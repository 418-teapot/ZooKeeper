/**
 * Auto-debug hook unit — evidence-driven autonomous debugging loop.
 *
 * When a turn settles while an investigation Case is open in the
 * session's workspace, the orchestrator should be woken to keep
 * debugging.  This unit is the auto-debug strategy: it binds the
 * injected `zdebug` runner and filesystem ports (falling back to the
 * default subprocess and `node:fs` wrappers), delegates the whole
 * judgment to {@link decide}, and contributes the resulting verdict on
 * the `onSettled` slot.  The engine has already filtered non-settled
 * turns and enforced the budget.
 *
 * The unit owns its own budget: it reads the parsed `[zoo.autodebug]`
 * config through `deps` and declares the debug-wake allowance as its
 * contribution's `maxWakes`.  With no valid config it contributes NO
 * settle handler at all (fail-closed at the contribution level), so the
 * engine never consults it — this is not a silent wake, it is the whole
 * feature being off.
 *
 * The unit is enabled purely by the profile hooks list (fail-closed when
 * absent).  On disk, "Case existence is the only activation": the
 * strategy only reacts to a Case a user created, never inferring one from
 * conversation.
 *
 * @module
 */

import type { HookUnitDescriptor } from "../../core/slots.js";
import { decide } from "./decide.js";
import { defaultAutoDebugFs } from "./workspace-fs.js";
import { defaultZdebugExec } from "./zdebug-exec.js";

/** An empty hook contribution set (no slot contributed). */
function emptyContributions() {
  return {
    kind: "hook" as const,
    beforeExec: [],
    afterExec: [],
    transform: [],
    textComplete: [],
    toolDefinition: [],
    delegation: [],
    onSettled: [],
  };
}

/**
 * Auto-debug hook unit descriptor.
 *
 * Binds the `zdebug` runner and filesystem ports once and contributes one
 * `onSettled` handler that discovers the workspace Case, re-runs its
 * verification experiment, and returns the strategy's verdict.  All other
 * slots stay empty.  Without a valid `[zoo.autodebug]` the `onSettled`
 * slot stays empty too.
 */
export const unit: HookUnitDescriptor = {
  name: "auto-debug",
  kind: "hook",
  create(deps) {
    const config = deps.autoDebugConfig;
    if (config === undefined) {
      return emptyContributions();
    }
    const ports = {
      zdebugExec: deps.zdebugExec ?? defaultZdebugExec,
      fs: deps.autoDebugFs ?? defaultAutoDebugFs,
    };
    return {
      kind: "hook",
      beforeExec: [],
      afterExec: [],
      transform: [],
      textComplete: [],
      toolDefinition: [],
      delegation: [],
      onSettled: [
        {
          name: "autoDebug",
          maxWakes: config.maxWakes,
          handle: (input) =>
            decide(ports, {
              workspace: deps.directory,
              sessionID: input.sessionID,
            }),
        },
      ],
    };
  },
};
