/**
 * Tests for the in-memory session state registry (`session-state.ts`).
 *
 * Covers the load-once cache contract (same object reference per
 * session, one store load per session), explicit dirty write-back via
 * `save`, TTL eviction (idle entries are saved to the store before they
 * are dropped, with an injectable clock), the `_resetForTesting` test
 * seam, and the no-duplicate-state guarantee under repeated gets.  All
 * tests run against a scratch store over a temporary directory; a
 * counting wrapper observes store load/save traffic.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import {
  createSessionStateManager,
  type SessionStateManager,
  type SessionStateManagerOptions,
} from "./session-state.js";
import { type Block, type Mark, markKey } from "./state.js";
import { createStateStore, type StateStore } from "./store.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A block fixture over `[0, 3)`. */
function makeBlock(overrides: Partial<Block> = {}): Block {
  return {
    start: 0,
    end: 3,
    summary: "summary text",
    spanHash: "abcd1234",
    active: true,
    compressedTokens: 100,
    summaryTokens: 20,
    createdAt: 1000,
    ...overrides,
  };
}

/** A pending mark fixture. */
function makeMark(overrides: Partial<Mark> = {}): Mark {
  return {
    anchorOrdinal: 0,
    content: "tool output",
    contentTokens: 50,
    effective: false,
    markedAt: 2000,
    ...overrides,
  };
}

/** Store call counters for the counting wrapper. */
interface Counts {
  loads: number;
  saves: number;
  deletes: number;
}

/** Wrap a store and count its load/save/delete calls. */
function countingStore(inner: StateStore): {
  store: StateStore;
  counts: Counts;
} {
  const counts: Counts = { loads: 0, saves: 0, deletes: 0 };
  const store: StateStore = {
    get dir() {
      return inner.dir;
    },
    load(sessionId) {
      counts.loads++;
      return inner.load(sessionId);
    },
    save(sessionId, state) {
      counts.saves++;
      inner.save(sessionId, state);
    },
    delete(sessionId) {
      counts.deletes++;
      inner.delete(sessionId);
    },
  };
  return { store, counts };
}

/**
 * A fresh manager over a fresh counting store on the given directory.
 */
function makeManager(
  dir: string,
  opts?: SessionStateManagerOptions,
): { manager: SessionStateManager; counts: Counts } {
  const { store, counts } = countingStore(createStateStore(dir));
  return { manager: createSessionStateManager(store, opts), counts };
}

// ---------------------------------------------------------------------------
// 1. Load-once caching
// ---------------------------------------------------------------------------

describe("load-once caching", () => {
  const dir = mkdtempSync(join(tmpdir(), "zoo-session-state-"));
  after(() => rmSync(dir, { recursive: true, force: true }));

  it("returns the same object reference across repeated gets", () => {
    const { manager } = makeManager(dir);
    const a = manager.get("sess-load-1");
    const b = manager.get("sess-load-1");
    const c = manager.get("sess-load-1");
    assert.equal(a, b);
    assert.equal(b, c);
  });

  it("loads from the store exactly once per session", () => {
    const { manager, counts } = makeManager(dir);
    manager.get("sess-load-2");
    manager.get("sess-load-2");
    manager.get("sess-load-3");
    assert.equal(counts.loads, 2);
  });

  it("different sessions get independent states", () => {
    const { manager } = makeManager(dir);
    const a = manager.get("sess-load-4");
    const b = manager.get("sess-load-5");
    assert.notEqual(a, b);
    a.blocks.set(1, makeBlock());
    assert.equal(b.blocks.size, 0);
  });
});

// ---------------------------------------------------------------------------
// 2. Explicit save write-back
// ---------------------------------------------------------------------------

describe("explicit save write-back", () => {
  const dir = mkdtempSync(join(tmpdir(), "zoo-session-state-"));
  after(() => rmSync(dir, { recursive: true, force: true }));

  it("persists in-place mutations on save", () => {
    const { manager, counts } = makeManager(dir);
    const state = manager.get("sess-save-1");
    state.blocks.set(1, makeBlock());
    state.marks.set(
      markKey(2),
      makeMark({ anchorOrdinal: 2, contentTokens: 7 }),
    );
    state.nudges = { lastNudgeTokens: 5000 };
    manager.save("sess-save-1");
    assert.equal(counts.saves, 1);

    // Restart: a brand-new manager over the same directory sees the writes.
    const restarted = createSessionStateManager(createStateStore(dir));
    const restored = restarted.get("sess-save-1");
    assert.equal(restored.blocks.get(1)?.summary, "summary text");
    assert.equal(restored.marks.get(markKey(2))?.contentTokens, 7);
    assert.deepEqual(restored.nudges, { lastNudgeTokens: 5000 });
  });

  it("save is a no-op for a session that was never cached", () => {
    const { manager, counts } = makeManager(dir);
    manager.save("sess-never-cached");
    assert.equal(counts.saves, 0);
  });

  it("saveAll writes every cached session back", () => {
    const { manager, counts } = makeManager(dir);
    manager.get("sess-save-2").blocks.set(1, makeBlock());
    manager.get("sess-save-3").marks.set(markKey(1), makeMark());
    manager.saveAll();
    assert.equal(counts.saves, 2);

    const restarted = createSessionStateManager(createStateStore(dir));
    assert.equal(restarted.get("sess-save-2").blocks.size, 1);
    assert.equal(restarted.get("sess-save-3").marks.size, 1);
  });
});

// ---------------------------------------------------------------------------
// 3. TTL eviction (idle entries are saved before being dropped)
// ---------------------------------------------------------------------------

describe("TTL eviction", () => {
  const dir = mkdtempSync(join(tmpdir(), "zoo-session-state-"));
  after(() => rmSync(dir, { recursive: true, force: true }));

  it("evicts an idle entry after ttlMs, saving it to the store first", () => {
    let now = 1000;
    const { manager, counts } = makeManager(dir, {
      ttlMs: 500,
      now: () => now,
    });
    const state = manager.get("sess-ttl-1");
    state.blocks.set(1, makeBlock());

    // Fast-forward past the TTL; the next get triggers the sweep.
    now += 501;
    manager.get("sess-ttl-2");

    // The idle session was written back before being evicted.
    assert.equal(counts.saves, 1);
    const restored = createStateStore(dir).load("sess-ttl-1");
    assert.equal(restored.blocks.size, 1);
  });

  it("keeps entries that are still within the TTL", () => {
    let now = 0;
    const { manager, counts } = makeManager(dir, {
      ttlMs: 100,
      now: () => now,
    });
    const first = manager.get("sess-ttl-3");
    now += 99;
    manager.get("sess-ttl-4"); // sweep runs; sess-ttl-3 is not stale yet
    const again = manager.get("sess-ttl-3");
    assert.equal(first, again); // still cached, same reference
    assert.equal(counts.saves, 0); // nothing was evicted
  });

  it("reloads a session from the store after eviction", () => {
    let now = 0;
    const { manager, counts } = makeManager(dir, {
      ttlMs: 100,
      now: () => now,
    });
    const first = manager.get("sess-ttl-5");
    first.blocks.set(1, makeBlock());
    now += 101;
    manager.get("sess-ttl-6"); // evicts sess-ttl-5
    const reloaded = manager.get("sess-ttl-5");
    assert.notEqual(first, reloaded); // fresh object after eviction
    assert.equal(counts.loads, 3); // ttl-5, ttl-6, ttl-5 reload
    assert.equal(reloaded.blocks.size, 1); // eviction saved the mutation first
  });

  it("uses a 7-day default TTL when none is given", () => {
    let now = 0;
    const { manager, counts } = makeManager(dir, { now: () => now });
    const first = manager.get("sess-ttl-7");
    first.blocks.set(1, makeBlock());

    // Just under the default TTL idle: a sweep evicts nothing, so the
    // state is never written back.
    now += 7 * 24 * 60 * 60 * 1000 - 1;
    manager.get("sess-ttl-8");
    assert.equal(counts.saves, 0);
    assert.equal(createStateStore(dir).load("sess-ttl-7").blocks.size, 0);

    // Beyond the default TTL idle: the next sweep evicts, saving first.
    now += 2;
    manager.get("sess-ttl-9");
    assert.equal(counts.saves, 1);
    assert.equal(createStateStore(dir).load("sess-ttl-7").blocks.size, 1);
  });
});

// ---------------------------------------------------------------------------
// 4. Reset test hook
// ---------------------------------------------------------------------------

describe("_resetForTesting", () => {
  const dir = mkdtempSync(join(tmpdir(), "zoo-session-state-"));
  after(() => rmSync(dir, { recursive: true, force: true }));

  it("drops the whole cache without saving", () => {
    const { manager, counts } = makeManager(dir);
    const state = manager.get("sess-reset-1");
    state.blocks.set(1, makeBlock());
    manager._resetForTesting();
    assert.equal(counts.saves, 0);

    const again = manager.get("sess-reset-1");
    assert.notEqual(state, again); // reloaded fresh
    assert.equal(again.blocks.size, 0); // the mutation was never persisted
  });

  it("clears all sessions at once", () => {
    const { manager, counts } = makeManager(dir);
    const a = manager.get("sess-reset-2");
    const b = manager.get("sess-reset-3");
    manager._resetForTesting();
    const a2 = manager.get("sess-reset-2");
    const b2 = manager.get("sess-reset-3");
    assert.notEqual(a, a2);
    assert.notEqual(b, b2);
    assert.equal(counts.loads, 4); // each session loaded twice
  });
});

// ---------------------------------------------------------------------------
// 4b. Explicit evict (silent drop, no write-back)
// ---------------------------------------------------------------------------

describe("explicit evict", () => {
  const dir = mkdtempSync(join(tmpdir(), "zoo-session-state-"));
  after(() => rmSync(dir, { recursive: true, force: true }));

  it("drops the in-memory entry without writing back to the store", () => {
    const { manager, counts } = makeManager(dir);
    const state = manager.get("sess-evict-1");
    state.blocks.set(1, makeBlock());
    assert.equal(counts.loads, 1);
    assert.equal(counts.saves, 0);

    manager.evict("sess-evict-1");
    assert.equal(counts.saves, 0, "evict must never touch the store");
    // The file was never written, so the next get sees an empty state.
    const reloaded = manager.get("sess-evict-1");
    assert.notEqual(state, reloaded, "fresh object after evict");
    assert.equal(reloaded.blocks.size, 0, "mutation was never persisted");
  });

  it("does not resurrect a deleted store file", () => {
    const { manager, counts } = makeManager(dir);
    // Persist a block, then simulate the session-deleted path which
    // removes the file from disk.
    state_blocks_set(manager, "sess-evict-2", 1);
    manager.save("sess-evict-2");
    assert.equal(counts.saves, 1);
    manager.store.delete("sess-evict-2");

    // Cache was not touched yet — get still returns the cached object.
    const cached = manager.get("sess-evict-2");
    assert.equal(cached.blocks.size, 1);

    // evict must drop the cached entry without saving it back: the
    // file is gone on disk, and the eviction must not recreate it.
    manager.evict("sess-evict-2");
    assert.equal(counts.saves, 1, "evict must not save the dirty entry");

    // A subsequent get reloads from disk and sees an empty state.
    const reloaded = manager.get("sess-evict-2");
    assert.equal(reloaded.blocks.size, 0);
  });

  it("is a no-op for a session that was never cached", () => {
    const { manager, counts } = makeManager(dir);
    assert.doesNotThrow(() => manager.evict("sess-never-evict"));
    assert.equal(counts.saves, 0);
    assert.equal(counts.loads, 0);
  });

  it("leaves other sessions untouched", () => {
    const { manager, counts } = makeManager(dir);
    const a = manager.get("sess-evict-a");
    const b = manager.get("sess-evict-b");
    manager.evict("sess-evict-a");
    assert.notEqual(a, manager.get("sess-evict-a")); // a reloaded
    assert.equal(b, manager.get("sess-evict-b")); // b still cached
    assert.equal(counts.saves, 0);
    assert.equal(counts.loads, 3); // a, b, a-reload
  });
});

/**
 * Helper: set a block on the cached state of `sessionId` so the
 * eviction tests can stage a "dirty cached entry" without touching
 * the test file's other helpers.
 */
function state_blocks_set(
  manager: SessionStateManager,
  sessionId: string,
  blockId: number,
): void {
  const state = manager.get(sessionId);
  state.blocks.set(blockId, makeBlock());
}

// ---------------------------------------------------------------------------
// 5. Repeated gets never produce duplicate state
// ---------------------------------------------------------------------------

describe("repeated gets never produce duplicate state", () => {
  const dir = mkdtempSync(join(tmpdir(), "zoo-session-state-"));
  after(() => rmSync(dir, { recursive: true, force: true }));

  it("N gets of the same session yield one object and one load", () => {
    const { manager, counts } = makeManager(dir);
    const refs = [0, 1, 2, 3, 4].map(() => manager.get("sess-dup-1"));
    assert.equal(new Set(refs).size, 1);
    assert.equal(counts.loads, 1);
  });

  it("interleaved gets across sessions keep each session singular", () => {
    const { manager, counts } = makeManager(dir);
    const a1 = manager.get("sess-dup-a");
    const b1 = manager.get("sess-dup-b");
    const a2 = manager.get("sess-dup-a");
    const b2 = manager.get("sess-dup-b");
    assert.equal(a1, a2);
    assert.equal(b1, b2);
    assert.notEqual(a1, b1);
    assert.equal(counts.loads, 2);
  });
});
