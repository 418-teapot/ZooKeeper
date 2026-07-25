/**
 * Tests for the context-pruning barrel — pruneToolOutputs.
 *
 * Covers: empty state → noop, pre-populated effective marks → output
 * replaced, non-effective (pending) marks NOT replaced, placeholder
 * verbatim match, accumulation (no clear).
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { _resetForTesting } from "../../utils/logger.js";
import type { ContextMessageEntry } from "../metrics.js";
import { estimateTokenCount } from "../metrics.js";
import {
  _clearAllSessionsForTesting,
  addMark,
  getOrCreateSessionState,
  PRUNED_TOOL_OUTPUT_REPLACEMENT,
  pruneToolOutputs,
} from "./index.js";
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
  it("is a no-op when marks is empty", () => {
    const state = getOrCreateSessionState("sess-empty");
    const messages: ContextMessageEntry[] = [
      msg("user", "u1", [textPart("hello")]),
      msg("assistant", "a1", [toolPart("call-1", "some output")]),
    ];

    const originalOutput = (messages[1].parts?.[0] as SweepToolPart).state
      ?.output;

    pruneToolOutputs(state, messages);

    // Output should be unchanged.
    assert.equal(
      (messages[1].parts?.[0] as SweepToolPart).state?.output,
      originalOutput,
    );
  });

  it("is a no-op when no effective marks match", () => {
    const state = getOrCreateSessionState("sess-nomatch");
    // Add a mark for a callID not in messages.
    addMark(state, "call-other", 50, true);

    const messages: ContextMessageEntry[] = [
      msg("assistant", "a1", [toolPart("call-1", "data")]),
    ];

    pruneToolOutputs(state, messages);

    // Output unchanged.
    assert.equal(
      (messages[0].parts?.[0] as SweepToolPart).state?.output,
      "data",
    );
    // Map is NOT cleared.
    assert.equal(state.marks.size, 1);
  });

  it("does NOT replace non-effective (pending) marks", () => {
    const state = getOrCreateSessionState("sess-pending-only");
    addMark(state, "call-1", 100, false); // Effective = false.

    const messages: ContextMessageEntry[] = [
      msg("assistant", "a1", [toolPart("call-1", "data")]),
    ];

    pruneToolOutputs(state, messages);

    // Output unchanged — pending marks not applied.
    assert.equal(
      (messages[0].parts?.[0] as SweepToolPart).state?.output,
      "data",
    );
  });
});

// ---------------------------------------------------------------------------
// pruneToolOutputs — pre-populated state
// ---------------------------------------------------------------------------

describe("pruneToolOutputs with pre-populated state", () => {
  it("replaces effective-marked tool outputs with placeholder", () => {
    const state = getOrCreateSessionState("sess-marked");
    addMark(state, "call-1", 100, true);
    addMark(state, "call-2", 200, true);

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
  });

  it("handles tool parts without pre-existing state object", () => {
    const state = getOrCreateSessionState("sess-nostate");
    addMark(state, "call-1", 50, true);

    const messages: ContextMessageEntry[] = [
      msg("assistant", "a1", [
        {
          type: "tool",
          callID: "call-1",
          tool: "bash",
        } as SweepToolPart,
      ]),
    ];

    pruneToolOutputs(state, messages);

    const part = messages[0].parts?.[0] as SweepToolPart;
    assert.ok(part.state);
    assert.equal(part.state?.output, PRUNED_TOOL_OUTPUT_REPLACEMENT);
  });

  it("only replaces tools with matching callID, skips others", () => {
    const state = getOrCreateSessionState("sess-skip");
    addMark(state, "call-1", 100, true);

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
  });

  it("does NOT clear marks after processing (accumulate)", () => {
    const state = getOrCreateSessionState("sess-accumulate");
    addMark(state, "call-1", 100, true);
    addMark(state, "call-2", 200, true);

    const messages: ContextMessageEntry[] = [
      msg("assistant", "a1", [
        toolPart("call-1", "data A"),
        toolPart("call-2", "data B"),
      ]),
    ];

    pruneToolOutputs(state, messages);
    assert.equal(state.marks.size, 2);

    // Second call — already placeholders.
    pruneToolOutputs(state, messages);
    assert.equal(
      (messages[0].parts?.[0] as SweepToolPart).state?.output,
      PRUNED_TOOL_OUTPUT_REPLACEMENT,
    );
  });
});

// ---------------------------------------------------------------------------
// Duplicate mark
// ---------------------------------------------------------------------------

describe("duplicate mark prevention", () => {
  it("pruneToolOutputs replaces both occurrences of same callID", () => {
    const state = getOrCreateSessionState("sess-dup-callid");
    addMark(state, "call-1", 100, true);

    const messages: ContextMessageEntry[] = [
      msg("assistant", "a1", [toolPart("call-1", "output A")]),
      msg("assistant", "a2", [toolPart("call-1", "output B")]),
    ];

    pruneToolOutputs(state, messages);

    assert.equal(
      (messages[0].parts?.[0] as SweepToolPart).state?.output,
      PRUNED_TOOL_OUTPUT_REPLACEMENT,
    );
    assert.equal(
      (messages[1].parts?.[0] as SweepToolPart).state?.output,
      PRUNED_TOOL_OUTPUT_REPLACEMENT,
    );
  });
});

// ---------------------------------------------------------------------------
// Accumulation (no clear)
// ---------------------------------------------------------------------------

describe("pruneToolOutputs accumulation (no clear)", () => {
  it("marks.size stays unchanged after prune", () => {
    const state = getOrCreateSessionState("sess-no-clear");
    addMark(state, "call-1", 100, true);
    addMark(state, "call-2", 200, true);

    const messages: ContextMessageEntry[] = [
      msg("assistant", "a1", [
        toolPart("call-1", "data A"),
        toolPart("call-2", "data B"),
      ]),
    ];

    assert.equal(state.marks.size, 2);
    pruneToolOutputs(state, messages);
    assert.equal(state.marks.size, 2);
  });

  it("accumulates marks across multiple sweep+prune turns", () => {
    const state = getOrCreateSessionState("sess-multi-turn");

    // Turn 1.
    addMark(state, "call-1", 100, true);
    pruneToolOutputs(state, [
      msg("assistant", "a1", [toolPart("call-1", "out1")]),
    ]);
    assert.equal(state.marks.size, 1);

    // Turn 2.
    addMark(state, "call-2", 200, true);
    assert.equal(state.marks.size, 2);
    pruneToolOutputs(state, [
      msg("assistant", "a2", [toolPart("call-2", "out2")]),
    ]);
    assert.equal(state.marks.size, 2);
  });
});

// ---------------------------------------------------------------------------
// Re-prune already-placeholder output
// ---------------------------------------------------------------------------

describe("re-prune already-placeholder output", () => {
  it("is stable (no double-count issues)", () => {
    const state = getOrCreateSessionState("sess-reprune");
    addMark(state, "call-1", 100, true);

    const messages: ContextMessageEntry[] = [
      msg("assistant", "a1", [toolPart("call-1", "real output")]),
    ];

    pruneToolOutputs(state, messages);
    pruneToolOutputs(state, messages);

    assert.equal(
      (messages[0].parts?.[0] as SweepToolPart).state?.output,
      PRUNED_TOOL_OUTPUT_REPLACEMENT,
    );
  });
});
