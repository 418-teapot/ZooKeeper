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
 * boundary.  The unit requires the host's asynchronous caller resolver:
 * without it the judge could never identify the caller and would have
 * to refuse every delegation, so the assembly-time capability check
 * disables the unit instead.
 */
export const unit = defineHook({
  name: "subagent-delegation",
  needs: ["resolveCallerAgent"],
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
