/**
 * Todo capability port.
 *
 * Pure types: the per-session todo state store the `todo` tool reads and
 * writes, and the read-only `TodoSource` the progress checks consume.  The
 * file imports types only — never an implementation.
 *
 * @module
 */

import type { TodoSource } from "../todo/source.js";
import type { TodoStateStore } from "../todo/store.js";

/**
 * The todo-store operations the todo tool calls: restore on a cache miss,
 * store the new state, and run the read-modify-write cycle under the gate.
 *
 * Cache invalidation belongs to the host adapter — a consumer never reaches
 * it.
 */
export type TodoStateAccess = Pick<TodoStateStore, "get" | "set" | "serialize">;

/** The todo capability. */
export interface TodoPort {
  /**
   * Per-session todo state store.
   *
   * Owned by the host-extension instance that created it: each session
   * (main or subagent child) gets the store backed by its own transcript,
   * so a cache miss can never scan another session.  The todo tool reads
   * and writes state exclusively through it; the host invalidates entries
   * when transcript navigation changes the active branch — that operation
   * stays behind the port, with the adapter that owns it.
   *
   * Absent on hosts that supply no store — the todo tool unit then
   * contributes no tools.
   */
  todoStore: TodoStateAccess;
  /**
   * Read-only todo source the progress checks consume.
   *
   * Bound once by the host assembly — OpenCode wraps its client's
   * `session.todo` read, pi wraps the per-session state store — so no
   * consumer ever selects a backend at read time.
   *
   * Absent on hosts that cannot read todo state at all.  A hook listing
   * it in `needs` then never activates (fail-closed); one listing it in
   * `wants` keeps running without todo context.
   */
  todoSource: TodoSource;
}
