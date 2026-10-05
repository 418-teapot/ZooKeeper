/**
 * Pi TUI — the `zoo-notice` custom-entry renderer.
 *
 * Slash-command chat notifications post as `zoo-notice` custom entries
 * through the pi tool host's in-session `appendEntry` channel.  pi renders
 * each such entry with the renderer built here, so the notice text becomes
 * a `[zoo]`-labelled block in the chat transcript without ever entering the
 * LLM context.
 *
 * @module
 */

/**
 * Build the chat-transcript renderer for `zoo-notice` custom entries.
 *
 * pi invokes the renderer with the appended `CustomEntry` (the
 * notification text lives in `data.content`), the render options, and
 * the active `Theme`.  The returned duck-typed `Component` (structurally
 * `{ render(width): string[], invalidate() }`) is placed into the TUI
 * chat transcript by pi's `CustomEntryComponent` — no pi package is
 * imported, mirroring the duck-typing discipline of the rest of the
 * adapter.  A missing or empty payload degrades to `undefined` so the
 * entry renders as nothing.  Renderer errors are caught and surfaced
 * by pi itself (an error box), so no defensive wrapping is needed here.
 *
 * @returns The `EntryRenderer` for the `zoo-notice` custom type.
 */
export function buildPiNoticeEntryRenderer(): (
  entry: unknown,
  _options: unknown,
  theme: unknown,
) => unknown {
  return (entry, _options, theme) => {
    const data = (entry as { data?: { content?: unknown } } | undefined)?.data;
    const content = typeof data?.content === "string" ? data.content : "";
    if (!content.trim()) return undefined;
    const t = theme as
      | { fg?: (color: string, text: string) => string }
      | undefined;
    const label = t?.fg ? t.fg("customMessageLabel", "[zoo]") : "[zoo]";
    const text = `${label}\n${content}`;
    return {
      render(): string[] {
        return text.split("\n");
      },
      invalidate(): void {},
    };
  };
}
