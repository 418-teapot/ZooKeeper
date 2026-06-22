/**
 * Direct unit tests for core/todo.ts.
 *
 * Tests `getTodoState()` in isolation: empty lists, single in_progress items,
 * mixed statuses, and API failure. Verifies `inProgressCount` and
 * `pendingCount` are computed correctly.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getTodoState, type TinyClient } from "./todo.js";

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

/**
 * Build a mock TinyClient whose `session.todo` resolves to the given items.
 */
function mockClient(
  items: Array<{
    content: string;
    status: string;
    priority: string;
    id: string;
  }>,
): TinyClient {
  return {
    session: {
      todo: async () => ({ data: items }),
    },
  };
}

/**
 * Build a mock TinyClient whose `session.todo` always rejects.
 */
function failingClient(): TinyClient {
  return {
    session: {
      todo: async () => {
        throw new Error("API failure");
      },
    },
  };
}

// ---------------------------------------------------------------------------
// getTodoState
// ---------------------------------------------------------------------------

describe("getTodoState", () => {
  it("returns zero counts for an empty todo list", async () => {
    const client = mockClient([]);
    const state = await getTodoState(client, "s1");
    assert.deepEqual(state.todos, []);
    assert.equal(state.inProgressCount, 0);
    assert.equal(state.pendingCount, 0);
  });

  it("returns correct counts for a single in_progress item", async () => {
    const client = mockClient([
      { content: "Fix auth", status: "in_progress", priority: "high", id: "1" },
    ]);
    const state = await getTodoState(client, "s1");
    assert.equal(state.todos.length, 1);
    assert.equal(state.inProgressCount, 1);
    assert.equal(state.pendingCount, 0);
  });

  it("returns correct counts for a single pending item", async () => {
    const client = mockClient([
      { content: "Refactor", status: "pending", priority: "low", id: "1" },
    ]);
    const state = await getTodoState(client, "s1");
    assert.equal(state.todos.length, 1);
    assert.equal(state.inProgressCount, 0);
    assert.equal(state.pendingCount, 1);
  });

  it("handles mixed statuses correctly", async () => {
    const client = mockClient([
      { content: "Task A", status: "in_progress", priority: "high", id: "1" },
      { content: "Task B", status: "in_progress", priority: "medium", id: "2" },
      { content: "Task C", status: "pending", priority: "low", id: "3" },
      { content: "Task D", status: "completed", priority: "high", id: "4" },
      { content: "Task E", status: "cancelled", priority: "medium", id: "5" },
    ]);
    const state = await getTodoState(client, "s1");
    assert.equal(state.todos.length, 5);
    assert.equal(state.inProgressCount, 2);
    assert.equal(state.pendingCount, 1);
  });

  it("treats only in_progress as in_progress (not completed/cancelled)", async () => {
    const client = mockClient([
      { content: "Done", status: "completed", priority: "high", id: "1" },
      { content: "Cancelled", status: "cancelled", priority: "low", id: "2" },
    ]);
    const state = await getTodoState(client, "s1");
    assert.equal(state.inProgressCount, 0);
    assert.equal(state.pendingCount, 0);
  });

  it("rejects when the todo API fails", async () => {
    const client = failingClient();
    await assert.rejects(async () => getTodoState(client, "s1"), /API failure/);
  });
});
