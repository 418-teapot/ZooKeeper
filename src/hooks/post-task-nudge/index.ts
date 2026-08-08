/**
 * Post-task nudge hook barrel export.
 *
 * Re-exports the handler function from the hook module and prompt constants
 * from `src/core/prompts.ts`.
 *
 * @module
 */

export {
  TODO_DONE_NUDGE,
  TODO_PROGRESS_NUDGE,
  TODO_RESUME_NUDGE,
  VERIFY_REMINDER,
} from "../../core/prompts.js";

import type { HookUnitDescriptor } from "../../core/slots.js";
import { nudgePostTask } from "./hook.js";

export { nudgePostTask };

/**
 * Post-task-nudge hook unit descriptor.
 *
 * Contributes the after-exec post-task verification and progress nudge.
 */
export const unit: HookUnitDescriptor = {
  name: "post-task-nudge",
  kind: "hook",
  create(deps) {
    return {
      kind: "hook",
      beforeExec: [],
      afterExec: [
        {
          name: "nudgePostTask",
          handle: (input, output) =>
            nudgePostTask(deps.client, input, output, deps.directory),
        },
      ],
      transform: [],
      toolDefinition: [],
    };
  },
};
