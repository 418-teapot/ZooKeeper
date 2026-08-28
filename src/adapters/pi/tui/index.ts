/**
 * Pi TUI rendering adapter — semantic → pi component translation.
 *
 * Contains the only pi-facing translation of the subagent transcript card:
 * `theme.ts` maps semantic hues to pi theme color names, and `card.ts`
 * turns view-model lines into pi TUI components (`Container` / `Text` from
 * `@earendil-works/pi-tui`).  Core (`src/core/subagent/view.ts`) stays
 * host-free.
 *
 * @module
 */

export type { Component } from "@earendil-works/pi-tui";
export {
  buildSubagentCardRenderer,
  type PiThemeLike,
} from "./card.js";
export { hueToPiColor } from "./theme.js";
