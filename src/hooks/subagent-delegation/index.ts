/**
 * Subagent delegation judge hook barrel export.
 *
 * Re-exports the judge function from the hook module.
 *
 * @module
 */

import { defineHook, makeHookContributions } from "../../core/unit.js";
import { judgeDelegationTarget } from "./hook.js";

export { judgeDelegationTarget };

/**
 * Subagent-delegation hook unit descriptor.
 *
 * Contributes the delegation-target judge; all handler slots stay
 * empty.  The judge is composed into the host gate by the selection
 * engine and runs only for `subagent` tool calls at the gate
 * boundary.
 */
export const unit = defineHook({
  name: "subagent-delegation",
  needs: [],
  create() {
    return makeHookContributions({
      delegation: [
        {
          name: "judgeDelegationTarget",
          needsCaller: true,
          judge: judgeDelegationTarget,
        },
      ],
    });
  },
});
