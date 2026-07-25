/**
 * Tests for the unified marks collection.
 *
 * Covers: addMark idempotency, releaseBatch only counts real flips,
 * derived stats (pendingCount/pendingTokens/reclaimedTokens/markedCount/
 * markedTokens), persistence round-trip, old-shape loaded as empty,
 * state management (get-or-create, remove, TTL cleanup).
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  _clearAllSessionsForTesting,
  addMark,
  deleteSessionState,
  getOrCreateSessionState,
  loadSessionState,
  markedCount,
  markedTokens,
  pendingCount,
  pendingTokens,
  reclaimedTokens,
  releaseBatch,
  removeSession,
  saveSessionState,
} from "./marks.js";

// ---------------------------------------------------------------------------
// Teardown
// ---------------------------------------------------------------------------

afterEach(() => {
  _clearAllSessionsForTesting();
});

// ---------------------------------------------------------------------------
// addMark
// ---------------------------------------------------------------------------

describe("addMark", () => {
  it("adds a new mark and returns true", () => {
    const state = getOrCreateSessionState("sess-add");
    const result = addMark(state, "call-1", 100, true);
    assert.equal(result, true);
    assert.ok(state.marks.has("call-1"));
    assert.equal(state.marks.get("call-1")?.tokens, 100);
    assert.equal(state.marks.get("call-1")?.effective, true);
    assert.equal(state.dirty, true);
  });

  it("adds a non-effective mark", () => {
    const state = getOrCreateSessionState("sess-add-pending");
    const result = addMark(state, "call-1", 50, false);
    assert.equal(result, true);
    assert.equal(state.marks.get("call-1")?.effective, false);
  });

  it("is idempotent — returns false for duplicate callID", () => {
    const state = getOrCreateSessionState("sess-idem");
    assert.equal(addMark(state, "call-1", 100, true), true);
    assert.equal(state.dirty, true);

    // Reset dirty to verify second add does NOT set it.
    state.dirty = false;
    assert.equal(addMark(state, "call-1", 200, false), false);
    // Original data preserved.
    assert.equal(state.marks.get("call-1")?.tokens, 100);
    assert.equal(state.marks.get("call-1")?.effective, true);
    // dirty NOT set.
    assert.equal(state.dirty, false);
  });
});

// ---------------------------------------------------------------------------
// releaseBatch
// ---------------------------------------------------------------------------

describe("releaseBatch", () => {
  it("flips all non-effective marks, returns count and tokens", () => {
    const state = getOrCreateSessionState("sess-release");
    addMark(state, "call-1", 100, false);
    addMark(state, "call-2", 200, false);
    addMark(state, "call-3", 50, true); // Already effective — not flipped.

    const { count, tokens } = releaseBatch(state);
    assert.equal(count, 2);
    assert.equal(tokens, 300);
    assert.equal(state.marks.get("call-1")?.effective, true);
    assert.equal(state.marks.get("call-2")?.effective, true);
    assert.equal(state.marks.get("call-3")?.effective, true);
    assert.equal(state.dirty, true);
  });

  it("is idempotent on empty pending — returns {0,0} and does NOT set dirty", () => {
    const state = getOrCreateSessionState("sess-release-empty");
    state.dirty = false;
    const { count, tokens } = releaseBatch(state);
    assert.equal(count, 0);
    assert.equal(tokens, 0);
    assert.equal(state.dirty, false);
  });

  it("only counts actually flipped marks (fixes stats inflation)", () => {
    const state = getOrCreateSessionState("sess-release-flip-only");
    addMark(state, "call-1", 100, false);
    addMark(state, "call-2", 50, true); // Already effective.

    const r1 = releaseBatch(state);
    assert.equal(r1.count, 1);
    assert.equal(r1.tokens, 100);

    // Second release — nothing left to flip.
    state.dirty = false;
    const r2 = releaseBatch(state);
    assert.equal(r2.count, 0);
    assert.equal(r2.tokens, 0);
    assert.equal(state.dirty, false);
  });
});

// ---------------------------------------------------------------------------
// Derived stats
// ---------------------------------------------------------------------------

describe("derived stats", () => {
  it("pendingCount returns number of non-effective marks", () => {
    const state = getOrCreateSessionState("sess-pc");
    assert.equal(pendingCount(state), 0);
    addMark(state, "call-1", 100, false);
    assert.equal(pendingCount(state), 1);
    addMark(state, "call-2", 50, true);
    assert.equal(pendingCount(state), 1);
    addMark(state, "call-3", 30, false);
    assert.equal(pendingCount(state), 2);
  });

  it("pendingTokens returns sum of non-effective marks' tokens", () => {
    const state = getOrCreateSessionState("sess-pt");
    addMark(state, "call-1", 100, false);
    addMark(state, "call-2", 50, true);
    addMark(state, "call-3", 30, false);
    assert.equal(pendingTokens(state), 130);
  });

  it("reclaimedTokens returns sum of effective marks' tokens", () => {
    const state = getOrCreateSessionState("sess-rt");
    addMark(state, "call-1", 100, false);
    addMark(state, "call-2", 50, true);
    addMark(state, "call-3", 30, true);
    assert.equal(reclaimedTokens(state), 80);

    // After release, all effective.
    releaseBatch(state);
    assert.equal(reclaimedTokens(state), 180);
  });

  it("markedCount returns total marks size", () => {
    const state = getOrCreateSessionState("sess-mc");
    assert.equal(markedCount(state), 0);
    addMark(state, "call-1", 100, false);
    assert.equal(markedCount(state), 1);
    addMark(state, "call-2", 50, true);
    assert.equal(markedCount(state), 2);
  });

  it("markedTokens returns sum of all marks' tokens", () => {
    const state = getOrCreateSessionState("sess-mt");
    addMark(state, "call-1", 100, false);
    addMark(state, "call-2", 50, true);
    assert.equal(markedTokens(state), 150);
  });
});

// ---------------------------------------------------------------------------
// State management
// ---------------------------------------------------------------------------

describe("getOrCreateSessionState", () => {
  it("creates a fresh state with empty marks", () => {
    const state = getOrCreateSessionState("sess-fresh");
    assert.equal(state.sessionId, "sess-fresh");
    assert.equal(state.marks.size, 0);
    assert.ok(typeof state.lastAccessedAt === "number");
    assert.equal(state.dirty, false);
  });

  it("returns the same state for the same session ID", () => {
    const state1 = getOrCreateSessionState("sess-same");
    addMark(state1, "call-1", 100, true);

    const state2 = getOrCreateSessionState("sess-same");
    assert.ok(state2.marks.has("call-1"));
    assert.equal(state1, state2); // Same object reference.
  });

  it("creates independent states for different session IDs", () => {
    const s1 = getOrCreateSessionState("sess-a");
    const s2 = getOrCreateSessionState("sess-b");
    assert.notEqual(s1, s2);
  });
});

describe("removeSession", () => {
  it("removes a session by ID (production)", () => {
    const s1 = getOrCreateSessionState("sess-rm");
    removeSession("sess-rm");
    const s2 = getOrCreateSessionState("sess-rm");
    assert.notEqual(s1, s2);
  });

  it("does not throw for non-existent session", () => {
    removeSession("sess-nonexistent");
    assert.ok(true);
  });
});

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

describe("saveSessionState / loadSessionState", () => {
  const TEST_SESSION_ID = "sess-persist-test";

  afterEach(() => {
    deleteSessionState(TEST_SESSION_ID);
    removeSession(TEST_SESSION_ID);
  });

  it("round-trips marks via save+load", () => {
    const state = getOrCreateSessionState(TEST_SESSION_ID);
    addMark(state, "call-1", 100, true);
    addMark(state, "call-2", 200, false);
    addMark(state, "call-3", 50, true);

    saveSessionState(TEST_SESSION_ID, state);

    // Clear and reload from disk.
    removeSession(TEST_SESSION_ID);
    const loaded = loadSessionState(TEST_SESSION_ID);
    assert.ok(loaded !== null);
    assert.equal(loaded.marks.size, 3);
    assert.ok(loaded.marks.has("call-1"));
    assert.equal(loaded.marks.get("call-1")?.tokens, 100);
    assert.equal(loaded.marks.get("call-1")?.effective, true);
    assert.equal(loaded.marks.get("call-2")?.tokens, 200);
    assert.equal(loaded.marks.get("call-2")?.effective, false);
    assert.equal(loaded.marks.get("call-3")?.tokens, 50);
    assert.equal(loaded.marks.get("call-3")?.effective, true);
  });

  it("returns null when no file exists", () => {
    const loaded = loadSessionState("sess-nonexistent-12345");
    assert.equal(loaded, null);
  });

  it("returns null on corrupt file", () => {
    const fs = require("node:fs");
    const path = require("node:path");
    const os = require("node:os");
    const dir = path.join(os.homedir(), ".zoo", "storage");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${TEST_SESSION_ID}.json`), "not json{{{");
    const loaded = loadSessionState(TEST_SESSION_ID);
    assert.equal(loaded, null);
  });

  it("loads old shape (prune.tools/stats) as empty state", () => {
    // Write old-format JSON.
    const fs = require("node:fs");
    const path = require("node:path");
    const os = require("node:os");
    const dir = path.join(os.homedir(), ".zoo", "storage");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, `${TEST_SESSION_ID}.json`),
      JSON.stringify({
        prune: { tools: { "call-old": 50 }, pending: {} },
        stats: { totalPruneTokens: 50, dedupMarkedCount: 3 },
        lastUpdated: "2024-01-01T00:00:00Z",
      }),
      "utf8",
    );

    const loaded = loadSessionState(TEST_SESSION_ID);
    assert.ok(loaded !== null);
    // Old shape treated as empty — no migration.
    assert.equal(loaded.marks.size, 0);
  });

  it("loads state on getOrCreateSessionState (restart recovery)", () => {
    const state = getOrCreateSessionState(TEST_SESSION_ID);
    addMark(state, "call-restored", 75, true);
    saveSessionState(TEST_SESSION_ID, state);

    // Simulate restart.
    removeSession(TEST_SESSION_ID);
    _clearAllSessionsForTesting();

    const restored = getOrCreateSessionState(TEST_SESSION_ID);
    assert.ok(restored.marks.has("call-restored"));
    assert.equal(restored.marks.get("call-restored")?.tokens, 75);
    assert.equal(restored.marks.get("call-restored")?.effective, true);
  });

  it("deleteSessionState removes the persisted file", () => {
    const state = getOrCreateSessionState(TEST_SESSION_ID);
    saveSessionState(TEST_SESSION_ID, state);
    assert.ok(loadSessionState(TEST_SESSION_ID) !== null);

    deleteSessionState(TEST_SESSION_ID);
    assert.equal(loadSessionState(TEST_SESSION_ID), null);
  });

  it("deleteSessionState does not throw for non-existent session", () => {
    deleteSessionState("sess-no-file");
    assert.ok(true);
  });
});

// ---------------------------------------------------------------------------
// Testing seams
// ---------------------------------------------------------------------------

describe("testing seams", () => {
  it("_clearAllSessionsForTesting clears all sessions", () => {
    getOrCreateSessionState("sess-a");
    getOrCreateSessionState("sess-b");
    _clearAllSessionsForTesting();
    const sA = getOrCreateSessionState("sess-a");
    const sB = getOrCreateSessionState("sess-b");
    // After clear, fresh states have empty marks.
    assert.equal(sA.marks.size, 0);
    assert.equal(sB.marks.size, 0);
  });
});
