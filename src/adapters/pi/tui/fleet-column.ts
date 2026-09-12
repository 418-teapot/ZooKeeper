/**
 * Pi expanded fleet column renderer.
 *
 * The left-hand column of the pi dual-column widget: the scrolling window of
 * subagent run rows (top-level rows plus every nested generation indented
 * with `├─` / `└─`), the `↑`/`↓` overflow indicators, and the background band on
 * the selected row.  All row semantics come from the host-agnostic view model
 * (`src/core/subagent/view.ts`); this module only windows the roster, draws
 * the indicators, and colorizes each line through the single pi hue bridge
 * (agent-name segments go through the host `colorizeAgent` so a terminal row
 * carries its configured `[agent.<name>].color`).
 *
 * Pure renderer: it owns no widget state, no timers, and no key handling.
 * The top-level runs, the selection, the window size, and the row budget are
 * inputs supplied on every render — the widget owns the height budget and
 * hands this column an explicit row allotment.  The renderer holds no opinion
 * about the widget's total height.
 *
 * @module
 */

import {
  childrenOf,
  type SubagentRun,
  type WindowSlice,
  windowRuns,
} from "../../../core/subagent/registry.js";
import { type CardLine, renderFleetRows } from "../../../core/subagent/view.js";
import { hueToPiColor } from "./theme.js";

// ---------------------------------------------------------------------------
// Input surfaces (duck-typed, not pi imports)
// ---------------------------------------------------------------------------

/**
 * Structural subset of pi's `Theme` the fleet column colors with.
 *
 * `fg` is required; `bg` (the selected-row band) is optional so a minimal
 * theme stub keeps working — an absent capability falls back to a raw ANSI
 * background pair (see `highlight`).
 */
export interface FleetColumnThemeLike {
  fg(color: string, text: string): string;
  bg?(color: string, text: string): string;
}

/** Inputs for the expanded fleet column. */
export interface FleetColumnOptions {
  /**
   * The window's run-row budget (each top-level run costs `1 + descendants`
   * rendered rows; whole runs are windowed, never split).
   */
  windowRows: number;
  /**
   * The body's total row budget (indicators included). Required: the widget
   * owns the height budget and hands the column its allotment.
   */
  maxLines: number;
  /**
   * The selected run id.
   *
   * Drives the window anchor (the selected top-level run, or the parent of a
   * selected child, stays in view) and the selected row's background band.
   */
  selectedId?: string;
  /**
   * Whether the fleet column currently holds focus.
   *
   * The band is drawn only when this is `true`: when the todo column owns
   * focus its own band is the single focus cue, so the selected fleet row is
   * rendered as a plain colorized row.
   */
  focused: boolean;
  /** Spinner frame sequence; drives each running row's glyph. */
  frame: number;
  /** The current epoch-millis time (injected for determinism). */
  now: number;
  /** The pi theme (duck-typed). */
  theme: FleetColumnThemeLike;
  /** Colorize an agent name per its configured `[agent.<name>].color`. */
  colorizeAgent(name: string): string;
}

// ---------------------------------------------------------------------------
// Rendering helpers
// ---------------------------------------------------------------------------

/**
 * Colorize one view-model line with the pi theme.
 *
 * A line that carries `segments` is colorized per segment: each segment with
 * a hue is wrapped in `theme.fg` alone, and a segment without a hue is
 * emitted verbatim.  This keeps a pre-colorized segment (the agent name,
 * carrying its own embedded ANSI sequence that ends with `\x1b[39m`) from
 * washing out the colors of later segments — the reset sequence never sits
 * inside an outer wrap.  A segment marked with its `agent` name is rendered
 * through the host `colorizeAgent`.  A line without segments falls back to
 * the whole-line wrap.
 */
function colorize(
  line: CardLine,
  theme: FleetColumnThemeLike,
  colorizeAgent: (name: string) => string,
): string {
  if (line.segments !== undefined && line.segments.length > 0) {
    return line.segments
      .map((segment) => {
        if (segment.agent !== undefined) {
          return colorizeAgent(segment.agent);
        }
        return segment.hue === undefined
          ? segment.text
          : theme.fg(hueToPiColor(segment.hue), segment.text);
      })
      .join("");
  }
  return theme.fg(hueToPiColor(line.hue), line.text);
}

/** Dim a secondary text with the pi theme. */
function dim(theme: FleetColumnThemeLike, text: string): string {
  return theme.fg("dim", text);
}

/**
 * Highlight a selected fleet row with a background band.
 *
 * The whole rendered line (per-segment colors + body) is wrapped:
 * the inner ANSI sequences use fg-only resets (`\x1b[39m`), which never clear
 * a background color, so the band survives the embedded colorization and the
 * segments' own foreground hues stay intact (unlike reverse video, which
 * swaps fg/bg per cell).  Uses pi's `Theme.bg` with the `selectedBg` token
 * (the same token pi's host selectors use) when the theme provides it, else a
 * raw ANSI 256-color gray (index 239, ≈ `#4e4e4e`) approximating pi's default
 * dark theme `selectedBg: #3a3a4a` (which has no exact 256-color
 * counterpart).
 */
function highlight(theme: FleetColumnThemeLike, text: string): string {
  return theme.bg !== undefined
    ? theme.bg("selectedBg", text)
    : `\x1b[48;5;239m${text}\x1b[49m`;
}

/**
 * The window anchor: the selected top-level id, or the top-level ancestor of
 * a selected descendant at any depth (so the selected run's top-level run
 * stays in view).  A stale id yields `undefined` and `windowRuns`
 * bottom-aligns.
 */
function anchorFor(
  tops: readonly SubagentRun[],
  selectedId: string | undefined,
): string | undefined {
  if (selectedId === undefined) return undefined;
  const contains = (runId: string): boolean => {
    if (runId === selectedId) return true;
    return childrenOf(runId).some((child) => contains(child.id));
  };
  for (const top of tops) {
    if (contains(top.id)) return top.id;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Public renderer
// ---------------------------------------------------------------------------

/**
 * Render the expanded fleet column rows.
 *
 * The roster windows around the selection by WHOLE run: a top-level run plus
 * its descendants at every generation is one indivisible unit that occupies
 * `1 + <descendant count>` rendered rows.  The window is chosen so the
 * visible runs plus any `↑`/`↓` overflow indicators fit `maxLines`: the
 * budget is searched down from `windowRows` until the rendered block fits,
 * so an over-budget window hides whole runs (surfaced as `↑ N more` /
 * `↓ N more`) instead of trimming rows off the end of the last run.  When
 * even a single run alone overflows the budget, that run's own row is kept,
 * its head child rows fill what remains beside one `… +K more` hint row, and
 * the tail child rows (along with the whole-run indicators) are dropped, so
 * the result stays within `maxLines`.
 *
 * The selection band is drawn only while `focused` is set (see
 * {@link FleetColumnOptions.focused}).
 *
 * @param tops - The session's top-level runs, in display order.
 * @param opts - The window size, row budget, selection, focus flag, frame /
 *   clock, theme, and agent colorizer.
 * @returns The rendered rows, at most `opts.maxLines` long.  When a single
 *   run alone exceeds the budget, its trailing child rows are summarized by
 *   a `… +K more` row so the bound still holds.
 */
export function renderFleetColumn(
  tops: readonly SubagentRun[],
  opts: FleetColumnOptions,
): string[] {
  const { windowRows, maxLines, selectedId, focused, frame, now, theme } = opts;
  // Index every run that has children, at any depth, so the recursive
  // renderer and the row count below walk the whole tree — not just the
  // top-level runs' direct children.
  const childrenByParent = new Map<string, SubagentRun[]>();
  const collect = (run: SubagentRun): void => {
    const children = childrenOf(run.id);
    if (children.length === 0) return;
    childrenByParent.set(run.id, children);
    for (const child of children) collect(child);
  };
  for (const top of tops) collect(top);

  const descendantCount = (runId: string): number => {
    const children = childrenByParent.get(runId);
    if (children === undefined) return 0;
    let total = 0;
    for (const child of children) total += 1 + descendantCount(child.id);
    return total;
  };
  // One row per run, at every generation: this must equal the number of
  // lines `renderFleetRows` emits for the run, or the window budget lies.
  const rowsOf = (run: SubagentRun): number => 1 + descendantCount(run.id);
  const anchor = anchorFor(tops, selectedId);

  // Pick the largest whole-run window (bounded by `windowRows`) whose rows
  // plus their overflow indicators still fit `maxLines`.  Shrinking the
  // budget hides whole runs, so a run's nested children are never cut in
  // half.  When even the smallest window overflows, the fallback below keeps
  // that single run's row and summarizes its trailing children.
  const budgetCap = Math.max(1, Math.floor(windowRows));
  let slice!: WindowSlice;
  for (let budget = budgetCap; budget >= 1; budget--) {
    const candidate = windowRuns([...tops], anchor, budget, rowsOf);
    slice = candidate;
    const runRows = candidate.rows.reduce((sum, r) => sum + rowsOf(r), 0);
    const indicators =
      (candidate.hiddenAbove > 0 ? 1 : 0) + (candidate.hiddenBelow > 0 ? 1 : 0);
    if (runRows + indicators <= maxLines) break;
  }

  const paint = (line: CardLine): string => {
    const colored = colorize(line, theme, opts.colorizeAgent);
    const banded = line.selected === true && focused;
    return banded ? highlight(theme, colored) : colored;
  };

  const out: string[] = [];
  if (slice.hiddenAbove > 0) {
    out.push(dim(theme, `↑ ${slice.hiddenAbove} more`));
  }
  const rendered = renderFleetRows(
    slice.rows,
    childrenByParent,
    selectedId,
    frame,
    now,
  );
  for (const line of rendered) out.push(paint(line));
  if (slice.hiddenBelow > 0) {
    out.push(dim(theme, `↓ ${slice.hiddenBelow} more`));
  }

  const budget = Math.floor(maxLines);
  // `maxLines < 1` is a degenerate caller and the common case fits; both
  // return the assembled rows unchanged.
  if (budget < 1 || out.length <= budget) return out;

  // Degenerate fallback: the budget search never found a fitting window, so
  // the slice is the smallest one — a single run.  Keep that run's own row,
  // drop the whole-run indicators, and keep as many head child rows as fit
  // beside one `… +K more` hint row; the tail child rows are dropped and the
  // hint (itself within the budget) reports how many.
  const childLines = rendered.slice(1);
  const lines = [paint(rendered[0])];
  const roomForChildren = budget - 1;
  if (childLines.length > 0 && roomForChildren >= 1) {
    if (childLines.length <= roomForChildren) {
      for (const line of childLines) lines.push(paint(line));
    } else {
      const keep = roomForChildren - 1;
      for (let i = 0; i < keep; i++) lines.push(paint(childLines[i]));
      lines.push(dim(theme, `… +${childLines.length - keep} more`));
    }
  }
  return lines;
}
