/**
 * Pi todo-history scanner — extracts todo snapshot candidates from the pi
 * session message history.
 *
 * The todo tool persists its state snapshot as the `details` field of its
 * toolResult messages in the pi session transcript.  On restart / fork /
 * compaction the in-memory state is rebuilt by scanning the current session
 * history for the most recent snapshot — snapshots only, never replaying
 * operations.
 *
 * This module performs the collection half of that rebuild: given the
 * chronological entries produced by `sessionManager.buildContextEntries()`
 * (see `subagent-scan.ts` for the entry shape and the scanning precedent),
 * it returns the `details` payloads of todo toolResults ordered NEWEST
 * FIRST, so the caller can take the first candidate it accepts.
 *
 * Selection rules:
 * - Only `toolResult` messages with `toolName === "todo"` are collected;
 *   everything else (assistant `toolCall` blocks, other tools' results,
 *   non-message entries) is ignored.
 * - A todo toolResult whose `details` is missing or not a plain object is
 *   skipped — a failed call writes no snapshot.  (Arrays are rejected too:
 *   the snapshot payload is always an object.)
 * - The candidate content itself is NOT parsed or validated here;
 *   lenient structural validation belongs to the downstream
 *   `restoreFromHistory` in `src/core/todo/serialize.ts`.
 *
 * Pure function: no I/O, no side effects, no host access.
 *
 * @module
 */

import type { PiHistoryEntry } from "./subagent-scan.js";

/** The tool name whose results carry the persisted todo snapshot. */
const TODO_TOOL_NAME = "todo";

/** The structural view of a history message used by the scan. */
interface TodoResultCandidate {
  role?: unknown;
  toolName?: unknown;
  details?: unknown;
}

/**
 * Whether a raw `details` value is a usable snapshot candidate.
 *
 * Only non-null plain objects count; missing values, primitives, and
 * arrays are rejected (a failed call writes no snapshot object).
 *
 * @param value - The raw `details` value from a todo toolResult message.
 * @returns Whether the value should be collected as a candidate.
 */
function isSnapshotObject(value: unknown): boolean {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Scan pi history entries for todo tool-result snapshots.
 *
 * Walks the chronological entry array backward so the returned candidates
 * are ordered newest first.  Only the structural collection is performed
 * here — the caller decides which candidate is a valid snapshot.
 *
 * @param entries - The pi context entries from `buildContextEntries()`,
 *   in chronological order.
 * @returns The `details` payloads of todo toolResults, newest first.
 */
export function scanTodoSnapshots(entries: PiHistoryEntry[]): unknown[] {
  const snapshots: unknown[] = [];
  for (let i = entries.length - 1; i >= 0; i--) {
    const message = entries[i]?.message;
    if (message === null || typeof message !== "object") continue;
    const msg = message as TodoResultCandidate;
    if (msg.role !== "toolResult") continue;
    if (msg.toolName !== TODO_TOOL_NAME) continue;
    if (!isSnapshotObject(msg.details)) continue;
    snapshots.push(msg.details);
  }
  return snapshots;
}
