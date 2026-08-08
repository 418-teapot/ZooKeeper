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

import type { HookUnitDescriptor } from "../../core/slots.js";
import {
  enhanceTaskDefinition,
  nudgeTaskOutput,
  validateBeforeExec,
} from "./hook";

export { enhanceTaskDefinition, nudgeTaskOutput, validateBeforeExec };

/**
 * Task-prompt hook unit descriptor.
 *
 * Contributes the before-exec validation, the after-exec output nudge,
 * and the `task` tool definition enhancement.
 */
export const unit: HookUnitDescriptor = {
  name: "task-prompt",
  kind: "hook",
  create(deps) {
    return {
      kind: "hook",
      beforeExec: [
        {
          name: "validateBeforeExec",
          handle: (input, output) =>
            validateBeforeExec(input, output, deps.limits),
        },
      ],
      afterExec: [
        {
          name: "nudgeTaskOutput",
          handle: (input, output) =>
            nudgeTaskOutput(input, output, deps.limits),
        },
      ],
      transform: [],
      toolDefinition: [
        {
          name: "enhanceTaskDefinition",
          handle: enhanceTaskDefinition,
        },
      ],
    };
  },
};
