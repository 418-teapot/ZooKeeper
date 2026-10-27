/**
 * Tests for the pi todo session catalog (`todo-sessions.ts`).
 *
 * The catalog is what the product composition receives: a
 * `TodoStateStore`-shaped port that routes every call to the store of the
 * session it names.  The assertions drive that port the way the todo tool
 * and the progress hooks do, so the test reads which session's state a call
 * reached rather than how the catalog keeps it.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { TodoPhase } from "../../core/todo/types.js";
import { createPiTodoSessions } from "./todo-sessions.js";

/** A one-phase state with the given task contents. */
function phase(name: string, contents: string[]): TodoPhase {
  return {
    name,
    tasks: contents.map((content) => ({ content, status: "pending" })),
  };
}

/** Collect the session ids whose transcript the candidate source scanned. */
function recordingSource() {
  const scans: string[] = [];
  return {
    scans,
    fetch: async (sessionID: string) => {
      scans.push(sessionID);
      return [];
    },
  };
}

describe("pi todo sessions", () => {
  it("keeps each session's state separate", async () => {
    const source = recordingSource();
    const todo = createPiTodoSessions(source.fetch);
    todo.own("s1");
    todo.own("s2");

    todo.set("s1", [phase("First", ["a"])]);
    todo.set("s2", [phase("Second", ["b"])]);

    assert.deepEqual(await todo.get("s1"), [phase("First", ["a"])]);
    assert.deepEqual(await todo.get("s2"), [phase("Second", ["b"])]);
    assert.deepEqual(source.scans, [], "a cached session never re-scans");
  });

  it("drops only the invalidated session's cache", async () => {
    const source = recordingSource();
    const todo = createPiTodoSessions(source.fetch);
    todo.own("s1");
    todo.own("s2");
    todo.set("s1", [phase("First", ["a"])]);
    todo.set("s2", [phase("Second", ["b"])]);

    todo.invalidate("s1");

    // The invalidated session restores from its transcript again; its
    // sibling keeps the state it had.
    assert.deepEqual(await todo.get("s1"), []);
    assert.deepEqual(source.scans, ["s1"]);
    assert.deepEqual(await todo.get("s2"), [phase("Second", ["b"])]);
  });

  it("keeps no state for a session its catalog never bound", async () => {
    const source = recordingSource();
    const todo = createPiTodoSessions(source.fetch);

    // The read contract still restores from the transcript, but nothing is
    // cached for a session no scope owns: a write cannot pin state and the
    // next read scans again.
    assert.deepEqual(await todo.get("ghost"), []);
    todo.set("ghost", [phase("Ghost", ["x"])]);
    todo.invalidate("ghost");

    assert.deepEqual(await todo.get("ghost"), []);
    assert.deepEqual(source.scans, ["ghost", "ghost"]);
  });

  it("releases a session's state when its scope stops", async () => {
    const source = recordingSource();
    const todo = createPiTodoSessions(source.fetch);
    const handle = todo.own("s1");
    todo.set("s1", [phase("First", ["a"])]);
    assert.deepEqual(await todo.get("s1"), [phase("First", ["a"])]);

    handle.dispose();

    // The scope is gone, so its state is too: the next read restores from
    // the transcript again (uncached) and a write no longer sticks.
    assert.deepEqual(await todo.get("s1"), [], "the cached state is gone");
    todo.set("s1", [phase("Ghost", ["x"])]);
    assert.deepEqual(await todo.get("s1"), []);
  });

  it("serialises changes across sessions through one gate", async () => {
    const source = recordingSource();
    const todo = createPiTodoSessions(source.fetch);
    todo.own("s1");
    todo.own("s2");
    todo.set("s1", [phase("First", ["a"])]);
    todo.set("s2", [phase("Second", ["b"])]);
    const order: string[] = [];

    const slow = todo.serialize(async () => {
      const before = await todo.get("s1");
      await new Promise((resolve) => setTimeout(resolve, 5));
      order.push(`slow:${before.length}`);
      todo.set("s1", [...before, phase("Added", ["x"])]);
    });
    const fast = todo.serialize(async () => {
      const before = await todo.get("s1");
      order.push(`fast:${before.length}`);
    });

    await Promise.all([slow, fast]);

    // The queued change read the state the first one wrote: two concurrent
    // todo calls can never lose an update.
    assert.deepEqual(order, ["slow:1", "fast:2"]);
  });

  it("reports a failed change to its own caller only", async () => {
    const source = recordingSource();
    const todo = createPiTodoSessions(source.fetch);
    todo.own("s1");

    await assert.rejects(
      todo.serialize(async () => {
        throw new Error("write failed");
      }),
      /write failed/,
    );

    assert.equal(await todo.serialize(async () => "ok"), "ok");
  });
});
