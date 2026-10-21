/**
 * Todo capability port.
 *
 * Pure types: the per-session todo state store the `todo` tool reads and
 * writes, its optional transcript-card renderer, and the optional
 * read-only `TodoSource` the progress checks consume.  The file imports
 * types only — never an implementation.
 *
 * @module
 */

import type { TodoSource } from "../todo/source.js";
import type { TodoStateStore } from "../todo/store.js";
import type { ToolCardRenderer } from "./subagent.js";

/** The todo capability. */
export interface TodoPort {
  /**
   * Per-session todo state store.
   *
   * Owned by the host-extension instance that created it: each session
   * (main or subagent child) gets the store backed by its own transcript,
   * so a cache miss can never scan another session.  The todo tool reads
   * and writes state exclusively through it; the host invalidates entries
   * when transcript navigation changes the active branch.
   *
   * Absent on hosts that supply no store — the todo tool unit then
   * contributes no tools.
   */
  todoStore: TodoStateStore;
  /**
   * Optional host renderer for the todo tool card.
   *
   * When present the tool attaches its `renderCall` / `renderResult`
   * callbacks so the host TUI draws the todo list as a transcript card
   * instead of the plain summary text.
   */
  todoRenderer: ToolCardRenderer;
  /**
   * Read-only todo source the progress checks consume.
   *
   * Bound once by the host assembly — OpenCode wraps its client's
   * `session.todo` read, pi wraps the per-session state store — so no
   * consumer ever selects a backend at read time.
   *
   * Absent on hosts that cannot read todo state at all.  A hook listing
   * it in `needs` then never activates (fail-closed); one listing it in
   * `wants` keeps running without todo context, exactly as if the list
   * were empty.
   */
  todoSource?: TodoSource;
}
