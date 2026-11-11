/**
 * pi host services — the state owners of one pi extension instance.
 *
 * The entry point used to keep these as unnamed locals (the mutable context
 * holder, the per-instance todo store, the tool baselines, the profile
 * skill list, the switch host), which meant the product composition had to
 * be handed session-scoped objects and a local variable had to be mutated
 * after composition for the subagent driver to see the profile.  They are
 * declared here as kernel services instead:
 *
 *  - extension-scope services are created once when the entry point
 *    activates the extension (before composition) and stopped by every path
 *    that stops it: the session contexts, the adapter, the tool host built
 *    on the contexts, the todo catalog, the profile catalog, the tool
 *    baselines, the fleet surface, the switch surface, the capability
 *    provision, the assembled profile and the loop engine built from it;
 *  - the `runScope` service is the run scope of this runtime: it reads the
 *    process run table and owns the runs this runtime started, so the
 *    runtime's stop ends only those.  It is declared first, so it is
 *    disposed last, after every run-change subscriber released its
 *    subscription;
 *  - session-scope services are created lazily, once per session, and
 *    release their own resources: the session's entry in the session
 *    contexts, its todo store, its own fleet (widget, todo column, host
 *    writes), its loop handle (the session's reminder budget and awaiting
 *    lock), and its settle bookkeeping (the open blocking prompt count and
 *    the last finished run's messages).
 *    The `sessionResources` service carries no state of its own: it applies
 *    this instance's record declarations (`core/session/resources.ts`,
 *    built from the instance's `ContextRuntime`) to the stopping scope, so a
 *    pi `session_shutdown` releases their runtime state while the persisted
 *    context and the agent bindings stay for the next runtime.
 *
 * A factory receives only the services it declares, so the dependency
 * direction is visible in the declarations: the tool host depends on the
 * session contexts, the switch surface depends on the session contexts,
 * the baselines and the fleet facade, the capability provision on the
 * ports it reads, the composition on the provision, and the session
 * services on the extension services they register with.  Nothing here
 * reaches a service locator, and the composition never receives a
 * session-scoped object: it receives the extension-scope ports.
 *
 * The switch handoff store is process-level on purpose (see
 * `switch-host.ts`): a switch spans two factory executions, so its pending
 * operations belong to the pi process owner, not to one extension kernel.
 *
 * @module
 */

import { ASK_TOOL_NAME } from "../../core/ask.js";
import type { HostCapabilities } from "../../core/composition.js";
import { defineCompositionService } from "../../core/composition.js";
import type { ContextRuntime } from "../../core/context/runtime.js";
import {
  defineExtensionService,
  defineSessionService,
} from "../../core/lifecycle/index.js";
import {
  createLoopEngine,
  type LoopEngine,
  type LoopSession,
} from "../../core/loop/index.js";
import { ORCHESTRATOR_AGENT_NAME } from "../../core/orchestrator.js";
import type { SwitchHost } from "../../core/ports/switch.js";
import {
  defineSessionResourcesService,
  type SessionResourceCatalog,
} from "../../core/session/resources.js";
import type {
  RunRegistry,
  RunScope,
  RunSnapshot,
} from "../../core/subagent/registry.js";
import type { FetchCandidates } from "../../core/todo/store.js";
import { REGISTRY } from "../../registry.js";
import { log } from "../../utils/logger.js";
import { createPiAdapter } from "./adapter.js";
import type { PiProcessScope } from "./config.js";
import {
  createPiFleetSession,
  createPiFleetSessionRegistry,
  type PiFleetSession,
} from "./fleet-session.js";
import type { PiProcessState } from "./process.js";
import {
  createPiSessionContexts,
  type PiSessionContexts,
} from "./session-contexts.js";
import type { PiHistoryEntry } from "./subagent-scan.js";
import {
  createPiSwitchHost,
  type PiSessionStartFacts,
  type PiSwitchHostController,
} from "./switch-host.js";
import { scanTodoSnapshots } from "./todo-scan.js";
import { createPiTodoSessions } from "./todo-sessions.js";
import { createPiToolHost, type PiAppendEntry } from "./tool-host.js";
import type { ExtensionAPI } from "./types.js";

/**
 * The untrimmed tool baselines shared by the trim paths.
 *
 * pi forbids calling action methods (`getActiveTools`) during extension
 * loading, so the baseline is captured on FIRST USE and then cached: the
 * session-start trim, the switch command and the subagent capability
 * computation all address the same fixed set, so tool denies never
 * accumulate.
 *
 * Both faces read ONE capture.  The subagent face must not depend on the
 * moment of its first use: a separate capture would observe the
 * main-session face already trimmed by the primary's denies and ask
 * visibility, and the caller's denies would then leak into every
 * sub-session.  The subagent face further drops `ask`: an SDK sub-session
 * has no event context that yields a question channel.
 *
 * Once the extension stops, the port serves nothing: a stopped scope must
 * not hand out a baseline it captured earlier.
 */
export interface PiToolBaselines {
  /** The shared untrimmed baseline, captured on first use. */
  primary(): string[] | undefined;
  /** The subagent capability baseline: the shared baseline minus `ask`. */
  subagent(): string[] | undefined;
  /** Drop the captures (the extension scope is stopping). */
  release(): void;
}

/**
 * Create the tool baseline port.
 *
 * @param piApi - The pi extension API, or undefined on a host without one
 *   (both faces then read as unavailable).
 * @returns The baseline port.
 */
export function createPiToolBaselines(
  piApi: ExtensionAPI | undefined,
): PiToolBaselines {
  let shared: string[] | undefined;
  let subagent: string[] | undefined;
  let released = false;

  // Copy the reported names: the baseline must stay frozen even if the host
  // hands back a live array that a later `setActiveTools` mutates.
  const capture = (): string[] | undefined => {
    if (shared === undefined) {
      shared = piApi?.getActiveTools?.()?.slice();
    }
    return shared;
  };

  return {
    primary() {
      return released ? undefined : capture();
    },
    subagent() {
      if (released) return undefined;
      if (subagent === undefined) {
        const baseline = capture();
        if (baseline === undefined) return undefined;
        subagent = baseline.filter((tool) => tool !== ASK_TOOL_NAME);
      }
      return subagent;
    },
    release() {
      released = true;
      shared = undefined;
      subagent = undefined;
    },
  };
}

/**
 * The composed profile's skill directory names, published after composition.
 *
 * The subagent driver reads them per run (a sub-session may start long
 * after composition) and `resources_discover` reads them per bind, so both
 * consume one published value instead of a mutable local in the entry
 * point.  Release is terminal: a stopped extension serves no profile, and a
 * late publication must not revive one.
 */
export interface PiProfileCatalog {
  /** Publish the composed profile's skill directory names. */
  publish(names: readonly string[]): void;
  /** A copy of the published names (empty before composition). */
  get(): string[];
  /** Drop the publication (the extension scope is stopping). */
  release(): void;
}

/**
 * Create the profile catalog.
 *
 * @returns The catalog the composition publishes into and both consumers
 *   read.
 */
export function createPiProfileCatalog(): PiProfileCatalog {
  let published: string[] = [];
  let released = false;

  return {
    publish(names) {
      // A stopped extension has no profile: drop the publication instead of
      // reviving a consumer's view of it.
      if (released) return;
      published = [...names];
    },
    get() {
      // A copy: a consumer that mutates the list it received must not change
      // what the other consumer reads.
      return [...published];
    },
    release() {
      released = true;
      published = [];
    },
  };
}

/**
 * One session's settle bookkeeping.
 *
 * The loop settle reads two facts about the run it judges: whether a
 * blocking UI prompt is open (a run behind one waits on the user, so it is
 * not finished) and the terminal messages of the run that just ended (pi's
 * pre-settle boundary carries no transcript).  Both belong to one session,
 * so two sessions settling at once never read each other's entry.
 *
 * A stopped scope serves nothing: the fields go with the scope, and a
 * retained reference cannot revive them.
 */
export interface PiSettleState {
  /** Count one open blocking UI prompt. */
  enterPrompt(): void;
  /** Count one closed blocking UI prompt (the count never goes below zero). */
  leavePrompt(): void;
  /** Drop the count (a real session start re-bound the session). */
  resetPrompt(): void;
  /** Whether a blocking UI prompt is open. */
  awaitingInput(): boolean;
  /** Record the finished run's terminal messages. */
  recordRun(messages: readonly unknown[]): void;
  /** The last finished run's terminal messages (empty before one). */
  lastRun(): readonly unknown[];
  /** Drop the bookkeeping (the session scope is stopping). */
  release(): void;
}

/**
 * Create one session's settle bookkeeping.
 *
 * @returns The state the settle handlers of that session read and write.
 */
export function createPiSettleState(): PiSettleState {
  let promptDepth = 0;
  let lastRun: readonly unknown[] = [];
  let released = false;

  return {
    enterPrompt() {
      if (released) return;
      promptDepth += 1;
    },
    leavePrompt() {
      if (released) return;
      if (promptDepth > 0) promptDepth -= 1;
    },
    resetPrompt() {
      if (released) return;
      promptDepth = 0;
    },
    awaitingInput() {
      return promptDepth > 0;
    },
    recordRun(messages) {
      if (released) return;
      lastRun = messages;
    },
    lastRun() {
      return lastRun;
    },
    release() {
      released = true;
      promptDepth = 0;
      lastRun = [];
    },
  };
}

/** The declaration of one session's settle bookkeeping. */
export const piSettleStateService = defineSessionService({
  name: "settleState",
  deps: [],
  create: () => createPiSettleState(),
  dispose: (state) => state.release(),
});

/**
 * One session's loop-facing services, as an event handler receives them.
 *
 * The projection carries the services of the session the admitted work
 * runs for, so a handler never holds another session's state.
 */
export interface PiSessionServices {
  /** The session's settle bookkeeping. */
  readonly settle: PiSettleState;
  /**
   * The session's loop handle, or `undefined` when the profile composed no
   * settle strategy (fail-closed: no settle judge, no wake).
   */
  readonly loop: LoopSession | undefined;
}

/**
 * The `zoo` fleet nudges of one extension instance.
 *
 * The fleet itself is per session (see `fleet-session.ts`): each session
 * scope owns its widget, its todo column and its host writes.  This facade
 * is what the entry point's nudges address, and every call names its
 * session explicitly — no session object is reachable from here, so a
 * caller can never hold one session's fleet.  An absent or unknown id
 * writes nothing.
 */
export interface PiFleetFacade {
  /** Re-render one session's widget (registry / primary change nudge). */
  refresh(sessionID: string | undefined): void;
  /** Re-read one session's todo state and re-render its widget. */
  refreshTodoView(sessionID: string | undefined): void;
  /** Seed one session's todo column once (the `before_agent_start` fallback). */
  seedTodoView(sessionID: string | undefined): void;
  /** Register one session's widget on that session's host writes. */
  register(sessionID: string | undefined): void;
}

/**
 * The extension-scope fleet service.
 *
 * The facade plus the session-scope seam the `fleetSession` service uses to
 * bind and release a session's own fleet.  The surface owns the one
 * subscription to the run registry: a run change repaints the fleet of the
 * session the run belongs to, and the extension stop removes it.
 */
export interface PiFleetSurface extends PiFleetFacade {
  /** Track one session scope's fleet. */
  attach(session: PiFleetSession): void;
  /** Release one session scope's fleet and stop routing to it. */
  detach(session: PiFleetSession): void;
  /** Remove the run-change subscription (the extension scope is stopping). */
  dispose(): void;
}

/**
 * The `/<agent>` switch surface of one extension instance.
 *
 * The host is absent without a pi API instance, which is how the switch
 * command unit stays unregistered on such a host (fail-closed).
 */
export interface PiSwitchSurface {
  /** The composition's switch port, or undefined without a pi API. */
  readonly host: SwitchHost | undefined;
  /**
   * Claim the pending replacement for one `session_start`.
   *
   * The facts are the evidence the start carries: pi's reason and the
   * replaced session it recorded on the new session's header.  Only the
   * pending replacement's own new session claims the target; every other
   * start claims nothing.
   */
  claimPending(sessionID: string, facts: PiSessionStartFacts): void;
  /**
   * Take one claimed session's post-replacement tool trim, or `undefined`
   * when that session holds none.
   */
  drainPendingOps(sessionID: string): string[] | undefined;
}

/** The host inputs the service declarations close over. */
export interface PiServiceHost {
  /** The configuration generation of this extension instance. */
  readonly scope: PiProcessScope;
  /**
   * The process state this instance runs over: the state every generation
   * of this process shares.
   */
  readonly process: PiProcessState;
  /** The pi extension API, or undefined on a test-only composition. */
  readonly piApi?: ExtensionAPI;
  /** pi's `appendEntry` binding for the tool host's notifications. */
  readonly appendEntry?: PiAppendEntry;
  /**
   * Build this instance's capability provision over its extension-scope
   * ports.
   *
   * The provision is a service the kernel creates; the composition service
   * depends on it and assembles the profile from it.  The loop engine that
   * consumes the composed settle strategies is a service of the same graph,
   * created after the composition.
   */
  capabilities(ports: PiCompositionPorts): PiCapabilities;
  /** The context records of this extension instance. */
  readonly contextRuntime: ContextRuntime;
  /** The session records of this extension instance. */
  readonly sessionCatalog: SessionResourceCatalog;
  /** Colorize an agent name per its configured `[agent.<name>].color`. */
  colorizeAgent(name: string): string;
  /** The overlay title for a run. */
  titleForRun(run: RunSnapshot): string;
  /** The run's agent border colorizer, or undefined when unconfigured. */
  borderColorizeForRun(
    run: RunSnapshot,
  ): ((text: string) => string) | undefined;
}

/** The extension-scope services the composed profile reads. */
export interface PiCompositionPorts {
  /** The extension-scope session contexts. */
  readonly sessionContexts: PiSessionContexts;
  /** The host adapter (it names no session of its own). */
  readonly adapter: ReturnType<typeof createPiAdapter>;
  /** The tool host built on the session contexts. */
  readonly toolHost: ReturnType<typeof createPiToolHost>;
  /** The todo catalog restoring each session's plan. */
  readonly todo: ReturnType<typeof createPiTodoSessions>;
  /** The published profile skill directories. */
  readonly profileCatalog: PiProfileCatalog;
  /** The untrimmed tool baselines. */
  readonly toolBaselines: PiToolBaselines;
  /** The fleet facade of this extension instance. */
  readonly fleet: PiFleetFacade;
  /** The `/<agent>` switch surface. */
  readonly switchHost: PiSwitchSurface;
  /**
   * The run scope of this runtime.
   *
   * The subagent tool writes every delegation through it, so the runtime's
   * stop ends exactly the runs this runtime started.
   */
  readonly runScope: RunScope;
}

/**
 * The capability provision of one pi extension instance.
 *
 * The shared composition service consumes the provision (`values`).  The
 * session resolvers travel with it because the wiring reads the same
 * functions the composition bound: both are built once per runtime and
 * read every session the same way.
 */
export interface PiCapabilities extends HostCapabilities {
  /**
   * The session → agent resolver of this runtime.
   *
   * Event handlers read it synchronously with the session the event names;
   * the answer comes from explicit sources only (see
   * `buildPiResolveAgent`).
   */
  readonly resolveAgent: (sessionID: string) => string | undefined;
  /** The caller resolver the delegation gate reads (same resolver). */
  readonly resolveCallerAgent: (
    sessionID: string,
  ) => Promise<string | undefined>;
}

/** The todo transcript scan of pi's live session manager. */
function createTodoCandidates(
  sessionContexts: PiSessionContexts,
): FetchCandidates {
  return async (sessionId) => {
    // Resolve the context of the session the CALLER named.  Reading another
    // session's context would scan its transcript whenever two sessions
    // interleave, and a session this host never observed has no transcript
    // at all — fail closed (empty) rather than borrowing one.
    const sessionManager =
      sessionContexts.forSession(sessionId)?.sessionManager;
    if (sessionManager?.getBranch === undefined) return [];
    try {
      // `getBranch` (not `buildContextEntries`): the raw entries of the
      // active branch INCLUDING pre-compaction ones, so a cache miss after a
      // compaction still finds the last snapshot.  It MUST be called as a
      // method on the session manager (an extracted reference unbinds
      // `this` and crashes).
      return scanTodoSnapshots(sessionManager.getBranch() as PiHistoryEntry[]);
    } catch (err) {
      // A throwing read is logged and rethrown: the store's
      // no-cache-on-failure policy owns the semantics, so a transient error
      // must not be cached as empty.
      log.warn({
        hook: "plugin",
        event: "todo_history_failed",
        error: String(err),
      });
      throw err;
    }
  };
}

/**
 * Build the fleet facade.
 *
 * Routing is by session id only, and the id is always the caller's: an id
 * no session scope bound writes nothing, so the facade never falls back to
 * another session's fleet.
 *
 * The facade is also the one subscriber to this process's run registry:
 * every run change repaints the fleet of the session that owns the run, so
 * no producer ever nudges a widget itself.
 *
 * @param runs - The run records of this process.
 * @returns The fleet surface, closed over the subscription.
 */
function createPiFleetSurface(runs: RunRegistry): PiFleetSurface {
  const sessions = createPiFleetSessionRegistry();
  const unsubscribe = runs.subscribe((change) => {
    sessions.refresh(change.parentSession);
  });

  return {
    refresh: (sessionID) => sessions.refresh(sessionID),
    refreshTodoView: (sessionID) => sessions.refreshTodoView(sessionID),
    seedTodoView: (sessionID) => sessions.seedTodoView(sessionID),
    register: (sessionID) => sessions.register(sessionID),
    attach: (session) => sessions.bind(session),
    detach: (session) => sessions.release(session),
    dispose: () => unsubscribe(),
  };
}

/** Build the switch surface, closed when the host has no pi API. */
function createPiSwitchSurface(
  host: PiServiceHost,
  deps: {
    readonly sessionContexts: PiSessionContexts;
    readonly toolBaselines: PiToolBaselines;
    readonly fleet: PiFleetFacade;
  },
): PiSwitchSurface {
  if (host.piApi === undefined) {
    // No host surface, no `/<agent>` command: the switch command unit
    // contributes nothing when this capability is absent (fail-closed).
    return {
      host: undefined,
      claimPending: () => {},
      drainPendingOps: () => undefined,
    };
  }
  const controller: PiSwitchHostController = createPiSwitchHost(
    {
      getBaselineTools: () => deps.toolBaselines.primary(),
      setActiveTools: (names) => host.piApi?.setActiveTools?.(names),
      refreshFleetWidget: (sessionID) => deps.fleet.refresh(sessionID),
      getCommandCtx: (sessionID) =>
        deps.sessionContexts.commandForSession(sessionID),
      setContext: (sessionID, ctx) => deps.sessionContexts.bind(sessionID, ctx),
    },
    host.process,
  );
  return {
    host: controller.host,
    claimPending: (sessionID, facts) =>
      controller.claimPending(sessionID, facts),
    drainPendingOps: (sessionID) => controller.drainPendingOps(sessionID),
  };
}

/**
 * Create the service declarations of one pi extension instance.
 *
 * The declarations close over the host inputs (the pi API, the colorizer
 * helpers); everything else is a declared dependency, so the kernel builds
 * the graph.  The returned tuples are also what the typed lifecycle wiring
 * is parameterised over, so the entry point reads the activated services
 * without casting.
 *
 * @param host - The host inputs the factories close over.
 * @returns The extension and session declarations, in creation order.
 */
export function createPiHostServices(host: PiServiceHost) {
  // The run scope of this runtime: one per configuration generation and per
  // pi sub-session runtime, over the run table the whole process shares.  The
  // runtime writes through it, so its stop ends only the runs it started.
  const runs = host.process.runs.createScope();

  // Declared FIRST so it is disposed LAST: the fleet subscribers stop
  // before the stop aborts the runs they would otherwise repaint.
  const runScope = defineExtensionService({
    name: "runScope",
    deps: [],
    create: () => runs,
    dispose: (scope) => scope.dispose(),
  });

  const sessionContexts = defineExtensionService({
    name: "sessionContexts",
    deps: [],
    create: () => createPiSessionContexts(),
    // A stopped extension has no session contexts: readers fail closed
    // instead of writing to a surface pi already replaced.
    dispose: (contexts) => contexts.release(),
  });

  const adapter = defineExtensionService({
    name: "adapter",
    deps: [],
    // The pi adapter names no session of its own: the entry paths pass the
    // session id to the transform.
    create: () => createPiAdapter(),
  });

  const toolHost = defineExtensionService({
    name: "toolHost",
    deps: [sessionContexts],
    create: ({ deps }) =>
      // The toast port resolves the ui of the session it serves; the session
      // contexts are its one owner.
      createPiToolHost(deps.sessionContexts, host.appendEntry),
  });

  const todo = defineExtensionService({
    name: "todo",
    deps: [sessionContexts],
    create: ({ deps }) =>
      createPiTodoSessions(createTodoCandidates(deps.sessionContexts)),
    // Sessions stop before their extension, so their stores are already
    // released; this drops any leftover registration.
    dispose: (sessions) => sessions.release(),
  });

  const profileCatalog = defineExtensionService({
    name: "profileCatalog",
    deps: [],
    create: () => createPiProfileCatalog(),
    dispose: (catalog) => catalog.release(),
  });

  const toolBaselines = defineExtensionService({
    name: "toolBaselines",
    deps: [],
    create: () => createPiToolBaselines(host.piApi),
    dispose: (baselines) => baselines.release(),
  });

  const fleet = defineExtensionService({
    name: "fleet",
    deps: [runScope],
    create: ({ deps }) => createPiFleetSurface(deps.runScope),
    // A stopped extension must not repaint a widget: the subscription ends
    // with this scope.
    dispose: (surface) => surface.dispose(),
  });

  const switchHost = defineExtensionService({
    name: "switchHost",
    deps: [sessionContexts, toolBaselines, fleet],
    create: ({ deps }) => createPiSwitchSurface(host, deps),
  });

  // The capability provision of this instance: the values the shared
  // composition service binds.  It is a service so every consumer of the
  // assembly reads the same provision, and so the assembly is created
  // inside the graph rather than before it.
  const capabilities = defineExtensionService({
    name: "capabilities",
    deps: [
      sessionContexts,
      adapter,
      toolHost,
      todo,
      profileCatalog,
      toolBaselines,
      fleet,
      switchHost,
      runScope,
    ],
    create: ({ deps }) => host.capabilities(deps),
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

  // The loop engine over the composed settle strategies.  A profile that
  // contributes none gets no engine (fail-closed: no settle judge, no wake).
  //
  // The engine holds the strategies only: each session scope owns the
  // handle that keeps its reminder budget and awaiting lock, so the engine
  // retains no per-session entry and needs no session cap.
  const loop = defineExtensionService({
    name: "loop",
    deps: [composition],
    create: ({ deps }): { engine: LoopEngine | undefined } => {
      const strategies = deps.composition.composed.onSettled;
      if (strategies.length === 0) return { engine: undefined };
      return { engine: createLoopEngine([...strategies]) };
    },
  });

  // The session's entry in the session contexts.  Declared FIRST so it is
  // disposed LAST: the session's todo store and fleet read the context
  // bound for this session, so it must outlive both of them.
  const sessionContext = defineSessionService({
    name: "sessionContext",
    deps: [sessionContexts],
    create: ({ deps, sessionID }) => ({
      release: () => deps.sessionContexts.releaseSession(sessionID),
    }),
    dispose: (owner) => owner.release(),
  });

  const todoStore = defineSessionService({
    name: "todoStore",
    deps: [todo],
    create: ({ deps, sessionID }) => deps.todo.own(sessionID),
    dispose: (handle) => handle.dispose(),
  });

  // The session's own fleet: its widget, its todo column and its host
  // writes.  It depends on this session's todo store (never the
  // extension-wide catalog), reads this session's `ui` out of the session
  // contexts, and is released with the session — a sibling session's widget
  // is untouched.
  const fleetSession = defineSessionService({
    name: "fleetSession",
    deps: [fleet, sessionContexts, todoStore, capabilities, runScope],
    create: ({ deps, sessionID }) => {
      const session = createPiFleetSession({
        sessionID,
        runs: deps.runScope,
        // The session's own primary: the shared resolver answers for the
        // session this fleet belongs to, never for a sibling's.
        getPrimary: () => deps.capabilities.resolveAgent(sessionID),
        colorizeAgent: host.colorizeAgent,
        // Fail-closed: without a pi API instance there is no host to write
        // to, so the fleet stays inert.
        getUi: () =>
          host.piApi === undefined
            ? undefined
            : deps.sessionContexts.forSession(sessionID)?.ui,
        getEditorText: () =>
          deps.sessionContexts.forSession(sessionID)?.ui?.getEditorText?.() ??
          "",
        titleForRun: host.titleForRun,
        borderColorizeForRun: host.borderColorizeForRun,
        // Read this session's `ui.custom` overlay opener fresh on each enter
        // (pi exposes it on every event context's `ui`).
        getOpenOverlay: () => {
          const ui = deps.sessionContexts.forSession(sessionID)?.ui;
          if (ui?.custom === undefined) return undefined;
          return ui.custom.bind(ui);
        },
        // Without a pi API instance the todo column stays off: the host
        // cannot restore state and never registers the todo tool either.
        ...(host.piApi === undefined
          ? {}
          : { todoStore: deps.todoStore.store }),
      });
      deps.fleet.attach(session);
      return {
        session,
        dispose: () => deps.fleet.detach(session),
      };
    },
    dispose: (service) => service.dispose(),
  });

  // The session's loop handle: its reminder budget and awaiting lock.  The
  // handle belongs to this scope, so its state ends with the scope and no
  // disposer has to reset a shared store.
  const loopSession = defineSessionService({
    name: "loopSession",
    deps: [loop],
    create: ({ deps, sessionID }) => deps.loop.engine?.createSession(sessionID),
  });

  return {
    extension: [
      runScope,
      sessionContexts,
      adapter,
      toolHost,
      todo,
      profileCatalog,
      toolBaselines,
      fleet,
      switchHost,
      capabilities,
      composition,
      loop,
    ] as const,
    session: [
      sessionContext,
      todoStore,
      fleetSession,
      loopSession,
      piSettleStateService,
      defineSessionResourcesService(host.sessionCatalog),
    ] as const,
  };
}
