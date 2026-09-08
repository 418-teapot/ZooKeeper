/**
 * Single normalization point for the todo state machine.
 *
 * Guarantees the one-in-progress invariant on every state that exits the
 * apply pipeline:
 * - more than one `in_progress` task: only the first one in list order stays
 *   active, the rest fall back to `pending`;
 * - no `in_progress` task: the earliest `pending` task in list order is
 *   promoted;
 * - `blocked` tasks are never auto-promoted — `unblock` is the only way back.
 *
 * Mutates the given phases in place and returns the same array. It is
 * invoked after every state change (`applyEntries`) and after history
 * restoration (`restoreFromHistory`), so every state observable from the
 * machine is normalized.
 *
 * @module
 */

import type { TodoPhase } from "./types.js";

/**
 * Enforce the single-in-progress invariant on a todo list in place.
 *
 * @param phases - Todo phases to normalize.
 * @returns The same `phases` array, mutated in place.
 */
export function normalizePhases(phases: TodoPhase[]): TodoPhase[] {
  const orderedTasks = phases.flatMap((phase) => phase.tasks);
  const inProgress = orderedTasks.filter(
    (task) => task.status === "in_progress",
  );

  for (const extra of inProgress.slice(1)) {
    extra.status = "pending";
  }

  if (inProgress.length === 0) {
    const firstPending = orderedTasks.find((task) => task.status === "pending");
    if (firstPending) firstPending.status = "in_progress";
  }

  return phases;
}
