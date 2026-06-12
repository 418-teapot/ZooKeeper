/**
 * Shared todo-update nudge prompt constants for the post-task-nudge hook.
 *
 * These are the only prompt constants shared across multiple use sites
 * (both within the post-task-nudge hook).  Hook-local prompt constants
 * live with their respective hook files.
 *
 * @module
 */

/**
 * Nudge text injected when there are multiple in-progress or pending
 * items, reminding the orchestrator to update the todo list.
 */
export const TODO_GENERAL =
  "**TODO UPDATE REQUIRED — DO THIS NOW**\n" +
  "\n" +
  "A subagent just completed work. Before proceeding, mark finished items as\n" +
  "`completed` and set the next item to `in_progress`.\n" +
  "UNMARKED = UNTRACKED = LOST PROGRESS.";

/**
 * Nudge text injected when exactly 1 task remains `in_progress` and
 * 0 tasks are `pending`, reminding the orchestrator to close it out.
 */
export const TODO_FINAL_ACTIVE =
  "**TODO UPDATE REQUIRED — LAST TASK STILL in_progress**\n" +
  "\n" +
  "1 task remains `in_progress`, 0 `pending`. A subagent just finished work.\n" +
  "Mark it `completed` now, or move unfinished items back to `pending`.\n" +
  "STALE STATUS = INVISIBLE WORK = FORGOTTEN WORK.";
