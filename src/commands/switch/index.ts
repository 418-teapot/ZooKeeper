/**
 * Primary-switch command unit barrel export.
 *
 * Declares the command unit descriptor and re-exports the switch
 * (`applySwitch`) used by the `/<agent>` commands.
 *
 * The unit contributes one `/<agent-name>` command per configured
 * primary agent (derived from the profile's agents array + the agent
 * modes map via `derivePrimaries` — command names are config-derived,
 * never hardcoded).  The commands register ONLY when the pi switch
 * surfaces are present in `Capabilities` (`switchHost`): OpenCode never
 * provides them, so no switch command registers there (fail-closed).
 * An empty primary set contributes zero commands.
 *
 * @module
 */

import { derivePrimaries } from "../../core/subagent/identity.js";
import { defineCommand } from "../../core/unit.js";
import { notifySessionError } from "../notify.js";
import { applySwitch } from "./switch.js";

export type { SwitchHost } from "../../core/ports/switch.js";
export { applySwitch };

/**
 * Primary-switch command unit descriptor.
 *
 * The unit declares `switchHost` as a need, so composition skips it on
 * hosts without the capability (OpenCode) — zero commands are
 * contributed.  With it, one command per derived
 * primary is contributed; each handler applies the shared switch for its
 * target agent and surfaces failures (missing replacement API, cancelled
 * replacement) through `notifySessionError`.
 */
export const unit = defineCommand({
  name: "switch",
  needs: ["switchHost"],
  wants: ["agentModes", "agentPermissions", "toolHost"],
  create(caps, activeSet) {
    const host = caps.switchHost;
    const primaries = derivePrimaries(
      [...activeSet.agents],
      caps.agentModes ?? {},
    );
    if (primaries.length === 0) {
      // No configured primary — fail closed with zero commands.
      return { kind: "command", commands: [] };
    }

    const permissions = caps.agentPermissions ?? {};
    return {
      kind: "command",
      commands: primaries.map((name) => ({
        name,
        description: `切换主 agent 到 ${name}`,
        handle: async (input) => {
          try {
            await applySwitch(
              name,
              permissions[name] ?? [],
              host,
              input.sessionID,
            );
          } catch (err) {
            await notifySessionError(
              caps.toolHost,
              input.sessionID,
              err,
              "switch-command",
              "switch_command_failed",
            );
          }
        },
      })),
    };
  },
});
