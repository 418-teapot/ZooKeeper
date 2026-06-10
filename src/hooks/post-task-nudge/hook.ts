/**
 * Post-task nudge hook for ZooKeeper OpenCode plugin.
 *
 * After every `task()` tool execution, appends a verification reminder and,
 * based on the session's todo list state, a todo-update nudge to the
 * tool output. This guides the orchestrator LLM to verify subagent work
 * and keep the todo list in sync.
 *
 * @module
 */

import {
  getTodoState,
  TODO_FINAL_ACTIVE,
  TODO_GENERAL,
  VERIFY_REMINDER,
} from "../shared/todo-nudge.js";

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * Nudge the orchestrator after a task() call.
 *
 * Always appends `VERIFY_REMINDER`. Then fetches the session's todo list
 * and decides which todo nudge (if any) to append:
 *
 * - All items completed / cancelled → VERIFY only (no todo nudge).
 * - 1 item `in_progress`, 0 `pending` → TODO_FINAL_ACTIVE.
 * - Any other active state          → TODO_GENERAL.
 * - API failure when fetching todos → TODO_GENERAL (fallback).
 *
 * @param client - OpenCode client captured via closure in the plugin factory.
 * @param input - Hook input containing the tool name and session ID.
 * @param input.tool - Name of the tool that was executed.
 * @param input.sessionID - Session identifier for todo lookup.
 * @param output - Hook output object mutated in place.
 * @param output.output - Text output from the tool call.
 */
export async function nudgePostTask(
  client:
    | {
        session: {
          todo: (opts: { path: { id: string } }) => Promise<{
            data: Array<{
              content: string;
              status: string;
              priority: string;
              id: string;
            }>;
          }>;
        };
      }
    | null
    | undefined,
  input: { tool: string; sessionID: string },
  output: { output?: string },
): Promise<void> {
  // Skip non-task tools
  if (input.tool.toLowerCase() !== "task") return;

  // Skip null / undefined output
  if (output.output == null) return;

  // Skip if no client available — OpenCode runtime may not provide one
  if (!client) return;

  // Always inject VERIFY_REMINDER for task tools
  let suffix = `\n\n${VERIFY_REMINDER}`;

  try {
    const state = await getTodoState(client, input.sessionID);

    // Determine if any items are still active (in_progress or pending)
    const activeStatuses = new Set(["in_progress", "pending"]);
    const activeCount = state.todos.filter((t) =>
      activeStatuses.has(t.status),
    ).length;

    if (activeCount === 0) {
      // All completed / cancelled — VERIFY only
      output.output += suffix;
      return;
    }

    // Pick the appropriate todo nudge
    if (state.inProgressCount === 1 && state.pendingCount === 0) {
      suffix += `\n\n${TODO_FINAL_ACTIVE}`;
    } else {
      suffix += `\n\n${TODO_GENERAL}`;
    }
  } catch {
    // API failure: fallback to VERIFY + TODO_GENERAL
    suffix += `\n\n${TODO_GENERAL}`;
  }

  output.output += suffix;
}
