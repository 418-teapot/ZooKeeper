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

import {
  JSON_ERROR_PATTERNS,
  JSON_ERROR_TOOL_EXCLUDE_LIST,
  JSON_ERROR_TOOL_EXCLUDES,
  recoverJsonError,
} from "../../core/recovery.js";
import type { HookUnitDescriptor } from "../../core/slots.js";

export {
  JSON_ERROR_PATTERNS,
  JSON_ERROR_TOOL_EXCLUDE_LIST,
  JSON_ERROR_TOOL_EXCLUDES,
  recoverJsonError,
};

/**
 * Json-error-nudge hook unit descriptor.
 *
 * Contributes the after-exec JSON parse error recovery nudge.
 */
export const unit: HookUnitDescriptor = {
  name: "json-error-nudge",
  kind: "hook",
  create() {
    return {
      kind: "hook",
      beforeExec: [],
      afterExec: [
        {
          name: "recoverJsonError",
          handle: (input, output) => recoverJsonError(input, output),
        },
      ],
      transform: [],
      textComplete: [],
      toolDefinition: [],
      delegation: [],
    };
  },
};
