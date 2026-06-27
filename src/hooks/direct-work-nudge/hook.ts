/**
 * Direct Work Nudge hook for ZooKeeper OpenCode plugin.
 *
 * After every edit/write tool call by the dolphin orchestrator agent, appends
 * a protocol reminder telling the orchestrator to delegate work via `task()`
 * instead of doing it directly. Also injects todo progress and plan progress
 * nudges for edit/write tools. The prompt constants live in
 * `src/core/prompts.ts`.
 *
 * @module
 */

import { type Clientish, isDolphinAgent } from "../../core/agent.js";
import { checkPlanProgress, checkTodoProgress } from "../../core/checks.js";
import {
  DIRECT_WORK_NUDGE,
  SEARCH_DELEGATE_NUDGE,
} from "../../core/prompts.js";
import type { TinyClient } from "../../core/todo.js";
import { log } from "../../utils/logger.js";

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * Append a protocol nudge to edit/write tool output, but only for the build
 * orchestrator agent.
 *
 * Fires on edit/write tool calls originating from the "dolphin" agent.
 * Subagent calls (lynx/beaver/spider) are silently skipped.
 * Non-null output gets the nudge appended.  Non-matching tools are skipped.
 *
 * Also injects todo progress and plan progress nudges for edit/write tools
 * to remind the orchestrator about remaining tasks and plan status.
 *
 * When no client is available (e.g. in tests) the nudge is skipped —
 * `isDolphinAgent` returns `false` for null/undefined clients.
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

  // Only fire for the dolphin orchestrator agent.
  // isDolphinAgent returns false when client is null/undefined, skipping
  // the nudge conservatively.
  if (!(await isDolphinAgent(client, input.sessionID))) {
    log(
      "direct-work-nudge",
      "nudge_skipped",
      input.sessionID,
      input.callID,
      "debug",
      {
        tool: input.tool,
        reason: "not_dolphin",
      },
    );
    return;
  }

  if (isDirectEdit) {
    output.output += `\n\n${DIRECT_WORK_NUDGE}`;

    // Todo and plan progress nudges — same pipeline as post-task-nudge.
    // The OpenCode client implements both Clientish (agent lookup) and
    // TinyClient (todo API) at runtime; cast is intentional. Failures are
    // caught inside checkTodoProgress with a TODO_PROGRESS_NUDGE fallback.
    const todoNudge = await checkTodoProgress(
      client as TinyClient | null | undefined,
      input.sessionID,
    );
    if (todoNudge) output.output += `\n\n${todoNudge}`;

    const planNudge = checkPlanProgress(input.sessionID);
    if (planNudge) output.output += `\n\n${planNudge}`;

    log(
      "direct-work-nudge",
      "nudge_injected",
      input.sessionID,
      input.callID,
      "info",
      {
        tool: input.tool,
        nudge_type: "edit",
        has_todo: todoNudge != null,
        has_plan: planNudge != null,
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
