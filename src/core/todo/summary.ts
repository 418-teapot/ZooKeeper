/**
 * Model-echo summary for the todo state machine.
 *
 * `formatSummary` renders a todo state (plus collected errors from the
 * applying batch) as the compact text returned to the orchestrator after a
 * todo operation. It mirrors the oh-my-pi summary conventions without any
 * truncation cap:
 * - errors lead the output (`Errors: ...`);
 * - open entries (`pending`/`in_progress`) are echoed under a
 *   `Remaining items (N):` header (`Remaining items: none.` when closed);
 * - completed/abandoned tasks are counted only, blocked tasks are counted
 *   separately;
 * - the `Overall:` line reports the closed count, the open count, and the
 *   blocked count;
 * - when later phases already hold completed/abandoned work, an extra note
 *   explains that the in-progress pointer resting behind that work is
 *   expected behavior, not a rollback.
 *
 * @module
 */

import type { TodoPhase } from "./types.js";

/**
 * Render a compact summary of a todo state.
 *
 * @param phases - Todo phases to summarize.
 * @param errors - Errors collected while producing this state (lead the text).
 * @param readOnly - Whether this summary describes a read-only view (changes
 *   the empty-list message).
 * @returns The summary text.
 */
export function formatSummary(
  phases: readonly TodoPhase[],
  errors: readonly string[],
  readOnly = false,
): string {
  const tasks = phases.flatMap((phase) => phase.tasks);

  if (tasks.length === 0) {
    if (errors.length > 0) return `Errors: ${errors.join("; ")}`;
    return readOnly ? "Todo list is empty." : "Todo list cleared.";
  }

  const lines: string[] = [];
  if (errors.length > 0) lines.push(`Errors: ${errors.join("; ")}`);

  // Group the open entries under the oh-my-pi "Remaining items (N):" header.
  // An all-closed list still prints the "none." variant so the Overall
  // count below never dangles without a preceding list context.
  const openEntries = tasks.filter(
    (task) => task.status === "pending" || task.status === "in_progress",
  );
  if (openEntries.length === 0) {
    lines.push("Remaining items: none.");
  } else {
    lines.push(`Remaining items (${openEntries.length}):`);
    for (const phase of phases) {
      for (const task of phase.tasks) {
        if (task.status !== "pending" && task.status !== "in_progress") {
          continue;
        }
        lines.push(`  - ${task.content} [${task.status}] (${phase.name})`);
      }
    }
  }

  const closed = tasks.filter(
    (task) => task.status === "completed" || task.status === "abandoned",
  ).length;
  const blocked = tasks.filter((task) => task.status === "blocked").length;
  const open = tasks.length - closed - blocked;
  lines.push(
    `Overall: ${closed}/${tasks.length} done, ${open} open` +
      (blocked > 0 ? `, ${blocked} blocked` : "") +
      ".",
  );

  // The normalization postcondition parks the in-progress pointer on the
  // earliest open task, which can sit behind completed work in later phases.
  // Spell that out instead of letting it read as a completed task reverting.
  const currentIdx = phases.findIndex((phase) =>
    phase.tasks.some(
      (task) => task.status === "pending" || task.status === "in_progress",
    ),
  );
  const workedAhead =
    currentIdx !== -1 &&
    phases.some(
      (phase, idx) =>
        idx > currentIdx &&
        phase.tasks.some(
          (task) => task.status === "completed" || task.status === "abandoned",
        ),
    );
  if (workedAhead) {
    lines.push(
      "The in-progress pointer sits in the earliest phase with open tasks; " +
        "completed or abandoned items in later phases mean work finished out " +
        "of order, so the pointer moving back is expected — nothing was reverted.",
    );
  }

  return lines.join("\n");
}
