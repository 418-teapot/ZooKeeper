/**
 * Todo list view model — host-agnostic display projections over todo phases.
 *
 * Everything here is a pure projection of a `TodoPhase[]`: it turns the state
 * into semantic display rows (glyph, hue, text, and semantic flags).  No
 * mutation, no host dependency — the module stays
 * importable and unit-testable in any TS runtime.
 *
 * A single projection, `todoLines`, always enumerates the plan: every
 * non-empty phase renders its header, and a phase's fold defaults to its
 * settled status — a phase holding open work enumerates all of its tasks in
 * declaration order (completed work included and struck through), while a
 * settled phase (all tasks closed) renders header-only.  A per-phase entry
 * in `opts.foldOverrides` replaces that default in either direction, so a
 * surface can collapse a busy in-progress phase or expand finished work on
 * demand.  Callers clip the projection to their budget with the shared
 * `fitToBudget` (the `+N` overflow row this module builds keeps dropped work
 * discoverable) without re-deriving any shape policy.
 *
 * Rows carry semantics only — a `hue` from the shared `DisplayHue`
 * vocabulary (`running` / `success` / `error` / `muted` / `accent`, defined
 * in `../display.ts`) and a glyph from the shared symbol table.  Rendering sites
 * map those onto their own concrete colors.  The `in_progress` glyph is
 * deliberately left as a spinner flag with no fixed frame character: core
 * never emits frames, the host's refresh clock drives the concrete spinner
 * character.
 *
 * @module
 */

import {
  type DisplayHue,
  FOLD_COLLAPSED,
  FOLD_EXPANDED,
  type PresentationStatus,
  STATUS_PRESENTATION,
} from "../display.js";
import type { TodoItem, TodoPhase, TodoStatus } from "./types.js";

/**
 * The todo domain's mapping from a task status to the canonical presentation
 * status.  Everything else (glyph, hue, spinner flag) resolves through the
 * single `STATUS_PRESENTATION` table in `../display.ts`.
 */
export const TODO_PRESENTATION: Record<TodoStatus, PresentationStatus> = {
  pending: "waiting",
  in_progress: "active",
  completed: "succeeded",
  abandoned: "cancelled",
  blocked: "blocked",
};

/** A phase header row of the todo view. */
export interface TodoHeaderLine {
  kind: "header";
  /** The phase name (verbatim identity). */
  name: string;
  /** The one-based phase ordinal within the plan. */
  index: number;
  /** Closed (completed or abandoned) tasks within the phase. */
  done: number;
  /** Total tasks within the phase. */
  total: number;
  /** Whether this is the phase currently being worked on. */
  active: boolean;
  /** Whether every task in the phase is closed (settled work). */
  settled: boolean;
  /** The structural fold glyph (`▾` expanded / `▸` collapsed). */
  fold: string;
  /** The rendered header text (`<fold> <name>  <done>/<total>`). */
  text: string;
  /** The header's semantic hue. */
  hue: DisplayHue;
}

/** A single task row of the todo view. */
export interface TodoTaskViewLine {
  kind: "task";
  /** The task content (verbatim identity). */
  content: string;
  /** The task status. */
  status: TodoStatus;
  /** The status glyph (empty when the spinner flag is set). */
  glyph: string;
  /** The status hue. */
  hue: DisplayHue;
  /** Whether the glyph is the animated spinner (host drives the frame char). */
  spinner: boolean;
  /** Whether the task text renders strikethrough. */
  strikethrough: boolean;
  /** The blocker note for a blocked task, when one is set. */
  blocker?: string;
  /** The rendered task text (content, plus the blocker note when set). */
  text: string;
}

/** A `+N` summary row standing in for work a surface's budget dropped. */
export interface TodoOverflowLine {
  kind: "overflow";
  /** How many tasks the row summarizes. */
  count: number;
  /** The rendered text (e.g. `+3 more`). */
  text: string;
  /** The overflow row's semantic hue. */
  hue: DisplayHue;
}

/** The single-line collapsed summary of the whole plan. */
export interface TodoSummaryLine {
  kind: "summary";
  /** Closed (completed or abandoned) tasks across the whole plan. */
  done: number;
  /** Total tasks across the whole plan. */
  total: number;
  /** The current task content (`in_progress`, else earliest `pending`). */
  current?: string;
  /** The rendered single-line text. */
  text: string;
  /** The summary's semantic hue. */
  hue: DisplayHue;
}

/** Any row the todo view model can emit. */ export type TodoViewLine =
  | TodoHeaderLine
  | TodoTaskViewLine
  | TodoOverflowLine
  | TodoSummaryLine;

/** Whether a task is settled (completed or abandoned). */
function isClosed(item: TodoItem): boolean {
  return item.status === "completed" || item.status === "abandoned";
}

/** Whether a task is still open work (pending, in progress, or blocked). */
function isOpen(item: TodoItem): boolean {
  return (
    item.status === "pending" ||
    item.status === "in_progress" ||
    item.status === "blocked"
  );
}

/**
 * The index of the phase currently being worked on.
 *
 * Prefers a phase holding an `in_progress` task; otherwise the phase holding
 * the earliest `pending` task.  Returns `-1` when no phase holds open work
 * (the whole plan is settled).
 *
 * @param phases - Todo phases to scan.
 * @returns The active phase index, or `-1`.
 */
function activePhaseIndex(phases: readonly TodoPhase[]): number {
  for (let i = 0; i < phases.length; i++) {
    if (phases[i].tasks.some((task) => task.status === "in_progress")) {
      return i;
    }
  }
  for (let i = 0; i < phases.length; i++) {
    if (phases[i].tasks.some((task) => task.status === "pending")) return i;
  }
  return -1;
}

/** Build a task view row from a task and its canonical presentation. */
function taskLine(item: TodoItem): TodoTaskViewLine {
  const presentation = STATUS_PRESENTATION[TODO_PRESENTATION[item.status]];
  const blocker =
    item.status === "blocked" && item.blocker !== undefined
      ? item.blocker
      : undefined;
  return {
    kind: "task",
    content: item.content,
    status: item.status,
    glyph: presentation.glyph,
    hue: presentation.hue,
    spinner: presentation.spinner === true,
    // A settled row's strikethrough is a todo-domain extra: only completed
    // work is crossed out; the canonical table carries no such flag.
    strikethrough: item.status === "completed",
    ...(blocker !== undefined ? { blocker } : {}),
    text: blocker !== undefined ? `${item.content} — ${blocker}` : item.content,
  };
}

/**
 * Build a phase header view row.
 *
 * @param phase - The phase the header names.
 * @param index - The one-based phase ordinal within the plan.
 * @param active - Whether the phase currently holds the active work.
 * @param enumerated - Whether the phase's task rows follow the header.
 */
function headerLine(
  phase: TodoPhase,
  index: number,
  active: boolean,
  enumerated: boolean,
): TodoHeaderLine {
  const done = phase.tasks.filter(isClosed).length;
  const total = phase.tasks.length;
  const fold = enumerated ? FOLD_EXPANDED : FOLD_COLLAPSED;
  return {
    kind: "header",
    name: phase.name,
    index,
    done,
    total,
    active,
    settled: done === total,
    fold,
    text: `${fold} ${phase.name}  ${done}/${total}`,
    hue: active ? "running" : "muted",
  };
}

/**
 * Build a `+N` overflow row summarizing hidden work.
 *
 * The row the todo domain contributes as `makeOverflow` to `fitToBudget`:
 * surfaces that clip the projected lines to a budget pass this builder so
 * dropped work is always discoverable, never silently cut.
 *
 * @param count - How many rows the overflow row stands in for.
 * @returns The `+N` overflow row.
 */
export function overflowLine(count: number): TodoOverflowLine {
  return { kind: "overflow", count, text: `+${count} more`, hue: "muted" };
}

/** Options for {@link todoLines}. */
export interface TodoLinesOptions {
  /**
   * Per-phase fold overrides (phase name → whether to enumerate its tasks).
   *
   * A phase's fold defaults to its settled status: a phase holding open work
   * enumerates, a settled phase collapses to its header.  A name in this map
   * overrides that default for that phase, in either direction.
   */
  foldOverrides?: ReadonlyMap<string, boolean>;
}

/**
 * Project a todo plan into its view rows.
 *
 * Every non-empty phase renders its header row.  A phase's fold defaults to
 * its settled status — one holding open work (pending, in progress, or
 * blocked) enumerates every one of its tasks in declaration order (closed
 * rows included, each keeping its `strikethrough` flag), while a settled
 * phase (tasks present, none open) renders its header alone.  A
 * `foldOverrides` entry (name → whether to enumerate) replaces that default
 * in either direction.  Task-less phases are skipped; an empty plan yields
 * no rows.
 *
 * @param phases - Todo phases to project.
 * @param opts - Per-phase fold overrides.
 * @returns The view rows (header / task) in display order.
 */
export function todoLines(
  phases: readonly TodoPhase[],
  opts: TodoLinesOptions = {},
): TodoViewLine[] {
  const overrides = opts.foldOverrides;
  const activeIdx = activePhaseIndex(phases);
  const lines: TodoViewLine[] = [];
  for (let i = 0; i < phases.length; i++) {
    const phase = phases[i];
    if (phase.tasks.length === 0) continue;
    const settled = !phase.tasks.some(isOpen);
    const enumerated = overrides?.get(phase.name) ?? !settled;
    lines.push(headerLine(phase, i + 1, i === activeIdx, enumerated));
    if (enumerated) {
      for (const item of phase.tasks) lines.push(taskLine(item));
    }
  }
  return lines;
}

/**
 * Project a single-line collapsed summary of the whole plan.
 *
 * Layout: `<done>/<total> done` followed by the current open task's content
 * (`in_progress`, else the earliest `pending`).  When no task is open the
 * line shows only the count.  `done` counts closed work (completed or
 * abandoned), mirroring the state machine's summary convention.
 *
 * @param phases - Todo phases to summarize.
 * @returns The single-line summary row.
 */
export function collapsedSummaryLine(
  phases: readonly TodoPhase[],
): TodoSummaryLine {
  const tasks = phases.flatMap((phase) => phase.tasks);
  const done = tasks.filter(isClosed).length;
  const total = tasks.length;
  const current =
    tasks.find((task) => task.status === "in_progress") ??
    tasks.find((task) => task.status === "pending");
  const currentContent = current?.content;
  return {
    kind: "summary",
    done,
    total,
    ...(currentContent !== undefined ? { current: currentContent } : {}),
    text:
      currentContent !== undefined
        ? `${done}/${total} done — ${currentContent}`
        : `${done}/${total} done`,
    hue: current?.status === "in_progress" ? "running" : "muted",
  };
}
