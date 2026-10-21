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

import { defineHook } from "../../core/unit.js";
import { nudgePostSubagent } from "./hook.js";

export { nudgePostSubagent };

/**
 * Post-subagent-nudge hook unit descriptor.
 *
 * Contributes the after-exec post-subagent verification and progress nudge.
 * The unit consumes the assembly-bound `todoSource` port directly.  The
 * port is a `wants` capability: the verification and progress nudges never
 * depend on todo state, so a host that binds no source still gets them,
 * just without the todo reminder.
 */
export const unit = defineHook({
  name: "post-subagent-nudge",
  needs: ["directory"],
  wants: ["todoSource"],
  create(caps) {
    return {
      afterExec: [
        {
          name: "nudgePostSubagent",
          handle: (input, output) =>
            nudgePostSubagent(
              caps.todoSource ?? null,
              input,
              output,
              caps.directory,
            ),
        },
      ],
    };
  },
});
