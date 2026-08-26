/**
 * `/go` command unit barrel export.
 *
 * Declares the command unit descriptor around the handoff protocol
 * (`executeHandoff` in `src/core/handoff.ts`); failure notification
 * comes from `../notify.ts`.
 *
 * @module
 */

import { executeHandoff } from "../../core/handoff.js";
import type { CommandUnitDescriptor } from "../../core/slots.js";
import { notifySessionError } from "../notify.js";

/**
 * `/go` command unit descriptor.
 *
 * The command contribution wraps `executeHandoff` with the host-specific
 * `venue` from `Deps`; when no venue is wired the command fails closed
 * with the missing-client error.  Failures are surfaced via
 * `notifySessionError` through the host tool host (on OpenCode the v1
 * tool host posts the identical ignored noReply message — zero behavior
 * change; on pi it routes through the command tool host's appendEntry,
 * making failures visible).  The handler returns normally — the handled
 * short-route sentinel is thrown by a later adapter layer.
 */
export const unit: CommandUnitDescriptor = {
  name: "go",
  kind: "command",
  create(deps) {
    return {
      kind: "command",
      commands: [
        {
          name: "go",
          description: "Approve plan and handoff to execution",
          handle: async (input) => {
            try {
              const venue = deps.venue;
              if (!venue) {
                throw new Error(
                  "Session creation API is not available. " +
                    "Ensure the ZooKeeper plugin is properly loaded.",
                );
              }
              await executeHandoff({
                venue,
                sessionID: input.sessionID,
                directory: deps.directory,
              });
            } catch (err) {
              await notifySessionError(
                deps.toolHost,
                input.sessionID,
                err,
                "go-command",
                "go_command_failed",
              );
            }
          },
        },
      ],
    };
  },
};
