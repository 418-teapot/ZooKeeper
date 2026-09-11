/**
 * Pi dual-column todo column renderer.
 *
 * The right-hand column of the pi dual-column widget: the expanded list of
 * projected todo rows and the collapsed one-line summary segment.  All row
 * semantics (glyph, hue, text, overflow, counts) and the single
 * enumerate-all projection come from the host-agnostic todo view model
 * (`src/core/todo/view.ts`); this module only colorizes rows
 * through the single pi hue bridge, substitutes the shared spinner frame for
 * an animated glyph slot, applies the completed-row strikethrough, paints the
 * focused row's background band, and truncates each row to the column width
 * with pi's ANSI-aware `truncateToWidth`.
 *
 * Pure renderer: it owns no widget state, no timers, no key handling, and no
 * height opinion — `frame`, `focused`, `maxRows` (the explicit row
 * allotment), and the optional scroll selection are inputs the widget
 * supplies on every render.  The collapsed form is a bare segment (no
 * trailing padding) — the widget composes it with the fleet segment and the
 * column separator itself.
 *
 * @module
 */

import { truncateToWidth } from "@earendil-works/pi-tui";
import { fitToBudget } from "../../../core/display.js";
import type { TodoPhase } from "../../../core/todo/types.js";
import {
  collapsedSummaryLine,
  overflowLine,
  type TodoSummaryLine,
  type TodoViewLine,
  todoLines,
} from "../../../core/todo/view.js";
import { hueToPiColor } from "./theme.js";
import { todoRowBody } from "./todo-row.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** The muted placeholder row shown for an empty plan. */
const EMPTY_PLACEHOLDER = "待办 —";

// ---------------------------------------------------------------------------
// Input surfaces (duck-typed, not pi imports)
// ---------------------------------------------------------------------------

/**
 * Structural subset of pi's `Theme` the todo column colors with.
 *
 * `fg` is required; `bg` (the focused-row band) and `strikethrough`
 * (completed rows) are optional so a minimal theme stub keeps working — an
 * absent capability degrades that one decoration to plain text.
 */
export interface TodoColumnThemeLike {
  fg(color: string, text: string): string;
  bg?(color: string, text: string): string;
  strikethrough?(text: string): string;
}

/** Inputs for the expanded todo column. */
export interface TodoColumnOptions {
  /** Column width; each rendered row is truncated to it. */
  width: number;
  /** Spinner frame sequence; drives an in-progress row's glyph slot. */
  frame: number;
  /**
   * Whether the column currently holds focus.
   *
   * Without a selection the first row carries the `selectedBg` band; with a
   * selection the selected row does.
   */
  focused: boolean;
  /** The pi theme (duck-typed). */
  theme: TodoColumnThemeLike;
  /**
   * The selected projected-row index (a scrolling selection).
   *
   * When provided the column windows its projected rows so this index stays
   * visible (with `↑`/`↓` overflow indicators for the hidden rows), and the
   * focused band follows it.  When absent the column keeps the fixed-budget
   * behaviour: the first `maxRows` rows, with the view model's `+N more`
   * overflow row last.
   */
  selectedIndex?: number;
  /**
   * The total output row budget (indicators included). Required: the widget
   * owns the height budget and hands the column its allotment; the column
   * never emits more rows than this, summarizing any dropped work in an
   * overflow row.
   */
  maxRows: number;
  /**
   * Per-phase fold overrides (phase name → whether to enumerate its tasks).
   *
   * A phase's fold defaults to its settled status; an entry here overrides
   * that default in either direction.
   */
  foldOverrides?: ReadonlyMap<string, boolean>;
}

/** Inputs for the collapsed todo summary segment. */
export interface TodoCollapsedOptions {
  /** The pi theme (duck-typed). */
  theme: TodoColumnThemeLike;
  /** Optional width; the segment truncates to it when provided. */
  width?: number;
}

// ---------------------------------------------------------------------------
// Rendering helpers
// ---------------------------------------------------------------------------

/** Colorize text through the single hue bridge (plain without a usable fg). */
function colorize(
  theme: TodoColumnThemeLike,
  hue: TodoViewLine["hue"],
  text: string,
): string {
  return typeof theme?.fg === "function"
    ? theme.fg(hueToPiColor(hue), text)
    : text;
}

/** A muted placeholder row standing in for an empty plan. */
function placeholderLine(): TodoSummaryLine {
  return {
    kind: "summary",
    done: 0,
    total: 0,
    text: EMPTY_PLACEHOLDER,
    hue: "muted",
  };
}

/** Truncate a row to a positive width (pi's ANSI-aware clipper). */
function clip(row: string, width: number): string {
  return truncateToWidth(row, Math.max(1, width));
}

/** A windowed slice of projected rows, with the hidden counts around it. */
interface RowWindow {
  /** The visible rows. */
  rows: TodoViewLine[];
  /** How many projected rows sit above the window. */
  hiddenAbove: number;
  /** How many projected rows sit below the window. */
  hiddenBelow: number;
  /** The selected row's index inside `rows`. */
  selectedIndex: number;
}

/**
 * Window projected rows around a selection within a row budget.
 *
 * Mirrors the fleet roster's window semantics: the selection stays visible
 * while the window shows as many later rows as fit, and a window anchored at
 * either end spends the free indicator slot on one more row.  The reserved
 * indicator rows count against the budget, so the output never exceeds it.
 *
 * @param rows - The projected rows in display order.
 * @param selectedIndex - The selected projected-row index.
 * @param budget - The total output row budget (indicators included).
 * @returns The visible slice plus the counts hidden above and below it.
 */
function windowRows(
  rows: readonly TodoViewLine[],
  selectedIndex: number,
  budget: number,
): RowWindow {
  const n = rows.length;
  const sel = Math.min(
    Math.max(0, Math.floor(selectedIndex)),
    Math.max(0, n - 1),
  );
  if (n <= budget) {
    return {
      rows: [...rows],
      hiddenAbove: 0,
      hiddenBelow: 0,
      selectedIndex: sel,
    };
  }
  // Below three rows there is no room for two content rows plus two side
  // indicators.  A budget of one shows only the selected row; a budget of
  // two shows the selected row plus one combined indicator (the renderer
  // merges the two hidden counts into a single line).
  if (budget < 3) {
    return {
      rows: [rows[sel]],
      hiddenAbove: budget === 1 ? 0 : sel,
      hiddenBelow: budget === 1 ? 0 : n - sel - 1,
      selectedIndex: 0,
    };
  }
  // Reserve one row per side for the overflow indicators, then grow back to
  // `budget - 1` rows when the window sits at one end (only one indicator
  // is needed there).
  let cap = Math.max(1, budget - 2);
  let start = Math.min(sel, Math.max(0, n - cap));
  let hiddenAbove = start;
  let hiddenBelow = n - (start + cap);
  if (hiddenAbove === 0 && hiddenBelow > 0 && cap < budget - 1) {
    cap = Math.min(budget - 1, n);
    start = 0;
    hiddenAbove = 0;
    hiddenBelow = n - cap;
  } else if (hiddenBelow === 0 && hiddenAbove > 0 && cap < budget - 1) {
    cap = Math.min(budget - 1, n);
    start = Math.max(0, n - cap);
    hiddenAbove = start;
    hiddenBelow = 0;
  }
  return {
    rows: rows.slice(start, start + cap),
    hiddenAbove,
    hiddenBelow,
    selectedIndex: sel - start,
  };
}

// ---------------------------------------------------------------------------
// Public renderers
// ---------------------------------------------------------------------------

/**
 * Render the expanded todo column rows.
 *
 * The plan projects through the single core projection (`todoLines`): a
 * phase's fold defaults to its settled status (open phases enumerate,
 * settled phases collapse to their header) and `foldOverrides` overrides
 * that per phase.  Without a selection those rows clip to `maxRows` with the
 * shared `fitToBudget`, so dropped work always resurfaces as the view
 * model's `+N more` overflow row.  With a `selectedIndex` the column
 * windows the projected rows around that index (still within `maxRows`),
 * surfacing the
 * hidden rows as `↑`/`↓` overflow indicators, and the focused `selectedBg`
 * band follows the selection.  Every row is colorized by its semantic hue;
 * a completed row keeps its strikethrough and a spinner row takes the
 * current `frame`'s braille character.  An empty plan renders a single
 * muted `待办 —` placeholder, clipped like any other row.
 *
 * @param phases - Todo phases to render.
 * @param opts - Width, the explicit `maxRows` row budget, spinner frame,
 *   focus flag, theme, and the optional scroll selection / phase fold
 *   overrides.
 * @returns The rendered rows, each at most `opts.width` visible columns and
 *   at most `maxRows` rows long.
 */
export function renderTodoColumn(
  phases: readonly TodoPhase[],
  opts: TodoColumnOptions,
): string[] {
  const { width, frame, focused, theme, selectedIndex, foldOverrides } = opts;
  const budget = Math.max(1, Math.floor(opts.maxRows));
  const empty = phases.length === 0;

  let rows: TodoViewLine[];
  let selectedLocal: number | undefined;
  let hiddenAbove = 0;
  let hiddenBelow = 0;
  if (selectedIndex === undefined) {
    // No selection: clip the projection, so dropped work surfaces as the
    // `+N more` row.
    rows = empty
      ? [placeholderLine()]
      : fitToBudget(todoLines(phases, { foldOverrides }), budget, overflowLine);
    selectedLocal = focused ? 0 : undefined;
  } else {
    // Selection: window the projected rows so the index can never land on a
    // row the budget would have dropped.
    const projected = empty
      ? [placeholderLine()]
      : todoLines(phases, { foldOverrides });
    const windowed = windowRows(projected, selectedIndex, budget);
    rows = windowed.rows;
    selectedLocal = windowed.selectedIndex;
    hiddenAbove = windowed.hiddenAbove;
    hiddenBelow = windowed.hiddenBelow;
  }

  const out: string[] = [];
  // A budget of two has room for one indicator row only: when both sides
  // hold hidden rows, merge them into a single line so the output still
  // fits the budget.
  const merged = hiddenAbove > 0 && hiddenBelow > 0 && budget < 3;
  if (hiddenAbove > 0 && !merged) {
    out.push(clip(colorize(theme, "muted", `↑ ${hiddenAbove} more`), width));
  }
  if (merged) {
    out.push(
      clip(
        colorize(theme, "muted", `↑ ${hiddenAbove} ↓ ${hiddenBelow}`),
        width,
      ),
    );
  }
  rows.forEach((row, index) => {
    const strikethrough =
      typeof theme?.strikethrough === "function"
        ? theme.strikethrough
        : undefined;
    let rendered = colorize(
      theme,
      row.hue,
      todoRowBody(row, frame, strikethrough),
    );
    if (focused && selectedLocal === index && typeof theme?.bg === "function") {
      rendered = theme.bg("selectedBg", rendered);
    }
    out.push(clip(rendered, width));
  });
  if (hiddenBelow > 0 && !merged) {
    out.push(clip(colorize(theme, "muted", `↓ ${hiddenBelow} more`), width));
  }
  return out;
}

/**
 * Render the collapsed todo summary segment.
 *
 * A single bare string (no trailing padding) built from the core
 * `collapsedSummaryLine` — the plan-wide `done/total` counts plus the
 * current item — colorized by its semantic hue.  An empty plan renders the
 * muted `待办 —` placeholder.  When `opts.width` is given the segment
 * truncates to it; otherwise it is returned at its natural width for the
 * widget to compose alongside the fleet segment.
 *
 * @param phases - Todo phases to summarize.
 * @param opts - Theme and an optional width.
 * @returns The summary segment.
 */
export function renderTodoCollapsed(
  phases: readonly TodoPhase[],
  opts: TodoCollapsedOptions,
): string {
  const { theme, width } = opts;
  const line =
    phases.length === 0
      ? colorize(theme, "muted", EMPTY_PLACEHOLDER)
      : (() => {
          const summary = collapsedSummaryLine(phases);
          return colorize(theme, summary.hue, summary.text);
        })();
  return width === undefined ? line : clip(line, width);
}
