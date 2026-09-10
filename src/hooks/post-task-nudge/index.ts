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

import { resolveTodoSource } from "../../core/client/todo.js";
import type { HookUnitDescriptor } from "../../core/slots.js";
import { nudgePostTask } from "./hook.js";

export { nudgePostTask };

/**
 * Post-task-nudge hook unit descriptor.
 *
 * Contributes the after-exec post-task verification and progress nudge.
 * The todo source is resolved once per composition via
 * `resolveTodoSource` (state store, then capable host client, else no
 * todo contribution).
 */
export const unit: HookUnitDescriptor = {
  name: "post-task-nudge",
  kind: "hook",
  create(deps) {
    const source = resolveTodoSource(deps);
    return {
      kind: "hook",
      beforeExec: [],
      afterExec: [
        {
          name: "nudgePostTask",
          handle: (input, output) =>
            nudgePostTask(source, input, output, deps.directory),
        },
      ],
      transform: [],
      textComplete: [],
      toolDefinition: [],
      delegation: [],
    };
  },
};
