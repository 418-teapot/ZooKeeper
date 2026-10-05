/**
 * Pi host adapter — the `/<agent>` primary-switch host surface.
 *
 * The primary-switch command unit drives pi's session-replacement API
 * through the `PiSwitchHost` contract.  This module builds that surface
 * from the pi entry point's live state: the shared untrimmed tool
 * baseline, the process-wide active tool set, the fleet widget (a `zoo`
 * widget write is a "primary changed" nudge, not a text update), the live
 * extension UI, and the live command context.
 *
 * A switch is asynchronous and re-runs the extension factory, so the
 * operations queued for the new session (the deferred tool trim) cannot
 * live on one host instance: the host that handled the `/<agent>` command
 * queues them from inside `withSession`, while a DIFFERENT factory
 * execution's first `before_agent_start` drains them.  The process-level
 * {@link SwitchOpsStore} owns that handoff explicitly — a documented slot
 * with a reset surface instead of a free module variable — and
 * `createPiSwitchHost` binds each host to it (tests inject a store to
 * isolate the handoff).
 *
 * @module
 */

import type { PiSwitchHost, PiSwitchNewSessionOps } from "../../core/slots.js";
import type { PiCommandCtx } from "./handoff-target.js";
import type { PiToolHostContext } from "./tool-host.js";

/** Structural subset of pi's extension UI the switch host writes to. */
type PiSwitchUi = PiToolHostContext["ui"];

/**
 * Pending post-replacement switch operations for the newest session.
 *
 * Only one switch can be pending at a time (each switch creates its own
 * new session; an abandoned intermediate session is simply not drained).
 */
export interface PendingSwitchOps {
  /** The trimmed active tool set to apply in the new session. */
  activeTools?: string[];
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
 * Reset the process-level pending switch slot (test isolation).
 *
 * The slot is process-global and bun shares one isolate across test
 * files, so tests must clear it deterministically.
 */
export function _resetPendingSwitchOpsForTesting(): void {
  switchOpsStore.reset();
}

/**
 * The live pi state the switch host reads.
 *
 * Every reader is a closure over the entry point's mutable context holder
 * so the host always sees the current extension surfaces.
 */
export interface PiSwitchHostDeps {
  /** Capture the shared untrimmed tool baseline (lazily, once). */
  getBaselineTools(): string[] | undefined;
  /** Replace the process-wide active tool set with the given names. */
  setActiveTools(toolNames: string[]): void;
  /** Nudge the fleet widget to re-render on a primary change. */
  refreshFleetWidget(): void;
  /** The live extension UI surface (non-`zoo` widgets), or undefined. */
  getUi(): PiSwitchUi | undefined;
  /** The live pi command context (session replacement), or undefined. */
  getCommandCtx(): PiCommandCtx | undefined;
  /**
   * Publish the fresh session's context on the shared holder, so later
   * reads resolve the replacement session.
   */
  setContext(ctx: unknown): void;
}

/**
 * The switch host plus the drain hook for its queued operations.
 */
export interface PiSwitchHostController {
  /** The host surface for the composition deps. */
  host: PiSwitchHost;
  /** Apply and clear the pending post-replacement operations. */
  drainPendingOps(): void;
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
  // A `zoo` write is a "primary changed" notification: the fleet widget
  // reads the active primary live, so the switch only nudges it to
  // re-render.  Every other key passes through plain.  `undefined` content
  // hides the widget.
  const writeWidget = (
    ui: PiSwitchUi | undefined,
    key: string,
    lines: string[] | undefined,
  ): void => {
    if (key === "zoo") {
      deps.refreshFleetWidget();
      return;
    }
    ui?.setWidget?.(key, lines, { placement: "aboveEditor" });
  };

  const host: PiSwitchHost = {
    getBaselineTools: () => deps.getBaselineTools(),
    setActiveTools: (names) => deps.setActiveTools(names),
    setWidget: (key, lines) => writeWidget(deps.getUi(), key, lines),
    // Replace the current session with a fresh one re-bound to the target
    // identity.  Delegates to the pi command context's `newSession` (the
    // same REPLACE operation the `/go` handoff target uses): the old
    // session is torn down, the new one is created with the target as
    // parent (so its bind-time `session_start`, `resources_discover`, and
    // first `before_agent_start` already resolve the new primary), and the
    // `withSession` callback runs against the fresh session's context.
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
      const cmdCtx = deps.getCommandCtx();
      if (!cmdCtx?.newSession) {
        throw new Error(
          "pi session replacement API is not available. " +
            "Ensure the pi command context exposes newSession.",
        );
      }
      // Clear any stale pending ops from a previous replacement so an
      // abandoned intermediate session never leaks its trim into the next
      // one.
      store.reset();
      return cmdCtx.newSession({
        parentSession: options.parentSession,
        withSession: (newCtx) => {
          // All post-replacement work must run against the fresh session's
          // context — the old command context is stale once the session is
          // replaced.
          deps.setContext(newCtx);
          const freshUi: PiSwitchUi = newCtx.ui;
          const ops: PiSwitchNewSessionOps = {
            setWidget: (key, lines) => writeWidget(freshUi, key, lines),
            setActiveTools: (names) => store.stash({ activeTools: names }),
          };
          return options.withSession?.(ops);
        },
      });
    },
  };

  return {
    host,
    drainPendingOps() {
      const ops = store.drain();
      if (ops?.activeTools !== undefined) {
        deps.setActiveTools(ops.activeTools);
      }
    },
  };
}
