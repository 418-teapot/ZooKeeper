/**
 * Dual-column layout primitives for pi TUI widgets.
 *
 * Renders two independent `string[]` line arrays side by side so a widget can
 * show, for example, a subagent fleet on the left and a todo list on the
 * right.  All helpers are pure string composition over pi-tui's ANSI-aware
 * width utilities: they know nothing about the pi host, pi components, or
 * the widget that consumes them, and they leave vertical stacking decisions
 * to the caller via `isNarrowLayout`.
 *
 * @module
 */

import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

/** Separator drawn between the two columns (space, box bar, space). */
const COLUMN_SEPARATOR = " │ ";

/** Visible width of {@link COLUMN_SEPARATOR}. */
const SEPARATOR_WIDTH = 3;

/** Minimum total width at which the two columns render side by side. */
const WIDE_LAYOUT_MIN_WIDTH = 100;

/** Share of the remaining width given to the left column in wide layout. */
const LEFT_COLUMN_SHARE = 0.55;

/**
 * Right-pad a possibly ANSI-colored line with spaces to an exact visible
 * width.
 *
 * Padding is measured on the visible width (escape sequences do not count).
 * A line already at or beyond `width` is returned unchanged — truncation is
 * the caller's responsibility.
 *
 * @param line - The line to pad, possibly containing ANSI escape codes.
 * @param width - The target visible width.
 * @returns The line padded with trailing spaces to `width` visible columns.
 */
export function padToWidth(line: string, width: number): string {
  const padding = width - visibleWidth(line);
  if (padding <= 0) {
    return line;
  }
  return line + " ".repeat(padding);
}

/**
 * Decide whether the layout should stack its columns vertically.
 *
 * @param width - The available total width in columns.
 * @returns `true` below 100 columns (stack), `false` at 100 or more (side by
 *   side).
 */
export function isNarrowLayout(width: number): boolean {
  return width < WIDE_LAYOUT_MIN_WIDTH;
}

/**
 * Split the total available width into the two column widths.
 *
 * Shares the separator and share arithmetic with {@link joinColumns}: the
 * separator is carved out first, then the remainder is split 55/45 between
 * the left and right columns (the split rounds down for the left column and
 * gives the leftover to the right, so the widths always sum back to the
 * content width).
 *
 * @param totalWidth - The total available width, separator included.
 * @returns The left and right column visible widths.
 */
export function columnWidths(totalWidth: number): {
  left: number;
  right: number;
} {
  const contentWidth = Math.max(0, totalWidth - SEPARATOR_WIDTH);
  const left = Math.floor(contentWidth * LEFT_COLUMN_SHARE);
  return { left, right: contentWidth - left };
}

/**
 * Join two pre-rendered line arrays side by side with a vertical separator.
 *
 * Each input line is truncated to its column width and padded to the full
 * column width, so every output line has the same visible width equal to
 * `totalWidth`.  When the columns have different heights the shorter one is
 * padded with blank lines, keeping rows aligned and the separator present on
 * every output line.
 *
 * @param left - Pre-rendered lines for the left column.
 * @param right - Pre-rendered lines for the right column.
 * @param totalWidth - The total available width, separator included.
 * @returns The joined lines, one per row of the taller column.
 */
export function joinColumns(
  left: readonly string[],
  right: readonly string[],
  totalWidth: number,
): string[] {
  const { left: leftWidth, right: rightWidth } = columnWidths(totalWidth);
  const rows = Math.max(left.length, right.length);

  const lines: string[] = [];
  for (let row = 0; row < rows; row += 1) {
    const leftLine = padToWidth(
      truncateToWidth(left[row] ?? "", leftWidth),
      leftWidth,
    );
    const rightLine = padToWidth(
      truncateToWidth(right[row] ?? "", rightWidth),
      rightWidth,
    );
    lines.push(leftLine + COLUMN_SEPARATOR + rightLine);
  }
  return lines;
}
