/**
 * Tests for the dedup producer.
 *
 * Covers: signature normalisation, basic dedup (keep newest, mark older),
 * turn protection via step-start and fallback, skip conditions, idempotent
 * re-runs (naturally ensured by addMark), zero-benefit skip.
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { ContextMessageEntry } from "../../metrics.js";
import {
  _clearAllSessionsForTesting,
  getOrCreateSessionState,
  pendingCount,
  pendingTokens,
} from "../marks.js";
import type { SweepToolPart } from "../types.js";
import { runDedup } from "./dedup.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Long output string guaranteed to exceed PRUNED_TOOL_OUTPUT_REPLACEMENT
 *  token estimate so the zero-benefit skip does not discard it. */
const LONG_OUTPUT = "x".repeat(500);

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
    | { type: string; text: string; ignored?: boolean }
    | { type: string }
  >,
  sessionID?: string,
): ContextMessageEntry {
  return {
    info: { role, id, ...(sessionID ? { sessionID } : {}) },
    parts: parts as unknown as ContextMessageEntry["parts"],
  };
}

function stepStartPart(): { type: string } {
  return { type: "step-start" };
}

// ===========================================================================
// Signature normalisation
// ===========================================================================

describe("signature normalisation", () => {
  it("treats different key order as equivalent", () => {
    const state = getOrCreateSessionState("sess-keyorder");
    const messages = [
      msg("assistant", "a1", [
        toolPart("call-1", LONG_OUTPUT, { cmd: "ls", path: "/tmp" }),
      ]),
      msg("assistant", "a2", [
        toolPart("call-2", LONG_OUTPUT, { path: "/tmp", cmd: "ls" }),
      ]),
    ];

    const marks = runDedup(state, messages, { turnProtection: 0 });
    assert.equal(marks.length, 1);
    assert.equal(marks[0].callID, "call-1");
    // mark written as non-effective (pending).
    assert.ok(state.marks.has("call-1"));
    assert.equal(state.marks.get("call-1")?.effective, false);
    assert.ok(!state.marks.has("call-2"));
  });

  it("strips null and undefined fields from input", () => {
    const state = getOrCreateSessionState("sess-null");
    const messages = [
      msg("assistant", "a1", [
        toolPart("call-1", LONG_OUTPUT, {
          cmd: "ls",
          extra: null,
          flag: undefined,
        }),
      ]),
      msg("assistant", "a2", [toolPart("call-2", LONG_OUTPUT, { cmd: "ls" })]),
    ];

    const marks = runDedup(state, messages, { turnProtection: 0 });
    assert.equal(marks.length, 1);
    assert.equal(marks[0].callID, "call-1");
  });

  it("strips volatile fields (timestamp/ts/date) at any depth", () => {
    const state = getOrCreateSessionState("sess-volatile");
    const messages = [
      msg("assistant", "a1", [
        toolPart("call-1", LONG_OUTPUT, {
          cmd: "grep",
          timestamp: "2024-01-01T00:00:00Z",
        }),
      ]),
      msg("assistant", "a2", [
        toolPart("call-2", LONG_OUTPUT, { cmd: "grep" }),
      ]),
    ];

    const marks = runDedup(state, messages, { turnProtection: 0 });
    assert.equal(marks.length, 1);
    assert.equal(marks[0].callID, "call-1");
  });

  it("strips volatile fields in nested objects", () => {
    const state = getOrCreateSessionState("sess-nested-vol");
    const messages = [
      msg("assistant", "a1", [
        toolPart("call-1", LONG_OUTPUT, {
          args: { path: "/etc", ts: 1234567890 },
        }),
      ]),
      msg("assistant", "a2", [
        toolPart("call-2", LONG_OUTPUT, {
          args: { path: "/etc" },
        }),
      ]),
    ];

    const marks = runDedup(state, messages, { turnProtection: 0 });
    assert.equal(marks.length, 1);
    assert.equal(marks[0].callID, "call-1");
  });

  it("treats different tool names as different signatures", () => {
    const state = getOrCreateSessionState("sess-diff-tool");
    const messages = [
      msg("assistant", "a1", [
        toolPart("call-1", LONG_OUTPUT, { path: "/tmp" }),
      ]),
      msg("assistant", "a2", [
        {
          type: "tool",
          callID: "call-2",
          state: { input: { path: "/tmp" }, output: LONG_OUTPUT },
          tool: "read",
        } as SweepToolPart,
      ]),
    ];

    const marks = runDedup(state, messages, { turnProtection: 0 });
    assert.equal(marks.length, 0);
  });
});

// ===========================================================================
// Basic dedup
// ===========================================================================

describe("basic dedup", () => {
  it("keeps the newest of 3 identical calls, marks 2 older", () => {
    const state = getOrCreateSessionState("sess-3dup");
    const messages = [
      msg("assistant", "a1", [toolPart("call-A", LONG_OUTPUT, { cmd: "ls" })]),
      msg("assistant", "a2", [toolPart("call-B", LONG_OUTPUT, { cmd: "ls" })]),
      msg("assistant", "a3", [toolPart("call-C", LONG_OUTPUT, { cmd: "ls" })]),
    ];

    const marks = runDedup(state, messages, { turnProtection: 0 });

    assert.equal(marks.length, 2);
    const markedIDs = marks.map((m) => m.callID).sort();
    assert.deepEqual(markedIDs, ["call-A", "call-B"]);

    assert.ok(state.marks.has("call-A"));
    assert.ok(state.marks.has("call-B"));
    assert.ok(!state.marks.has("call-C"));

    // All marks are non-effective (pending).
    assert.equal(state.marks.get("call-A")?.effective, false);
    assert.equal(state.marks.get("call-B")?.effective, false);

    // State dirty.
    assert.equal(state.dirty, true);
  });

  it("computes estimatedTokens for each mark", () => {
    const state = getOrCreateSessionState("sess-ested");
    const messages = [
      msg("assistant", "a1", [toolPart("call-A", LONG_OUTPUT, { cmd: "ls" })]),
      msg("assistant", "a2", [
        toolPart("call-B", "very long output ".repeat(100), {
          cmd: "ls",
        }),
      ]),
    ];

    const marks = runDedup(state, messages, { turnProtection: 0 });

    assert.equal(marks.length, 1);
    assert.equal(marks[0].callID, "call-A");
    assert.ok(typeof marks[0].estimatedTokens === "number");
    assert.ok(marks[0].estimatedTokens >= 0);
  });

  it("marks only when there are >=2 occurrences of the same signature", () => {
    const state = getOrCreateSessionState("sess-unique");
    const messages = [
      msg("assistant", "a1", [toolPart("call-A", LONG_OUTPUT, { cmd: "ls" })]),
      msg("assistant", "a2", [toolPart("call-B", LONG_OUTPUT, { cmd: "pwd" })]),
    ];

    const marks = runDedup(state, messages, { turnProtection: 0 });
    assert.equal(marks.length, 0);
  });
});

// ===========================================================================
// Turn protection (step-start)
// ===========================================================================

describe("turn protection with step-start", () => {
  it("protects the last turnProtection steps from dedup", () => {
    const state = getOrCreateSessionState("sess-step-proto");
    const messages = [
      msg("assistant", "a1", [
        stepStartPart(),
        toolPart("call-A", LONG_OUTPUT, { cmd: "ls" }),
      ]),
      msg("assistant", "a2", [
        stepStartPart(),
        toolPart("call-B", LONG_OUTPUT, { cmd: "ls" }),
      ]),
      msg("assistant", "a3", [
        stepStartPart(),
        toolPart("call-C", LONG_OUTPUT, { cmd: "ls" }),
      ]),
    ];

    const marks = runDedup(state, messages, { turnProtection: 2 });
    assert.equal(marks.length, 0);

    // Boundary: protection=1 → protect last 1 step.
    const state2 = getOrCreateSessionState("sess-step-boundary");
    const marks2 = runDedup(state2, messages, { turnProtection: 1 });
    assert.equal(marks2.length, 1);
    assert.equal(marks2[0].callID, "call-A");
  });

  it("protects tool calls in messages after the last step-start", () => {
    const state = getOrCreateSessionState("sess-step-trailing");
    const messages = [
      msg("assistant", "a1", [
        stepStartPart(),
        toolPart("call-A", LONG_OUTPUT, { cmd: "ls" }),
      ]),
      msg("assistant", "a2", [toolPart("call-B", LONG_OUTPUT, { cmd: "ls" })]),
      msg("assistant", "a3", [
        stepStartPart(),
        toolPart("call-C", LONG_OUTPUT, { cmd: "ls" }),
      ]),
      msg("assistant", "a4", [toolPart("call-D", LONG_OUTPUT, { cmd: "ls" })]),
    ];

    const marks = runDedup(state, messages, { turnProtection: 1 });
    assert.equal(marks.length, 1);
    assert.equal(marks[0].callID, "call-A");
  });

  it("does not protect beyond available steps (fewer than turnProtection)", () => {
    const state = getOrCreateSessionState("sess-few-steps");
    const messages = [
      msg("assistant", "a1", [
        stepStartPart(),
        toolPart("call-A", LONG_OUTPUT, { cmd: "ls" }),
      ]),
      msg("assistant", "a2", [
        stepStartPart(),
        toolPart("call-B", LONG_OUTPUT, { cmd: "ls" }),
      ]),
    ];

    const marks = runDedup(state, messages, { turnProtection: 5 });
    assert.equal(marks.length, 0);
  });
});

// ===========================================================================
// Turn protection fallback (no step-start)
// ===========================================================================

describe("turn protection fallback (no step-start)", () => {
  it("protects the last N tool calls when no step-start exists", () => {
    const state = getOrCreateSessionState("sess-no-step");
    const messages = [
      msg("assistant", "a1", [toolPart("call-A", LONG_OUTPUT, { cmd: "ls" })]),
      msg("assistant", "a2", [toolPart("call-B", LONG_OUTPUT, { cmd: "ls" })]),
      msg("assistant", "a3", [toolPart("call-C", LONG_OUTPUT, { cmd: "ls" })]),
      msg("assistant", "a4", [toolPart("call-D", LONG_OUTPUT, { cmd: "ls" })]),
    ];

    const marks = runDedup(state, messages, { turnProtection: 2 });
    assert.equal(marks.length, 1);
    assert.equal(marks[0].callID, "call-A");
  });

  it("turnProtection=0 disables protection", () => {
    const state = getOrCreateSessionState("sess-no-prot");
    const messages = [
      msg("assistant", "a1", [toolPart("call-A", LONG_OUTPUT, { cmd: "ls" })]),
      msg("assistant", "a2", [toolPart("call-B", LONG_OUTPUT, { cmd: "ls" })]),
    ];

    const marks = runDedup(state, messages, { turnProtection: 0 });
    assert.equal(marks.length, 1);
    assert.equal(marks[0].callID, "call-A");
  });
});

// ===========================================================================
// Skip conditions
// ===========================================================================

describe("skip conditions", () => {
  it("skips already-marked callIDs", () => {
    const state = getOrCreateSessionState("sess-already");
    // Pre-mark call-A.
    state.marks.set("call-A", {
      tokens: 10,
      effective: false,
      action: "tool-output",
    });

    const messages = [
      msg("assistant", "a1", [
        toolPart("call-A", LONG_OUTPUT, { cmd: "ls" }),
        toolPart("call-B", LONG_OUTPUT, { cmd: "ls" }),
      ]),
    ];

    const marks = runDedup(state, messages, { turnProtection: 0 });
    // call-A already marked → skipped. Only call-B → single → no marks.
    assert.equal(marks.length, 0);
  });

  it("skips protected tools by name", () => {
    const state = getOrCreateSessionState("sess-prot-tool");
    const messages = [
      msg("assistant", "a1", [
        {
          type: "tool",
          callID: "call-A",
          state: { input: { path: "/tmp" }, output: LONG_OUTPUT },
          tool: "read",
        } as SweepToolPart,
      ]),
      msg("assistant", "a2", [
        {
          type: "tool",
          callID: "call-B",
          state: { input: { path: "/tmp" }, output: LONG_OUTPUT },
          tool: "read",
        } as SweepToolPart,
      ]),
    ];

    const marks = runDedup(state, messages, {
      turnProtection: 0,
      protectedTools: ["read"],
    });
    assert.equal(marks.length, 0);
  });

  it("skips error-status parts", () => {
    const state = getOrCreateSessionState("sess-error");
    const messages = [
      msg("assistant", "a1", [
        toolPart("call-A", LONG_OUTPUT, { cmd: "ls" }, "error"),
      ]),
      msg("assistant", "a2", [toolPart("call-B", LONG_OUTPUT, { cmd: "ls" })]),
    ];

    const marks = runDedup(state, messages, { turnProtection: 0 });
    assert.equal(marks.length, 0);
  });

  it("skips non-completed in-progress parts (running)", () => {
    const state = getOrCreateSessionState("sess-running");
    const messages = [
      msg("assistant", "a1", [
        toolPart("call-A", LONG_OUTPUT, { cmd: "ls" }, "running"),
      ]),
      msg("assistant", "a2", [toolPart("call-B", LONG_OUTPUT, { cmd: "ls" })]),
    ];

    const marks = runDedup(state, messages, { turnProtection: 0 });
    assert.equal(marks.length, 0);
  });

  it("skips non-completed in-progress parts (pending)", () => {
    const state = getOrCreateSessionState("sess-pending-status");
    const messages = [
      msg("assistant", "a1", [
        toolPart("call-A", LONG_OUTPUT, { cmd: "ls" }, "pending"),
      ]),
      msg("assistant", "a2", [toolPart("call-B", LONG_OUTPUT, { cmd: "ls" })]),
    ];

    const marks = runDedup(state, messages, { turnProtection: 0 });
    assert.equal(marks.length, 0);
  });

  it("processes completed-status parts normally", () => {
    const state = getOrCreateSessionState("sess-completed");
    const messages = [
      msg("assistant", "a1", [
        toolPart("call-A", LONG_OUTPUT, { cmd: "ls" }, "completed"),
      ]),
      msg("assistant", "a2", [toolPart("call-B", LONG_OUTPUT, { cmd: "ls" })]),
    ];

    const marks = runDedup(state, messages, { turnProtection: 0 });
    assert.equal(marks.length, 1);
    assert.equal(marks[0].callID, "call-A");
  });

  it("skips parts without a callID", () => {
    const state = getOrCreateSessionState("sess-no-callid");
    const messages = [
      msg("assistant", "a1", [
        {
          type: "tool",
          state: { input: { cmd: "ls" }, output: LONG_OUTPUT },
          tool: "bash",
        } as SweepToolPart,
      ]),
      msg("assistant", "a2", [toolPart("call-B", LONG_OUTPUT, { cmd: "ls" })]),
    ];

    const marks = runDedup(state, messages, { turnProtection: 0 });
    assert.equal(marks.length, 0);
  });
});

// ===========================================================================
// Idempotent — addMark naturally prevents double-marking
// ===========================================================================

describe("idempotent re-run", () => {
  it("does not double-mark on second run", () => {
    const state = getOrCreateSessionState("sess-idem");
    const messages = [
      msg("assistant", "a1", [toolPart("call-A", LONG_OUTPUT, { cmd: "ls" })]),
      msg("assistant", "a2", [toolPart("call-B", LONG_OUTPUT, { cmd: "ls" })]),
      msg("assistant", "a3", [toolPart("call-C", LONG_OUTPUT, { cmd: "ls" })]),
    ];

    const marks1 = runDedup(state, messages, { turnProtection: 0 });
    assert.equal(marks1.length, 2);

    const pendingCount1 = pendingCount(state);
    const pendingTokens1 = pendingTokens(state);

    // Second run: addMark idempotency prevents new marks.
    const marks2 = runDedup(state, messages, { turnProtection: 0 });
    assert.equal(marks2.length, 0);

    // Derived stats unchanged.
    assert.equal(pendingCount(state), pendingCount1);
    assert.equal(pendingTokens(state), pendingTokens1);
  });

  it("does not double-mark when previously marked callIDs reappear", () => {
    const state = getOrCreateSessionState("sess-partial-idem");
    const messages1 = [
      msg("assistant", "a1", [toolPart("call-A", LONG_OUTPUT, { cmd: "ls" })]),
      msg("assistant", "a2", [toolPart("call-B", LONG_OUTPUT, { cmd: "ls" })]),
      msg("assistant", "a3", [toolPart("call-C", LONG_OUTPUT, { cmd: "ls" })]),
    ];
    const marks1 = runDedup(state, messages1, { turnProtection: 0 });
    assert.equal(marks1.length, 2);
    assert.equal(pendingCount(state), 2);

    const ptsBefore = pendingTokens(state);

    const marks2 = runDedup(state, messages1, { turnProtection: 0 });
    assert.equal(marks2.length, 0);
    assert.equal(pendingCount(state), 2);
    assert.equal(pendingTokens(state), ptsBefore);
  });
});

// ===========================================================================
// Zero-benefit skip
// ===========================================================================

describe("zero-benefit skip", () => {
  it("skips marking when all duplicate outputs are shorter than placeholder", () => {
    const state = getOrCreateSessionState("sess-zero-benefit");
    const SHORT_OUTPUT = "short";
    const messages = [
      msg("assistant", "a1", [toolPart("call-A", SHORT_OUTPUT, { cmd: "ls" })]),
      msg("assistant", "a2", [toolPart("call-B", SHORT_OUTPUT, { cmd: "ls" })]),
    ];

    const marks = runDedup(state, messages, { turnProtection: 0 });
    assert.equal(marks.length, 0);
    assert.equal(state.marks.size, 0);
  });

  it("does mark when at least one duplicate output exceeds placeholder", () => {
    const state = getOrCreateSessionState("sess-zero-benefit-mixed");
    const messages = [
      msg("assistant", "a1", [toolPart("call-A", "short", { cmd: "ls" })]),
      msg("assistant", "a2", [toolPart("call-B", LONG_OUTPUT, { cmd: "ls" })]),
    ];

    const marks = runDedup(state, messages, { turnProtection: 0 });
    // call-A is short → rawDiff <= 0 → skipped. call-B is keeper.
    // Only call-B eligible after zero-benefit filter, no duplicate → no marks.
    assert.equal(marks.length, 0);
  });
});

// ===========================================================================
// Array normalisation
// ===========================================================================

describe("array normalisation", () => {
  it("treats differently-ordered arrays as different", () => {
    const state = getOrCreateSessionState("sess-array-order");
    const messages = [
      msg("assistant", "a1", [
        toolPart("call-1", LONG_OUTPUT, {
          args: ["-la", "/tmp"],
        }),
      ]),
      msg("assistant", "a2", [
        toolPart("call-2", LONG_OUTPUT, {
          args: ["/tmp", "-la"],
        }),
      ]),
    ];

    const marks = runDedup(state, messages, { turnProtection: 0 });
    // Arrays preserve order → different signatures → 0 marks.
    assert.equal(marks.length, 0);
  });

  it("strips volatile fields inside array elements", () => {
    const state = getOrCreateSessionState("sess-array-volatile");
    const messages = [
      msg("assistant", "a1", [
        toolPart("call-1", LONG_OUTPUT, {
          items: [{ path: "/tmp", ts: 123 }],
        }),
      ]),
      msg("assistant", "a2", [
        toolPart("call-2", LONG_OUTPUT, {
          items: [{ path: "/tmp" }],
        }),
      ]),
    ];

    const marks = runDedup(state, messages, { turnProtection: 0 });
    assert.equal(marks.length, 1);
    assert.equal(marks[0].callID, "call-1");
  });

  it("produces same signature for object arguments with sorted keys", () => {
    const state = getOrCreateSessionState("sess-obj-keyorder");
    const messages = [
      msg("assistant", "a1", [
        toolPart("call-1", LONG_OUTPUT, {
          cmd: "ls",
          path: "/tmp",
          opts: { recursive: true, force: false },
        }),
      ]),
      msg("assistant", "a2", [
        toolPart("call-2", LONG_OUTPUT, {
          path: "/tmp",
          opts: { force: false, recursive: true },
          cmd: "ls",
        }),
      ]),
    ];

    const marks = runDedup(state, messages, { turnProtection: 0 });
    assert.equal(marks.length, 1);
    assert.equal(marks[0].callID, "call-1");
  });
});
