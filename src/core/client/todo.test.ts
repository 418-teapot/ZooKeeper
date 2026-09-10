/**
 * Direct unit tests for core/client/todo.ts.
 *
 * Covers the `TodoSource` adapters: store-backed flattening, phase order
 * preservation and per-session isolation, plus client-backed status
 * mapping, unrecognized-status dropping, session id pass-through and
 * error propagation, and the `resolveTodoSource` backend selection rule.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { TodoStateStore } from "../todo/store.js";
import type { TodoPhase } from "../todo/types.js";
import {
  resolveTodoSource,
  type TinyClient,
  todoSourceFromClient,
  todoSourceFromStore,
} from "./todo.js";

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
// Helpers for TodoSource adapters
// ---------------------------------------------------------------------------

/**
 * Build a fake TodoStateStore serving fixed phase lists per session id.
 */
function mockStore(
  phasesBySession: Record<string, TodoPhase[]>,
): TodoStateStore {
  return {
    async get(sessionId: string): Promise<TodoPhase[]> {
      return phasesBySession[sessionId] ?? [];
    },
    set(): void {
      /* unused by the read-only adapter */
    },
    invalidate(): void {
      /* unused by the read-only adapter */
    },
  };
}

// ---------------------------------------------------------------------------
// todoSourceFromStore
// ---------------------------------------------------------------------------

describe("todoSourceFromStore", () => {
  it("flattens multiple phases preserving order and drops blocker", async () => {
    const store = mockStore({
      s1: [
        {
          name: "Setup",
          tasks: [
            { content: "Init repo", status: "completed" },
            {
              content: "Wait for API",
              status: "blocked",
              blocker: "missing key",
            },
          ],
        },
        {
          name: "Implement",
          tasks: [
            { content: "Write code", status: "in_progress" },
            { content: "Add tests", status: "pending" },
          ],
        },
      ],
    });
    const view = await todoSourceFromStore(store)("s1");
    assert.deepEqual(view, [
      { content: "Init repo", status: "completed" },
      { content: "Wait for API", status: "blocked" },
      { content: "Write code", status: "in_progress" },
      { content: "Add tests", status: "pending" },
    ]);
  });

  it("serves two sessions independently without leakage", async () => {
    const store = mockStore({
      s1: [
        { name: "A", tasks: [{ content: "only in s1", status: "pending" }] },
      ],
      s2: [
        {
          name: "B",
          tasks: [
            { content: "first in s2", status: "completed" },
            { content: "second in s2", status: "abandoned" },
          ],
        },
      ],
    });
    const source = todoSourceFromStore(store);
    const view1 = await source("s1");
    const view2 = await source("s2");
    assert.deepEqual(view1, [{ content: "only in s1", status: "pending" }]);
    assert.deepEqual(view2, [
      { content: "first in s2", status: "completed" },
      { content: "second in s2", status: "abandoned" },
    ]);
  });

  it("returns an empty view for a session with no phases", async () => {
    const source = todoSourceFromStore(mockStore({}));
    assert.deepEqual(await source("missing"), []);
  });
});

// ---------------------------------------------------------------------------
// todoSourceFromClient
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// resolveTodoSource
// ---------------------------------------------------------------------------

describe("resolveTodoSource", () => {
  const storePhases: Record<string, TodoPhase[]> = {
    s1: [
      {
        name: "Implement",
        tasks: [{ content: "from the store", status: "in_progress" }],
      },
    ],
  };

  it("prefers the store when a capable client is also present", async () => {
    const clientCalled: string[] = [];
    const client: TinyClient = {
      session: {
        todo: async (opts) => {
          clientCalled.push(opts.path.id);
          return {
            data: [
              {
                content: "from the client",
                status: "pending",
                priority: "high",
                id: "1",
              },
            ],
          };
        },
      },
    };
    const source = resolveTodoSource({
      todoStore: mockStore(storePhases),
      client,
    });
    assert.ok(source, "a store-backed source must be resolved");
    assert.deepEqual(await source("s1"), [
      { content: "from the store", status: "in_progress" },
    ]);
    assert.deepEqual(clientCalled, [], "the client must not be read");
  });

  it("falls back to the client adapter when no store is supplied", async () => {
    const source = resolveTodoSource({
      client: mockClient([
        {
          content: "from the client",
          status: "cancelled",
          priority: "low",
          id: "1",
        },
      ]),
    });
    assert.ok(source, "a client-backed source must be resolved");
    assert.deepEqual(await source("s1"), [
      { content: "from the client", status: "abandoned" },
    ]);
  });

  it("fails closed for a client that does not expose session.todo", () => {
    assert.equal(
      resolveTodoSource({ client: {} as TinyClient }),
      null,
      "an incapable client must resolve to null",
    );
  });

  it("fails closed when neither store nor client is supplied", () => {
    assert.equal(resolveTodoSource({}), null);
    assert.equal(resolveTodoSource({ client: null }), null);
  });
});
