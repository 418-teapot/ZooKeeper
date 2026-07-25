/**
 * Tests for the sweep producer.
 *
 * Covers: last-user-index semantics (no-arg), numeric last-N semantics,
 * ignored user messages, duplicate skip via addMark idempotency,
 * empty/no-user/no-tool edge cases, effective=true assurance.
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { ContextMessageEntry } from "../../metrics.js";
import {
  _clearAllSessionsForTesting,
  addMark,
  getOrCreateSessionState,
  reclaimedTokens,
} from "../marks.js";
import type { SweepToolPart } from "../types.js";
import { runSweep } from "./sweep.js";

// ---------------------------------------------------------------------------
// Teardown
// ---------------------------------------------------------------------------

afterEach(() => {
  _clearAllSessionsForTesting();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function textPart(
  text: string,
  ignored = false,
): { type: string; text: string; ignored?: boolean } {
  return { type: "text", text, ...(ignored ? { ignored: true } : {}) };
}

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
// No-arg mode (last-user-index)
// ---------------------------------------------------------------------------

describe("runSweep (no-arg / default)", () => {
  it("marks all tool callIDs after last user message", () => {
    const state = getOrCreateSessionState("sess-noarg");
    const messages = [
      msg("user", "u1", [textPart("first command")]),
      msg("assistant", "a1", [toolPart("call-1", "result 1")]),
      msg("user", "u2", [textPart("second command")]),
      msg("assistant", "a2", [toolPart("call-2", "result 2")]),
      msg("assistant", "a3", [toolPart("call-3", "result 3")]),
    ];

    const marks = runSweep(state, messages);
    assert.equal(marks.length, 2);
    assert.equal(marks[0].callID, "call-2");
    assert.equal(marks[1].callID, "call-3");

    // Marks are effective=true.
    for (const m of marks) {
      assert.ok(state.marks.get(m.callID)?.effective);
    }
  });

  it("skips ignored user messages when finding last user", () => {
    const state = getOrCreateSessionState("sess-skip-ignored");
    const messages = [
      msg("user", "u1", [textPart("real message")]),
      msg("assistant", "a1", [toolPart("call-1", "output 1")]),
      msg("user", "u-ignored", [textPart("injected context", true)]),
      msg("assistant", "a2", [toolPart("call-2", "output 2")]),
    ];

    const marks = runSweep(state, messages);
    assert.equal(marks.length, 2);
    assert.equal(marks[0].callID, "call-1");
    assert.equal(marks[1].callID, "call-2");
  });

  it("returns empty array when no user message found", () => {
    const state = getOrCreateSessionState("sess-no-user");
    const messages = [msg("assistant", "a1", [toolPart("call-1", "data")])];

    const marks = runSweep(state, messages);
    assert.equal(marks.length, 0);
  });

  it("returns empty when no tool parts after last user", () => {
    const state = getOrCreateSessionState("sess-no-tool");
    const messages = [msg("user", "u1", [textPart("hello")])];

    const marks = runSweep(state, messages);
    assert.equal(marks.length, 0);
  });

  it("skips parts without callID", () => {
    const state = getOrCreateSessionState("sess-no-callid");
    const messages = [
      msg("user", "u1", [textPart("do it")]),
      msg("assistant", "a1", [
        { type: "tool", tool: "bash", state: { output: "no callID" } },
        toolPart("call-1", "has callID"),
      ]),
    ];

    const marks = runSweep(state, messages);
    assert.equal(marks.length, 1);
    assert.equal(marks[0].callID, "call-1");
  });

  it("skips already-marked callIDs (addMark idempotency)", () => {
    const state = getOrCreateSessionState("sess-already-marked");
    // Pre-mark call-2 (simulates previous sweep).
    addMark(state, "call-2", 99, true, "tool-output");

    const messages = [
      msg("user", "u1", [textPart("do it")]),
      msg("assistant", "a1", [
        toolPart("call-1", "output A"),
        toolPart("call-2", "output B"),
      ]),
    ];

    const marks = runSweep(state, messages);
    // call-2 already marked → only call-1 is new.
    assert.equal(marks.length, 1);
    assert.equal(marks[0].callID, "call-1");
  });
});

// ---------------------------------------------------------------------------
// Numeric count mode
// ---------------------------------------------------------------------------

describe("runSweep (numeric arg)", () => {
  it("collects last N tool callIDs from messages (walk backward)", () => {
    const state = getOrCreateSessionState("sess-numeric");
    const messages = [
      msg("assistant", "a1", [toolPart("call-1", "result 1")]),
      msg("assistant", "a2", [toolPart("call-2", "result 2")]),
      msg("assistant", "a3", [toolPart("call-3", "result 3")]),
    ];

    const marks = runSweep(state, messages, 2);
    assert.equal(marks.length, 2);
    assert.equal(marks[0].callID, "call-3");
    assert.equal(marks[1].callID, "call-2");
  });

  it("stops at N even when more tool parts exist", () => {
    const state = getOrCreateSessionState("sess-stop-n");
    const messages = [
      msg("assistant", "a1", [toolPart("call-1", "r1")]),
      msg("assistant", "a2", [toolPart("call-2", "r2")]),
      msg("assistant", "a3", [toolPart("call-3", "r3")]),
    ];

    const marks = runSweep(state, messages, 1);
    assert.equal(marks.length, 1);
    assert.equal(marks[0].callID, "call-3");
  });

  it("collects multiple tool parts from the same message (reverse parts)", () => {
    const state = getOrCreateSessionState("sess-multi-parts");
    const messages = [
      msg("assistant", "a1", [
        toolPart("call-1", "r1"),
        toolPart("call-2", "r2"),
        toolPart("call-3", "r3"),
      ]),
    ];

    const marks = runSweep(state, messages, 2);
    assert.equal(marks.length, 2);
    assert.equal(marks[0].callID, "call-3");
    assert.equal(marks[1].callID, "call-2");
  });

  it("returns fewer than N when not enough tool parts exist", () => {
    const state = getOrCreateSessionState("sess-fewer");
    const messages = [msg("assistant", "a1", [toolPart("call-1", "r1")])];

    const marks = runSweep(state, messages, 5);
    assert.equal(marks.length, 1);
    assert.equal(marks[0].callID, "call-1");
  });

  it("returns empty array for N=0", () => {
    const state = getOrCreateSessionState("sess-zero");
    const messages = [msg("assistant", "a1", [toolPart("call-1", "r1")])];

    const marks = runSweep(state, messages, 0);
    assert.equal(marks.length, 0);
  });

  it("skips already-marked callIDs with numeric count", () => {
    const state = getOrCreateSessionState("sess-already-num");
    addMark(state, "call-3", 99, true, "tool-output");

    const messages = [
      msg("assistant", "a1", [toolPart("call-1", "r1")]),
      msg("assistant", "a2", [toolPart("call-2", "r2")]),
      msg("assistant", "a3", [toolPart("call-3", "r3")]),
    ];

    const marks = runSweep(state, messages, 1);
    // Walk backward: call-3 (skip), call-2 (collect).
    assert.equal(marks.length, 1);
    assert.equal(marks[0].callID, "call-2");
  });

  it("writes effective=true marks", () => {
    const state = getOrCreateSessionState("sess-effective");
    const messages = [msg("assistant", "a1", [toolPart("call-1", "output")])];

    runSweep(state, messages, 1);
    assert.ok(state.marks.get("call-1")?.effective);
    assert.equal(reclaimedTokens(state), state.marks.get("call-1")?.tokens);
  });
});
