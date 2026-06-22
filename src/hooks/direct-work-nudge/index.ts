/**
 * Direct Work Nudge barrel export.
 *
 * Re-exports the handler function from the hook module and prompt constants
 * from `src/core/prompts.ts`.
 *
 * @module
 */
export {
  DIRECT_WORK_NUDGE,
  SEARCH_DELEGATE_NUDGE,
} from "../../core/prompts.js";
export { nudgeDirectWork } from "./hook";
