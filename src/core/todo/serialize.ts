/**
 * Snapshot serialization and recovery for the todo state machine.
 *
 * `serializeSnapshot` produces the canonical `{ op, phases }` shape persisted
 * after a state change; `restoreFromHistory` recovers the newest usable state
 * from a newest-first list of raw candidate values, repairing what is clearly
 * typed and skipping what is not. Recovery never throws: it falls back to an
 * empty list when nothing is usable.
 *
 * @module
 */

import { normalizePhases } from "./normalize.js";
import type { TodoOperation, TodoPhase } from "./types.js";
import { clonePhases, isTodoStatus } from "./types.js";

/** Canonical serialized shape of a todo state. */
export interface TodoSnapshot {
  /** Operation that produced the snapshot. */
  op: TodoOperation;
  /** The captured phases. */
  phases: TodoPhase[];
}

/**
 * Serialize a todo state for persistence.
 *
 * @param op - Operation that produced this state.
 * @param phases - Todo phases to serialize.
 * @returns A deep-cloned `{ op, phases }` snapshot.
 */
export function serializeSnapshot(
  op: TodoOperation,
  phases: readonly TodoPhase[],
): TodoSnapshot {
  return { op, phases: clonePhases(phases) };
}

/**
 * Recover todo phases from candidate snapshots ordered newest first.
 *
 * Each candidate is parsed leniently: unknown fields are ignored, phases and
 * items are checked structurally, and an item with an unknown status is
 * demoted to `pending` — as is a `blocked` item whose reason cannot be
 * recovered, so the restored state never carries a blocked task without a
 * reason. The first structurally valid candidate wins; invalid
 * candidates are skipped in favor of older ones. The recovered phases pass
 * through normalization (single point), so the one-in-progress invariant
 * holds before the state is first rendered. If nothing is usable the
 * explicit empty fallback `[]` is returned — never an exception.
 *
 * @param candidates - Raw snapshot values, newest first.
 * @returns The recovered phases of the newest valid candidate, or `[]`.
 */
export function restoreFromHistory(
  candidates: readonly unknown[],
): TodoPhase[] {
  for (const candidate of candidates) {
    const recovered = tryParseSnapshot(candidate);
    if (recovered) return normalizePhases(recovered);
  }
  return [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Parse a single candidate. Returns `undefined` when any item or phase is
 * structurally invalid — a corrupt snapshot is skipped wholesale rather than
 * silently dropping entries from persisted state.
 */
function tryParseSnapshot(value: unknown): TodoPhase[] | undefined {
  if (!isRecord(value) || !Array.isArray(value.phases)) return undefined;

  const phases: TodoPhase[] = [];
  for (const rawPhase of value.phases) {
    if (
      !isRecord(rawPhase) ||
      typeof rawPhase.name !== "string" ||
      !Array.isArray(rawPhase.tasks)
    ) {
      return undefined;
    }

    const tasks: TodoPhase["tasks"] = [];
    for (const rawTask of rawPhase.tasks) {
      if (!isRecord(rawTask) || typeof rawTask.content !== "string") {
        return undefined;
      }
      // A blocker is kept only when it is a string that stays non-empty after
      // whitespace collapsing; anything else (non-string, empty, blank) is
      // dropped so a blocked task never carries an empty reason.  A blocked
      // task whose reason cannot be recovered is demoted to `pending` —
      // blocked without a reason would violate the blocked-requires-reason
      // invariant and the task could never be auto-promoted.
      const blocker =
        typeof rawTask.blocker === "string"
          ? rawTask.blocker.replace(/\s+/g, " ").trim()
          : undefined;
      const hasBlocker = blocker !== undefined && blocker.length > 0;
      const status = isTodoStatus(rawTask.status) ? rawTask.status : "pending";
      tasks.push({
        content: rawTask.content,
        status: status === "blocked" && !hasBlocker ? "pending" : status,
        ...(hasBlocker ? { blocker } : {}),
      });
    }
    phases.push({ name: rawPhase.name, tasks });
  }
  return phases;
}
