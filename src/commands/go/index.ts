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
import { defineCommand } from "../../core/unit.js";
import { notifySessionError } from "../notify.js";

/**
 * `/go` command unit descriptor.
 *
 * The command contribution wraps `executeHandoff` with the host-specific
 * `handoffTarget` from `Capabilities` and the executor agent the
 * selection resolved (`uses: ["orchestrator"]`); when no handoff target
 * is wired the command fails closed with the missing-client error.
 * A selection that resolved no orchestrator role is not a `/go` host —
 * the unit then contributes zero commands, because the handoff would
 * have no executor identity to create the new session under.
 *
 * Failures are surfaced via `notifySessionError` through the host tool
 * host (on OpenCode the v1 tool host posts the identical ignored noReply
 * message — zero behavior change; on pi the unified tool host posts a
 * `zoo-notice` appendEntry entry, making failures visible).  The handler
 * returns normally — the handled short-route sentinel is thrown by a
 * later adapter layer.
 */
export const unit = defineCommand({
  name: "go",
  needs: ["handoffTarget", "directory"],
  wants: ["toolHost"],
  uses: ["orchestrator"],
  create(caps, uses) {
    const agent = uses.orchestrator;
    if (agent === undefined) {
      // No resolved role — fail closed with zero commands.
      return { kind: "command", commands: [] };
    }
    return {
      kind: "command",
      commands: [
        {
          name: "go",
          description: "Approve plan and handoff to execution",
          handle: async (input) => {
            try {
              await executeHandoff({
                handoffTarget: caps.handoffTarget,
                agent,
                sessionID: input.sessionID,
                directory: caps.directory,
              });
            } catch (err) {
              await notifySessionError(
                caps.toolHost,
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
});
