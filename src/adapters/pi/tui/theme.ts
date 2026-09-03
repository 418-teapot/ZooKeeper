/**
 * Semantic-hue → pi theme color mapping for the subagent transcript card.
 *
 * The card view model (`src/core/subagent/view.ts`) emits lines tagged with
 * semantic hues (`running` / `success` / `error` / `muted` / `accent`).
 * This module is the SINGLE place that translates those hues into pi theme
 * color names for `theme.fg(...)`.  Everything pi-specific about coloring
 * lives here; core never knows pi's color vocabulary.
 *
 * The markdown theme also lives here — the card and the transcript overlay
 * share the same "render markdown with pi's full theme" contract, so the
 * `fullMarkdownTheme` constructor is defined once and imported by both
 * adapters.
 *
 * @module
 */

import type { MarkdownTheme } from "@earendil-works/pi-tui";
import type { CardHue } from "../../../core/subagent/view.js";

/**
 * Structural subset of pi's `Theme` needed to build the full markdown theme.
 *
 * Duck-typed so this module never imports pi's `Theme` class directly; the
 * real `Theme` pi passes to extension renderers / `ui.custom` satisfies it.
 */
export interface MarkdownThemeSource {
  fg(color: string, text: string): string;
  bold(text: string): string;
  italic(text: string): string;
  underline(text: string): string;
  strikethrough(text: string): string;
}

/**
 * Build the full pi-tui `MarkdownTheme` from a pi `Theme`.
 *
 * Mirrors pi's own `getMarkdownTheme()` (pi repo
 * `modes/interactive/theme/theme.ts`): every markdown element carries its
 * `md*` theme color (headings, links, code, code blocks, quotes, hr, list
 * bullets) and inline emphasis resolves to the theme's bold / italic /
 * underline / strikethrough — so the card and transcript overlay render
 * markdown exactly like pi's native transcript.  Unlike the pi original, no
 * `highlightCode` is wired: the pi-tui `Markdown` component falls back to
 * `codeBlock` per line, which yields the consistent code-block color without
 * a `cli-highlight` dependency.
 *
 * @param theme - The pi `Theme` the host passed to the renderer / overlay.
 * @returns The full markdown theme.
 */
export function fullMarkdownTheme(theme: MarkdownThemeSource): MarkdownTheme {
  return {
    heading: (text) => theme.fg("mdHeading", text),
    link: (text) => theme.fg("mdLink", text),
    linkUrl: (text) => theme.fg("mdLinkUrl", text),
    code: (text) => theme.fg("mdCode", text),
    codeBlock: (text) => theme.fg("mdCodeBlock", text),
    codeBlockBorder: (text) => theme.fg("mdCodeBlockBorder", text),
    quote: (text) => theme.fg("mdQuote", text),
    quoteBorder: (text) => theme.fg("mdQuoteBorder", text),
    hr: (text) => theme.fg("mdHr", text),
    listBullet: (text) => theme.fg("mdListBullet", text),
    bold: (text) => theme.bold(text),
    italic: (text) => theme.italic(text),
    underline: (text) => theme.underline(text),
    strikethrough: (text) => theme.strikethrough(text),
  };
}

/**
 * Map a semantic card hue onto a pi theme foreground color name.
 *
 * @param hue - The semantic hue from the view model.
 * @returns The pi `ThemeColor` name for `theme.fg`.
 */
export function hueToPiColor(hue: CardHue): string {
  switch (hue) {
    case "running":
      return "warning";
    case "success":
      return "success";
    case "error":
      return "error";
    case "muted":
      return "dim";
    case "accent":
      return "accent";
  }
}
