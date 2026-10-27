/**
 * Process-wide shared session-state manager for the context pipeline.
 *
 * The hook, the compress/decompress tools, and the /dcp command all run
 * in the same plugin process and must observe ONE in-memory state per
 * session — separate managers over the same directory would fork state.
 * This accessor pins the singleton; the backing store uses the default
 * storage directory.
 *
 * Two release entry points sit here, and they differ in what survives:
 *
 *  - `cleanupSession` drops every per-session record on
 *    `session.deleted` events — including the persisted state file and
 *    the session's binding in the shared agent registry
 *    (`core/session-agent.ts`, read by units through
 *    `Capabilities.resolveAgent`).
 *  - `releaseSessionRuntime` drops only the in-memory state for a stop
 *    that is not a deletion (a plugin dispose or reload), keeping the
 *    persisted state and the agent binding so a later instance restores
 *    the same session.
 *
 * Adding a new session-level record means registering its release in
 * both entry points, not adding a line to the host's event handler.
 *
 * @module
 */

import { sessionAgentRegistry } from "../session-agent.js";
import { clearModelLimit } from "./model-limits.js";
import { _resetRoundViewsForTesting, clearRoundView } from "./round-view.js";
import {
  createSessionStateManager,
  type SessionStateManager,
} from "./session-state.js";
import type { SessionState } from "./state.js";
import { createStateStore, type StateStore } from "./store.js";

let manager: SessionStateManager | null = null;

/** Return the shared manager, creating it on first use. */
export function getContextStateManager(): SessionStateManager {
  manager ??= createSessionStateManager(createStateStore());
  return manager;
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

/**
 * Drop every per-session record for the given session ID.
 *
 * Deletion entry point, called only when the host reports
 * `session.deleted`: drops the session-agent binding, the model-limit
 * entry, the persisted state file, the pending view-change flag (however
 * it was armed), the cached round view, and the in-memory cache entry via
 * `SessionStateManager.evict`.  The cache eviction is silent (no
 * write-back) because the on-disk file has already been removed and
 * writing it back would resurrect the deletion — TTL eviction is
 * reserved for entries that are merely idle, not deleted.
 *
 * This is deliberately not `releaseSessionRuntime` plus a file delete:
 * that entry point saves the cache back before evicting, which would
 * recreate the file this call just removed.
 *
 * @param sessionID - The session identifier to clean up.
 */
export function cleanupSession(sessionID: string): void {
  sessionAgentRegistry.delete(sessionID);
  clearModelLimit(sessionID);
  pendingViewChangeFlags.delete(sessionID);
  clearRoundView(sessionID);
  const manager = getContextStateManager();
  manager.store.delete(sessionID);
  // Silent drop — the store file is already gone, so writing the
  // cached entry back here would resurrect it on disk.
  manager.evict(sessionID);
}

/**
 * Release the runtime state of one session, keeping its persisted context.
 *
 * Used for every stop that is not a session deletion — a plugin dispose
 * or reload — where the session itself still exists on the host side.
 * The model limit, the cached round view, the pending view-change flag
 * and the cached state entry are dropped, while the store file and the
 * session-agent binding stay: the next plugin instance must be able to
 * restore the session's context and identity.  Cached mutations are
 * written back before the entry is dropped, so releasing runtime state
 * never discards the compression this instance performed.
 *
 * @param sessionID - The session identifier to release.
 */
export function releaseSessionRuntime(sessionID: string): void {
  clearModelLimit(sessionID);
  pendingViewChangeFlags.delete(sessionID);
  clearRoundView(sessionID);
  const manager = getContextStateManager();
  // Save before evicting: a silent drop here would discard every
  // compression this instance made, because the file stays on disk.
  manager.save(sessionID);
  manager.evict(sessionID);
}

// ---------------------------------------------------------------------------
// Runtime-only state flags
// ---------------------------------------------------------------------------

/**
 * In-memory-only flags carried on the shared session state object by
 * sibling units (the compress / decompress tools and the /dcp command).
 *
 * Not part of the persisted `SessionState` schema — a one-shot
 * signal consumed (cleared) by the pipeline: `pendingManualTrigger`
 * injects the synthetic compress command on the next turn.  Loss on
 * restart is benign.
 *
 * The flag sits on the session state object itself, so any unit that
 * reads or writes it must go through `getRuntimeFlaggedState` (or
 * the `RuntimeFlaggedState` alias) instead of the bare `SessionState`
 * type.  `pendingViewChange` deliberately does NOT live here — it is
 * signalled through this module's own flag map (see
 * `setPendingViewChange`).
 */
export interface RuntimeFlags {
  pendingManualTrigger?: boolean;
}

/** The session state plus the runtime-only flag fields. */
export type RuntimeFlaggedState = SessionState & RuntimeFlags;

/**
 * Return the session state typed with the runtime-only flag fields.
 *
 * The shared manager's `get` returns the bare `SessionState`; this
 * accessor attaches the flag contract so callers can read and write
 * `pendingManualTrigger` without a per-call cast.
 *
 * @param sessionId - The session identifier.
 * @returns The session state object (same reference as the manager's).
 */
export function getRuntimeFlaggedState(sessionId: string): RuntimeFlaggedState {
  return getContextStateManager().get(sessionId) as RuntimeFlaggedState;
}

// ---------------------------------------------------------------------------
// Pending view-change flags
// ---------------------------------------------------------------------------

/**
 * Per-session view-change flags shared by the pipeline.
 *
 * The transform hook's release phase consumes (reads and clears) the
 * flag on the next turn, bypassing the release percentage gate so
 * pending marks flip in the same turn the view changes.  Armed by the
 * fold phase (a block dropped out of this round's fold) and by the
 * compress/decompress tools and the /dcp command after mutating
 * blocks.  Never persisted — loss on restart is benign; the release
 * entry points drop it with the session's other runtime records.
 */
const pendingViewChangeFlags = new Map<string, boolean>();

/** Arm the session's pending-view-change flag. */
export function setPendingViewChange(sessionId: string): void {
  pendingViewChangeFlags.set(sessionId, true);
}

/** Read and clear the session's pending-view-change flag. */
export function consumePendingViewChange(sessionId: string): boolean {
  const flag = pendingViewChangeFlags.get(sessionId) === true;
  pendingViewChangeFlags.delete(sessionId);
  return flag;
}

/**
 * Test affordance: drop the singleton so suites can isolate state.
 *
 * @param store - Optional store to bind the fresh manager to; suites that
 *   observe persistence pass a sandbox store instead of the default one.
 */
export function _resetContextStateManagerForTesting(store?: StateStore): void {
  manager = store === undefined ? null : createSessionStateManager(store);
  pendingViewChangeFlags.clear();
  _resetRoundViewsForTesting();
}
