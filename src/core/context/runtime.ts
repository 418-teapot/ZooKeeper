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
 * state only while its permit stays active and the write succeeded.  The
 * one-shot `pendingViewChange` flag rides on that draft, so it commits and
 * fails with the state it belongs to.  A model limit and a published round
 * view are separate records: the limit is captured under an active permit,
 * and a round view is published by the caller that committed the round.
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
 * units (the compress / decompress tools, the pipeline, and the /dcp
 * command).
 *
 * Not part of the persisted `SessionState` schema — one-shot signals
 * carried by the committed state and dropped with its cache entry:
 *
 *  - `pendingManualTrigger` injects the synthetic compress command on the
 *    next turn;
 *  - `pendingViewChange` forces the next release regardless of the
 *    releasedPercent gate.
 *
 * Both are written on the state draft, so they commit and fail with the
 * state they belong to.  Loss on restart is benign.
 */
export interface RuntimeFlags {
  pendingManualTrigger?: boolean;
  pendingViewChange?: boolean;
}

/** The session state plus the runtime-only flag fields. */
export type RuntimeFlaggedState = SessionState & RuntimeFlags;

/**
 * The context records of one plugin instance.
 *
 * `read` and `commit` keep the manager's one-change-at-a-time guarantee per
 * session, and a model limit is captured only under an active permit.  A
 * round view is published by the caller that committed the round.
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
   * while the permit is still active and the write succeeded.  Returns
   * `undefined` when the permit lapsed, and rejects when the write failed,
   * so a caller never reports uncommitted work as committed.
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
  /**
   * Publish the view of a round that already committed.
   *
   * The caller publishes only after its commit succeeded, so the view and
   * the state it addresses are the same committed result.
   */
  publishRoundView(sessionID: string, view: RoundView): void;
  /** Drop the session's published round view. */
  clearRoundView(sessionID: string): void;
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
    publishRoundView(sessionID, view) {
      roundViews.publish(sessionID, view);
    },
    clearRoundView(sessionID) {
      roundViews.clear(sessionID);
    },
  };
}
