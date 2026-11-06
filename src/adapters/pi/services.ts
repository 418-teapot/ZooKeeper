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
 *    baselines, the fleet surface, the switch surface, the composed
 *    profile and the loop engine built from it;
 *  - session-scope services are created lazily, once per session, and
 *    release their own resources: the session's entry in the session
 *    contexts, its todo store, its own fleet (widget, todo column, host
 *    writes), and its loop state (the engine's reminder budget and
 *    awaiting lock).
 *    The `sessionResources` service carries no state of its own: it applies
 *    this instance's record declarations (`core/session/resources.ts`,
 *    built from the instance's `ContextRuntime`) to the stopping scope, so a
 *    pi `session_shutdown` releases their runtime state while the persisted
 *    context and the agent bindings stay for the next runtime.
 *
 * A factory receives only the services it declares, so the dependency
 * direction is visible in the declarations: the tool host depends on the
 * session contexts, the switch surface depends on the session contexts,
 * the baselines and the fleet facade, and the session services depend on
 * the extension services they register with.  Nothing here reaches a
 * service locator, and the composition never receives a session-scoped
 * object: it receives these extension-scope ports.
 *
 * The switch handoff store stays process-level on purpose (see
 * `switch-host.ts`): a switch spans two factory executions, so its pending
 * operations cannot belong to one extension kernel.
 *
 * @module
 */

import { ASK_TOOL_NAME } from "../../core/ask.js";
import type { ComposedResult } from "../../core/compose.js";
import type { AgentModeMap, ModeProfile } from "../../core/config-types.js";
import type { ContextRuntime } from "../../core/context/runtime.js";
import {
  defineExtensionService,
  defineSessionService,
} from "../../core/lifecycle/index.js";
import {
  type BudgetStore,
  createLoopEngine,
  type LoopEngine,
} from "../../core/loop/index.js";
import type { AgentPermissionMap } from "../../core/permissions/deny-tools.js";
import type { SwitchHost } from "../../core/ports/switch.js";
import {
  defineSessionResourcesService,
  type SessionResourceCatalog,
} from "../../core/session/resources.js";
import type { RunSnapshot } from "../../core/subagent/registry.js";
import { subscribeRunChange } from "../../core/subagent/registry.js";
import type { FetchCandidates } from "../../core/todo/store.js";
import type { ValidationLimits } from "../../core/validate.js";
import { log } from "../../utils/logger.js";
import { createPiAdapter } from "./adapter.js";
import {
  createPiFleetSession,
  createPiFleetSessionRegistry,
  type PiFleetSession,
} from "./fleet-session.js";
import {
  createPiSessionContexts,
  type PiSessionContexts,
} from "./session-contexts.js";
import type { PiHistoryEntry } from "./subagent-scan.js";
import {
  createPiSwitchHost,
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
   * Take the pending post-replacement tool trim, or `undefined` when none
   * was queued.
   */
  drainPendingOps(): string[] | undefined;
}

/** The host inputs the service declarations close over. */
export interface PiServiceHost {
  /** The pi extension API, or undefined on a test-only composition. */
  readonly piApi?: ExtensionAPI;
  /** pi's `appendEntry` binding for the tool host's notifications. */
  readonly appendEntry?: PiAppendEntry;
  /**
   * Compose the active profile over the extension-scope ports.
   *
   * The composition reads services the kernel created, so it is the
   * `composition` service's factory: the loop engine that consumes its
   * settle strategies is a service of the same graph, created after it.
   */
  composeProfile(ports: PiCompositionPorts): PiContributions;
  /** The context records of this extension instance. */
  readonly contextRuntime: ContextRuntime;
  /** The session records of this extension instance. */
  readonly sessionCatalog: SessionResourceCatalog;
  /**
   * Test seam: the per-(session, strategy) reminder-budget store to
   * observe and seed.  Defaults to a fresh store when omitted.
   */
  readonly loopStore?: BudgetStore;
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
}

/** The composed profile and the facts the entry point reads from it. */
export interface PiContributions {
  /** The active mode profile, or `null` when the selection loaded none. */
  readonly profile: ModeProfile | null;
  /** The host-agnostic contributions of the selection. */
  readonly composed: ComposedResult;
  /** The parsed validation limits of the profile. */
  readonly limits: ValidationLimits;
  /** The per-agent mode map of the profile. */
  readonly agentModes: AgentModeMap;
  /** The per-agent tool-deny rules of the profile. */
  readonly agentPermissions: AgentPermissionMap;
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
  /** The context records of this extension instance. */
  readonly contextRuntime: ContextRuntime;
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
 * The facade is also the one subscriber to the run registry of this
 * extension instance: every run change repaints the fleet of the session
 * that owns the run, so no producer ever nudges a widget itself.
 */
function createPiFleetSurface(): PiFleetSurface {
  const sessions = createPiFleetSessionRegistry();
  const unsubscribe = subscribeRunChange((change) => {
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
    return { host: undefined, drainPendingOps: () => undefined };
  }
  const controller: PiSwitchHostController = createPiSwitchHost({
    getBaselineTools: () => deps.toolBaselines.primary(),
    setActiveTools: (names) => host.piApi?.setActiveTools?.(names),
    refreshFleetWidget: (sessionID) => deps.fleet.refresh(sessionID),
    getCommandCtx: (sessionID) =>
      deps.sessionContexts.commandForSession(sessionID),
    setContext: (sessionID, ctx) => deps.sessionContexts.bind(sessionID, ctx),
  });
  return {
    host: controller.host,
    drainPendingOps: controller.drainPendingOps,
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
    deps: [],
    create: () => createPiFleetSurface(),
    // A stopped extension must not repaint a widget: the subscription ends
    // with this scope.
    dispose: (surface) => surface.dispose(),
  });

  const switchHost = defineExtensionService({
    name: "switchHost",
    deps: [sessionContexts, toolBaselines, fleet],
    create: ({ deps }) => createPiSwitchSurface(host, deps),
  });

  // The composed profile.  It reads extension-scope ports only, so it is a
  // service like them: the entry point activates the extension to obtain it
  // instead of composing outside the graph.
  const composition = defineExtensionService({
    name: "composition",
    deps: [
      sessionContexts,
      adapter,
      toolHost,
      todo,
      profileCatalog,
      toolBaselines,
      fleet,
      switchHost,
    ],
    create: ({ deps }) => host.composeProfile(deps),
  });

  // The loop engine over the composed settle strategies.  A profile that
  // contributes none gets no engine (fail-closed: no settle judge, no wake).
  //
  // The session cap bounds the tracked sessions: pi fires no session-deletion
  // event, so a long-lived process would otherwise retain one budget entry
  // per session ever opened.  The engine evicts the oldest-inserted sessions
  // once the bound is exceeded (the budget is only ever a soft reminder
  // ceiling).
  const LOOP_SESSION_CAP = 100;
  const loop = defineExtensionService({
    name: "loop",
    deps: [composition],
    create: ({ deps }): { engine: LoopEngine | undefined } => {
      const strategies = deps.composition.composed.onSettled;
      if (strategies.length === 0) return { engine: undefined };
      return {
        engine: createLoopEngine([...strategies], {
          cap: LOOP_SESSION_CAP,
          ...(host.loopStore === undefined ? {} : { store: host.loopStore }),
        }),
      };
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
    deps: [fleet, sessionContexts, todoStore, composition],
    create: ({ deps, sessionID }) => {
      const session = createPiFleetSession({
        sessionID,
        // The session's own primary: the shared resolver answers for the
        // session this fleet belongs to, never for a sibling's.
        getPrimary: () => deps.composition.resolveAgent(sessionID),
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

  // The engine's per-session reminder budget and awaiting lock are the
  // session's own resources: every stop of the session resets them, in both
  // stop modes (a shutdown releases the runtime state, a deletion drops it).
  const loopSession = defineSessionService({
    name: "loopSession",
    deps: [loop],
    create: ({ deps, sessionID }) => ({ sessionID, engine: deps.loop.engine }),
    dispose: (session) => session.engine?.reset(session.sessionID),
  });

  return {
    extension: [
      sessionContexts,
      adapter,
      toolHost,
      todo,
      profileCatalog,
      toolBaselines,
      fleet,
      switchHost,
      composition,
      loop,
    ] as const,
    session: [
      sessionContext,
      todoStore,
      fleetSession,
      loopSession,
      defineSessionResourcesService(host.sessionCatalog),
    ] as const,
  };
}
