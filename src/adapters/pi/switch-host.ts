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
 * process-level {@link SwitchOpsStore} owns that handoff explicitly — a
 * documented slot with a reset surface instead of a free module variable —
 * and `createPiSwitchHost` binds each host to it (tests inject a store to
 * isolate the handoff).
 *
 * The session → primary surface is the shared {@link sessionAgentRegistry}:
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
import { sessionAgentRegistry } from "../../core/session/agent.js";
import type { PiCommandCtx } from "./handoff-target.js";

/**
 * Pending post-replacement switch operations for the newest session.
 *
 * Only one switch can be pending at a time (each switch creates its own
 * new session; an abandoned intermediate session is simply not drained).
 */
export interface PendingSwitchOps {
  /** The trimmed active tool set to apply in the new session. */
  activeTools?: string[];
  /**
   * The primary the new session is bound to.
   *
   * A replacement session's bind-time events run before its first
   * `before_agent_start` drains the deferred trim, so they resolve the
   * target from here; from the first bind onwards the shared registry
   * answers.
   */
  primary?: string;
}

/**
 * Process-level handoff slot for the pending switch operations.
 *
 * The writer is the host that handled the switch command; the reader is
 * the replacement session's fresh host (the extension factory re-ran on
 * `newSession`), so the slot must outlive a single host.  Owning it behind
 * this interface keeps its lifecycle explicit and its reset surface
 * documented.
 */
export interface SwitchOpsStore {
  /** Merge the queued operations into the pending slot. */
  stash(ops: PendingSwitchOps): void;
  /**
   * The pending replacement target, or `undefined` when no replacement
   * awaits its first turn.  Read-only: `drain`, `clearPrimary` or `reset`
   * clears it, never a read.
   */
  pendingPrimary(): string | undefined;
  /**
   * Revoke the pending primary, keeping any queued tool trim.
   *
   * A replacement that never created its session must not publish its
   * target, while the trim it queued still belongs to the session that
   * drains it.
   */
  clearPrimary(): void;
  /** Take and clear the queued operations, or `undefined` when none. */
  drain(): PendingSwitchOps | undefined;
  /**
   * Drop any queued operations.
   *
   * Used before a replacement so an abandoned intermediate session never
   * leaks its trim into the next one, and by tests for isolation.
   */
  reset(): void;
}

/**
 * Create an empty switch-ops store.
 *
 * @returns A fresh, isolated store.
 */
export function createSwitchOpsStore(): SwitchOpsStore {
  let pending: PendingSwitchOps | undefined;
  return {
    stash(ops) {
      pending = { ...(pending ?? {}), ...ops };
    },
    pendingPrimary() {
      return pending?.primary;
    },
    clearPrimary() {
      if (pending === undefined) return;
      delete pending.primary;
      if (Object.keys(pending).length === 0) pending = undefined;
    },
    drain() {
      const ops = pending;
      pending = undefined;
      return ops;
    },
    reset() {
      pending = undefined;
    },
  };
}

/**
 * The process-wide handoff slot.
 *
 * A switch spans two factory executions (see the module note), so the
 * slot is owned here rather than by any single `createPiSwitchHost` call.
 */
const switchOpsStore = createSwitchOpsStore();

/**
 * The pending replacement target of the process-level slot.
 *
 * The session → agent resolver reads it, so a replacement session's
 * bind-time events already resolve the primary the switch created it for.
 *
 * @returns The pending primary, or `undefined` when none awaits its turn.
 */
export function pendingSwitchPrimary(): string | undefined {
  return switchOpsStore.pendingPrimary();
}

/**
 * Reset the process-level pending switch slot (test isolation).
 *
 * The slot is process-global and bun shares one isolate across test
 * files, so tests must clear it deterministically.
 */
export function _resetPendingSwitchOpsForTesting(): void {
  switchOpsStore.reset();
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
   * Publish the primary the replacement session binds to.
   *
   * `undefined` revokes the published primary only: a tool trim the slot
   * already queues stays for the session that drains it.
   */
  stashPrimary(name: string | undefined): void;
}

/**
 * The session → primary surface over the shared registry.
 *
 * The switch host and the handoff identity both expose this one
 * implementation, so a binding either of them writes is what every reader
 * resolves.
 */
const primaryBinding: Pick<PiHandoffIdentity, "getPrimary" | "setPrimary"> = {
  getPrimary: (sessionID) => sessionAgentRegistry.resolve(sessionID),
  // `undefined` restores the session's unresolved state, which is what the
  // rollback of a session that had no binding yet leaves behind.
  setPrimary: (sessionID, name) => {
    if (name === undefined) sessionAgentRegistry.delete(sessionID);
    else sessionAgentRegistry.bind(sessionID, name);
  },
};

/**
 * Create the handoff identity surface over the shared registry and slot.
 *
 * @param store - The pending-ops slot (defaults to the process-level one).
 * @returns The surface the handoff target writes through.
 */
export function createPiHandoffIdentity(
  store: SwitchOpsStore = switchOpsStore,
): PiHandoffIdentity {
  return {
    ...primaryBinding,
    stashPrimary: (name) => {
      if (name === undefined) store.clearPrimary();
      else store.stash({ primary: name });
    },
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
 * The switch host plus the drain hook for its queued operations.
 */
export interface PiSwitchHostController {
  /** The host surface for the composition deps. */
  host: SwitchHost;
  /**
   * Take the pending post-replacement tool trim, or `undefined` when none
   * was queued.
   *
   * The caller applies it: the active-tool set has one writer (the pi
   * adapter's availability rule), so the drain never writes it directly.
   */
  drainPendingOps(): string[] | undefined;
}

/**
 * Build the primary-switch host surface.
 *
 * @param deps - The live pi state (baseline, active tools, widget, UI,
 *   command context).
 * @param store - The pending-ops handoff slot (defaults to the
 *   process-level store; tests inject one to isolate the handoff).
 * @returns The host and its drain hook.
 */
export function createPiSwitchHost(
  deps: PiSwitchHostDeps,
  store: SwitchOpsStore = switchOpsStore,
): PiSwitchHostController {
  const host: SwitchHost = {
    getBaselineTools: () => deps.getBaselineTools(),
    setActiveTools: (names) => deps.setActiveTools(names),
    // The session → primary surface, shared with the handoff identity.
    ...primaryBinding,
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
      // Clear any stale pending ops from a previous replacement so an
      // abandoned intermediate session never leaks its trim into the next
      // one, then publish this replacement's target.  The new session's
      // bind-time handlers run inside `newSession` and resolve the primary
      // from this slot; the parent's binding is the target `applySwitch`
      // just wrote.
      store.reset();
      const target = sessionAgentRegistry.resolve(parentSession);
      if (target !== undefined) store.stash({ primary: target });
      const result = await cmdCtx.newSession({
        parentSession,
        withSession: (newCtx) => {
          // All post-replacement work must run against the fresh session's
          // context — the old command context is stale once the session is
          // replaced.
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
            setActiveTools: (names) => store.stash({ activeTools: names }),
          };
          return options.withSession?.(ops);
        },
      });
      // A cancelled replacement never created a session, so the target
      // published above must not survive for the next one.  Only the
      // target: a queued trim still belongs to the next session.
      if (result.cancelled === true) store.clearPrimary();
      return result;
    },
  };

  return {
    host,
    drainPendingOps() {
      return store.drain()?.activeTools;
    },
  };
}
