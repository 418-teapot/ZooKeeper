/**
 * pi todo session catalog — the extension-scope todo port.
 *
 * The product composition may not capture a session-scoped store: a single
 * store shared by every session would let one session's cache miss scan
 * another session's transcript, and a store owned by the entry point would
 * outlive the session it describes.  The composition therefore receives
 * this catalog, which is `TodoStateStore`-shaped and routes every call to
 * the store of the session the call names.
 *
 * The stores themselves belong to the session scopes: the lifecycle
 * kernel's per-session `todoStore` service binds one through
 * {@link PiTodoSessions.own} and releases it when that session stops.  A
 * session the catalog never bound has no state and no transcript read —
 * fail-closed rather than inventing state for an unknown session.
 *
 * The serialisation gate lives here, beside the routing: a todo call is one
 * read-modify-write cycle and must not interleave with another, and a call
 * does not learn its session id until it is already inside the gate.  One
 * gate is a superset of one-gate-per-session, so no update can be lost; it
 * only keeps two sessions' mutations from overlapping.
 *
 * @module
 */

import { createSequencer } from "../../core/sequencer.js";
import type { FetchCandidates, TodoStateStore } from "../../core/todo/store.js";
import { createTodoStore } from "../../core/todo/store.js";
import type { TodoPhase } from "../../core/todo/types.js";

/** One session's todo store plus the handle that releases it. */
export interface PiTodoSessionHandle {
  /** The session's own store (owned by the session scope). */
  readonly store: TodoStateStore;
  /** Release the session's store and drop its cached state. */
  dispose(): void;
}

/**
 * The extension-scope todo port the composition receives.
 *
 * `get` / `set` / `invalidate` / `serialize` are the store contract the todo
 * tool and the progress hooks already consume; `own` is the session-scope
 * side that binds a session's store into the routing.
 */
export interface PiTodoSessions extends TodoStateStore {
  /**
   * Bind the store of one session scope.
   *
   * Re-binding the same id replaces the previous entry, which is how a
   * recreated scope takes its own id over.
   */
  own(sessionID: string): PiTodoSessionHandle;
  /**
   * Drop every bound store (the extension scope is stopping).
   *
   * The session scopes stop before their extension, so this only clears
   * leftovers; no session's state may outlive the extension that routed to
   * it.
   */
  release(): void;
}

/**
 * Create the todo catalog over a host candidate source.
 *
 * @param fetchCandidates - Newest-first transcript snapshot source; the
 *   session scope's stores share it (pi's transcript scan reads the live
 *   session manager, so the source is host state, not session state).
 * @returns The catalog the composition receives.
 */
export function createPiTodoSessions(
  fetchCandidates: FetchCandidates,
): PiTodoSessions {
  const live = new Map<string, TodoStateStore>();
  const gate = createSequencer();

  return {
    own(sessionID) {
      const store = createTodoStore(fetchCandidates);
      live.set(sessionID, store);
      return {
        store,
        dispose() {
          // Drop only the entry this scope still owns: a recreated scope's
          // store must survive the previous scope's teardown.
          if (live.get(sessionID) === store) live.delete(sessionID);
        },
      };
    },
    get(sessionID): Promise<TodoPhase[]> {
      const store = live.get(sessionID);
      // An unowned session is read THROUGH the transcript, uncached: the
      // read contract stays "restore this session's plan from its history",
      // but nothing is remembered for a session no scope owns, so the next
      // read scans again instead of pinning state nothing will release.
      if (store === undefined) {
        return createTodoStore(fetchCandidates).get(sessionID);
      }
      return store.get(sessionID);
    },
    set(sessionID, phases) {
      live.get(sessionID)?.set(sessionID, phases);
    },
    invalidate(sessionID) {
      live.get(sessionID)?.invalidate(sessionID);
    },
    serialize<T>(fn: () => Promise<T>): Promise<T> {
      return gate(fn);
    },
    release() {
      live.clear();
    },
  };
}
