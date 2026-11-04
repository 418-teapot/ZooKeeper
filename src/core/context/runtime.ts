/**
 * Per-plugin-instance context runtime.
 *
 * One `ContextRuntime` owns every in-memory record the context pipeline
 * and its tools share: the session state (loaded through a
 * `SessionStateManager`), the captured model limits, the published round
 * views, and the pending-view-change flags.  Every host composition root
 * creates exactly one runtime per plugin instance and injects it as the
 * `contextRuntime` capability, so two instances in one process never
 * observe each other's state.
 *
 * Two records sit here, and they differ in what a stop keeps:
 *
 *  - the in-memory state cache drops its entry on every stop, writing the
 *    cached mutations back on a runtime release so a stop never discards
 *    the compression this instance made;
 *  - the persisted state file survives a runtime release, because the
 *    session still exists on the host side, and only a deletion removes it.
 *
 * Both are declared as session resources (`session/resources.ts`), so a
 * host stop reaches them through the session scope.
 *
 * Call-scoped work uses the permit protocol: `read` observes the committed
 * state, `commit` runs one change on a draft and makes it the committed
 * state only while its permit stays active, and every runtime-only write
 * (a model limit, a round view, a pending-view-change flag) is gated the
 * same way.  A lapsed permit therefore never leaves a record behind.
 *
 * @module
 */

import type { WorkPermit } from "../lifecycle/index.js";
import {
  createModelLimitRegistry,
  type ModelLimitInfo,
  type ModelLimitRegistry,
} from "./model-limits.js";
import {
  createRoundViewRegistry,
  type RoundView,
  type RoundViewRegistry,
} from "./round-view.js";
import {
  createSessionStateManager,
  type SessionStateManager,
} from "./session-state.js";
import type { SessionState } from "./state.js";
import { createStateStore, type StateStore } from "./store.js";

/**
 * In-memory-only flags carried on the session state object by sibling
 * units (the compress / decompress tools and the /dcp command).
 *
 * Not part of the persisted `SessionState` schema — a one-shot signal
 * consumed (cleared) by the pipeline: `pendingManualTrigger` injects the
 * synthetic compress command on the next turn.  Loss on restart is benign.
 *
 * The flag sits on the session state object itself, so a unit that reads
 * or writes it types the object as `RuntimeFlaggedState` instead of the
 * bare `SessionState`.  `pendingViewChange` deliberately does NOT live
 * here — the runtime owns it as its own flag set.
 */
export interface RuntimeFlags {
  pendingManualTrigger?: boolean;
}

/** The session state plus the runtime-only flag fields. */
export type RuntimeFlaggedState = SessionState & RuntimeFlags;

/**
 * The context records of one plugin instance.
 *
 * Every method that writes runs only under an active permit; `read` and
 * `commit` keep the manager's one-change-at-a-time guarantee per session.
 */
export interface ContextRuntime {
  /** The store this runtime's state is loaded from and saved to. */
  readonly store: StateStore;
  /**
   * Read the committed state of the permit's session.
   *
   * Nothing is written back, and the reader never runs for a lapsed
   * permit.
   */
  read<T>(
    permit: WorkPermit,
    reader: (state: RuntimeFlaggedState) => T,
  ): T | undefined;
  /**
   * Commit one change to the permit's session.
   *
   * Changes of one session run one at a time in submission order, on a
   * draft.  The draft replaces the committed cache and the store file only
   * while the permit is still active.  Returns `undefined` when the permit
   * lapsed, so a caller never reports uncommitted work as committed.
   */
  commit<T>(
    permit: WorkPermit,
    change: (state: RuntimeFlaggedState) => T | Promise<T>,
  ): Promise<T | undefined>;
  /** Save the committed state of one session and drop its cache entry. */
  release(sessionID: string): void;
  /** Drop one session's cache entry without writing it back. */
  evict(sessionID: string): void;
  /** Drop one session's cache entry and delete its store file. */
  delete(sessionID: string): void;

  /** The model limit captured for a session, when known. */
  modelLimit(sessionID: string): ModelLimitInfo | undefined;
  /** Capture the active model's context limit; no-op for a lapsed permit. */
  setModelLimit(permit: WorkPermit, context: number, modelId: string): void;
  /** Drop the session's captured model limit. */
  clearModelLimit(sessionID: string): void;

  /** The round view published for a session, when known. */
  roundView(sessionID: string): RoundView | undefined;
  /** Publish the round's view; no-op for a lapsed permit. */
  publishRoundView(permit: WorkPermit, view: RoundView): void;
  /** Drop the session's published round view. */
  clearRoundView(sessionID: string): void;

  /** Arm the session's pending-view-change flag; no-op for a lapsed permit. */
  setPendingViewChange(permit: WorkPermit): void;
  /** Read and clear the flag; `false` for a lapsed permit. */
  consumePendingViewChange(permit: WorkPermit): boolean;
  /** Drop the session's pending-view-change flag. */
  clearPendingViewChange(sessionID: string): void;
}

/**
 * Create the context runtime of one plugin instance.
 *
 * @param store - The store the instance's session state lives in; the
 *   default store is used when omitted.
 * @returns A runtime whose records are private to this instance.
 */
export function createContextRuntime(
  store: StateStore = createStateStore(),
): ContextRuntime {
  const manager: SessionStateManager = createSessionStateManager(store);
  const modelLimits: ModelLimitRegistry = createModelLimitRegistry();
  const roundViews: RoundViewRegistry = createRoundViewRegistry();
  const pendingViewChanges = new Set<string>();

  return {
    store,
    read(permit, reader) {
      return manager.read(permit, (state) =>
        reader(state as RuntimeFlaggedState),
      );
    },
    commit(permit, change) {
      return manager.commit(permit, (state) =>
        change(state as RuntimeFlaggedState),
      );
    },
    release(sessionID) {
      manager.release(sessionID);
    },
    evict(sessionID) {
      manager.evict(sessionID);
    },
    delete(sessionID) {
      manager.delete(sessionID);
    },

    modelLimit(sessionID) {
      return modelLimits.get(sessionID);
    },
    setModelLimit(permit, context, modelId) {
      if (!permit.isActive()) return;
      modelLimits.set(permit.sessionID, context, modelId);
    },
    clearModelLimit(sessionID) {
      modelLimits.clear(sessionID);
    },

    roundView(sessionID) {
      return roundViews.get(sessionID);
    },
    publishRoundView(permit, view) {
      if (!permit.isActive()) return;
      roundViews.publish(permit.sessionID, view);
    },
    clearRoundView(sessionID) {
      roundViews.clear(sessionID);
    },

    setPendingViewChange(permit) {
      if (!permit.isActive()) return;
      pendingViewChanges.add(permit.sessionID);
    },
    consumePendingViewChange(permit) {
      if (!permit.isActive()) return false;
      return pendingViewChanges.delete(permit.sessionID);
    },
    clearPendingViewChange(sessionID) {
      pendingViewChanges.delete(sessionID);
    },
  };
}
