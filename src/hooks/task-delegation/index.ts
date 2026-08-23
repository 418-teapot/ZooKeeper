/**
 * Task delegation validation hook barrel export.
 *
 * Re-exports the handler function from the hook module.
 *
 * @module
 */

import type { HookUnitDescriptor } from "../../core/slots.js";
import { validateDelegationTarget } from "./hook.js";

export { validateDelegationTarget };

/**
 * Task-delegation hook unit descriptor.
 *
 * Contributes the before-exec delegation target validation.
 */
export const unit: HookUnitDescriptor = {
  name: "task-delegation",
  kind: "hook",
  create(deps) {
    return {
      kind: "hook",
      beforeExec: [
        {
          name: "validateDelegationTarget",
          handle: (input, output) =>
            validateDelegationTarget(deps.client, input, output),
        },
      ],
      afterExec: [],
      transform: [],
      textComplete: [],
      toolDefinition: [],
    };
  },
};
