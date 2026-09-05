/**
 * Task prompt validation hook barrel export.
 *
 * Re-exports all public API. Types and validation functions come from
 * `src/core/validate.ts` and `src/core/prompts.ts`; judge/handler
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
  judgeTaskPrompt,
  nudgeTaskOutput,
} from "./hook";

export { enhanceTaskDefinition, judgeTaskPrompt, nudgeTaskOutput };

/**
 * Task-prompt hook unit descriptor.
 *
 * Contributes the prompt-format judge (composed into the host gate),
 * the after-exec output nudge, and the `task` tool definition
 * enhancement.
 */
export const unit: HookUnitDescriptor = {
  name: "task-prompt",
  kind: "hook",
  create(deps) {
    return {
      kind: "hook",
      beforeExec: [],
      afterExec: [
        {
          name: "nudgeTaskOutput",
          handle: (input, output) =>
            nudgeTaskOutput(input, output, deps.limits),
        },
      ],
      transform: [],
      textComplete: [],
      toolDefinition: [
        {
          name: "enhanceTaskDefinition",
          handle: enhanceTaskDefinition,
        },
      ],
      delegation: [
        {
          name: "judgeTaskPrompt",
          judge: (req) => judgeTaskPrompt(req, deps.limits),
        },
      ],
    };
  },
};
