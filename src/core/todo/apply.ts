/**
 * Operation semantics of the todo state machine.
 *
 * Every op entry is validated before it mutates anything, and a whole batch
 * is atomic: if any entry reports an error the batch is discarded wholesale,
 * the input state is returned unchanged, and every error is reported.
 *
 * Tasks are addressed exclusively by verbatim content equality — synthetic
 * IDs like `task-1` are rejected with an explicit corrective message.
 * `init` accepts both the canonical `list` shape and a flattened
 * `items` (+ optional `phase`) shape; a repeated `init` replaces the whole
 * list (restart semantics).
 *
 * @module
 */

import { normalizePhases } from "./normalize.js";
import type { TodoEntry, TodoInitPhase, TodoItem, TodoPhase } from "./types.js";
import { clonePhases } from "./types.js";

/** Result of applying a batch of entries. */
export interface ApplyResult {
  /** The resulting state, a fresh clone; unchanged from the input on error. */
  phases: TodoPhase[];
  /** All errors from the batch; non-empty means nothing was applied. */
  errors: string[];
}

/** Phase name used for a flattened `init` with no explicit `phase`. */
const DEFAULT_INIT_PHASE = "Todos";

/** Target-looking strings treated as synthetic-ID references. */
const TASK_ID_PATTERN = /^task-\d+$/i;

/**
 * Apply a batch of op entries to a todo state.
 *
 * Entries are applied in order against a working clone. Any error aborts the
 * batch: the input state is returned untouched and every collected error is
 * reported. On a clean batch the result is normalized (single point of
 * normalization) as the pipeline's postcondition.
 *
 * @param state - Current todo phases (never mutated).
 * @param entries - Op entries to apply.
 * @returns The new state and the collected errors.
 */
export function applyEntries(
  state: readonly TodoPhase[],
  entries: readonly TodoEntry[],
): ApplyResult {
  const work = clonePhases(state);
  const errors: string[] = [];

  for (const entry of entries) {
    applyEntry(work, entry, errors);
  }

  if (errors.length > 0) {
    return { phases: clonePhases(state), errors };
  }

  normalizePhases(work);
  return { phases: work, errors: [] };
}

function applyEntry(
  phases: TodoPhase[],
  entry: TodoEntry,
  errors: string[],
): void {
  switch (entry.op) {
    case "init":
      applyInit(phases, entry, errors);
      break;
    case "start":
      applyStart(phases, entry, errors);
      break;
    case "done":
      applyDoneDrop(phases, entry, errors, "completed");
      break;
    case "drop":
      applyDoneDrop(phases, entry, errors, "abandoned");
      break;
    case "rm":
      applyRm(phases, entry, errors);
      break;
    case "block":
      applyBlock(phases, entry, errors);
      break;
    case "unblock":
      applyUnblock(phases, entry, errors);
      break;
    case "append":
      applyAppend(phases, entry, errors);
      break;
    case "view":
      // Read-only: the state is echoed back without any change.
      break;
    default:
      errors.push(`Unknown operation "${entry.op}"`);
      break;
  }
}

function findTaskByContent(
  phases: readonly TodoPhase[],
  content: string,
): { task: TodoItem; phase: TodoPhase } | undefined {
  for (const phase of phases) {
    const task = phase.tasks.find((candidate) => candidate.content === content);
    if (task) return { task, phase };
  }
  return undefined;
}

function taskNotFoundError(
  phases: readonly TodoPhase[],
  content: string,
): string {
  if (TASK_ID_PATTERN.test(content)) {
    return `Task "${content}" not found. Tasks are addressed by their exact content text, not by IDs — pass the task's full content from the previous result.`;
  }
  const total = phases.reduce((sum, phase) => sum + phase.tasks.length, 0);
  const hint =
    total === 0
      ? " (todo list is empty — was it replaced or not yet created?)"
      : "";
  return `Task "${content}" not found${hint}`;
}

function hasTargetField(entry: TodoEntry): boolean {
  return (
    entry.task !== undefined ||
    entry.tasks !== undefined ||
    entry.phase !== undefined
  );
}

/**
 * Resolve the task targets of an entry by exact content equality, pushing
 * errors and returning `null` on any failure so callers never mutate
 * partially.
 *
 * `allowDefault` lets a target-less entry mean "every task" (used by
 * `done`/`drop`/`rm`); otherwise a missing target is itself an error.
 */
function resolveTargets(
  phases: TodoPhase[],
  entry: TodoEntry,
  errors: string[],
  allowDefault: boolean,
): TodoItem[] | null {
  const { task, tasks, phase } = entry;
  const provided = [
    task !== undefined,
    tasks !== undefined,
    phase !== undefined,
  ].filter(Boolean).length;

  if (provided > 1) {
    errors.push(
      'Ambiguous target: provide only one of "task", "tasks", or "phase"',
    );
    return null;
  }

  if (task !== undefined) {
    const hit = findTaskByContent(phases, task);
    if (!hit) {
      errors.push(taskNotFoundError(phases, task));
      return null;
    }
    return [hit.task];
  }

  if (tasks !== undefined) {
    if (tasks.length === 0) {
      errors.push(`Empty task list for ${entry.op} operation`);
      return null;
    }
    const found: TodoItem[] = [];
    let missing = false;
    for (const content of tasks) {
      const hit = findTaskByContent(phases, content);
      if (hit) {
        found.push(hit.task);
      } else {
        errors.push(taskNotFoundError(phases, content));
        missing = true;
      }
    }
    return missing ? null : found;
  }

  if (phase !== undefined) {
    const named = phases.find((candidate) => candidate.name === phase);
    if (!named) {
      errors.push(`Phase "${phase}" not found`);
      return null;
    }
    return [...named.tasks];
  }

  if (allowDefault) return phases.flatMap((candidate) => candidate.tasks);
  return null;
}

/**
 * Resolve the source list of an `init`: canonical `list`, or a synthesized
 * single-phase list from flat `items` (default phase "Todos").
 */
function resolveInitList(entry: TodoEntry): TodoInitPhase[] | undefined {
  if (entry.list !== undefined) return entry.list;
  if (Array.isArray(entry.items) && entry.items.length > 0) {
    return [{ phase: entry.phase ?? DEFAULT_INIT_PHASE, items: entry.items }];
  }
  return undefined;
}

function applyInit(
  phases: TodoPhase[],
  entry: TodoEntry,
  errors: string[],
): void {
  const list = resolveInitList(entry);
  if (!list) {
    errors.push("Missing list for init operation");
    return;
  }

  // Duplicate phase names or task contents would be permanently unaddressable
  // (content targeting always resolves the first match), so the whole batch
  // is rejected up front and nothing is replaced. Each entry is also guarded
  // structurally: a malformed `list` entry (missing or mistyped fields, or
  // non-string items) is reported as an error and never thrown, keeping the
  // batch atomic.
  const seenPhases = new Set<string>();
  const seenTasks = new Set<string>();
  let invalid = false;
  for (const listEntry of list) {
    const phaseName =
      typeof listEntry.phase === "string" ? listEntry.phase : undefined;
    const items = Array.isArray(listEntry.items) ? listEntry.items : undefined;
    if (phaseName === undefined || items === undefined) {
      errors.push(
        "Malformed init list entry: expected { phase: string, items: string[] }",
      );
      invalid = true;
      continue;
    }
    if (items.some((content) => typeof content !== "string")) {
      errors.push(`Phase "${phaseName}" contains non-string items`);
      invalid = true;
      continue;
    }
    if (items.length === 0) {
      errors.push(`Phase "${phaseName}" contains no items`);
      invalid = true;
    }
    if (seenPhases.has(phaseName)) {
      errors.push(`Duplicate phase "${phaseName}" in init list`);
      invalid = true;
    }
    seenPhases.add(phaseName);
    for (const content of items) {
      if (seenTasks.has(content)) {
        errors.push(`Duplicate task "${content}" in init list`);
        invalid = true;
      }
      seenTasks.add(content);
    }
  }
  if (invalid) return;

  const replacement = list.map((listEntry) => ({
    name: listEntry.phase,
    tasks: listEntry.items.map<TodoItem>((content) => ({
      content,
      status: "pending",
    })),
  }));
  phases.splice(0, phases.length, ...replacement);
}

function applyStart(
  phases: TodoPhase[],
  entry: TodoEntry,
  errors: string[],
): void {
  if (entry.task === undefined) {
    errors.push("Missing task content");
    return;
  }
  const hit = findTaskByContent(phases, entry.task);
  if (!hit) {
    errors.push(taskNotFoundError(phases, entry.task));
    return;
  }
  if (hit.task.status === "completed" || hit.task.status === "abandoned") {
    errors.push(
      `Cannot start "${hit.task.content}": the task is completed or abandoned`,
    );
    return;
  }
  if (hit.task.status === "blocked") {
    errors.push(
      `Cannot start "${hit.task.content}": the task is blocked — unblock it first`,
    );
    return;
  }

  // Only the named task stays active; any other in-progress task falls back.
  for (const phase of phases) {
    for (const candidate of phase.tasks) {
      if (candidate.status === "in_progress" && candidate !== hit.task) {
        candidate.status = "pending";
      }
    }
  }
  hit.task.status = "in_progress";
}

function applyDoneDrop(
  phases: TodoPhase[],
  entry: TodoEntry,
  errors: string[],
  status: "completed" | "abandoned",
): void {
  const targets = resolveTargets(phases, entry, errors, true);
  if (!targets) return;
  for (const task of targets) {
    task.status = status;
  }
}

function applyRm(
  phases: TodoPhase[],
  entry: TodoEntry,
  errors: string[],
): void {
  // With no targets the whole list is cleared; with a phase target that
  // phase's tasks are removed; with task contents those tasks are removed.
  const targets = resolveTargets(phases, entry, errors, true);
  if (!targets) return;
  const doomed = new Set(targets);
  for (const phase of phases) {
    phase.tasks = phase.tasks.filter((task) => !doomed.has(task));
  }
}

function applyBlock(
  phases: TodoPhase[],
  entry: TodoEntry,
  errors: string[],
): void {
  if (!hasTargetField(entry)) {
    errors.push("block requires a task, tasks, or phase target");
    return;
  }
  const targets = resolveTargets(phases, entry, errors, false);
  if (!targets) return;

  // Collapse whitespace runs (incl. newlines) to single spaces so the note
  // stays one-line-safe for every consumer; an empty collapsed note is an
  // error because the design requires every block to carry a reason.
  const reason =
    entry.reason === undefined ? "" : entry.reason.replace(/\s+/g, " ").trim();
  if (reason === "") {
    errors.push("Missing reason for block operation");
    return;
  }

  // Only actionable open work can be blocked: blocking must never reopen
  // completed/abandoned tasks or erase finished progress. An already-blocked
  // task stays eligible so a later block can refine its note.
  for (const task of targets) {
    if (
      task.status === "pending" ||
      task.status === "in_progress" ||
      task.status === "blocked"
    ) {
      task.status = "blocked";
      task.blocker = reason;
    }
  }
}

function applyUnblock(
  phases: TodoPhase[],
  entry: TodoEntry,
  errors: string[],
): void {
  if (!hasTargetField(entry)) {
    errors.push("unblock requires a task, tasks, or phase target");
    return;
  }
  const targets = resolveTargets(phases, entry, errors, false);
  if (!targets) return;
  for (const task of targets) {
    if (task.status === "blocked") {
      task.status = "pending";
      task.blocker = undefined;
    }
  }
}

function applyAppend(
  phases: TodoPhase[],
  entry: TodoEntry,
  errors: string[],
): void {
  if (!entry.phase) {
    errors.push("Missing phase name for append operation");
    return;
  }
  if (!Array.isArray(entry.items) || entry.items.length === 0) {
    errors.push("Missing items for append operation");
    return;
  }
  if (entry.items.some((content) => typeof content !== "string")) {
    errors.push(
      "Malformed items for append operation: expected an array of strings",
    );
    return;
  }

  // Validate against the whole list and the batch itself before mutating, so
  // a failing append reports every duplicate and leaves nothing half-applied.
  const seen = new Set<string>();
  let hasDuplicate = false;
  for (const content of entry.items) {
    if (seen.has(content) || findTaskByContent(phases, content)) {
      errors.push(`Task "${content}" already exists`);
      hasDuplicate = true;
    }
    seen.add(content);
  }
  if (hasDuplicate) return;

  let phase = phases.find((candidate) => candidate.name === entry.phase);
  if (!phase) {
    phase = { name: entry.phase, tasks: [] };
    phases.push(phase);
  }
  for (const content of entry.items) {
    phase.tasks.push({ content, status: "pending" });
  }
}
