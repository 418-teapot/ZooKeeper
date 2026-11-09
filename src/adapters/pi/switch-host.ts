/**
 * Pi host adapter — the `/<agent>` primary-switch host surface.
 *
 * The primary-switch command unit drives pi's session-replacement API
 * through the `SwitchHost` contract.  This module builds that surface
 * from the pi entry point's live state: the shared untrimmed tool
 * baseline, the process-wide active tool set, the session's fleet widget
 * (a `zoo` widget write is a "primary changed" nudge, not a text update),
 * and the command context of the session being replaced.
 *
 * Every addressable surface names its session explicitly: the command
 * context comes from the session the replacement names, and the fresh
 * context is bound under the session id pi reports for it.  A session id
 * is never inferred from "the last event".
 *
 * A switch is asynchronous and re-runs the extension factory, so the
 * operations queued for the new session cannot live on one host instance:
 * the host that handled the `/<agent>` command queues them, while a
 * DIFFERENT factory execution's bind-time handlers resolve the target and
 * its first `before_agent_start` drains the deferred tool trim.  The
 * process-level {@link SwitchOpsStore} owns that handoff explicitly: it is
 * part of the pi process owner (`process.ts`), so both factory executions
 * read the same slot and a test injects its own owner to isolate the
 * handoff.  `createPiSwitchHost` binds each host to that owner.
 *
 * The queued operations belong to exactly one session: the replacement the
 * switch or handoff asked pi to create.  Only that session's `session_start`
 * may claim them (see {@link SwitchOpsStore.claim}), so a reload, a resume,
 * a startup, a plain `/new` session or a failed replacement never receives
 * the target primary or the queued trim.  The claim binds the target before
 * the session's bind-time handlers run, and keys the trim to that session.
 *
 * The session → primary surface is the process owner's session registry:
 * `getPrimary` / `setPrimary` read and write one session's binding, so a
 * switch, a handler and the fleet widget always see the same answer.
 * Nothing here keeps a process-level "current primary".
 *
 * @module
 */

import type {
  SwitchHost,
  SwitchNewSessionOps,
} from "../../core/ports/switch.js";
import type { SessionAgentRegistry } from "../../core/session/agent.js";
import type { PiCommandCtx } from "./handoff-target.js";

/**
 * What one `session_start` reports about the session it started.
 *
 * These are the only facts a replacement claim matches on: pi reports
 * reason `new` for a session `newSession` created, and records the replaced
 * session on the new session's header.  A plain `/new` carries no parent,
 * and a reload / resume / startup / fork is another reason.
 */
export interface PiSessionStartFacts {
  /** pi's reason for the start. */
  readonly reason: string | undefined;
  /** The replaced session pi recorded, or undefined for a plain new one. */
  readonly parentSession: string | undefined;
}

/**
 * Pending post-replacement switch operations for the newest session.
 *
 * Only one switch can be pending at a time (each switch creates its own
 * new session; an abandoned intermediate session is simply not drained).
 */
export interface PendingSwitchOps {
  /**
   * The session the replacement replaces.
   *
   * pi records it on the new session's header, which is the evidence a
   * `session_start` must carry before it may claim the target and the
   * trim: every other start belongs to a session this replacement did not
   * create.
   */
  parentSession?: string;
  /** The trimmed active tool set to apply in the new session. */
  activeTools?: string[];
  /**
   * The primary the new session is bound to.
   *
   * A replacement session's bind-time events run before its first
   * `before_agent_start` drains the deferred trim, so the start that
   * claims this slot binds the target before them; from the bind onwards
   * the shared registry answers.
   */
  primary?: string;
}

/**
 * Process-level handoff slot for the pending switch operations.
 *
 * The writer is the host that handled the switch command; the reader is
 * the replacement session's fresh host (the extension factory re-ran on
 * `newSession`), so the slot must outlive a single host.  It belongs to the
 * pi process owner, which keeps its lifecycle explicit and its reset
 * surface documented.
 */
export interface SwitchOpsStore {
  /**
   * Open a replacement of one session, dropping stale operations.
   *
   * Used before a replacement so an abandoned intermediate session never
   * leaks its target or trim into the next one.
   */
  begin(parentSession: string): void;
  /**
   * Merge the queued operations into the pending slot.
   *
   * The replacement must already be open: `begin` ran and no claim, drain or
   * abandon closed the slot.  A write into a slot no replacement opened would
   * leave operations no `session_start` can ever claim, so it throws instead.
   *
   * @param ops - The target primary and/or the deferred tool trim.
   * @throws Error when no replacement is pending.
   */
  stash(ops: PendingSwitchOps): void;
  /**
   * Claim the pending replacement for one `session_start`.
   *
   * The claim succeeds only for the start pi reports as the new session of
   * the pending replacement: reason `new` (the reason `newSession`
   * reports) whose header names the replaced session.  A plain `/new`
   * carries no parent, and a reload / resume / startup / fork is another
   * reason, so none of them can consume the slot.
   *
   * @param sessionID - The session the start names.
   * @param facts - The evidence the start carries (see
   *   {@link PiSessionStartFacts}).
   * @returns The target primary when this start created the replacement
   *   session, `undefined` otherwise (the slot stays untouched).
   */
  claim(sessionID: string, facts: PiSessionStartFacts): string | undefined;
  /**
   * Take and clear one claimed session's deferred tool trim, or
   * `undefined` when that session holds none.
   */
  drain(sessionID: string): string[] | undefined;
  /**
   * Drop a replacement that created no session.
   *
   * A claimed slot belongs to a session pi did create, so its trim stays
   * for that session's first turn; only unclaimed operations are dropped.
   */
  abandon(): void;
}

/**
 * Create an empty switch-ops store.
 *
 * @returns A fresh, isolated store.
 */
export function createSwitchOpsStore(): SwitchOpsStore {
  let pending: PendingSwitchOps | undefined;
  /**
   * The session that claimed the pending slot, or undefined while no
   * `session_start` has proven it created the replacement.
   */
  let claimedBy: string | undefined;
  return {
    begin(parentSession) {
      pending = { parentSession };
      claimedBy = undefined;
    },
    stash(ops) {
      if (pending === undefined) {
        throw new Error("尚未开始一次会话替换，无法暂存切换操作。");
      }
      pending = { ...pending, ...ops };
    },
    claim(sessionID, facts) {
      if (pending === undefined || claimedBy !== undefined) return undefined;
      if (facts.reason !== "new") return undefined;
      if (pending.parentSession !== facts.parentSession) return undefined;
      claimedBy = sessionID;
      const primary = pending.primary;
      delete pending.primary;
      return primary;
    },
    drain(sessionID) {
      if (claimedBy !== sessionID) return undefined;
      const tools = pending?.activeTools;
      pending = undefined;
      claimedBy = undefined;
      return tools;
    },
    abandon() {
      if (claimedBy !== undefined) return;
      pending = undefined;
    },
  };
}

/**
 * The pi process state the switch surfaces read.
 *
 * A switch spans two factory executions (see the module note), so both read
 * the process owner instead of holding their own slot or registry.
 */
export interface PiSwitchState {
  /** The session → primary bindings of this process. */
  readonly sessionAgents: SessionAgentRegistry;
  /** The pending switch operations of this process. */
  readonly switchOps: SwitchOpsStore;
}

/**
 * The identity surface the `/go` handoff target writes through.
 *
 * The handoff replaces the session itself (it does not use this host's
 * `newSession`), so it publishes the target primary into the same pending
 * slot the switch uses and reads the replaced session's binding by id.
 */
export interface PiHandoffIdentity {
  /** The primary one session is bound to, or `undefined` when unresolved. */
  getPrimary(sessionID: string): string | undefined;
  /** Bind one session to a primary (`undefined` restores it unbound). */
  setPrimary(sessionID: string, name: string | undefined): void;
  /**
   * Open the replacement of one session and publish its target primary.
   *
   * The replaced session is the evidence the replacement's own
   * `session_start` must carry before the target binds (see
   * {@link SwitchOpsStore.claim}).
   */
  publishPrimary(parentSession: string, name: string): void;
  /** Drop the published replacement (it created no session). */
  dropPending(): void;
}

/**
 * The session → primary surface over the process owner's registry.
 *
 * The switch host and the handoff identity both expose this one
 * implementation, so a binding either of them writes is what every reader
 * resolves.
 *
 * @param state - The pi process state of this process.
 * @returns The read/write surface over its session bindings.
 */
function sessionPrimaryBinding(
  state: PiSwitchState,
): Pick<PiHandoffIdentity, "getPrimary" | "setPrimary"> {
  return {
    getPrimary: (sessionID) => state.sessionAgents.resolve(sessionID),
    // `undefined` restores the session's unresolved state, which is what the
    // rollback of a session that had no binding yet leaves behind.
    setPrimary: (sessionID, name) => {
      if (name === undefined) state.sessionAgents.delete(sessionID);
      else state.sessionAgents.bind(sessionID, name);
    },
  };
}

/**
 * Create the handoff identity surface over the process owner.
 *
 * @param state - The pi process state of this process.
 * @returns The surface the handoff target writes through.
 */
export function createPiHandoffIdentity(
  state: PiSwitchState,
): PiHandoffIdentity {
  return {
    ...sessionPrimaryBinding(state),
    publishPrimary: (parentSession, name) => {
      state.switchOps.begin(parentSession);
      state.switchOps.stash({ primary: name });
    },
    dropPending: () => state.switchOps.abandon(),
  };
}

/**
 * The live pi state the switch host reads.
 *
 * Every reader names the session it addresses, so the host resolves the
 * command context and the fleet widget of one session instead of whichever
 * session an event touched last.
 */
export interface PiSwitchHostDeps {
  /** Capture the shared untrimmed tool baseline (lazily, once). */
  getBaselineTools(): string[] | undefined;
  /** Replace the process-wide active tool set with the given names. */
  setActiveTools(toolNames: string[]): void;
  /** Nudge one session's fleet widget to re-render on a primary change. */
  refreshFleetWidget(sessionID: string): void;
  /**
   * The command context of one session (the entry its admitted command
   * bound), or undefined.
   */
  getCommandCtx(sessionID: string): PiCommandCtx | undefined;
  /**
   * Bind the fresh session's context under its own id, so later readers
   * resolve the replacement session.
   */
  setContext(sessionID: string, ctx: unknown): void;
}

/**
 * The switch host plus the claim / drain hooks for its queued operations.
 */
export interface PiSwitchHostController {
  /** The host surface for the composition deps. */
  host: SwitchHost;
  /**
   * Claim the pending replacement for one `session_start`.
   *
   * When the start is the new session of the pending replacement, this
   * binds that session to the published target and keeps its deferred
   * trim for {@link drainPendingOps}.  Every other start claims nothing.
   *
   * @param sessionID - The session the start names.
   * @param facts - The evidence the start carries (see
   *   {@link PiSessionStartFacts}).
   */
  claimPending(sessionID: string, facts: PiSessionStartFacts): void;
  /**
   * Take one claimed session's post-replacement tool trim, or `undefined`
   * when that session holds none.
   *
   * The caller applies it: the active-tool set has one writer (the pi
   * adapter's availability rule), so the drain never writes it directly.
   */
  drainPendingOps(sessionID: string): string[] | undefined;
}

/**
 * Build the primary-switch host surface.
 *
 * @param deps - The live pi state (baseline, active tools, widget, UI,
 *   command context).
 * @param state - The pi process state of this process (its pending-ops slot
 *   and session bindings).
 * @returns The host and its drain hook.
 */
export function createPiSwitchHost(
  deps: PiSwitchHostDeps,
  state: PiSwitchState,
): PiSwitchHostController {
  const { switchOps } = state;
  const host: SwitchHost = {
    getBaselineTools: () => deps.getBaselineTools(),
    setActiveTools: (names) => deps.setActiveTools(names),
    // The session → primary surface, shared with the handoff identity.
    ...sessionPrimaryBinding(state),
    // Replace the session the caller names with a fresh one re-bound to the
    // target identity.  Delegates to that session's command context
    // `newSession` (the same REPLACE operation the `/go` handoff target
    // uses): the old session is torn down, the new one is created with the
    // target as parent (so its bind-time `session_start`,
    // `resources_discover`, and first `before_agent_start` already resolve
    // the new primary), and the `withSession` callback runs against the
    // fresh session's context.
    //
    // pi invalidates the captured extension API and command context after
    // `newSession` — calling the action methods captured before the switch
    // inside `withSession` throws "This extension ctx is stale after
    // session replacement or reload...".  The facade handed to
    // `withSession` therefore binds every operation to the FRESH
    // `ReplacedSessionContext` pi passes there (which structurally
    // inherits the command-context surface):
    //   - `setWidget` runs immediately via the fresh context's
    //     `ui.setWidget`.
    //   - `setActiveTools` would touch the OLD session's action bindings,
    //     which pi invalidates on replacement — so it is deferred
    //     (stashed into the process-level slot) and applied at the new
    //     session's first `before_agent_start`, where the fresh host's API
    //     is non-stale.
    newSession: async (options) => {
      const parentSession = options.parentSession;
      const cmdCtx =
        parentSession === undefined
          ? undefined
          : deps.getCommandCtx(parentSession);
      if (parentSession === undefined || !cmdCtx?.newSession) {
        throw new Error(
          "pi session replacement API is not available. " +
            "Ensure the pi command context exposes newSession.",
        );
      }
      // Open this replacement, dropping stale operations of a previous one
      // so an abandoned intermediate session never leaks its trim into the
      // next one, then publish this replacement's target.  The replaced
      // session is the evidence the new session's `session_start` must
      // carry before the target binds; the parent's binding is the target
      // `applySwitch` just wrote.
      switchOps.begin(parentSession);
      const target = state.sessionAgents.resolve(parentSession);
      if (target !== undefined) switchOps.stash({ primary: target });
      let result: { cancelled: boolean };
      try {
        result = await cmdCtx.newSession({
          parentSession,
          withSession: (newCtx) => {
            // All post-replacement work must run against the fresh
            // session's context — the old command context is stale once the
            // session is replaced.
            const newSessionID = newCtx.sessionManager?.getSessionId();
            if (newSessionID !== undefined) {
              deps.setContext(newSessionID, newCtx);
            }
            const ops: SwitchNewSessionOps = {
              // A `zoo` write is a "primary changed" notification: the
              // session's fleet widget reads the active primary live, so the
              // switch only nudges that session to re-render.  Every other
              // key passes through to the fresh ui; `undefined` content
              // hides the widget.
              setWidget: (key, lines) => {
                if (key === "zoo") {
                  if (newSessionID !== undefined) {
                    deps.refreshFleetWidget(newSessionID);
                  }
                  return;
                }
                newCtx.ui?.setWidget?.(key, lines, {
                  placement: "aboveEditor",
                });
              },
              setActiveTools: (names) =>
                switchOps.stash({ activeTools: names }),
            };
            return options.withSession?.(ops);
          },
        });
      } catch (err) {
        // The replacement threw: nothing it published may outlive it.  A
        // replacement that did create its session already claimed the slot,
        // so the trim stays with that session; the error still propagates.
        switchOps.abandon();
        throw err;
      }
      // A cancelled replacement never created a session, so neither the
      // target nor the trim published above may survive for the next one.
      if (result.cancelled === true) switchOps.abandon();
      return result;
    },
  };

  return {
    host,
    claimPending(sessionID, facts) {
      const primary = switchOps.claim(sessionID, facts);
      if (primary !== undefined) state.sessionAgents.bind(sessionID, primary);
    },
    drainPendingOps(sessionID) {
      return switchOps.drain(sessionID);
    },
  };
}
