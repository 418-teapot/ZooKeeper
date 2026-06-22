/**
 * JSON error recovery barrel export.
 *
 * All logic lives in `src/core/recovery.ts`.
 * Prompt constants live in `src/core/prompts.ts`.
 *
 * @module
 */
export {
  JSON_ERROR_REMINDER,
  JSON_ERROR_REMINDER_MARKER,
} from "../../core/prompts.js";
export {
  JSON_ERROR_PATTERNS,
  JSON_ERROR_TOOL_EXCLUDE_LIST,
  JSON_ERROR_TOOL_EXCLUDES,
  recoverJsonError,
} from "../../core/recovery.js";
