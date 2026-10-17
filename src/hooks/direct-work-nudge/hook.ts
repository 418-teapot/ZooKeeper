/**
 * Direct Work Nudge hook for ZooKeeper OpenCode plugin.
 *
 * After every edit/write tool call, appends a reminder to recheck the
 * delivery boundary and verification evidence. Also injects todo progress
 * and plan progress nudges for edit/write tools.
 * The prompt constants live in `src/core/prompts.ts`.
 *
 * `nudgeDirectWork` is agent-agnostic — it fires for any agent.  The
 * agent-gated wrapper `nudgeDirectWorkForAgent` (used by the plugin entry
 * point) applies the dolphin-only filter before delegating.
 *
 * @module
 */

import { checkPlanProgress, checkTodoProgress } from "../../core/checks.js";
import type { TodoSource } from "../../core/client/todo.js";
import { applyNudge, type NudgeGuard } from "../../core/nudge.js";
import { ORCHESTRATOR_AGENT_NAME } from "../../core/orchestrator.js";
import {
  DIRECT_WORK_NUDGE,
  SEARCH_DELEGATE_NUDGE,
} from "../../core/prompts.js";
import { log } from "../../utils/logger.js";

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * Append a delivery-boundary nudge to edit/write tool output.
 *
 * Fires on edit/write/grep/glob tool calls regardless of agent identity.
 * Agent gating is the caller's responsibility — the hook unit resolves
 * the session's agent through `Capabilities.resolveAgent` before calling this
 * function.
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
 * @param options.todoSource - Port reading the session's todo entries, or `null` when no todo list is readable.
 * @param options.planDir - Workspace base directory for plan discovery.
 */
export async function nudgeDirectWork(
  input: { tool: string; sessionID: string; callID?: string },
  output: { output?: string },
  options?: { todoSource?: TodoSource | null; planDir?: string },
): Promise<void> {
  const tool = input.tool.toLowerCase();
  const isDirectEdit = tool === "edit" || tool === "write";
  const isSearch = tool === "grep" || tool === "glob";

  // Both variants share this guard: a tool call with no text has nothing
  // to append to.
  const hasOutput: NudgeGuard = () =>
    output.output == null
      ? {
          event: "nudge_skipped",
          fields: { tool: input.tool, reason: "no_output" },
        }
      : null;

  // Facts exposed to the injected log; filled by the edit text provider.
  let hasTodo = false;
  let hasPlan = false;

  await applyNudge({
    hook: "direct-work-nudge",
    sessionID: input.sessionID,
    callID: input.callID,
    tool: input.tool,
    output,
    rules: [
      {
        matches: () => isDirectEdit,
        guards: [hasOutput],
        text: async () => {
          // Which backend serves the todo read is decided by the caller at
          // composition time; a caller without a readable list passes
          // `null` (or omits the option) and this nudge is simply skipped.
          const todoNudge = options?.todoSource
            ? await checkTodoProgress(options.todoSource, input.sessionID)
            : null;
          const planNudge = checkPlanProgress(
            input.sessionID,
            options?.planDir ?? "",
          );
          hasTodo = todoNudge != null;
          hasPlan = planNudge != null;
          return [DIRECT_WORK_NUDGE, todoNudge, planNudge]
            .filter((part): part is string => part != null)
            .join("\n\n");
        },
        event: "nudge_injected",
        fields: () => ({
          tool: input.tool,
          nudge_type: "edit",
          has_todo: hasTodo,
          has_plan: hasPlan,
        }),
      },
      {
        matches: () => isSearch,
        guards: [hasOutput],
        text: () => SEARCH_DELEGATE_NUDGE,
        event: "nudge_injected",
        fields: () => ({ tool: input.tool, nudge_type: "search" }),
      },
    ],
  });
}

/**
 * Agent-gated wrapper around `nudgeDirectWork` (dolphin only).
 *
 * The hook unit resolves the session's agent via `Capabilities.resolveAgent`
 * and passes it here.  When the agent is not the orchestrator
 * (`ORCHESTRATOR_AGENT_NAME`; including unknown), the nudge is skipped and
 * one debug entry (`nudge_skipped` / `not_dolphin`) is logged — mirroring
 * the historical entry-point guard.  Other agents keep receiving no protocol
 * reminder: sub-agents must not be told to delegate.
 *
 * @param input - Input containing the tool name, session ID, and optional call ID.
 * @param output - Output object mutated in place.
 * @param options - Optional configuration.
 * @param options.todoSource - Port reading the session's todo entries, or `null` when no todo list is readable.
 * @param options.planDir - Workspace base directory for plan discovery.
 * @param options.agent - The session's resolved agent name (`undefined` when unknown).
 */
export async function nudgeDirectWorkForAgent(
  input: { tool: string; sessionID: string; callID?: string },
  output: { output?: string },
  options: {
    todoSource?: TodoSource | null;
    planDir?: string;
    agent?: string;
  },
): Promise<void> {
  if (options.agent !== ORCHESTRATOR_AGENT_NAME) {
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
    todoSource: options.todoSource,
    planDir: options.planDir,
  });
}
