/**
 * Context pruning hook barrel export.
 *
 * Exports the host-agnostic handler functions.  Config schema types are at
 * `src/core/config-types.ts`; the host-agnostic pipeline core lives in
 * `src/core/context/` (state, producers, fold, release, nudge) and is
 * driven through the host adapter injected via `Deps.adapter`; the shared
 * session maps and their cleanup live in `src/core/context/runtime.ts`.
 *
 * @module
 */

import type { HookUnitDescriptor } from "../../core/slots.js";
import {
  contextPruningTransformHandler,
  handleContextPruning,
} from "./hook.js";

export { contextPruningTransformHandler, handleContextPruning };

/**
 * Context-pruning hook unit descriptor.
 *
 * Contributes the messages-transform pruning handler when `deps.adapter`
 * is wired.  The unit is otherwise enabled unconditionally: the whole
 * pipeline runs on every host and session kind (anchor protection covers
 * the first-user message via `anchorTokens`; the release notification
 * routes through `deps.toolHost` and is skipped when the host wires no
 * tool host or the session agent cannot be resolved).  `hasCompressTool`
 * is derived from the active set's tool enablement so the nudge /
 * manual-compress phases only advertise windows the registered `compress`
 * tool would accept.
 *
 * Fail-closed: when `deps.adapter` is undefined the unit contributes no
 * transform handler, consistent with the null-profile philosophy.
 */
export const unit: HookUnitDescriptor = {
  name: "context-pruning",
  kind: "hook",
  create(deps, activeSet) {
    const adapter = deps.adapter;
    if (!adapter) {
      return {
        kind: "hook",
        beforeExec: [],
        afterExec: [],
        transform: [],
        textComplete: [],
        toolDefinition: [],
        delegation: [],
      };
    }
    return {
      kind: "hook",
      beforeExec: [],
      afterExec: [],
      transform: [
        {
          name: "contextPruning",
          handle: async (output) => {
            handleContextPruning(
              output,
              deps.contextConfig,
              deps.toolHost,
              activeSet.tools.has("compress"),
              adapter,
            );
          },
        },
      ],
      textComplete: [],
      toolDefinition: [],
      delegation: [],
    };
  },
};
