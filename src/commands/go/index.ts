/**
 * `/go` command unit barrel export.
 *
 * Declares the command unit descriptor and re-exports the `/go`
 * command handler from the handler module.
 *
 * @module
 */

import type { CommandUnitDescriptor } from "../../core/slots.js";
import { notifySessionError } from "../notify.js";
import { handleGoCommand } from "./hook.js";

export type { PlanClient } from "./hook.js";
export { handleGoCommand };

/**
 * `/go` command unit descriptor.
 *
 * The command contribution wraps `handleGoCommand`, retaining the
 * try/catch + `notifySessionError` flow; the handler returns normally —
 * the handled short-route sentinel is thrown by a later adapter layer.
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
          description: "Approve plan and handoff to dolphin",
          handle: async (input) => {
            try {
              await handleGoCommand(
                deps.client,
                input.sessionID,
                deps.directory,
              );
            } catch (err) {
              await notifySessionError(
                deps.client,
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
