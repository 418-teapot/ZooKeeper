/**
 * Todo capability port.
 *
 * Pure types: the per-session todo state store the `todo` tool reads and
 * writes plus its optional transcript-card renderer.  The file imports
 * types only — never an implementation.
 *
 * @module
 */

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
}
