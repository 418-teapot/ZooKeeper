/**
 * Direct Work Nudge hook for ZooKeeper OpenCode plugin.
 *
 * After every edit/write tool call, appends a protocol reminder telling the
 * orchestrator to delegate work via `task()` instead of doing it directly.
 * Also injects todo progress and plan progress nudges for edit/write tools.
 * The prompt constants live in `src/core/prompts.ts`.
 *
 * `nudgeDirectWork` is agent-agnostic — it fires for any agent.  The
 * agent-gated wrapper `nudgeDirectWorkForAgent` (used by the plugin entry
 * point) applies the dolphin-only filter before delegating.
 *
 * @module
 */

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
 * Append a protocol nudge to edit/write tool output.
 *
 * Fires on edit/write/grep/glob tool calls regardless of agent identity.
 * Agent gating is the caller's responsibility — the plugin entry point
 * checks the `sessionAgentMap` (populated by `message.updated` events) before
 * calling this function.
 *
 * Non-null output gets the nudge appended. Non-matching tools are skipped.
 *
 * @param input - Input containing the tool name, session ID, and optional call ID.
 * @param input.tool - Name of the tool that was executed.
 * @param input.sessionID - Session ID for plan/todo lookup.
 * @param input.callID - Optional call identifier for logging.
 * @param output - Output object mutated in place.
 * @param output.output - Text output from the tool call.
 * @param options - Optional configuration.
 * @param options.todoClient - Client for todo progress check (OpenCode SDK client at runtime).
 * @param options.planDir - Workspace base directory for plan discovery.
 */
export async function nudgeDirectWork(
  input: { tool: string; sessionID: string; callID?: string },
  output: { output?: string },
  options?: { todoClient?: TinyClient | null; planDir?: string },
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

  if (isDirectEdit) {
    output.output += `\n\n${DIRECT_WORK_NUDGE}`;

    const todoNudge = await checkTodoProgress(
      options?.todoClient ?? null,
      input.sessionID,
    );
    if (todoNudge) output.output += `\n\n${todoNudge}`;

    const planNudge = checkPlanProgress(
      input.sessionID,
      options?.planDir ?? "",
    );
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

/**
 * Agent-gated wrapper around `nudgeDirectWork` (dolphin only).
 *
 * The plugin entry point resolves the session's agent from its
 * `sessionAgentMap` (populated by `message.updated` events) and passes it
 * here.  When the agent is not `"dolphin"` (including unknown), the nudge
 * is skipped and one debug entry (`nudge_skipped` / `not_dolphin`) is
 * logged — mirroring the historical entry-point guard.  Other agents keep
 * receiving no protocol reminder: sub-agents must not be told to delegate.
 *
 * @param input - Input containing the tool name, session ID, and optional call ID.
 * @param output - Output object mutated in place.
 * @param options - Optional configuration.
 * @param options.todoClient - Client for todo progress check (OpenCode SDK client at runtime).
 * @param options.planDir - Workspace base directory for plan discovery.
 * @param options.agent - The session's resolved agent name (`undefined` when unknown).
 */
export async function nudgeDirectWorkForAgent(
  input: { tool: string; sessionID: string; callID?: string },
  output: { output?: string },
  options: {
    todoClient?: TinyClient | null;
    planDir?: string;
    agent?: string;
  },
): Promise<void> {
  if (options.agent !== "dolphin") {
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
  return nudgeDirectWork(input, output, {
    todoClient: options.todoClient,
    planDir: options.planDir,
  });
}
