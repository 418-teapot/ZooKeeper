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
 * - **Finished runs keep metadata only** — `finishRun` releases the run's
 *   fact log (a fresh empty log takes its place), so resident memory scales
 *   with ACTIVE work, not with the number or size of finished runs.  A
 *   finished run keeps its lifecycle metadata (status, timestamps, `error`,
 *   `sessionPath`, `childSession`, `tokens`, `model`); the facts'
 *   authoritative copy lives in the persisted sub-session file and any
 *   post-finish view rebuilds it on demand through the hydration layer.
 * - **Session isolation** — `topLevelRuns` / `summary` scope by
 *   `parentSession`, so concurrent main sessions never see each other's
 *   runs.  Run ids are globally unique; a duplicate `startRun` never
 *   clobbers an existing entry.
 * - **Read-only views** — a public query returns a frozen `RunSnapshot`, so
 *   the mutable entry never leaves this module; a producer holds a
 *   `RunHandle` (id plus the shared live log) and addresses the run by id.
 *
 * `windowRuns` is the stateless scrolling-window slice that feeds the
 * expanded fleet widget's ~7-row budget: the selected run (when present)
 * is kept visible and the window follows it; an absent/stale selection
 * aligns to the bottom.
 *
 * Pure module-level state plus `resetRegistry()` for tests.
 *
 * Each run entry owns a `RunLog` (`run-log.ts`): the run's ordered data
 * stream while the run is active.  Fact appends to a live run's log
 * surface through the run-change subscription (`subscribeRunChange`)
 * alongside lifecycle transitions, so one subscription refreshes consumers
 * on both kinds of change (the streaming partial deliveries stay off this
 * fact-only feed by design — the fleet must not repaint per streamed
 * token).  Every published change names the run and its parent session, so
 * a subscriber routes it without a registry lookup.  At finish the log is
 * released: the terminal run holds a fresh empty log, and the released
 * object stays valid for any consumer already holding it (an open
 * transcript overlay keeps its projected content).
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
 * An immutable snapshot of one tracked subagent run.
 *
 * Every public query hands out a frozen snapshot: a read-only consumer never
 * sees the registry's mutable entry, so a later `updateRun` / `finishRun`
 * cannot change what an already-returned snapshot reports.  Unset optional
 * fields are absent keys, never `undefined` values.
 *
 * `log` is the one shared, deliberately mutable handle — see `RunHandle`.
 *
 * `parentSession` is the calling session (the main session for top-level
 * runs, or the parent run's `childSession` for a nested delegation).
 * `childSession` is the sub-session id this run created when it delegated,
 * recorded via `updateRun` once the sub-session exists.
 */
export interface RunSnapshot {
  /** The globally unique run id (the delegation's tool-call / run id). */
  readonly id: string;
  /** The delegated subagent name (e.g. "lynx", "spider"). */
  readonly agent: string;
  /** The calling session id (main session for top-level runs). */
  readonly parentSession: string;
  /** The lifecycle status. */
  readonly status: RunStatus;
  /** Epoch-millis start time. */
  readonly startedAt: number;
  /** Epoch-millis end time, set only on a terminal finish. */
  readonly endedAt?: number;
  /** The delegation's task description (rendered beside the agent). */
  readonly label?: string;
  /** The sub-session id this run created (its delegation target). */
  readonly childSession?: string;
  /** The tool name the run is currently executing, when any. */
  readonly currentTool?: string;
  /** The context length of the latest message that reported usable usage. */
  readonly tokens?: number;
  /** The model id actually used by the sub-session, when resolved. */
  readonly model?: string;
  /** The failure reason, set only when `status` is `error`. */
  readonly error?: string;
  /** The on-disk path of the sub-session file, when the host persists it. */
  readonly sessionPath?: string;
  /** The run's append-only fact log while the run is active.  Created with
   * the run; replaced by a fresh empty log when the run finishes — the
   * terminal log is inert by design: it carries no `onFact` listener, so
   * appending to it fires no notifications (a post-finish append is a
   * programming error).  The terminal run keeps metadata only (see the
   * module doc). */
  readonly log: RunLog;
}

/**
 * The handle of a run a caller just started.
 *
 * A producer drives the run through the registry (`updateRun` /
 * `finishRun`) and needs exactly two things: the id to address it, and the
 * live log to append facts to.  The log is shared on purpose — it is the
 * live append stream, not a snapshot — so it is neither copied nor frozen.
 */
export interface RunHandle {
  /** The globally unique run id. */
  readonly id: string;
  /** The run's live fact log. */
  readonly log: RunLog;
}

/** The registry's mutable entry — the snapshot's shape without `readonly`. */
type MutableRun = { -readonly [K in keyof RunSnapshot]: RunSnapshot[K] };

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
   * The delegation's task description.
   *
   * Rewritable while the run is active: a host that learns the title from
   * a later, stronger source replaces it (the terminal run freezes it).
   */
  label?: string;
  /**
   * The tool name the run is currently executing.
   *
   * Tri-state: a name sets it, `null` clears it (the tool finished), and an
   * absent field leaves the previous value untouched — the clear signal has
   * to be expressible separately from "no news".
   */
  currentTool?: string | null;
  /** The context length of the latest usage report. */
  tokens?: number;
  /** The model id actually used by the sub-session. */
  model?: string;
  /** The sub-session id this run created (its delegation target). */
  childSession?: string;
  /** The on-disk path of the sub-session file, when the host persists it. */
  sessionPath?: string;
}

/**
 * Input to `finishRun` — the terminal outcome plus the run's last progress
 * fields.
 *
 * The final progress batch belongs here: a producer that reads the last
 * values (tokens, model, label, current tool) while the run settles commits
 * them in the same write as the terminal transition, so the run never
 * publishes an intermediate "fields updated but still running" event.
 */
export interface FinishRunInput extends UpdateRunPatch {
  /** The terminal outcome. */
  status: "done" | "error" | "aborted";
  /** Epoch-millis end time (defaults to the current time). */
  endedAt?: number;
  /** The failure reason (only meaningful for `error`). */
  error?: string;
}

/** Input to `restoreRun` — one historical run rebuilt from persisted data. */
export interface RestoreRunInput extends UpdateRunPatch {
  /** The globally unique run id. */
  id: string;
  /** The delegated subagent name. */
  agent: string;
  /** The calling session id. */
  parentSession: string;
  /** The terminal outcome the persisted data resolved. */
  status: "done" | "error" | "aborted";
  /** Epoch-millis start time (defaults to the current time). */
  startedAt?: number;
  /** Epoch-millis end time (defaults to the current time). */
  endedAt?: number;
  /** The failure reason, set only when `status` is `error`. */
  error?: string;
}

/** Per-main-session run counts feeding the collapsed fleet widget. */
export interface RunSummary {
  /** Runs still in the `running` state. */
  running: number;
  /** Runs in the terminal `done` state. */
  done: number;
  /** Runs in the failed terminal state (`error`). */
  failed: number;
  /** Runs aborted — a cancellation, kept separate from failures. */
  aborted: number;
}

/** A scrolling-window slice over a run list. */
export interface WindowSlice {
  /** The visible rows (already sorted by the caller). */
  rows: RunSnapshot[];
  /** Runs hidden above the window. */
  hiddenAbove: number;
  /** Runs hidden below the window. */
  hiddenBelow: number;
  /** Index of the selected run inside `rows`, or `-1` when none is shown. */
  selectedIndex: number;
}

/** The module-level run table, keyed by run id. */
const registry = new Map<string, MutableRun>();

/**
 * Freeze a shallow copy of one registry entry for a read-only consumer.
 *
 * The copy carries the entry's own keys only, so an unset optional field
 * stays absent.  `log` is the run's live handle and stays shared.
 *
 * @param run - The registry entry.
 * @returns The frozen snapshot.
 */
function snapshot(run: MutableRun): RunSnapshot {
  return Object.freeze({ ...run });
}

/**
 * One published run change: which run changed and which session owns it.
 *
 * `parentSession` routes the change to that session's consumers only, so a
 * subscriber never has to look the run up to decide who it belongs to.
 */
export interface RunChange {
  /** The id of the run that changed. */
  runId: string;
  /** The calling session id the run is scoped to. */
  parentSession: string;
}

/**
 * Listeners notified on any run change — a lifecycle transition or a fact
 * appended to any run's log.
 */
type RunChangeListener = (change: RunChange) => void;

const runChangeListeners = new Set<RunChangeListener>();

/** Fire the run-change notification for every registered listener. */
function notifyRunChange(run: MutableRun): void {
  const change: RunChange = {
    runId: run.id,
    parentSession: run.parentSession,
  };
  for (const listener of runChangeListeners) listener(change);
}

/**
 * Subscribe to run changes.
 *
 * The listener is called whenever a run is registered, a running run's
 * fields actually change, a run reaches its terminal state, or any run's
 * fact log receives an append (partial deliveries never reach it) — so a
 * single subscription keeps consumers (fleet widget, card, overlay)
 * current with both lifecycle and transcript changes.  A write that changes
 * nothing publishes nothing.
 *
 * @param listener - Called with the changed run and its parent session.
 * @returns A function that removes the subscription.
 */
export function subscribeRunChange(listener: RunChangeListener): () => void {
  runChangeListeners.add(listener);
  return () => {
    runChangeListeners.delete(listener);
  };
}

/** The terminal statuses — no field may change after one is reached. */
export const TERMINAL_STATUSES: ReadonlySet<RunStatus> = new Set([
  "done",
  "error",
  "aborted",
]);

/**
 * Reset the module-level registry state.
 *
 * Process-global state means tests share one isolate; call this between
 * tests to keep every assertion deterministic.  The run-change subscribers
 * are module-level state too, so they are dropped as well — a subscription
 * left behind by an earlier test would otherwise repaint its session on
 * every later registry write.
 */
export function resetRegistry(): void {
  registry.clear();
  runChangeListeners.clear();
}

/**
 * Register a new running run.
 *
 * A duplicate id never clobbers an existing entry — the first `startRun`
 * wins (run ids are globally unique, so a collision is a programming error
 * that must not silently re-parent an existing run).
 *
 * @param input - The run to register.
 * @returns The handle of the registered run (its id and live log); a
 *   duplicate id returns the first run's handle.
 */
export function startRun(input: StartRunInput): RunHandle {
  const existing = registry.get(input.id);
  if (existing !== undefined) return { id: existing.id, log: existing.log };
  const run: MutableRun = {
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
    notifyRunChange(run);
  });
  registry.set(input.id, run);
  notifyRunChange(run);
  return { id: run.id, log: run.log };
}

/**
 * Apply a progress patch to a run, reporting whether any field changed.
 *
 * A field already holding the requested value is not a change: the
 * subscribers learn only about writes that alter what they would read.
 *
 * @param run - The run to patch.
 * @param patch - The fields to apply.
 * @returns Whether the run changed.
 */
function applyProgress(run: MutableRun, patch: UpdateRunPatch): boolean {
  let changed = false;
  if (patch.currentTool !== undefined) {
    // `null` is the explicit clear; an absent field never reaches here.
    if (patch.currentTool === null) {
      if (run.currentTool !== undefined) {
        delete run.currentTool;
        changed = true;
      }
    } else if (run.currentTool !== patch.currentTool) {
      run.currentTool = patch.currentTool;
      changed = true;
    }
  }
  if (patch.tokens !== undefined && run.tokens !== patch.tokens) {
    run.tokens = patch.tokens;
    changed = true;
  }
  if (patch.label !== undefined && run.label !== patch.label) {
    run.label = patch.label;
    changed = true;
  }
  if (patch.model !== undefined && run.model !== patch.model) {
    run.model = patch.model;
    changed = true;
  }
  if (
    patch.childSession !== undefined &&
    run.childSession !== patch.childSession
  ) {
    run.childSession = patch.childSession;
    changed = true;
  }
  if (
    patch.sessionPath !== undefined &&
    run.sessionPath !== patch.sessionPath
  ) {
    run.sessionPath = patch.sessionPath;
    changed = true;
  }
  return changed;
}

/**
 * Patch the progress fields of a running run.
 *
 * Silently ignored when the run is terminal (its status, progress fields,
 * and timestamps are frozen) or the id is unknown.  A patch that changes
 * nothing (empty, or every value already held) publishes no event.
 *
 * @param id - The run id.
 * @param patch - The fields to update.
 */
export function updateRun(id: string, patch: UpdateRunPatch): void {
  const run = registry.get(id);
  if (run === undefined || TERMINAL_STATUSES.has(run.status)) return;
  if (!applyProgress(run, patch)) return;
  notifyRunChange(run);
}

/**
 * Finish a run, transitioning it to a terminal state.
 *
 * Silently ignored when the run is already terminal (its status, `endedAt`,
 * `error`, and `sessionPath` are frozen — a second finish never overwrites
 * the first) or the id is unknown.  `endedAt` defaults to the current time.
 *
 * The input also carries the run's last progress fields: they are written
 * in the same step as the terminal transition, and the whole write
 * publishes exactly one event.  A producer that reads the final values
 * while the run settles therefore never publishes an intermediate update.
 *
 * The finish also RELEASES the run's fact log: the terminal run keeps its
 * lifecycle metadata only and its `log` becomes a fresh empty log.  The
 * facts' authoritative copy lives in the persisted sub-session file, and
 * any post-finish view rebuilds it through the hydration path.  The
 * released log object stays valid for consumers already holding it (an
 * open transcript overlay keeps what it projected) but receives no further
 * appends.  The fresh terminal log is inert by design: it carries no
 * `onFact` listener, so appending to it fires no run-change notification —
 * a post-finish append is a programming error.
 *
 * @param id - The run id.
 * @param input - The terminal outcome and the run's last progress fields.
 */
export function finishRun(id: string, input: FinishRunInput): void {
  const run = registry.get(id);
  if (run === undefined || TERMINAL_STATUSES.has(run.status)) return;
  applyProgress(run, input);
  run.status = input.status;
  run.endedAt = input.endedAt ?? Date.now();
  if (input.error !== undefined) run.error = input.error;
  // Release the run's fact log: resident memory must track ACTIVE work only.
  // The run keeps its lifecycle metadata; a later view of the finished run's
  // transcript rebuilds the facts from the persisted sub-session file
  // through the hydration path.  The released log stays valid for any holder
  // (the open-overlay edge case) but is no longer the registry's.
  run.log = createRunLog();
  notifyRunChange(run);
}

/**
 * Restore one run from persisted history as an already-terminal entry.
 *
 * History rebuilds know the run's outcome up front, so a restored run never
 * passes through a `running` state: its metadata and its empty terminal log
 * are created in one step, and exactly one change is published.
 *
 * An id already present in the registry is left untouched and publishes
 * nothing — a live run (or a run restored earlier) keeps what it has, so a
 * repeated scan is idempotent.
 *
 * @param input - The restored run's metadata and terminal outcome.
 * @returns Whether the run was created (`false` when it already existed).
 */
export function restoreRun(input: RestoreRunInput): boolean {
  if (registry.has(input.id)) return false;
  const run: MutableRun = {
    id: input.id,
    agent: input.agent,
    parentSession: input.parentSession,
    status: input.status,
    startedAt: input.startedAt ?? Date.now(),
    endedAt: input.endedAt ?? Date.now(),
    // The terminal log is inert: a restored run has no facts and takes no
    // appends, and the log carries no listener.
    log: createRunLog(),
    ...(input.label !== undefined ? { label: input.label } : {}),
    ...(input.currentTool !== undefined && input.currentTool !== null
      ? { currentTool: input.currentTool }
      : {}),
    ...(input.tokens !== undefined ? { tokens: input.tokens } : {}),
    ...(input.model !== undefined ? { model: input.model } : {}),
    ...(input.error !== undefined ? { error: input.error } : {}),
    ...(input.childSession !== undefined
      ? { childSession: input.childSession }
      : {}),
    ...(input.sessionPath !== undefined
      ? { sessionPath: input.sessionPath }
      : {}),
  };
  registry.set(input.id, run);
  notifyRunChange(run);
  return true;
}

/**
 * Look up a run by id.
 *
 * @param id - The run id.
 * @returns A frozen snapshot of the run, or `undefined` when unknown.
 */
export function getRun(id: string): RunSnapshot | undefined {
  const run = registry.get(id);
  return run === undefined ? undefined : snapshot(run);
}

/**
 * Order runs by `startedAt` ascending with a stable id tiebreak.
 *
 * @param a - The first run.
 * @param b - The second run.
 * @returns A negative / zero / positive sort comparison.
 */
function byStartedAt(a: RunSnapshot, b: RunSnapshot): number {
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
 * @returns Frozen snapshots of the top-level runs, oldest first.
 */
export function topLevelRuns(parentSession: string): RunSnapshot[] {
  return [...registry.values()]
    .filter((run) => run.parentSession === parentSession)
    .sort(byStartedAt)
    .map(snapshot);
}

/**
 * List the child runs of a run, ordered by `startedAt`.
 *
 * A run's children are those whose `parentSession` equals the run's
 * `childSession` (the sub-session it created when it delegated).  Runs
 * without a recorded `childSession` have no children.
 *
 * @param runId - The parent run id.
 * @returns Frozen snapshots of the child runs, oldest first.
 */
export function childrenOf(runId: string): RunSnapshot[] {
  const parent = registry.get(runId);
  if (parent === undefined || parent.childSession === undefined) return [];
  return [...registry.values()]
    .filter((run) => run.parentSession === parent.childSession)
    .sort(byStartedAt)
    .map(snapshot);
}

/**
 * Index the subtrees rooted at the given runs by parent run id.
 *
 * The map covers every generation reachable from `roots`: each entry holds a
 * root's or descendant's child runs, ordered by `startedAt` — the same order
 * `childrenOf` returns.  A run with no children has no entry, so a consumer
 * reads `index.get(id) ?? []`.  A read-only consumer can hand the shared
 * index to the card and the fleet renderers, which then render every depth
 * from one explicit source instead of querying the registry per level.
 *
 * The index is a DAG even when the registry holds a parent/child loop (a run
 * whose child session points back at an ancestor, which a corrupted history
 * scan can leave behind): a run enters the index at most once, so a later
 * edge back to an indexed run is dropped.  A recursive consumer of this map
 * therefore always terminates.
 *
 * @param roots - The run snapshots to walk down from (top-level runs).
 * @returns Parent-run id → its child runs, at every depth.
 */
export function childrenIndex(
  roots: readonly RunSnapshot[],
): Map<string, RunSnapshot[]> {
  const index = new Map<string, RunSnapshot[]>();
  // Seeding the roots keeps a root out of any child list, so a loop through
  // a root and a run that delegates into it cannot re-enter the root.
  const placed = new Set<string>(roots.map((root) => root.id));
  const walk = (run: RunSnapshot): void => {
    const children = childrenOf(run.id).filter(
      (child) => !placed.has(child.id),
    );
    if (children.length === 0) return;
    index.set(run.id, children);
    for (const child of children) {
      placed.add(child.id);
      walk(child);
    }
  };
  for (const root of roots) walk(root);
  return index;
}

/**
 * Find the run that delegated into a given sub-session.
 *
 * The reverse lookup over `childSession`: in the host's in-process
 * model every sub-session was created by exactly one run, so the first
 * match is the answer.  Terminal runs still match — the delegation
 * outlives the run, and identity resolution needs it to (a session
 * rebuilt from persisted history carries the same `childSession`).
 *
 * @param childSession - The sub-session id to look up.
 * @returns A frozen snapshot of the run whose `childSession` matches, or
 *   `undefined`.
 */
export function findByChildSession(
  childSession: string,
): RunSnapshot | undefined {
  for (const run of registry.values()) {
    if (run.childSession === childSession) return snapshot(run);
  }
  return undefined;
}

/**
 * Count a main session's runs by status.
 *
 * Counts the WHOLE run tree under one main session — every top-level run plus
 * its nested descendants (a nested delegation lands in the parent run's
 * `childSession`, so the tree is walked through `parentSession` /
 * `childSession` links).  The done/failed totals therefore reflect every
 * delegation the session performed, not just the ones it launched directly.
 * The `running` field is likewise whole-tree, matching the collapsed line's
 * running list, which also walks every generation.  `failed` counts `error`
 * outcomes; `aborted` counts
 * cancellations in their own field so the collapsed line renders them with
 * the cancelled presentation instead of the failure one; `running` counts
 * still-active runs; `done` counts successful completions.
 *
 * @param parentSession - The main session id.
 * @returns The per-status counts.
 */
export function summary(parentSession: string): RunSummary {
  let running = 0;
  let done = 0;
  let failed = 0;
  let aborted = 0;
  const tally = (run: MutableRun): void => {
    if (run.status === "running") running += 1;
    else if (run.status === "done") done += 1;
    else if (run.status === "aborted") aborted += 1;
    else failed += 1; // error
  };
  // Index runs by their calling session once, then walk the tree from the
  // main session so nested runs are counted without a per-run registry scan.
  const runsByParent = new Map<string, MutableRun[]>();
  for (const run of registry.values()) {
    const siblings = runsByParent.get(run.parentSession);
    if (siblings === undefined) runsByParent.set(run.parentSession, [run]);
    else siblings.push(run);
  }
  const counted = new Set<string>();
  const stack: string[] = [parentSession];
  while (stack.length > 0) {
    const session = stack.pop();
    if (session === undefined) break;
    for (const run of runsByParent.get(session) ?? []) {
      if (counted.has(run.id)) continue;
      counted.add(run.id);
      tally(run);
      if (run.childSession !== undefined) stack.push(run.childSession);
    }
  }
  return { running, done, failed, aborted };
}

/**
 * Slice a run list into a scrolling window whose rendered rows fit `maxRows`.
 *
 * Selection is always by whole run: the window is a contiguous run range, so
 * a run's nested children are never split across the boundary.  `maxRows` is
 * a ROW budget, not a run count — the optional `rowsOf` callback reports how
 * many display rows a run occupies (a top-level run plus its descendants
 * renders `1 + <descendant count>` rows), and the window keeps whole runs
 * while their cumulative rows fit.
 *
 * When a `selectedId` is present and found, the window keeps it visible and
 * follows it: the window start is clamped so the selection stays in view
 * while as many later runs as fit are shown.  When the selection is absent
 * or stale (not found), the window aligns to the bottom of the list.  The
 * input array is never mutated.
 *
 * @param entries - The full sorted run list (top-level runs).
 * @param selectedId - The id of the selected run, or `undefined` for the
 *   bottom-aligned window.
 * @param maxRows - The maximum rendered-row budget (clamped to at least 1).
 * @param rowsOf - Reports the display rows a run occupies; defaults to 1
 *   (one row per run).
 * @returns The visible slice with the hidden counts and selection index.
 */
export function windowRuns(
  entries: RunSnapshot[],
  selectedId: string | undefined,
  maxRows: number,
  rowsOf?: (run: RunSnapshot) => number,
): WindowSlice {
  const n = entries.length;
  if (n === 0) {
    return { rows: [], hiddenAbove: 0, hiddenBelow: 0, selectedIndex: -1 };
  }
  const cap = Math.max(1, Math.floor(maxRows));
  const cost = (run: RunSnapshot): number => {
    if (rowsOf === undefined) return 1;
    const rows = Math.floor(rowsOf(run));
    return Number.isFinite(rows) && rows >= 1 ? rows : 1;
  };
  // Walk in from the end to the smallest start whose whole-run suffix fits
  // the budget.  A run whose rows alone exceed the cap still counts as one
  // run so the window is never empty.
  let bottomStart = n;
  let bottomRows = 0;
  while (bottomStart > 0) {
    const next = cost(entries[bottomStart - 1]);
    if (bottomRows + next > cap) break;
    bottomStart -= 1;
    bottomRows += next;
  }
  if (bottomStart === n) bottomStart = n - 1;
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
  // Keep the selection visible while showing as many later runs as fit:
  // start = min(sel, bottomStart) keeps the window from pushing the
  // selection out when the list outgrows it.
  const start = Math.min(sel, bottomStart);
  let end = start;
  let rows = 0;
  while (end < n) {
    const next = cost(entries[end]);
    if (end > start && rows + next > cap) break;
    rows += next;
    end += 1;
  }
  // Defensive: the clamped start always reaches the selection, but never
  // let the window end before it if the cost model ever changes.
  if (end <= sel) end = sel + 1;
  return {
    rows: entries.slice(start, end),
    hiddenAbove: start,
    hiddenBelow: n - end,
    selectedIndex: sel - start,
  };
}
