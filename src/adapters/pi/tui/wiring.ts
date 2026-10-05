/**
 * Pi TUI wiring — the `zoo` fleet widget and its todo column.
 *
 * The pi entry point registers the fleet widget (a component factory)
 * above the editor and refreshes its right-hand todo column.  Both read
 * their data live from the identity core, the run registry, and the
 * per-session todo store, so they only need nudges when that data changes:
 * a primary switch, a registry write, a successful `todo` tool result, a
 * session start, and a session tree navigation.
 *
 * This module owns that wiring — it creates the widget bound to the host
 * surfaces and exposes the todo-column refresh — so the mutable
 * per-session caches (the todo phases, the request sequence, the seed
 * flag, and the deferred overlay opens) live with the widget that reads
 * them instead of on the entry point factory.
 *
 * The widget's enter-inspect action opens the transcript overlay for the
 * selected run, hydrating a finished run's facts from its persisted
 * sub-session file when the in-memory log was released on finish.
 *
 * @module
 */

import type { SubagentRun } from "../../../core/subagent/registry.js";
import type { RunLog } from "../../../core/subagent/run-log.js";
import type { TodoStateStore } from "../../../core/todo/store.js";
import type { TodoPhase } from "../../../core/todo/types.js";
import { log } from "../../../utils/logger.js";
import {
  beginHydration,
  hydrationState,
  waitForHydration,
} from "../hydrate.js";
import { readSessionCwd } from "../subagent-scan.js";
import {
  openTranscriptOverlay,
  TRANSCRIPT_NOT_RECORDED_NOTICE,
  TRANSCRIPT_UNAVAILABLE_NOTICE,
} from "./transcript.js";
import { createFleetWidget, type FleetWidget } from "./widget.js";

/**
 * The live host surfaces the fleet wiring reads.
 *
 * Every reader is a closure over the entry point's mutable context holder
 * so the widget and its overlay always see the current pi surfaces.
 */
export interface FleetWiringDeps {
  /** The active primary agent name, or undefined when none. */
  getPrimary(): string | undefined;
  /** Colorize an agent name per its configured `[agent.<name>].color`. */
  colorizeAgent(name: string): string;
  /** The current session id (scopes registry and todo queries). */
  getSessionId(): string | undefined;
  /** The current pi editor text (guards the collapsed-key activation). */
  getEditorText(): string;
  /** The overlay title for a run (`<agent> · <label>`, colorized). */
  titleForRun(run: SubagentRun): string;
  /** The run's agent border colorizer, or undefined when unconfigured. */
  borderColorizeForRun(
    run: SubagentRun,
  ): ((text: string) => string) | undefined;
  /** The live `ui.custom` overlay opener, or undefined when absent. */
  getOpenOverlay():
    | ((factory: unknown, options: unknown) => unknown)
    | undefined;
  /** The per-session todo state store, or undefined when absent. */
  todoStore?: TodoStateStore;
}

/**
 * The wired fleet widget and its todo-column refresh hooks.
 */
export interface FleetWiring {
  /** The `zoo` fleet widget (registered above the editor by the host). */
  fleetWidget: FleetWidget;
  /** Re-read the session's todo state and re-render the widget. */
  refreshTodoView(): void;
  /** Seed the todo column once (the `before_agent_start` fallback). */
  seedTodoView(): void;
}

/**
 * Create the fleet widget and its todo-column wiring.
 *
 * @param deps - The live host surfaces (primary, colorizer, session id,
 *   editor text, overlay title/color, overlay opener, todo store).
 * @returns The widget plus the todo refresh hooks.
 */
export function createFleetWiring(deps: FleetWiringDeps): FleetWiring {
  // The session-scoped todo snapshot the widget's column renders.  The
  // per-session store fills it through `refreshTodoView`, triggered by a
  // successful `todo` tool result, a session start, and a session tree
  // navigation.  An empty list hides the column, so a session with no plan
  // (or no store) reads as the fleet column alone.
  let todoPhasesCache: readonly TodoPhase[] = [];
  // The monotonically increasing request sequence: a refresh issued later
  // must never be overwritten by an earlier one that resolves later, so
  // each read carries its sequence and a stale resolution is discarded.
  let todoViewRequest = 0;
  // Whether a todo read has actually resolved a session.  The first such
  // read marks the column seeded so the `before_agent_start` fallback stops
  // consulting the store on every turn.
  let todoSeeded = false;
  // Runs whose overlay open is deferred on a transcript load: a second
  // enter while that load is in flight must not stack a second overlay.
  const deferredOverlayOpens = new Set<string>();

  const fleetWidget = createFleetWidget({
    getPrimary: () => deps.getPrimary(),
    colorizeAgent: deps.colorizeAgent,
    getSessionId: deps.getSessionId,
    getEditorText: deps.getEditorText,
    getTodoPhases: () => todoPhasesCache,
    enterRun: (run) => {
      // The overlay opens through pi's `ExtensionUIContext.custom` surface,
      // exposed on every event context's `ui`.  When nothing is cached no
      // overlay can open: return `false` so the widget leaves enter
      // unconsumed (the key falls through to the editor); otherwise the key
      // is always consumed.
      const openOverlay = deps.getOpenOverlay();
      if (openOverlay === undefined) return false;
      // Collapse the fleet widget to its one-line stable state BEFORE the
      // overlay opens: pi's overlay compositor line-diffs the base content,
      // and an expanded widget (~10 lines) that collapses mid-overlay (the
      // editor-focus guard on each keypress) would mutate the base length
      // under it, forcing a full re-paint.  `collapse()` is idempotent —
      // an already-collapsed widget is unchanged (and the overlay keeps the
      // collapsed state; ↓ re-expands it after close, as before).
      fleetWidget.collapse();
      // Open the overlay on a chosen fact log (empty-log notice optional).
      const open = (runLog: RunLog, emptyNotice?: string): boolean =>
        openTranscriptOverlay({
          log: runLog,
          title: deps.titleForRun(run),
          // The overlay title uses the inspected run's agent color; absent a
          // configured color the overlay falls back to its fixed border color.
          borderColorize: deps.borderColorizeForRun(run),
          // The working directory the sub-session ran in — the native tool
          // renderers' render context.  Read at open time because
          // `run.sessionPath` is patched mid-run, so a run whose path is
          // still unknown (or whose header cannot be read) leaves `cwd`
          // undefined and the renderers use their non-cwd fallback formats.
          cwd:
            typeof run.sessionPath === "string" && run.sessionPath.length > 0
              ? readSessionCwd(run.sessionPath)
              : undefined,
          ...(emptyNotice === undefined ? {} : { emptyNotice }),
          openOverlay,
        });
      // HYDRATION GATE.  `finishRun` releases a finished run's in-memory log
      // (resident memory tracks active work only), and the post-restart
      // history scanner rebuilds runs from persisted sessions with lifecycle
      // metadata only — so in both cases a terminal run's registry log is
      // empty while its full transcript sits intact in `run.sessionPath`;
      // opening straight on `run.log` would render "(empty transcript)" for
      // a run that clearly produced work.  Restore the facts through the
      // shared hydration cache the inline card already uses (keyed by run id,
      // so the card and this overlay dedupe one load): open on the settled
      // log when it is ready, state `TRANSCRIPT_UNAVAILABLE_NOTICE` when the
      // load failed (a gone or unparseable file — the failure stays cached
      // until eviction, after which the id returns to `missing` and a later
      // open retries the load), and otherwise join the load and open when it
      // settles, which costs a few milliseconds of dead time on the keypress
      // but never shows a transcript that is not there.  A still-RUNNING run
      // is excluded on purpose: its log is the live source, and a file
      // snapshot would both repeat the facts already appended and cut the
      // open overlay off from the driver's later appends.  A finished run
      // with an EMPTY log and no session path at all is the other dead end —
      // nothing to restore from anywhere (a run that failed or was aborted
      // before its prompt reached the host leaves exactly this shape), so it
      // opens on the explicit "nothing was recorded" notice rather than the
      // generic empty line.
      const sessionPath = run.sessionPath;
      if (run.status !== "running" && run.log.facts().length === 0) {
        if (typeof sessionPath !== "string" || sessionPath.length === 0) {
          return open(run.log, TRANSCRIPT_NOT_RECORDED_NOTICE);
        }
        const state = hydrationState(run.id);
        if (state.kind === "ready") return open(state.log);
        if (state.kind === "failed") {
          return open(run.log, TRANSCRIPT_UNAVAILABLE_NOTICE);
        }
        if (deferredOverlayOpens.has(run.id)) return true;
        deferredOverlayOpens.add(run.id);
        beginHydration(run.id, sessionPath);
        void waitForHydration(run.id).then(() => {
          deferredOverlayOpens.delete(run.id);
          const settled = hydrationState(run.id);
          if (settled.kind === "ready") {
            open(settled.log);
          } else {
            open(run.log, TRANSCRIPT_UNAVAILABLE_NOTICE);
          }
        });
        return true;
      }
      return open(run.log);
    },
  });

  // Refresh the widget's todo cache from the per-session store, then nudge
  // the widget to re-render.  Fire-and-forget: the async store read must
  // not block the triggering handler, and a rejected read keeps the
  // previous cache in place so the widget keeps rendering the last good
  // view.
  const refreshTodoView = (): void => {
    const request = ++todoViewRequest;
    const sessionId = deps.getSessionId();
    if (deps.todoStore === undefined || sessionId === undefined) {
      todoPhasesCache = [];
      fleetWidget.refresh();
      return;
    }
    // A resolved read is the one-shot seed: later turns skip the fallback
    // read entirely.
    todoSeeded = true;
    deps.todoStore
      .get(sessionId)
      .then((phases) => {
        if (request !== todoViewRequest) return;
        todoPhasesCache = phases;
        fleetWidget.refresh();
      })
      .catch((err) => {
        log(
          "plugin",
          "todo_view_refresh_failed",
          sessionId,
          undefined,
          "warn",
          {
            error: String(err),
          },
        );
      });
  };

  return {
    fleetWidget,
    refreshTodoView,
    // The `before_agent_start` fallback: seed the todo column once when
    // `session_start` did not already do so; the one-shot flag keeps later
    // turns from re-reading the store.
    seedTodoView() {
      if (!todoSeeded) refreshTodoView();
    },
  };
}
