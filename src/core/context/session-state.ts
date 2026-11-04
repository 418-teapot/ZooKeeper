/**
 * In-memory session state registry — the load-once cache that sits
 * between the pure state layer (`state.ts`) and persistence
 * (`store.ts`).
 *
 * Each session's state is loaded from the store on first access and
 * cached for the lifetime of its entry; every `read` of the same
 * session observes the same committed object.  The cache has no TTL and
 * performs no background save: an entry leaves the cache only through
 * `release`, `evict`, or `delete`, and only `commit` writes to the
 * store.
 *
 * Call-scoped work uses the permit protocol: `read` observes the
 * committed state, `commit` runs one change on a draft and makes it the
 * committed state only while its permit stays active and the write
 * succeeded.  Lifecycle cleanup uses `release`, `evict`, and `delete`.
 *
 * @module
 */

import type { WorkPermit } from "../lifecycle/index.js";
import { createSequencer, type Sequencer } from "../sequencer.js";
import type { SessionState } from "./state.js";
import type { StateStore } from "./store.js";

/**
 * Per-session registry over a store.
 *
 * `read` and `commit` are the only way to reach a session's state, so a
 * session's work never writes another session's state.  `release`,
 * `evict`, and `delete` cover the three lifecycle endings; none of them
 * runs on its own.
 */
export interface SessionStateManager {
  /** The store all cached state is loaded from and saved to. */
  readonly store: StateStore;
  /**
   * Read the committed state of the permit's session.
   *
   * Loads from the store on first access and caches the result.  Pure
   * read: nothing is written back, and the reader never runs when the
   * permit already lapsed.
   */
  read<T>(
    permit: WorkPermit,
    reader: (state: SessionState) => T,
  ): T | undefined;
  /**
   * Commit one change to the permit's session.
   *
   * Changes of one session run one at a time in submission order.  Each
   * change runs on a draft; the draft replaces the committed cache and
   * the store file only when the permit is still active afterwards and
   * the write succeeded.  Returns undefined when the permit lapsed, so a
   * caller never reports uncommitted work as committed; a failed write
   * rejects with a user-facing error that keeps the store error as its
   * cause and leaves the committed state in place.  An error the change
   * itself throws passes through unchanged.
   */
  commit<T>(
    permit: WorkPermit,
    change: (state: SessionState) => T | Promise<T>,
  ): Promise<T | undefined>;
  /**
   * Save the committed state of one session and drop its cache entry.
   *
   * Lifecycle cleanup calls it after the session's work finished.  A
   * failed write throws and keeps the cache entry, so the cleanup
   * mechanism reports the failure and a later release can retry.
   */
  release(sessionId: string): void;
  /**
   * Drop one session's cached entry without writing back.
   *
   * The caller owns the store side of the decision: the deletion path
   * removes the file first (writing the entry back would resurrect the
   * deletion).  No-op when the session is not cached; never throws.
   *
   * @param sessionId - The session identifier to drop from cache.
   */
  evict(sessionId: string): void;
  /**
   * Drop one session's cache entry and delete its store file.
   *
   * Nothing is written back, so a deleted session stays deleted.
   */
  delete(sessionId: string): void;
}

/**
 * Create an in-memory session state manager over the given store.
 *
 * @param store - The store backing the registry.
 * @returns The session state manager.
 */
export function createSessionStateManager(
  store: StateStore,
): SessionStateManager {
  const entries = new Map<string, SessionState>();
  const sequencers = new Map<string, Sequencer>();

  /** The committed state of one session, loaded from the store on miss. */
  const load = (sessionId: string): SessionState => {
    const cached = entries.get(sessionId);
    if (cached !== undefined) return cached;
    const state = store.load(sessionId);
    entries.set(sessionId, state);
    return state;
  };

  /** The sequencer that serialises commits of one session. */
  const sequencerFor = (sessionId: string): Sequencer => {
    let sequencer = sequencers.get(sessionId);
    if (sequencer === undefined) {
      sequencer = createSequencer();
      sequencers.set(sessionId, sequencer);
    }
    return sequencer;
  };

  const read = <T>(
    permit: WorkPermit,
    reader: (state: SessionState) => T,
  ): T | undefined => {
    if (!permit.isActive()) return undefined;
    return reader(load(permit.sessionID));
  };

  const commit = <T>(
    permit: WorkPermit,
    change: (state: SessionState) => T | Promise<T>,
  ): Promise<T | undefined> => {
    if (!permit.isActive()) return Promise.resolve(undefined);
    const sessionId = permit.sessionID;
    return sequencerFor(sessionId)(async () => {
      if (!permit.isActive()) return undefined;
      const draft: SessionState = structuredClone(load(sessionId));
      const value = await change(draft);
      if (!permit.isActive()) return undefined;
      // One synchronous segment: no other commit interleaves between
      // the file write and the cache swap.
      try {
        store.save(sessionId, draft);
      } catch (err) {
        throw new Error(
          "本次修改未生效：会话状态写入磁盘失败，会话状态未改动。" +
            "请检查磁盘空间和存储目录权限后重试。",
          { cause: err },
        );
      }
      entries.set(sessionId, draft);
      return value;
    });
  };

  const release = (sessionId: string): void => {
    const committed = entries.get(sessionId);
    if (committed !== undefined) store.save(sessionId, committed);
    entries.delete(sessionId);
    sequencers.delete(sessionId);
  };

  const evict = (sessionId: string): void => {
    entries.delete(sessionId);
  };

  const remove = (sessionId: string): void => {
    entries.delete(sessionId);
    store.delete(sessionId);
    sequencers.delete(sessionId);
  };

  return { store, read, commit, release, evict, delete: remove };
}
