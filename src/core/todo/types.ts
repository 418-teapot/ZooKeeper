/**
 * Core todo types: the five-status task model, the nine-operation vocabulary,
 * and the entry/phase shapes consumed by the todo state machine.
 *
 * Pure declarations plus identity helpers (guards, deep cloning). No logic
 * that mutates or interprets state lives here.
 *
 * @module
 */

/** Status of a single todo task. */
export type TodoStatus =
  | "pending"
  | "in_progress"
  | "completed"
  | "abandoned"
  | "blocked";

/** Operations accepted by the todo state machine. */
export type TodoOperation =
  | "init"
  | "start"
  | "done"
  | "rm"
  | "drop"
  | "block"
  | "unblock"
  | "append"
  | "view";

/** A single todo task, addressed exclusively by its exact content text. */
export interface TodoItem {
  /** Identity key: matched verbatim, never trimmed or normalized. */
  content: string;
  status: TodoStatus;
  /** Why the task is blocked; required (and whitespace-collapsed) when blocked. */
  blocker?: string;
}

/** A named group of tasks within the todo list. */
export interface TodoPhase {
  name: string;
  tasks: TodoItem[];
}

/**
 * Flattened, phase-agnostic view of a single todo entry.
 *
 * Consumed by progress checks that only need content and status,
 * regardless of which source (state store or host client) produced it.
 */
export interface TodoItemView {
  content: string;
  status: TodoStatus;
}

/** One phase entry of a canonical `init` list. */
export interface TodoInitPhase {
  phase: string;
  tasks: string[];
}

/** One operation entry targeting the todo state machine. */
export interface TodoEntry {
  op: TodoOperation;
  /** Canonical phased list for `init`. */
  list?: TodoInitPhase[];
  /** Flat contents for a single-phase `init`, or the payload of `append`. */
  tasks?: string[];
  /** Phase name for a flattened `init`, the `append` target, or a phase target. */
  phase?: string;
  /** Single task target by exact content text. */
  task?: string;
  /** Blocker note for `block` (whitespace-collapsed when stored). */
  reason?: string;
}

/**
 * Whether a value is one of the five known task statuses.
 *
 * @param value - Value to test.
 * @returns True when the value is a known status string.
 */
export function isTodoStatus(value: unknown): value is TodoStatus {
  return (
    value === "pending" ||
    value === "in_progress" ||
    value === "completed" ||
    value === "abandoned" ||
    value === "blocked"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Whether an unknown value is a structurally valid persisted todo phase.
 *
 * Every task must carry a string `content` and one of the five known
 * statuses; anything else fails the guard.
 *
 * @param value - Value to test.
 * @returns True when the value is a valid `TodoPhase`.
 */
export function isTodoPhase(value: unknown): value is TodoPhase {
  if (
    !isRecord(value) ||
    typeof value.name !== "string" ||
    !Array.isArray(value.tasks)
  ) {
    return false;
  }
  return value.tasks.every(
    (task) =>
      isRecord(task) &&
      typeof task.content === "string" &&
      isTodoStatus(task.status),
  );
}

function cloneTask(item: TodoItem): TodoItem {
  return item.blocker !== undefined
    ? { content: item.content, status: item.status, blocker: item.blocker }
    : { content: item.content, status: item.status };
}

/**
 * Deep-clone a todo list so mutations never leak into the origin state.
 *
 * @param phases - Todo phases to clone.
 * @returns A structurally independent copy.
 */
export function clonePhases(phases: readonly TodoPhase[]): TodoPhase[] {
  return phases.map((phase) => ({
    name: phase.name,
    tasks: phase.tasks.map(cloneTask),
  }));
}
