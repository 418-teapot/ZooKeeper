/**
 * Tests for the per-instance context runtime (`runtime.ts`).
 *
 * Boundary: `createContextRuntime` — the object every unit reads through
 * after the composition root injects it.  Covers the permit contract (a
 * commit and a runtime-only write land only while the permit is active),
 * the state-record stop semantics (a release writes back and drops the
 * cache, a deletion removes the file, an eviction never writes back), and
 * the isolation of two instances in one process.
 */
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { afterEach, describe, it } from "node:test";
import { permitFor } from "../../testkits/context-runtime.js";
import { makeTmpDir } from "../../testkits/tmp.js";
import { project } from "./lens.js";
import { createContextRuntime } from "./runtime.js";
import type { Block } from "./state.js";
import { createStateStore } from "./store.js";

/** Scratch store directories the current test created. */
const tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** The block a commit stages for the stop-semantics assertions. */
const BLOCK: Block = {
  start: 0,
  end: 3,
  summary: "kept",
  spanHash: "ffff0000",
  status: "active",
  compressedTokens: 100,
  summaryTokens: 20,
  createdAt: 1000,
};

/**
 * Create a runtime over a fresh scratch store.
 *
 * @returns The runtime and the store it reads and writes.
 */
function sandboxRuntime() {
  const dir = makeTmpDir("zoo-runtime");
  tmpDirs.push(dir);
  const store = createStateStore(dir);
  return { runtime: createContextRuntime(store), store };
}

describe("commit / read under a permit", () => {
  it("commits a change to the cache and the store", async () => {
    const { runtime, store } = sandboxRuntime();
    const permit = permitFor("sess-commit");

    const value = await runtime.commit(permit, (state) => {
      state.blocks.set(1, { ...BLOCK });
      state.pendingManualTrigger = true;
      return "done";
    });

    assert.equal(value, "done");
    assert.equal(store.load("sess-commit").blocks.get(1)?.summary, "kept");
    assert.equal(
      runtime.read(permit, (state) => state.blocks.size),
      1,
    );
    assert.equal(
      runtime.read(permit, (state) => state.pendingManualTrigger),
      true,
    );
  });

  it("rejects a commit whose permit lapsed and writes nothing", async () => {
    const { runtime, store } = sandboxRuntime();
    const controller = new AbortController();
    const permit = permitFor("sess-lapsed", controller.signal);

    const value = await runtime.commit(permit, (state) => {
      controller.abort();
      state.blocks.set(1, { ...BLOCK });
      return "done";
    });

    assert.equal(value, undefined);
    assert.equal(store.load("sess-lapsed").blocks.size, 0);
    assert.equal(
      runtime.read(permit, (state) => state.blocks.size),
      undefined,
    );
  });

  it("serialises two commits of the same session without losing updates", async () => {
    const { runtime } = sandboxRuntime();
    const permit = permitFor("sess-serial");

    await Promise.all([
      runtime.commit(permit, async (state) => {
        await Promise.resolve();
        state.blocks.set(1, { ...BLOCK });
      }),
      runtime.commit(permit, async (state) => {
        await Promise.resolve();
        state.blocks.set(2, { ...BLOCK });
      }),
    ]);

    assert.deepEqual(
      runtime.read(permit, (state) => [...state.blocks.keys()]),
      [1, 2],
    );
  });
});

describe("runtime-only records", () => {
  it("captures the model limit and publishes the round view under a permit", () => {
    const { runtime } = sandboxRuntime();
    const permit = permitFor("sess-records");

    runtime.setModelLimit(permit, 1000, "model");
    runtime.publishRoundView(permit, {
      projection: project([], []),
      numbered: [],
    });
    runtime.setPendingViewChange(permit);

    assert.deepEqual(runtime.modelLimit("sess-records"), {
      context: 1000,
      modelId: "model",
    });
    assert.ok(runtime.roundView("sess-records"));
    assert.equal(runtime.consumePendingViewChange(permit), true);
    assert.equal(runtime.consumePendingViewChange(permit), false);
  });

  it("ignores every write of a lapsed permit", () => {
    const { runtime } = sandboxRuntime();
    const controller = new AbortController();
    const permit = permitFor("sess-lapsed-records", controller.signal);
    controller.abort();

    runtime.setModelLimit(permit, 1000, "model");
    runtime.publishRoundView(permit, {
      projection: project([], []),
      numbered: [],
    });
    runtime.setPendingViewChange(permit);

    assert.equal(runtime.modelLimit("sess-lapsed-records"), undefined);
    assert.equal(runtime.roundView("sess-lapsed-records"), undefined);
    assert.equal(runtime.consumePendingViewChange(permit), false);
  });

  it("clears each record of one session", async () => {
    const { runtime } = sandboxRuntime();
    const permit = permitFor("sess-clear");
    runtime.setModelLimit(permit, 1000, "model");
    runtime.publishRoundView(permit, {
      projection: project([], []),
      numbered: [],
    });
    runtime.setPendingViewChange(permit);

    runtime.clearModelLimit("sess-clear");
    runtime.clearRoundView("sess-clear");
    runtime.clearPendingViewChange("sess-clear");

    assert.equal(runtime.modelLimit("sess-clear"), undefined);
    assert.equal(runtime.roundView("sess-clear"), undefined);
    assert.equal(runtime.consumePendingViewChange(permit), false);
  });
});

describe("state records at a session stop", () => {
  it("Release writes the cached mutation back and drops the entry", async () => {
    const { runtime, store } = sandboxRuntime();
    const permit = permitFor("sess-release");
    await runtime.commit(permit, (state) => {
      state.blocks.set(1, { ...BLOCK });
    });

    runtime.release("sess-release");

    assert.equal(
      store.load("sess-release").blocks.get(1)?.summary,
      "kept",
      "a release must not discard the committed compression",
    );
    assert.equal(
      runtime.read(permit, (state) => state.blocks.get(1)?.summary),
      "kept",
      "the next read reloads the same state from the store",
    );
  });

  it("Evict drops the entry without writing it back", async () => {
    const { runtime, store } = sandboxRuntime();
    const permit = permitFor("sess-evict");
    await runtime.commit(permit, (state) => {
      state.blocks.set(1, { ...BLOCK });
    });
    // Diverge the cache from the store to observe the missing write-back:
    // the read hands out the committed object, which is mutated here
    // without a commit.
    runtime.read(permit, (state) => {
      const block = state.blocks.get(1);
      if (block !== undefined) block.summary = "cache-only";
    });

    runtime.evict("sess-evict");

    assert.equal(
      store.load("sess-evict").blocks.get(1)?.summary,
      "kept",
      "an eviction never writes the cached mutation back",
    );
    assert.equal(
      runtime.read(permit, (state) => state.blocks.get(1)?.summary),
      "kept",
      "the reloaded state comes from the store",
    );
  });

  it("Delete removes the cached entry and the store file", async () => {
    const { runtime, store } = sandboxRuntime();
    const permit = permitFor("sess-delete");
    await runtime.commit(permit, (state) => {
      state.blocks.set(1, { ...BLOCK });
    });

    runtime.delete("sess-delete");

    assert.equal(store.load("sess-delete").blocks.size, 0);
  });
});

describe("instance isolation", () => {
  it("two runtimes in one process share no record", async () => {
    const first = sandboxRuntime();
    const second = sandboxRuntime();
    const firstPermit = permitFor("shared-id");
    const secondPermit = permitFor("shared-id");

    await first.runtime.commit(firstPermit, (state) => {
      state.blocks.set(1, { ...BLOCK, summary: "first" });
    });
    first.runtime.setModelLimit(firstPermit, 1000, "model-a");
    first.runtime.publishRoundView(firstPermit, {
      projection: project([], []),
      numbered: [],
    });
    first.runtime.setPendingViewChange(firstPermit);

    assert.equal(
      second.runtime.read(secondPermit, (state) => state.blocks.size),
      0,
      "the second instance never sees the first instance's state",
    );
    assert.equal(second.runtime.modelLimit("shared-id"), undefined);
    assert.equal(second.runtime.roundView("shared-id"), undefined);
    assert.equal(second.runtime.consumePendingViewChange(secondPermit), false);
  });
});
