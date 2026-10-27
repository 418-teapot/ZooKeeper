/**
 * pi host services — the state owners of one pi extension instance.
 *
 * The entry point used to keep these as unnamed locals (the mutable context
 * holder, the per-instance todo store, the two tool baselines, the profile
 * skill list, the switch host), which meant the product composition had to
 * be handed session-scoped objects and a local variable had to be mutated
 * after composition for the subagent driver to see the profile.  They are
 * declared here as kernel services instead:
 *
 *  - extension-scope services are created once when the entry point
 *    activates the extension (before composition) and stopped by every path
 *    that stops it: the live context, the adapter built on it, the tool
 *    host built on it, the todo catalog, the profile catalog, the tool
 *    baselines, the fleet surface and the switch surface;
 *  - session-scope services are created lazily, once per session, and
 *    release their own resources: the session's entry in the live context,
 *    its todo store and its own fleet (widget, todo column, host writes).
 *
 * A factory receives only the services it declares, so the dependency
 * direction is visible in the declarations: the adapter and the tool host
 * depend on the live context (context holder → adapter → tool host), the
 * fleet facade depends on the live context, the switch surface depends on
 * the live context, the baselines and the fleet facade, and the session
 * services depend on the extension services they register with.  Nothing
 * here reaches a service locator, and the composition never receives a
 * session-scoped object: it receives these extension-scope ports.
 *
 * The switch handoff store stays process-level on purpose (see
 * `switch-host.ts`): a switch spans two factory executions, so its pending
 * operations cannot belong to one extension kernel.
 *
 * @module
 */

import {
  defineExtensionService,
  defineSessionService,
} from "../../core/lifecycle/index.js";
import type { SwitchHost } from "../../core/ports/switch.js";
import { getPrimary } from "../../core/subagent/identity.js";
import type { SubagentRun } from "../../core/subagent/registry.js";
import type { FetchCandidates } from "../../core/todo/store.js";
import { log } from "../../utils/logger.js";
import { createPiAdapter } from "./adapter.js";
import {
  createPiFleetSession,
  createPiFleetSessionRegistry,
  type PiFleetSession,
} from "./fleet-session.js";
import type { PiCommandCtx } from "./handoff-target.js";
import { createPiLiveContext, type PiLiveContext } from "./live-context.js";
import type { PiHistoryEntry } from "./subagent-scan.js";
import {
  createPiSwitchHost,
  type PiSwitchHostController,
} from "./switch-host.js";
import { scanTodoSnapshots } from "./todo-scan.js";
import { createPiTodoSessions } from "./todo-sessions.js";
import {
  createPiToolHost,
  type PiAppendEntry,
  type PiToolHostContext,
} from "./tool-host.js";
import type { ExtensionAPI } from "./types.js";

/**
 * The untrimmed tool baselines shared by the trim paths.
 *
 * pi forbids calling action methods (`getActiveTools`) during extension
 * loading, so each baseline is captured on FIRST USE and then cached: the
 * session-start trim, the switch command and the subagent capability
 * computation all address the same fixed set, so tool denies never
 * accumulate.  The two captures stay separate — the primary trim and the
 * subagent capability face are computed at different moments and one must
 * not make the other's capture stale.
 *
 * Once the extension stops, the port serves nothing: a stopped scope must
 * not hand out a baseline it captured earlier.
 */
export interface PiToolBaselines {
  /** The primary-trim baseline, captured on first use. */
  primary(): string[] | undefined;
  /** The subagent capability baseline, captured on first use. */
  subagent(): string[] | undefined;
  /** Drop both captures (the extension scope is stopping). */
  release(): void;
}

/**
 * Create the tool baseline port.
 *
 * @param piApi - The pi extension API, or undefined on a host without one
 *   (both baselines then read as unavailable).
 * @returns The baseline port.
 */
export function createPiToolBaselines(
  piApi: ExtensionAPI | undefined,
): PiToolBaselines {
  let primary: string[] | undefined;
  let subagent: string[] | undefined;
  let released = false;

  return {
    primary() {
      if (released) return undefined;
      if (primary === undefined) {
        // Copy the reported names: the baseline must stay frozen even if the
        // host hands back a live array that a later `setActiveTools` mutates.
        primary = piApi?.getActiveTools?.()?.slice();
      }
      return primary;
    },
    subagent() {
      if (released) return undefined;
      if (subagent === undefined) {
        // Same frozen copy as the primary baseline: a live array from the
        // host must not let a later `setActiveTools` move this baseline.
        subagent = piApi?.getActiveTools?.()?.slice();
      }
      return subagent;
    },
    release() {
      released = true;
      primary = undefined;
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
 * is what the entry point's nudges address, and it names sessions only by
 * id — an explicit id, or the session the current event names when the
 * caller omits one.  No session object is reachable from here, so a caller
 * can never hold one session's fleet.
 */
export interface PiFleetFacade {
  /** Re-render one session's widget (registry / primary change nudge). */
  refresh(sessionID?: string): void;
  /** Re-read one session's todo state and re-render its widget. */
  refreshTodoView(sessionID?: string): void;
  /** Seed one session's todo column once (the `before_agent_start` fallback). */
  seedTodoView(sessionID?: string): void;
  /**
   * Register one session's widget on that session's host writes.  An absent
   * or unknown id writes nothing.
   */
  register(sessionID?: string): void;
}

/**
 * The extension-scope fleet service.
 *
 * The facade plus the session-scope seam the `fleetSession` service uses to
 * bind and release a session's own fleet.
 */
export interface PiFleetSurface extends PiFleetFacade {
  /** Track one session scope's fleet. */
  attach(session: PiFleetSession): void;
  /** Release one session scope's fleet and stop routing to it. */
  detach(session: PiFleetSession): void;
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
  /** Apply and clear the pending post-replacement operations. */
  drainPendingOps(): void;
}

/** The host inputs the service declarations close over. */
export interface PiServiceHost {
  /** The pi extension API, or undefined on a test-only composition. */
  readonly piApi?: ExtensionAPI;
  /** pi's `appendEntry` binding for the tool host's notifications. */
  readonly appendEntry?: PiAppendEntry;
  /** Colorize an agent name per its configured `[agent.<name>].color`. */
  colorizeAgent(name: string): string;
  /** The overlay title for a run. */
  titleForRun(run: SubagentRun): string;
  /** The run's agent border colorizer, or undefined when unconfigured. */
  borderColorizeForRun(
    run: SubagentRun,
  ): ((text: string) => string) | undefined;
}

/** The todo transcript scan of pi's live session manager. */
function createTodoCandidates(liveContext: PiLiveContext): FetchCandidates {
  return async (sessionId) => {
    // Resolve the context of the session the CALLER named.  Reading the
    // latest published context instead would scan another session's
    // transcript whenever two sessions interleave, and a session this host
    // never observed has no transcript at all — fail closed (empty) rather
    // than borrowing one.
    const sessionManager = liveContext.forSession(sessionId)?.sessionManager;
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
 * Build the fleet facade over the live context.
 *
 * Routing is by session id only: the caller may name the session, otherwise
 * the session the current event names is used.  An id no session scope bound
 * writes nothing — the facade never falls back to another session's fleet.
 */
function createPiFleetSurface(deps: {
  readonly liveContext: PiLiveContext;
}): PiFleetSurface {
  const sessions = createPiFleetSessionRegistry();
  /** The session a call addresses: explicit id, or the current event's. */
  const route = (sessionID: string | undefined): string | undefined =>
    sessionID ?? deps.liveContext.sessionId();

  return {
    refresh: (sessionID) => sessions.refresh(route(sessionID)),
    refreshTodoView: (sessionID) => sessions.refreshTodoView(route(sessionID)),
    seedTodoView: (sessionID) => sessions.seedTodoView(route(sessionID)),
    register: (sessionID) => sessions.register(route(sessionID)),
    attach: (session) => sessions.bind(session),
    detach: (session) => sessions.release(session),
  };
}

/** Build the switch surface, closed when the host has no pi API. */
function createPiSwitchSurface(
  host: PiServiceHost,
  deps: {
    readonly liveContext: PiLiveContext;
    readonly toolBaselines: PiToolBaselines;
    readonly fleet: PiFleetFacade;
  },
): PiSwitchSurface {
  if (host.piApi === undefined) {
    // No host surface, no `/<agent>` command: the switch command unit
    // contributes nothing when this capability is absent (fail-closed).
    return { host: undefined, drainPendingOps: () => {} };
  }
  const controller: PiSwitchHostController = createPiSwitchHost({
    getBaselineTools: () => deps.toolBaselines.primary(),
    setActiveTools: (names) => host.piApi?.setActiveTools?.(names),
    refreshFleetWidget: () => deps.fleet.refresh(),
    getUi: () => deps.liveContext.current()?.ui,
    getCommandCtx: () => deps.liveContext.current() as PiCommandCtx | undefined,
    setContext: (ctx) => deps.liveContext.publish(ctx),
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
  const liveContext = defineExtensionService({
    name: "liveContext",
    deps: [],
    create: () => createPiLiveContext(),
    // A stopped extension has no live context: readers fail closed instead
    // of writing to a surface pi already replaced.
    dispose: (context) => context.release(),
  });

  const adapter = defineExtensionService({
    name: "adapter",
    deps: [liveContext],
    create: ({ deps }) => createPiAdapter(() => deps.liveContext.sessionId()),
  });

  const toolHost = defineExtensionService({
    name: "toolHost",
    deps: [liveContext],
    create: ({ deps }) =>
      createPiToolHost(
        // The holder the tool host reads is a view over the live context, so
        // the pointer keeps exactly one owner.
        {
          get current(): PiToolHostContext | undefined {
            return deps.liveContext.current();
          },
        },
        host.appendEntry,
      ),
  });

  const todo = defineExtensionService({
    name: "todo",
    deps: [liveContext],
    create: ({ deps }) =>
      createPiTodoSessions(createTodoCandidates(deps.liveContext)),
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
    deps: [liveContext],
    create: ({ deps }) => createPiFleetSurface(deps),
  });

  const switchHost = defineExtensionService({
    name: "switchHost",
    deps: [liveContext, toolBaselines, fleet],
    create: ({ deps }) => createPiSwitchSurface(host, deps),
  });

  // The session's entry in the live context.  Declared FIRST so it is
  // disposed LAST: the session's todo store and fleet read the context
  // indexed for this session, so it must outlive both of them.
  const sessionContext = defineSessionService({
    name: "sessionContext",
    deps: [liveContext],
    create: ({ deps, sessionID }) => ({
      release: () => deps.liveContext.releaseSession(sessionID),
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
  // extension-wide catalog), reads this session's `ui` out of the live
  // context, and is released with the session — a sibling session's widget
  // is untouched.
  const fleetSession = defineSessionService({
    name: "fleetSession",
    deps: [fleet, liveContext, todoStore],
    create: ({ deps, sessionID }) => {
      const session = createPiFleetSession({
        sessionID,
        getPrimary: () => getPrimary(),
        colorizeAgent: host.colorizeAgent,
        // Fail-closed: without a pi API instance there is no host to write
        // to, so the fleet stays inert.
        getUi: () =>
          host.piApi === undefined
            ? undefined
            : deps.liveContext.forSession(sessionID)?.ui,
        getEditorText: () =>
          deps.liveContext.forSession(sessionID)?.ui?.getEditorText?.() ?? "",
        titleForRun: host.titleForRun,
        borderColorizeForRun: host.borderColorizeForRun,
        // Read this session's `ui.custom` overlay opener fresh on each enter
        // (pi exposes it on every event context's `ui`).
        getOpenOverlay: () => {
          const ui = deps.liveContext.forSession(sessionID)?.ui;
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

  return {
    extension: [
      liveContext,
      adapter,
      toolHost,
      todo,
      profileCatalog,
      toolBaselines,
      fleet,
      switchHost,
    ] as const,
    session: [sessionContext, todoStore, fleetSession] as const,
  };
}
