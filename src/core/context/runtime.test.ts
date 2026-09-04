/**
 * Tests for the runtime singletons (`runtime.ts`).
 *
 * Covers the per-session `cleanupSession` single entry point (clears
 * the agent binding, the model-limit entry, the persisted state file,
 * and the pending view-change flag), the shared `sessionAgentRegistry`
 * the cleanup writes through, and the
 * `_resetContextStateManagerForTesting` test seam that drops the
 * singleton plus the view-change flags.  Tests run against a
 * scratch store directory so the persistence cleanup is observable.
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { sessionAgentRegistry } from "../session-agent.js";
import * as modelLimits from "./model-limits.js";
import {
  _resetContextStateManagerForTesting,
  cleanupSession,
  consumePendingViewChange,
  getContextStateManager,
  setPendingViewChange,
} from "./runtime.js";

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

afterEach(() => {
  _resetContextStateManagerForTesting();
  sessionAgentRegistry.clear();
  modelLimits._resetForTesting();
});

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
      active: true,
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
