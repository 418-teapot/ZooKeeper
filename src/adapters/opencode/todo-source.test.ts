/**
 * Direct unit tests for adapters/opencode/todo-source.ts.
 *
 * Covers the OpenCode client-backed `TodoSource` adapter: the host status
 * vocabulary translation, dropping entries whose status is unrecognized,
 * the session id passed to the host, empty lists, and error propagation.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  type HostTodoItem,
  type TinyClient,
  todoSourceFromClient,
} from "./todo-source.js";

/**
 * Build a mock client whose `session.todo` resolves to the given items.
 *
 * @param items - Host-shaped todo items to return.
 * @returns A mock `TinyClient`.
 */
function mockClient(items: HostTodoItem[]): TinyClient {
  return {
    session: {
      todo: async () => ({ data: items }),
    },
  };
}

/**
 * Build a mock client whose `session.todo` always rejects.
 *
 * @returns A mock `TinyClient` that throws on every read.
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

describe("todoSourceFromClient", () => {
  it("maps cancelled to abandoned and passes other statuses through", async () => {
    const client = mockClient([
      { content: "Task A", status: "pending", priority: "low", id: "1" },
      {
        content: "Task B",
        status: "in_progress",
        priority: "high",
        id: "2",
      },
      {
        content: "Task C",
        status: "completed",
        priority: "medium",
        id: "3",
      },
      {
        content: "Task D",
        status: "cancelled",
        priority: "low",
        id: "4",
      },
    ]);
    const view = await todoSourceFromClient(client)("s1");
    assert.deepEqual(view, [
      { content: "Task A", status: "pending" },
      { content: "Task B", status: "in_progress" },
      { content: "Task C", status: "completed" },
      { content: "Task D", status: "abandoned" },
    ]);
  });

  it("drops items whose host status is unrecognized", async () => {
    const client = mockClient([
      {
        content: "Task A",
        status: "in_progress",
        priority: "high",
        id: "1",
      },
      { content: "Task B", status: "paused", priority: "low", id: "2" },
      { content: "Task C", status: "cancelled", priority: "low", id: "3" },
    ]);
    const view = await todoSourceFromClient(client)("s1");
    assert.deepEqual(view, [
      { content: "Task A", status: "in_progress" },
      { content: "Task C", status: "abandoned" },
    ]);
  });

  it("rejects when the underlying client fetch fails", async () => {
    const source = todoSourceFromClient(failingClient());
    await assert.rejects(async () => source("s1"), /API failure/);
  });

  it("returns an empty view when the session has no todo items", async () => {
    assert.deepEqual(await todoSourceFromClient(mockClient([]))("s1"), []);
  });

  it("queries the host with the requested session id", async () => {
    const requested: string[] = [];
    const client: TinyClient = {
      session: {
        todo: async (opts) => {
          requested.push(opts.path.id);
          return { data: [] };
        },
      },
    };
    const source = todoSourceFromClient(client);
    await source("s1");
    await source("s2");
    assert.deepEqual(requested, ["s1", "s2"]);
  });
});
