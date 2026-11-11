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
 *  - the `runScope` extension service is the run scope of this runtime: it
 *    reads the process run table and owns exactly the runs this runtime
 *    started through the `runs` capability, so the plugin's dispose ends
 *    those and leaves the process history alone.  A TUI panel is not part
 *    of this scope: its translator writes the process run table directly
 *    (a host fact), so the rows it records and the panel's own run-change
 *    subscription belong to the panel's lifetime, not to this stop.
 *  - the `capabilities` extension service owns this instance's capability
 *    provision: the values the shared composition service binds, and the
 *    materialisation facts the host answers (read while the service is
 *    created, never during the assembly).
 *  - the `composition` extension service assembles the active profile over
 *    that provision (see `core/composition.ts`).
 *  - the `loop` extension service owns the loop engine, built once per
 *    plugin instance when the active profile contributed a settle
 *    strategy.  The engine holds the strategies only.
 *  - the `sessionRuntime` session service is the session's whole state: the
 *    consume-once abort flag, the pending wake echo and the loop handle of
 *    this session.  The handle's reminder budgets and awaiting-progress
 *    locks belong to this scope, so they end with it and no sibling
 *    session can observe them.
 *
 * The context pipeline's per-session records (the persisted state, the model
 * limit, the round view, the pending view-change flag, the session's entry in
 * the agent registry) belong to the plugin instance: the hook, the tools and
 * the `/dcp` command share one `ContextRuntime` per instance, so no session
 * scope may own them.  They are declared by
 * `contextSessionResources(runtime)` in `core/session/resources.ts` and are
 * applied by the session lifecycle coordinator: the `sessionResources`
 * service releases them when the scope stops, and a session deletion drops
 * them after the scope stopped.
 *
 * A `release-runtime` stop (the plugin dispose) stops the scope while the
 * session lives on: the runtime records are released and the persisted
 * context and the agent binding survive for the next instance.  A deletion
 * ends the session and drops every record.  The reason is diagnostic and
 * never selects the cleanup step.
 *
 * @module
 */

import { configCapabilities } from "../../core/capabilities.js";
import {
  defineCompositionService,
  type HostCapabilities,
} from "../../core/composition.js";
import type {
  ConfigSnapshot,
  ProcessScope,
} from "../../core/config-snapshot.js";
import type { ContextRuntime } from "../../core/context/runtime.js";
import {
  defineExtensionService,
  defineSessionService,
  type ServiceMap,
  type SessionScope,
} from "../../core/lifecycle/index.js";
import { createLoopEngine, type LoopSession } from "../../core/loop/index.js";
import { ORCHESTRATOR_AGENT_NAME } from "../../core/orchestrator.js";
import type { Capabilities } from "../../core/ports/index.js";
import type { ProcessState } from "../../core/process-state.js";
import {
  defineSessionResourcesService,
  type SessionResourceCatalog,
} from "../../core/session/resources.js";
import type { RunScope } from "../../core/subagent/registry.js";
import { REGISTRY } from "../../registry.js";
import { createV1Adapter } from "./adapter.js";
import { readHostMaterialisation } from "./config.js";
import { createOpenCodeHandoffTarget } from "./handoff-target.js";
import { createOpenCodeMessageInjector } from "./message-injector.js";
import { todoSourceFromClient } from "./todo-source.js";
import { createV1ToolHost, resolveSessionAgent } from "./tool-host.js";

/** The host inputs the service declarations close over. */
export interface OpenCodeServiceHost {
  /** The configuration generation of this plugin instance. */
  readonly scope: ProcessScope<ConfigSnapshot>;
  /**
   * The OpenCode SDK client of this instance: the todo read, the tool host,
   * the message injector, the handoff target and the host config pre-read
   * all go through it.
   */
  readonly client: any;
  /** The working directory the host adapter reports. */
  readonly directory: string;
  /** The process state this instance runs over (shared, never created here). */
  readonly process: ProcessState;
  /** The context records of this plugin instance. */
  readonly contextRuntime: ContextRuntime;
  /** The session records of this plugin instance. */
  readonly sessionCatalog: SessionResourceCatalog;
  /** Test seam: the `zdebug` runner for the auto-debug strategy. */
  readonly zdebugExec?: Partial<Capabilities>["zdebugExec"];
}

/**
 * The capability provision of one OpenCode plugin instance.
 *
 * The shared composition service consumes the provision.  The session
 * resolvers travel with it because the infrastructure hooks and the
 * delegation gate read the same functions the composition bound.
 */
export interface OpenCodeCapabilities extends HostCapabilities {
  /**
   * The session → agent resolver of this plugin instance.
   *
   * It reads the shared session agent registry, which the always-on event
   * hook populates from `message.updated` events.
   */
  readonly resolveAgent: (sessionID: string) => string | undefined;
  /** The asynchronous caller resolver the delegation gate reads. */
  readonly resolveCallerAgent: (
    sessionID: string,
  ) => Promise<string | undefined>;
}

/**
 * The per-session state the always-on hooks drive: the `sessionRuntime`
 * service value.
 *
 * The abort flag, the pending echo and the loop handle belong to one
 * session: a reader goes through the session it addresses, so neither the
 * flag nor a reminder budget crosses a session boundary.
 */
export interface OpenCodeSessionState {
  /** The session this state belongs to. */
  readonly sessionID: string;
  /**
   * This session's loop handle, or `undefined` when the profile
   * contributed no settle strategy (fail-closed: no settle judge, no
   * wake).
   */
  readonly loop: LoopSession | undefined;
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
 * @param loop - This session's loop handle, if the profile built an
 *   engine.
 * @returns The session runtime; it ends with its scope.
 */
function createSessionRuntime(
  sessionID: string,
  loop: LoopSession | undefined,
): OpenCodeSessionState {
  let aborted = false;
  let echoMessageID: string | undefined;

  return {
    sessionID,
    loop,
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
 * The capability provision is created first: it builds the values the
 * assembly binds and asks the host what it will materialise.  The
 * composition service then assembles the active profile over it, and the
 * loop engine over the composed settle strategies.
 *
 * @param host - The host inputs the factories close over.
 * @returns The extension and session declarations, in creation order.
 */
export function createOpenCodeHostServices(host: OpenCodeServiceHost) {
  // The run scope of this plugin instance: one per runtime, over the run
  // table the whole process shares.  The runtime writes its runs through it,
  // so the plugin's dispose ends only the runs this runtime started.  A run a
  // panel translator wrote into the table is a host fact outside this scope,
  // so this stop never ends it.
  const runs = host.process.runs.createScope();

  // Declared FIRST so it is disposed LAST: this runtime's other services stop
  // before the runs they may still read end.
  const runScope = defineExtensionService({
    name: "runScope",
    deps: [],
    create: (): RunScope => runs,
    dispose: (scope) => scope.dispose(),
  });

  const capabilities = defineExtensionService({
    name: "capabilities",
    deps: [runScope],
    create: async ({ deps }): Promise<OpenCodeCapabilities> => {
      const resolveAgent = (sessionID: string): string | undefined =>
        host.process.sessionAgents.resolve(sessionID);
      // The gate's caller resolution is the registry read above, then the
      // host's own `session.get` — the SDK exposes no other access method.
      const resolveCallerAgent = (sessionID: string) =>
        resolveSessionAgent(sessionID, host.client, resolveAgent);
      // A disabled selection asks the host nothing, and an unreadable
      // config stays an unavailable fact — the planner closes this
      // configuration instead of treating "unknown" as "unconstrained".
      const materialisation =
        host.scope.snapshot.modeProfile === null
          ? undefined
          : await readHostMaterialisation(host.client);
      return {
        values: {
          ...configCapabilities(host.scope.snapshot),
          // The run records of this runtime: a host subagent driver writes
          // each delegation through this scope, so the plugin's dispose
          // ends only the runs this runtime started.
          runs: deps.runScope,
          contextRuntime: host.contextRuntime,
          // OpenCode serves the todo read from its SDK client; the
          // assembly is the single place that binds the backend.
          todoSource: todoSourceFromClient(host.client),
          directory: host.directory,
          zdebugExec: host.zdebugExec,
          resolveAgent,
          resolveCallerAgent,
          toolHost: createV1ToolHost(host.client, resolveAgent),
          adapter: createV1Adapter(),
          messageInjector: createOpenCodeMessageInjector(
            host.client,
            resolveAgent,
          ),
          // The `/go` handoff target.  Built from host facts only — the
          // executor agent travels with each handoff call, so the target
          // is the same for every selection.
          handoffTarget: createOpenCodeHandoffTarget(
            host.client,
            host.directory,
          ),
        },
        ...(materialisation === undefined ? {} : { materialisation }),
        resolveAgent,
        resolveCallerAgent,
      };
    },
  });

  // The assembled profile, produced by the shared composition service over
  // the capability provision and this generation's snapshot.
  const composition = defineCompositionService({
    scope: host.scope,
    capabilities,
    units: REGISTRY,
    // The product's orchestrator role.  The planner decides whether the
    // enabled profile can provide it; this host holds no fallback.
    orchestrator: ORCHESTRATOR_AGENT_NAME,
  });

  const loop = defineExtensionService({
    name: "loop",
    deps: [composition],
    create: ({ deps }) => {
      const strategies = deps.composition.composed.onSettled;
      return {
        // Fail-closed: a profile that contributes no settle strategy gets
        // no engine, so the settle path cannot wake anything.
        engine:
          strategies.length > 0 ? createLoopEngine([...strategies]) : undefined,
      };
    },
  });

  // The engine holds the strategies; the session scope owns the handle that
  // keeps this session's reminder budget and awaiting lock.  Both end with
  // the scope, so the engine keeps no state of its own.
  const sessionRuntime = defineSessionService({
    name: "sessionRuntime",
    deps: [loop],
    create: ({ deps, sessionID }) =>
      createSessionRuntime(
        sessionID,
        deps.loop.engine?.createSession(sessionID),
      ),
  });

  return {
    extension: [runScope, capabilities, composition, loop] as const,
    session: [
      sessionRuntime,
      defineSessionResourcesService(host.sessionCatalog),
    ] as const,
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
