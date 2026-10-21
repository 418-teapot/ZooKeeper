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

import { defineHook } from "../../core/unit.js";
import { nudgeDirectWork, nudgeDirectWorkForAgent } from "./hook";

export { nudgeDirectWork, nudgeDirectWorkForAgent };

/**
 * Direct-work-nudge hook unit descriptor.
 *
 * Contributes the after-exec nudge, gated on the session's resolved
 * agent (dolphin only) via `Capabilities.resolveAgent` (fail-closed: an
 * unresolved session is treated as "not dolphin").
 *
 * The unit consumes the assembly-bound `todoSource` port directly.  The
 * port is a `wants` capability: the nudge itself never depends on todo
 * state, so a host that binds no source still gets the nudge, just
 * without the todo reminder (the read degrades to "no todo context").
 */
export const unit = defineHook({
  name: "direct-work-nudge",
  needs: ["directory", "resolveAgent"],
  wants: ["todoSource"],
  create(caps) {
    return {
      afterExec: [
        {
          name: "nudgeDirectWork",
          handle: (input, output) =>
            nudgeDirectWorkForAgent(input, output, {
              todoSource: caps.todoSource,
              planDir: caps.directory,
              agent: caps.resolveAgent(input.sessionID),
            }),
        },
      ],
    };
  },
});
