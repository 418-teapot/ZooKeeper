/**
 * Tests for the runtime singletons (`runtime.ts`).
 *
 * Covers the two session state records: the in-memory cache (a runtime
 * release writes the cached mutations back before dropping the entry) and
 * the persisted file (a runtime release keeps it, a deletion removes it),
 * plus the pending view-change flag record and the
 * `_resetContextStateManagerForTesting` seam that binds a scratch store
 * without creating a manager.  The expectations follow the two stop modes,
 * so an implementation that deletes on a release, or that creates the
 * manager just to clean up, fails here.
 */
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { afterEach, describe, it } from "node:test";
import { makeTmpDir } from "../../testkits/tmp.js";
import * as modelLimits from "./model-limits.js";
import {
  _hasContextStateManagerForTesting,
  _resetContextStateManagerForTesting,
  consumePendingViewChange,
  getContextStateManager,
  pendingViewChangeFlagResource,
  sessionStateCacheResource,
  sessionStateFileResource,
  setPendingViewChange,
} from "./runtime.js";
import { createStateStore } from "./store.js";

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

/** Scratch store directories the current test created. */
const tmpDirs: string[] = [];

afterEach(() => {
  _resetContextStateManagerForTesting();
  modelLimits._resetForTesting();
  for (const dir of tmpDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * Bind the runtime to a scratch store without creating a manager.
 *
 * @returns The sandbox store and its directory.
 */
function sandboxStore() {
  const dir = makeTmpDir("zoo-runtime");
  tmpDirs.push(dir);
  const store = createStateStore(dir);
  _resetContextStateManagerForTesting(store);
  return { dir, store };
}

/**
 * Stage a cached, mutated state entry.
 *
 * @param sessionID - The session to stage.
 * @param summary - The block summary that must survive a release.
 * @returns The manager and the cached state object.
 */
function stageCachedBlock(sessionID: string, summary: string) {
  const manager = getContextStateManager();
  const cached = manager.get(sessionID);
  cached.blocks.set(1, {
    start: 0,
    end: 3,
    summary,
    spanHash: "ffff0000",
    status: "active",
    compressedTokens: 100,
    summaryTokens: 20,
    createdAt: 1000,
  });
  return { manager, cached };
}

// ---------------------------------------------------------------------------
// session state cache
// ---------------------------------------------------------------------------

describe("session state cache record", () => {
  it("saves the cached mutations before a runtime release drops them", () => {
    const { store } = sandboxStore();
    const { manager, cached } = stageCachedBlock("release-keeps", "kept");

    sessionStateCacheResource.release("release-keeps");

    assert.equal(
      store.load("release-keeps").blocks.get(1)?.summary,
      "kept",
      "the cached compression must be written back, not dropped",
    );
    const after = manager.get("release-keeps");
    assert.notEqual(after, cached, "the in-memory entry must be dropped");
    assert.equal(
      after.blocks.get(1)?.summary,
      "kept",
      "a later instance reloads the same state from the store",
    );
  });

  it("drops the entry on a deletion without writing it back", () => {
    const { store } = sandboxStore();
    const { manager, cached } = stageCachedBlock("delete-drops", "dropped");

    sessionStateFileResource.delete("delete-drops");
    sessionStateCacheResource.delete("delete-drops");

    // A write-back would recreate the file this deletion just removed.
    assert.equal(store.load("delete-drops").blocks.size, 0);
    const after = manager.get("delete-drops");
    assert.notEqual(after, cached, "the in-memory entry must be dropped");
    assert.equal(
      after.blocks.size,
      0,
      "cache eviction must not resurrect the deleted file",
    );
  });

  it("does not create the manager to release a session", () => {
    sandboxStore();

    sessionStateCacheResource.release("never-loaded");

    assert.equal(
      _hasContextStateManagerForTesting(),
      false,
      "a release must not build the manager it only found absent",
    );
  });
});

// ---------------------------------------------------------------------------
// session state file
// ---------------------------------------------------------------------------

describe("session state file record", () => {
  it("keeps the file on a runtime release", () => {
    const { store } = sandboxStore();
    stageCachedBlock("release-file", "kept");
    sessionStateCacheResource.release("release-file");

    assert.equal(
      store.load("release-file").blocks.get(1)?.summary,
      "kept",
      "only a deletion may remove the persisted context",
    );
  });

  it("removes the file of a session this process never loaded", () => {
    const { store } = sandboxStore();
    const manager = getContextStateManager();
    stageCachedBlock("unloaded", "kept");
    manager.save("unloaded");
    // A later process instance: the store outlives the manager.
    _resetContextStateManagerForTesting(store);
    assert.equal(_hasContextStateManagerForTesting(), false);

    sessionStateFileResource.delete("unloaded");

    assert.equal(
      _hasContextStateManagerForTesting(),
      false,
      "a deletion must not create a manager either",
    );
    assert.equal(store.load("unloaded").blocks.size, 0);
  });
});

// ---------------------------------------------------------------------------
// pending view-change flag
// ---------------------------------------------------------------------------

describe("pending view-change flag record", () => {
  it("drops the armed flag on both stop modes", () => {
    for (const stop of [
      pendingViewChangeFlagResource.release,
      pendingViewChangeFlagResource.delete,
    ]) {
      setPendingViewChange("sess-flag");
      assert.equal(consumePendingViewChange("sess-flag"), true);

      setPendingViewChange("sess-flag");
      stop("sess-flag");

      assert.equal(consumePendingViewChange("sess-flag"), false);
    }
  });
});

// ---------------------------------------------------------------------------
// _resetContextStateManagerForTesting
// ---------------------------------------------------------------------------

describe("_resetContextStateManagerForTesting", () => {
  it("drops the singleton so the next access creates a fresh manager", () => {
    const m1 = getContextStateManager();
    _resetContextStateManagerForTesting();
    const m2 = getContextStateManager();
    assert.notEqual(m1, m2, "manager must be a fresh instance after reset");
  });

  it("binds the store the next manager reads from", () => {
    const { store } = sandboxStore();

    assert.equal(getContextStateManager().store, store);
  });

  it("clears pending view-change flags", () => {
    setPendingViewChange("s");
    _resetContextStateManagerForTesting();
    assert.equal(consumePendingViewChange("s"), false);
  });
});
