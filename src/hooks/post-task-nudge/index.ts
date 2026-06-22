/**
 * Post-task nudge hook barrel export.
 *
 * Re-exports the handler function from the hook module and prompt constants
 * from `src/core/prompts.ts`.
 *
 * @module
 */

export {
  TODO_FINAL_ACTIVE,
  TODO_GENERAL,
  VERIFY_REMINDER,
} from "../../core/prompts.js";
export { nudgePostTask } from "./hook.js";
