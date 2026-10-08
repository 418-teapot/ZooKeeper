/**
 * Test doubles for the pi TUI `theme` and `tui` seams.
 *
 * The pi TUI suites hand a stub `theme` (and, where the code inspects focus,
 * a stub `tui`) to renderers and widgets.  The suites differ only in which
 * theme methods they fake and how they tag the styled text, so `makeTheme`
 * fills pi's `MarkdownThemeSource` methods with assertable tag markup and
 * lets each suite override the fields it cares about; `stubTui` provides the
 * render-request sink every TUI stub starts from.
 *
 * @module
 */

/** The theme a `makeTheme()` call resolves to. */
export interface StubTheme {
  fg(color: string, text: string): string;
  bg(color: string, text: string): string;
  bold(text: string): string;
  italic(text: string): string;
  underline(text: string): string;
  strikethrough(text: string): string;
}

/** A `tui` stub that swallows render requests. */
export interface StubTui {
  requestRender(): void;
}

/** Wrap styled text in `<color>…</color>` tags. */
export function colorTag(color: string, text: string): string {
  return `<${color}>${text}</${color}>`;
}

/** Wrap styled text in `[bg]…[/bg]` tags (the default background variant). */
function bracketTag(color: string, text: string): string {
  return `[${color}]${text}[/${color}]`;
}

/** Leave styled text untouched (the default emphasis variant). */
function identity(text: string): string {
  return text;
}

/**
 * Build a theme stub; the defaults tag every field so tests can assert the
 * styling, and `overrides` replaces individual fields.
 */
export function makeTheme(overrides: Partial<StubTheme> = {}): StubTheme {
  return {
    fg: overrides.fg ?? colorTag,
    bg: overrides.bg ?? bracketTag,
    bold: overrides.bold ?? identity,
    italic: overrides.italic ?? identity,
    underline: overrides.underline ?? identity,
    strikethrough: overrides.strikethrough ?? identity,
  };
}

/** A `tui` stub that swallows render requests. */
export function stubTui(): StubTui {
  return { requestRender() {} };
}
