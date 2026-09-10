/**
 * Pi todo transcript card — renderCall / renderResult implementation.
 *
 * The only pi-facing translation layer for the todo tool card: it maps the
 * host-agnostic todo view model (`src/core/todo/view.ts` `todoLines`, over
 * the `{ op, phases }` snapshot the tool writes into the persisted result
 * `details`) onto pi TUI components.  The components (`Container` / `Text`)
 * and the width utilities (`stripTerminalSequences` / `truncateToWidth`)
 * come straight from the `@earendil-works/pi-tui` package — the same
 * implementation pi's TUI renders with — so width accounting can never
 * drift from the host's `doRender` guard.
 *
 * Data contract: a successful mutating todo call persists
 * `serializeSnapshot(op, phases)` as the tool result's `details` (the pi
 * bridge merges it with its own keys); `view` calls and failed calls write
 * NO details.  The card therefore parses `details` leniently — any
 * missing or structurally invalid snapshot degrades to a plain-text render
 * of the result content, exactly like pi's default text result reads.
 *
 * Glyph / color discipline: every row comes from `todoLines` carrying a
 * pre-computed `text`, `glyph`, and semantic `hue`; this module never
 * re-derives them.  Hues map to pi colors exclusively through
 * `hueToPiColor` (the single pi color vocabulary translation), the
 * spinner slot resolves through the shared `SPINNER_FRAMES` /
 * `spinnerFrameIndex`, and completed rows get the theme's strikethrough.
 *
 * Budget discipline: the projection emits the whole plan; the card clips
 * it with the shared `fitToBudget`, so dropped work always surfaces as the
 * view model's `+N more` overflow row (never a silent cut).  Collapsed
 * renders lead with the single-line `collapsedSummaryLine`, matching the
 * glance/expand split of the subagent card.
 *
 * Width discipline: like the subagent card, nothing character-truncates at
 * construction time — the title line truncates inside its own
 * `render(width)` with pi's width-aware utilities.
 *
 * @module
 */

import {
  type Component,
  Container,
  stripTerminalSequences,
  Text,
  truncateToWidth,
} from "@earendil-works/pi-tui";
import type { DisplayHue } from "../../../core/display.js";
import {
  fitToBudget,
  SPINNER_FRAMES,
  spinnerFrameIndex,
} from "../../../core/display.js";
import type { TodoOperation, TodoPhase } from "../../../core/todo/types.js";
import { isTodoPhase } from "../../../core/todo/types.js";
import {
  collapsedSummaryLine,
  overflowLine,
  type TodoViewLine,
  todoLines,
} from "../../../core/todo/view.js";
import type { MarkdownThemeSource } from "./theme.js";
import { hueToPiColor } from "./theme.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * The card's line budget when collapsed: the summary line plus this many
 * projected rows (the overflow row counts among them), mirroring the
 * glance window of the subagent card.
 */
const COLLAPSED_BODY_ROWS = 5;

/** The card's line budget when expanded. */
const EXPANDED_BODY_ROWS = 16;

/** How many call targets the title lists before a `+N` counter. */
const MAX_TITLE_TARGETS = 3;

/** The tool's model-facing op vocabulary rendered as Chinese labels. */
const TODO_OP_LABELS: Record<TodoOperation, string> = {
  init: "初始化",
  start: "开始",
  done: "完成",
  drop: "放弃",
  rm: "删除",
  block: "阻塞",
  unblock: "解除阻塞",
  append: "追加",
  view: "查看",
};

// ---------------------------------------------------------------------------
// pi renderer surface types (duck-typed inputs, not pi imports)
// ---------------------------------------------------------------------------

/**
 * Structural subset of the todo tool's raw call arguments.
 *
 * The tool's arguments are flat: one `op` plus that op's payload fields at
 * the top level (`list` / `tasks` / `phase` / `task` / `reason`).  `reason`
 * is carried for completeness but is a note, not a target, so `callTargets`
 * never lists it.
 */
interface TodoToolArgs {
  op?: unknown;
  list?: unknown;
  tasks?: unknown;
  phase?: unknown;
  task?: unknown;
  reason?: unknown;
}

/**
 * Structural subset of the `AgentToolResult` the card renders from.
 *
 * `details` is the persisted `{ op, phases }` snapshot on a successful
 * mutating call; `view` and failed calls carry none (the plain-text
 * fallback then serves them).
 */
interface TodoToolResult {
  content?: Array<{ type?: string; text?: string }>;
  details?: unknown;
}

/** Structural subset of pi's `ToolRenderResultOptions`. */
interface PiRenderOptionsLike {
  expanded?: boolean;
  isPartial?: boolean;
}

/** Structural subset of pi's `ToolRenderContext` the card reads. */
interface PiRenderContextLike {
  /** Shared renderer state (the spinner frame the fleet widget advances). */
  state?: { frame?: number };
  /** The stable tool-call id (unused here; kept for the port shape). */
  toolCallId?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ---------------------------------------------------------------------------
// Snapshot parsing
// ---------------------------------------------------------------------------

/**
 * Parse a persisted result `details` into todo phases, leniently.
 *
 * The structural guards mirror the snapshot contract (`serializeSnapshot`
 * always produces `{ op: string, phases: TodoPhase[] }`, plus whatever
 * keys the bridge merged in): a non-record, a non-string `op`, or a
 * `phases` array holding any structurally invalid phase degrades to
 * `undefined` — never a throw, never a partial render of corrupt state.
 *
 * @param details - The raw `result.details` value.
 * @returns The snapshot phases, or `undefined` when unusable.
 */
function parseSnapshot(details: unknown): TodoPhase[] | undefined {
  if (!isRecord(details)) return undefined;
  if (typeof details.op !== "string") return undefined;
  const phases: unknown = details.phases;
  if (!Array.isArray(phases) || !phases.every(isTodoPhase)) return undefined;
  return phases;
}

/**
 * The delivered text of a result (the plain-text fallback body).
 *
 * @param result - The pi tool result.
 * @returns The first text part's text (empty when there is none).
 */
function deliveredText(result: TodoToolResult): string {
  return result.content?.[0]?.type === "text"
    ? (result.content[0].text ?? "")
    : "";
}

// ---------------------------------------------------------------------------
// Line rendering
// ---------------------------------------------------------------------------

/**
 * Render one view-model row as a pi `Text` child.
 *
 * The row's whole body carries its semantic hue through the host
 * colorizer (the same `theme.fg(hueToPiColor(hue), text)` path the fleet
 * widget uses); without a usable theme the row degrades to plain text.
 * A task row prefixes its glyph slot: the shared braille frame for a
 * spinner row (read from the renderer-state frame), the pre-computed
 * status glyph otherwise; completed work renders struck through.  Header,
 * overflow, and summary rows carry their text verbatim — the view model
 * already composed their glyphs and counts.
 */
function rowComponent(
  row: TodoViewLine,
  colorize: ((hue: DisplayHue, text: string) => string) | undefined,
  strikethrough: ((text: string) => string) | undefined,
  frame: number,
): Component {
  let body: string;
  if (row.kind === "task") {
    const glyph = row.spinner
      ? SPINNER_FRAMES[spinnerFrameIndex(frame)]
      : row.glyph;
    const text =
      row.strikethrough === true && strikethrough !== undefined
        ? strikethrough(row.text)
        : row.text;
    body = `${glyph} ${text}`;
  } else {
    body = row.text;
  }
  return new Text(
    colorize === undefined ? body : colorize(row.hue, body),
    0,
    0,
  );
}

/**
 * A single-line title, width-truncated at render time.
 *
 * The terminal width is only known when the TUI calls `render(width)`, so
 * truncation lives here rather than at construction.  Uses pi's own
 * width-aware `truncateToWidth` (grapheme + ANSI-aware, `...` ellipsis)
 * and strips the ANSI resets it emits, keeping the card plain — the same
 * contract the subagent card's collapsed preview honors.
 */
class TitleLine implements Component {
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
// renderCall
// ---------------------------------------------------------------------------

/** Push every non-empty string of a raw argument field into `targets`. */
function collectStrings(value: unknown, targets: string[]): void {
  if (typeof value === "string" && value.length > 0) {
    targets.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      if (typeof item === "string" && item.length > 0) targets.push(item);
    }
  }
}

/**
 * The target labels a call acts on.
 *
 * Reads the flat payload fields loosely (the same `{op, list|tasks|phase|
 * task}` shape the tool validates strictly — a malformed call degrades to
 * fewer labels, never a throw): `task` / `tasks` name the targeted rows,
 * `phase` names a phase target, and `init`'s canonical `list` contributes
 * its phase names.
 *
 * @param args - The raw tool-call arguments.
 * @returns The collected target labels (possibly empty).
 */
function callTargets(args: TodoToolArgs): string[] {
  const targets: string[] = [];
  const list = Array.isArray(args.list) ? args.list : [];
  for (const phase of list) {
    if (isRecord(phase) && typeof phase.phase === "string") {
      targets.push(phase.phase);
    }
  }
  collectStrings(args.phase, targets);
  collectStrings(args.task, targets);
  collectStrings(args.tasks, targets);
  return targets;
}

/**
 * Build the tool-call title line (`renderCall`).
 *
 * A compact single line naming the tool, the operation (Chinese label,
 * matching the tool's model-facing vocabulary), and the targeted rows or
 * phases: `todo(初始化) · 环境搭建, 核心实现 +2`.  The target LIST is
 * capped at construction (the count is layout, not clipping); the line
 * itself truncates at render width through `TitleLine`, so no
 * character-cutting happens before the real width is known.
 *
 * @param args - The raw tool-call arguments (`{ op, list?, tasks?, phase?,
 *   task?, reason? }`).
 * @returns A component tree (the single title line).
 */
export function renderCall(args: TodoToolArgs): Component {
  const container = new Container();
  const op = typeof args?.op === "string" ? args.op : undefined;
  const label =
    op === undefined
      ? "todo"
      : `todo(${TODO_OP_LABELS[op as TodoOperation] ?? op})`;
  const targets = callTargets(args ?? {});
  const shown = targets.slice(0, MAX_TITLE_TARGETS);
  const hidden = targets.length - shown.length;
  const title =
    shown.length === 0
      ? label
      : `${label} · ${shown.join(", ")}${hidden > 0 ? ` +${hidden}` : ""}`;
  container.addChild(new TitleLine(title));
  return container;
}

// ---------------------------------------------------------------------------
// renderResult
// ---------------------------------------------------------------------------

/**
 * Build the result card (`renderResult`).
 *
 * A valid `{ op, phases }` snapshot projects through `todoLines` into
 * card rows, clipped to the card's line budget with the shared
 * `fitToBudget` (dropped work resurfaces as the view model's `+N`
 * overflow row).  Collapsed renders lead with the single-line
 * `collapsedSummaryLine`; an empty plan renders just that summary line
 * (`0/0 done`) in either mode, so the card is never blank on a valid
 * snapshot.  A missing or malformed snapshot (a `view` call, a failed
 * call, a legacy record) degrades to the plain-text result content — the
 * exact reading pi's default text result gives.
 *
 * @param result - The pi tool result (partial or final).
 * @param options - Render options (`expanded`, `isPartial`).
 * @param theme - The pi `Theme` (duck-typed), used for hue colors and the
 *   completed-row strikethrough.
 * @param context - The tool render context (shared renderer state for the
 *   spinner frame).
 * @returns A component tree.
 */
export function renderResult(
  result: TodoToolResult,
  options: PiRenderOptionsLike,
  theme: MarkdownThemeSource,
  context?: PiRenderContextLike,
): Component {
  const container = new Container();
  const phases = parseSnapshot(result?.details);
  if (phases === undefined) {
    const text = deliveredText(result ?? {});
    if (text.length > 0) container.addChild(new Text(text, 0, 0));
    return container;
  }

  // Hue → pi color through the single bridge; absent on an unthemed
  // render, degrading every row to plain text.
  const colorize =
    typeof theme?.fg === "function"
      ? (hue: DisplayHue, text: string): string =>
          theme.fg(hueToPiColor(hue), text)
      : undefined;
  const strikethrough =
    typeof theme?.strikethrough === "function"
      ? (text: string): string => theme.strikethrough(text)
      : undefined;
  // Read-only: the todo card is a one-shot render of a settled snapshot;
  // the frame only fills the spinner slot for an in-progress row.
  const frame = context?.state?.frame ?? 0;

  const lines = todoLines(phases);
  const rows =
    lines.length === 0
      ? [collapsedSummaryLine(phases)]
      : options?.expanded === true
        ? fitToBudget(lines, EXPANDED_BODY_ROWS, overflowLine)
        : [
            collapsedSummaryLine(phases),
            ...fitToBudget(lines, COLLAPSED_BODY_ROWS, overflowLine),
          ];
  for (const row of rows) {
    container.addChild(rowComponent(row, colorize, strikethrough, frame));
  }
  return container;
}

// ---------------------------------------------------------------------------
// Deps-shaped wrapper
// ---------------------------------------------------------------------------

/**
 * The renderer surface attached to the todo tool contribution.
 *
 * Mirrors `buildSubagentCardRenderer`: the loose `(args, theme, context)`
 * / `(result, options, theme, context)` signatures are what pi's tool
 * registration forwards, matched to the `Deps["todoRenderer"]` port shape.
 * `renderCall` renders a plain-text title, so it ignores the theme.
 */
export function buildTodoCardRenderer(): {
  renderCall: (args: unknown, theme: unknown, context?: unknown) => unknown;
  renderResult: (
    result: unknown,
    options: unknown,
    theme: unknown,
    context?: unknown,
  ) => unknown;
} {
  return {
    renderCall: (args, _theme) => renderCall((args ?? {}) as TodoToolArgs),
    renderResult: (result, options, theme, context) =>
      renderResult(
        (result ?? {}) as TodoToolResult,
        (options ?? {}) as PiRenderOptionsLike,
        (theme ?? {}) as MarkdownThemeSource,
        context as PiRenderContextLike | undefined,
      ),
  };
}
