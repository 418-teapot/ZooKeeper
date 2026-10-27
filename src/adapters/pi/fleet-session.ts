/**
 * pi session-scoped fleet — one session's widget, its todo column and its
 * host writes.
 *
 * The `zoo` fleet widget is a component factory plus its todo column, and
 * the host writes it needs (`setWidget` above the editor, the terminal-input
 * listener) belong to exactly one session.  pi can hold several session
 * scopes at once — a reloaded session overlapping its predecessor, a
 * replayed start for a resumed one — so the whole fleet is created per
 * session scope here: its own wiring (widget, todo view caches, overlay
 * state), its own todo store, and its own resource object for the host
 * writes.  One session therefore can never render, refresh or release
 * another session's widget.
 *
 * {@link createPiFleetSessionRegistry} is the extension-scope router: it
 * keys every session's fleet by the session id the lifecycle kernel used to
 * create the scope, so a call that names a session reaches that session's
 * fleet and an unknown id reaches nothing (fail closed — never "whichever
 * session was created last").
 *
 * Registration itself stays idempotent: pi replays `session_start` after a
 * reload / resume, so re-registering must re-seed the widget without
 * stacking a second listener.
 *
 * @module
 */

import type { SubagentRun } from "../../core/subagent/registry.js";
import type { TodoStateStore } from "../../core/todo/store.js";
import type { PiToolHostContext } from "./tool-host.js";
import type { FleetWidget } from "./tui/widget.js";
import { createFleetWiring } from "./tui/wiring.js";

/** The pi `ui` surface the fleet resources write to. */
export type PiFleetUi = NonNullable<PiToolHostContext["ui"]>;

/** The live host surfaces one session's fleet resources write to. */
export interface PiFleetSessionHost {
  /** The fleet widget the session binds (owned by the same scope). */
  readonly widget: FleetWidget;
  /** The active primary, or undefined when the machinery is off. */
  getPrimary(): string | undefined;
  /** This session's pi `ui` surface, or undefined before a context arrives. */
  getUi(): PiFleetUi | undefined;
}

/** One session's host-write resources. */
export interface PiFleetSessionResources {
  /** Bind the widget and its listener to the current host `ui`. */
  register(): void;
  /** Release the listener and the widget; further registrations no-op. */
  dispose(): void;
}

/**
 * One session's fleet: widget, todo column and host writes.
 *
 * Created by the session scope's `fleetSession` service, which releases it
 * when that session (or its extension) stops.
 */
export interface PiFleetSession {
  /** The session this fleet belongs to. */
  readonly sessionID: string;
  /** Bind this session's widget and listener to its host `ui`. */
  register(): void;
  /** Re-render this session's widget (registry / primary change nudge). */
  refresh(): void;
  /** Re-read this session's todo state and re-render its widget. */
  refreshTodoView(): void;
  /** Seed this session's todo column once (the startup fallback). */
  seedTodoView(): void;
  /** Release this session's listener and widget; further calls no-op. */
  dispose(): void;
}

/** The surfaces one session's fleet wiring reads. */
export interface PiFleetSessionDeps {
  /** The session this fleet belongs to. */
  readonly sessionID: string;
  /** The active primary agent name, or undefined when none. */
  getPrimary(): string | undefined;
  /** Colorize an agent name per its configured `[agent.<name>].color`. */
  colorizeAgent(name: string): string;
  /** This session's pi `ui` surface, or undefined when none is live. */
  getUi(): PiFleetUi | undefined;
  /** This session's pi editor text (guards the collapsed-key activation). */
  getEditorText(): string;
  /** The overlay title for a run (`<agent> · <label>`, colorized). */
  titleForRun(run: SubagentRun): string;
  /** The run's agent border colorizer, or undefined when unconfigured. */
  borderColorizeForRun(
    run: SubagentRun,
  ): ((text: string) => string) | undefined;
  /** This session's `ui.custom` overlay opener, or undefined when absent. */
  getOpenOverlay():
    | ((factory: unknown, options: unknown) => unknown)
    | undefined;
  /** This session's todo store, or undefined when the host has none. */
  todoStore?: TodoStateStore;
}

/**
 * The live fleets of every session, routed by session id.
 *
 * A host instance can hold more than one live session, so a single
 * "current" fleet pointer would let one session register through — or
 * release — another session's widget.  Routing is therefore keyed by the
 * session id the kernel used to create the scope.
 */
export interface PiFleetSessionRegistry {
  /**
   * Track one session's fleet.
   *
   * Re-binding the same id replaces the previous entry, which is how a
   * recreated scope takes its own id over.
   */
  bind(session: PiFleetSession): void;
  /** Release one session's fleet and stop routing to it. */
  release(session: PiFleetSession): void;
  /** Re-seed the widget of one session (unknown ids write nothing). */
  register(sessionID: string | undefined): void;
  /** Re-render the widget of one session. */
  refresh(sessionID: string | undefined): void;
  /** Re-read the todo view of one session. */
  refreshTodoView(sessionID: string | undefined): void;
  /** Seed the todo view of one session. */
  seedTodoView(sessionID: string | undefined): void;
}

/** Empty and absent ids both mean "no session". */
function normalizeSessionID(sessionID: string | undefined): string | null {
  if (typeof sessionID !== "string") return null;
  return sessionID.trim() === "" ? null : sessionID;
}

/**
 * Create the session-id routed fleet registry.
 *
 * @returns The registry the session services bind their fleets into.
 */
export function createPiFleetSessionRegistry(): PiFleetSessionRegistry {
  const live = new Map<string, PiFleetSession>();

  /** The fleet of one session, or undefined for an unusable id. */
  const route = (sessionID: string | undefined): PiFleetSession | undefined => {
    const id = normalizeSessionID(sessionID);
    if (id === null) return undefined;
    return live.get(id);
  };

  return {
    bind(session) {
      live.set(session.sessionID, session);
    },
    release(session) {
      // Drop only the entry this scope still owns: a replaced or sibling
      // session's fleet must survive another scope's teardown.
      if (live.get(session.sessionID) === session) {
        live.delete(session.sessionID);
      }
      session.dispose();
    },
    register(sessionID) {
      route(sessionID)?.register();
    },
    refresh(sessionID) {
      route(sessionID)?.refresh();
    },
    refreshTodoView(sessionID) {
      route(sessionID)?.refreshTodoView();
    },
    seedTodoView(sessionID) {
      route(sessionID)?.seedTodoView();
    },
  };
}

/**
 * Create the fleet of one session scope.
 *
 * The wiring is created per session on purpose: the widget's todo view
 * caches, the deferred overlay opens and the collapse state are that
 * session's own, so two live sessions cannot overwrite each other's view.
 *
 * @param deps - The session's own host surfaces and todo store.
 * @returns The session's fleet, released by its scope's disposer.
 */
export function createPiFleetSession(deps: PiFleetSessionDeps): PiFleetSession {
  const wiring = createFleetWiring({
    getPrimary: deps.getPrimary,
    colorizeAgent: deps.colorizeAgent,
    // The widget belongs to this session, so its scopes registry and todo
    // queries name this session only.
    getSessionId: () => deps.sessionID,
    getEditorText: deps.getEditorText,
    titleForRun: deps.titleForRun,
    borderColorizeForRun: deps.borderColorizeForRun,
    getOpenOverlay: deps.getOpenOverlay,
    ...(deps.todoStore === undefined ? {} : { todoStore: deps.todoStore }),
  });
  const resources = createPiFleetSessionResources({
    widget: wiring.fleetWidget,
    getPrimary: deps.getPrimary,
    getUi: deps.getUi,
  });

  return {
    sessionID: deps.sessionID,
    register: () => resources.register(),
    refresh: () => wiring.fleetWidget.refresh(),
    refreshTodoView: wiring.refreshTodoView,
    seedTodoView: wiring.seedTodoView,
    dispose: () => resources.dispose(),
  };
}

/**
 * Create the host-write resources of one session scope.
 *
 * @param host - The live host surfaces to read.
 * @returns The resources the session scope owns.
 */
export function createPiFleetSessionResources(
  host: PiFleetSessionHost,
): PiFleetSessionResources {
  // The terminal-input unsubscribe handle of the current binding.
  let inputUnsubscribe: (() => void) | undefined;
  let disposed = false;

  const releaseListener = (): void => {
    if (inputUnsubscribe === undefined) return;
    inputUnsubscribe();
    inputUnsubscribe = undefined;
  };

  return {
    register() {
      // A stopped scope must not write to the host again: pi may deliver a
      // late event for a session it is tearing down.
      if (disposed) return;
      const ui = host.getUi();
      if (ui === undefined) return;
      // Fail-closed: without an active primary (no configured primary
      // agent) no widget is registered — the fleet line is primary-driven
      // and a primary-less session renders nothing.
      if (host.getPrimary() === undefined) return;
      // Release any previous listener before re-binding so a
      // re-registration never stacks a second one.
      releaseListener();
      if (typeof ui.setWidget === "function") {
        ui.setWidget(
          "zoo",
          (tui, theme) => {
            host.widget.attach(
              tui as Parameters<FleetWidget["attach"]>[0],
              theme as Parameters<FleetWidget["attach"]>[1],
            );
            return {
              render: (width: number) => host.widget.render(width),
              invalidate: () => host.widget.refresh(),
              dispose: () => {
                releaseListener();
                host.widget.dispose();
              },
            };
          },
          { placement: "aboveEditor" },
        );
      }
      if (typeof ui.onTerminalInput === "function") {
        inputUnsubscribe = ui.onTerminalInput((data) =>
          host.widget.handleKey(data),
        );
      }
      host.widget.refresh();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      releaseListener();
      host.widget.dispose();
    },
  };
}
