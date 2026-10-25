/**
 * Context pruning hook barrel export.
 *
 * Exports the host-agnostic handler functions.  Config schema types are at
 * `src/core/config-types.ts`; the host-agnostic pipeline core lives in
 * `src/core/context/` (state, producers, fold, release, nudge) and is
 * driven through the host adapter injected via `Capabilities.adapter`;
 * the shared
 * session maps and their cleanup live in `src/core/context/runtime.ts`.
 *
 * @module
 */

import {
  contextPruningTransformHandler,
  handleContextPruning,
} from "../../core/context/pipeline.js";
import { defineHook } from "../../core/unit.js";

export { contextPruningTransformHandler, handleContextPruning };

/**
 * Context-pruning hook unit descriptor.
 *
 * Contributes the messages-transform pruning handler; the unit declares
 * `adapter` and `contextConfig` as needs, so composition skips it when
 * the host wires no adapter.  The unit is otherwise enabled
 * unconditionally: the whole pipeline runs on every host and session
 * kind (anchor protection covers the first-user message via
 * `anchorTokens`; the release notification routes through
 * `caps.toolHost` and is skipped when the host wires no tool host or
 * the session agent cannot be resolved).  `hasCompressTool` is read from
 * the `uses` projection of the selected tools, so the nudge /
 * manual-compress phases only advertise windows a selected `compress`
 * tool would accept — whether or not that tool is registered yet.
 *
 * Fail-closed: a host without an adapter never activates the unit,
 * matching how a null mode profile disables every unit.
 */
export const unit = defineHook({
  name: "context-pruning",
  needs: ["adapter", "contextConfig"],
  wants: ["toolHost"],
  uses: ["tools"],
  create(caps, uses) {
    const adapter = caps.adapter;
    return {
      transform: [
        {
          name: "contextPruning",
          handle: async (output) => {
            handleContextPruning(
              output,
              caps.contextConfig,
              caps.toolHost,
              uses.tools.includes("compress"),
              adapter,
            );
          },
        },
      ],
    };
  },
});
