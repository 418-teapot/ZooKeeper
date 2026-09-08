/**
 * Domain-neutral TUI display primitives.
 *
 * The single source of truth for the domain-neutral presentation
 * primitives shared by the display view models (`src/core/subagent/view.ts`
 * and `src/core/todo/view.ts`):
 *   - `DisplayHue` — the five semantic hues a display line can carry.
 *   - `PresentationStatus` / `STATUS_PRESENTATION` — the canonical
 *     status→presentation table (glyph, hue, spinner flag) every domain
 *     resolves through a one-line domain mapping.
 *   - `SPINNER_FRAMES` / `spinnerFrameIndex` — the canonical braille spinner
 *     frame sequence and its frame-selector helper.
 *   - Structural symbols — the fold glyphs (`FOLD_COLLAPSED` /
 *     `FOLD_EXPANDED`) and the tree branch glyphs (`TREE_BRANCH` /
 *     `TREE_LAST`), one unique meaning per symbol.
 *   - `fitToBudget` — the generic line-budget fit: emit every line, or the
 *     first `budget - 1` lines plus one caller-built overflow row.
 *
 * This module only declares semantics — core never knows pi's concrete
 * theme colors.  The host adapter maps each hue onto a real color in one
 * place (`src/adapters/pi/tui/theme.ts` `hueToPiColor`).
 *
 * @module
 */

/**
 * The canonical ten-frame braille spinner.
 */
export const SPINNER_FRAMES = [
  "⠋",
  "⠙",
  "⠹",
  "⠸",
  "⠼",
  "⠴",
  "⠦",
  "⠧",
  "⠇",
  "⠏",
];

/** Semantic hues a display line can carry. */
export type DisplayHue = "running" | "success" | "error" | "muted" | "accent";

/**
 * The domain-neutral presentation statuses.
 *
 * A domain maps its own states onto exactly one of these six canonical
 * statuses (`active` / `waiting` / `succeeded` / `failed` / `blocked` /
 * `cancelled`) and
 * reads everything else — glyph, hue, spinner flag — from the single
 * `STATUS_PRESENTATION` table below, so no two domains can ever render the
 * same canonical state differently.
 */
export type PresentationStatus =
  | "active"
  | "waiting"
  | "succeeded"
  | "failed"
  | "blocked"
  | "cancelled";

/** How a canonical presentation status renders. */
export interface StatusPresentation {
  /** The semantic glyph (empty for `active` — the spinner owns the slot). */
  glyph: string;
  /** The semantic hue the glyph and its line carry. */
  hue: DisplayHue;
  /** Whether the glyph slot animates (the host's clock drives the frame). */
  spinner?: boolean;
}

/**
 * The single status → presentation table.
 *
 * `active` marks the spinner flag with an empty glyph (the host emits the
 * frame character per render); `blocked` shares the `running` hue with
 * `active` but stays static — the spinner flag is what separates the
 * animated running state from the blocked one.
 *
 * The glyph carries a shape axis on top of the hue axis: a circle marks a
 * normal state (succeeded, blocked, waiting), a square marks a non-success
 * termination — red (`error`) for a failure, muted for a cancellation or
 * abandonment, so a user-intent stop stays visually distinct from an
 * exception.
 */
export const STATUS_PRESENTATION: Record<
  PresentationStatus,
  StatusPresentation
> = {
  active: { glyph: "", hue: "running", spinner: true },
  waiting: { glyph: "○", hue: "muted" },
  succeeded: { glyph: "●", hue: "success" },
  failed: { glyph: "■", hue: "error" },
  blocked: { glyph: "●", hue: "running" },
  cancelled: { glyph: "■", hue: "muted" },
};

/**
 * Compute the display index of the current spinner frame.
 *
 * @param seq - A monotonically increasing sequence counter.
 * @returns The frame index into `SPINNER_FRAMES`.
 */
export function spinnerFrameIndex(seq: number): number {
  return (
    ((Math.max(0, seq) % SPINNER_FRAMES.length) + SPINNER_FRAMES.length) %
    SPINNER_FRAMES.length
  );
}

/**
 * Structural fold glyphs for expandable headers.
 *
 * Distinct from every status glyph in `STATUS_PRESENTATION` and from the
 * tree branch glyphs below: a fold glyph carries expansion state, nothing
 * else.
 */

/** Fold glyph for a collapsed (one-line) header. */
export const FOLD_COLLAPSED = "▸";

/** Fold glyph for an expanded header. */
export const FOLD_EXPANDED = "▾";

/**
 * Structural tree glyphs for nested (indented) lines.
 *
 * Distinct from every fold and status glyph: a tree glyph marks nesting
 * only.  `TREE_BRANCH` renders all but the last child of a parent;
 * `TREE_LAST` renders the last child.
 */

/** Tree glyph for a nested child that is not the last of its parent. */
export const TREE_BRANCH = "├─";

/** Tree glyph for the last nested child of a parent. */
export const TREE_LAST = "└─";

/**
 * Fit a sequence of display lines into a fixed line budget.
 *
 * The domain-neutral budget primitive: a view model emits its lines in full
 * semantic order, and each surface clips the result to its own physical
 * space by passing its budget here.  When every line fits, the sequence is
 * returned unchanged.  When it does not, the first `budget - 1` lines are
 * kept and the remaining `hidden` lines are summarized by a single row the
 * caller builds through `makeOverflow` (e.g. a `+N more` row) — overflow is
 * always discoverable, never silently dropped.
 *
 * Degenerate budgets: `budget < 1` leaves room for nothing — an empty input
 * stays empty, and a non-empty input collapses to a single overflow row
 * summarizing all of its lines (`makeOverflow(lines.length)`).
 *
 * @param lines - Display lines in their full semantic order.
 * @param budget - Maximum number of rows the surface can show (required —
 *   the caller owns the number; this module carries no default).
 * @param makeOverflow - Builds the single overflow row from the count of
 *   hidden lines.
 * @returns The fitted rows: at most `budget` of them, the last one being
 *   the overflow row when lines were dropped.
 */
export function fitToBudget<T>(
  lines: readonly T[],
  budget: number,
  makeOverflow: (hiddenCount: number) => T,
): T[] {
  if (budget < 1) {
    return lines.length > 0 ? [makeOverflow(lines.length)] : [];
  }
  if (lines.length <= budget) return [...lines];
  const hidden = lines.length - (budget - 1);
  return [...lines.slice(0, budget - 1), makeOverflow(hidden)];
}
