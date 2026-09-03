/**
 * Pi subagent transcript card — renderCall / renderResult implementation.
 *
 * The only pi-facing translation layer for the subagent tool card: it maps
 * the host-agnostic view-model lines (`src/core/subagent/view.ts`) onto pi
 * TUI components.  The components (`Container` / `Text`) and the width
 * utilities (`visibleWidth` / `truncateToWidth`) come straight from the
 * `@earendil-works/pi-tui` package — the same implementation pi's TUI
 * renders with — so width accounting can never drift from the host's
 * `doRender` guard.  This mirrors how the pi-subagents extension (an
 * external extension shipped outside the pi repo) consumes pi-tui.
 *
 * The card renders structural lines as plain text, while markdown-flagged
 * lines (the expanded final output) render through pi-tui's `Markdown`
 * component with pi's FULL markdown theme (`fullMarkdownTheme`) — so markdown
 * content in the card looks exactly like pi's native transcript (colored
 * headings / code blocks / emphasis).  Non-markdown lines (titles, current
 * tool, stats, collapsed previews) stay uncolored.  The semantic hues of the
 * view model are carried by the view model itself (`src/core/subagent/view.ts`
 * + `theme.ts`) and are only used by the fleet widget, never by the card.
 *
 * Wrapping is delegated to pi's `Text` component, which is ANSI-aware:
 * it splits on `\n` into logical lines and wraps each one so its *visible*
 * width (ANSI escapes count as 0, CJK / full width characters as 2) never
 * exceeds the passed width.
 *
 * Title ownership (mirroring the pi-subagents extension's division of
 * labour): `renderCall` renders ONLY the single title line
 * `⠋ subagent(<agent>) · <description>` — the prompt preview is omitted
 * because the description already labels the task.  The spinner glyph in
 * that title is read from the shared renderer-state frame, which the
 * running `renderResult` body advances once per rebuild — so the title
 * animates in lock-step with the body.  The tool-execution component stacks
 * the `renderCall` card with the `renderResult` card (`updateDisplay` adds
 * both, it never replaces), so the running `renderResult` body must NOT
 * render a title — a second title would duplicate the one above it.  On a
 * terminal render `renderCall` yields: it returns an empty container (pi
 * still stacks the call card, but it renders nothing), and the terminal
 * `renderResult` renders its own `✓ / ✗ / ⏹ subagent(<agent>)` title.
 *
 * Layout (from the agreed visual contract):
 *   - running (isPartial): the stacked `renderCall` title, then the running
 *     body (current tool, recent tools, recent output, stats line).  The
 *     spinner advances via a ~100ms interval that drives
 *     `context.invalidate()` — pi has no periodic re-render for tool cards,
 *     so the extension must drive the animation itself.
 *   - done: `✓ subagent(<agent>)` success / `✗` error / `⏹` aborted (the
 *     stacked call card renders nothing by then).
 *   - collapsed final preview: the first non-empty line of the delivered
 *     result, width-truncated to the viewport (plain text, not markdown);
 *     expanded shows the full result through the `Markdown` component.
 *   - expanded (pi ctrl+o): more recent tools / output lines.
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
import type { SubagentProgress } from "../../../core/subagent/driver.js";
import { childrenOf } from "../../../core/subagent/registry.js";
import {
  type CardLine,
  renderProgressCard,
  renderProgressTitle,
  renderResultCard,
} from "../../../core/subagent/view.js";
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
  /** Shared renderer state (spinner frame sequence, timer handle). */
  state?: RendererState;
  /** Invalidate this tool-execution component for a redraw (drives the
   * spinner while partial results stream). */
  invalidate?: () => void;
  /** Whether this render is a partial update (false = terminal). */
  isPartial?: boolean;
}

/** Structural subset of pi's `ToolRenderContext.state` (renderer state). */
interface RendererState {
  frame?: number;
  /** The resolved model id published by the running `renderResult` for the
   * stacked `renderCall` title to read (shared per tool-execution
   * instance, mirroring the spinner frame). */
  model?: string;
}

/** The tool-call arguments the subagent tool is invoked with. */
interface SubagentToolArgs {
  agent?: string;
  description?: string;
  prompt?: string;
}

/** The partial/final `AgentToolResult` the card renders from. */
interface SubagentToolResult {
  content?: Array<{ type?: string; text?: string }>;
  details?: SubagentProgress;
}

// ---------------------------------------------------------------------------
// Renderer
// ---------------------------------------------------------------------------

/**
 * Render one view-model line as a pi `Text` child.
 *
 * Non-markdown lines stay uncolored: the semantic hue of the line is carried
 * by the view model itself and ignored here — no `theme.fg` call is ever
 * made for them.  Markdown-flagged lines are the exception, rendering with
 * pi's full markdown theme.
 *
 * A markdown-flagged line (the terminal final output, expanded) is rendered
 * through pi-tui's `Markdown` component with pi's FULL markdown theme
 * (built by `fullMarkdownTheme` from the renderer's `theme`) — structure is
 * parsed (headings, lists, code blocks, spacing) and styled exactly like pi's
 * native transcript (colored headings / code blocks / emphasis).  A
 * `truncateToWidth`-flagged line (the collapsed final-output preview) renders
 * as a single width-truncated line: the width is only known at
 * `render(width)`, so a thin component truncates there with pi's own
 * width-aware `truncateToWidth` semantics and strips the ANSI resets it
 * emits, keeping the collapsed preview plain.  All other lines render as
 * plain `Text`.
 *
 * A line that carries `segments` renders its flat concatenated `text` (the
 * per-segment hues are a widget-only concern): the card stays uncolored for
 * these and never wraps or strips any segment.
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

/**
 * Build the tool-call card (`renderCall`).
 *
 * Shown when the subagent tool call first renders, then re-rendered on each
 * `invalidate()` while partial results stream.  While the run is partial it
 * renders ONLY the single animated title line
 * `⠋ subagent(<agent>) · <description>` — the prompt preview is omitted
 * because the description already labels the task, and a preview would read
 * as noise.  The spinner glyph is read (not advanced) from the shared
 * renderer-state frame, which the running `renderResult` body increments on
 * each rebuild — so both stacked cards animate in lock-step.  The
 * tool-execution component stacks this card above the running
 * `renderResult` body, so the body must NOT render a title (a second title
 * would duplicate the one above it).
 *
 * On a terminal render (`isPartial === false`) this returns an empty
 * container: pi stacks the renderCall card forever, so the running title
 * must yield to the terminal `renderResult`'s own `✓ / ✗ / ⏹` title — an
 * empty container renders nothing, handing full title ownership to the
 * result card and clearing any frozen spinner glyph.
 *
 * @param args - The tool-call arguments (agent / description / prompt).
 * @param context - The tool render context (shared renderer state for the
 *   spinner frame, `isPartial` for the running/terminal switch).
 * @returns A component tree (empty once the run is terminal).
 */
export function renderCall(
  args: SubagentToolArgs,
  context?: PiRenderContextLike,
): Component {
  const container = new Container();
  // Terminal: yield the title to the renderResult terminal branch — an empty
  // container renders nothing (pi still stacks the call card, but it stays
  // blank, so the `✓ / ✗ / ⏹` title below is not duplicated).
  if (context?.isPartial === false) return container;

  const state = (context?.state ?? {}) as RendererState;
  // Read-only: the running renderResult body owns the frame counter so each
  // rebuild advances the frame exactly once for both stacked cards.
  const frame = state.frame ?? 0;
  const line = renderProgressTitle(
    args.agent,
    args.description,
    frame,
    state.model,
  );
  container.addChild(new Text(line.text, 0, 0));
  return container;
}

/**
 * Build the result card (`renderResult`).
 *
 * Renders the live running card when the result is a partial update
 * (`isPartial`), otherwise the terminal success / error / aborted card.
 * The structured progress is read from `result.details`; a missing or
 * unshaped `details` falls back to the text content snapshot.  Structural
 * lines (titles, current tool, stats, collapsed previews) are plain text;
 * markdown-flagged lines (the expanded final output) render with pi's full
 * markdown theme built from the `theme` argument.
 *
 * Title ownership: the running branch renders only the body — the static
 * title lives in the stacked `renderCall` card, and a second title would
 * duplicate it.  The terminal branch renders its own `✓ / ✗ / ⏹` title
 * (the stacked call card is cleared by then).
 *
 * Spinner animation: pi has no periodic re-render for tool cards, so the
 * running branch drives the animation itself.  While `isPartial` is true
 * it starts (idempotently) a ~100ms interval that calls `context.invalidate()`
 * (which rebuilds this card and re-renders — advancing the shared spinner
 * frame); on a terminal render the interval is cleared.  Timers are tracked
 * per render-context instance (isolated across concurrent subagent cards)
 * and `unref()`'d so a finished run can never hold the process open.
 *
 * @param result - The pi tool result (partial or final).
 * @param options - Render options (`expanded`, `isPartial`).
 * @param theme - The pi `Theme` (duck-typed) used to build the full
 *   markdown theme for markdown-flagged lines.
 * @param context - The tool render context (renderer state for the spinner,
 *   `invalidate` for the animation timer).
 * @returns A component tree.
 */
export function renderResult(
  result: SubagentToolResult,
  options: PiRenderOptionsLike,
  theme: MarkdownThemeSource,
  context?: PiRenderContextLike,
): Component {
  const container = new Container();
  const expanded = options.expanded === true;
  const isPartial = options.isPartial === true;
  const details = result.details;
  // The full markdown theme: markdown-flagged lines render exactly like
  // pi's native transcript (colored headings / code blocks / emphasis).
  const markdownTheme = fullMarkdownTheme(theme);
  // The card's task label comes from the tool-call description (the
  // `description` argument), read off the render context.
  const label = context?.args?.description;

  if (
    details !== undefined &&
    typeof details === "object" &&
    details.output !== undefined
  ) {
    // Advance the spinner frame once per render via the shared state.
    const state = (context?.state ?? {}) as RendererState;
    state.frame = (state.frame ?? 0) + 1;
    // Publish the resolved model id onto the shared state so the stacked
    // `renderCall` title (which cannot see the progress details) shows the
    // same badge as this terminal title.  The running body reads it on the
    // next rebuild; the terminal title reads it from `details` directly.
    if (details.model !== undefined) state.model = details.model;

    // This run's nested subagent delegations, looked up by the run id the
    // tool stamped onto the streamed details (the pi tool-call id).  The
    // card appends them one level deep below its own region.
    const runId = details.runId;
    const children =
      typeof runId === "string" && runId.length > 0 ? childrenOf(runId) : [];

    const lines = isPartial
      ? renderProgressCard(
          details,
          label,
          expanded,
          Date.now(),
          state.frame,
          children,
        )
      : renderResultCard(details, label, expanded, children, state.frame);

    for (const line of lines) addLine(container, line, markdownTheme);
    manageSpinnerTimer(state, isPartial, context?.invalidate);
    return container;
  }

  // Fallback: render the text snapshot (non-TUI / unshaped details).
  //
  // Defensive timer cleanup: this branch is not reachable in practice — the
  // spinner timer only starts from the shaped-partial branch above, and a
  // terminal render always inherits the final partial's `details` — but if it
  // ever is reached after a partial render, clearing the timer closes the
  // loop instead of leaking an animation interval.
  const state = (context?.state ?? {}) as RendererState;
  manageSpinnerTimer(state, false, context?.invalidate);
  const text =
    result.content?.[0]?.type === "text" ? (result.content[0].text ?? "") : "";
  if (text.length > 0) {
    container.addChild(new Text(text, 0, 0));
  }
  return container;
}

/**
 * The interval-driven spinner handle stored in the shared renderer state.
 *
 * Tracked on `state` (the render-context state object) so timers are
 * isolated per tool-execution instance: concurrent subagent cards each get
 * their own handle, and a terminal render clears only its own.
 */
interface SpinnerTimerState {
  /** The active animation interval, or undefined when idle. */
  spinnerTimer?: ReturnType<typeof setInterval>;
}

/**
 * Start (idempotently) or clear the spinner animation timer.
 *
 * While a partial result is rendering, a ~100ms interval calls the render
 * context's `invalidate()` to drive the spinner; on a terminal (or fallback)
 * render the timer is cleared.  Idempotent: re-rendering a partial never
 * stacks a second interval, and the handle is `unref()`'d so a finished run
 * never keeps the process alive.  The timer state lives on the shared
 * renderer state object, keyed to the tool-execution instance.
 *
 * @param state - The shared renderer state (cast to include the timer).
 * @param isPartial - Whether the current render is a partial update.
 * @param invalidate - The render context's `invalidate` callback (absent in
 *   tests / non-TUI renders, in which case no timer is started).
 */
function manageSpinnerTimer(
  state: RendererState,
  isPartial: boolean,
  invalidate: (() => void) | undefined,
): void {
  const timerState = state as RendererState & SpinnerTimerState;
  if (isPartial) {
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
 * `renderCall` / `renderResult` are stateless closures over nothing but the
 * view model; pi invokes them with its real `Theme` / render context.  The
 * `theme` argument is forwarded to `renderResult`, which uses it to build
 * the full markdown theme for markdown-flagged lines; `renderCall` renders
 * only a plain-text title, so it does not need the theme.
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
