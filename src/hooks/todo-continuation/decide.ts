/**
 * Todo-continuation strategy: judge a stopped turn against its todo list.
 *
 * This is the todo controller's control law.  The engine has already
 * guaranteed the turn settled and the budget is not spent, so the
 * strategy sees only the session and the observed progress fact.  It
 * inspects the flattened task list and returns either a rendered reminder
 * to deliver or an explicit silence with the gate that suppressed it.
 * The function is total and side-effect free: the same inputs always
 * produce the same output, and no module state or host API is touched.
 *
 * @module
 */

import type { Decision } from "../../core/loop/index.js";
import type { TodoItemView } from "../../core/todo/types.js";
import { isActiveTodoStatus } from "../../core/todo/types.js";

/** Why the todo strategy withheld a continuation reminder. */
export type TodoSilenceReason = "empty" | "no-active" | "no-progress";

/** The todo strategy's verdict for one stopped turn. */
export type TodoDecision = Decision<TodoSilenceReason>;

/**
 * Fixed directive prepended to every continuation reminder.
 *
 * The wording is deliberately adversarial: it anticipates the model
 * claiming the work is done and pushes it to re-verify rather than
 * silently accept the claim.
 */
export const CONTINUATION_PROMPT =
  "Incomplete tasks remain in your todo list. " +
  "Continue working on the next pending task.\n" +
  "- Proceed without asking for permission\n" +
  "- Mark each task complete when finished\n" +
  "- Do not stop until all tasks are done\n" +
  "- If you believe all work is already complete, the system is " +
  "questioning your completion claim. Critically re-examine each todo " +
  "item from a skeptical perspective, verify the work was actually done " +
  "correctly, and update the todo list accordingly.";

function isRemaining(status: TodoItemView["status"]): boolean {
  return status !== "completed" && status !== "abandoned";
}

/**
 * Render the continuation reminder for an unfinished todo list.
 *
 * The text is the fixed `CONTINUATION_PROMPT` followed by a compact status
 * summary and the list of tasks that are neither completed nor abandoned
 * (blocked tasks are still reported, since they remain unresolved).
 *
 * @param tasks - The task views to summarize.
 * @returns The reminder text.
 */
function renderContinuation(tasks: readonly TodoItemView[]): string {
  const completed = tasks.filter((task) => task.status === "completed").length;
  const remaining = tasks.filter((task) => isRemaining(task.status));

  const lines = [
    CONTINUATION_PROMPT,
    "",
    `[Status: ${completed}/${tasks.length} completed, ` +
      `${remaining.length} remaining]`,
    "Remaining tasks:",
    ...remaining.map((task) => `- [${task.status}] ${task.content}`),
  ];
  return lines.join("\n");
}

/**
 * Decide whether to wake the agent to continue its unfinished todos.
 *
 * Gates short-circuit in a fixed order, each producing a distinct silence
 * reason:
 * 1. the todo list is empty (`"empty"`);
 * 2. no task is active — pending or in-progress (`"no-active"`); a list of
 *    only completed, abandoned, and/or blocked tasks does not warrant a
 *    wake;
 * 3. the settled turn made no mutating progress (`"no-progress"`); a turn
 *    that only read, discussed, updated its todo list, or delegated to a
 *    read-only agent has not advanced the work and may be handing the turn
 *    back.
 *
 * Otherwise the agent is woken with a rendered reminder.
 *
 * @param tasks - Flattened task views for the current todo list.
 * @param progress - Whether the settled turn performed mutating work.
 * @returns The wake decision with its text, or silence with its reason.
 */
export function decide(
  tasks: readonly TodoItemView[],
  progress: boolean,
): TodoDecision {
  if (tasks.length === 0) {
    return { kind: "silence", reason: "empty" };
  }
  if (!tasks.some((task) => isActiveTodoStatus(task.status))) {
    return { kind: "silence", reason: "no-active" };
  }
  if (!progress) {
    return { kind: "silence", reason: "no-progress" };
  }
  return { kind: "wake", text: renderContinuation(tasks) };
}
