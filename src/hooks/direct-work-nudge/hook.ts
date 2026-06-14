/**
 * Direct Work Nudge hook for ZooKeeper OpenCode plugin.
 *
 * After every edit/write tool call by the build orchestrator agent, appends
 * a protocol reminder telling the orchestrator to delegate work via `task()`
 * instead of doing it directly.
 *
 * @module
 */

import { log } from "../../utils/logger.js";
import { type Clientish, isBuildAgent } from "../utils/agent.js";

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

/**
 * Nudge text appended to grep/glob tool output for the build agent.
 *
 * Distinguishes between codebase discovery (delegate to the explore agent)
 * and simple verification (fine to proceed).
 */
export const SEARCH_DELEGATE_NUDGE = `**POTENTIAL DELEGATION OPPORTUNITY** — You just searched the codebase.

- **Codebase discovery** (finding files, searching across multiple files, exploring structure) → delegate to the \`explore\` agent via \`task()\`.
- **Verification** (confirming a change in a specific file, checking if a pattern exists in a known file) → fine, continue.`;

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * Append a protocol nudge to edit/write tool output, but only for the build
 * orchestrator agent.
 *
 * Fires on edit/write tool calls originating from the "build" agent.
 * Subagent calls (explore/general/spider) are silently skipped.
 * Non-null output gets the nudge appended.  Non-matching tools are skipped.
 *
 * When no client is available (e.g. in tests) the nudge is skipped —
 * `isBuildAgent` returns `false` for null/undefined clients.
 *
 * @param client - OpenCode client (captured via closure), or null/undefined.
 * @param input - Input containing the tool name, session ID, and optional call ID.
 * @param input.tool - Name of the tool that was executed.
 * @param input.sessionID - Session ID for agent lookup.
 * @param input.callID - Optional call identifier for logging.
 * @param output - Output object mutated in place.
 * @param output.output - Text output from the tool call.
 */
export async function nudgeDirectWork(
  client: Clientish | null | undefined,
  input: { tool: string; sessionID: string; callID?: string },
  output: { output?: string },
): Promise<void> {
  const tool = input.tool.toLowerCase();
  const isDirectEdit = tool === "edit" || tool === "write";
  const isSearch = tool === "grep" || tool === "glob";
  if (!isDirectEdit && !isSearch) return;
  if (output.output == null) {
    log(
      "direct-work-nudge",
      "nudge_skipped",
      input.sessionID,
      input.callID,
      "debug",
      {
        tool: input.tool,
        reason: "no_output",
      },
    );
    return;
  }

  // Only fire for the build orchestrator agent.
  // isBuildAgent returns false when client is null/undefined, skipping
  // the nudge conservatively.
  if (!(await isBuildAgent(client, input.sessionID))) {
    log(
      "direct-work-nudge",
      "nudge_skipped",
      input.sessionID,
      input.callID,
      "debug",
      {
        tool: input.tool,
        reason: "not_build",
      },
    );
    return;
  }

  if (isDirectEdit) {
    output.output += `\n\n${DIRECT_WORK_NUDGE}`;
    log(
      "direct-work-nudge",
      "nudge_injected",
      input.sessionID,
      input.callID,
      "info",
      {
        tool: input.tool,
        nudge_type: "edit",
      },
    );
  } else {
    output.output += `\n\n${SEARCH_DELEGATE_NUDGE}`;
    log(
      "direct-work-nudge",
      "nudge_injected",
      input.sessionID,
      input.callID,
      "info",
      {
        tool: input.tool,
        nudge_type: "search",
      },
    );
  }
}
