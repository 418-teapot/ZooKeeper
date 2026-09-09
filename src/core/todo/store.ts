/**
 * Per-session todo state store: the single owner of live todo state.
 *
 * The conversation transcript is the single source of truth for todo
 * state — snapshots ride along as tool-result details, and the state
 * rebuilt after a restart, a fork, or a compaction must equal the actual
 * state at that point. This store is the only restoration path: every
 * cache miss performs one scan (via a host-supplied candidate source)
 * followed by one `restoreFromHistory`, and the result is cached before
 * being served. No caller restores todo state anywhere else, so the
 * restore logic can never fork into variants that disagree.
 *
 * The host supplies `fetchCandidates` at the boundary (newest-first raw
 * snapshot values for a session); this module stays free of any host
 * dependency. Reads and writes hand out deep clones (the package's
 * `clonePhases` convention), so a caller mutating a returned array can
 * never corrupt the cache.
 *
 * Ownership is per host-extension instance: the host entry point creates
 * one store per extension factory execution and injects it through
 * `Deps.todoStore`, so each session (main or subagent child) reads and
 * writes only the store backed by its own transcript.  A process-wide
 * singleton would let a late compose replace the candidate source and
 * make one session's cache miss scan another session's transcript.
 *
 * @module
 */

import { restoreFromHistory } from "./serialize.js";
import type { TodoPhase } from "./types.js";
import { clonePhases } from "./types.js";

/**
 * Host-supplied source of raw snapshot candidates for a session.
 *
 * Returns candidate snapshot values ordered newest first; the store
 * feeds them to `restoreFromHistory`, whose "first valid candidate
 * wins" rule selects the state to restore.
 *
 * @param sessionId - The session whose history to scan.
 * @returns Newest-first raw candidate values.
 */
export type FetchCandidates = (
  sessionId: string,
) => Promise<readonly unknown[]>;

/** Owner of the per-session todo state cache. */
export interface TodoStateStore {
  /**
   * Return the session's todo state, restoring from history on a cache
   * miss. Cached sessions never re-invoke the candidate source.
   *
   * @param sessionId - The session to serve.
   * @returns A deep clone of the cached state.
   */
  get(sessionId: string): Promise<TodoPhase[]>;
  /**
   * Overwrite the cached state for a session (used by the todo tool
   * after applying operations).
   *
   * @param sessionId - The session to update.
   * @param phases - The new state; deep-cloned before storing.
   */
  set(sessionId: string, phases: readonly TodoPhase[]): void;
  /**
   * Drop the cached entry so the next access restores from history
   * again (used when session tree navigation switches branches).
   *
   * @param sessionId - The session to invalidate.
   */
  invalidate(sessionId: string): void;
}

/**
 * Create a todo state store over the given candidate source.
 *
 * A fetch failure (thrown synchronously or rejected) is reported as an
 * empty restore for that call only: the failure is not cached, so the
 * next access retries the candidate source. This keeps a transient
 * history-read error from permanently pinning a session to empty state.
 *
 * @param fetchCandidates - Host-supplied newest-first snapshot source.
 * @returns A fresh store instance.
 */
export function createTodoStore(
  fetchCandidates: FetchCandidates,
): TodoStateStore {
  const cache = new Map<string, TodoPhase[]>();

  return {
    async get(sessionId: string): Promise<TodoPhase[]> {
      const cached = cache.get(sessionId);
      if (cached) return clonePhases(cached);

      let candidates: readonly unknown[];
      try {
        candidates = await fetchCandidates(sessionId);
      } catch {
        return [];
      }
      const restored = restoreFromHistory(candidates);
      cache.set(sessionId, restored);
      return clonePhases(restored);
    },

    set(sessionId: string, phases: readonly TodoPhase[]): void {
      cache.set(sessionId, clonePhases(phases));
    },

    invalidate(sessionId: string): void {
      cache.delete(sessionId);
    },
  };
}
