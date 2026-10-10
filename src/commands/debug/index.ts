/**
 * `/debug` command unit barrel export.
 *
 * Declares the command unit descriptor around the handler logic in
 * `./command.ts`; failure notification comes from `../notify.ts`.
 *
 * The unit binds the injected `zdebug` runner and filesystem ports once
 * (falling back to the default subprocess and `node:fs` wrappers, the
 * same precedence the auto-debug strategy uses) and contributes a single
 * `/debug` command.  The command
 * is the only user entry that creates a Case — no flag parsing, the raw
 * arguments become the Case objective (`docs/autodebug-design.md` §6.4,
 * §8.1) — and on success injects a model-visible startup message through
 * the host's `messageInjector` so the agent starts investigating in
 * place.
 *
 * @module
 */

import type { CommandUnitDescriptor } from "../../core/slots.js";
import { defaultAutoDebugFs } from "../../hooks/auto-debug/workspace-fs.js";
import { defaultZdebugExec } from "../../hooks/auto-debug/zdebug-exec.js";
import { notifySessionError } from "../notify.js";
import { handleDebugCommand } from "./command.js";

/**
 * `/debug` command unit descriptor.
 *
 * The command contribution wraps `handleDebugCommand` with the bound
 * `zdebug` runner, the read-only filesystem, and the session workspace;
 * failures are surfaced via `notifySessionError` and the handler returns
 * normally — the handled short-route sentinel is thrown by a later
 * adapter layer.
 */
export const unit: CommandUnitDescriptor = {
  name: "debug",
  kind: "command",
  create(deps) {
    const zdebugExec = deps.zdebugExec ?? defaultZdebugExec;
    const fs = deps.autoDebugFs ?? defaultAutoDebugFs;
    return {
      kind: "command",
      commands: [
        {
          name: "debug",
          description: "创建调试 Case 并立即启动调查",
          handle: async (input) => {
            try {
              await handleDebugCommand(
                deps.toolHost,
                input.sessionID,
                input.arguments,
                {
                  zdebugExec,
                  fs,
                  directory: deps.directory,
                  messageInjector: deps.messageInjector,
                },
              );
            } catch (err) {
              await notifySessionError(
                deps.toolHost,
                input.sessionID,
                err,
                "debug-command",
                "debug_command_failed",
              );
            }
          },
        },
      ],
    };
  },
};
