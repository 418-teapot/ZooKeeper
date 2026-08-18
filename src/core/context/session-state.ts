/**
 * In-memory session state registry — the load-once cache that sits
 * between the pure state layer (`state.ts`) and persistence
 * (`store.ts`).
 *
 * Each session's state is loaded from the store on first access and
 * cached for the lifetime of its entry; every `get` for the same
 * session returns the same object, so consumers mutate state in place
 * and write back explicitly with `save`.  Entries idle longer than
 * `ttlMs` are evicted on the next access — written back to the store
 * first — and `_resetForTesting` drops the whole cache for test
 * isolation.  `evict` drops a single entry silently (no write-back)
 * for the session-deleted path where the on-disk file has already
 * been removed and writing it back would resurrect the deletion.
 *
 * @module
 */

import type { SessionState } from "./state.js";
import type { StateStore } from "./store.js";

/** Default idle time before an unaccessed entry is evicted (7 days). */
const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Options for `createSessionStateManager`.
 */
export interface SessionStateManagerOptions {
  /** Idle time (ms) before an unaccessed entry is evicted. */
  ttlMs?: number;
  /** Clock used for TTL bookkeeping; defaults to `Date.now`. */
  now?: () => number;
}

/**
 * Per-session registry over a store.
 *
 * The pipeline-facing surface is two verbs: `get` (load-or-cache, same
 * reference per session) and `save` (explicit write-back).  `evict`
 * and `_resetForTesting` cover silent single-session and bulk cache
 * drops; `saveAll` covers bulk write-back.  `evict` and TTL eviction
 * share the verb "evict" but differ in semantics: TTL eviction saves
 * the entry back to the store first (the entry is merely idle), while
 * `evict` is a silent drop (the session is gone — its on-disk file
 * was already removed, so writing back would resurrect the deletion).
 */
export interface SessionStateManager {
  /** The store all cached state is loaded from and saved to. */
  readonly store: StateStore;
  /**
   * Load-or-cache the session's state.
   *
   * Returns the cached object when the session is already resident
   * (same reference on every call); otherwise loads from the store and
   * caches the result.  Also sweeps entries idle beyond `ttlMs`,
   * writing each back to the store before eviction.
   */
  get(sessionId: string): SessionState;
  /**
   * Write the cached state of one session back to the store.
   *
   * Explicit dirty write-back: the caller decides when a mutation is
   * worth persisting.  No-op when the session is not cached.
   */
  save(sessionId: string): void;
  /**
   * Drop one session's cached entry without writing back.
   *
   * Call this on the session-deleted path, where the on-disk file has
   * already been removed and writing it back would resurrect the
   * deletion.  Differs from TTL eviction (which saves first because
   * the entry is merely idle, not deleted); differs from
   * `_resetForTesting` (which drops the whole cache at once).
   * No-op when the session is not cached; never throws.
   *
   * @param sessionId - The session identifier to drop from cache.
   */
  evict(sessionId: string): void;
  /** Write every cached session state back to the store. */
  saveAll(): void;
  /** Drop the whole cache without saving (test isolation). */
  _resetForTesting(): void;
}

/** A cached entry: the state plus its last-access timestamp. */
interface SessionEntry {
  state: SessionState;
  lastAccessedAt: number;
}

/**
 * Create an in-memory session state manager over the given store.
 *
 * The default TTL is 7 days; pass `ttlMs` to override and `now` to
 * control the clock (tests fast-forward it to force eviction).
 *
 * @param store - The store backing the registry.
 * @param opts - Optional TTL and clock overrides.
 * @returns The session state manager.
 */
export function createSessionStateManager(
  store: StateStore,
  opts: SessionStateManagerOptions = {},
): SessionStateManager {
  const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
  const clock = opts.now ?? (() => Date.now());
  const entries = new Map<string, SessionEntry>();

  /**
   * Evict every entry except the requested one that has been idle
   * longer than `ttlMs`, writing each back to the store first.
   */
  const evictStale = (now: number, exceptSessionId?: string): void => {
    for (const [sessionId, entry] of [...entries]) {
      if (sessionId === exceptSessionId) continue;
      if (now - entry.lastAccessedAt > ttlMs) {
        store.save(sessionId, entry.state);
        entries.delete(sessionId);
      }
    }
  };

  const get = (sessionId: string): SessionState => {
    const now = clock();
    evictStale(now, sessionId);
    const cached = entries.get(sessionId);
    if (cached) {
      cached.lastAccessedAt = now;
      return cached.state;
    }
    const state = store.load(sessionId);
    entries.set(sessionId, { state, lastAccessedAt: now });
    return state;
  };

  const save = (sessionId: string): void => {
    const entry = entries.get(sessionId);
    if (entry) store.save(sessionId, entry.state);
  };

  const evict = (sessionId: string): void => {
    entries.delete(sessionId);
  };

  const saveAll = (): void => {
    for (const [sessionId, entry] of entries) {
      store.save(sessionId, entry.state);
    }
  };

  const reset = (): void => {
    entries.clear();
  };

  return { store, get, save, evict, saveAll, _resetForTesting: reset };
}
