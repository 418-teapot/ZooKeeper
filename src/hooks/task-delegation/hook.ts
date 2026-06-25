/**
 * Task delegation validation hook for ZooKeeper OpenCode plugin.
 *
 * Provides the hook-level adapter that reads the calling agent identity
 * from the session and validates the delegation target against the
 * allowlist defined in `src/core/delegation.ts`.
 *
 * @module
 */

import { type Clientish, getAgentName } from "../../core/agent.js";
import { isDelegationAllowed } from "../../core/delegation.js";
import { log } from "../../utils/logger.js";

// ---------------------------------------------------------------------------
// Handler — wired by the plugin entry point
// ---------------------------------------------------------------------------

/**
 * Validate that the calling agent is permitted to delegate to the target
 * subagent type. Throws a blocking error when the delegation is forbidden.
 *
 * Relies on `getAgentName` to resolve the calling agent from the session,
 * then consults the static allowlist in `isDelegationAllowed`.
 *
 * @param client - Framework client providing session lookup.
 * @param input - Hook input containing the tool name and session ID.
 * @param output - Hook output object with the tool call arguments.
 * @throws Error if the delegation target is not allowlisted for the caller.
 */
export async function validateDelegationTarget(
  client: Clientish | null | undefined,
  input: { tool: string; sessionID?: string; callID?: string },
  output: { args?: Record<string, unknown> },
): Promise<void> {
  if (input.tool !== "task") return;
  if (!input.sessionID) return;

  const agent = await getAgentName(client, input.sessionID);
  if (!agent) return;

  const subagentType = output.args?.subagent_type;
  if (typeof subagentType !== "string") return;

  const result = isDelegationAllowed(agent, subagentType);
  if (!result.allowed) {
    log("task-delegation", "blocked", input.sessionID, input.callID, "warn", {
      caller: agent,
      target: subagentType,
    });
    throw new Error(result.reason);
  }
}
