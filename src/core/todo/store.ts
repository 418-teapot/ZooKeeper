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
 * Ownership is one store per session.  A store caches one session's state,
 * so it is bound to that session's scope and released when the scope stops:
 * on pi the composition receives an extension-scope catalog
 * (`adapters/pi/todo-sessions.ts`) that routes every call to the store the
 * named session owns.  Sharing one store across sessions would let a cache
 * miss scan another session's transcript and serve that state as this
 * session's plan.
 *
 * The store also offers a serialisation gate (`serialize`): callers that
 * hold one store and must not interleave their read-modify-write cycles
 * run them through it.  A port that routes several sessions to several
 * stores owns a gate of its own beside the routing, so the cycles it
 * serves stay serialised across sessions as well.
 *
 * @module
 */

import { createSequencer } from "../sequencer.js";
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
  /**
   * Run a state change alone with respect to every other change made
   * through this store (used by the todo tool to make its
   * read-modify-write cycle atomic).
   *
   * Queued functions start in submission order and never overlap; a
   * rejected function is reported to its own caller without affecting
   * the rest of the queue.  A function must not call `serialize` again
   * while running.
   *
   * @param fn - The change to run.
   * @returns Whatever `fn` resolved with.
   */
  serialize<T>(fn: () => Promise<T>): Promise<T>;
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
  const gate = createSequencer();

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

    serialize<T>(fn: () => Promise<T>): Promise<T> {
      return gate(fn);
    },
  };
}
