/**
 * Process-wide shared session-state manager for the context pipeline.
 *
 * The hook, the compress/decompress tools, and the /dcp command all run
 * in the same plugin process and must observe ONE in-memory state per
 * session — separate managers over the same directory would fork state.
 * This accessor pins the singleton; the backing store uses the default
 * storage directory.
 *
 * Two records sit here, and they differ in what a stop keeps:
 *
 *  - the in-memory state cache (`sessionStateCacheResource`) drops its entry
 *    on every stop, writing the cached mutations back on a runtime release
 *    so a stop never discards the compression this instance made;
 *  - the persisted state file (`sessionStateFileResource`) survives a
 *    runtime release, because the session still exists on the host side,
 *    and only a deletion removes it.
 *
 * Both are declared as session resources (`session/resources.ts`),
 * so a host stop reaches them through the session scope.  Adding a new
 * session-level record means declaring it there, not adding a line to a
 * host's event handler.
 *
 * @module
 */

import type {
  ReleasedSessionResource,
  RetainedSessionResource,
} from "../session/resources.js";
import { _resetRoundViewsForTesting } from "./round-view.js";
import {
  createSessionStateManager,
  type SessionStateManager,
} from "./session-state.js";
import type { SessionState } from "./state.js";
import { createStateStore, type StateStore } from "./store.js";

let manager: SessionStateManager | null = null;
let store: StateStore | null = null;

/** Return the store the resident state lives in, creating it on first use. */
function stateStore(): StateStore {
  store ??= createStateStore();
  return store;
}

/** Return the shared manager, creating it on first use. */
export function getContextStateManager(): SessionStateManager {
  manager ??= createSessionStateManager(stateStore());
  return manager;
}

// ---------------------------------------------------------------------------
// Session state records
// ---------------------------------------------------------------------------

/**
 * The in-memory state cache of one session.
 *
 * A runtime release writes the cached mutations back before dropping the
 * entry, so releasing never discards a compression; a deletion drops the
 * entry silently, because the file record removes the file and a write-back
 * would resurrect the deletion.
 *
 * A stop never creates the manager: no manager means this process loaded no
 * state at all, so there is nothing cached to drop.
 */
export const sessionStateCacheResource: ReleasedSessionResource = {
  name: "sessionStateCache",
  runtime: "release",
  release(sessionID) {
    manager?.save(sessionID);
    manager?.evict(sessionID);
  },
  delete(sessionID) {
    manager?.evict(sessionID);
  },
};

/**
 * The persisted state file of one session.
 *
 * A runtime release keeps it, so the next instance restores the session's
 * context.  A deletion removes it — also for a session this process never
 * loaded, so the file record resolves the store without a manager.
 */
export const sessionStateFileResource: RetainedSessionResource = {
  name: "sessionStateFile",
  runtime: "retain",
  delete(sessionID) {
    stateStore().delete(sessionID);
  },
};

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
 * blocks.  Never persisted — loss on restart is benign; a session stop drops
 * it with the session's other runtime records.
 */
const pendingViewChangeFlags = new Map<string, boolean>();

/** Drop the session's pending-view-change flag. */
function clearPendingViewChange(sessionID: string): void {
  pendingViewChangeFlags.delete(sessionID);
}

/**
 * The pending-view-change flags are runtime-only: both stop modes drop the
 * flag, because the next release phase consumes it once.
 */
export const pendingViewChangeFlagResource: ReleasedSessionResource = {
  name: "pendingViewChangeFlag",
  runtime: "release",
  release: clearPendingViewChange,
  delete: clearPendingViewChange,
};

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
 * @param storeOverride - Optional store the next manager binds to, and the
 *   store a stop resolves; suites that observe persistence pass a sandbox
 *   store instead of the default one.  No manager is created here, so a test
 *   can stop a session this process never loaded.
 */
export function _resetContextStateManagerForTesting(
  storeOverride?: StateStore,
): void {
  manager = null;
  store = storeOverride ?? null;
  pendingViewChangeFlags.clear();
  _resetRoundViewsForTesting();
}

/** Test affordance: whether the shared manager exists yet. */
export function _hasContextStateManagerForTesting(): boolean {
  return manager !== null;
}
