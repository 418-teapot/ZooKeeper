/**
 * Pure check functions for plan progress and todo progress nudges.
 *
 * These functions extract the nudge decision logic from the direct-work-nudge
 * and post-task-nudge hooks into reusable, testable units. Each returns a
 * nudge string or `null` when no nudge is needed.
 *
 * @module
 */

import { log } from "../utils/logger.js";
import { allTodosDone, countOpenTodos, findPlanByStatus } from "./plan.js";
import {
  PLAN_DONE_NUDGE,
  PLAN_PROGRESS_NUDGE,
  PLAN_RESUME_NUDGE,
  TODO_DONE_NUDGE,
  TODO_PROGRESS_NUDGE,
  TODO_RESUME_NUDGE,
} from "./prompts.js";
import { getTodoState, type TinyClient } from "./todo.js";

// ---------------------------------------------------------------------------
// Plan progress check
// ---------------------------------------------------------------------------

/**
 * Check plan progress and return a nudge string if the orchestrator needs
 * a reminder about plan state.
 *
 * Logic:
 * 1. Look for an executing plan. If found with open TODOs, return a progress
 *    nudge showing completed/total counts.
 * 2. If the executing plan has all TODOs done, return a "plan done" nudge.
 * 3. If no executing plan, look for a done plan and return a "resume" nudge.
 * 4. If nothing is found, return `null`.
 *
 * Plans are discovered flat under `<planDir>/.zoo/plans/` by mtime-desc
 * order (newest file matching the target status wins).
 *
 * All filesystem errors are caught and logged at `"warn"` level. The function
 * never throws — it returns `null` on any failure.
 *
 * @param sessionID - The current session identifier (for logging).
 * @param planDir - Workspace base directory containing `.zoo/plans/`.
 * @returns A nudge string, or `null` if no nudge is needed.
 */
export function checkPlanProgress(
  sessionID: string,
  planDir: string,
): string | null {
  try {
    const executingPlan = findPlanByStatus(planDir, "executing");

    if (executingPlan) {
      const openTodos = countOpenTodos(executingPlan.content);

      if (openTodos > 0) {
        const doneMatch = executingPlan.content.match(/^- \[[xX]\]/gm);
        const done = doneMatch ? doneMatch.length : 0;
        const total = done + openTodos;

        return PLAN_PROGRESS_NUDGE.replace("{slug}", executingPlan.slug)
          .replace("{path}", executingPlan.path)
          .replace("{done}", String(done))
          .replace("{total}", String(total));
      }

      if (allTodosDone(executingPlan.content)) {
        return PLAN_DONE_NUDGE.replace("{slug}", executingPlan.slug).replace(
          "{path}",
          executingPlan.path,
        );
      }
    }

    const donePlan = findPlanByStatus(planDir, "done");

    if (donePlan) {
      return PLAN_RESUME_NUDGE.replace("{slug}", donePlan.slug).replace(
        "{path}",
        donePlan.path,
      );
    }

    return null;
  } catch (err) {
    log("checks", "plan_check_failed", sessionID, undefined, "warn", {
      error: String(err),
    });
    return null;
  }
}

// ---------------------------------------------------------------------------
// Todo progress check
// ---------------------------------------------------------------------------

/**
 * Check todo list progress and return a nudge string if the orchestrator
 * needs a reminder about todo state.
 *
 * Logic:
 * 1. If no client is available, return `null` (skip silently).
 * 2. Fetch the todo list via the client API.
 * 3. If zero items are active (in_progress or pending), return the done nudge.
 * 4. If exactly 1 item is in_progress and 0 are pending, return the final
 *    active nudge.
 * 5. Otherwise, return the general todo nudge.
 * 6. On API failure, log a warning and return the general nudge as fallback.
 *
 * @param client - OpenCode client (captured via closure), or null/undefined.
 * @param sessionID - The current session identifier.
 * @returns A nudge string, or `null` if no nudge is needed.
 */
export async function checkTodoProgress(
  client: TinyClient | null | undefined,
  sessionID: string,
): Promise<string | null> {
  if (!client) return null;

  try {
    const state = await getTodoState(client, sessionID);

    const activeStatuses = new Set(["in_progress", "pending"]);
    const activeCount = state.todos.filter((t) =>
      activeStatuses.has(t.status),
    ).length;

    if (activeCount === 0) {
      return TODO_RESUME_NUDGE;
    }

    if (state.inProgressCount === 1 && state.pendingCount === 0) {
      return TODO_DONE_NUDGE;
    }

    return TODO_PROGRESS_NUDGE;
  } catch (err) {
    log("checks", "todo_check_failed", sessionID, undefined, "warn", {
      error: String(err),
    });
    return TODO_PROGRESS_NUDGE;
  }
}
