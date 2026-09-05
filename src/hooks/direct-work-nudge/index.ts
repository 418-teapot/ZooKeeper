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

import type { HookUnitDescriptor } from "../../core/slots.js";
import { nudgeDirectWork, nudgeDirectWorkForAgent } from "./hook";

export { nudgeDirectWork, nudgeDirectWorkForAgent };

/**
 * Direct-work-nudge hook unit descriptor.
 *
 * Contributes the after-exec nudge, gated on the session's resolved
 * agent (dolphin only) via `Deps.resolveAgent` (fail-closed: an
 * unresolved session is treated as "not dolphin").
 */
export const unit: HookUnitDescriptor = {
  name: "direct-work-nudge",
  kind: "hook",
  create(deps) {
    return {
      kind: "hook",
      beforeExec: [],
      afterExec: [
        {
          name: "nudgeDirectWork",
          handle: (input, output) =>
            nudgeDirectWorkForAgent(input, output, {
              todoClient: deps.client,
              planDir: deps.directory,
              agent: deps.resolveAgent(input.sessionID),
            }),
        },
      ],
      transform: [],
      textComplete: [],
      toolDefinition: [],
      delegation: [],
    };
  },
};
