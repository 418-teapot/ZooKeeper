/**
 * Direct Work Nudge hook for ZooKeeper OpenCode plugin.
 *
 * After every edit/write tool call by the build orchestrator agent, appends
 * a protocol reminder telling the orchestrator to delegate work via `task()`
 * instead of doing it directly.
 *
 * @module
 */

import { type Clientish, isBuildAgent } from "../shared/agent.js";
import { debug } from "../shared/logger.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Full nudge text appended to edit/write tool output.
 *
 * Reminds the orchestrator that direct editing violates protocol and should
 * be delegated via `task()`.
 */
export const DIRECT_WORK_NUDGE = `**DELEGATION REQUIRED** — You just edited a source file directly.

Did you ACTUALLY need to be the one doing that?

- Documentation, design docs, research reports, prompts → **fine, this is your job.** Continue.
- Tiny verification fix during subagent review → fine, continue.
- Anything else → **you violated orchestrator protocol.**
  Revert the change and delegate it via \`task()\`.

**Build does not implement. Build orchestrates.**`;

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * Append a protocol nudge to edit/write tool output, but only for the build
 * orchestrator agent.
 *
 * Fires on edit/write tool calls originating from the "build" agent.
 * Subagent calls (explore/general/scout/spider) are silently skipped.
 * Non-null output gets the nudge appended.  Non-matching tools are skipped.
 *
 * When no client is available (e.g. in tests) the nudge is skipped —
 * `isBuildAgent` returns `false` for null/undefined clients.
 *
 * @param client - OpenCode client (captured via closure), or null/undefined.
 * @param input - Input containing the tool name and session ID.
 * @param input.tool - Name of the tool that was executed.
 * @param input.sessionID - Session ID for agent lookup.
 * @param output - Output object mutated in place.
 * @param output.output - Text output from the tool call.
 */
export async function nudgeDirectWork(
  client: Clientish | null | undefined,
  input: { tool: string; sessionID: string },
  output: { output?: string },
): Promise<void> {
  const tool = input.tool.toLowerCase();
  if (tool !== "edit" && tool !== "write") return;
  if (output.output == null) return;

  // Only fire for the build orchestrator agent.
  // isBuildAgent returns false when client is null/undefined, skipping
  // the nudge conservatively.
  if (!(await isBuildAgent(client, input.sessionID))) return;

  output.output += `\n\n${DIRECT_WORK_NUDGE}`;

  debug("direct-work-nudge", { tool: input.tool });
}
