/**
 * Process-level subagent run registry — the single source of truth for
 * subagent run state across every session in the pi process.
 *
 * The pi host runs all sessions in one process, so a module-level table
 * (keyed by run id) is the natural home for run state.  Each run records
 * its `parentSession` (the calling session) and, once the sub-session is
 * created, its `childSession` — the two pointers that let the fleet widget
 * rebuild the parent/child tree.  A nested delegation (beaver/mola → lynx/
 * spider) is therefore a run whose `parentSession` equals the parent run's
 * `childSession`; top-level runs under a main session are those whose
 * `parentSession` is that session itself.
 *
 * Invariants:
 * - **Terminal immutability** — once a run reaches `done` / `error` /
 *   `aborted`, `updateRun` and `finishRun` never change its status,
 *   `endedAt`, `error`, or `sessionPath` again (silently ignored), mirroring
 *   the OpenCode sidebar rule.  Entries are never deleted.
 * - **Session isolation** — `topLevelRuns` / `summary` scope by
 *   `parentSession`, so concurrent main sessions never see each other's
 *   runs.  Run ids are globally unique; a duplicate `startRun` never
 *   clobbers an existing entry.
 *
 * `windowRuns` is the stateless scrolling-window slice that feeds the
 * expanded fleet widget's ~7-row budget: the selected run (when present)
 * is kept visible and the window follows it; an absent/stale selection
 * aligns to the bottom.
 *
 * Pure module-level state plus `resetRegistry()` for tests.
 *
 * Each run entry owns a `RunLog` (`run-log.ts`): the run's ordered data
 * stream.  Fact appends to any run's log surface through the run-change
 * subscription (`subscribeRunChange`) alongside lifecycle transitions, so
 * one subscription refreshes consumers on both kinds of change (the
 * streaming partial deliveries stay off this fact-only feed by design — the
 * fleet must not repaint per streamed token).
 *
 * @module
 */

import { createRunLog, type RunLog } from "./run-log.js";

/**
 * The lifecycle status of a subagent run.
 *
 * `running` is the only non-terminal state; `done` / `error` / `aborted`
 * are terminal and immutable.
 */
export type RunStatus = "running" | "done" | "error" | "aborted";

/**
 * One tracked subagent run.
 *
 * `parentSession` is the calling session (the main session for top-level
 * runs, or the parent run's `childSession` for a nested delegation).
 * `childSession` is the sub-session id this run created when it delegated,
 * recorded via `updateRun` once the sub-session exists.
 */
export interface SubagentRun {
  /** The globally unique run id (the delegation's tool-call / run id). */
  id: string;
  /** The delegated subagent name (e.g. "lynx", "spider"). */
  agent: string;
  /** The calling session id (main session for top-level runs). */
  parentSession: string;
  /** The lifecycle status. */
  status: RunStatus;
  /** Epoch-millis start time. */
  startedAt: number;
  /** Epoch-millis end time, set only on a terminal finish. */
  endedAt?: number;
  /** The delegation's task description (rendered beside the agent). */
  label?: string;
  /** The sub-session id this run created (its delegation target). */
  childSession?: string;
  /** The tool name the run is currently executing, when any. */
  currentTool?: string;
  /** The accumulated token usage reported by the sub-session, when any. */
  tokens?: number;
  /** The model id actually used by the sub-session, when resolved. */
  model?: string;
  /** The failure reason, set only when `status` is `error`. */
  error?: string;
  /** The on-disk path of the sub-session file, when the host persists it. */
  sessionPath?: string;
  /** The run's append-only fact log (tool starts / ends, assistant
   * messages).  Created with the run; never replaced. */
  log: RunLog;
}

/** Input to `startRun`. */
export interface StartRunInput {
  /** The globally unique run id. */
  id: string;
  /** The delegated subagent name. */
  agent: string;
  /** The calling session id. */
  parentSession: string;
  /** The delegation's task description. */
  label?: string;
  /** Epoch-millis start time (defaults to the current time). */
  startedAt?: number;
  /** The sub-session id this run created (its delegation target). */
  childSession?: string;
  /** The on-disk path of the sub-session file, when the host persists it. */
  sessionPath?: string;
}

/** Progress fields patchable on a running run via `updateRun`. */
export interface UpdateRunPatch {
  /**
   * The tool name the run is currently executing.
   *
   * Tri-state: a name sets it, `null` clears it (the tool finished), and an
   * absent field leaves the previous value untouched — the clear signal has
   * to be expressible separately from "no news".
   */
  currentTool?: string | null;
  /** The accumulated token usage. */
  tokens?: number;
  /** The model id actually used by the sub-session. */
  model?: string;
  /** The sub-session id this run created (its delegation target). */
  childSession?: string;
  /** The on-disk path of the sub-session file, when the host persists it. */
  sessionPath?: string;
}

/** Input to `finishRun` — transitions a run to a terminal state. */
export interface FinishRunInput {
  /** The terminal outcome. */
  status: "done" | "error" | "aborted";
  /** Epoch-millis end time (defaults to the current time). */
  endedAt?: number;
  /** The failure reason (only meaningful for `error`). */
  error?: string;
  /** The on-disk path of the sub-session file, when the host persists it. */
  sessionPath?: string;
  /** The sub-session id this run created (its delegation target). */
  childSession?: string;
}

/** Per-main-session run counts feeding the collapsed fleet widget. */
export interface RunSummary {
  /** Runs still in the `running` state. */
  running: number;
  /** Runs in the terminal `done` state. */
  done: number;
  /** Runs in a failed terminal state (`error` or `aborted`). */
  failed: number;
}

/** A scrolling-window slice over a run list. */
export interface WindowSlice {
  /** The visible rows (already sorted by the caller). */
  rows: SubagentRun[];
  /** Runs hidden above the window. */
  hiddenAbove: number;
  /** Runs hidden below the window. */
  hiddenBelow: number;
  /** Index of the selected run inside `rows`, or `-1` when none is shown. */
  selectedIndex: number;
}

/** The module-level run table, keyed by run id. */
const registry = new Map<string, SubagentRun>();

/**
 * Listeners notified on any run change — a lifecycle transition or a fact
 * appended to any run's log.
 */
type RunChangeListener = () => void;

const runChangeListeners = new Set<RunChangeListener>();

/** Fire the run-change notification for every registered listener. */
function notifyRunChange(): void {
  for (const listener of runChangeListeners) listener();
}

/**
 * Subscribe to run changes.
 *
 * The listener is called whenever a run is registered, updated, or
 * finished, and whenever any run's fact log receives an append (partial
 * deliveries never reach it) — so a
 * single subscription keeps consumers (fleet widget, card, overlay)
 * current with both lifecycle and transcript changes.
 *
 * @param listener - Called with no arguments on each change.
 * @returns A function that removes the subscription.
 */
export function subscribeRunChange(listener: RunChangeListener): () => void {
  runChangeListeners.add(listener);
  return () => {
    runChangeListeners.delete(listener);
  };
}

/** The terminal statuses — no field may change after one is reached. */
const TERMINAL: ReadonlySet<RunStatus> = new Set(["done", "error", "aborted"]);

/**
 * Reset the module-level registry state.
 *
 * Process-global state means tests share one isolate; call this between
 * tests to keep every assertion deterministic.
 */
export function resetRegistry(): void {
  registry.clear();
}

/**
 * Register a new running run.
 *
 * A duplicate id never clobbers an existing entry — the first `startRun`
 * wins (run ids are globally unique, so a collision is a programming error
 * that must not silently re-parent an existing run).
 *
 * @param input - The run to register.
 * @returns The registered run.
 */
export function startRun(input: StartRunInput): SubagentRun {
  const existing = registry.get(input.id);
  if (existing !== undefined) return existing;
  const run: SubagentRun = {
    id: input.id,
    agent: input.agent,
    parentSession: input.parentSession,
    status: "running",
    startedAt: input.startedAt ?? Date.now(),
    log: createRunLog(),
    ...(input.label !== undefined ? { label: input.label } : {}),
    ...(input.childSession !== undefined
      ? { childSession: input.childSession }
      : {}),
    ...(input.sessionPath !== undefined
      ? { sessionPath: input.sessionPath }
      : {}),
  };
  run.log.onFact(() => {
    notifyRunChange();
  });
  registry.set(input.id, run);
  notifyRunChange();
  return run;
}

/**
 * Patch the progress fields of a running run.
 *
 * Silently ignored when the run is terminal (its status, progress fields,
 * and timestamps are frozen) or the id is unknown.
 *
 * @param id - The run id.
 * @param patch - The fields to update.
 */
export function updateRun(id: string, patch: UpdateRunPatch): void {
  const run = registry.get(id);
  if (run === undefined || TERMINAL.has(run.status)) return;
  if (patch.currentTool !== undefined) {
    // `null` is the explicit clear; an absent field never reaches here.
    if (patch.currentTool === null) delete run.currentTool;
    else run.currentTool = patch.currentTool;
  }
  if (patch.tokens !== undefined) run.tokens = patch.tokens;
  if (patch.model !== undefined) run.model = patch.model;
  if (patch.childSession !== undefined) run.childSession = patch.childSession;
  if (patch.sessionPath !== undefined) run.sessionPath = patch.sessionPath;
  notifyRunChange();
}

/**
 * Finish a run, transitioning it to a terminal state.
 *
 * Silently ignored when the run is already terminal (its status, `endedAt`,
 * `error`, and `sessionPath` are frozen — a second finish never overwrites
 * the first) or the id is unknown.  `endedAt` defaults to the current time.
 *
 * @param id - The run id.
 * @param input - The terminal outcome.
 */
export function finishRun(id: string, input: FinishRunInput): void {
  const run = registry.get(id);
  if (run === undefined || TERMINAL.has(run.status)) return;
  run.status = input.status;
  run.endedAt = input.endedAt ?? Date.now();
  if (input.error !== undefined) run.error = input.error;
  if (input.sessionPath !== undefined) run.sessionPath = input.sessionPath;
  if (input.childSession !== undefined) run.childSession = input.childSession;
  notifyRunChange();
}

/**
 * Look up a run by id.
 *
 * @param id - The run id.
 * @returns The run, or `undefined` when unknown.
 */
export function getRun(id: string): SubagentRun | undefined {
  return registry.get(id);
}

/**
 * Order runs by `startedAt` ascending with a stable id tiebreak.
 *
 * @param a - The first run.
 * @param b - The second run.
 * @returns A negative / zero / positive sort comparison.
 */
function byStartedAt(a: SubagentRun, b: SubagentRun): number {
  if (a.startedAt !== b.startedAt) return a.startedAt - b.startedAt;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * List the top-level runs of a main session, ordered by `startedAt`.
 *
 * A run is top-level when its `parentSession` is the main session itself —
 * nested child runs (whose `parentSession` is a run's `childSession`) are
 * excluded.
 *
 * @param parentSession - The main session id.
 * @returns The top-level runs, oldest first.
 */
export function topLevelRuns(parentSession: string): SubagentRun[] {
  return [...registry.values()]
    .filter((run) => run.parentSession === parentSession)
    .sort(byStartedAt);
}

/**
 * List the child runs of a run, ordered by `startedAt`.
 *
 * A run's children are those whose `parentSession` equals the run's
 * `childSession` (the sub-session it created when it delegated).  Runs
 * without a recorded `childSession` have no children.
 *
 * @param runId - The parent run id.
 * @returns The child runs, oldest first.
 */
export function childrenOf(runId: string): SubagentRun[] {
  const parent = registry.get(runId);
  if (parent === undefined || parent.childSession === undefined) return [];
  return [...registry.values()]
    .filter((run) => run.parentSession === parent.childSession)
    .sort(byStartedAt);
}

/**
 * Count a main session's runs by status.
 *
 * `failed` counts both `error` and `aborted` outcomes; `running` counts
 * still-active runs; `done` counts successful completions.  Scoped to one
 * main session.
 *
 * @param parentSession - The main session id.
 * @returns The per-status counts.
 */
export function summary(parentSession: string): RunSummary {
  let running = 0;
  let done = 0;
  let failed = 0;
  for (const run of registry.values()) {
    if (run.parentSession !== parentSession) continue;
    if (run.status === "running") running += 1;
    else if (run.status === "done") done += 1;
    else failed += 1; // error or aborted
  }
  return { running, done, failed };
}

/**
 * Slice a run list into a scrolling window of at most `maxRows` rows.
 *
 * When a `selectedId` is present and found, the window keeps it visible and
 * follows it: the window start is clamped so the selection stays in view
 * while as many later rows as fit are shown.  When the selection is absent
 * or stale (not found), the window aligns to the bottom of the list.  The
 * input array is never mutated.
 *
 * @param entries - The full sorted run list (top-level runs).
 * @param selectedId - The id of the selected run, or `undefined` for the
 *   bottom-aligned window.
 * @param maxRows - The maximum window height (clamped to at least 1).
 * @returns The visible slice with the hidden counts and selection index.
 */
export function windowRuns(
  entries: SubagentRun[],
  selectedId: string | undefined,
  maxRows: number,
): WindowSlice {
  const n = entries.length;
  if (n === 0) {
    return { rows: [], hiddenAbove: 0, hiddenBelow: 0, selectedIndex: -1 };
  }
  const cap = Math.max(1, Math.floor(maxRows));
  const bottomStart = Math.max(0, n - cap);
  if (selectedId === undefined) {
    return {
      rows: entries.slice(bottomStart),
      hiddenAbove: bottomStart,
      hiddenBelow: 0,
      selectedIndex: -1,
    };
  }
  const sel = entries.findIndex((run) => run.id === selectedId);
  if (sel === -1) {
    return {
      rows: entries.slice(bottomStart),
      hiddenAbove: bottomStart,
      hiddenBelow: 0,
      selectedIndex: -1,
    };
  }
  // Keep the selection visible while showing as many later rows as fit:
  // start = min(sel, bottomStart) keeps the window from pushing the
  // selection out when the list outgrows it.
  const start = Math.min(sel, bottomStart);
  const rows = entries.slice(start, start + cap);
  return {
    rows,
    hiddenAbove: start,
    hiddenBelow: n - (start + rows.length),
    selectedIndex: sel - start,
  };
}
