/**
 * Tests for the unified marks collection.
 *
 * Covers: addMark idempotency, releaseBatch only counts real flips,
 * derived stats (pendingCount/pendingTokens/reclaimedTokens/markedCount/
 * markedTokens), persistence round-trip, unrecognized-shape loaded as empty,
 * state management (get-or-create, remove, TTL cleanup).
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { createBlock } from "./blocks.js";
import {
  _clearAllSessionsForTesting,
  addMark,
  clearPersistedRefs,
  deleteSessionState,
  getOrCreateSessionState,
  loadSessionState,
  markedCount,
  markedTokens,
  pendingCount,
  pendingTokens,
  readPersistedRefs,
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
    const result = addMark(state, "call-1", 100, true, "tool-output");
    assert.equal(result, true);
    assert.ok(state.marks.has("call-1"));
    assert.equal(state.marks.get("call-1")?.tokens, 100);
    assert.equal(state.marks.get("call-1")?.effective, true);
    assert.equal(state.marks.get("call-1")?.action, "tool-output");
    assert.equal(state.dirty, true);
  });

  it("adds a non-effective mark", () => {
    const state = getOrCreateSessionState("sess-add-pending");
    const result = addMark(state, "call-1", 50, false, "tool-output");
    assert.equal(result, true);
    assert.equal(state.marks.get("call-1")?.effective, false);
  });

  it("is idempotent — returns false for duplicate callID", () => {
    const state = getOrCreateSessionState("sess-idem");
    assert.equal(addMark(state, "call-1", 100, true, "tool-output"), true);
    assert.equal(state.dirty, true);

    // Reset dirty to verify second add does NOT set it.
    state.dirty = false;
    assert.equal(addMark(state, "call-1", 200, false, "tool-output"), false);
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
  it("flips all non-effective marks, returns count, tokens & byAction", () => {
    const state = getOrCreateSessionState("sess-release");
    addMark(state, "call-1", 100, false, "tool-output");
    addMark(state, "call-2", 200, false, "tool-output");
    addMark(state, "call-3", 50, true, "tool-output"); // Already effective — not flipped.

    const { count, tokens, byAction } = releaseBatch(state);
    assert.equal(count, 2);
    assert.equal(tokens, 300);
    assert.equal(byAction["tool-output"].count, 2);
    assert.equal(byAction["tool-output"].tokens, 300);
    assert.equal(byAction["tool-error-input"].count, 0);
    assert.equal(byAction["tool-error-input"].tokens, 0);
    assert.equal(state.marks.get("call-1")?.effective, true);
    assert.equal(state.marks.get("call-2")?.effective, true);
    assert.equal(state.marks.get("call-3")?.effective, true);
    assert.equal(state.dirty, true);
  });

  it("is idempotent on empty pending — returns zero fields and does NOT set dirty", () => {
    const state = getOrCreateSessionState("sess-release-empty");
    state.dirty = false;
    const { count, tokens, byAction } = releaseBatch(state);
    assert.equal(count, 0);
    assert.equal(tokens, 0);
    assert.equal(byAction["tool-output"].count, 0);
    assert.equal(byAction["tool-error-input"].count, 0);
    assert.equal(state.dirty, false);
  });

  it("byAction tracks token-output and token-error-input separately", () => {
    const state = getOrCreateSessionState("sess-byaction");
    addMark(state, "call-out-1", 100, false, "tool-output");
    addMark(state, "call-out-2", 200, false, "tool-output");
    addMark(state, "call-err-1", 50, false, "tool-error-input");

    const { count, tokens, byAction } = releaseBatch(state);
    assert.equal(count, 3);
    assert.equal(tokens, 350);
    assert.equal(byAction["tool-output"].count, 2);
    assert.equal(byAction["tool-output"].tokens, 300);
    assert.equal(byAction["tool-error-input"].count, 1);
    assert.equal(byAction["tool-error-input"].tokens, 50);
  });

  it("only counts actually flipped marks (fixes stats inflation)", () => {
    const state = getOrCreateSessionState("sess-release-flip-only");
    addMark(state, "call-1", 100, false, "tool-output");
    addMark(state, "call-2", 50, true, "tool-output"); // Already effective.

    const r1 = releaseBatch(state);
    assert.equal(r1.count, 1);
    assert.equal(r1.tokens, 100);
    assert.equal(r1.byAction["tool-output"].count, 1);
    assert.equal(r1.byAction["tool-output"].tokens, 100);

    // Second release — nothing left to flip.
    state.dirty = false;
    const r2 = releaseBatch(state);
    assert.equal(r2.count, 0);
    assert.equal(r2.tokens, 0);
    assert.equal(r2.byAction["tool-output"].count, 0);
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
    addMark(state, "call-1", 100, false, "tool-output");
    assert.equal(pendingCount(state), 1);
    addMark(state, "call-2", 50, true, "tool-output");
    assert.equal(pendingCount(state), 1);
    addMark(state, "call-3", 30, false, "tool-output");
    assert.equal(pendingCount(state), 2);
  });

  it("pendingTokens returns sum of non-effective marks' tokens", () => {
    const state = getOrCreateSessionState("sess-pt");
    addMark(state, "call-1", 100, false, "tool-output");
    addMark(state, "call-2", 50, true, "tool-output");
    addMark(state, "call-3", 30, false, "tool-output");
    assert.equal(pendingTokens(state), 130);
  });

  it("reclaimedTokens returns sum of effective marks' tokens", () => {
    const state = getOrCreateSessionState("sess-rt");
    addMark(state, "call-1", 100, false, "tool-output");
    addMark(state, "call-2", 50, true, "tool-output");
    addMark(state, "call-3", 30, true, "tool-output");
    assert.equal(reclaimedTokens(state), 80);

    // After release, all effective.
    releaseBatch(state);
    assert.equal(reclaimedTokens(state), 180);
  });

  it("markedCount returns total marks size", () => {
    const state = getOrCreateSessionState("sess-mc");
    assert.equal(markedCount(state), 0);
    addMark(state, "call-1", 100, false, "tool-output");
    assert.equal(markedCount(state), 1);
    addMark(state, "call-2", 50, true, "tool-output");
    assert.equal(markedCount(state), 2);
  });

  it("markedTokens returns sum of all marks' tokens", () => {
    const state = getOrCreateSessionState("sess-mt");
    addMark(state, "call-1", 100, false, "tool-output");
    addMark(state, "call-2", 50, true, "tool-output");
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
    addMark(state1, "call-1", 100, true, "tool-output");

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
    addMark(state, "call-1", 100, true, "tool-output");
    addMark(state, "call-2", 200, false, "tool-output");
    addMark(state, "call-3", 50, true, "tool-output");

    saveSessionState(TEST_SESSION_ID, state);

    // Raw file uses full-word keys.
    const fs = require("node:fs");
    const path = require("node:path");
    const os = require("node:os");
    const raw = JSON.parse(
      fs.readFileSync(
        path.join(os.homedir(), ".zoo", "storage", `${TEST_SESSION_ID}.json`),
        "utf8",
      ),
    );
    assert.deepEqual(Object.keys(raw.marks["call-1"]).sort(), [
      "action",
      "effective",
      "tokens",
    ]);

    // Clear and reload from disk.
    removeSession(TEST_SESSION_ID);
    const loaded = loadSessionState(TEST_SESSION_ID);
    assert.ok(loaded !== null);
    assert.equal(loaded.marks.size, 3);
    assert.ok(loaded.marks.has("call-1"));
    assert.equal(loaded.marks.get("call-1")?.tokens, 100);
    assert.equal(loaded.marks.get("call-1")?.effective, true);
    assert.equal(loaded.marks.get("call-1")?.action, "tool-output");
    assert.equal(loaded.marks.get("call-2")?.tokens, 200);
    assert.equal(loaded.marks.get("call-2")?.effective, false);
    assert.equal(loaded.marks.get("call-2")?.action, "tool-output");
    assert.equal(loaded.marks.get("call-3")?.tokens, 50);
    assert.equal(loaded.marks.get("call-3")?.effective, true);
    assert.equal(loaded.marks.get("call-3")?.action, "tool-output");
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

  it("loads unrecognized shape as empty state", () => {
    // Write an unrecognized JSON shape.
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
    // Unrecognized shape treated as empty.
    assert.equal(loaded.marks.size, 0);
  });

  it("loads v2 shape (missing `a`) as empty state — strict validation", () => {
    const fs = require("node:fs");
    const path = require("node:path");
    const os = require("node:os");
    const dir = path.join(os.homedir(), ".zoo", "storage");
    fs.mkdirSync(dir, { recursive: true });
    // v2 shape: { t, e } without `a`.
    fs.writeFileSync(
      path.join(dir, `${TEST_SESSION_ID}.json`),
      JSON.stringify({
        marks: { "call-1": { t: 100, e: true } },
        lastUpdated: "2024-06-01T00:00:00Z",
      }),
      "utf8",
    );

    const loaded = loadSessionState(TEST_SESSION_ID);
    // Strict validation: missing `a` → entire file treated as empty.
    assert.ok(loaded !== null);
    assert.equal(loaded.marks.size, 0);
  });

  it("loads entries with an invalid action value as empty state", () => {
    const fs = require("node:fs");
    const path = require("node:path");
    const os = require("node:os");
    const dir = path.join(os.homedir(), ".zoo", "storage");
    fs.mkdirSync(dir, { recursive: true });
    // Current full-word shape with an invalid action value.
    fs.writeFileSync(
      path.join(dir, `${TEST_SESSION_ID}.json`),
      JSON.stringify({
        marks: {
          "call-1": { tokens: 100, effective: true, action: "bad-action" },
        },
        lastUpdated: "2024-06-01T00:00:00Z",
      }),
      "utf8",
    );

    const loaded = loadSessionState(TEST_SESSION_ID);
    // Strict validation: invalid action → entire file treated as empty.
    assert.ok(loaded !== null);
    assert.equal(loaded.marks.size, 0);
  });

  it("loads state on getOrCreateSessionState (restart recovery)", () => {
    const state = getOrCreateSessionState(TEST_SESSION_ID);
    addMark(state, "call-restored", 75, true, "tool-output");
    saveSessionState(TEST_SESSION_ID, state);

    // Simulate restart.
    removeSession(TEST_SESSION_ID);
    _clearAllSessionsForTesting();

    const restored = getOrCreateSessionState(TEST_SESSION_ID);
    assert.ok(restored.marks.has("call-restored"));
    assert.equal(restored.marks.get("call-restored")?.tokens, 75);
    assert.equal(restored.marks.get("call-restored")?.effective, true);
  });

  it("round-trips refs via save+load", () => {
    const state = getOrCreateSessionState(TEST_SESSION_ID);
    state.refs = {
      nextRef: 3,
      byRef: { m0001: "u1", m0002: "a1" },
    };
    saveSessionState(TEST_SESSION_ID, state);

    // Simulate restart.
    removeSession(TEST_SESSION_ID);
    _clearAllSessionsForTesting();

    const loaded = loadSessionState(TEST_SESSION_ID);
    assert.ok(loaded !== null);
    assert.deepEqual(loaded.refs, {
      nextRef: 3,
      byRef: { m0001: "u1", m0002: "a1" },
    });
  });

  it("loads old state file without refs key — refs undefined", () => {
    const fs = require("node:fs");
    const path = require("node:path");
    const os = require("node:os");
    const dir = path.join(os.homedir(), ".zoo", "storage");
    fs.mkdirSync(dir, { recursive: true });
    // Legacy file written before the refs field existed (no schema bump).
    fs.writeFileSync(
      path.join(dir, `${TEST_SESSION_ID}.json`),
      JSON.stringify({
        marks: {
          "call-1": { tokens: 100, effective: true, action: "tool-output" },
        },
        lastUpdated: "2024-06-01T00:00:00Z",
      }),
      "utf8",
    );

    const loaded = loadSessionState(TEST_SESSION_ID);
    assert.ok(loaded !== null);
    // Marks still load from the legacy file.
    assert.equal(loaded.marks.size, 1);
    // No refs snapshot — field is absent, not error.
    assert.equal(loaded.refs, undefined);
  });

  it("readPersistedRefs returns null for missing/corrupt state", () => {
    const fs = require("node:fs");
    const path = require("node:path");
    const os = require("node:os");
    const dir = path.join(os.homedir(), ".zoo", "storage");

    // Missing file → null.
    assert.equal(readPersistedRefs("sess-nonexistent-12345"), null);

    // Corrupt JSON → null.
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${TEST_SESSION_ID}.json`), "not json{{{");
    assert.equal(readPersistedRefs(TEST_SESSION_ID), null);

    // Valid file without a refs key → null.
    fs.writeFileSync(
      path.join(dir, `${TEST_SESSION_ID}.json`),
      JSON.stringify({
        marks: {},
        lastUpdated: "2024-01-01T00:00:00Z",
      }),
      "utf8",
    );
    assert.equal(readPersistedRefs(TEST_SESSION_ID), null);
  });

  it("readPersistedRefs returns null for malformed refs shape", () => {
    const fs = require("node:fs");
    const path = require("node:path");
    const os = require("node:os");
    const dir = path.join(os.homedir(), ".zoo", "storage");
    fs.mkdirSync(dir, { recursive: true });
    // Malformed refs: byRef values are numbers, not strings.
    fs.writeFileSync(
      path.join(dir, `${TEST_SESSION_ID}.json`),
      JSON.stringify({
        marks: {},
        refs: { nextRef: 3, byRef: { m0001: 123 } },
        lastUpdated: "2024-01-01T00:00:00Z",
      }),
      "utf8",
    );
    assert.equal(readPersistedRefs(TEST_SESSION_ID), null);
  });

  it("readPersistedRefs rejects a non-positive-integer nextRef", () => {
    const fs = require("node:fs");
    const path = require("node:path");
    const os = require("node:os");
    const dir = path.join(os.homedir(), ".zoo", "storage");
    fs.mkdirSync(dir, { recursive: true });
    // nextRef must be a positive integer (Number.isInteger && >= 1) —
    // zero would otherwise renumber from m0000 on restore.
    fs.writeFileSync(
      path.join(dir, `${TEST_SESSION_ID}.json`),
      JSON.stringify({
        marks: {},
        refs: { nextRef: 0, byRef: { m0001: "u1" } },
        lastUpdated: "2024-01-01T00:00:00Z",
      }),
      "utf8",
    );
    assert.equal(readPersistedRefs(TEST_SESSION_ID), null);
  });

  it("readPersistedRefs rejects byRef keys not matching /^m\\d{4}$/", () => {
    const fs = require("node:fs");
    const path = require("node:path");
    const os = require("node:os");
    const dir = path.join(os.homedir(), ".zoo", "storage");
    fs.mkdirSync(dir, { recursive: true });
    // byRef keys must be zero-padded four-digit refs (m0001…m9999) —
    // a malformed key would break the reverse-lookup on restore.
    fs.writeFileSync(
      path.join(dir, `${TEST_SESSION_ID}.json`),
      JSON.stringify({
        marks: {},
        refs: { nextRef: 2, byRef: { m01: "u1" } },
        lastUpdated: "2024-01-01T00:00:00Z",
      }),
      "utf8",
    );
    assert.equal(readPersistedRefs(TEST_SESSION_ID), null);
  });

  it("getOrCreateSessionState seeds refs from the persisted snapshot", () => {
    const state = getOrCreateSessionState(TEST_SESSION_ID);
    state.refs = {
      nextRef: 5,
      byRef: { m0001: "u1", m0002: "a1", m0003: "u2", m0004: "a2" },
    };
    saveSessionState(TEST_SESSION_ID, state);

    // Simulate restart.
    removeSession(TEST_SESSION_ID);
    _clearAllSessionsForTesting();

    const restored = getOrCreateSessionState(TEST_SESSION_ID);
    assert.deepEqual(restored.refs, {
      nextRef: 5,
      byRef: { m0001: "u1", m0002: "a1", m0003: "u2", m0004: "a2" },
    });
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

  it("clearPersistedRefs removes only the refs field, keeping marks intact", () => {
    const state = getOrCreateSessionState(TEST_SESSION_ID);
    addMark(state, "call-1", 100, true, "tool-output");
    state.refs = { nextRef: 3, byRef: { m0001: "u1", m0002: "a1" } };
    saveSessionState(TEST_SESSION_ID, state);

    clearPersistedRefs(TEST_SESSION_ID);

    // Refs snapshot gone — narrow read returns null.
    assert.equal(readPersistedRefs(TEST_SESSION_ID), null);
    // Marks survive (the file is rewritten, not deleted).
    removeSession(TEST_SESSION_ID);
    _clearAllSessionsForTesting();
    const loaded = loadSessionState(TEST_SESSION_ID);
    assert.ok(loaded !== null);
    assert.equal(loaded.marks.size, 1);
    assert.equal(loaded.marks.get("call-1")?.tokens, 100);
  });

  it("clearPersistedRefs is a no-op when the file or refs field is absent", () => {
    deleteSessionState(TEST_SESSION_ID);
    clearPersistedRefs(TEST_SESSION_ID); // no file
    const state = getOrCreateSessionState(TEST_SESSION_ID);
    saveSessionState(TEST_SESSION_ID, state); // file without refs
    clearPersistedRefs(TEST_SESSION_ID); // refs field absent
    assert.equal(readPersistedRefs(TEST_SESSION_ID), null);
    assert.ok(loadSessionState(TEST_SESSION_ID) !== null);
  });
});

// ---------------------------------------------------------------------------
// Persistence — blocks
// ---------------------------------------------------------------------------

describe("persistence with blocks", () => {
  const B_SESSION_ID = "sess-blocks-persist";

  afterEach(() => {
    deleteSessionState(B_SESSION_ID);
    removeSession(B_SESSION_ID);
  });

  function makePlan(anchor: string, title = "测试主题") {
    return {
      anchorMessageId: anchor,
      messageIds: ["m1", "m2", anchor],
      summary: "test summary",
      title,
      compressedTokens: 1000,
      summaryTokens: 60,
    };
  }

  it("round-trips blocks via save+load", () => {
    const state = getOrCreateSessionState(B_SESSION_ID);
    createBlock(state, makePlan("m3", "第一个主题"));
    createBlock(state, makePlan("m7", "第二个主题"));

    saveSessionState(B_SESSION_ID, state);

    // Clear and reload from disk.
    removeSession(B_SESSION_ID);
    _clearAllSessionsForTesting();

    const loaded = loadSessionState(B_SESSION_ID);
    assert.ok(loaded !== null);
    assert.equal(loaded.blocks.size, 2);

    const b1 = loaded.blocks.get("1");
    assert.ok(b1 !== undefined);
    assert.equal(b1.blockId, 1);
    assert.equal(b1.active, true);
    assert.equal(b1.anchorMessageId, "m3");
    assert.deepEqual(b1.messageIds, ["m1", "m2", "m3"]);
    assert.equal(b1.title, "第一个主题");
    assert.equal(b1.compressedTokens, 1000);
    assert.equal(b1.summaryTokens, 60);
    assert.ok(typeof b1.createdAt === "number");

    const b2 = loaded.blocks.get("2");
    assert.ok(b2 !== undefined);
    assert.equal(b2.blockId, 2);
    assert.equal(b2.anchorMessageId, "m7");
    assert.equal(b2.title, "第二个主题");
  });

  it("writes pretty-printed JSON that still round-trips", () => {
    const fs = require("node:fs");
    const path = require("node:path");
    const os = require("node:os");

    const state = getOrCreateSessionState(B_SESSION_ID);
    addMark(state, "call-1", 100, true, "tool-output");
    createBlock(state, makePlan("m3", "漂亮打印主题"));
    saveSessionState(B_SESSION_ID, state);

    const filePath = path.join(
      os.homedir(),
      ".zoo",
      "storage",
      `${B_SESSION_ID}.json`,
    );
    const raw = fs.readFileSync(filePath, "utf8");
    // Pretty-printed: newlines and 2-space indentation inside objects.
    assert.ok(raw.includes('\n  "marks"'), "expected indented marks key");
    assert.ok(raw.includes('\n      "title"'), "expected indented title key");
    // Parses cleanly and round-trips the title.
    const parsed = JSON.parse(raw);
    assert.equal(parsed.blocks["1"].title, "漂亮打印主题");

    removeSession(B_SESSION_ID);
    _clearAllSessionsForTesting();
    const loaded = loadSessionState(B_SESSION_ID);
    assert.ok(loaded !== null);
    assert.equal(loaded.blocks.get("1")?.title, "漂亮打印主题");
  });

  it("loads a dev-era block without a title (title undefined, not rejected)", () => {
    const fs = require("node:fs");
    const path = require("node:path");
    const os = require("node:os");
    const dir = path.join(os.homedir(), ".zoo", "storage");
    fs.mkdirSync(dir, { recursive: true });
    // Block entry written before the title field existed — no title key.
    fs.writeFileSync(
      path.join(dir, `${B_SESSION_ID}.json`),
      JSON.stringify({
        marks: {
          "call-1": { tokens: 100, effective: true, action: "tool-output" },
        },
        blocks: {
          "1": {
            blockId: 1,
            active: true,
            anchorMessageId: "m3",
            messageIds: ["m1", "m2", "m3"],
            summary: "test",
            compressedTokens: 500,
            summaryTokens: 30,
            createdAt: 123456789,
          },
        },
        lastUpdated: "2024-06-01T00:00:00Z",
      }),
      "utf8",
    );

    const loaded = loadSessionState(B_SESSION_ID);
    assert.ok(loaded !== null, "block without title must not reject the file");
    assert.equal(loaded.blocks.size, 1);
    assert.equal(loaded.blocks.get("1")?.title, undefined);
  });

  it("round-trips an absent title through save+load as undefined", () => {
    const state = getOrCreateSessionState(B_SESSION_ID);
    const block = createBlock(state, makePlan("m3", "初始主题"));
    assert.ok(block !== null);
    // Simulate a dev-era block whose title was never persisted: the title
    // is dropped at save time and reloads as undefined (no assertion).
    block.title = undefined;
    saveSessionState(B_SESSION_ID, state);

    removeSession(B_SESSION_ID);
    _clearAllSessionsForTesting();

    const loaded = loadSessionState(B_SESSION_ID);
    assert.ok(loaded !== null);
    assert.equal(loaded.blocks.size, 1);
    assert.equal(loaded.blocks.get("1")?.title, undefined);
  });

  it("restores state with blocks on getOrCreateSessionState", () => {
    const state = getOrCreateSessionState(B_SESSION_ID);
    createBlock(state, makePlan("m3"));
    saveSessionState(B_SESSION_ID, state);

    // Simulate restart.
    removeSession(B_SESSION_ID);
    _clearAllSessionsForTesting();

    const restored = getOrCreateSessionState(B_SESSION_ID);
    assert.equal(restored.blocks.size, 1);
    assert.ok(restored.blocks.has("1"));
    assert.equal(restored.blocks.get("1")?.anchorMessageId, "m3");
  });

  it("loads file without blocks key as empty block set", () => {
    const fs = require("node:fs");
    const path = require("node:path");
    const os = require("node:os");
    const dir = path.join(os.homedir(), ".zoo", "storage");
    fs.mkdirSync(dir, { recursive: true });
    // File without `blocks` key.
    fs.writeFileSync(
      path.join(dir, `${B_SESSION_ID}.json`),
      JSON.stringify({
        marks: {
          "call-1": { tokens: 100, effective: true, action: "tool-output" },
        },
        lastUpdated: "2024-06-01T00:00:00Z",
      }),
      "utf8",
    );

    const loaded = loadSessionState(B_SESSION_ID);
    assert.ok(loaded !== null);
    // Marks from old file still load.
    assert.equal(loaded.marks.size, 1);
    // Blocks is empty set (not null, not error).
    assert.ok(loaded.blocks instanceof Map);
    assert.equal(loaded.blocks.size, 0);
  });

  it("treats malformed block entry as whole file empty + warn", () => {
    const fs = require("node:fs");
    const path = require("node:path");
    const os = require("node:os");
    const dir = path.join(os.homedir(), ".zoo", "storage");
    fs.mkdirSync(dir, { recursive: true });
    // Blocks present but one entry is missing `anchorMessageId`.
    fs.writeFileSync(
      path.join(dir, `${B_SESSION_ID}.json`),
      JSON.stringify({
        marks: {
          "call-1": { tokens: 100, effective: true, action: "tool-output" },
        },
        blocks: {
          "1": {
            blockId: 1,
            active: true,
            // anchorMessageId MISSING
            messageIds: ["m1"],
            summary: "bad",
            compressedTokens: 500,
            summaryTokens: 30,
            createdAt: 123456789,
          },
        },
        lastUpdated: "2024-06-01T00:00:00Z",
      }),
      "utf8",
    );

    const loaded = loadSessionState(B_SESSION_ID);
    assert.ok(loaded !== null);
    // Both marks AND blocks should be empty — whole file treated as empty.
    assert.equal(loaded.marks.size, 0);
    assert.equal(loaded.blocks.size, 0);
  });

  it("ignores unknown key tier in an old block entry (forward tolerance)", () => {
    const fs = require("node:fs");
    const path = require("node:path");
    const os = require("node:os");
    const dir = path.join(os.homedir(), ".zoo", "storage");
    fs.mkdirSync(dir, { recursive: true });
    // Dev-era file still carries the removed `tier` key.  The loader
    // ignores unknown keys per-field — the block loads cleanly.
    fs.writeFileSync(
      path.join(dir, `${B_SESSION_ID}.json`),
      JSON.stringify({
        marks: {},
        blocks: {
          "1": {
            blockId: 1,
            active: true,
            anchorMessageId: "m3",
            messageIds: ["m1", "m2", "m3"],
            summary: "test",
            compressedTokens: 500,
            summaryTokens: 30,
            tier: 2, // Unknown key — must be ignored.
            createdAt: 123456789,
          },
        },
        lastUpdated: "2024-06-01T00:00:00Z",
      }),
      "utf8",
    );

    const loaded = loadSessionState(B_SESSION_ID);
    assert.ok(loaded !== null);
    assert.equal(loaded.blocks.size, 1);
    const block = loaded.blocks.get("1");
    assert.ok(block !== undefined);
    assert.equal(block.blockId, 1);
    assert.equal(block.anchorMessageId, "m3");
  });

  it("treats blocks with non-array messageIds as whole file empty", () => {
    const fs = require("node:fs");
    const path = require("node:path");
    const os = require("node:os");
    const dir = path.join(os.homedir(), ".zoo", "storage");
    fs.mkdirSync(dir, { recursive: true });
    // Block with messageIds as string instead of array.
    fs.writeFileSync(
      path.join(dir, `${B_SESSION_ID}.json`),
      JSON.stringify({
        marks: {},
        blocks: {
          "1": {
            blockId: 1,
            active: true,
            anchorMessageId: "m3",
            messageIds: "not-an-array", // Invalid.
            summary: "test",
            compressedTokens: 500,
            summaryTokens: 30,
            createdAt: 123456789,
          },
        },
        lastUpdated: "2024-06-01T00:00:00Z",
      }),
      "utf8",
    );

    const loaded = loadSessionState(B_SESSION_ID);
    assert.ok(loaded !== null);
    assert.equal(loaded.marks.size, 0);
    assert.equal(loaded.blocks.size, 0);
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
