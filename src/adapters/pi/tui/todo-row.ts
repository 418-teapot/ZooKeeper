/**
 * Shared todo row-body composition.
 *
 * Both the transcript card (`todo-card.ts`) and the dual-column widget
 * (`todo-column.ts`) render the same view-model rows, so the task-row body
 * — the glyph slot (the shared braille spinner frame for a spinner row, the
 * pre-computed status glyph otherwise) plus the completed-row strikethrough
 * — lives here once.  Non-task rows carry their view-model `text` verbatim.
 *
 * @module
 */

import { SPINNER_FRAMES, spinnerFrameIndex } from "../../../core/display.js";
import type { TodoViewLine } from "../../../core/todo/view.js";

/**
 * The uncolored body of one view-model row.
 *
 * A task row prefixes the glyph slot and strikes the text of a completed
 * row; every other row kind carries its text verbatim (the view model
 * already composed its fold glyph, counts, and blocker note).
 *
 * @param row - The view-model row.
 * @param frame - The spinner frame index (drives an animated glyph slot).
 * @param strikethrough - Optional completed-row text styler.
 * @returns The row body (glyph-prefixed for task rows, verbatim otherwise).
 */
export function todoRowBody(
  row: TodoViewLine,
  frame: number,
  strikethrough?: (text: string) => string,
): string {
  if (row.kind !== "task") return row.text;
  const glyph = row.spinner
    ? SPINNER_FRAMES[spinnerFrameIndex(frame)]
    : row.glyph;
  const text =
    row.strikethrough === true && strikethrough !== undefined
      ? strikethrough(row.text)
      : row.text;
  return `${glyph} ${text}`;
}
