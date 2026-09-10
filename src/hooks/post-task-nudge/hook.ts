/**
 * Post-task nudge hook for ZooKeeper plugin.
 *
 * After every `task()` tool execution, appends a verification reminder and
 * delegates todo and plan progress nudges to `checkTodoProgress` and
 * `checkPlanProgress` from `src/core/checks.ts`.
 *
 * @module
 */

import { checkPlanProgress, checkTodoProgress } from "../../core/checks.js";
import type { TodoSource } from "../../core/client/todo.js";
import { VERIFY_REMINDER } from "../../core/prompts.js";
import { log } from "../../utils/logger.js";

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * Nudge the orchestrator after a task() call.
 *
 * Injects `VERIFY_REMINDER`, then delegates to `checkTodoProgress` and
 * `checkPlanProgress` for additional nudges. Both check functions handle
 * their own error logging; this function only assembles the output.
 *
 * The todo entries are read through `source`; which backend serves that
 * read is decided by the caller once at composition time. When `source`
 * is `null` the todo nudge contribution is skipped, while the verification
 * reminder and the plan nudge still run — neither depends on todo state.
 *
 * @param source - Port reading the session's todo entries, or `null` to
 *   skip the todo nudge.
 * @param input - Hook input containing the tool name and session ID.
 * @param input.tool - Name of the tool that was executed.
 * @param input.sessionID - Session identifier for todo/plan lookup.
 * @param output - Hook output object mutated in place.
 * @param output.output - Text output from the tool call.
 * @param planDir - Workspace base directory containing `.zoo/plans/`.
 */
export async function nudgePostTask(
  source: TodoSource | null,
  input: { tool: string; sessionID: string; callID?: string },
  output: { output?: string },
  planDir: string,
): Promise<void> {
  // Skip non-delegation tools
  if (input.tool.toLowerCase() !== "subagent") return;

  // Skip null / undefined output
  if (output.output == null) return;

  // Build nudge pipeline
  let suffix = `\n\n${VERIFY_REMINDER}`;

  // Todo progress check (async — read through the injected source)
  const todoNudge = source
    ? await checkTodoProgress(source, input.sessionID)
    : null;
  if (todoNudge) suffix += `\n\n${todoNudge}`;

  // Plan progress check (sync — filesystem read)
  const planNudge = checkPlanProgress(input.sessionID, planDir);
  if (planNudge) suffix += `\n\n${planNudge}`;

  output.output += suffix;

  log(
    "post-task-nudge",
    "nudge_injected",
    input.sessionID,
    input.callID,
    "info",
    {
      has_todo: !!todoNudge,
      has_plan: !!planNudge,
    },
  );
}
