/**
 * Task prompt validation hook barrel export.
 *
 * Re-exports all public API. Types and validation functions come from
 * `src/core/validate.ts` and `src/core/prompts.ts`; adapter/handler
 * functions come from the hook module.
 *
 * @module
 */

export { TASK_PROMPT_HINT } from "../../agents/parts.js";
export {
  type ValidationLimits,
  validateTaskPrompt,
} from "../../core/validate.js";
export {
  enhanceTaskDefinition,
  nudgeTaskOutput,
  validateBeforeExec,
} from "./hook";
