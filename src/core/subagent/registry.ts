/**
 * Subagent run registry — the single source of truth for subagent run state
 * across every session of a process.
 *
 * A host runs all its sessions in one process, so one {@link RunRegistry}
 * instance (a table keyed by run id) is the natural home for run state.  The
 * instance belongs to the host's process owner (`core/process-state.ts`),
 * which hands the same instance to every configuration generation and to
 * every sub-runtime of that process; nothing here is ambient.
 *
 * Each run records
 * its `parentSession` (the calling session) and, once the sub-session is
 * created, its `childSession` — the two pointers that let the fleet widget
 * rebuild the parent/child tree.  A nested delegation (beaver/mola → lynx/
 * spider) is therefore a run whose `parentSession` equals the parent run's
 * `childSession`; top-level runs under a main session are those whose
 * `parentSession` is that session itself.
 *
 * Invariants:
 * - **Terminal immutability** — once a run reaches `done` / `error` /
 *   `aborted`, `update` and `finish` never change its status,
 *   `endedAt`, `error`, or `sessionPath` again (silently ignored), mirroring
 *   the OpenCode sidebar rule.  Entries are never deleted.
 * - **Finished runs keep metadata only** — `finish` releases the run's
 *   fact log (a fresh empty log takes its place), so resident memory scales
 *   with ACTIVE work, not with the number or size of finished runs.  A
 *   finished run keeps its lifecycle metadata (status, timestamps, `error`,
 *   `sessionPath`, `childSession`, `tokens`, `model`); the facts'
 *   authoritative copy lives in the persisted sub-session file and any
 *   post-finish view rebuilds it on demand through the hydration layer.
 * - **Session isolation** — `topLevel` / `summary` scope by
 *   `parentSession`, so concurrent main sessions never see each other's
 *   runs.  Run ids are globally unique; a duplicate `start` never
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
 * The registry is an explicit object: a host creates one per process, so a
 * test creates its own instance instead of clearing shared state.
 *
 * Ownership is separate from history.  The process table keeps every run,
 * including the terminal records a reload renders, but a run started by a
 * runtime is an ACTIVE run of that runtime.  Each runtime creates its own
 * scope ({@link RunScope}) over the process table, writes through it, and
 * disposes it when the runtime stops; the stop aborts the runs that scope
 * started and still runs, while the process history, the terminal records
 * and every other runtime stay untouched.  A scope reads the whole table, so
 * a reloaded runtime still renders what the previous generation recorded.
 *
 * One writer is a host fact, not a runtime start: a host's subagent
 * translator (the OpenCode TUI panel rebuilding rows from host events)
 * writes the table directly.  Those records are process history, so no
 * scope owns them and no runtime stop ends them.
 *
 * Each run entry owns a `RunLog` (`run-log.ts`): the run's ordered data
 * stream while the run is active.  Fact appends to a live run's log
 * surface through the run-change subscription (`subscribe`)
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
 * sees the registry's mutable entry, so a later `update` / `finish`
 * cannot change what an already-returned snapshot reports.  Unset optional
 * fields are absent keys, never `undefined` values.
 *
 * `log` is the one shared, deliberately mutable handle — see `RunHandle`.
 *
 * `parentSession` is the calling session (the main session for top-level
 * runs, or the parent run's `childSession` for a nested delegation).
 * `childSession` is the sub-session id this run created when it delegated,
 * recorded via `update` once the sub-session exists.
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
 * A producer drives the run through the registry (`update` /
 * `finish`) and needs exactly two things: the id to address it, and the
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

/**
 * The state one process table shares with every scope over it.
 *
 * `owners` tracks ACTIVE ownership only: a run leaves the map when it
 * reaches a terminal state, so a scope's stop never walks history.
 */
interface RunTable {
  /** The run table, keyed by run id. */
  readonly runs: Map<string, MutableRun>;
  /** The run-change subscribers of the process table. */
  readonly listeners: Set<RunChangeListener>;
  /** The scope that started each still-running run. */
  readonly owners: Map<string, RunScope>;
}

/** Input to `start`. */
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

/** Progress fields patchable on a running run via `update`. */
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
 * Input to `finish` — the terminal outcome plus the run's last progress
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

/** Input to `restore` — one historical run rebuilt from persisted data. */
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

/** The terminal statuses — no field may change after one is reached. */
export const TERMINAL_STATUSES: ReadonlySet<RunStatus> = new Set([
  "done",
  "error",
  "aborted",
]);

/**
 * The subagent run table of one process, with its run-change subscribers.
 *
 * A host's process owner creates exactly one instance and hands the same
 * object to every configuration generation, so a reload keeps the runs a
 * previous generation recorded.  A test creates its own instance.
 */
export class RunRegistry {
  /** The state this registry shares with every scope over it. */
  protected readonly table: RunTable;

  /**
   * Build a registry or a scope over a process table.
   *
   * Only the factories in this module call it: the table is the state every
   * generation and every runtime of one process shares.
   *
   * @param table - The table to read and write.
   */
  constructor(table: RunTable) {
    this.table = table;
  }

  /**
   * Create a runtime scope over this process table.
   *
   * The runtimes of one process create their scopes here: each scope writes
   * the runs of exactly one runtime, so the runtime's stop ends only its own
   * running runs.  A direct table write (a host-fact translator) belongs to
   * no scope, so no stop ends it.
   *
   * @returns A fresh scope over the same table.
   */
  createScope(): RunScope {
    return new RunScope(this.table);
  }

  /**
   * Subscribe to run changes.
   *
   * The listener is called whenever a run is registered, a running run's
   * fields actually change, a run reaches its terminal state, or any run's
   * fact log receives an append (partial deliveries never reach it) — so a
   * single subscription keeps consumers (fleet widget, card, overlay)
   * current with both lifecycle and transcript changes.  A write that
   * changes nothing publishes nothing.
   *
   * @param listener - Called with the changed run and its parent session.
   * @returns A function that removes the subscription.
   */
  subscribe(listener: RunChangeListener): () => void {
    this.table.listeners.add(listener);
    return () => {
      this.table.listeners.delete(listener);
    };
  }

  /** Fire the run-change notification for every registered listener. */
  private notify(run: MutableRun): void {
    const change: RunChange = {
      runId: run.id,
      parentSession: run.parentSession,
    };
    for (const listener of this.table.listeners) listener(change);
  }

  /**
   * Register a new running run.
   *
   * A duplicate id never clobbers an existing entry — the first `start`
   * wins (run ids are globally unique, so a collision is a programming error
   * that must not silently re-parent an existing run).
   *
   * The process registry owns no run: only a runtime scope records
   * ownership (see {@link RunScope.start}).
   *
   * @param input - The run to register.
   * @returns The handle of the registered run (its id and live log); a
   *   duplicate id returns the first run's handle.
   */
  start(input: StartRunInput): RunHandle {
    return this.register(input);
  }

  /**
   * Register a run and record the owning scope before the first change.
   *
   * Ownership is written in the same step as the record, before any
   * subscriber runs: a subscriber that throws on the start notification
   * leaves the run in the table, and a run without an owner would never be
   * ended by a stop.  A duplicate id keeps the scope that started it.
   *
   * @param input - The run to register.
   * @param owner - The scope starting the run; absent for the process
   *   registry, which owns nothing.
   * @returns The run's handle.
   */
  protected register(input: StartRunInput, owner?: RunScope): RunHandle {
    const existing = this.table.runs.get(input.id);
    if (existing !== undefined) {
      return { id: existing.id, log: existing.log };
    }
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
      this.notify(run);
    });
    this.table.runs.set(input.id, run);
    if (owner !== undefined) this.table.owners.set(input.id, owner);
    this.notify(run);
    return { id: run.id, log: run.log };
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
  update(id: string, patch: UpdateRunPatch): void {
    const run = this.table.runs.get(id);
    if (run === undefined || TERMINAL_STATUSES.has(run.status)) return;
    if (!applyProgress(run, patch)) return;
    this.notify(run);
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
  finish(id: string, input: FinishRunInput): void {
    const run = this.table.runs.get(id);
    if (run === undefined || TERMINAL_STATUSES.has(run.status)) return;
    applyProgress(run, input);
    run.status = input.status;
    run.endedAt = input.endedAt ?? Date.now();
    if (input.error !== undefined) run.error = input.error;
    // The run is no longer active, so no scope's stop may end it again.
    this.table.owners.delete(id);
    // Release the run's fact log: resident memory must track ACTIVE work only.
    // The run keeps its lifecycle metadata; a later view of the finished run's
    // transcript rebuilds the facts from the persisted sub-session file
    // through the hydration path.  The released log stays valid for any holder
    // (the open-overlay edge case) but is no longer the registry's.
    run.log = createRunLog();
    this.notify(run);
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
  restore(input: RestoreRunInput): boolean {
    if (this.table.runs.has(input.id)) return false;
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
    this.table.runs.set(input.id, run);
    this.notify(run);
    return true;
  }

  /**
   * Look up a run by id.
   *
   * @param id - The run id.
   * @returns A frozen snapshot of the run, or `undefined` when unknown.
   */
  get(id: string): RunSnapshot | undefined {
    const run = this.table.runs.get(id);
    return run === undefined ? undefined : snapshot(run);
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
  topLevel(parentSession: string): RunSnapshot[] {
    return [...this.table.runs.values()]
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
  childrenOf(runId: string): RunSnapshot[] {
    const parent = this.table.runs.get(runId);
    if (parent === undefined || parent.childSession === undefined) return [];
    return [...this.table.runs.values()]
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
  childrenIndex(roots: readonly RunSnapshot[]): Map<string, RunSnapshot[]> {
    const index = new Map<string, RunSnapshot[]>();
    // Seeding the roots keeps a root out of any child list, so a loop through
    // a root and a run that delegates into it cannot re-enter the root.
    const placed = new Set<string>(roots.map((root) => root.id));
    const walk = (run: RunSnapshot): void => {
      const children = this.childrenOf(run.id).filter(
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
  findByChildSession(childSession: string): RunSnapshot | undefined {
    for (const run of this.table.runs.values()) {
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
  summary(parentSession: string): RunSummary {
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
    for (const run of this.table.runs.values()) {
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
}

/**
 * The run scope of one runtime over the process table.
 *
 * A runtime writes its runs through its scope.  `start` also records the run
 * as an active run of this scope (a duplicate id never moves an existing run
 * to another scope), so {@link RunScope.dispose} can end exactly the runs
 * this runtime started.
 *
 * Reads are the process table's, so a scope still renders the runs of every
 * generation.  A restored run is terminal history, so it is never owned.
 * A disposed scope refuses every further start: a run started after the stop
 * would have no owner, so no stop would ever end it.
 */
export class RunScope extends RunRegistry {
  /** Whether this scope stopped; a stopped scope refuses every start. */
  private disposed = false;

  /**
   * Register a new running run and own it.
   *
   * A stopped scope fails closed: the start throws before any table write, so
   * it creates no record, takes no id, and owns nothing.  A run that no
   * runtime owns would run forever, because no stop would end it.
   *
   * The ownership is recorded before the change notification, so a throwing
   * subscriber cannot leave a running run this scope started but does not
   * own.
   *
   * @param input - The run to register.
   * @returns The run's handle.
   * @throws Error when this scope is already stopped.
   */
  override start(input: StartRunInput): RunHandle {
    if (this.disposed) {
      throw new Error(`运行作用域已停止，无法启动运行 "${input.id}"。`);
    }
    return this.register(input, this);
  }

  /**
   * Stop this scope: abort every run it started that still runs.
   *
   * Terminal records keep their status and metadata, other scopes' runs keep
   * running, and the process table keeps every record.  A throwing
   * subscriber cannot stop the cleanup: the remaining owned runs are still
   * closed, and the collected failures are thrown to the caller (the
   * lifecycle stop report).
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const failures: unknown[] = [];
    for (const [id, owner] of [...this.table.owners]) {
      if (owner !== this) continue;
      try {
        this.finish(id, { status: "aborted" });
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length === 0) return;
    if (failures.length === 1) throw failures[0];
    throw new AggregateError(
      failures,
      `运行作用域释放失败，共 ${failures.length} 项失败。`,
    );
  }
}

/**
 * Create an empty run registry.
 *
 * @returns A fresh registry with no runs and no subscribers.
 */
export function createRunRegistry(): RunRegistry {
  return new RunRegistry({
    runs: new Map(),
    listeners: new Set(),
    owners: new Map(),
  });
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
