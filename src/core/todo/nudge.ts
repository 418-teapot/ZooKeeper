/**
 * Todo progress nudge decision — a pure function over task views.
 *
 * Given a flattened list of todo entries (content + status only), it
 * decides which kind of reminder a caller should emit, or whether the
 * list makes every reminder premise false and no reminder should be
 * emitted at all.
 *
 * The decision interprets statuses with a fixed vocabulary:
 * `in_progress` and `pending` count as active work, while `blocked`,
 * `abandoned`, and `completed` do not. Mapping the returned tier onto
 * prompt text is the caller's concern, not this module's.
 *
 * @module
 */

import type { TodoItemView } from "./types.js";

/** Which reminder tier applies to the current todo state. */
export type TodoNudgeTier = "progress" | "done" | "resume";

/**
 * Decide the todo nudge tier for a flattened list of task views.
 *
 * - Empty list -> `null`: a cleared or absent list makes every reminder's
 *   premise false, so nudging would only be noise.
 * - No active items (all completed / abandoned / blocked) -> `"resume"`:
 *   the queue holds no work in flight and the caller should prompt the
 *   model to resume planning.
 * - Exactly one `in_progress` and zero `pending` -> `"done"`: the single
 *   running task is the whole queue, so its completion closes the list.
 * - Otherwise -> `"progress"`: active work remains and a progress
 *   reminder is appropriate.
 *
 * @param items - Task views to inspect (status is all that matters).
 * @returns The reminder tier, or `null` when no reminder applies.
 */
export function decideTodoNudge(
  items: readonly TodoItemView[],
): TodoNudgeTier | null {
  if (items.length === 0) {
    return null;
  }
  let inProgress = 0;
  let pending = 0;
  for (const item of items) {
    if (item.status === "in_progress") {
      inProgress += 1;
    } else if (item.status === "pending") {
      pending += 1;
    }
  }
  if (inProgress + pending === 0) {
    return "resume";
  }
  if (inProgress === 1 && pending === 0) {
    return "done";
  }
  return "progress";
}
