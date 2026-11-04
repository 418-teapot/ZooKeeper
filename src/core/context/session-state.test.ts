/**
 * Tests for the in-memory session state registry (`session-state.ts`).
 *
 * Covers the committed-state cache (one store load per session, one
 * object per session, no TTL and no background write), the permit-gated
 * `read`/`commit` protocol (draft isolation, per-session serialisation,
 * cancellation before or during the change), and the lifecycle cleanup
 * verbs (`release`, `evict`, `delete`).  One test locks the guarantee
 * that work on one session never writes another session's state.  All
 * tests run against a scratch store over a temporary directory; a
 * counting wrapper observes store load/save traffic and records which
 * sessions were saved.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { makeMark } from "../../testkits/context.js";
import { makeTmpDir } from "../../testkits/tmp.js";
import type { WorkPermit } from "../lifecycle/index.js";
import type { RuntimeFlaggedState } from "./runtime.js";
import {
  createSessionStateManager,
  type SessionStateManager,
} from "./session-state.js";
import { type Block, markKey } from "./state.js";
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
    status: "active",
    compressedTokens: 100,
    summaryTokens: 20,
    createdAt: 1000,
    ...overrides,
  };
}

/** Store call counters for the counting wrapper. */
interface Counts {
  loads: number;
  saves: number;
  deletes: number;
  savedSessions: string[];
}

/** Wrap a store and count its load/save/delete calls. */
function countingStore(inner: StateStore): {
  store: StateStore;
  counts: Counts;
} {
  const counts: Counts = { loads: 0, saves: 0, deletes: 0, savedSessions: [] };
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
      counts.savedSessions.push(sessionId);
      inner.save(sessionId, state);
    },
    delete(sessionId) {
      counts.deletes++;
      inner.delete(sessionId);
    },
  };
  return { store, counts };
}

/** A fresh manager over a fresh counting store on the given directory. */
function makeManager(dir: string): {
  manager: SessionStateManager;
  counts: Counts;
} {
  const { store, counts } = countingStore(createStateStore(dir));
  return { manager: createSessionStateManager(store), counts };
}

/** Wrap a store whose next write fails, standing in for a full disk. */
function failingStore(inner: StateStore): {
  store: StateStore;
  failNextWrite: () => void;
} {
  let failing = false;
  const store: StateStore = {
    get dir() {
      return inner.dir;
    },
    load: (sessionId) => inner.load(sessionId),
    save: (sessionId, state) => {
      if (failing) throw new Error("state write failed");
      inner.save(sessionId, state);
    },
    delete: (sessionId) => inner.delete(sessionId),
  };
  return {
    store,
    failNextWrite: () => {
      failing = true;
    },
  };
}

/** Block every later atomic write of one session at the temp file. */
function blockWrites(dir: string, sessionId: string): void {
  mkdirSync(join(dir, `.${sessionId}.json.tmp`));
}

/** Persist one block for `sessionId` outside the counted store. */
function seedBlock(
  dir: string,
  sessionId: string,
  blockId: number,
  block: Block,
): void {
  const store = createStateStore(dir);
  const state = store.load(sessionId);
  state.blocks.set(blockId, block);
  store.save(sessionId, state);
}

/** A permit the test itself revokes, standing in for the kernel's. */
interface TestPermit extends WorkPermit {
  revoke(): void;
}

/** Create an active permit for `sessionID`. */
function makePermit(sessionID: string): TestPermit {
  let active = true;
  return {
    sessionID,
    signal: new AbortController().signal,
    isActive: () => active,
    revoke: () => {
      active = false;
    },
  };
}

/** Resolve after `ms` so a held commit stays in flight. */
function tick(ms = 5): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A gate the test opens to let a blocked change finish. */
function makeGate(): { wait: Promise<void>; open: () => void } {
  let open = (): void => {};
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { wait, open };
}

// ---------------------------------------------------------------------------
// 1. Public surface
// ---------------------------------------------------------------------------

describe("public surface", () => {
  const dir = makeTmpDir("zoo-session-state");
  after(() => rmSync(dir, { recursive: true, force: true }));

  it("offers no arbitrary get, save, bulk save, or test hook", () => {
    const { manager } = makeManager(dir);
    assert.deepEqual(Object.keys(manager).sort(), [
      "commit",
      "delete",
      "evict",
      "read",
      "release",
      "store",
    ]);
  });
});

// ---------------------------------------------------------------------------
// 2. Committed-state cache
// ---------------------------------------------------------------------------

describe("committed-state cache", () => {
  const dir = makeTmpDir("zoo-session-state");
  after(() => rmSync(dir, { recursive: true, force: true }));

  it("loads from the store exactly once per session", () => {
    const { manager, counts } = makeManager(dir);
    const first = makePermit("sess-load-1");
    const second = makePermit("sess-load-2");
    manager.read(first, (state) => state);
    manager.read(first, (state) => state);
    manager.read(second, (state) => state);
    assert.equal(counts.loads, 2);
    assert.equal(counts.saves, 0, "caching never writes back");
  });

  it("returns the same committed object for one session", () => {
    const { manager } = makeManager(dir);
    const permit = makePermit("sess-load-3");
    const a = manager.read(permit, (state) => state);
    const b = manager.read(permit, (state) => state);
    assert.equal(a, b);
  });

  it("keeps sessions independent", async () => {
    const { manager, counts } = makeManager(dir);
    const a = makePermit("sess-load-4");
    const b = makePermit("sess-load-5");
    await manager.commit(a, (state) => {
      state.blocks.set(1, makeBlock());
    });
    const aState = manager.read(a, (state) => state);
    const bState = manager.read(b, (state) => state);
    assert.equal(aState?.blocks.size, 1);
    assert.equal(bState?.blocks.size, 0);
    assert.notEqual(aState, bState);
    assert.equal(counts.loads, 2);
  });
});

// ---------------------------------------------------------------------------
// 3. Permit-gated read
// ---------------------------------------------------------------------------

describe("permit-gated read", () => {
  const dir = makeTmpDir("zoo-session-state");
  after(() => rmSync(dir, { recursive: true, force: true }));

  it("returns the persisted state without writing back", () => {
    seedBlock(dir, "sess-read-1", 1, makeBlock());
    const { manager, counts } = makeManager(dir);
    const permit = makePermit("sess-read-1");
    assert.equal(
      manager.read(permit, (state) => state.blocks.size),
      1,
    );
    assert.equal(counts.saves, 0);
  });

  it("skips the reader when the permit lapsed", () => {
    const { manager, counts } = makeManager(dir);
    const permit = makePermit("sess-read-2");
    permit.revoke();
    let called = false;
    const value = manager.read(permit, () => {
      called = true;
      return 1;
    });
    assert.equal(value, undefined);
    assert.equal(called, false, "the reader never runs");
    assert.equal(counts.loads, 0);
  });
});

// ---------------------------------------------------------------------------
// 4. Permit-gated commit
// ---------------------------------------------------------------------------

describe("permit-gated commit", () => {
  const dir = makeTmpDir("zoo-session-state");
  after(() => rmSync(dir, { recursive: true, force: true }));

  it("runs the change on a draft and persists it", async () => {
    const { manager } = makeManager(dir);
    const permit = makePermit("sess-commit-1");
    const value = await manager.commit(permit, (state) => {
      state.blocks.set(1, makeBlock());
      state.nudges = { lastNudgeTokens: 30 };
      state.marks.set(markKey(2), makeMark({ anchorOrdinal: 2 }));
      return "done";
    });
    assert.equal(value, "done");
    const stored = createStateStore(dir).load("sess-commit-1");
    assert.equal(stored.blocks.size, 1);
    assert.equal(stored.marks.size, 1);
    assert.deepEqual(stored.nudges, { lastNudgeTokens: 30 });
  });

  it("keeps the draft away from the committed cache", async () => {
    const { manager } = makeManager(dir);
    const permit = makePermit("sess-commit-2");
    const gate = makeGate();
    const pending = manager.commit(permit, async (state) => {
      state.nudges = { lastNudgeTokens: 5 };
      await gate.wait;
      return 5;
    });
    assert.equal(
      manager.read(permit, (state) => state.nudges),
      undefined,
      "the draft is not observable",
    );
    gate.open();
    assert.equal(await pending, 5);
    assert.deepEqual(
      manager.read(permit, (state) => state.nudges),
      {
        lastNudgeTokens: 5,
      },
    );
  });

  it("serialises one session's commits without losing updates", async () => {
    const { manager } = makeManager(dir);
    const permit = makePermit("sess-commit-3");
    const bump = (): Promise<number | undefined> =>
      manager.commit(permit, async (state) => {
        const current = state.nudges?.lastNudgeTokens ?? 0;
        await tick();
        state.nudges = { lastNudgeTokens: current + 1 };
        return current + 1;
      });
    const results = await Promise.all([bump(), bump()]);
    assert.deepEqual(results, [1, 2]);
    assert.equal(
      createStateStore(dir).load("sess-commit-3").nudges?.lastNudgeTokens,
      2,
    );
  });

  it("skips a change whose permit lapsed while queued", async () => {
    const { manager } = makeManager(dir);
    const held = makePermit("sess-commit-4");
    const queued = makePermit("sess-commit-4");
    const gate = makeGate();
    const first = manager.commit(held, async (state) => {
      await gate.wait;
      state.nudges = { lastNudgeTokens: 1 };
      return "first";
    });
    let ran = false;
    const second = manager.commit(queued, (state) => {
      ran = true;
      state.nudges = { lastNudgeTokens: 2 };
      return "second";
    });
    queued.revoke();
    gate.open();
    assert.equal(await first, "first");
    assert.equal(await second, undefined);
    assert.equal(ran, false, "the queued change never runs");
    assert.equal(
      createStateStore(dir).load("sess-commit-4").nudges?.lastNudgeTokens,
      1,
    );
  });

  it("writes nothing when the permit lapses inside the change", async () => {
    const { manager, counts } = makeManager(dir);
    const permit = makePermit("sess-commit-5");
    await manager.commit(permit, (state) => {
      state.nudges = { lastNudgeTokens: 7 };
    });
    const savesBefore = counts.saves;
    const value = await manager.commit(permit, (state) => {
      state.nudges = { lastNudgeTokens: 99 };
      state.blocks.set(1, makeBlock());
      permit.revoke();
      return "half";
    });
    assert.equal(value, undefined);
    assert.equal(counts.saves, savesBefore, "no write-back");

    const observer = makePermit("sess-commit-5");
    const cached = manager.read(observer, (state) => state);
    assert.equal(cached?.nudges?.lastNudgeTokens, 7);
    assert.equal(cached?.blocks.size, 0);
    assert.equal(
      createStateStore(dir).load("sess-commit-5").nudges?.lastNudgeTokens,
      7,
    );
  });

  it("does not run the change when the permit already lapsed", async () => {
    const { manager, counts } = makeManager(dir);
    const permit = makePermit("sess-commit-7");
    permit.revoke();
    let ran = false;
    const value = await manager.commit(permit, () => {
      ran = true;
    });
    assert.equal(value, undefined);
    assert.equal(ran, false);
    assert.equal(counts.saves, 0);
  });

  it("keeps runtime-only fields on the draft", async () => {
    const { manager } = makeManager(dir);
    const permit = makePermit("sess-commit-6");
    await manager.commit(permit, (state) => {
      (state as RuntimeFlaggedState).pendingManualTrigger = true;
    });
    const observed = await manager.commit(permit, (state) => {
      return (state as RuntimeFlaggedState).pendingManualTrigger;
    });
    assert.equal(observed, true);
  });
});

// ---------------------------------------------------------------------------
// 4b. Persistence failure
// ---------------------------------------------------------------------------

describe("persistence failure", () => {
  const dir = makeTmpDir("zoo-session-state");
  after(() => rmSync(dir, { recursive: true, force: true }));

  it("rejects the commit and keeps the committed state", async () => {
    const manager = createSessionStateManager(createStateStore(dir));
    const permit = makePermit("sess-write-fail");
    await manager.commit(permit, (state) => {
      state.blocks.set(1, makeBlock());
    });

    blockWrites(dir, "sess-write-fail");
    await assert.rejects(
      () =>
        manager.commit(permit, (state) => {
          state.blocks.set(2, makeBlock({ start: 3, end: 6 }));
        }),
      "an unwritten change never reports success",
    );

    assert.deepEqual(
      manager.read(permit, (state) => [...state.blocks.keys()]),
      [1],
      "the cache keeps the last committed state",
    );
    assert.deepEqual(
      [...createStateStore(dir).load("sess-write-fail").blocks.keys()],
      [1],
      "the file keeps the last committed state",
    );
  });

  it("reports a failed release instead of claiming success", async () => {
    const manager = createSessionStateManager(createStateStore(dir));
    const permit = makePermit("sess-release-fail");
    await manager.commit(permit, (state) => {
      state.blocks.set(1, makeBlock());
    });

    blockWrites(dir, "sess-release-fail");
    assert.throws(() => manager.release("sess-release-fail"));
    assert.deepEqual(
      manager.read(permit, (state) => [...state.blocks.keys()]),
      [1],
      "the unsaved cache entry survives for the next attempt",
    );
  });

  it("reports a write failure as an actionable user-facing error", async () => {
    const { store, failNextWrite } = failingStore(createStateStore(dir));
    const manager = createSessionStateManager(store);
    const permit = makePermit("sess-store-fail");

    failNextWrite();
    await assert.rejects(
      () =>
        manager.commit(permit, (state) => {
          state.blocks.set(1, makeBlock());
        }),
      (err: Error) => {
        assert.match(err.message, /本次修改未生效/, "the error is actionable");
        assert.match(err.message, /未改动/, "the error states the outcome");
        assert.doesNotMatch(
          err.message,
          /state write failed/,
          "the internal cause never reaches the reader",
        );
        assert.equal(
          (err.cause as Error).message,
          "state write failed",
          "the cause stays for diagnosis",
        );
        return true;
      },
    );
    assert.equal(
      manager.read(permit, (state) => state.blocks.size),
      0,
    );
  });

  it("leaves the change's own error unwrapped", async () => {
    const manager = createSessionStateManager(createStateStore(dir));
    const permit = makePermit("sess-change-fail");

    await assert.rejects(
      () =>
        manager.commit(permit, () => {
          throw new Error("本次压缩未生效：范围无效，会话状态未改动。");
        }),
      (err: Error) => {
        assert.equal(
          err.message,
          "本次压缩未生效：范围无效，会话状态未改动。",
          "a change error keeps its own semantics",
        );
        assert.equal(err.cause, undefined, "a change error gains no cause");
        return true;
      },
    );
  });
});

// ---------------------------------------------------------------------------
// 5. Release
// ---------------------------------------------------------------------------

describe("release", () => {
  const dir = makeTmpDir("zoo-session-state");
  after(() => rmSync(dir, { recursive: true, force: true }));

  it("saves the committed state and drops the cache", async () => {
    const { manager, counts } = makeManager(dir);
    const permit = makePermit("sess-release-1");
    await manager.commit(permit, (state) => {
      state.blocks.set(1, makeBlock());
      state.marks.set(
        markKey(2),
        makeMark({ anchorOrdinal: 2, contentTokens: 7 }),
      );
    });
    const savesBefore = counts.saves;
    manager.release("sess-release-1");
    assert.equal(counts.saves, savesBefore + 1);
    assert.deepEqual(counts.savedSessions, [
      "sess-release-1",
      "sess-release-1",
    ]);

    const stored = createStateStore(dir).load("sess-release-1");
    assert.equal(stored.blocks.get(1)?.summary, "summary text");
    assert.equal(stored.marks.get(markKey(2))?.contentTokens, 7);

    // The cache was dropped: the next read loads from the file again.
    assert.equal(
      manager.read(permit, (state) => state.blocks.size),
      1,
    );
    assert.equal(counts.loads, 2);
  });

  it("never saves a cancelled change", async () => {
    const { manager } = makeManager(dir);
    const permit = makePermit("sess-release-2");
    await manager.commit(permit, (state) => {
      state.nudges = { lastNudgeTokens: 3 };
    });
    await manager.commit(permit, (state) => {
      state.nudges = { lastNudgeTokens: 500 };
      permit.revoke();
    });
    manager.release("sess-release-2");
    assert.equal(
      createStateStore(dir).load("sess-release-2").nudges?.lastNudgeTokens,
      3,
    );
  });

  it("is a no-op for a session that was never cached", () => {
    const { manager, counts } = makeManager(dir);
    manager.release("sess-never-release");
    assert.equal(counts.saves, 0);
    assert.equal(counts.loads, 0);
  });
});

// ---------------------------------------------------------------------------
// 6. Explicit evict (silent drop, no write-back)
// ---------------------------------------------------------------------------

describe("explicit evict", () => {
  const dir = makeTmpDir("zoo-session-state");
  after(() => rmSync(dir, { recursive: true, force: true }));

  it("drops the cache entry without writing back", async () => {
    const { manager, counts } = makeManager(dir);
    const permit = makePermit("sess-evict-1");
    await manager.commit(permit, (state) => {
      state.blocks.set(1, makeBlock());
    });
    const savesBefore = counts.saves;
    manager.evict("sess-evict-1");
    assert.equal(counts.saves, savesBefore, "evict never touches the store");
    assert.equal(
      manager.read(permit, (state) => state.blocks.size),
      1,
    );
    assert.equal(counts.loads, 2, "the next read reloads from the file");
  });

  it("does not resurrect a deleted store file", async () => {
    const { manager, counts } = makeManager(dir);
    const permit = makePermit("sess-evict-2");
    await manager.commit(permit, (state) => {
      state.blocks.set(1, makeBlock());
    });
    // Simulate the session-deleted path: the file is gone from disk.
    manager.store.delete("sess-evict-2");
    const savesBefore = counts.saves;
    manager.evict("sess-evict-2");
    assert.equal(counts.saves, savesBefore, "evict must not save");
    assert.equal(
      manager.read(permit, (state) => state.blocks.size),
      0,
    );
    assert.equal(existsSync(join(dir, "sess-evict-2.json")), false);
  });

  it("is a no-op for a session that was never cached", () => {
    const { manager, counts } = makeManager(dir);
    assert.doesNotThrow(() => manager.evict("sess-never-evict"));
    assert.equal(counts.saves, 0);
    assert.equal(counts.loads, 0);
  });

  it("leaves other sessions untouched", () => {
    const { manager, counts } = makeManager(dir);
    const a = makePermit("sess-evict-a");
    const b = makePermit("sess-evict-b");
    const aState = manager.read(a, (state) => state);
    const bState = manager.read(b, (state) => state);
    manager.evict("sess-evict-a");
    assert.notEqual(
      manager.read(a, (state) => state),
      aState,
    );
    assert.equal(
      manager.read(b, (state) => state),
      bState,
    );
    assert.equal(counts.saves, 0);
    assert.equal(counts.loads, 3);
  });
});

// ---------------------------------------------------------------------------
// 7. Delete
// ---------------------------------------------------------------------------

describe("delete", () => {
  const dir = makeTmpDir("zoo-session-state");
  after(() => rmSync(dir, { recursive: true, force: true }));

  it("removes the file without writing it back", async () => {
    const { manager, counts } = makeManager(dir);
    const permit = makePermit("sess-delete-1");
    await manager.commit(permit, (state) => {
      state.blocks.set(1, makeBlock());
    });
    const savesBefore = counts.saves;
    manager.delete("sess-delete-1");
    assert.equal(counts.saves, savesBefore, "delete never saves");
    assert.equal(existsSync(join(dir, "sess-delete-1.json")), false);
    assert.equal(
      manager.read(permit, (state) => state.blocks.size),
      0,
    );
    assert.equal(existsSync(join(dir, "sess-delete-1.json")), false);
  });
});

// ---------------------------------------------------------------------------
// 8. No cross-session write-back
// ---------------------------------------------------------------------------

describe("no cross-session write-back", () => {
  const dir = makeTmpDir("zoo-session-state");
  after(() => rmSync(dir, { recursive: true, force: true }));

  it("writes only the session whose work commits or releases", async () => {
    const { manager, counts } = makeManager(dir);
    const a = makePermit("sess-iso-a");
    const b = makePermit("sess-iso-b");

    // Both sessions are cached; B carries a committed block.
    await manager.commit(b, (state) => {
      state.blocks.set(2, makeBlock({ start: 4, end: 8 }));
    });
    manager.read(a, (state) => state);
    const bState = manager.read(b, (state) => state);
    assert.equal(bState?.blocks.size, 1);

    // From here on, only A's own work may reach the store.
    counts.saves = 0;
    counts.savedSessions.length = 0;
    await manager.commit(a, (state) => {
      state.blocks.set(1, makeBlock());
    });
    manager.read(a, (state) => state);
    assert.deepEqual(counts.savedSessions, ["sess-iso-a"]);
    assert.equal(
      manager.read(b, (state) => state),
      bState,
      "B's cache stays untouched",
    );

    // Releasing B saves only its own committed state.
    manager.release("sess-iso-b");
    assert.deepEqual(counts.savedSessions, ["sess-iso-a", "sess-iso-b"]);
    const storedB = createStateStore(dir).load("sess-iso-b");
    assert.equal(storedB.blocks.size, 1);
    assert.equal(storedB.blocks.get(2)?.start, 4);
    assert.deepEqual(
      [...createStateStore(dir).load("sess-iso-a").blocks.keys()],
      [1],
    );
  });
});

// ---------------------------------------------------------------------------
// 9. Per-session serialisation scope
// ---------------------------------------------------------------------------

describe("per-session serialisation scope", () => {
  const dir = makeTmpDir("zoo-session-state");
  after(() => rmSync(dir, { recursive: true, force: true }));

  it("does not queue one session behind another", async () => {
    const { manager } = makeManager(dir);
    const held = makePermit("sess-pair-a");
    const other = makePermit("sess-pair-b");
    const gate = makeGate();
    const blocking = manager.commit(held, async (state) => {
      await gate.wait;
      state.nudges = { lastNudgeTokens: 1 };
      return "a";
    });
    let otherRan = false;
    const concurrent = manager.commit(other, (state) => {
      otherRan = true;
      state.nudges = { lastNudgeTokens: 2 };
      return "b";
    });
    await tick();
    assert.equal(otherRan, true, "the other session is not queued behind");
    gate.open();
    assert.equal(await blocking, "a");
    assert.equal(await concurrent, "b");
  });
});
