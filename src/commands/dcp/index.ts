/**
 * `/dcp` command unit barrel export.
 *
 * Declares the command unit descriptor around the handler logic in
 * `./command.ts`; failure notification comes from `../notify.ts`.
 *
 * @module
 */

import { defineCommand } from "../../core/unit.js";
import { notifySessionError } from "../notify.js";
import { handleDcpCommand } from "./command.js";

/**
 * `/dcp` command unit descriptor.
 *
 * The command contribution wraps `handleDcpCommand`; failures are
 * surfaced via `notifySessionError` and the handler returns normally —
 * the handled short-route sentinel is thrown by a later adapter layer.
 */
export const unit = defineCommand({
  name: "dcp",
  needs: ["contextConfig"],
  wants: ["toolHost"],
  create(caps, activeSet) {
    return {
      kind: "command",
      commands: [
        {
          name: "dcp",
          description: "显示上下文用量与缓存命中率",
          handle: async (input) => {
            try {
              await handleDcpCommand(
                caps.toolHost,
                input.sessionID,
                input.arguments,
                caps.contextConfig,
                activeSet.tools.has("compress"),
              );
            } catch (err) {
              await notifySessionError(
                caps.toolHost,
                input.sessionID,
                err,
                "context-command",
                "dcp_command_failed",
              );
            }
          },
        },
      ],
    };
  },
});
