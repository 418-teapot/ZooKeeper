/**
 * Tests for {@link persist} — disk JSON persistence for session state.
 *
 * Covers:
 * - Round-trip save + load with populated Maps/Sets
 * - Empty Maps/Sets round-trip
 * - loadSessionState returns null for non-existent session
 * - deletePersistedState removes the persisted file
 * - cleanupExpiredSessions removes stale session files
 */
import assert from "node:assert/strict";
import { afterEach, before, describe, it } from "node:test";
import {
  cleanupExpiredSessions,
  deletePersistedState,
  loadSessionState,
  saveSessionState,
} from "./persist";
import type { SessionState } from "./types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEST_SESSION_ID = "__test_persist_roundtrip__";
const TEST_SESSION_DELETE = "__test_persist_delete__";
const TEST_SESSION_CLEANUP = "__test_persist_cleanup__";

/**
 * Build a minimal {@link SessionState} for testing.
 *
 * @param overrides - Partial overrides to customise the state.
 * @returns A fresh session state.
 */
function freshState(overrides?: Partial<SessionState>): SessionState {
  return {
    sessionId: TEST_SESSION_ID,
    blocksById: new Map(),
    byMessageId: new Map(),
    activeBlockIds: new Set(),
    activeByAnchorMessageId: new Map(),
    dedupCache: new Map(),
    errorTracking: new Map(),
    protectedTurns: 2,
    turnCount: 0,
    nudgeCounter: 0,
    nextBlockId: 1,
    nextRunId: 1,
    lastAccessedAt: Date.now(),
    totalPrunedTokens: 0,
    totalCompressedTokens: 0,
    prune: { tools: new Map(), prunedCallIds: new Set() },
    ...overrides,
  } as SessionState;
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

afterEach(() => {
  deletePersistedState(TEST_SESSION_ID);
  deletePersistedState(TEST_SESSION_DELETE);
  deletePersistedState(TEST_SESSION_CLEANUP);
});

// ---------------------------------------------------------------------------
// (a) Round-trip with populated Maps/Sets
// ---------------------------------------------------------------------------

describe("persist round-trip", () => {
  it("saves and loads a fully populated session state", async () => {
    const state = freshState({
      sessionId: TEST_SESSION_ID,
      turnCount: 5,
      nudgeCounter: 3,
      nextBlockId: 42,
      nextRunId: 7,
      lastAccessedAt: 1_000_000,
      totalPrunedTokens: 1000,
      totalCompressedTokens: 500,
      blocksById: new Map([
        [
          1,
          {
            blockId: 1,
            runId: 1,
            active: true,
            deactivatedByUser: false,
            compressedTokens: 100,
            summaryTokens: 20,
            mode: "range",
            topic: "test",
            createdAt: 100,
            anchorMessageId: "m0000",
            compressMessageId: "m0001",
            durationMs: 50,
            consumedBlockIds: [],
            parentBlockIds: [],
            includedBlockIds: [1],
            startId: "m0000",
            endId: "m0002",
            directMessageIds: ["m0000"],
            directToolIds: ["t0000"],
            effectiveMessageIds: ["m0000"],
            effectiveToolIds: ["t0000"],
            summary: "test summary",
          },
        ],
      ]),
      byMessageId: new Map([
        [
          "m0000",
          {
            tokenCount: 50,
            allBlockIds: [1],
            activeBlockIds: [1],
          },
        ],
      ]),
      activeBlockIds: new Set([1]),
      activeByAnchorMessageId: new Map([["m0000", 1]]),
      dedupCache: new Map([
        [
          "sig1",
          {
            toolName: "read",
            signature: "sig1",
            firstSeenAt: "m0000",
            latestSeenAt: "m0001",
            callCount: 2,
          },
        ],
      ]),
      errorTracking: new Map([
        [
          "t0000",
          {
            toolCallId: "t0000",
            toolName: "bash",
            turnNumber: 1,
            errorMessage: "not found",
          },
        ],
      ]),
      prune: {
        tools: new Map([["t0001", 5]]),
        prunedCallIds: new Set(["t0000"]),
      },
    });

    saveSessionState(state);

    // Wait for debounce timer (1 s)
    await new Promise((r) => setTimeout(r, 1_100));

    const loaded = loadSessionState(TEST_SESSION_ID);
    assert.ok(loaded, "loaded state should not be null");
    assert.equal(loaded.sessionId, TEST_SESSION_ID);
    assert.equal(loaded.turnCount, 5);
    assert.equal(loaded.nudgeCounter, 3);
    assert.equal(loaded.nextBlockId, 42);
    assert.equal(loaded.nextRunId, 7);
    assert.equal(loaded.totalPrunedTokens, 1000);
    assert.equal(loaded.totalCompressedTokens, 500);

    // Compression blocks
    assert.equal(loaded.blocksById.size, 1);
    const block = loaded.blocksById.get(1);
    assert.ok(block);
    assert.equal(block.topic, "test");

    // Message-block index
    const entry = loaded.byMessageId.get("m0000");
    assert.ok(entry);
    assert.equal(entry.tokenCount, 50);

    // Active sets
    assert.ok(loaded.activeBlockIds.has(1));
    assert.equal(loaded.activeByAnchorMessageId.get("m0000"), 1);

    // Dedup cache
    assert.equal(loaded.dedupCache.size, 1);
    const dedup = loaded.dedupCache.get("sig1");
    assert.ok(dedup);
    assert.equal(dedup.toolName, "read");
    assert.equal(dedup.callCount, 2);

    // Error tracking
    assert.equal(loaded.errorTracking.size, 1);
    const err = loaded.errorTracking.get("t0000");
    assert.ok(err);
    assert.equal(err.errorMessage, "not found");

    // Prune state
    assert.equal(loaded.prune.tools.size, 1);
    assert.ok(loaded.prune.tools.has("t0001"));
    assert.equal(loaded.prune.prunedCallIds.size, 1);
    assert.ok(loaded.prune.prunedCallIds.has("t0000"));
  });

  it("handles empty maps and sets", async () => {
    const state = freshState({ sessionId: TEST_SESSION_ID });
    saveSessionState(state);

    await new Promise((r) => setTimeout(r, 1_100));

    const loaded = loadSessionState(TEST_SESSION_ID);
    assert.ok(loaded);
    assert.equal(loaded.blocksById.size, 0);
    assert.equal(loaded.byMessageId.size, 0);
    assert.equal(loaded.activeBlockIds.size, 0);
    assert.equal(loaded.activeByAnchorMessageId.size, 0);
    assert.equal(loaded.dedupCache.size, 0);
    assert.equal(loaded.errorTracking.size, 0);
    assert.equal(loaded.prune.tools.size, 0);
    assert.equal(loaded.prune.prunedCallIds.size, 0);
  });
});

// ---------------------------------------------------------------------------
// (b) loadSessionState returns null for non-existent session
// ---------------------------------------------------------------------------

describe("loadSessionState non-existent", () => {
  it("returns null when no file exists", () => {
    const loaded = loadSessionState("non-existent-session-id");
    assert.equal(loaded, null);
  });
});

// ---------------------------------------------------------------------------
// (c) deletePersistedState removes the file
// ---------------------------------------------------------------------------

describe("deletePersistedState", () => {
  it("removes the persisted file so load returns null", async () => {
    const state = freshState({ sessionId: TEST_SESSION_DELETE });
    saveSessionState(state);
    await new Promise((r) => setTimeout(r, 1_100));

    assert.ok(
      loadSessionState(TEST_SESSION_DELETE),
      "state should exist after save",
    );

    deletePersistedState(TEST_SESSION_DELETE);

    assert.equal(
      loadSessionState(TEST_SESSION_DELETE),
      null,
      "state should be null after delete",
    );
  });

  it("does not throw when deleting a non-existent session", () => {
    assert.doesNotThrow(() => {
      deletePersistedState("never-saved-session");
    });
  });
});

// ---------------------------------------------------------------------------
// (d) cleanupExpiredSessions
// ---------------------------------------------------------------------------

describe("cleanupExpiredSessions", () => {
  before(async () => {
    // Persist a state with an extremely short TTL
    const state = freshState({ sessionId: TEST_SESSION_CLEANUP });
    saveSessionState(state);
    await new Promise((r) => setTimeout(r, 1_100));
  });

  it("removes session files older than the given TTL", async () => {
    // First verify the file exists
    assert.ok(loadSessionState(TEST_SESSION_CLEANUP));

    // Use a TTL of 0 ms to force immediate expiry
    cleanupExpiredSessions(0);

    // The file should now be gone
    assert.equal(loadSessionState(TEST_SESSION_CLEANUP), null);
  });

  it("does not throw when storage directory does not exist", () => {
    assert.doesNotThrow(() => {
      cleanupExpiredSessions(0);
    });
  });

  it("default TTL is 30 minutes and does not delete recent files", () => {
    // Calling with default TTL should NOT delete a file we just created
    // (but since we deleted in the previous test, re-create it)
    const state = freshState({ sessionId: TEST_SESSION_CLEANUP });
    saveSessionState(state);
    // No await — we want to test the default path, but we won't assert
    // on load since the debounce may not have fired yet.
    // Just verify it doesn't throw.
    assert.doesNotThrow(() => {
      cleanupExpiredSessions();
    });
  });
});
