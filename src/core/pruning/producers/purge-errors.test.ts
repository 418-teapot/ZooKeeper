/**
 * Tests for the purge-errors producer.
 *
 * Covers: error-status marked successfully, already-marked skip,
 * message-count protection, protected tool skip, zero-benefit skip,
 * non-error status ignored, idempotent re-run.
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { type ContextMessageEntry, estimateTokenCount } from "../../metrics.js";
import {
  _clearAllSessionsForTesting,
  getOrCreateSessionState,
  pendingCount,
  pendingTokens,
} from "../marks.js";
import type { SweepToolPart } from "../types.js";
import { PRUNED_TOOL_ERROR_INPUT_REPLACEMENT } from "../types.js";
import { runPurgeErrors } from "./purge-errors.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Input content long enough to exceed the placeholder token estimate. */
const LONG_INPUT = {
  cmd: "very long command ".repeat(50),
  path: "/very/long/path/".repeat(30),
};

/** Short input that yields zero net reclaim against the placeholder. */
const SHORT_INPUT = { cmd: "ls" };

const LONG_TOOL_INPUT = {
  cmd: "long running process ".repeat(40),
  args: ["-v", "-f", "/tmp/test/file"],
};

// ---------------------------------------------------------------------------
// Teardown
// ---------------------------------------------------------------------------

afterEach(() => {
  _clearAllSessionsForTesting();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toolPart(
  callID: string,
  output: unknown,
  input?: unknown,
  status?: string,
): SweepToolPart {
  const state: Record<string, unknown> = { input: input ?? "", output };
  if (status) state.status = status;
  return {
    type: "tool",
    callID,
    state,
    tool: "bash",
  };
}

function msg(
  role: string,
  id: string,
  parts: Array<
    | SweepToolPart
    | { type: string; text?: string; ignored?: boolean }
    | { type: string }
  >,
): ContextMessageEntry {
  return {
    info: { role, id },
    parts: parts as unknown as ContextMessageEntry["parts"],
  };
}

// ===========================================================================
// Basic — error-status parts get marked
// ===========================================================================

describe("runPurgeErrors — basic", () => {
  it("marks an error-status tool part with pending mark and returns it", () => {
    const state = getOrCreateSessionState("sess-basic");
    const messages = [
      msg("assistant", "a1", [
        toolPart("call-1", "error output", LONG_INPUT, "error"),
      ]),
    ];

    const marks = runPurgeErrors(state, messages, { turnProtection: 0 });

    assert.equal(marks.length, 1);
    assert.equal(marks[0].callID, "call-1");
    assert.equal(marks[0].tool, "bash");
    assert.ok(typeof marks[0].estimatedTokens === "number");
    assert.ok(marks[0].estimatedTokens > 0);
    assert.equal(marks[0].messageIndex, 0);
    assert.equal(marks[0].partIndex, 0);

    // Written as non-effective (pending).
    assert.ok(state.marks.has("call-1"));
    assert.equal(state.marks.get("call-1")?.effective, false);
    assert.equal(state.marks.get("call-1")?.action, "tool-error-input");
    assert.equal(state.dirty, true);
  });

  it("marks multiple error parts across different messages", () => {
    const state = getOrCreateSessionState("sess-multi");
    const messages = [
      msg("assistant", "a1", [
        toolPart("call-1", "err", LONG_TOOL_INPUT, "error"),
      ]),
      msg("assistant", "a2", [
        toolPart("call-2", "err2", LONG_TOOL_INPUT, "error"),
      ]),
    ];

    const marks = runPurgeErrors(state, messages, { turnProtection: 0 });
    assert.equal(marks.length, 2);
    assert.equal(marks[0].callID, "call-1");
    assert.equal(marks[1].callID, "call-2");
  });

  it("handles tool parts without pre-existing state object", () => {
    const state = getOrCreateSessionState("sess-nostate");
    const messages = [
      msg("assistant", "a1", [
        {
          type: "tool",
          callID: "call-1",
          state: {
            input: LONG_INPUT,
            output: "error",
            status: "error",
          },
          tool: "bash",
        } as SweepToolPart,
      ]),
    ];

    const marks = runPurgeErrors(state, messages, { turnProtection: 0 });
    assert.equal(marks.length, 1);
    assert.equal(marks[0].callID, "call-1");
  });

  it("handles parts where callID is on callId (lowercase d)", () => {
    const state = getOrCreateSessionState("sess-callid-lower");
    const messages = [
      msg("assistant", "a1", [
        {
          type: "tool",
          callId: "call-1",
          state: { input: LONG_INPUT, output: "err", status: "error" },
          tool: "bash",
        } as unknown as SweepToolPart,
      ]),
    ];

    const marks = runPurgeErrors(state, messages, { turnProtection: 0 });
    assert.equal(marks.length, 1);
    assert.equal(marks[0].callID, "call-1");
  });
});

// ===========================================================================
// Already-marked skip
// ===========================================================================

describe("runPurgeErrors — already-marked skip", () => {
  it("skips callIDs already in state.marks", () => {
    const state = getOrCreateSessionState("sess-already");
    // Pre-mark call-1.
    state.marks.set("call-1", {
      tokens: 50,
      effective: false,
      action: "tool-error-input",
    });

    const messages = [
      msg("assistant", "a1", [
        toolPart("call-1", "err", LONG_INPUT, "error"),
        toolPart("call-2", "err2", LONG_INPUT, "error"),
      ]),
    ];

    const marks = runPurgeErrors(state, messages, { turnProtection: 0 });
    // call-1 already marked, only call-2 processed.
    assert.equal(marks.length, 1);
    assert.equal(marks[0].callID, "call-2");
  });

  it("skips when mark is effective (already released)", () => {
    const state = getOrCreateSessionState("sess-effective-skip");
    state.marks.set("call-1", {
      tokens: 50,
      effective: true,
      action: "tool-error-input",
    });

    const messages = [
      msg("assistant", "a1", [toolPart("call-1", "err", LONG_INPUT, "error")]),
    ];

    const marks = runPurgeErrors(state, messages, { turnProtection: 0 });
    assert.equal(marks.length, 0);
  });
});

// ===========================================================================
// Protection window skip (message-count)
// ===========================================================================

describe("runPurgeErrors — protection window (message-count)", () => {
  it("skips error parts within the last N messages", () => {
    // 3 messages, protect=2 → last 2 messages (call-B, call-C) protected,
    // only call-A is outside the window.
    const state = getOrCreateSessionState("sess-msg-prot");
    const messages = [
      msg("assistant", "a1", [toolPart("call-A", "err", LONG_INPUT, "error")]),
      msg("assistant", "a2", [toolPart("call-B", "err", LONG_INPUT, "error")]),
      msg("assistant", "a3", [toolPart("call-C", "err", LONG_INPUT, "error")]),
    ];

    const marks = runPurgeErrors(state, messages, { turnProtection: 2 });
    assert.equal(marks.length, 1);
    assert.equal(marks[0].callID, "call-A");
  });

  it("protects all messages when N exceeds message count", () => {
    const state = getOrCreateSessionState("sess-msg-few");
    const messages = [
      msg("assistant", "a1", [toolPart("call-A", "err", LONG_INPUT, "error")]),
    ];

    const marks = runPurgeErrors(state, messages, { turnProtection: 5 });
    assert.equal(marks.length, 0);
  });

  it("turnProtection=0 disables protection", () => {
    const state = getOrCreateSessionState("sess-msg-no-prot");
    const messages = [
      msg("assistant", "a1", [toolPart("call-A", "err", LONG_INPUT, "error")]),
    ];

    const marks = runPurgeErrors(state, messages, { turnProtection: 0 });
    assert.equal(marks.length, 1);
    assert.equal(marks[0].callID, "call-A");
  });
});

// ===========================================================================
// Protected tool skip
// ===========================================================================

describe("runPurgeErrors — protected tool skip", () => {
  it("skips tools in the protectedTools list", () => {
    const state = getOrCreateSessionState("sess-prot-tool");
    const messages = [
      msg("assistant", "a1", [
        {
          type: "tool",
          callID: "call-Q",
          state: { input: LONG_INPUT, output: "err", status: "error" },
          tool: "question",
        } as SweepToolPart,
      ]),
    ];

    // No default — must explicitly pass protectedTools to protect "question".
    const marks = runPurgeErrors(state, messages, {
      turnProtection: 0,
      protectedTools: ["question"],
    });
    assert.equal(marks.length, 0);
  });

  it("respects custom protectedTools list", () => {
    const state = getOrCreateSessionState("sess-custom-prot");
    const messages = [
      msg("assistant", "a1", [
        {
          type: "tool",
          callID: "call-R",
          state: { input: LONG_INPUT, output: "err", status: "error" },
          tool: "read",
        } as SweepToolPart,
      ]),
    ];

    const marks = runPurgeErrors(state, messages, {
      turnProtection: 0,
      protectedTools: ["read"],
    });
    assert.equal(marks.length, 0);
  });

  it("marks tool not in protectedTools list", () => {
    const state = getOrCreateSessionState("sess-unprotected");
    const messages = [
      msg("assistant", "a1", [toolPart("call-1", "err", LONG_INPUT, "error")]),
    ];

    const marks = runPurgeErrors(state, messages, {
      turnProtection: 0,
      protectedTools: ["read"],
    });
    assert.equal(marks.length, 1);
    assert.equal(marks[0].callID, "call-1");
  });
});

// ===========================================================================
// Zero-benefit skip
// ===========================================================================

describe("runPurgeErrors — zero-benefit skip", () => {
  it("skips when input string values are shorter than the placeholder", () => {
    const state = getOrCreateSessionState("sess-zero-benefit");
    const messages = [
      msg("assistant", "a1", [toolPart("call-1", "err", SHORT_INPUT, "error")]),
    ];

    const marks = runPurgeErrors(state, messages, { turnProtection: 0 });
    assert.equal(marks.length, 0);
    assert.equal(state.marks.size, 0);
  });

  it("marks when input string values exceed the placeholder", () => {
    const state = getOrCreateSessionState("sess-positive");
    const messages = [
      msg("assistant", "a1", [toolPart("call-1", "err", LONG_INPUT, "error")]),
    ];

    const marks = runPurgeErrors(state, messages, { turnProtection: 0 });
    assert.equal(marks.length, 1);
    assert.equal(marks[0].callID, "call-1");
  });

  it("skips when input is null or undefined", () => {
    const state = getOrCreateSessionState("sess-null-input");
    const messages = [
      msg("assistant", "a1", [
        {
          type: "tool",
          callID: "call-1",
          state: { input: null, output: "err", status: "error" },
          tool: "bash",
        } as SweepToolPart,
      ]),
    ];

    const marks = runPurgeErrors(state, messages, { turnProtection: 0 });
    assert.equal(marks.length, 0);
  });

  it("skips when input is an empty object", () => {
    const state = getOrCreateSessionState("sess-empty-input");
    const messages = [
      msg("assistant", "a1", [toolPart("call-1", "err", {}, "error")]),
    ];

    const marks = runPurgeErrors(state, messages, { turnProtection: 0 });
    assert.equal(marks.length, 0);
  });

  it("skips when only nested strings exist (top-level no strings — zero reclaim)", () => {
    // collectTopLevelStringFields only counts top-level string fields,
    // aligning with pruneToolErrors replacement semantics.
    // Nested strings are never replaced, so they must not inflate
    // estimatedTokens.
    const state = getOrCreateSessionState("sess-nested-only");
    const messages = [
      msg("assistant", "a1", [
        {
          type: "tool",
          callID: "call-1",
          state: {
            input: {
              opts: { recursive: true, verbose: true },
              nested: { cmd: "very long command ".repeat(50) },
              arr: ["long string item ".repeat(20)],
            },
            output: "err",
            status: "error",
          },
          tool: "bash",
        } as SweepToolPart,
      ]),
    ];

    // Top-level has only booleans and nested objects/arrays,
    // no string values → collectTopLevelStringFields returns empty → skip.
    const marks = runPurgeErrors(state, messages, { turnProtection: 0 });
    assert.equal(marks.length, 0);
  });

  it("two-field input yields per-field estimatedTokens (N×placeholder)", () => {
    // Two top-level string fields → each contributes its own
    // placeholder cost, matching pruneToolErrors replacement.
    const state = getOrCreateSessionState("sess-two-field");
    const field1 = "x".repeat(200);
    const field2 = "y".repeat(200);
    const messages = [
      msg("assistant", "a1", [
        toolPart("call-1", "err", { cmd: field1, path: field2 }, "error"),
      ]),
    ];

    const marks = runPurgeErrors(state, messages, { turnProtection: 0 });
    assert.equal(marks.length, 1);

    const placeholderTokens = estimateTokenCount(
      PRUNED_TOOL_ERROR_INPUT_REPLACEMENT,
    );
    const expected =
      estimateTokenCount(field1) +
      estimateTokenCount(field2) -
      2 * placeholderTokens;
    assert.equal(marks[0].estimatedTokens, expected);
  });

  it("two short fields where old formula (1×placeholder) overestimated", () => {
    // Sum of two short fields > 1×placeholder but ≤ 2×placeholder.
    // Old formula: content - 1×placeholder > 0 → would mark.
    // Correct formula: content - 2×placeholder ≤ 0 → zero benefit → skip.
    const state = getOrCreateSessionState("sess-two-short");
    const field1 = "x".repeat(40); // ceil(40/4) = 10 tokens
    const field2 = "y".repeat(40); // ceil(40/4) = 10 tokens
    const messages = [
      msg("assistant", "a1", [
        toolPart("call-1", "err", { cmd: field1, path: field2 }, "error"),
      ]),
    ];

    const marks = runPurgeErrors(state, messages, { turnProtection: 0 });
    // Per-field: 20 - 2*18 = -16 → zero → no mark.
    assert.equal(marks.length, 0);
    assert.equal(state.marks.size, 0);
  });
});

// ===========================================================================
// Non-error status ignored
// ===========================================================================

describe("runPurgeErrors — non-error status ignored", () => {
  it("ignores completed-status parts", () => {
    const state = getOrCreateSessionState("sess-completed");
    const messages = [
      msg("assistant", "a1", [
        toolPart("call-1", "ok", LONG_INPUT, "completed"),
      ]),
    ];

    const marks = runPurgeErrors(state, messages, { turnProtection: 0 });
    assert.equal(marks.length, 0);
    assert.equal(state.marks.size, 0);
  });

  it("ignores running-status parts", () => {
    const state = getOrCreateSessionState("sess-running");
    const messages = [
      msg("assistant", "a1", [
        toolPart("call-1", "in-progress", LONG_INPUT, "running"),
      ]),
    ];

    const marks = runPurgeErrors(state, messages, { turnProtection: 0 });
    assert.equal(marks.length, 0);
  });

  it("ignores pending-status parts", () => {
    const state = getOrCreateSessionState("sess-pending-status");
    const messages = [
      msg("assistant", "a1", [
        toolPart("call-1", "in-flight", LONG_INPUT, "pending"),
      ]),
    ];

    const marks = runPurgeErrors(state, messages, { turnProtection: 0 });
    assert.equal(marks.length, 0);
  });

  it("ignores parts without a status field", () => {
    const state = getOrCreateSessionState("sess-no-status");
    const messages = [
      msg("assistant", "a1", [toolPart("call-1", "ok", LONG_INPUT)]),
    ];

    const marks = runPurgeErrors(state, messages, { turnProtection: 0 });
    assert.equal(marks.length, 0);
  });

  it("ignores text parts and non-tool parts", () => {
    const state = getOrCreateSessionState("sess-text");
    const messages = [
      msg("assistant", "a1", [
        { type: "text", text: "hello" },
        toolPart("call-1", "err", LONG_INPUT, "error"),
      ]),
    ];

    const marks = runPurgeErrors(state, messages, { turnProtection: 0 });
    assert.equal(marks.length, 1);
    assert.equal(marks[0].callID, "call-1");
  });

  it("skips parts without a callID", () => {
    const state = getOrCreateSessionState("sess-no-callid");
    const messages = [
      msg("assistant", "a1", [
        {
          type: "tool",
          state: { input: LONG_INPUT, output: "err", status: "error" },
          tool: "bash",
        } as SweepToolPart,
      ]),
    ];

    const marks = runPurgeErrors(state, messages, { turnProtection: 0 });
    assert.equal(marks.length, 0);
  });
});

// ===========================================================================
// Idempotent re-run
// ===========================================================================

describe("runPurgeErrors — idempotent re-run", () => {
  it("does not double-mark on second run", () => {
    const state = getOrCreateSessionState("sess-idem");
    const messages = [
      msg("assistant", "a1", [
        toolPart("call-1", "err1", LONG_INPUT, "error"),
        toolPart("call-2", "err2", LONG_INPUT, "error"),
      ]),
    ];

    const marks1 = runPurgeErrors(state, messages, { turnProtection: 0 });
    assert.equal(marks1.length, 2);

    const pendingCount1 = pendingCount(state);
    const pendingTokens1 = pendingTokens(state);

    // Second run: addMark idempotency prevents new marks.
    const marks2 = runPurgeErrors(state, messages, { turnProtection: 0 });
    assert.equal(marks2.length, 0);

    // Derived stats unchanged.
    assert.equal(pendingCount(state), pendingCount1);
    assert.equal(pendingTokens(state), pendingTokens1);
  });

  it("does not double-mark when previously marked callIDs reappear in new scan", () => {
    const state = getOrCreateSessionState("sess-partial-idem");
    const messages = [
      msg("assistant", "a1", [
        toolPart("call-1", "err1", LONG_INPUT, "error"),
        toolPart("call-2", "err2", LONG_INPUT, "error"),
      ]),
    ];

    const marks1 = runPurgeErrors(state, messages, { turnProtection: 0 });
    assert.equal(marks1.length, 2);
    assert.equal(pendingCount(state), 2);

    const ptsBefore = pendingTokens(state);

    const marks2 = runPurgeErrors(state, messages, { turnProtection: 0 });
    assert.equal(marks2.length, 0);
    assert.equal(pendingCount(state), 2);
    assert.equal(pendingTokens(state), ptsBefore);
  });

  it("marks.size stays unchanged across multiple runs", () => {
    const state = getOrCreateSessionState("sess-accumulate");
    const messages = [
      msg("assistant", "a1", [toolPart("call-1", "err1", LONG_INPUT, "error")]),
    ];

    runPurgeErrors(state, messages, { turnProtection: 0 });
    assert.equal(state.marks.size, 1);

    // Second run — no new marks.
    runPurgeErrors(state, messages, { turnProtection: 0 });
    assert.equal(state.marks.size, 1);
  });
});

// ===========================================================================
// Undefined turnProtection → early-return (fail to skip)
// ===========================================================================

describe("runPurgeErrors — undefined turnProtection → early-return", () => {
  it("returns empty marks and writes nothing when turnProtection is undefined", () => {
    // Input that would normally produce a purge-errors mark (error part
    // with long input content).
    const state = getOrCreateSessionState("sess-undef-tp");
    const messages = [
      msg("assistant", "a1", [toolPart("call-1", "err", LONG_INPUT, "error")]),
    ];

    const marks = runPurgeErrors(state, messages, {});

    assert.equal(marks.length, 0, "must return empty marks");
    assert.equal(state.marks.size, 0, "must not write any marks");
    assert.equal(state.dirty, false, "must not mark state as dirty");
  });

  it("returns empty marks when options omits turnProtection entirely", () => {
    const state = getOrCreateSessionState("sess-undef-tp-omit");
    const messages = [
      msg("assistant", "a1", [toolPart("call-1", "err", LONG_INPUT, "error")]),
    ];

    const marks = runPurgeErrors(state, messages, {
      turnProtection: undefined,
    });

    assert.equal(marks.length, 0, "must return empty marks");
    assert.equal(state.marks.size, 0, "must not write any marks");
  });

  it("does not affect pre-existing state when turnProtection is undefined", () => {
    const state = getOrCreateSessionState("sess-undef-tp-noside");
    // Pre-populate a mark to verify it is not mutated.
    state.marks.set("existing", {
      tokens: 50,
      effective: false,
      action: "tool-error-input",
    });

    const messages = [
      msg("assistant", "a1", [toolPart("call-1", "err", LONG_INPUT, "error")]),
    ];

    runPurgeErrors(state, messages, {});

    assert.equal(state.marks.size, 1, "pre-existing mark must survive");
    assert.equal(state.marks.get("existing")?.tokens, 50);
    assert.equal(state.dirty, false, "must not set dirty flag");
  });
});

// ===========================================================================
// PRUNED_TOOL_ERROR_INPUT_REPLACEMENT
// ===========================================================================

describe("PRUNED_TOOL_ERROR_INPUT_REPLACEMENT", () => {
  it("matches the verbatim constant exactly", () => {
    assert.equal(
      PRUNED_TOOL_ERROR_INPUT_REPLACEMENT,
      "[Input removed due to failed tool call - information no longer relevant]",
    );
  });
});
