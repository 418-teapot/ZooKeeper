/**
 * Tests for the runtime singletons (`runtime.ts`).
 *
 * Covers the per-session `cleanupSession` deletion entry point (clears
 * the agent binding, the model-limit entry, the persisted state file,
 * and the pending view-change flag), the `releaseSessionRuntime` entry
 * point that keeps the persisted context (a plugin dispose or reload is
 * not a deletion), the shared `sessionAgentRegistry` the cleanup writes
 * through, and the `_resetContextStateManagerForTesting` test seam that
 * drops the singleton plus the view-change flags.  Suites that observe
 * persistence bind the singleton to a scratch store directory.
 */
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { afterEach, describe, it } from "node:test";
import { makeTmpDir } from "../../testkits/tmp.js";
import { sessionAgentRegistry } from "../session-agent.js";
import * as modelLimits from "./model-limits.js";
import { getRoundView, publishRoundView } from "./round-view.js";
import {
  _resetContextStateManagerForTesting,
  cleanupSession,
  consumePendingViewChange,
  getContextStateManager,
  releaseSessionRuntime,
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
  sessionAgentRegistry.clear();
  modelLimits._resetForTesting();
  for (const dir of tmpDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * Bind the singleton manager to a scratch store.
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

/** A minimal published round view; only its presence in the cache matters. */
const EMPTY_ROUND_VIEW = {
  projection: { messages: [], invocations: [], byRegion: new Map() },
  numbered: [],
};

/**
 * Stage a cached, mutated state entry without writing it to the store.
 *
 * @param sessionID - The session to stage.
 * @param summary - The block summary that must survive the release.
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
// cleanupSession
// ---------------------------------------------------------------------------

describe("cleanupSession", () => {
  it("drops the session binding from the shared agent registry", () => {
    const id = "cleanup-agent-map";
    sessionAgentRegistry.bind(id, "dolphin");
    assert.equal(sessionAgentRegistry.resolve(id), "dolphin");

    cleanupSession(id);

    assert.equal(sessionAgentRegistry.resolve(id), undefined);
  });

  it("clears the model limit for the session", () => {
    const id = "cleanup-model-limit";
    modelLimits.setModelLimit(id, 4096, "test-model");
    assert.ok(modelLimits.getModelLimit(id));

    cleanupSession(id);

    assert.equal(modelLimits.getModelLimit(id), undefined);
  });

  it("removes the persisted state file for the session", () => {
    const id = "cleanup-state-file";
    const manager = getContextStateManager();

    // Assert the contract: cleanupSession delegates to the store's
    // delete.  We observe the call by wrapping the singleton's store.
    assert.equal(typeof manager.store.delete, "function");

    let deleteCalled = false;
    const originalDelete = manager.store.delete;
    manager.store.delete = (sid: string) => {
      if (sid === id) deleteCalled = true;
      originalDelete(sid);
    };

    cleanupSession(id);

    assert.ok(deleteCalled, "store.delete must be called by cleanupSession");
    manager.store.delete = originalDelete;
  });

  it("clears the pending-view-change flag for the session", () => {
    const id = "cleanup-view-change";
    setPendingViewChange(id);
    assert.equal(consumePendingViewChange(id), true);

    setPendingViewChange(id);
    cleanupSession(id);
    assert.equal(
      consumePendingViewChange(id),
      false,
      "pendingViewChange flag must be cleared by cleanupSession",
    );
  });

  it("evicts the session from the manager's in-memory cache", () => {
    const id = "cleanup-cache-evict";
    const manager = getContextStateManager();

    // Stage: a session loaded into cache with a mutated block.
    const cached = manager.get(id);
    cached.blocks.set(1, {
      start: 0,
      end: 3,
      summary: "should-not-survive",
      spanHash: "ffff0000",
      status: "active",
      compressedTokens: 100,
      summaryTokens: 20,
      createdAt: 1000,
    });
    const sameAgain = manager.get(id);
    assert.equal(cached, sameAgain, "precondition: entry is cached");

    cleanupSession(id);

    // Post-cleanup the cache must be empty: a fresh get returns a
    // different object, and the mutated block does not come back
    // (the store file was deleted, so reload yields an empty state).
    const after = manager.get(id);
    assert.notEqual(
      cached,
      after,
      "in-memory cache must be evicted by cleanupSession",
    );
    assert.equal(
      after.blocks.size,
      0,
      "cache eviction must not resurrect the deleted file",
    );
  });

  it("is a no-op for an unknown session id", () => {
    // No throws, no leaked state.
    cleanupSession("never-existed");
    assert.equal(sessionAgentRegistry.resolve("never-existed"), undefined);
    assert.equal(modelLimits.getModelLimit("never-existed"), undefined);
  });
});

// ---------------------------------------------------------------------------
// releaseSessionRuntime
// ---------------------------------------------------------------------------

describe("releaseSessionRuntime", () => {
  it("keeps the persisted state and saves the cached mutations", () => {
    const { store } = sandboxStore();
    const { manager, cached } = stageCachedBlock("release-keeps", "kept");

    releaseSessionRuntime("release-keeps");

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

  it("drops the runtime records and keeps the session's agent binding", () => {
    sandboxStore();
    const sessionID = "release-runtime";
    sessionAgentRegistry.bind(sessionID, "dolphin");
    modelLimits.setModelLimit(sessionID, 4096, "test-model");
    setPendingViewChange(sessionID);
    publishRoundView(sessionID, EMPTY_ROUND_VIEW);

    releaseSessionRuntime(sessionID);

    assert.equal(modelLimits.getModelLimit(sessionID), undefined);
    assert.equal(consumePendingViewChange(sessionID), false);
    assert.equal(getRoundView(sessionID), undefined);
    assert.equal(
      sessionAgentRegistry.resolve(sessionID),
      "dolphin",
      "the agent binding is process-owned and outlives the plugin instance",
    );
  });

  it("is a no-op for an unknown session id", () => {
    sandboxStore();

    releaseSessionRuntime("never-existed");

    assert.equal(sessionAgentRegistry.resolve("never-existed"), undefined);
    assert.equal(modelLimits.getModelLimit("never-existed"), undefined);
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

  it("clears pending view-change flags", () => {
    setPendingViewChange("s");
    _resetContextStateManagerForTesting();
    assert.equal(consumePendingViewChange("s"), false);
  });
});
