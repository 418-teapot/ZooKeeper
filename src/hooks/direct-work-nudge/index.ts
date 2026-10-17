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

import { resolveTodoSource } from "../../core/client/todo.js";
import { defineHook, makeHookContributions } from "../../core/unit.js";
import { nudgeDirectWork, nudgeDirectWorkForAgent } from "./hook";

export { nudgeDirectWork, nudgeDirectWorkForAgent };

/**
 * Direct-work-nudge hook unit descriptor.
 *
 * Contributes the after-exec nudge, gated on the session's resolved
 * agent (dolphin only) via `Capabilities.resolveAgent` (fail-closed: an
 * unresolved session is treated as "not dolphin").
 *
 * The todo source is resolved once per composition via
 * `resolveTodoSource` (state store, then capable host client, else no
 * todo contribution).
 */
export const unit = defineHook({
  name: "direct-work-nudge",
  needs: ["client", "directory", "resolveAgent"],
  wants: ["todoStore"],
  create(caps) {
    const source = resolveTodoSource(caps);
    return makeHookContributions({
      afterExec: [
        {
          name: "nudgeDirectWork",
          handle: (input, output) =>
            nudgeDirectWorkForAgent(input, output, {
              todoSource: source,
              planDir: caps.directory,
              agent: caps.resolveAgent(input.sessionID),
            }),
        },
      ],
    });
  },
});
