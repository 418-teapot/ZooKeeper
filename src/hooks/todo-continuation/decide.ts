/**
 * Todo-continuation strategy: judge a stopped turn against its todo list.
 *
 * This is the todo controller's control law. The engine has already
 * guaranteed the turn settled, its budget is not spent, and the
 * awaiting-progress lock is clear, so the strategy sees only the task
 * list. The list itself is the authority: unfinished active work wakes
 * the agent, and a genuine wait on the user is declared through the
 * `blocked` status — never guessed from the turn's prose. It inspects
 * the flattened task list and returns either a rendered reminder to
 * deliver or an explicit silence with the gate that suppressed it. The
 * function is total and side-effect free: the same inputs always produce
 * the same output, and no module state or host API is touched.
 *
 * @module
 */

import type { Decision } from "../../core/loop/index.js";
import type { TodoItemView } from "../../core/todo/types.js";
import { isActiveTodoStatus } from "../../core/todo/types.js";

/** Why the todo strategy withheld a continuation reminder. */
export type TodoSilenceReason = "empty" | "no-active";

/** The todo strategy's verdict for one stopped turn. */
export type TodoDecision = Decision<TodoSilenceReason>;

/**
 * Fixed directive prepended to every continuation reminder.
 *
 * The wording is deliberately adversarial: it anticipates the model
 * claiming the work is done and pushes it to re-verify rather than
 * silently accept the claim.
 */
export const CONTINUATION_PROMPT = `Incomplete tasks remain in your todo list. Continue working on the next pending task.
- Proceed without asking for permission
- Mark each task complete when finished
- Do not stop until all tasks are done
- If you believe all work is already complete, the system is questioning your completion claim. Critically re-examine each todo item from a skeptical perspective, verify the work was actually done correctly, and update the todo list accordingly.
- If you cannot advance without the user (an approval, a decision, an answer, or credentials), mark the affected tasks blocked with what you are waiting on and stop; declaring a block is not asking permission, and a task you are waiting on must never stay in_progress`;

function isRemaining(status: TodoItemView["status"]): boolean {
  return status !== "completed" && status !== "abandoned";
}

/** One remaining-task line, carrying the block reason when present. */
function renderRemainingTask(task: TodoItemView): string {
  const line = `- [${task.status}] ${task.content}`;
  return task.status === "blocked" && task.blocker !== undefined
    ? `${line} (waiting on: ${task.blocker})`
    : line;
}

/**
 * Render the continuation reminder for an unfinished todo list.
 *
 * The text is the fixed `CONTINUATION_PROMPT` followed by a compact status
 * summary and the list of tasks that are neither completed nor abandoned
 * (blocked tasks are still reported, since they remain unresolved; a
 * blocked task renders the reason it waits on).
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
    ...remaining.map(renderRemainingTask),
  ];
  return lines.join("\n");
}

/**
 * Decide whether to wake the agent to continue its unfinished todos.
 *
 * Gates short-circuit in a fixed order, each producing a distinct
 * silence reason:
 * 1. the todo list is empty (`"empty"`);
 * 2. no task is active — pending or in-progress (`"no-active"`); a list
 *    of only completed, abandoned, and/or blocked tasks does not warrant
 *    a wake, because a blocked task is the agent's own declaration that
 *    it waits on the user, not on more work.
 *
 * Otherwise the agent is woken with a rendered reminder. Whether the
 * settled turn did any work is not this strategy's concern: the list is
 * the single authority, and the engine's awaiting-progress lock already
 * handles turns that answer a wake with mere text.
 *
 * @param tasks - Flattened task views for the current todo list.
 * @returns The wake decision with its text, or silence with its reason.
 */
export function decide(tasks: readonly TodoItemView[]): TodoDecision {
  if (tasks.length === 0) {
    return { kind: "silence", reason: "empty" };
  }
  if (!tasks.some((task) => isActiveTodoStatus(task.status))) {
    return { kind: "silence", reason: "no-active" };
  }
  return { kind: "wake", text: renderContinuation(tasks) };
}
