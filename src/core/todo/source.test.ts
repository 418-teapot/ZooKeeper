/**
 * Direct unit tests for core/todo/source.ts.
 *
 * Covers the store-backed `TodoSource` adapter: flattening phases into a
 * single ordered view, carrying the blocker note, per-session isolation,
 * and the empty view for a session with no phases.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { todoSourceFromStore } from "./source.js";
import type { TodoStateStore } from "./store.js";
import type { TodoPhase } from "./types.js";

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
    serialize<T>(fn: () => Promise<T>): Promise<T> {
      return fn();
    },
  };
}

describe("todoSourceFromStore", () => {
  it("flattens multiple phases preserving order and carries blocker", async () => {
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
      {
        content: "Wait for API",
        status: "blocked",
        blocker: "missing key",
      },
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
