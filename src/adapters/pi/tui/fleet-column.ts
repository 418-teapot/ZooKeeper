/**
 * Pi expanded fleet column renderer.
 *
 * The left-hand column of the pi dual-column widget: the scrolling window of
 * subagent run rows (top-level rows plus one nested-child level indented with
 * `├─` / `└─`), the `↑`/`↓` overflow indicators, and the background band on
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
  /** The run-window height (top-level rows kept visible). */
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
 * The window anchor: the selected top-level id, or the parent of a selected
 * child (so the child's parent stays in view).  A stale id yields `undefined`
 * and `windowRuns` bottom-aligns.
 */
function anchorFor(
  tops: readonly SubagentRun[],
  selectedId: string | undefined,
): string | undefined {
  if (selectedId === undefined) return undefined;
  for (const top of tops) {
    if (top.id === selectedId) return top.id;
    if (childrenOf(top.id).some((child) => child.id === selectedId)) {
      return top.id;
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Public renderer
// ---------------------------------------------------------------------------

/**
 * Render the expanded fleet column rows.
 *
 * The roster windows around the selection (`windowRuns`) within `windowRows`
 * top-level rows, surfacing any hidden runs as `↑`/`↓` overflow indicators.
 * The assembled block (↑ + rows + ↓) can still exceed `maxLines` when nested
 * children inflate the rows (each child renders its own line) or both
 * indicators appear; the trim removes lines from the END of the run-row block
 * only — never the trailing `↓` indicator (which a naive tail-slice would
 * cut) nor the leading `↑`.
 *
 * The selection band is drawn only while `focused` is set (see
 * {@link FleetColumnOptions.focused}).
 *
 * @param tops - The session's top-level runs, in display order.
 * @param opts - The window size, row budget, selection, focus flag, frame /
 *   clock, theme, and agent colorizer.
 * @returns The rendered rows, at most `opts.maxLines` long.
 */
export function renderFleetColumn(
  tops: readonly SubagentRun[],
  opts: FleetColumnOptions,
): string[] {
  const { windowRows, maxLines, selectedId, focused, frame, now, theme } = opts;
  const childrenByParent = new Map<string, SubagentRun[]>();
  for (const top of tops) {
    childrenByParent.set(top.id, childrenOf(top.id));
  }
  const slice = windowRuns([...tops], anchorFor(tops, selectedId), windowRows);

  const out: string[] = [];
  if (slice.hiddenAbove > 0) {
    out.push(dim(theme, `↑ ${slice.hiddenAbove} more`));
  }
  for (const line of renderFleetRows(
    slice.rows,
    childrenByParent,
    selectedId,
    frame,
    now,
  )) {
    const colored = colorize(line, theme, opts.colorizeAgent);
    const banded = line.selected === true && focused;
    out.push(banded ? highlight(theme, colored) : colored);
  }
  if (slice.hiddenBelow > 0) {
    out.push(dim(theme, `↓ ${slice.hiddenBelow} more`));
  }

  // Nested children (or both indicators) can push the assembled block past
  // the budget.  Trim from the end of the run-row block only, preserving the
  // leading ↑ and the trailing ↓ indicator.
  if (out.length <= maxLines) return out;
  const overflow = out.length - maxLines;
  const hasUp = slice.hiddenAbove > 0;
  const hasDown = slice.hiddenBelow > 0;
  const runStart = hasUp ? 1 : 0;
  const runEnd = hasDown ? out.length - 1 : out.length;
  const remove = Math.min(overflow, runEnd - runStart);
  out.splice(runEnd - remove, remove);
  return out;
}
