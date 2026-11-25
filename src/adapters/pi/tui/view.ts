/**
 * Pi TUI — the `zoo-view` custom-entry renderer.
 *
 * The `/view` page posts as a `zoo-view` custom entry: the core hands over
 * complete logical lines, and this renderer clips each line to the width
 * the transcript currently shows.  Clipping only removes a line's tail, so
 * the page's columns stay where the core put them and a resize repaints the
 * same entry at the new width.
 *
 * @module
 */

import { truncateToWidth } from "@earendil-works/pi-tui";

/**
 * Build the chat-transcript renderer for `zoo-view` custom entries.
 *
 * The appended entry carries the page's logical lines in `data.lines`.  The
 * returned duck-typed component (structurally
 * `{ render(width): string[], invalidate() }`) truncates the label and every
 * line in `render(width)` with pi-tui's `...` marker, so the client's current
 * width is the only width the page is trimmed to.  A missing or empty payload
 * degrades to `undefined`, so the entry renders as nothing.
 *
 * @returns The `EntryRenderer` for the `zoo-view` custom type.
 */
export function buildPiViewEntryRenderer(): (
  entry: unknown,
  _options: unknown,
  theme: unknown,
) => unknown {
  return (entry, _options, theme) => {
    const data = (entry as { data?: { lines?: unknown } } | undefined)?.data;
    const lines = Array.isArray(data?.lines)
      ? data.lines.filter((line): line is string => typeof line === "string")
      : [];
    if (lines.length === 0) return undefined;
    const t = theme as
      | { fg?: (color: string, text: string) => string }
      | undefined;
    const label = t?.fg ? t.fg("customMessageLabel", "[zoo]") : "[zoo]";
    return {
      render(width: number): string[] {
        return [
          truncateToWidth(label, width),
          ...lines.map((line) => truncateToWidth(line, width)),
        ];
      },
      invalidate(): void {},
    };
  };
}
