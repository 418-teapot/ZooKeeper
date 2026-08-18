/**
 * Context pruning hook barrel export.
 *
 * Exports the OpenCode framework adapter.  Config schema types are at
 * `src/core/config-types.ts`; the host-agnostic pipeline core lives in
 * `src/core/context/` (state, producers, fold, release, nudge) and is
 * driven through the OpenCode adapter (`src/adapters/opencode/`); the
 * shared session maps and their cleanup live in
 * `src/core/context/runtime.ts`.
 *
 * @module
 */

import type { HookUnitDescriptor } from "../../core/slots.js";
import {
  contextPruningTransformHandler,
  handleContextPruning,
  handleDedupNotify,
  resolveSessionAgent,
} from "./hook.js";

export {
  contextPruningTransformHandler,
  handleContextPruning,
  handleDedupNotify,
  resolveSessionAgent,
};

/**
 * Context-pruning hook unit descriptor.
 *
 * Contributes the messages-transform pruning handler.  The unit is
 * unconditionally enabled: the whole pipeline runs on every host and
 * session kind (anchor protection covers the first-user message via
 * `anchorTokens`; session introspection is optional — the dedup-release
 * notification suppresses itself when the agent cannot be resolved).
 * `hasCompressTool` is derived from the active set's tool enablement so
 * the nudge / manual-compress phases only advertise windows the
 * registered `compress` tool would accept.
 */
export const unit: HookUnitDescriptor = {
  name: "context-pruning",
  kind: "hook",
  create(deps, activeSet) {
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
              deps.client,
              activeSet.tools.has("compress"),
            );
          },
        },
      ],
      toolDefinition: [],
    };
  },
};
