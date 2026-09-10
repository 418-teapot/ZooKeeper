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
import type { TodoSource } from "./client/todo.js";
import { allTodosDone, countOpenTodos, findPlanByStatus } from "./plan.js";
import {
  PLAN_DONE_NUDGE,
  PLAN_PROGRESS_NUDGE,
  PLAN_RESUME_NUDGE,
  TODO_DONE_NUDGE,
  TODO_PROGRESS_NUDGE,
  TODO_RESUME_NUDGE,
} from "./prompts.js";
import { decideTodoNudge } from "./todo/nudge.js";

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
 * The todo entries are read through the injected `TodoSource` port: which
 * backend serves the read (state store or host client) is decided by the
 * caller at composition time, so this function never inspects a client.
 *
 * The reminder tier comes from `decideTodoNudge` and maps onto the prompt
 * constants: `"progress"` -> TODO_PROGRESS_NUDGE, `"done"` -> TODO_DONE_NUDGE,
 * `"resume"` -> TODO_RESUME_NUDGE.
 *
 * The function returns `null` — no reminder — when the decision is `null`
 * (an empty list makes every reminder premise false) and when the source
 * read fails: with nothing verifiable about the list, staying silent beats
 * asserting an unverified claim.
 *
 * @param source - Port that reads the session's todo entries as a flat view.
 * @param sessionID - The current session identifier (for logging).
 * @returns A nudge string, or `null` if no nudge is needed.
 */
export async function checkTodoProgress(
  source: TodoSource,
  sessionID: string,
): Promise<string | null> {
  try {
    const tier = decideTodoNudge(await source(sessionID));

    switch (tier) {
      case "resume":
        return TODO_RESUME_NUDGE;
      case "done":
        return TODO_DONE_NUDGE;
      case "progress":
        return TODO_PROGRESS_NUDGE;
      default:
        return null;
    }
  } catch (err) {
    log("checks", "todo_check_failed", sessionID, undefined, "warn", {
      error: String(err),
    });
    return null;
  }
}
