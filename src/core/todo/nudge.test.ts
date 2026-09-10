/**
 * Tests for the todo nudge decision (`nudge.ts`).
 *
 * Locks the pure tier semantics over flattened task views: the empty-list
 * silence, the resume tier when no active work remains (including mixes of
 * settled statuses), the done tier for a lone in-progress task, and the
 * progress tier for every other active configuration. Blocked, abandoned,
 * and completed tasks must never disturb the active counts.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { decideTodoNudge } from "./nudge.js";
import type { TodoItemView, TodoStatus } from "./types.js";

/** Build a task view from a status (content is irrelevant to the decision). */
function item(status: TodoStatus): TodoItemView {
  return { content: `task-${status}`, status };
}

describe("decideTodoNudge", () => {
  it("returns null for an empty list", () => {
    assert.equal(decideTodoNudge([]), null);
  });

  it("returns resume when every task is completed", () => {
    assert.equal(
      decideTodoNudge([item("completed"), item("completed")]),
      "resume",
    );
  });

  it("returns resume when every task is abandoned", () => {
    assert.equal(
      decideTodoNudge([item("abandoned"), item("abandoned")]),
      "resume",
    );
  });

  it("returns resume when every task is blocked", () => {
    assert.equal(decideTodoNudge([item("blocked"), item("blocked")]), "resume");
  });

  it("returns resume for a mix of settled statuses with zero active", () => {
    assert.equal(
      decideTodoNudge([item("completed"), item("abandoned"), item("blocked")]),
      "resume",
    );
  });

  it("returns done for exactly one in-progress task and no pending", () => {
    assert.equal(decideTodoNudge([item("in_progress")]), "done");
  });

  it("returns done when settled tasks accompany a lone in-progress task", () => {
    assert.equal(
      decideTodoNudge([
        item("completed"),
        item("abandoned"),
        item("in_progress"),
      ]),
      "done",
    );
  });

  it("returns done when blocked tasks accompany a lone in-progress task", () => {
    assert.equal(
      decideTodoNudge([item("blocked"), item("in_progress")]),
      "done",
    );
  });

  it("returns progress for one in-progress task with pending work", () => {
    assert.equal(
      decideTodoNudge([item("in_progress"), item("pending"), item("pending")]),
      "progress",
    );
  });

  it("returns progress for two or more in-progress tasks", () => {
    assert.equal(
      decideTodoNudge([item("in_progress"), item("in_progress")]),
      "progress",
    );
  });

  it("returns progress when only pending tasks remain", () => {
    assert.equal(
      decideTodoNudge([item("pending"), item("pending")]),
      "progress",
    );
  });

  it("returns progress for pending work mixed with settled tasks", () => {
    assert.equal(
      decideTodoNudge([item("blocked"), item("completed"), item("pending")]),
      "progress",
    );
  });
});
