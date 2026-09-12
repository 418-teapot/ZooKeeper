/**
 * Subagent prompt validation hook barrel export.
 *
 * Re-exports all public API. Types and validation functions come from
 * `src/core/validate.ts` and `src/core/prompts.ts`; judge/handler
 * functions come from the hook module.
 *
 * @module
 */

export { SUBAGENT_PROMPT_HINT } from "../../agents/parts.js";
export {
  type ValidationLimits,
  validateSubagentPrompt,
} from "../../core/validate.js";

import type { HookUnitDescriptor } from "../../core/slots.js";
import {
  enhanceSubagentDefinition,
  judgeSubagentPrompt,
  nudgeSubagentOutput,
} from "./hook";

export { enhanceSubagentDefinition, judgeSubagentPrompt, nudgeSubagentOutput };

/**
 * Subagent-prompt hook unit descriptor.
 *
 * Contributes the prompt-format judge (composed into the host gate),
 * the after-exec output nudge, and the `subagent` tool definition
 * enhancement.
 */
export const unit: HookUnitDescriptor = {
  name: "subagent-prompt",
  kind: "hook",
  create(deps) {
    return {
      kind: "hook",
      beforeExec: [],
      afterExec: [
        {
          name: "nudgeSubagentOutput",
          handle: (input, output) =>
            nudgeSubagentOutput(input, output, deps.limits),
        },
      ],
      transform: [],
      textComplete: [],
      toolDefinition: [
        {
          name: "enhanceSubagentDefinition",
          handle: enhanceSubagentDefinition,
        },
      ],
      delegation: [
        {
          name: "judgeSubagentPrompt",
          judge: (req) => judgeSubagentPrompt(req, deps.limits),
        },
      ],
    };
  },
};
