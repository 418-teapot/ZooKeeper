/**
 * Context pruning hook barrel export.
 *
 * Exports the OpenCode framework adapter.  Config schema types are at
 * `src/core/config-types.ts`; pure logic (types, state, prune) is at
 * `src/core/context/pruning/`; the shared session maps and their
 * cleanup live in `src/core/session-state.ts`.
 *
 * @module
 */

import type { HookUnitDescriptor } from "../../core/slots.js";
import {
  contextPruningTransformHandler,
  handleContextPruning,
  handleDedupNotify,
  resolveSessionAgent,
  resolveSubAgentStatus,
} from "./hook.js";

export {
  contextPruningTransformHandler,
  handleContextPruning,
  handleDedupNotify,
  resolveSessionAgent,
  resolveSubAgentStatus,
};

/**
 * Context-pruning hook unit descriptor.
 *
 * Contributes the messages-transform pruning handler.  The sub-agent
 * status is resolved per session (cached) before the sweep pipeline
 * runs; `hasCompressTool` is derived from the active set's tool
 * enablement so the nudge / manual-compress phases only advertise
 * windows the registered `compress` tool would accept.
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
            const isSubAgent = await resolveSubAgentStatus(output, deps.client);
            handleContextPruning(
              output,
              deps.contextConfig,
              deps.client,
              isSubAgent,
              activeSet.tools.has("compress"),
            );
          },
        },
      ],
      toolDefinition: [],
    };
  },
};
