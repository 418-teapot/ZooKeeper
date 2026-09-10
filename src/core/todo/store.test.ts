/**
 * Unit tests for the per-session todo state store (src/core/todo/store).
 *
 * Locks the single restore path: one fetch per cache miss, none on a
 * hit, re-fetch after invalidation, `set` short-circuiting history,
 * corrupted candidates restoring to an empty list without throwing, and
 * a failed fetch recovering on the next access instead of poisoning
 * the cache. Also locks clone isolation between the cache and callers, and
 * the `serialize` gate that keeps concurrent state changes from
 * interleaving.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { TodoPhase } from "./types.js";

let fetchCount = 0;

/** Candidate source that counts calls and replays fixed candidates. */
function source(candidates: readonly unknown[]) {
  fetchCount = 0;
  return async (_sessionId: string) => {
    fetchCount += 1;
    return candidates;
  };
}

/** Build a phase object from [content, status] pairs. */
function phase(name: string, ...tasks: Array<[string, string]>): TodoPhase {
  return {
    name,
    tasks: tasks.map(([content, status]) => ({
      content,
      status,
    })) as TodoPhase["tasks"],
  };
}

/** A valid snapshot payload as found in tool-result details. */
const SNAPSHOT = {
  op: "init",
  phases: [{ name: "Todos", tasks: [{ content: "a", status: "pending" }] }],
};

// Restored states below show task "a" as `in_progress` because
// `restoreFromHistory` normalizes: the earliest pending task is promoted
// whenever nothing is active.

describe("createTodoStore", () => {
  it("restores once on a cache miss and caches the result", async () => {
    const { createTodoStore } = await import("./store.js");
    const store = createTodoStore(source([SNAPSHOT]));

    const got = await store.get("s1");
    assert.equal(fetchCount, 1);
    assert.deepEqual(got, [phase("Todos", ["a", "in_progress"])]);

    const again = await store.get("s1");
    assert.equal(fetchCount, 1, "cache hit must not re-fetch");
    assert.deepEqual(again, got);
  });

  it("re-restores after invalidate", async () => {
    const { createTodoStore } = await import("./store.js");
    const store = createTodoStore(source([SNAPSHOT]));

    await store.get("s1");
    store.invalidate("s1");
    const got = await store.get("s1");
    assert.equal(fetchCount, 2);
    assert.deepEqual(got, [phase("Todos", ["a", "in_progress"])]);
  });

  it("invalidate only drops the named session", async () => {
    const { createTodoStore } = await import("./store.js");
    const store = createTodoStore(source([SNAPSHOT]));

    await store.get("s1");
    await store.get("s2");
    assert.equal(fetchCount, 2);
    store.invalidate("s1");
    await store.get("s2");
    assert.equal(fetchCount, 2, "s2 cache entry must survive");
    await store.get("s1");
    assert.equal(fetchCount, 3);
  });

  it("set serves later reads without touching history", async () => {
    const { createTodoStore } = await import("./store.js");
    const store = createTodoStore(source([SNAPSHOT]));

    const written = [phase("Work", ["b", "in_progress"])];
    store.set("s1", written);
    const got = await store.get("s1");
    assert.equal(fetchCount, 0);
    assert.deepEqual(got, written);

    written[0].tasks[0].status = "pending";
    assert.equal(
      (await store.get("s1"))[0].tasks[0].status,
      "in_progress",
      "mutating the caller array must not leak into the cache",
    );
  });

  it("returned arrays are clones, not the cached state", async () => {
    const { createTodoStore } = await import("./store.js");
    const store = createTodoStore(source([SNAPSHOT]));

    const got = await store.get("s1");
    got[0].tasks[0].content = "corrupted";
    got.push(phase("extra"));
    assert.deepEqual(await store.get("s1"), [
      phase("Todos", ["a", "in_progress"]),
    ]);
  });

  it("garbage-only candidates restore an empty list without throwing", async () => {
    const { createTodoStore } = await import("./store.js");
    const store = createTodoStore(
      source(["nope", null, 42, { phases: "broken" }, []]),
    );

    assert.deepEqual(await store.get("s1"), []);
    assert.equal(fetchCount, 1, "the empty result is still cached");
  });

  it("a failed fetch yields empty without poisoning the cache", async () => {
    const { createTodoStore } = await import("./store.js");
    let fail = true;
    const store = createTodoStore(async () => {
      if (fail) throw new Error("history read failed");
      return [SNAPSHOT];
    });

    assert.deepEqual(await store.get("s1"), [], "failed fetch -> empty");
    fail = false;
    assert.deepEqual(await store.get("s1"), [
      phase("Todos", ["a", "in_progress"]),
    ]);
  });

  it("a rejected fetch also recovers on the next access", async () => {
    const { createTodoStore } = await import("./store.js");
    let calls = 0;
    const store = createTodoStore(async () => {
      calls += 1;
      if (calls === 1) return Promise.reject(new Error("rejected"));
      return [SNAPSHOT];
    });

    assert.deepEqual(await store.get("s1"), []);
    assert.equal(calls, 1);
    assert.deepEqual((await store.get("s1"))[0].name, "Todos");
    assert.equal(calls, 2);
    await store.get("s1");
    assert.equal(calls, 2, "the success is cached");
  });

  it("each store instance owns its own cache", async () => {
    const { createTodoStore } = await import("./store.js");
    const first = createTodoStore(async () => [SNAPSHOT]);
    const second = createTodoStore(async () => []);

    assert.equal((await first.get("s1")).length, 1);
    // The second instance must not see the first one's cached state.
    assert.deepEqual(await second.get("s1"), []);
  });

  it("serialize hands out the state one change at a time", async () => {
    const { createTodoStore } = await import("./store.js");
    const store = createTodoStore(async () => [SNAPSHOT]);
    const order: string[] = [];

    const slow = store.serialize(async () => {
      const before = await store.get("s1");
      await new Promise((resolve) => setTimeout(resolve, 5));
      order.push(`slow:${before.length}`);
      store.set("s1", [...before, phase("Added", ["x", "pending"])]);
    });
    const fast = store.serialize(async () => {
      const before = await store.get("s1");
      order.push(`fast:${before.length}`);
    });

    await Promise.all([slow, fast]);
    // The queued change read the state the first one wrote: no
    // read-modify-write interleaving through the store.
    assert.deepEqual(order, ["slow:1", "fast:2"]);
  });

  it("serialize reports a failed change to its own caller only", async () => {
    const { createTodoStore } = await import("./store.js");
    const store = createTodoStore(async () => [SNAPSHOT]);

    await assert.rejects(
      store.serialize(async () => {
        throw new Error("write failed");
      }),
      /write failed/,
    );
    // The gate is released: the next change still runs.
    assert.equal(await store.serialize(async () => "ok"), "ok");
  });
});
