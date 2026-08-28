/**
 * Semantic-hue → pi theme color mapping for the subagent transcript card.
 *
 * The card view model (`src/core/subagent/view.ts`) emits lines tagged with
 * semantic hues (`running` / `success` / `error` / `muted` / `accent`).
 * This module is the SINGLE place that translates those hues into pi theme
 * color names for `theme.fg(...)`.  Everything pi-specific about coloring
 * lives here; core never knows pi's color vocabulary.
 *
 * @module
 */

import type { CardHue } from "../../../core/subagent/view.js";

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
