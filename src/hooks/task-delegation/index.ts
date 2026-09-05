/**
 * Task delegation judge hook barrel export.
 *
 * Re-exports the judge function from the hook module.
 *
 * @module
 */

import type { HookUnitDescriptor } from "../../core/slots.js";
import { judgeDelegationTarget } from "./hook.js";

export { judgeDelegationTarget };

/**
 * Task-delegation hook unit descriptor.
 *
 * Contributes the delegation-target judge; all handler slots stay
 * empty.  The judge is composed into the host gate by the selection
 * engine and runs only for `subagent` tool calls at the gate
 * boundary.
 */
export const unit: HookUnitDescriptor = {
  name: "task-delegation",
  kind: "hook",
  create() {
    return {
      kind: "hook",
      beforeExec: [],
      afterExec: [],
      transform: [],
      textComplete: [],
      toolDefinition: [],
      delegation: [
        {
          name: "judgeDelegationTarget",
          needsCaller: true,
          judge: judgeDelegationTarget,
        },
      ],
    };
  },
};
