/**
 * OpenCode host services — the state owners of one plugin instance.
 *
 * Two facts are genuinely per session: whether the turn was observed
 * aborting, and the id of the wake this host injected whose echo must not
 * reset the reminder budget.  They are declared as a session service, so
 * each session owns its copy — one session's abort cannot silence its
 * sibling, and an echo is only ever matched against the session that
 * injected it.
 *
 *  - the `loop` extension service owns the loop engine, built once per
 *    plugin instance when the active profile contributed a settle
 *    strategy.  Its per-session reminder budgets and awaiting-progress
 *    locks stay inside the engine; the session runtime resets them when
 *    the session is released.
 *  - the `sessionRuntime` session service holds the consume-once abort flag
 *    and the pending wake echo.
 *
 * The context pipeline's per-session records (`cleanupSession` and
 * `releaseSessionRuntime`: the persisted state, the model limit, the round
 * view, the session's entry in the shared agent registry) stay
 * process-level: the hook, the tools and the `/dcp` command share one
 * store per process, so they cannot be re-created per plugin instance.
 * The session scope is their release boundary — a scope that stops is a
 * session this plugin instance is done with.
 *
 * What a stop does to those records depends on why the scope stopped.
 * Only the host's `session.deleted` ends the session itself, so only that
 * reason deletes the persisted context.  A plugin dispose or reload stops
 * the scope while the session lives on: the runtime state is released and
 * the persisted context (plus the session's agent binding, whose owner is
 * the process rather than this plugin instance) survives for the next
 * instance.  An unrecognised reason is treated as "keep": losing a
 * session's compression is unrecoverable, keeping a stale cache is not.
 *
 * @module
 */

import {
  cleanupSession,
  releaseSessionRuntime,
} from "../../core/context/runtime.js";
import {
  defineExtensionService,
  defineSessionService,
  type ServiceMap,
  type SessionScope,
} from "../../core/lifecycle/index.js";
import {
  createLoopEngine,
  type LoopEngine,
  type SettledContribution,
} from "../../core/loop/index.js";
import { SESSION_DELETED_REASON } from "./lifecycle.js";

/** The host inputs the service declarations close over. */
export interface OpenCodeServiceHost {
  /** The settle strategies the active profile contributed. */
  readonly onSettled: readonly SettledContribution[];
}

/**
 * The per-session state the always-on hooks drive.
 *
 * Every reader goes through the session it addresses, so no caller can
 * observe another session's abort flag or pending echo.
 */
export interface OpenCodeSessionState {
  /** The session this state belongs to. */
  readonly sessionID: string;
  /**
   * The loop engine shared by the plugin instance, or `undefined` when the
   * profile contributed no settle strategy (fail-closed: no settle judge,
   * no wake).
   */
  readonly engine: LoopEngine | undefined;
  /** Record an observed abort (`session.error`) for this session. */
  markAborted(): void;
  /** Claim the recorded abort; consume-once, so it cannot linger. */
  takeAborted(): boolean;
  /** Record the id of the wake this host injected into this session. */
  expectEcho(messageID: string): void;
  /**
   * Claim the pending wake echo when `messageID` is the injected message.
   *
   * @param messageID - The id the host reported for the user message.
   * @returns Whether this message was the host's own wake.
   */
  takeEcho(messageID: string | undefined): boolean;
  /** Drop a pending echo (an assistant update, or a failed delivery). */
  clearEcho(): void;
}

/** The session service value: the state plus the scope's release step. */
export interface OpenCodeSessionRuntime extends OpenCodeSessionState {
  /**
   * Release this session's state, budget, and process-level records.
   *
   * @param reason - The stop reason the kernel recorded; only
   *   {@link SESSION_DELETED_REASON} deletes the persisted context.
   */
  release(reason: string): void;
}

/**
 * Build the session runtime of one session scope.
 *
 * @param sessionID - The owning session.
 * @param engine - The plugin instance's loop engine, if any.
 * @returns The session runtime; its disposer releases it.
 */
function createSessionRuntime(
  sessionID: string,
  engine: LoopEngine | undefined,
): OpenCodeSessionRuntime {
  let aborted = false;
  let echoMessageID: string | undefined;

  return {
    sessionID,
    engine,
    markAborted() {
      aborted = true;
    },
    takeAborted() {
      const observed = aborted;
      aborted = false;
      return observed;
    },
    expectEcho(messageID) {
      echoMessageID = messageID;
    },
    takeEcho(messageID) {
      if (echoMessageID === undefined || messageID !== echoMessageID) {
        return false;
      }
      echoMessageID = undefined;
      return true;
    },
    clearEcho() {
      echoMessageID = undefined;
    },
    release(reason) {
      // Dropping the state is what makes a late event read as "no abort, no
      // echo": the kernel never hands a stopped session out again.
      aborted = false;
      echoMessageID = undefined;
      engine?.reset(sessionID);
      // The host deleting the session is the only stop that ends its
      // persisted context.  A plugin dispose or reload stops the scope
      // while the session lives on, so its state must survive; an unknown
      // reason is treated the same way.
      if (reason === SESSION_DELETED_REASON) {
        cleanupSession(sessionID);
        return;
      }
      releaseSessionRuntime(sessionID);
    },
  };
}

/**
 * Release the process-level records of a session no scope owned.
 *
 * A `session.deleted` event can name a session this instance never created
 * a scope for (the host announces a deletion for a session whose events
 * predate the plugin), so the event path releases that session's records —
 * the same full deletion a scope's disposer performs for that reason.
 * Only the deletion path calls this: a stop that keeps the session (a
 * dispose or reload) goes through the scope's own disposer.
 *
 * @param sessionID - The deleted session.
 */
export function releaseUnscopedSession(sessionID: string): void {
  cleanupSession(sessionID);
}

/**
 * Create the service declarations of one OpenCode plugin instance.
 *
 * @param host - The host inputs the factories close over.
 * @returns The extension and session declarations, in creation order.
 */
export function createOpenCodeHostServices(host: OpenCodeServiceHost) {
  const loop = defineExtensionService({
    name: "loop",
    deps: [],
    create: () => ({
      // Fail-closed: a profile that contributes no settle strategy gets no
      // engine, so the settle path cannot wake anything.
      engine:
        host.onSettled.length > 0
          ? createLoopEngine([...host.onSettled])
          : undefined,
    }),
  });

  const sessionRuntime = defineSessionService({
    name: "sessionRuntime",
    deps: [loop],
    create: ({ deps, sessionID }) =>
      createSessionRuntime(sessionID, deps.loop.engine),
    dispose: (runtime, { reason }) => runtime.release(reason),
  });

  return {
    extension: [loop] as const,
    session: [sessionRuntime] as const,
  };
}

/** The declaration set of one plugin instance. */
export type OpenCodeServiceDeclarations = ReturnType<
  typeof createOpenCodeHostServices
>;

/**
 * Narrow a session scope to the state the always-on hooks drive.
 *
 * The lifecycle wiring hands out whole scopes; the hooks address one
 * session's state only, so the session service is unwrapped here.
 *
 * @param scope - The ensured session scope, or `null` for no session.
 * @returns The session state, or `null`.
 */
export function sessionScopeState(
  scope: SessionScope<
    ServiceMap<OpenCodeServiceDeclarations["session"]>
  > | null,
): OpenCodeSessionState | null {
  return scope?.services.sessionRuntime ?? null;
}
