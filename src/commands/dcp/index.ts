/**
 * `/dcp` command unit barrel export.
 *
 * Declares the command unit descriptor around the handler logic in
 * `./command.ts`; failure notification comes from `../notify.ts`.
 *
 * @module
 */

import type { CommandUnitDescriptor } from "../../core/slots.js";
import { notifySessionError } from "../notify.js";
import { handleDcpCommand } from "./command.js";

/**
 * `/dcp` command unit descriptor.
 *
 * The command contribution wraps `handleDcpCommand`; failures are
 * surfaced via `notifySessionError` and the handler returns normally —
 * the handled short-route sentinel is thrown by a later adapter layer.
 */
export const unit: CommandUnitDescriptor = {
  name: "dcp",
  kind: "command",
  create(deps, activeSet) {
    return {
      kind: "command",
      commands: [
        {
          name: "dcp",
          description: "显示上下文用量与缓存命中率",
          handle: async (input) => {
            try {
              await handleDcpCommand(
                deps.toolHost,
                input.sessionID,
                input.arguments,
                deps.contextConfig,
                activeSet.tools.has("compress"),
              );
            } catch (err) {
              await notifySessionError(
                deps.toolHost,
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
};
