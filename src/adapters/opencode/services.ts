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
 *    strategy.
 *  - the `sessionRuntime` session service is the session's whole state: the
 *    consume-once abort flag, the pending wake echo and the instance's
 *    engine.  The engine's per-session reminder budgets and
 *    awaiting-progress locks belong to this scope, so every stop of a
 *    session resets that session's loop state.
 *
 * The context pipeline's per-session records (the persisted state, the model
 * limit, the round view, the pending view-change flag, the session's entry in
 * the shared agent registry) stay process-level: the hook, the tools and the
 * `/dcp` command share one store per process, so they cannot be re-created per
 * plugin instance.  They are declared in `core/session/resources.ts` and
 * released through the `sessionResources` session service: the session scope
 * is their stop boundary, and the stop mode decides what it does to them.
 *
 * Only a `delete-session` stop ends a session, so only that mode deletes the
 * persisted context and the agent binding.  A `release-runtime` stop (the
 * plugin dispose) stops the scope while the session lives on: the runtime
 * records are released and the persisted context survives for the next
 * instance.  The reason is diagnostic and never selects the cleanup step.
 *
 * @module
 */

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
import { sessionResourcesService } from "../../core/session/resources.js";

/** The host inputs the service declarations close over. */
export interface OpenCodeServiceHost {
  /** The settle strategies the active profile contributed. */
  readonly onSettled: readonly SettledContribution[];
}

/**
 * The per-session state the always-on hooks drive: the `sessionRuntime`
 * service value.
 *
 * The abort flag and the pending echo belong to one session: a reader goes
 * through the session it addresses, so neither crosses a session boundary.
 * The engine is the plugin instance's shared object, so its budget
 * bookkeeping stays readable for every session of the instance.
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

/**
 * Build the session runtime of one session scope.
 *
 * @param sessionID - The owning session.
 * @param engine - The instance's loop engine, if the profile built one.
 * @returns The session runtime; its disposer drops it.
 */
function createSessionRuntime(
  sessionID: string,
  engine: LoopEngine | undefined,
): OpenCodeSessionState {
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
  };
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

  // The engine's per-session budget and awaiting lock are the session's own
  // resources: every stop of the session resets them, in both stop modes.
  const sessionRuntime = defineSessionService({
    name: "sessionRuntime",
    deps: [loop],
    create: ({ deps, sessionID }) =>
      createSessionRuntime(sessionID, deps.loop.engine),
    dispose: (session) => session.engine?.reset(session.sessionID),
  });

  return {
    extension: [loop] as const,
    session: [sessionRuntime, sessionResourcesService] as const,
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
 * session's state only, so the scope is unwrapped here.  The state is the
 * `sessionRuntime` service instance itself, so every reader sees the same
 * object until the session stops.
 *
 * @param scope - The ensured session scope, or `null` for no session.
 * @returns The session state, or `null`.
 */
export function sessionScopeState(
  scope: SessionScope<
    ServiceMap<OpenCodeServiceDeclarations["session"]>
  > | null,
): OpenCodeSessionState | null {
  if (scope === null) return null;
  return scope.services.sessionRuntime;
}
