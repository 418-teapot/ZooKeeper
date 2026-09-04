/**
 * Pi subagent transcript card — renderCall / renderResult implementation.
 *
 * The only pi-facing translation layer for the subagent tool card: it maps
 * the host-agnostic card projection (`src/core/subagent/view.ts`
 * `projectCard`, over the run's append-only fact log) onto pi TUI
 * components.  The components (`Container` / `Text`) and the width
 * utilities (`stripTerminalSequences` / `truncateToWidth`) come straight
 * from the `@earendil-works/pi-tui` package — the same implementation pi's
 * TUI renders with — so width accounting can never drift from the host's
 * `doRender` guard.
 *
 * The card is a pure projection: it reads the run from the registry by the
 * render context's `toolCallId` (the driver keys runs by that id) and
 * projects `run.log` at render time.  It never reads a progress snapshot —
 * the only `details` field the card knows is the terminal result's
 * `sessionPath` hydration pointer (see below).
 *
 * Width discipline: the terminal width only exists inside the component's
 * `render(width)`, so the `ProjectedCard` component runs `projectCard`
 * THERE, caching the rendered lines per width (the `CollapsedPreview`
 * pattern).  Nothing character-truncates at construction time; the
 * projection caps lines to the render width it is given.
 *
 * Wrapping is delegated to pi's `Text` component, which is ANSI-aware: it
 * splits on `\n` into logical lines and wraps each one so its *visible*
 * width (ANSI escapes count as 0, CJK / full width characters as 2) never
 * exceeds the passed width.
 *
 * Title ownership (mirroring the pi-subagents extension's division of
 * labour): `renderCall` renders ONLY the single title line
 * `⠋ subagent(<agent>) · <model> · <description>` — the prompt preview is
 * omitted because the description already labels the task.  The spinner
 * glyph in that title is read from the shared renderer-state frame, which
 * the running `renderResult` body advances once per rebuild — so the title
 * animates in lock-step with the body.  The tool-execution component stacks
 * the `renderCall` card with the `renderResult` card (`updateDisplay` adds
 * both, it never replaces), so the running `renderResult` body must NOT
 * render a title — a second title would duplicate the one above it.  On a
 * terminal render `renderCall` yields: it returns an empty container and
 * the terminal projection owns the `✓ / ✗ / ⏹` title.
 *
 * Layout:
 *   - running (partial render, run in registry): the stacked `renderCall`
 *     title, then the projected body — current tool, recent tool calls,
 *     recent outputs, stats, nested children.
 *   - terminal (run in registry): the projected terminal card — title with
 *     stats badge, error reason when failed, collapsed preview (expanded
 *     markdown) of the final output, nested children.
 *   - terminal after a restart, run missing (or log-less) but the result
 *     carries `details.sessionPath`: a placeholder line while the
 *     sub-session jsonl is hydrated into a private log cache
 *     (`../hydrate.ts` — deliberately NOT the registry, so restored
 *     finished runs never enter the fleet), then the same terminal
 *     projection over the hydrated log once `invalidate()` repaints.
 *   - fallback (no run, no pointer, or an early partial render before the
 *     driver registered the run): the streamed / delivered result text.
 *
 * Coloring discipline: the card body stays UNCOLORED — the view model's
 * semantic hues are a fleet-widget concern and are never applied here
 * (markdown lines are the sole exception, styled by pi's markdown theme).
 *
 * @module
 */

import {
  type Component,
  Container,
  Markdown,
  type MarkdownTheme,
  stripTerminalSequences,
  Text,
  truncateToWidth,
} from "@earendil-works/pi-tui";
import {
  childrenOf,
  getRun,
  type SubagentRun,
} from "../../../core/subagent/registry.js";
import type { RunLog } from "../../../core/subagent/run-log.js";
import {
  type CardLine,
  type CardMeta,
  projectCard,
  renderProgressTitle,
} from "../../../core/subagent/view.js";
import { beginHydration, hydrationState } from "../hydrate.js";
import { fullMarkdownTheme, type MarkdownThemeSource } from "./theme.js";

// ---------------------------------------------------------------------------
// pi renderer surface types (duck-typed inputs, not pi imports)
// ---------------------------------------------------------------------------

/** Structural subset of pi's `Theme` the card needs for the full markdown
 * theme (`fullMarkdownTheme`). */
export type PiThemeLike = MarkdownThemeSource;

/** Structural subset of pi's `ToolRenderResultOptions`. */
export interface PiRenderOptionsLike {
  expanded?: boolean;
  isPartial?: boolean;
}

/** Structural subset of pi's `ToolRenderContext` the card reads. */
export interface PiRenderContextLike {
  /** The tool-call arguments (the `description` doubles as the label). */
  args?: SubagentToolArgs;
  /** The stable tool-call id — the key the driver registers the run
   * under (registry lookup + hydration cache key). */
  toolCallId?: string;
  /** Shared renderer state (spinner frame sequence, timer handle). */
  state?: RendererState;
  /** Invalidate this tool-execution component for a redraw (drives the
   * spinner while partial results stream and the repaint after a cold-
   * start hydration settles). */
  invalidate?: () => void;
  /** Whether this render is a partial update (false = terminal). */
  isPartial?: boolean;
  /** Whether the terminal result failed (drives the synthesized title). */
  isError?: boolean;
}

/** Structural subset of pi's `ToolRenderContext.state` (renderer state). */
interface RendererState {
  frame?: number;
  /** The resolved model id published by the running `renderResult` for the
   * stacked `renderCall` title to read (shared per tool-execution
   * instance, mirroring the spinner frame).  A fallback for renders
   * without a registry run; the live path reads the model from the run. */
  model?: string;
}

/** The tool-call arguments the subagent tool is invoked with. */
interface SubagentToolArgs {
  agent?: string;
  description?: string;
  prompt?: string;
}

/**
 * The partial/final `AgentToolResult` the card renders from.
 *
 * `details` is the terminal session pointer only: pi persists a tool
 * result's `details` (partial ones never reach disk), so the terminal
 * result carries the sub-session file path and nothing else.  The card
 * reads it EXCLUSIVELY as the cold-start hydration key — never as a
 * progress payload (that channel is gone).
 */
interface SubagentToolResult {
  content?: Array<{ type?: string; text?: string }>;
  details?: { sessionPath?: string };
}

// ---------------------------------------------------------------------------
// Projection component
// ---------------------------------------------------------------------------

/** The three inputs one card projection needs, resolved at render time. */
interface CardProjection {
  /** The fact log to project (live registry log or hydrated copy). */
  log: RunLog;
  /** Run identity / lifecycle beyond the facts. */
  meta: CardMeta;
  /** The run's nested subagent runs (registry children, one level deep). */
  children: SubagentRun[];
}

/**
 * A card that projects its content lazily, at the real render width.
 *
 * `projectCard` needs the width to cap its lines, but pi only reveals the
 * width when it calls `render(width)` — so the projection runs there and
 * the rendered output is cached per width.  Pi rebuilds this component on
 * every `invalidate()` (the 100ms spinner tick, a partial update, a
 * hydration repaint), so a live log's new facts are picked up on the next
 * rebuild; within one instance the cache is exact.
 */
class ProjectedCard implements Component {
  private readonly cache = new Map<number, string[]>();

  /**
   * @param projection - Resolver for the log / meta / children snapshot.
   * @param markdownTheme - pi's full markdown theme (markdown lines only).
   * @param expanded - Whether the card renders in expanded mode.
   * @param frame - The shared spinner frame (nested-child spinners).
   */
  constructor(
    private readonly projection: () => CardProjection,
    private readonly markdownTheme: MarkdownTheme,
    private readonly expanded: boolean,
    private readonly frame: number,
  ) {}

  invalidate(): void {
    this.cache.clear();
  }

  render(width: number): string[] {
    const safeWidth = Math.max(1, width);
    const hit = this.cache.get(safeWidth);
    if (hit !== undefined) return hit;
    const { log, meta, children } = this.projection();
    const lines = projectCard(log, meta, {
      width: safeWidth,
      expanded: this.expanded,
      now: Date.now(),
      frame: this.frame,
      children,
    });
    const container = new Container();
    for (const line of lines) addLine(container, line, this.markdownTheme);
    const rendered = container.render(safeWidth);
    this.cache.set(safeWidth, rendered);
    return rendered;
  }
}

/**
 * The card meta of a registry run (identity + lifecycle).
 *
 * @param run - The registry entry.
 * @returns The projection meta.
 */
function metaFromRun(run: SubagentRun): CardMeta {
  return {
    agent: run.agent,
    model: run.model,
    status: run.status,
    startedAt: run.startedAt,
    endedAt: run.endedAt,
    currentTool: run.currentTool,
    error: run.error,
  };
}

/**
 * Synthesized meta for a restored run the registry does not know.
 *
 * A post-restart terminal render knows only the tool-call arguments and
 * whether the delivered result failed; the lifecycle timestamps are
 * recovered from the hydrated log's own fact times (the persisted
 * messages carry them).
 *
 * @param args - The tool-call arguments from the render context.
 * @param isError - Whether the persisted terminal result failed.
 * @param log - The hydrated fact log (its first / last fact times bound
 *   the run's lifecycle).
 * @returns The projection meta.
 */
function metaFromRestore(
  args: SubagentToolArgs,
  isError: boolean,
  log: RunLog,
): CardMeta {
  const facts = log.facts();
  return {
    agent: args.agent,
    status: isError ? "error" : "done",
    startedAt: facts.length > 0 ? facts[0].at : 0,
    endedAt: facts.length > 0 ? facts[facts.length - 1].at : undefined,
  };
}

/**
 * The delivered / streamed text of a result (the fallback body).
 *
 * @param result - The pi tool result.
 * @returns The first text part's text (empty when there is none).
 */
function deliveredText(result: SubagentToolResult): string {
  return result.content?.[0]?.type === "text"
    ? (result.content[0].text ?? "")
    : "";
}

// ---------------------------------------------------------------------------
// Line rendering
// ---------------------------------------------------------------------------

/**
 * Render one view-model line as a pi child component.
 *
 * Non-markdown lines stay uncolored: the semantic hue of the line is
 * carried by the view model itself and ignored here — no `theme.fg` call
 * is ever made for them.  Markdown-flagged lines are the exception,
 * rendering with pi's full markdown theme.
 *
 * A markdown-flagged line (the terminal final output, expanded) is
 * rendered through pi-tui's `Markdown` component with pi's FULL markdown
 * theme — structure is parsed (headings, lists, code blocks, spacing) and
 * styled exactly like pi's native transcript.  A `truncateToWidth`-flagged
 * line (the collapsed final-output preview, the error reason) renders as
 * a single width-truncated line: the width is only known at
 * `render(width)`, so a thin component truncates there with pi's own
 * width-aware `truncateToWidth` semantics and strips the ANSI resets it
 * emits, keeping the card plain.  All other lines render as plain `Text`.
 *
 * A line that carries `segments` renders its flat concatenated `text`
 * (the per-segment hues are a widget-only concern).
 *
 * @param container - The container to add the line to.
 * @param line - The view-model line (text + semantic hue).
 * @param markdownTheme - The pi-tui `MarkdownTheme` for markdown-flagged
 *   lines (pi's full theme, from `fullMarkdownTheme`).
 */
export function addLine(
  container: Container,
  line: CardLine,
  markdownTheme: MarkdownTheme,
): void {
  if (line.markdown === true) {
    container.addChild(new Markdown(line.text, 0, 0, markdownTheme));
    return;
  }
  if (line.truncateToWidth === true) {
    container.addChild(new CollapsedPreview(line.text));
    return;
  }
  container.addChild(new Text(line.text, 0, 0));
}

/**
 * A single-line collapsed preview, width-truncated at render time.
 *
 * The terminal width is only known when the TUI calls `render(width)`, so
 * truncation must live here rather than at construction.  Uses pi's own
 * width-aware `truncateToWidth` (grapheme + ANSI-aware, `...` ellipsis)
 * and then strips the ANSI resets it emits so the card stays plain text —
 * the same no-ANSI contract the card documents for all other lines.
 */
class CollapsedPreview implements Component {
  private readonly text: string;

  constructor(text: string) {
    this.text = text;
  }

  invalidate(): void {
    // Stateless: nothing cached to invalidate.
  }

  render(width: number): string[] {
    const safeWidth = Math.max(1, width);
    return [stripTerminalSequences(truncateToWidth(this.text, safeWidth))];
  }
}

// ---------------------------------------------------------------------------
// Renderers
// ---------------------------------------------------------------------------

/**
 * Build the tool-call card (`renderCall`).
 *
 * Shown when the subagent tool call first renders, then re-rendered on
 * each `invalidate()` while partial results stream.  While the run is
 * partial it renders ONLY the single animated title line
 * `⠋ subagent(<agent>) · <model> · <description>` — the prompt preview is
 * omitted because the description already labels the task.  The model
 * badge is read from the registry run (the driver publishes it as soon as
 * the sub-session resolves one); the spinner glyph is read (not advanced)
 * from the shared renderer-state frame, which the running `renderResult`
 * body increments on each rebuild — so both stacked cards animate in
 * lock-step.
 *
 * On a terminal render (`isPartial === false`) this returns an empty
 * container: pi stacks the call card forever, so the running title must
 * yield to the terminal `renderResult`'s own `✓ / ✗ / ⏹` title — an empty
 * container renders nothing, handing full title ownership to the result
 * card and clearing any frozen spinner glyph.
 *
 * @param args - The tool-call arguments (agent / description / prompt).
 * @param context - The tool render context (tool-call id for the registry
 *   run lookup, shared renderer state for the spinner frame, `isPartial`
 *   for the running/terminal switch).
 * @returns A component tree (empty once the run is terminal).
 */
export function renderCall(
  args: SubagentToolArgs,
  context?: PiRenderContextLike,
): Component {
  const container = new Container();
  // Terminal: yield the title to the renderResult terminal branch — an
  // empty container renders nothing (pi still stacks the call card, but it
  // stays blank, so the `✓ / ✗ / ⏹` title below is not duplicated).
  if (context?.isPartial === false) return container;

  const state = context?.state ?? {};
  const run = getRun(context?.toolCallId ?? "");
  // Read-only: the running renderResult body owns the frame counter so
  // each rebuild advances the frame exactly once for both stacked cards.
  const frame = state.frame ?? 0;
  const line = renderProgressTitle(
    args.agent,
    args.description,
    frame,
    // Live path: the registry run carries the model.  The state copy is
    // the fallback for renders without a registry run (startup race).
    run?.model ?? state.model,
  );
  container.addChild(new Text(line.text, 0, 0));
  return container;
}

/**
 * Build the result card (`renderResult`).
 *
 * The card is a lazy projection over the run's fact log: the component it
 * returns runs `projectCard` inside `render(width)` (see `ProjectedCard`),
 * looking the run up by the render context's `toolCallId`.  A terminal
 * render for a run the registry does not have (post-restart restore) — or
 * one the history scanner rebuilt with an empty log — hydrates the log
 * from the terminal result's `details.sessionPath` (see `../hydrate.ts`):
 * a placeholder renders while the sub-session jsonl parses
 * asynchronously, then `context.invalidate()` repaints with the full
 * terminal card.  Without any log source the card falls back to the
 * streamed / delivered text.
 *
 * Title ownership: the RUNNING projection emits no title line (the
 * stacked `renderCall` owns it); only the terminal projection carries the
 * `✓ / ✗ / ⏹` title.
 *
 * Spinner animation: pi has no periodic re-render for tool cards, so the
 * running branch drives the animation itself.  While the run is active it
 * starts (idempotently) a ~100ms interval calling
 * `context.invalidate()` — which rebuilds this card, picking up facts
 * appended since the last paint; once the registry run is terminal (or on
 * any terminal render) the interval is cleared.  Timers are tracked per
 * render-context instance (isolated across concurrent subagent cards) and
 * `unref()`'d so a finished run can never hold the process open.
 *
 * @param result - The pi tool result (partial or final).
 * @param options - Render options (`expanded`, `isPartial`).
 * @param theme - The pi `Theme` (duck-typed), used to build the full
 *   markdown theme for markdown-flagged lines.
 * @param context - The tool render context (tool-call id for the registry
 *   run lookup, renderer state for the spinner, `invalidate` for the
 *   animation timer and the hydration repaint).
 * @returns A component tree.
 */
export function renderResult(
  result: SubagentToolResult,
  options: PiRenderOptionsLike,
  theme: MarkdownThemeSource,
  context?: PiRenderContextLike,
): Component {
  const isPartial = options.isPartial === true;
  const state = context?.state ?? {};
  const toolCallId = context?.toolCallId ?? "";
  const run = getRun(toolCallId);
  // Active = a partial render whose registry run has not gone terminal.
  // A terminal run needs no animation ticks even when a late partial
  // render arrives (e.g. a result update racing the finish).
  const active = isPartial && (run === undefined || run.status === "running");
  if (active) state.frame = (state.frame ?? 0) + 1;
  manageSpinnerTimer(state, active, context?.invalidate);
  const frame = state.frame ?? 0;
  const expanded = options.expanded === true;
  const markdownTheme = fullMarkdownTheme(theme);

  // Publish the resolved model for the stacked renderCall title (the
  // fallback path for renderers without a registry run read it from
  // shared state; the live lookup prefers the run itself).
  if (run?.model !== undefined) state.model = run.model;

  // Registry hit: project the run's log.  A terminal run with an empty
  // log is the restored-scanner case (the history scanner rebuilds runs
  // without facts) — hydration below upgrades it; until a hydrated log
  // exists the empty terminal projection (title + "(no output)") renders.
  const sessionPath = result.details?.sessionPath;
  const canHydrate =
    toolCallId.length > 0 &&
    !isPartial &&
    typeof sessionPath === "string" &&
    sessionPath.length > 0;
  if (run !== undefined) {
    const emptyTerminal = !active && run.log.facts().length === 0;
    if (emptyTerminal && canHydrate) {
      const hydration = hydrationState(toolCallId);
      if (hydration.kind === "ready") {
        return new ProjectedCard(
          () => ({
            log: hydration.log,
            meta: metaFromRun(run),
            children: childrenOf(run.id),
          }),
          markdownTheme,
          expanded,
          frame,
        );
      }
      if (hydration.kind !== "failed") {
        // Missing → start the load; pending → wait for the in-flight
        // one.  Either way paint the placeholder until the settle
        // invalidate.
        beginHydration(toolCallId, sessionPath, context?.invalidate);
        return new Text("(restoring subagent transcript…)", 0, 0);
      }
      // Failed load: fall through — the empty terminal projection beats
      // nothing, and the run's own fields still carry the truth.
    }
    return new ProjectedCard(
      () => ({
        log: run.log,
        meta: metaFromRun(run),
        children: childrenOf(run.id),
      }),
      markdownTheme,
      expanded,
      frame,
    );
  }

  // Cold-start restore with no registry run at all (the history scanner
  // has not rebuilt it either): hydrate the log from the terminal
  // result's sub-session pointer.  The hydrated log lives in a private
  // cache keyed by tool-call id and is NEVER registered — the fleet must
  // not suddenly list restored finished runs.
  if (canHydrate) {
    const hydration = hydrationState(toolCallId);
    if (hydration.kind === "ready") {
      const meta = metaFromRestore(
        context?.args ?? {},
        context?.isError === true,
        hydration.log,
      );
      return new ProjectedCard(
        () => ({ log: hydration.log, meta, children: [] }),
        markdownTheme,
        expanded,
        frame,
      );
    }
    if (hydration.kind !== "failed") {
      beginHydration(toolCallId, sessionPath, context?.invalidate);
      return new Text("(restoring subagent transcript…)", 0, 0);
    }
    // Failed load: fall through to the delivered-text fallback.
  }

  // Fallback: the streamed text (partial, before the driver registered
  // the run) or the delivered result text (terminal, no log source).
  const container = new Container();
  const text = deliveredText(result);
  if (text.length > 0) {
    container.addChild(new Text(text, 0, 0));
  }
  return container;
}

/**
 * The interval-driven spinner handle stored in the shared renderer state.
 *
 * Tracked on `state` (the render-context state object) so timers are
 * isolated per tool-execution instance: concurrent subagent cards each
 * get their own handle, and a terminal render clears only its own.
 */
interface SpinnerTimerState {
  /** The active animation interval, or undefined when idle. */
  spinnerTimer?: ReturnType<typeof setInterval>;
}

/**
 * Start (idempotently) or clear the spinner animation timer.
 *
 * While the run is active, a ~100ms interval calls the render context's
 * `invalidate()` to drive the spinner and pick up appended facts; on a
 * terminal render the timer is cleared.  Idempotent: re-rendering an
 * active run never stacks a second interval, and the handle is
 * `unref()`'d so a finished run never keeps the process alive.  The timer
 * state lives on the shared renderer state object, keyed to the
 * tool-execution instance.
 *
 * @param state - The shared renderer state (cast to include the timer).
 * @param active - Whether the run still needs animation ticks.
 * @param invalidate - The render context's `invalidate` callback (absent
 *   in tests / non-TUI renders, in which case no timer is started).
 */
function manageSpinnerTimer(
  state: RendererState,
  active: boolean,
  invalidate: (() => void) | undefined,
): void {
  const timerState = state as RendererState & SpinnerTimerState;
  if (active) {
    if (
      timerState.spinnerTimer === undefined &&
      typeof invalidate === "function"
    ) {
      timerState.spinnerTimer = setInterval(() => invalidate(), 100);
      timerState.spinnerTimer.unref();
    }
    return;
  }
  if (timerState.spinnerTimer !== undefined) {
    clearInterval(timerState.spinnerTimer);
    timerState.spinnerTimer = undefined;
  }
}

/**
 * The renderer surface attached to the subagent tool contribution.
 *
 * `renderCall` / `renderResult` are closures over the host-agnostic
 * projection machinery; pi invokes them with its real `Theme` / render
 * context.  The `theme` argument is forwarded to `renderResult`, which
 * uses it to build the full markdown theme for markdown-flagged lines;
 * `renderCall` renders only a plain-text title, so it does not need the
 * theme.
 */
export function buildSubagentCardRenderer(): {
  renderCall: (args: unknown, theme: unknown, context?: unknown) => unknown;
  renderResult: (
    result: unknown,
    options: unknown,
    theme: unknown,
    context?: unknown,
  ) => unknown;
} {
  return {
    renderCall: (args, _theme, context) =>
      renderCall(args as SubagentToolArgs, context as PiRenderContextLike),
    renderResult: (result, options, theme, context) =>
      renderResult(
        result as SubagentToolResult,
        (options ?? {}) as PiRenderOptionsLike,
        (theme ?? {}) as MarkdownThemeSource,
        context as PiRenderContextLike | undefined,
      ),
  };
}
