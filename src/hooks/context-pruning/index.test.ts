/**
 * Tests for the context-pruning hook adapter.
 *
 * Covers: null/undefined/empty input, missing sessionID, empty prune map,
 * pre-populated prune map, repeat calls on the same session.
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { ContextMessageEntry } from "../../core/metrics.js";
import {
  _clearAllSessionsForTesting,
  deleteSessionState,
  getOrCreateSessionState,
  loadSessionState,
  PRUNED_TOOL_OUTPUT_REPLACEMENT,
} from "../../core/pruning/index.js";
import type { SweepToolPart } from "../../core/pruning/types.js";
import { _resetForTesting } from "../../utils/logger.js";
import { contextPruningTransformHandler } from "./index.js";

// ---------------------------------------------------------------------------
// Teardown
// ---------------------------------------------------------------------------

/** Session IDs used by tests in this file (for cleanup of persisted files). */
const TEST_SESSION_IDS = [
  "sess-no-marks",
  "sess-populated",
  "sess-repeat",
  "sess-persist",
];

afterEach(() => {
  _resetForTesting();
  _clearAllSessionsForTesting();
  for (const sid of TEST_SESSION_IDS) {
    deleteSessionState(sid);
  }
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
// contextPruningTransformHandler — integration tests
// ---------------------------------------------------------------------------

describe("contextPruningTransformHandler", () => {
  it("is a no-op for null messages", () => {
    // Should not throw.
    contextPruningTransformHandler(null);
  });

  it("is a no-op for undefined messages", () => {
    contextPruningTransformHandler(undefined);
  });

  it("is a no-op for empty array", () => {
    contextPruningTransformHandler([]);
  });

  it("is a no-op when first message has no sessionID", () => {
    const messages = [
      msg("user", "u1", [textPart("hello")]),
      msg("assistant", "a1", [toolPart("call-1", "data")]),
    ];
    // Should not throw despite no sessionID.
    contextPruningTransformHandler(messages);
    // Output unchanged.
    assert.equal(
      (messages[1].parts?.[0] as SweepToolPart).state?.output,
      "data",
    );
  });

  it("is a no-op when prune map is empty", () => {
    // Create state but don't add marks.
    getOrCreateSessionState("sess-no-marks");
    const messages = [
      msg("user", "u1", [textPart("hello")], "sess-no-marks"),
      msg("assistant", "a1", [toolPart("call-1", "data")]),
    ];

    contextPruningTransformHandler(messages);

    // Output unchanged.
    assert.equal(
      (messages[1].parts?.[0] as SweepToolPart).state?.output,
      "data",
    );
  });

  it("replaces tool outputs when prune map is pre-populated", () => {
    const sessionID = "sess-populated";
    const state = getOrCreateSessionState(sessionID);
    state.prune.tools.set("call-1", 100);
    state.prune.tools.set("call-2", 200);

    const messages = [
      msg("user", "u1", [textPart("do it")], sessionID),
      msg("assistant", "a1", [
        toolPart("call-1", "original output 1"),
        textPart("interleaved text"),
        toolPart("call-2", "original output 2"),
      ]),
    ];

    contextPruningTransformHandler(messages);

    const parts = messages[1].parts ?? [];
    assert.equal(
      (parts[0] as SweepToolPart).state?.output,
      PRUNED_TOOL_OUTPUT_REPLACEMENT,
    );
    assert.equal(
      (parts[2] as SweepToolPart).state?.output,
      PRUNED_TOOL_OUTPUT_REPLACEMENT,
    );
    // Text part unchanged.
    assert.equal((parts[1] as { text?: string }).text, "interleaved text");
    // Map NOT cleared after processing (DCP accumulate).
    assert.equal(state.prune.tools.size, 2);
    // totalPruneTokens is NOT modified by prune — token accounting
    // happens at mark time (sweep command / strategies).
    assert.equal(state.stats.totalPruneTokens, 0);
  });

  it("reuses existing state for repeat calls on same session", () => {
    const sessionID = "sess-repeat";
    const state = getOrCreateSessionState(sessionID);
    state.prune.tools.set("call-1", 50);

    const messages = [
      msg("user", "u1", [textPart("again")], sessionID),
      msg("assistant", "a1", [toolPart("call-1", "data")]),
    ];

    contextPruningTransformHandler(messages);

    // First call: output replaced.
    assert.equal(
      (messages[1].parts?.[0] as SweepToolPart).state?.output,
      PRUNED_TOOL_OUTPUT_REPLACEMENT,
    );
    // totalPruneTokens is NOT modified by prune (token accounting at mark time).
    assert.equal(state.stats.totalPruneTokens, 0);

    // Second call with same session but new marks.
    state.prune.tools.set("call-2", 30);
    const moreMessages = [
      msg("user", "u2", [textPart("more")], sessionID),
      msg("assistant", "a2", [toolPart("call-2", "new data")]),
    ];

    contextPruningTransformHandler(moreMessages);

    assert.equal(
      (moreMessages[1].parts?.[0] as SweepToolPart).state?.output,
      PRUNED_TOOL_OUTPUT_REPLACEMENT,
    );
    // totalPruneTokens still unchanged by prune.
    assert.equal(state.stats.totalPruneTokens, 0);
  });

  it("persists state to disk after transform when dirty", () => {
    const sessionID = "sess-persist";
    const state = getOrCreateSessionState(sessionID);
    state.prune.tools.set("call-1", 100);
    state.dirty = true;

    const messages = [
      msg("user", "u1", [textPart("hello")], sessionID),
      msg("assistant", "a1", [toolPart("call-1", "original output")]),
    ];

    contextPruningTransformHandler(messages);

    // Verify disk persistence.
    const persisted = loadSessionState(sessionID);
    assert.ok(persisted, "state should be persisted to disk");
    assert.ok(persisted.prune.tools.has("call-1"));
    assert.equal(persisted.prune.tools.get("call-1"), 100);
    // dirty flag should be reset after save.
    assert.equal(state.dirty, false);
  });
});
