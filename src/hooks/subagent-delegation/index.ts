/**
 * Subagent delegation judge hook barrel export.
 *
 * Re-exports the judge function from the hook module.
 *
 * @module
 */

import {
  type HookUnitDescriptor,
  makeHookContributions,
} from "../../core/slots.js";
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
export const unit: HookUnitDescriptor = {
  name: "subagent-delegation",
  kind: "hook",
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
};
