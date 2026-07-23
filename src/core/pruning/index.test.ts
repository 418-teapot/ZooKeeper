/**
 * Tests for the context-pruning module.
 *
 * Covers: empty state → noop, pre-populated state → output replaced,
 * sweep callID collection (last-user-index + last-N semantics),
 * duplicate mark prevention, placeholder verbatim match.
 *
 * DCP alignment: `prune.tools` accumulates (never cleared by prune),
 * `stats.totalPruneTokens` replaces `totalPrunedTokens`, persistence
 * uses `saveSessionState`/`loadSessionState`/`deleteSessionState`.
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { _resetForTesting } from "../../utils/logger.js";
import type { ContextMessageEntry } from "../metrics.js";
import { estimateTokenCount } from "../metrics.js";
import {
  collectSweepCallIDs,
  deleteSessionState,
  getOrCreateSessionState,
  loadSessionState,
  PRUNED_TOOL_OUTPUT_REPLACEMENT,
  pruneToolOutputs,
  removeSession,
  saveSessionState,
} from "./index.js";
import {
  _clearAllSessionsForTesting,
  _removeSessionForTesting,
} from "./state.js";
import type { SweepToolPart } from "./types.js";

// ---------------------------------------------------------------------------
// Teardown
// ---------------------------------------------------------------------------

afterEach(() => {
  _resetForTesting();
  _clearAllSessionsForTesting();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a text part.
 */
function textPart(
  text: string,
  ignored = false,
): { type: string; text: string; ignored?: boolean } {
  return { type: "text", text, ...(ignored ? { ignored: true } : {}) };
}

/**
 * Build a tool part with a callID and output.
 */
function toolPart(
  callID: string,
  output: unknown,
  input?: unknown,
): SweepToolPart {
  return {
    type: "tool",
    callID,
    state: { input: input ?? "", output },
    tool: "bash",
  };
}

/**
 * Build a message entry with the given role and parts.
 */
function msg(
  role: string,
  id: string,
  parts: Array<
    SweepToolPart | { type: string; text: string; ignored?: boolean }
  >,
  sessionID?: string,
): ContextMessageEntry {
  return {
    info: { role, id, ...(sessionID ? { sessionID } : {}) },
    parts: parts as unknown as ContextMessageEntry["parts"],
  };
}

// ---------------------------------------------------------------------------
// PRUNED_TOOL_OUTPUT_REPLACEMENT constant
// ---------------------------------------------------------------------------

describe("PRUNED_TOOL_OUTPUT_REPLACEMENT", () => {
  it("matches the verbatim constant exactly", () => {
    assert.equal(
      PRUNED_TOOL_OUTPUT_REPLACEMENT,
      "[Output removed to save context - information superseded or no longer needed]",
    );
  });
});

// ---------------------------------------------------------------------------
// estimateTokenCount (replaces estimateToolOutputTokens)
// ---------------------------------------------------------------------------

describe("estimateTokenCount", () => {
  it("returns 0 for null / undefined", () => {
    assert.equal(estimateTokenCount(null), 0);
    assert.equal(estimateTokenCount(undefined), 0);
  });

  it("returns 0 for empty string", () => {
    assert.equal(estimateTokenCount(""), 0);
  });

  it("estimates ASCII text at length / 4, ceil'd", () => {
    // "Hello World" = 11 chars → 11/4 = 2.75 → ceil = 3
    assert.equal(estimateTokenCount("Hello World"), 3);
  });

  it("handles JSON output by stringifying", () => {
    const val = { foo: "bar" };
    // JSON.stringify → '{"foo":"bar"}' = 13 chars → 13/4 = 3.25 → ceil = 4
    assert.equal(estimateTokenCount(val), 4);
  });
});

// ---------------------------------------------------------------------------
// pruneToolOutputs — empty state
// ---------------------------------------------------------------------------

describe("pruneToolOutputs with empty state", () => {
  it("is a no-op when state.prune.tools is empty", () => {
    const state = getOrCreateSessionState("sess-empty");
    const messages: ContextMessageEntry[] = [
      msg("user", "u1", [textPart("hello")]),
      msg("assistant", "a1", [toolPart("call-1", "some output")]),
    ];

    // Capture original output for later comparison.
    const originalOutput = (messages[1].parts?.[0] as SweepToolPart).state
      ?.output;

    pruneToolOutputs(state, messages);

    // Output should be unchanged.
    assert.equal(
      (messages[1].parts?.[0] as SweepToolPart).state?.output,
      originalOutput,
    );
    assert.equal(state.stats.totalPruneTokens, 0);
  });

  it("is a no-op when state exists but no marks match", () => {
    const state = getOrCreateSessionState("sess-nomatch");
    // Mark a different callID that doesn't appear in messages.
    state.prune.tools.set("call-other", 50);

    const messages: ContextMessageEntry[] = [
      msg("assistant", "a1", [toolPart("call-1", "data")]),
    ];

    pruneToolOutputs(state, messages);

    // Output unchanged, totalPruneTokens not incremented (unmatched
    // marks don't count — they refer to callIDs not in messages).
    assert.equal(
      (messages[0].parts?.[0] as SweepToolPart).state?.output,
      "data",
    );
    assert.equal(state.stats.totalPruneTokens, 0);
    // Map is NOT cleared (accumulates per DCP).
    assert.equal(state.prune.tools.size, 1);
  });
});

// ---------------------------------------------------------------------------
// pruneToolOutputs — pre-populated state
// ---------------------------------------------------------------------------

describe("pruneToolOutputs with pre-populated state", () => {
  it("replaces marked tool outputs with placeholder", () => {
    const state = getOrCreateSessionState("sess-marked");
    state.prune.tools.set("call-1", 100);
    state.prune.tools.set("call-2", 200);

    const messages: ContextMessageEntry[] = [
      msg("user", "u1", [textPart("do something")]),
      msg("assistant", "a1", [
        toolPart("call-1", "ls output\nfile1\nfile2"),
        textPart("here are the files"),
        toolPart("call-2", "grep result\nmatch"),
      ]),
    ];

    pruneToolOutputs(state, messages);

    const parts = messages[1].parts ?? [];
    // call-1 output replaced.
    assert.equal(
      (parts[0] as SweepToolPart).state?.output,
      PRUNED_TOOL_OUTPUT_REPLACEMENT,
    );
    // call-2 output replaced.
    assert.equal(
      (parts[2] as SweepToolPart).state?.output,
      PRUNED_TOOL_OUTPUT_REPLACEMENT,
    );
    // Text part unchanged.
    assert.equal((parts[1] as { text?: string }).text, "here are the files");
    // totalPruneTokens is NOT modified by prune — token accounting
    // happens at mark time (sweep command).
    assert.equal(state.stats.totalPruneTokens, 0);
  });

  it("handles tool parts without pre-existing state object", () => {
    const state = getOrCreateSessionState("sess-nostate");
    state.prune.tools.set("call-1", 50);

    const messages: ContextMessageEntry[] = [
      msg("assistant", "a1", [
        {
          type: "tool",
          callID: "call-1",
          tool: "bash",
          // No state property at all.
        } as SweepToolPart,
      ]),
    ];

    pruneToolOutputs(state, messages);

    // A state object should have been created with the placeholder.
    const part = messages[0].parts?.[0] as SweepToolPart;
    assert.ok(part.state);
    assert.equal(part.state?.output, PRUNED_TOOL_OUTPUT_REPLACEMENT);
    // totalPruneTokens is NOT modified by prune.
    assert.equal(state.stats.totalPruneTokens, 0);
  });

  it("only replaces tools with matching callID, skips others", () => {
    const state = getOrCreateSessionState("sess-skip");
    state.prune.tools.set("call-1", 100);

    const messages: ContextMessageEntry[] = [
      msg("assistant", "a1", [
        toolPart("call-1", "output A"),
        toolPart("call-2", "output B"),
        toolPart("call-3", "output C"),
      ]),
    ];

    pruneToolOutputs(state, messages);

    const parts = messages[0].parts ?? [];
    assert.equal(
      (parts[0] as SweepToolPart).state?.output,
      PRUNED_TOOL_OUTPUT_REPLACEMENT,
    );
    assert.equal((parts[1] as SweepToolPart).state?.output, "output B");
    assert.equal((parts[2] as SweepToolPart).state?.output, "output C");
    // totalPruneTokens is NOT modified by prune.
    assert.equal(state.stats.totalPruneTokens, 0);
  });

  it("does NOT clear prune.tools after processing (DCP accumulate)", () => {
    const state = getOrCreateSessionState("sess-accumulate");
    state.prune.tools.set("call-1", 100);
    state.prune.tools.set("call-2", 200);

    const messages: ContextMessageEntry[] = [
      msg("assistant", "a1", [
        toolPart("call-1", "data A"),
        toolPart("call-2", "data B"),
      ]),
    ];

    pruneToolOutputs(state, messages);

    // Map should NOT be cleared after processing (DCP semantics).
    assert.equal(state.prune.tools.size, 2);

    // Second call with same messages — outputs already placeholders.
    pruneToolOutputs(state, messages);

    // Output stays as placeholder (already replaced).
    assert.equal(
      (messages[0].parts?.[0] as SweepToolPart).state?.output,
      PRUNED_TOOL_OUTPUT_REPLACEMENT,
    );
    // totalPruneTokens is NOT modified by prune (token accounting
    // happens at mark time, not here).
    assert.equal(state.stats.totalPruneTokens, 0);
  });
});

// ---------------------------------------------------------------------------
// Duplicate mark
// ---------------------------------------------------------------------------

describe("duplicate mark prevention", () => {
  it("collectSweepCallIDs skips already-marked callIDs (no-arg path)", () => {
    const alreadyMarked = new Set(["call-1"]);
    const messages: ContextMessageEntry[] = [
      msg("user", "u1", [textPart("do it")]),
      msg("assistant", "a1", [
        toolPart("call-1", "output A"),
        toolPart("call-2", "output B"),
      ]),
    ];

    const marks = collectSweepCallIDs(messages, alreadyMarked);
    // After last user (u1): call-1 and call-2. call-1 is marked → skip.
    assert.equal(marks.length, 1);
    assert.equal(marks[0].callID, "call-2");
  });

  it("pruneToolOutputs does not double-count token reclaim", () => {
    const state = getOrCreateSessionState("sess-dedup");
    state.prune.tools.set("call-1", 100);

    // Two different messages with the same callID (unusual but defensive).
    const messages: ContextMessageEntry[] = [
      msg("assistant", "a1", [toolPart("call-1", "output A")]),
      msg("assistant", "a2", [toolPart("call-1", "output B")]),
    ];

    pruneToolOutputs(state, messages);

    // Both occurrences should be replaced.
    assert.equal(
      (messages[0].parts?.[0] as SweepToolPart).state?.output,
      PRUNED_TOOL_OUTPUT_REPLACEMENT,
    );
    assert.equal(
      (messages[1].parts?.[0] as SweepToolPart).state?.output,
      PRUNED_TOOL_OUTPUT_REPLACEMENT,
    );
    // totalPruneTokens is NOT modified by prune (token accounting
    // happens at mark time, not here).
    assert.equal(state.stats.totalPruneTokens, 0);
  });
});

// ---------------------------------------------------------------------------
// collectSweepCallIDs — last-user-index semantics (no-arg)
// ---------------------------------------------------------------------------

describe("collectSweepCallIDs (no-arg / default)", () => {
  it("collects all tool callIDs after last user message", () => {
    const messages: ContextMessageEntry[] = [
      msg("user", "u1", [textPart("first command")]),
      msg("assistant", "a1", [toolPart("call-1", "result 1")]),
      msg("user", "u2", [textPart("second command")]),
      msg("assistant", "a2", [toolPart("call-2", "result 2")]),
      msg("assistant", "a3", [toolPart("call-3", "result 3")]),
    ];

    const marks = collectSweepCallIDs(messages, new Set());
    assert.equal(marks.length, 2);
    assert.equal(marks[0].callID, "call-2");
    assert.equal(marks[1].callID, "call-3");
  });

  it("skips ignored user messages when finding last user", () => {
    const messages: ContextMessageEntry[] = [
      msg("user", "u1", [textPart("real message")]),
      msg("assistant", "a1", [toolPart("call-1", "output 1")]),
      msg("user", "u-ignored", [textPart("injected context", true)]),
      msg("assistant", "a2", [toolPart("call-2", "output 2")]),
    ];

    const marks = collectSweepCallIDs(messages, new Set());
    // Last non-ignored user is u1 at index 0, so tool parts after it
    // are call-1 and call-2.
    assert.equal(marks.length, 2);
    assert.equal(marks[0].callID, "call-1");
    assert.equal(marks[1].callID, "call-2");
  });

  it("returns empty array when no user message found", () => {
    const messages: ContextMessageEntry[] = [
      msg("assistant", "a1", [toolPart("call-1", "data")]),
    ];

    const marks = collectSweepCallIDs(messages, new Set());
    assert.equal(marks.length, 0);
  });

  it("returns empty array when no tool parts after last user", () => {
    const messages: ContextMessageEntry[] = [
      msg("user", "u1", [textPart("hello")]),
    ];

    const marks = collectSweepCallIDs(messages, new Set());
    assert.equal(marks.length, 0);
  });

  it("skips parts without callID", () => {
    const messages: ContextMessageEntry[] = [
      msg("user", "u1", [textPart("do it")]),
      msg("assistant", "a1", [
        { type: "tool", tool: "bash", state: { output: "no callID" } },
        toolPart("call-1", "has callID"),
      ]),
    ];

    const marks = collectSweepCallIDs(messages, new Set());
    assert.equal(marks.length, 1);
    assert.equal(marks[0].callID, "call-1");
  });
});

// ---------------------------------------------------------------------------
// collectSweepCallIDs — last-N semantics (numeric arg)
// ---------------------------------------------------------------------------

describe("collectSweepCallIDs (numeric arg)", () => {
  it("collects last N tool callIDs from messages (walk backward)", () => {
    const messages: ContextMessageEntry[] = [
      msg("assistant", "a1", [toolPart("call-1", "result 1")]),
      msg("assistant", "a2", [toolPart("call-2", "result 2")]),
      msg("assistant", "a3", [toolPart("call-3", "result 3")]),
    ];

    const marks = collectSweepCallIDs(messages, new Set(), 2);
    // Walk backward: a3 (call-3), then a2 (call-2).
    assert.equal(marks.length, 2);
    assert.equal(marks[0].callID, "call-3");
    assert.equal(marks[1].callID, "call-2");
  });

  it("stops at N even when more tool parts exist", () => {
    const messages: ContextMessageEntry[] = [
      msg("assistant", "a1", [toolPart("call-1", "r1")]),
      msg("assistant", "a2", [toolPart("call-2", "r2")]),
      msg("assistant", "a3", [toolPart("call-3", "r3")]),
    ];

    const marks = collectSweepCallIDs(messages, new Set(), 1);
    assert.equal(marks.length, 1);
    assert.equal(marks[0].callID, "call-3"); // newest first
  });

  it("collects multiple tool parts from the same message (reverse parts)", () => {
    const messages: ContextMessageEntry[] = [
      msg("assistant", "a1", [
        toolPart("call-1", "r1"),
        toolPart("call-2", "r2"),
        toolPart("call-3", "r3"),
      ]),
    ];

    const marks = collectSweepCallIDs(messages, new Set(), 2);
    assert.equal(marks.length, 2);
    // Walk backward: a1 only message, parts walked backward too.
    assert.equal(marks[0].callID, "call-3");
    assert.equal(marks[1].callID, "call-2");
  });

  it("returns fewer than N when not enough tool parts exist", () => {
    const messages: ContextMessageEntry[] = [
      msg("assistant", "a1", [toolPart("call-1", "r1")]),
    ];

    const marks = collectSweepCallIDs(messages, new Set(), 5);
    assert.equal(marks.length, 1);
    assert.equal(marks[0].callID, "call-1");
  });

  it("returns empty array for N=0", () => {
    const messages: ContextMessageEntry[] = [
      msg("assistant", "a1", [toolPart("call-1", "r1")]),
    ];

    const marks = collectSweepCallIDs(messages, new Set(), 0);
    assert.equal(marks.length, 0);
  });

  it("respects already-marked filter with numeric count", () => {
    const alreadyMarked = new Set(["call-3"]);
    const messages: ContextMessageEntry[] = [
      msg("assistant", "a1", [toolPart("call-1", "r1")]),
      msg("assistant", "a2", [toolPart("call-2", "r2")]),
      msg("assistant", "a3", [toolPart("call-3", "r3")]),
    ];

    const marks = collectSweepCallIDs(messages, alreadyMarked, 1);
    // Walk backward: a3 (call-3 → skipped), a2 (call-2 → collected)
    assert.equal(marks.length, 1);
    assert.equal(marks[0].callID, "call-2");
  });
});

// ---------------------------------------------------------------------------
// State management
// ---------------------------------------------------------------------------

describe("getOrCreateSessionState", () => {
  it("creates a fresh state with empty prune map and zero stats", () => {
    const state = getOrCreateSessionState("sess-fresh");
    assert.equal(state.sessionId, "sess-fresh");
    assert.ok(state.prune.tools instanceof Map);
    assert.equal(state.prune.tools.size, 0);
    assert.equal(state.stats.totalPruneTokens, 0);
    assert.ok(typeof state.lastAccessedAt === "number");
  });

  it("returns the same state for the same session ID", () => {
    const state1 = getOrCreateSessionState("sess-same");
    state1.stats.totalPruneTokens = 42;

    const state2 = getOrCreateSessionState("sess-same");
    assert.equal(state2.stats.totalPruneTokens, 42);
    assert.equal(state1, state2); // Same object reference.
  });

  it("creates independent states for different session IDs", () => {
    const s1 = getOrCreateSessionState("sess-a");
    const s2 = getOrCreateSessionState("sess-b");
    assert.notEqual(s1, s2);
    assert.equal(s1.stats.totalPruneTokens, 0);
    assert.equal(s2.stats.totalPruneTokens, 0);
  });
});

describe("state teardown helpers", () => {
  it("_removeSessionForTesting removes a session", () => {
    const s1 = getOrCreateSessionState("sess-rm");
    _removeSessionForTesting("sess-rm");
    const s2 = getOrCreateSessionState("sess-rm");
    assert.notEqual(s1, s2); // Different object after re-creation.
  });

  it("removeSession removes a session by ID (production cleanup)", () => {
    const s1 = getOrCreateSessionState("sess-prod");
    removeSession("sess-prod");
    const s2 = getOrCreateSessionState("sess-prod");
    assert.notEqual(s1, s2); // Different object after re-creation.
  });

  it("removeSession does not throw for non-existent session", () => {
    removeSession("sess-nonexistent");
    // No assertion needed — the test passes if no throw occurs.
    assert.ok(true);
  });
});

// ---------------------------------------------------------------------------
// saveSessionState + loadSessionState round-trip
// ---------------------------------------------------------------------------

describe("saveSessionState / loadSessionState", () => {
  const testSessionId = "sess-rt-test";

  afterEach(() => {
    // Clean up the persisted file after each test.
    deleteSessionState(testSessionId);
  });

  it("round-trips prune.tools and stats.totalPruneTokens", () => {
    const state = getOrCreateSessionState(testSessionId);
    state.prune.tools.set("call-1", 100);
    state.prune.tools.set("call-2", 200);
    state.stats.totalPruneTokens = 300;

    saveSessionState(testSessionId, state);

    const loaded = loadSessionState(testSessionId);
    assert.ok(loaded !== null);
    assert.equal(loaded.prune.tools.size, 2);
    assert.ok(loaded.prune.tools.has("call-1"));
    assert.equal(loaded.prune.tools.get("call-1"), 100);
    assert.ok(loaded.prune.tools.has("call-2"));
    assert.equal(loaded.prune.tools.get("call-2"), 200);
    assert.equal(loaded.stats.totalPruneTokens, 300);
  });

  it("returns null when no file exists (missing session)", () => {
    const loaded = loadSessionState("sess-nonexistent-12345");
    assert.equal(loaded, null);
  });

  it("returns null on corrupt file (defensive)", () => {
    // Write invalid JSON to the file.
    const fs = require("node:fs");
    const path = require("node:path");
    const os = require("node:os");
    const dir = path.join(os.homedir(), ".zoo", "storage");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${testSessionId}.json`), "not json{{{");
    const loaded = loadSessionState(testSessionId);
    assert.equal(loaded, null);
  });

  it("loads state on getOrCreateSessionState (restart recovery)", () => {
    // Persist state first.
    const state = getOrCreateSessionState(testSessionId);
    state.prune.tools.set("call-recovery", 50);
    state.stats.totalPruneTokens = 50;
    saveSessionState(testSessionId, state);

    // Clear module-level map and re-create.
    _removeSessionForTesting(testSessionId);
    const restored = getOrCreateSessionState(testSessionId);
    assert.ok(restored.prune.tools.has("call-recovery"));
    assert.equal(restored.prune.tools.size, 1);
    assert.equal(restored.stats.totalPruneTokens, 50);
  });

  it("deleteSessionState removes the persisted file", () => {
    // Persist state first.
    const state = getOrCreateSessionState(testSessionId);
    saveSessionState(testSessionId, state);
    assert.ok(loadSessionState(testSessionId) !== null);

    // Delete and verify.
    deleteSessionState(testSessionId);
    assert.equal(loadSessionState(testSessionId), null);
  });

  it("deleteSessionState does not throw for non-existent session", () => {
    deleteSessionState("sess-no-file");
    // No assertion — test passes if no throw.
    assert.ok(true);
  });
});

// ---------------------------------------------------------------------------
// pruneToolOutputs — prune.tools accumulates across turns (no clear)
// ---------------------------------------------------------------------------

describe("pruneToolOutputs accumulation (no clear)", () => {
  it("prune.tools.size stays unchanged after prune", () => {
    const state = getOrCreateSessionState("sess-no-clear");
    state.prune.tools.set("call-1", 100);
    state.prune.tools.set("call-2", 200);

    const messages: ContextMessageEntry[] = [
      msg("assistant", "a1", [
        toolPart("call-1", "data A"),
        toolPart("call-2", "data B"),
      ]),
    ];

    assert.equal(state.prune.tools.size, 2);
    pruneToolOutputs(state, messages);
    // Map is NOT cleared — stays at 2.
    assert.equal(state.prune.tools.size, 2);
  });

  it("accumulates marks across multiple sweep+prune turns", () => {
    const state = getOrCreateSessionState("sess-multi-turn");

    // Turn 1: mark call-1 → prune.
    state.prune.tools.set("call-1", 100);
    pruneToolOutputs(state, [
      msg("assistant", "a1", [toolPart("call-1", "out1")]),
    ]);
    assert.equal(state.prune.tools.size, 1); // Not cleared.
    // totalPruneTokens is NOT modified by prune (token accounting
    // happens at mark time).
    assert.equal(state.stats.totalPruneTokens, 0);

    // Turn 2: mark call-2 (in addition to accumulated call-1) → prune.
    state.prune.tools.set("call-2", 200);
    assert.equal(state.prune.tools.size, 2);
    pruneToolOutputs(state, [
      msg("assistant", "a2", [toolPart("call-2", "out2")]),
    ]);
    assert.equal(state.prune.tools.size, 2); // Still not cleared.
    // totalPruneTokens stays at 0 (unmodified by prune).
    assert.equal(state.stats.totalPruneTokens, 0);
  });
});

// ---------------------------------------------------------------------------
// Re-pruning already-placeholder output does NOT double-count
// ---------------------------------------------------------------------------

describe("re-prune already-placeholder output (no double-count)", () => {
  it("does not increment totalPruneTokens when output is already placeholder", () => {
    const state = getOrCreateSessionState("sess-reprune");
    state.prune.tools.set("call-1", 100);

    const messages: ContextMessageEntry[] = [
      msg("assistant", "a1", [toolPart("call-1", "real output")]),
    ];

    // Prune replaces output but does NOT touch stats.
    pruneToolOutputs(state, messages);
    assert.equal(state.stats.totalPruneTokens, 0);

    // Second prune: output already placeholder, same behavior.
    pruneToolOutputs(state, messages);
    assert.equal(state.stats.totalPruneTokens, 0);
  });

  it("only counts newly-pruned callIDs, not previously-pruned ones", () => {
    const state = getOrCreateSessionState("sess-mixed-reprune");
    state.prune.tools.set("call-old", 50);
    state.prune.tools.set("call-new", 150);

    const messages: ContextMessageEntry[] = [
      msg("assistant", "a1", [
        // call-old output is already the placeholder (pruned in previous turn).
        toolPart("call-old", PRUNED_TOOL_OUTPUT_REPLACEMENT),
        // call-new has real output (first-time prune).
        toolPart("call-new", "fresh output"),
      ]),
    ];

    pruneToolOutputs(state, messages);

    // totalPruneTokens is NOT modified by prune — token accounting
    // happens at mark time.
    assert.equal(state.stats.totalPruneTokens, 0);
  });
});

// ---------------------------------------------------------------------------
// pruneToolOutputs stats persist across restart
// ---------------------------------------------------------------------------

describe("stats.totalPruneTokens persists across restart", () => {
  const testSessionId = "sess-restart-stats";

  afterEach(() => {
    deleteSessionState(testSessionId);
    _removeSessionForTesting(testSessionId);
  });

  it("round-trips totalPruneTokens through save+load", () => {
    const state = getOrCreateSessionState(testSessionId);
    state.prune.tools.set("call-1", 100);
    // Simulate mark-time accumulation (actual sweep command does this).
    state.stats.totalPruneTokens = 100;
    pruneToolOutputs(state, [
      msg("assistant", "a1", [toolPart("call-1", "output")]),
    ]);

    // Prune does NOT modify stats; value stays at mark-time accumulation.
    assert.equal(state.stats.totalPruneTokens, 100);

    // Persist.
    saveSessionState(testSessionId, state);

    // Load from disk (simulate restart).
    const loaded = loadSessionState(testSessionId);
    assert.ok(loaded !== null);
    assert.equal(loaded.stats.totalPruneTokens, 100);
  });

  it("recovers totalPruneTokens on getOrCreateSessionState after restart", () => {
    const state = getOrCreateSessionState(testSessionId);
    state.prune.tools.set("call-1", 100);
    // Simulate mark-time accumulation (actual sweep command does this).
    state.stats.totalPruneTokens = 100;
    pruneToolOutputs(state, [
      msg("assistant", "a1", [toolPart("call-1", "output")]),
    ]);
    saveSessionState(testSessionId, state);

    // Clear module-level state (simulate restart).
    _removeSessionForTesting(testSessionId);
    _clearAllSessionsForTesting();

    const restored = getOrCreateSessionState(testSessionId);
    assert.equal(restored.stats.totalPruneTokens, 100);
    assert.ok(restored.prune.tools.has("call-1"));
  });
});
