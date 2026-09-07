/**
 * Process-wide shared session-state manager for the context pipeline.
 *
 * The hook, the compress/decompress tools, and the /dcp command all run
 * in the same plugin process and must observe ONE in-memory state per
 * session — separate managers over the same directory would fork state.
 * This accessor pins the singleton; the backing store uses the default
 * storage directory.
 *
 * Also registers the `cleanupSession` entry point that drops every
 * per-session record on `session.deleted` events — including the
 * session's binding in the shared agent registry
 * (`core/session-agent.ts`, read by units through
 * `Deps.resolveAgent`).  Adding a new session-level record means
 * registering its cleanup in `cleanupSession`, not adding a line to the
 * host's event handler.
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
import { createStateStore } from "./store.js";

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
 * Single cleanup entry point called on `session.deleted` events: drops
 * the session-agent binding, the model-limit entry, the persisted state
 * file, the pending view-change flag (however it was armed), the cached
 * round view, and the in-memory cache entry via
 * `SessionStateManager.evict`.  The cache eviction is silent (no
 * write-back) because the on-disk file has already been removed and
 * writing it back would resurrect the deletion — TTL eviction is
 * reserved for entries that are merely idle, not deleted.  Adding a new
 * per-session record means registering its cleanup here, not adding a
 * line to the host's event handler.
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
 * blocks.  Never persisted — loss on restart is benign; `cleanupSession`
 * drops it with the session's other records.
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

/** Test affordance: drop the singleton so suites can isolate state. */
export function _resetContextStateManagerForTesting(): void {
  manager = null;
  pendingViewChangeFlags.clear();
  _resetRoundViewsForTesting();
}
