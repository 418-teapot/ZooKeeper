/**
 * Post-subagent nudge hook barrel export.
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
import { defineHook, makeHookContributions } from "../../core/unit.js";
import { nudgePostSubagent } from "./hook.js";

export { nudgePostSubagent };

/**
 * Post-subagent-nudge hook unit descriptor.
 *
 * Contributes the after-exec post-subagent verification and progress nudge.
 * The todo source is resolved once per composition via
 * `resolveTodoSource` (state store, then capable host client, else no
 * todo contribution).
 */
export const unit = defineHook({
  name: "post-subagent-nudge",
  needs: ["client", "directory"],
  wants: ["todoStore"],
  create(caps) {
    const source = resolveTodoSource(caps);
    return makeHookContributions({
      afterExec: [
        {
          name: "nudgePostSubagent",
          handle: (input, output) =>
            nudgePostSubagent(source, input, output, caps.directory),
        },
      ],
    });
  },
});
