/**
 * Tests for the context-pruning hook adapter.
 *
 * Covers: null/undefined/empty input, missing sessionID, empty prune map,
 * pre-populated prune map, repeat calls on the same session.
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type {
  ContextMessageEntry,
  ContextTokenInfo,
} from "../../core/metrics.js";
import {
  activeBlockCount,
  createBlock,
  deleteSessionState,
  loadSessionState,
  PRUNED_TOOL_ERROR_INPUT_REPLACEMENT,
  PRUNED_TOOL_OUTPUT_REPLACEMENT,
} from "../../core/pruning/index.js";
import {
  _clearAllSessionsForTesting,
  addMark,
  getOrCreateSessionState,
  pendingCount,
  reclaimedTokens,
} from "../../core/pruning/marks.js";
import type { SweepToolPart } from "../../core/pruning/types.js";
import { parseContextConfig } from "../../opencode.js";
import { _getBufferForTesting, _resetForTesting } from "../../utils/logger.js";
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
  "sess-order",
  "sess-gate-below",
  "sess-gate-at",
  "sess-gate-missing",
  "sess-enabled-absent",
  "sess-enabled-false",
  "sess-disabled",
  "sess-gate-cache-read-at",
  "sess-gate-cache-read-below",
  "sess-gate-cache-read-write-at",
  "sess-log-mixed",
  "sess-refs-phase2",
  "sess-refs-det",
  "sess-refs-boundary",
  "sess-gate-threshold-undef",
  "sess-release-pct-undef",
  "sess-fold-integration",
  "sess-fold-refs",
  "sess-lifecycle",
  "sess-forced-compress",
  "sess-forced-batched",
  "sess-forced-deactivate",
  "sess-forced-clear",
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
  output: string,
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
  tokens?: ContextTokenInfo,
): ContextMessageEntry {
  return {
    info: {
      role,
      id,
      ...(sessionID ? { sessionID } : {}),
      ...(tokens ? { tokens } : {}),
    },
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
    addMark(state, "call-1", 100, true, "tool-output");
    addMark(state, "call-2", 200, true, "tool-output");

    const messages = [
      msg("user", "u1", [textPart("do it")], sessionID),
      msg("assistant", "a1", [
        toolPart("call-1", "original output 1"),
        textPart("interleaved text"),
        toolPart("call-2", "original output 2"),
      ]),
    ];

    contextPruningTransformHandler(messages, {
      enabled: true,
      dedup: {},
      purgeErrors: {},
    });

    const parts = messages[1].parts ?? [];
    assert.ok(
      (parts[0] as SweepToolPart).state?.output?.startsWith(
        PRUNED_TOOL_OUTPUT_REPLACEMENT,
      ),
      "call-1 output pruned",
    );
    assert.ok(
      (parts[2] as SweepToolPart).state?.output?.startsWith(
        PRUNED_TOOL_OUTPUT_REPLACEMENT,
      ),
      "call-2 output pruned",
    );
    // Text part unchanged (ref tags go into tool outputs, not text).
    assert.ok(
      (parts[1] as { text?: string }).text?.startsWith("interleaved text"),
      "text part content preserved",
    );
    // injectMessageRefs adds a ref tag to every completed tool output.
    assert.ok(
      (parts[0] as SweepToolPart).state?.output?.includes(
        "<zoo-msg-id>m0002</zoo-msg-id>",
      ),
      "call-1 tool output should carry a message ref",
    );
    assert.ok(
      (parts[2] as SweepToolPart).state?.output?.includes(
        "<zoo-msg-id>m0002</zoo-msg-id>",
      ),
      "call-2 tool output should carry a message ref",
    );
    // Map NOT cleared after processing (DCP accumulate).
    assert.equal(state.marks.size, 2);
    // reclaimedTokens reflects the effective marks (100 + 200).
    assert.equal(reclaimedTokens(state), 300);
  });

  it("reuses existing state for repeat calls on same session", () => {
    const sessionID = "sess-repeat";
    const state = getOrCreateSessionState(sessionID);
    addMark(state, "call-1", 50, true, "tool-output");

    const messages = [
      msg("user", "u1", [textPart("again")], sessionID),
      msg("assistant", "a1", [toolPart("call-1", "data")]),
    ];

    contextPruningTransformHandler(messages, {
      enabled: true,
      dedup: {},
      purgeErrors: {},
    });

    // First call: output replaced.
    assert.ok(
      (messages[1].parts?.[0] as SweepToolPart).state?.output?.startsWith(
        PRUNED_TOOL_OUTPUT_REPLACEMENT,
      ),
      "call-1 output pruned",
    );
    // reclaimedTokens reflects the effective mark.
    assert.equal(reclaimedTokens(state), 50);

    // Second call with same session but new marks.
    addMark(state, "call-2", 30, true, "tool-output");
    const moreMessages = [
      msg("user", "u2", [textPart("more")], sessionID),
      msg("assistant", "a2", [toolPart("call-2", "new data")]),
    ];

    contextPruningTransformHandler(moreMessages, {
      enabled: true,
      dedup: {},
      purgeErrors: {},
    });

    assert.ok(
      (moreMessages[1].parts?.[0] as SweepToolPart).state?.output?.startsWith(
        PRUNED_TOOL_OUTPUT_REPLACEMENT,
      ),
      "call-2 output pruned",
    );
    // reclaimedTokens accumulates across marks.
    assert.equal(reclaimedTokens(state), 80);
  });

  it("persists state to disk after transform when dirty", () => {
    const sessionID = "sess-persist";
    const state = getOrCreateSessionState(sessionID);
    addMark(state, "call-1", 100, true, "tool-output");

    const messages = [
      msg("user", "u1", [textPart("hello")], sessionID),
      msg("assistant", "a1", [toolPart("call-1", "original output")]),
    ];

    contextPruningTransformHandler(messages, {
      enabled: true,
      dedup: {},
      purgeErrors: {},
    });

    // Verify disk persistence.
    const persisted = loadSessionState(sessionID);
    assert.ok(persisted, "state should be persisted to disk");
    assert.ok(persisted.marks.has("call-1"));
    assert.equal(persisted.marks.get("call-1")?.tokens, 100);
    assert.equal(persisted.marks.get("call-1")?.effective, true);
    // dirty flag should be reset after save.
    assert.equal(state.dirty, false);
  });

  // ===========================================================================
  // Clean-then-mark ordering
  // ===========================================================================

  /** Long output string guaranteed to exceed PRUNED_TOOL_OUTPUT_REPLACEMENT
   *  token estimate so the zero-benefit skip does not discard it. */
  const LONG_OUTPUT = "x".repeat(500);

  it("clean-then-mark: turn N dedup marks do NOT apply in same turn", () => {
    const sessionID = "sess-order";
    const state = getOrCreateSessionState(sessionID);

    // Pre-populated mark from a previous `/dcp sweep` command.
    addMark(state, "call-sweep-1", 50, true, "tool-output");

    // Turn N messages: one pre-marked call + duplicate tool calls that
    // will be deduped.  The last assistant has tokens.input >= 100K to
    // pass the gate.  releasedPercent=0 ensures pending is always
    // released immediately so marks take effect next turn.
    const messages = [
      msg("user", "u1", [textPart("do it")], sessionID),
      msg(
        "assistant",
        "a1",
        [
          toolPart("call-sweep-1", "original sweep output", { cmd: "ls" }),
          textPart("interleaved"),
          toolPart("call-dedup-1", LONG_OUTPUT, { cmd: "echo hello" }),
          toolPart("call-dedup-2", LONG_OUTPUT, { cmd: "echo hello" }),
        ],
        undefined,
        { input: 100000, output: 200 },
      ),
    ];

    contextPruningTransformHandler(messages, {
      enabled: true,
      protectedMessages: 0,
      releasedPercent: 0, // Always release pending immediately for test.
      dedup: {
        enabled: true,
        thresholdContext: 100000,
      },
      purgeErrors: {},
    });

    // Phase 2 (clean) — pre-existing marks ARE replaced.
    assert.ok(
      (messages[1].parts?.[0] as SweepToolPart).state?.output?.startsWith(
        PRUNED_TOOL_OUTPUT_REPLACEMENT,
      ),
      "call-sweep-1 output pruned",
    );

    // Phase 3 (mark) — dedup ran; older duplicate is marked.
    // With releasedPercent=0, releaseBatch fires immediately, flipping
    // the dedup mark to effective=true (pendingCount becomes 0).
    assert.ok(state.marks.size > 0);

    // But the newly-marked outputs are NOT yet replaced in this turn.
    assert.ok(
      (messages[1].parts?.[2] as SweepToolPart).state?.output?.startsWith(
        LONG_OUTPUT,
      ),
      "call-dedup-1 output not pruned yet",
    );
    assert.ok(
      (messages[1].parts?.[3] as SweepToolPart).state?.output?.startsWith(
        LONG_OUTPUT,
      ),
      "call-dedup-2 output not pruned yet",
    );

    // --- Turn N+1: marks from turn N should now take effect ---
    const messages2 = [
      msg("user", "u2", [textPart("again")], sessionID),
      msg("assistant", "a2", [
        toolPart("call-dedup-1", LONG_OUTPUT, { cmd: "echo hello" }),
        toolPart("call-dedup-2", LONG_OUTPUT, { cmd: "echo hello" }),
      ]),
    ];

    contextPruningTransformHandler(messages2, {
      enabled: true,
      releasedPercent: 0,
      dedup: {
        enabled: true,
        thresholdContext: 100000,
      },
      purgeErrors: {},
    });

    // The older duplicate (call-dedup-1) is now pruned.
    const parts2 = messages2[1].parts ?? [];
    assert.ok(
      (parts2[0] as SweepToolPart).state?.output?.startsWith(
        PRUNED_TOOL_OUTPUT_REPLACEMENT,
      ),
      "call-dedup-1 pruned on turn N+1",
    );
    // The newer duplicate (call-dedup-2) is not marked — it's the keeper.
    assert.ok(
      (parts2[1] as SweepToolPart).state?.output?.startsWith(LONG_OUTPUT),
      "call-dedup-2 is the keeper",
    );
  });

  // ===========================================================================
  // Gate: threshold control
  // ===========================================================================

  it("gate: tokens.input below threshold skips dedup", () => {
    const sessionID = "sess-gate-below";
    const state = getOrCreateSessionState(sessionID);

    const messages = [
      msg("user", "u1", [textPart("hi")], sessionID),
      msg(
        "assistant",
        "a1",
        [
          toolPart("call-1", LONG_OUTPUT, { cmd: "echo hello" }),
          toolPart("call-2", LONG_OUTPUT, { cmd: "echo hello" }),
        ],
        undefined,
        { input: 99999, output: 100 },
      ),
    ];

    contextPruningTransformHandler(messages, {
      enabled: true,
      dedup: {
        enabled: true,
        thresholdContext: 100000,
      },
      purgeErrors: {},
    });

    // Gate closed — no dedup marks created.
    assert.equal(state.marks.size, 0);
    // Outputs untouched.
    assert.ok(
      (messages[1].parts?.[0] as SweepToolPart).state?.output?.startsWith(
        LONG_OUTPUT,
      ),
    );
    assert.ok(
      (messages[1].parts?.[1] as SweepToolPart).state?.output?.startsWith(
        LONG_OUTPUT,
      ),
    );
  });

  it("gate: tokens.input at threshold runs dedup", () => {
    const sessionID = "sess-gate-at";
    const state = getOrCreateSessionState(sessionID);

    const messages = [
      msg("user", "u1", [textPart("hi")], sessionID),
      msg(
        "assistant",
        "a1",
        [
          toolPart("call-1", LONG_OUTPUT, { cmd: "echo hello" }),
          toolPart("call-2", LONG_OUTPUT, { cmd: "echo hello" }),
        ],
        undefined,
        { input: 100000, output: 100 },
      ),
    ];

    contextPruningTransformHandler(messages, {
      enabled: true,
      protectedMessages: 0,
      dedup: {
        enabled: true,
        thresholdContext: 100000,
      },
      purgeErrors: {},
    });

    // Gate open — dedup runs, older duplicate marked (non-effective).
    assert.ok(pendingCount(state) > 0);
    // Outputs NOT replaced (marks fresh for next turn).
    assert.ok(
      (messages[1].parts?.[0] as SweepToolPart).state?.output?.startsWith(
        LONG_OUTPUT,
      ),
    );
    assert.ok(
      (messages[1].parts?.[1] as SweepToolPart).state?.output?.startsWith(
        LONG_OUTPUT,
      ),
    );
  });

  it("gate: missing tokens.input skips dedup", () => {
    const sessionID = "sess-gate-missing";
    const state = getOrCreateSessionState(sessionID);

    const messages = [
      msg("user", "u1", [textPart("hi")], sessionID),
      msg(
        "assistant",
        "a1",
        [
          toolPart("call-1", LONG_OUTPUT, { cmd: "echo hello" }),
          toolPart("call-2", LONG_OUTPUT, { cmd: "echo hello" }),
        ],
        undefined,
        { output: 100 }, // no input field
      ),
    ];

    contextPruningTransformHandler(messages, {
      enabled: true,
      dedup: {
        enabled: true,
        thresholdContext: 100000,
      },
      purgeErrors: {},
    });

    // Gate closed — no dedup.
    assert.equal(state.marks.size, 0);
  });

  it("gate: cache.read pushes total to threshold — runs dedup", () => {
    // Regression test for the prompt-caching bug:
    // when prompt caching is enabled, tokens.input may be very small
    // while cache.read carries the bulk of prompt tokens.
    // Gate must sum input + cache.read + cache.write.
    const sessionID = "sess-gate-cache-read-at";
    const state = getOrCreateSessionState(sessionID);

    const messages = [
      msg("user", "u1", [textPart("hi")], sessionID),
      msg(
        "assistant",
        "a1",
        [
          toolPart("call-1", LONG_OUTPUT, { cmd: "echo hello" }),
          toolPart("call-2", LONG_OUTPUT, { cmd: "echo hello" }),
        ],
        undefined,
        { input: 500, cache: { read: 99500 }, output: 100 },
      ),
    ];

    contextPruningTransformHandler(messages, {
      enabled: true,
      protectedMessages: 0,
      dedup: {
        enabled: true,
        thresholdContext: 100000,
      },
      purgeErrors: {},
    });

    // Gate open — total = 500 + 99500 = 100000 >= threshold.
    assert.ok(pendingCount(state) > 0);
    assert.ok(
      (messages[1].parts?.[0] as SweepToolPart).state?.output?.startsWith(
        LONG_OUTPUT,
      ),
    );
  });

  it("gate: cache.read just below threshold skips dedup", () => {
    const sessionID = "sess-gate-cache-read-below";
    const state = getOrCreateSessionState(sessionID);

    const messages = [
      msg("user", "u1", [textPart("hi")], sessionID),
      msg(
        "assistant",
        "a1",
        [
          toolPart("call-1", LONG_OUTPUT, { cmd: "echo hello" }),
          toolPart("call-2", LONG_OUTPUT, { cmd: "echo hello" }),
        ],
        undefined,
        { input: 500, cache: { read: 99499 }, output: 100 },
      ),
    ];

    contextPruningTransformHandler(messages, {
      enabled: true,
      dedup: {
        enabled: true,
        thresholdContext: 100000,
      },
      purgeErrors: {},
    });

    // Gate closed — total = 500 + 99499 = 99999 < threshold.
    assert.equal(state.marks.size, 0);
    assert.ok(
      (messages[1].parts?.[0] as SweepToolPart).state?.output?.startsWith(
        LONG_OUTPUT,
      ),
    );
  });

  it("gate: cache.read + cache.write both contribute to threshold", () => {
    const sessionID = "sess-gate-cache-read-write-at";
    const state = getOrCreateSessionState(sessionID);

    const messages = [
      msg("user", "u1", [textPart("hi")], sessionID),
      msg(
        "assistant",
        "a1",
        [
          toolPart("call-1", LONG_OUTPUT, { cmd: "echo hello" }),
          toolPart("call-2", LONG_OUTPUT, { cmd: "echo hello" }),
        ],
        undefined,
        { input: 50000, cache: { read: 40000, write: 10000 }, output: 100 },
      ),
    ];

    contextPruningTransformHandler(messages, {
      enabled: true,
      protectedMessages: 0,
      dedup: {
        enabled: true,
        thresholdContext: 100000,
      },
      purgeErrors: {},
    });

    // Gate open — total = 50000 + 40000 + 10000 = 100000 >= threshold.
    assert.ok(pendingCount(state) > 0);
    assert.ok(
      (messages[1].parts?.[0] as SweepToolPart).state?.output?.startsWith(
        LONG_OUTPUT,
      ),
    );
  });

  it("master enabled=false leaves messages completely untouched", () => {
    // When config.enabled === false, nothing happens — no Phases 1–6,
    // no persistence, no state mutations.
    const sessionID = "sess-disabled";
    const state = getOrCreateSessionState(sessionID);
    const LONG_OUTPUT = "x".repeat(500);

    // Pre-populate an effective mark so Phase 1 would normally prune.
    addMark(state, "call-sweep-1", 50, true, "tool-output");

    const messages = [
      msg("user", "u1", [textPart("do it")], sessionID),
      msg(
        "assistant",
        "a1",
        [
          toolPart("call-sweep-1", "original output", { cmd: "ls" }),
          toolPart("call-dedup-1", LONG_OUTPUT, { cmd: "echo hello" }),
          toolPart("call-dedup-2", LONG_OUTPUT, { cmd: "echo hello" }),
        ],
        undefined,
        { input: 100000, output: 200 },
      ),
    ];

    // Deep-clone the original messages for comparison.
    const original = JSON.parse(JSON.stringify(messages));

    contextPruningTransformHandler(messages, {
      enabled: false,
      protectedMessages: 0,
      releasedPercent: 0,
      dedup: { enabled: true, thresholdContext: 100000 },
      purgeErrors: { enabled: true, thresholdContext: 0 },
    });

    // Messages completely untouched — byte-identical to original.
    assert.equal(JSON.stringify(messages), JSON.stringify(original));

    // No state mutations (marks untouched, no persistence).
    assert.equal(state.marks.size, 1, "pre-existing marks not modified");
    assert.equal(
      state.marks.get("call-sweep-1")?.effective,
      true,
      "mark effective flag unchanged",
    );
    // dirty was set to true by addMark() before the handler call;
    // the early-return must not have cleared it (no saveSessionState).
    assert.equal(
      state.dirty,
      true,
      "state dirty flag untouched by early return",
    );
  });

  it("handler no-ops when enabled field is absent (default-off)", () => {
    // With the master switch defaulting to off, passing a config without
    // `enabled` must cause the handler to no-op entirely.
    const sessionID = "sess-enabled-absent";
    const state = getOrCreateSessionState(sessionID);

    // Pre-populate an effective mark so Phase 2 would normally prune.
    addMark(state, "call-sweep-1", 50, true, "tool-output");

    const messages = [
      msg("user", "u1", [textPart("do it")], sessionID),
      msg(
        "assistant",
        "a1",
        [
          toolPart("call-sweep-1", "original output", { cmd: "ls" }),
          toolPart("call-dedup-1", LONG_OUTPUT, { cmd: "echo hello" }),
          toolPart("call-dedup-2", LONG_OUTPUT, { cmd: "echo hello" }),
        ],
        undefined,
        { input: 100000, output: 200 },
      ),
    ];

    // Deep-clone the original messages for comparison.
    const original = JSON.parse(JSON.stringify(messages));

    // Config without `enabled` field — uses default (false).
    contextPruningTransformHandler(messages, {
      dedup: { enabled: true, thresholdContext: 100000 },
      purgeErrors: { enabled: true, thresholdContext: 0 },
    });

    // Messages completely untouched.
    assert.equal(JSON.stringify(messages), JSON.stringify(original));

    // No state mutations — pre-existing marks unchanged.
    assert.equal(state.marks.size, 1);
    assert.equal(state.marks.get("call-sweep-1")?.effective, true);
    assert.equal(state.dirty, true, "dirty flag preserved (no save)");
  });

  it("gate: enabled=false skips dedup but prune still runs", () => {
    const sessionID = "sess-enabled-false";
    const state = getOrCreateSessionState(sessionID);

    // Pre-populate a mark to verify prune still runs.
    addMark(state, "call-sweep-1", 50, true, "tool-output");

    const messages = [
      msg("user", "u1", [textPart("hi")], sessionID),
      msg(
        "assistant",
        "a1",
        [
          toolPart("call-sweep-1", "original output", { cmd: "ls" }),
          toolPart("call-1", LONG_OUTPUT, { cmd: "echo hello" }),
          toolPart("call-2", LONG_OUTPUT, { cmd: "echo hello" }),
        ],
        undefined,
        { input: 100000, output: 200 },
      ),
    ];

    contextPruningTransformHandler(messages, {
      enabled: true,
      dedup: {
        enabled: false,
        thresholdContext: 100000,
      },
      purgeErrors: {},
    });

    // Prune still runs — pre-existing mark replaced.
    assert.ok(
      (messages[1].parts?.[0] as SweepToolPart).state?.output?.startsWith(
        PRUNED_TOOL_OUTPUT_REPLACEMENT,
      ),
    );

    // Dedup skipped — no new marks.
    assert.equal(state.marks.size, 1); // Only the pre-existing sweep mark.
  });

  it("gate: thresholdContext undefined skips the producer entirely", () => {
    // Regression: when thresholdContext is undefined (not configured),
    // the producer gate must skip the producer — no marks created.
    const sessionID = "sess-gate-threshold-undef";
    const state = getOrCreateSessionState(sessionID);

    const messages = [
      msg("user", "u1", [textPart("hi")], sessionID),
      msg(
        "assistant",
        "a1",
        [
          toolPart("call-1", LONG_OUTPUT, { cmd: "echo hello" }),
          toolPart("call-2", LONG_OUTPUT, { cmd: "echo hello" }),
        ],
        undefined,
        { input: 100000, output: 100 },
      ),
    ];

    contextPruningTransformHandler(messages, {
      enabled: true,
      protectedMessages: 0,
      dedup: {
        enabled: true,
        // thresholdContext is undefined → gate closes, producer skipped.
      },
      purgeErrors: {},
    });

    // No dedup marks created — producer was skipped due to undefined threshold.
    assert.equal(state.marks.size, 0);
    // Outputs untouched.
    assert.ok(
      (messages[1].parts?.[0] as SweepToolPart).state?.output?.startsWith(
        LONG_OUTPUT,
      ),
    );
    assert.ok(
      (messages[1].parts?.[1] as SweepToolPart).state?.output?.startsWith(
        LONG_OUTPUT,
      ),
    );
  });

  it("gate: releasedPercent undefined skips batch release", () => {
    // Regression: when releasedPercent is undefined, the batch
    // release check must be skipped entirely.  Marks remain pending.
    const sessionID = "sess-release-pct-undef";
    const state = getOrCreateSessionState(sessionID);

    const messages = [
      msg("user", "u1", [textPart("do it")], sessionID),
      msg(
        "assistant",
        "a1",
        [
          toolPart("call-1", LONG_OUTPUT, { cmd: "echo hello" }),
          toolPart("call-2", LONG_OUTPUT, { cmd: "echo hello" }),
        ],
        undefined,
        { input: 100000, output: 200 },
      ),
    ];

    contextPruningTransformHandler(messages, {
      enabled: true,
      protectedMessages: 0,
      // releasedPercent is undefined → release check skipped.
      releasedPercent: undefined,
      dedup: {
        enabled: true,
        thresholdContext: 100000,
      },
      purgeErrors: {},
    });

    // Dedup ran → mark is pending (non-effective).
    assert.ok(pendingCount(state) > 0, "must have pending marks");
    // No effective marks — batch release did NOT fire.
    assert.equal(reclaimedTokens(state), 0, "must not release marks");
    // Outputs untouched (marks are pending, not effective).
    assert.ok(
      (messages[1].parts?.[0] as SweepToolPart).state?.output?.startsWith(
        LONG_OUTPUT,
      ),
    );
  });

  // ===========================================================================
  // parseContextConfig — no defaults (fail to skip)
  // ===========================================================================

  it("parseContextConfig returns undefined fields when [zoo.context] is absent", () => {
    const config = parseContextConfig({});
    assert.equal(config.enabled, undefined);
    assert.equal(config.protectedMessages, undefined);
    assert.equal(config.releasedPercent, undefined);
    assert.equal(config.dedup.enabled, undefined);
    assert.equal(config.dedup.thresholdContext, undefined);
    assert.equal(config.dedup.protectedTools, undefined);
    assert.equal(config.purgeErrors.enabled, undefined);
    assert.equal(config.purgeErrors.thresholdContext, undefined);
    assert.equal(config.purgeErrors.protectedTools, undefined);
  });

  it("parseContextConfig reads [zoo.context] section with two-layer structure", () => {
    const config = parseContextConfig({
      context: {
        protected_messages: 3,
        dedup: {
          enabled: false,
          threshold_context: 64000,
          protected_tools: ["task", "read"],
        },
      },
    });
    assert.equal(config.dedup.enabled, false);
    assert.equal(config.dedup.thresholdContext, 64000);
    assert.equal(config.protectedMessages, 3);
    assert.deepEqual(config.dedup.protectedTools, ["task", "read"]);
    // Absent fields yield undefined.
    assert.equal(config.releasedPercent, undefined);
    assert.equal(config.purgeErrors.enabled, undefined);
    assert.equal(config.purgeErrors.thresholdContext, undefined);
    assert.equal(config.purgeErrors.protectedTools, undefined);
  });

  it("parseContextConfig returns undefined for non-boolean dedup.enabled (warns)", () => {
    const config = parseContextConfig({
      context: { dedup: { enabled: "false" } },
    });
    // "false" is not boolean → undefined (no default).
    assert.equal(config.dedup.enabled, undefined);

    const buffer = _getBufferForTesting();
    const entry = buffer.find((e) => e.event === "invalid_dedup_enabled");
    assert.ok(entry, "must log invalid_dedup_enabled");
  });

  it("parseContextConfig returns undefined for non-finite threshold_context (warns)", () => {
    const config = parseContextConfig({
      context: { dedup: { threshold_context: Infinity } },
    });
    assert.equal(config.dedup.thresholdContext, undefined);

    const config2 = parseContextConfig({
      context: { dedup: { threshold_context: NaN } },
    });
    assert.equal(config2.dedup.thresholdContext, undefined);

    const config3 = parseContextConfig({
      context: { dedup: { threshold_context: "100000" } },
    });
    assert.equal(config3.dedup.thresholdContext, undefined);

    const buffer = _getBufferForTesting();
    const entries = buffer.filter(
      (e) => e.event === "invalid_dedup_threshold_context",
    );
    assert.equal(entries.length, 3);
  });

  it("parseContextConfig returns undefined for non-finite protected_messages (warns)", () => {
    const config = parseContextConfig({
      context: { protected_messages: NaN },
    });
    assert.equal(config.protectedMessages, undefined);

    const config2 = parseContextConfig({
      context: { protected_messages: Infinity },
    });
    assert.equal(config2.protectedMessages, undefined);

    const config3 = parseContextConfig({
      context: { protected_messages: "3" },
    });
    assert.equal(config3.protectedMessages, undefined);

    const buffer = _getBufferForTesting();
    const entries = buffer.filter(
      (e) => e.event === "invalid_protected_messages",
    );
    assert.equal(entries.length, 3);
  });

  it("parseContextConfig returns undefined for non-string-array protected_tools", () => {
    const config = parseContextConfig({
      context: { dedup: { protected_tools: "task" } },
    });
    assert.equal(config.dedup.protectedTools, undefined);

    const config2 = parseContextConfig({
      context: { dedup: { protected_tools: [123, "read"] } },
    });
    assert.equal(config2.dedup.protectedTools, undefined);

    // Empty array is valid — preserved.
    const config3 = parseContextConfig({
      context: { dedup: { protected_tools: [] } },
    });
    assert.deepEqual(config3.dedup.protectedTools, []);
  });

  it("parseContextConfig preserves valid zero values", () => {
    const config = parseContextConfig({
      context: {
        protected_messages: 0,
        released_percent: 0,
        dedup: {
          enabled: false,
          threshold_context: 0,
          protected_tools: [],
        },
      },
    });
    assert.equal(config.dedup.enabled, false);
    assert.equal(config.dedup.thresholdContext, 0);
    assert.equal(config.protectedMessages, 0);
    assert.equal(config.releasedPercent, 0);
    assert.deepEqual(config.dedup.protectedTools, []);
  });

  // ===========================================================================
  // parseContextConfig — releasedPercent (top-level [zoo.context])
  // ===========================================================================

  it("parseContextConfig reads released_percent from top-level [zoo.context]", () => {
    const config = parseContextConfig({
      context: { released_percent: 10 },
    });
    assert.equal(config.releasedPercent, 10);
  });

  it("parseContextConfig returns undefined for non-number released_percent (warns)", () => {
    const config = parseContextConfig({
      context: { released_percent: "10" },
    });
    assert.equal(config.releasedPercent, undefined);

    const buffer = _getBufferForTesting();
    const entry = buffer.find((e) => e.event === "invalid_released_percent");
    assert.ok(entry, "must log invalid_released_percent");
  });

  it("parseContextConfig returns undefined for Infinity/NaN released_percent (warns)", () => {
    const config1 = parseContextConfig({
      context: { released_percent: Infinity },
    });
    assert.equal(config1.releasedPercent, undefined);

    const config2 = parseContextConfig({
      context: { released_percent: NaN },
    });
    assert.equal(config2.releasedPercent, undefined);

    const buffer = _getBufferForTesting();
    const entries = buffer.filter(
      (e) => e.event === "invalid_released_percent",
    );
    assert.equal(entries.length, 2);
  });

  it("parseContextConfig accepts 0 as valid releasedPercent (no batching)", () => {
    const config = parseContextConfig({
      context: { released_percent: 0 },
    });
    assert.equal(config.releasedPercent, 0);
  });

  it("parseContextConfig returns undefined for negative released_percent (warns)", () => {
    const config = parseContextConfig({
      context: { released_percent: -1 },
    });
    assert.equal(config.releasedPercent, undefined);

    const buffer = _getBufferForTesting();
    const entry = buffer.find((e) => e.event === "invalid_released_percent");
    assert.ok(entry, "must log invalid_released_percent");
  });

  it("parseContextConfig returns undefined for released_percent when absent", () => {
    const config = parseContextConfig({});
    assert.equal(config.releasedPercent, undefined);
  });

  it("parseContextConfig ignores dedup.released_percent (old location)", () => {
    // Old location [zoo.context.dedup].released_percent is
    // intentionally NOT read — the new location is [zoo.context] top-level.
    const config = parseContextConfig({
      context: {
        released_percent: 10,
        dedup: { released_percent: 99 },
      },
    });
    // Top-level value takes precedence (99 in dedup is ignored).
    assert.equal(config.releasedPercent, 10);

    // When only dedup.released_percent exists (no top-level) → undefined.
    const config2 = parseContextConfig({
      context: { dedup: { released_percent: 99 } },
    });
    assert.equal(config2.releasedPercent, undefined);
  });

  // ===========================================================================
  // parseContextConfig — purgeErrors
  // ===========================================================================

  it("parseContextConfig reads purge_errors section from [zoo.context]", () => {
    const config = parseContextConfig({
      context: {
        purge_errors: {
          enabled: false,
          threshold_context: 50000,
          protected_tools: ["bash"],
        },
      },
    });
    assert.equal(config.purgeErrors.enabled, false);
    assert.equal(config.purgeErrors.thresholdContext, 50000);
    assert.deepEqual(config.purgeErrors.protectedTools, ["bash"]);
  });

  it("parseContextConfig returns undefined for purgeErrors fields when section is absent", () => {
    const config = parseContextConfig({});
    assert.equal(config.purgeErrors.enabled, undefined);
    assert.equal(config.purgeErrors.thresholdContext, undefined);
    assert.equal(config.purgeErrors.protectedTools, undefined);
  });

  it("parseContextConfig returns undefined for non-boolean purge_errors enabled (warns)", () => {
    const config = parseContextConfig({
      context: { purge_errors: { enabled: "false" } },
    });
    assert.equal(config.purgeErrors.enabled, undefined);

    const buffer = _getBufferForTesting();
    const entry = buffer.find(
      (e) => e.event === "invalid_purge_errors_enabled",
    );
    assert.ok(entry, "must log invalid_purge_errors_enabled");
  });

  it("parseContextConfig reads enabled: false from [zoo.context]", () => {
    const config = parseContextConfig({
      context: { enabled: false },
    });
    assert.equal(config.enabled, false);
  });

  it("parseContextConfig returns undefined for enabled when absent", () => {
    const config = parseContextConfig({});
    assert.equal(config.enabled, undefined);
  });

  it("parseContextConfig returns undefined for non-boolean enabled (warns)", () => {
    const config1 = parseContextConfig({
      context: { enabled: "false" },
    });
    assert.equal(config1.enabled, undefined);

    const config2 = parseContextConfig({
      context: { enabled: 0 },
    });
    assert.equal(config2.enabled, undefined);

    const buffer = _getBufferForTesting();
    const entries = buffer.filter(
      (e) => e.event === "invalid_context_pruning_enabled",
    );
    assert.equal(entries.length, 2);
  });

  it("parseContextConfig returns undefined for unknown keys in context config", () => {
    const config = parseContextConfig({
      context: {
        unknown_key: true,
        dedup: { unknown_dedup_key: true },
        purge_errors: { unknown_pe_key: true },
      },
    });
    // Unknown keys ignored — all fields are undefined.
    assert.equal(config.enabled, undefined);
    assert.equal(config.protectedMessages, undefined);
    assert.equal(config.releasedPercent, undefined);
    assert.equal(config.dedup.enabled, undefined);
    assert.equal(config.dedup.thresholdContext, undefined);
    assert.equal(config.dedup.protectedTools, undefined);
    assert.equal(config.purgeErrors.enabled, undefined);
    assert.equal(config.purgeErrors.thresholdContext, undefined);
    assert.equal(config.purgeErrors.protectedTools, undefined);
  });

  it("parseContextConfig ignores unrecognized keys", () => {
    // Unknown keys are silently ignored — they do not map to config fields.
    const config = parseContextConfig({
      context: {
        turn_protection: 3,
        release_threshold_percent: 10,
        dedup: { threshold_tokens: 50000 },
        purge_errors: { threshold_tokens: 25000 },
      },
    });
    assert.equal(config.protectedMessages, undefined);
    assert.equal(config.releasedPercent, undefined);
    assert.equal(config.dedup.thresholdContext, undefined);
    assert.equal(config.purgeErrors.thresholdContext, undefined);
    // Other config fields are also undefined by default.
    assert.equal(config.enabled, undefined);
  });

  // ===========================================================================
  // parseContextConfig — compress section
  // ===========================================================================

  it("parseContextConfig reads [zoo.context.compress] section with three keys", () => {
    const config = parseContextConfig({
      context: {
        compress: {
          enabled: true,
          threshold_tokens: 2000,
          protected_tokens: 20000,
        },
      },
    });
    assert.equal(config.compress?.enabled, true);
    assert.equal(config.compress?.thresholdTokens, 2000);
    assert.equal(config.compress?.protectedTokens, 20000);
  });

  it("parseContextConfig returns undefined compress fields when section is absent", () => {
    const config = parseContextConfig({});
    assert.equal(config.compress?.enabled, undefined);
    assert.equal(config.compress?.thresholdTokens, undefined);
    assert.equal(config.compress?.protectedTokens, undefined);
  });

  it("parseContextConfig returns undefined for non-boolean compress.enabled (warns)", () => {
    const config = parseContextConfig({
      context: { compress: { enabled: "true" } },
    });
    assert.equal(config.compress?.enabled, undefined);

    const buffer = _getBufferForTesting();
    const entry = buffer.find((e) => e.event === "invalid_compress_enabled");
    assert.ok(entry, "must log invalid_compress_enabled");
  });

  it("parseContextConfig returns undefined for non-finite compress.threshold_tokens (warns)", () => {
    const config = parseContextConfig({
      context: { compress: { threshold_tokens: Infinity } },
    });
    assert.equal(config.compress?.thresholdTokens, undefined);

    const config2 = parseContextConfig({
      context: { compress: { threshold_tokens: NaN } },
    });
    assert.equal(config2.compress?.thresholdTokens, undefined);

    const config3 = parseContextConfig({
      context: { compress: { threshold_tokens: "2000" } },
    });
    assert.equal(config3.compress?.thresholdTokens, undefined);

    const buffer = _getBufferForTesting();
    const entries = buffer.filter(
      (e) => e.event === "invalid_compress_threshold_tokens",
    );
    assert.equal(entries.length, 3);
  });

  it("parseContextConfig returns undefined for non-finite compress.protected_tokens (warns)", () => {
    const config = parseContextConfig({
      context: { compress: { protected_tokens: Infinity } },
    });
    assert.equal(config.compress?.protectedTokens, undefined);

    const config2 = parseContextConfig({
      context: { compress: { protected_tokens: "20000" } },
    });
    assert.equal(config2.compress?.protectedTokens, undefined);

    const buffer = _getBufferForTesting();
    const entries = buffer.filter(
      (e) => e.event === "invalid_compress_protected_tokens",
    );
    assert.equal(entries.length, 2);
  });

  it("parseContextConfig reads compress.enabled: false", () => {
    const config = parseContextConfig({
      context: { compress: { enabled: false } },
    });
    assert.equal(config.compress?.enabled, false);
  });

  // ===========================================================================
  // Batch release integration tests
  // ===========================================================================

  /** Helper: setup session ID list for cleanup. */
  const BATCH_SESSION_IDS = [
    "sess-batch-below",
    "sess-batch-at",
    "sess-batch-accumulate",
    "sess-batch-sweep",
    "sess-batch-notify",
    "sess-batch-no-notify",
    "sess-batch-empty-pending",
    "sess-batch-notify-below",
  ];

  // Add to the file-level TEST_SESSION_IDS so afterEach cleans them.
  // We mutate the array at runtime — it's fine since afterEach iterates it.
  TEST_SESSION_IDS.push(...BATCH_SESSION_IDS);

  it("batch: turn N dedup goes to pending, turn N+1 NOT replaced (below threshold)", () => {
    const sessionID = "sess-batch-below";
    const state = getOrCreateSessionState(sessionID);

    // Turn N: 2 duplicate calls -> dedup marks call-1 (older).
    // Each mark ~125 tokens, total ~125, promptTokens=100000,
    // releasedPercent=5 -> threshold=5000. 125 < 5000 -> no release.
    const messages = [
      msg("user", "u1", [textPart("do it")], sessionID),
      msg(
        "assistant",
        "a1",
        [
          toolPart("call-1", LONG_OUTPUT, { cmd: "echo hello" }),
          toolPart("call-2", LONG_OUTPUT, { cmd: "echo hello" }),
        ],
        undefined,
        { input: 100000, output: 200 },
      ),
    ];

    contextPruningTransformHandler(messages, {
      enabled: true,
      protectedMessages: 0,
      releasedPercent: 5,
      dedup: {
        enabled: true,
        thresholdContext: 100000,
      },
      purgeErrors: {},
    });

    // Dedup ran -> mark is pending (non-effective).
    assert.ok(pendingCount(state) > 0);
    // No effective marks yet (not released).
    assert.equal(reclaimedTokens(state), 0);
    // Outputs not replaced.
    assert.ok(
      (messages[1].parts?.[0] as SweepToolPart).state?.output?.startsWith(
        LONG_OUTPUT,
      ),
    );

    // Turn N+1: same messages (no new marks, no release needed).
    const messages2 = [
      msg("user", "u2", [textPart("again")], sessionID),
      msg(
        "assistant",
        "a2",
        [
          toolPart("call-1", LONG_OUTPUT, { cmd: "echo hello" }),
          toolPart("call-2", LONG_OUTPUT, { cmd: "echo hello" }),
        ],
        undefined,
        { input: 100000, output: 200 },
      ),
    ];

    contextPruningTransformHandler(messages2, {
      enabled: true,
      protectedMessages: 0,
      releasedPercent: 5,
      dedup: {
        enabled: true,
        thresholdContext: 100000,
      },
      purgeErrors: {},
    });

    // Still not effective (pending tokens still below threshold,
    // no new marks added so pending hasn't grown).
    assert.equal(reclaimedTokens(state), 0, "marks still pending");
  });

  it("batch: marks released when pending reaches threshold, pruned next turn", () => {
    const sessionID = "sess-batch-at";
    const state = getOrCreateSessionState(sessionID);

    // Use a very low releasedPercent to trigger immediate release.
    // promptTokens=100000, releasedPercent=0.001 -> threshold=1
    // Any positive pending tokens will trigger release.
    const lotOfOutput = "x".repeat(2000); // ~500 tokens

    // Turn N: 20 duplicate calls so pending sum is large.
    // Actually simpler: set releasedPercent=0 so 0 >= threshold always.
    const messages = [
      msg("user", "u1", [textPart("do it")], sessionID),
      msg(
        "assistant",
        "a1",
        [
          toolPart("call-1", lotOfOutput, { cmd: "echo hello" }),
          toolPart("call-2", lotOfOutput, { cmd: "echo hello" }),
        ],
        undefined,
        { input: 100000, output: 200 },
      ),
    ];

    // With releasedPercent=0, any positive pending triggers immediate release.
    contextPruningTransformHandler(messages, {
      enabled: true,
      protectedMessages: 0,
      releasedPercent: 0,
      dedup: {
        enabled: true,
        thresholdContext: 100000,
      },
      purgeErrors: {},
    });

    // Dedup ran and marks were released (flipped to effective).
    assert.ok(state.marks.size > 0);
    assert.ok(
      reclaimedTokens(state) > 0,
      "marks should be effective after release",
    );
    assert.equal(
      pendingCount(state),
      0,
      "pending should be empty after release",
    );

    // But this turn's outputs are NOT replaced yet (Phase 2 ran before release).
    assert.ok(
      (messages[1].parts?.[0] as SweepToolPart).state?.output?.startsWith(
        lotOfOutput,
      ),
    );

    // Turn N+1: now marks should take effect.
    const messages2 = [
      msg("user", "u2", [textPart("again")], sessionID),
      msg("assistant", "a2", [
        toolPart("call-1", lotOfOutput, { cmd: "echo hello" }),
        toolPart("call-2", lotOfOutput, { cmd: "echo hello" }),
      ]),
    ];

    contextPruningTransformHandler(messages2, {
      enabled: true,
      protectedMessages: 0,
      releasedPercent: 0,
      dedup: {
        enabled: true,
        thresholdContext: 100000,
      },
      purgeErrors: {},
    });

    const parts2 = messages2[1].parts ?? [];
    // call-1 (older duplicate) should now be pruned.
    assert.ok(
      (parts2[0] as SweepToolPart).state?.output?.startsWith(
        PRUNED_TOOL_OUTPUT_REPLACEMENT,
      ),
    );
    // call-2 (keeper) unchanged.
    assert.ok(
      (parts2[1] as SweepToolPart).state?.output?.startsWith(lotOfOutput),
    );
  });

  it("batch: accumulation across multiple turns before release", () => {
    const sessionID = "sess-batch-accumulate";
    const state = getOrCreateSessionState(sessionID);

    // Each mark ~104 tokens (LONG_OUTPUT=500 chars ~125 tokens,
    // placeholder ~21 tokens, diff=104). With promptTokens=100000,
    // releasedPercent=0.8, threshold=800. Need ~8 marks to trigger.
    // We'll create marks spread across multiple turns.

    // Turn 1: 4 identical calls -> 3 marks (~312 tokens).
    let messages = [
      msg("user", "u1", [textPart("turn 1")], sessionID),
      msg(
        "assistant",
        "a1",
        [
          toolPart("call-A1", LONG_OUTPUT, { cmd: "ls" }),
          toolPart("call-A2", LONG_OUTPUT, { cmd: "ls" }),
          toolPart("call-A3", LONG_OUTPUT, { cmd: "ls" }),
          toolPart("call-A4", LONG_OUTPUT, { cmd: "ls" }),
        ],
        undefined,
        { input: 100000, output: 200 },
      ),
    ];
    contextPruningTransformHandler(messages, {
      enabled: true,
      protectedMessages: 0,
      releasedPercent: 0.8,
      dedup: {
        enabled: true,
        thresholdContext: 100000,
      },
      purgeErrors: {},
    });

    // ~312 tokens in pending, threshold=800, not released.
    assert.ok(pendingCount(state) > 0);
    assert.equal(reclaimedTokens(state), 0);

    // Turn 2: 4 more identical calls -> 3 more marks (~624 cumulative).
    messages = [
      msg("user", "u2", [textPart("turn 2")], sessionID),
      msg(
        "assistant",
        "a2",
        [
          toolPart("call-B1", LONG_OUTPUT, { cmd: "ls" }),
          toolPart("call-B2", LONG_OUTPUT, { cmd: "ls" }),
          toolPart("call-B3", LONG_OUTPUT, { cmd: "ls" }),
          toolPart("call-B4", LONG_OUTPUT, { cmd: "ls" }),
        ],
        undefined,
        { input: 100000, output: 200 },
      ),
    ];
    contextPruningTransformHandler(messages, {
      enabled: true,
      protectedMessages: 0,
      releasedPercent: 0.8,
      dedup: {
        enabled: true,
        thresholdContext: 100000,
      },
      purgeErrors: {},
    });

    // Still below threshold (~624 < 800).
    assert.equal(reclaimedTokens(state), 0, "still below threshold");

    // Turn 3: 4 more identical calls -> 3 more marks (~936 cumulative).
    // This should trigger release!
    messages = [
      msg("user", "u3", [textPart("turn 3")], sessionID),
      msg(
        "assistant",
        "a3",
        [
          toolPart("call-C1", LONG_OUTPUT, { cmd: "ls" }),
          toolPart("call-C2", LONG_OUTPUT, { cmd: "ls" }),
          toolPart("call-C3", LONG_OUTPUT, { cmd: "ls" }),
          toolPart("call-C4", LONG_OUTPUT, { cmd: "ls" }),
        ],
        undefined,
        { input: 100000, output: 200 },
      ),
    ];
    contextPruningTransformHandler(messages, {
      enabled: true,
      protectedMessages: 0,
      releasedPercent: 0.8,
      dedup: {
        enabled: true,
        thresholdContext: 100000,
      },
      purgeErrors: {},
    });

    // Now released (936 >= 800).
    assert.ok(
      reclaimedTokens(state) > 0,
      "marks should be effective after release",
    );
    assert.equal(pendingCount(state), 0, "pending should be cleared");
  });

  it("batch: /dcp sweep marks are effective immediately", () => {
    const sessionID = "sess-batch-sweep";
    const state = getOrCreateSessionState(sessionID);

    // Simulate a sweep: add an effective mark.
    addMark(state, "call-sweep", 200, true, "tool-output");

    // Turn N: no dedup-worthy duplicates, but sweep mark exists.
    const messages = [
      msg("user", "u1", [textPart("do it")], sessionID),
      msg(
        "assistant",
        "a1",
        [toolPart("call-sweep", "sweep output", { cmd: "ls" })],
        undefined,
        { input: 100000, output: 200 },
      ),
    ];

    contextPruningTransformHandler(messages, {
      enabled: true,
      protectedMessages: 0,
      releasedPercent: 5, // Normal threshold
      dedup: {
        enabled: true,
        thresholdContext: 100000,
      },
      purgeErrors: {},
    });

    // Sweep mark is in tools and should be pruned.
    assert.ok(
      (messages[1].parts?.[0] as SweepToolPart).state?.output?.startsWith(
        PRUNED_TOOL_OUTPUT_REPLACEMENT,
      ),
    );
    // No pending marks for sweep marks.
    assert.equal(pendingCount(state), 0);
  });

  // ===========================================================================
  // Dedup release notification (notify callback)
  // ===========================================================================

  it("notify: called exactly once with count and tokens on batch release", () => {
    const sessionID = "sess-batch-notify";
    const lotOfOutput = "x".repeat(2000);
    const messages = [
      msg("user", "u1", [textPart("do it")], sessionID),
      msg(
        "assistant",
        "a1",
        [
          toolPart("call-1", lotOfOutput, { cmd: "echo hello" }),
          toolPart("call-2", lotOfOutput, { cmd: "echo hello" }),
        ],
        undefined,
        { input: 100000, output: 200 },
      ),
    ];

    const notifyCalls: string[] = [];
    const notify = (text: string) => {
      notifyCalls.push(text);
    };

    contextPruningTransformHandler(
      messages,
      {
        enabled: true,
        protectedMessages: 0,
        releasedPercent: 0,
        dedup: { enabled: true, thresholdContext: 100000 },
        purgeErrors: {},
      },
      notify,
    );

    // Dedup ran → pending released → notify called once.
    assert.equal(notifyCalls.length, 1);
    // Text contains count and token info.
    const text = notifyCalls[0];
    assert.ok(text.includes("上下文清理"), "should contain action keyword");
    assert.ok(text.includes("1"), "should mention mark count");
    assert.ok(
      text.includes("K") || text.includes("token"),
      "should reference tokens",
    );
  });

  it("notify: not called when handler works without notify parameter", () => {
    const sessionID = "sess-batch-no-notify";
    const state = getOrCreateSessionState(sessionID);

    const lotOfOutput = "x".repeat(2000);
    const messages = [
      msg("user", "u1", [textPart("do it")], sessionID),
      msg(
        "assistant",
        "a1",
        [
          toolPart("call-1", lotOfOutput, { cmd: "echo hello" }),
          toolPart("call-2", lotOfOutput, { cmd: "echo hello" }),
        ],
        undefined,
        { input: 100000, output: 200 },
      ),
    ];

    // No notify parameter — should not throw.
    contextPruningTransformHandler(messages, {
      enabled: true,
      protectedMessages: 0,
      releasedPercent: 0,
      dedup: {
        enabled: true,
        thresholdContext: 100000,
      },
      purgeErrors: {},
    });

    // Release happened normally.
    assert.ok(reclaimedTokens(state) > 0, "should have released marks");
    assert.equal(pendingCount(state), 0, "pending should be cleared");
  });

  it("notify: not called when pending is empty (no dedup marks)", () => {
    const sessionID = "sess-batch-empty-pending";
    const state = getOrCreateSessionState(sessionID);

    const messages = [
      msg("user", "u1", [textPart("hi")], sessionID),
      msg(
        "assistant",
        "a1",
        [toolPart("call-1", "unique output", { cmd: "echo hello" })],
        undefined,
        { input: 100000, output: 200 },
      ),
    ];

    const notifyCalls: string[] = [];
    const notify = (text: string) => {
      notifyCalls.push(text);
    };

    contextPruningTransformHandler(
      messages,
      {
        enabled: true,
        protectedMessages: 0,
        releasedPercent: 0,
        dedup: { enabled: true, thresholdContext: 100000 },
        purgeErrors: {},
      },
      notify,
    );

    // No duplicates → no marks → no release → no notify.
    assert.equal(notifyCalls.length, 0);
    assert.equal(state.marks.size, 0);
  });

  it("notify: not called when pending tokens below batch threshold", () => {
    const sessionID = "sess-batch-notify-below";

    // With releasedPercent=5 and promptTokens=100000, threshold is 5000.
    // A single short duplicate will produce a very small mark.
    const SHORT_OUTPUT = "x".repeat(20); // ~5 tokens
    const messages = [
      msg("user", "u1", [textPart("do it")], sessionID),
      msg(
        "assistant",
        "a1",
        [
          toolPart("call-1", SHORT_OUTPUT, { cmd: "echo hello" }),
          toolPart("call-2", SHORT_OUTPUT, { cmd: "echo hello" }),
        ],
        undefined,
        { input: 100000, output: 200 },
      ),
    ];

    const notifyCalls: string[] = [];
    const notify = (text: string) => {
      notifyCalls.push(text);
    };

    contextPruningTransformHandler(
      messages,
      {
        enabled: true,
        protectedMessages: 0,
        releasedPercent: 0,
        dedup: { enabled: true, thresholdContext: 100000 },
        purgeErrors: {},
      },
      notify,
    );

    // Dedup ran but short outputs → zero-benefit skip → no marks.
    // If marks did exist they'd be tiny (<5000) → no release → no notify.
    assert.equal(notifyCalls.length, 0);
  });

  // ===========================================================================
  // prune_completed log: mixed effective + pending marks
  // ===========================================================================

  it("prune_completed log: prunedToolCount counts only effective marks, totalReclaimedTokens excludes pending", () => {
    // Regression: the prune_completed log must report effective-only counts,
    // not total marks (which would inflate both prunedToolCount and
    // totalReclaimedTokens with pending marks not yet applied).
    const sessionID = "sess-log-mixed";
    const state = getOrCreateSessionState(sessionID);

    // 2 effective marks (already released).
    addMark(state, "call-eff-1", 200, true, "tool-output");
    addMark(state, "call-eff-2", 300, true, "tool-output");
    // 1 pending mark (not yet released).
    addMark(state, "call-pending-1", 500, false, "tool-output");

    // Messages referencing all three call IDs so pruneToolOutputs runs.
    const messages = [
      msg("user", "u1", [textPart("do it")], sessionID),
      msg("assistant", "a1", [
        toolPart(
          "call-eff-1",
          "eff1 output that is long enough for positive net",
        ),
        textPart("some text"),
        toolPart(
          "call-eff-2",
          "eff2 output that is also fairly long for positive net",
        ),
        toolPart(
          "call-pending-1",
          "pending output that is also long enough for positive net",
        ),
      ]),
    ];

    contextPruningTransformHandler(messages, {
      enabled: true,
      dedup: {},
      purgeErrors: {},
    });

    // Capture the prune_completed log event.
    const entries = _getBufferForTesting();
    const pruneCompleted = entries.find((e) => e.event === "prune_completed") as
      | Record<string, unknown>
      | undefined;
    assert.ok(pruneCompleted, "expected prune_completed log event");

    // prunedToolCount must be 2 (effective only, NOT 3 total).
    assert.equal(
      pruneCompleted.prunedToolCount,
      2,
      "prunedToolCount should count only effective marks",
    );

    // totalReclaimedTokens must equal reclaimed tokens (200 + 300 = 500),
    // NOT 500 + 500 = 1000 (which would include pending).
    assert.equal(
      pruneCompleted.totalReclaimedTokens,
      500,
      "totalReclaimedTokens must exclude pending tokens",
    );

    // totalPruneTokens has the same value as totalReclaimedTokens.
    assert.equal(
      pruneCompleted.totalPruneTokens,
      500,
      "totalPruneTokens should also equal effective-only tokens",
    );
  });

  it("purge-errors end-to-end: error part → mark → release → next-turn clean", () => {
    // Session starts with an error tool call outside the protection window.
    const sessionID = "sess-pe-e2e";
    const state = getOrCreateSessionState(sessionID);

    // Turn N: first assistant message (step-start), error tool part.
    const turnN = [
      msg("user", "u1", [textPart("do it")], sessionID),
      msg(
        "assistant",
        "a1",
        [
          { type: "step-start" },
          {
            type: "tool",
            callID: "call-err-1",
            state: {
              input: { cmd: "very long command ".repeat(50) },
              output: "process terminated",
              status: "error",
            },
            tool: "bash",
          },
        ] as Array<SweepToolPart | { type: string; text?: string }>,
        undefined,
        { input: 200000, output: 100 },
      ),
    ];

    // Handler with dedup enabled (won't touch error parts) and
    // purge-errors enabled.
    contextPruningTransformHandler(turnN, {
      enabled: true,
      protectedMessages: 0,
      releasedPercent: 0,
      dedup: { enabled: true, thresholdContext: 0 },
      purgeErrors: { enabled: true, thresholdContext: 0 },
    });

    // Turn N: purge-errors marks call-err-1 as pending and releaseBatch
    // flips it immediately (releasedPercent=0).
    assert.ok(state.marks.has("call-err-1"), "error part should be marked");
    const mark = state.marks.get("call-err-1");
    assert.ok(mark, "mark should exist");
    assert.equal(
      mark.effective,
      true,
      "mark flipped to effective by immediate release",
    );
    assert.equal(
      mark.action,
      "tool-error-input",
      "mark action should be tool-error-input",
    );

    // Turn N Phase 2 already ran before Phase 3 (mark), so the
    // just-released mark did NOT get cleaned in this turn.
    // (The two-turn effect is verified by checking that the next turn's
    // Phase 2 applies the replacement.)

    // Simulate Turn N+1: new messages arrive.  The effective mark for
    // call-err-1 should now be cleaned by Phase 2 pruneToolErrors.
    const turnN1 = [
      msg("user", "u2", [textPart("again")], sessionID),
      msg(
        "assistant",
        "a2",
        [
          { type: "step-start" },
          {
            type: "tool",
            callID: "call-err-1",
            state: {
              input: { cmd: "very long command ".repeat(50) },
              output: "process terminated",
              status: "error",
            },
            tool: "bash",
          },
        ] as Array<SweepToolPart | { type: string; text?: string }>,
        undefined,
        { input: 200000, output: 100 },
      ),
    ];

    contextPruningTransformHandler(turnN1, {
      enabled: true,
      protectedMessages: 0,
      releasedPercent: 0,
      dedup: { enabled: true, thresholdContext: 0 },
      purgeErrors: { enabled: true, thresholdContext: 0 },
    });

    // Turn N+1 Phase 2: pruneToolErrors replaces the input.
    // Note: injectMessageRefs inserts a synthetic text part
    // before the first tool part, shifting tool part index from 1 to 2.
    const partN1 = turnN1[1].parts?.[2] as SweepToolPart;
    assert.equal(
      (partN1.state?.input as Record<string, unknown>).cmd,
      PRUNED_TOOL_ERROR_INPUT_REPLACEMENT,
      "input replaced in next turn",
    );
    // state.error and output remain untouched.
    // Note: status is a separate field from error message.
    assert.ok(
      partN1.state?.output?.startsWith("process terminated"),
      "output should remain unchanged",
    );
  });

  // ===========================================================================
  // message-refs integration
  // ===========================================================================

  describe("message-refs integration", () => {
    const P25_SESSION_IDS = [
      "sess-refs-phase2",
      "sess-refs-det",
      "sess-refs-boundary",
    ];
    TEST_SESSION_IDS.push(...P25_SESSION_IDS);

    it("(a) refs injected into all non-ignored messages with text parts", () => {
      const sessionID = "sess-refs-phase2";
      const messages: ContextMessageEntry[] = [
        msg("user", "u1", [textPart("hello")], sessionID),
        msg("assistant", "a1", [textPart("world")]),
        msg("user", "u2", [textPart("ignored-msg", true)], sessionID),
        msg("assistant", "a2", [
          {
            type: "tool",
            tool: "bash",
            callID: "c1",
            state: { input: "", output: "" },
          } as unknown as {
            type: string;
            text?: string;
          },
        ]),
        msg("user", "u3", [textPart("bar")], sessionID, {
          input: 100000,
          output: 200,
        }),
      ];

      contextPruningTransformHandler(messages, {
        enabled: true,
        dedup: { enabled: false },
        purgeErrors: { enabled: false },
      });

      // u1 (user, non-ignored, text part) → has exactly one tag.
      const u1Text = (messages[0].parts?.[0] as { text?: string }).text;
      assert.ok(u1Text?.includes("m0001"), "u1 should have ref m0001");

      // a1 (assistant, non-ignored, text part) → has a tag.
      const a1Text = (messages[1].parts?.[0] as { text?: string }).text;
      assert.ok(a1Text?.includes("m0002"), "a1 should have ref m0002");

      // u2 (user, ignored) → no tag, text unchanged.
      const u2Text = (messages[2].parts?.[0] as { text?: string }).text;
      assert.equal(u2Text, "ignored-msg");

      // a2 (assistant, tool only) → tool output carries the tag.
      const a2Part0 = messages[3].parts?.[0] as unknown as Record<
        string,
        unknown
      >;
      const a2State = a2Part0.state as Record<string, unknown>;
      assert.ok(
        (a2State.output as string).includes("m0003"),
        "a2 tool output should have ref m0003",
      );

      // u3 (user, non-ignored, text part) → has a tag.
      const u3Text = (messages[4].parts?.[0] as { text?: string }).text;
      // a2 gets m0003 (assigned, injected into tool output),
      // so u3 gets m0004.
      assert.ok(u3Text?.includes("m0004"), "u3 should have ref m0004");

      // Exactly 4 tag-bearing messages (u1, a1, a2 via tool output, u3).
      const allText = JSON.stringify(messages);
      const tagMatches = allText.match(/<zoo-msg-id>m\d{4}<\/zoo-msg-id>/g);
      assert.equal(tagMatches?.length ?? 0, 4);
    });

    it("(b) two handler runs over equivalent fresh input produce byte-identical output", () => {
      const sessionID = "sess-refs-det";
      const baseInput: ContextMessageEntry[] = [
        msg("user", "u1", [textPart("Hello")], sessionID),
        msg("assistant", "a1", [textPart("World")]),
      ];

      // Round 1 — fresh copy.
      const input1: ContextMessageEntry[] = JSON.parse(
        JSON.stringify(baseInput),
      );
      contextPruningTransformHandler(input1, {
        enabled: true,
        dedup: { enabled: false },
        purgeErrors: { enabled: false },
      });
      const snapshot1 = JSON.stringify(input1);

      // Round 2 — fresh copy of the same base.
      const input2: ContextMessageEntry[] = JSON.parse(
        JSON.stringify(baseInput),
      );
      contextPruningTransformHandler(input2, {
        enabled: true,
        dedup: { enabled: false },
        purgeErrors: { enabled: false },
      });
      const snapshot2 = JSON.stringify(input2);

      assert.equal(snapshot1, snapshot2);
    });

    it("(c) boundary change causes refs to renumber from m0001 with no duplicates", () => {
      const sessionID = "sess-refs-boundary";

      // Turn N: messages start with a summary boundary (boundary_1).
      // The summary message is marked ignored (system-injected bookkeeping)
      // so it does not consume a ref.
      const turn1: ContextMessageEntry[] = [
        {
          info: {
            role: "assistant",
            id: "boundary_1",
            sessionID,
            summary: true,
            ignored: true,
          } as unknown as ContextMessageEntry["info"],
          parts: [{ type: "text", text: "compaction summary" }],
        },
        msg("user", "u1", [textPart("hello")], sessionID),
        msg("assistant", "a1", [textPart("response")]),
      ];

      contextPruningTransformHandler(turn1, {
        enabled: true,
        dedup: { enabled: false },
        purgeErrors: { enabled: false },
      });

      // u1 → m0001, a1 → m0002 (boundary summary skipped)
      assert.ok(
        (turn1[1].parts?.[0] as { text?: string }).text?.includes("m0001"),
        "u1 should have m0001",
      );
      assert.ok(
        (turn1[2].parts?.[0] as { text?: string }).text?.includes("m0002"),
        "a1 should have m0002",
      );

      // Turn N+1: boundary changes to boundary_2 — refs must renumber.
      const turn2: ContextMessageEntry[] = [
        {
          info: {
            role: "assistant",
            id: "boundary_2",
            sessionID,
            summary: true,
            ignored: true,
          } as unknown as ContextMessageEntry["info"],
          parts: [{ type: "text", text: "new compaction summary" }],
        },
        msg("user", "u2", [textPart("again")], sessionID),
        msg("assistant", "a2", [textPart("ok")]),
      ];

      contextPruningTransformHandler(turn2, {
        enabled: true,
        dedup: { enabled: false },
        purgeErrors: { enabled: false },
      });

      // Refs renumbered: u2 → m0001, a2 → m0002 (NOT m0003/m0004).
      const u2Text = (turn2[1].parts?.[0] as { text?: string }).text;
      const a2Text = (turn2[2].parts?.[0] as { text?: string }).text;
      assert.ok(u2Text?.includes("m0001"), "u2 should have m0001 after reset");
      assert.ok(a2Text?.includes("m0002"), "a2 should have m0002 after reset");

      // Verify distinct refs (no duplicates).
      const refsU2 = u2Text?.match(/m\d{4}/)?.[0];
      const refsA2 = a2Text?.match(/m\d{4}/)?.[0];
      assert.notEqual(refsU2, refsA2, "u2 and a2 must have different refs");
    });
  });

  // -------------------------------------------------------------------------
  // Phase 1: Compression block folding integration
  // -------------------------------------------------------------------------

  describe("Phase 1 compression block folding", () => {
    it("folded synthetic summary receives an mNNNN ref from Phase 4", () => {
      const sessionID = "sess-fold-integration";
      const state = getOrCreateSessionState(sessionID);

      // Block covers u1..u2, anchor = u2 (so u1 is covered but NOT anchor).
      // First user (u1) is force-kept by fold; summary injected at u2.
      createBlock(state, {
        anchorMessageId: "u2",
        messageIds: ["u1", "a1", "u2"],
        summary: "test summary.",
        compressedTokens: 1500,
        summaryTokens: 80,
      });

      const messages = [
        msg("user", "u1", [textPart("hello")], sessionID),
        msg("assistant", "a1", [toolPart("call-1", "data")]),
        msg("user", "u2", [textPart("again")], sessionID),
        msg("assistant", "a2", [toolPart("call-2", "done")]),
      ];

      contextPruningTransformHandler(messages, {
        enabled: true,
        dedup: { enabled: false },
        purgeErrors: { enabled: false },
      });

      // After folding: u1 (force-kept) → m0001, summary(b1) → m0002,
      // a2 → m0003.  a1 and u2 are folded away and get NO ref.
      const u1Text = (messages[0].parts?.[0] as { text?: string }).text;
      assert.ok(u1Text?.includes("m0001"), "u1 should have ref m0001");

      const synthText = (messages[1].parts?.[0] as { text?: string }).text;
      assert.ok(synthText?.includes("m0002"), "summary should have ref m0002");

      const a2Part0 = messages[2].parts?.[0] as unknown as Record<
        string,
        unknown
      >;
      const a2State = a2Part0.state as Record<string, unknown>;
      assert.ok(
        (a2State.output as string).includes("m0003"),
        "a2 should have ref m0003",
      );

      // Only 3 tag-bearing messages (u1, summary, a2).
      const allText = JSON.stringify(messages);
      const tagMatches = allText.match(/<zoo-msg-id>m\d{4}<\/zoo-msg-id>/g);
      assert.equal(tagMatches?.length ?? 0, 3);
    });

    it("full lifecycle: create → fold → deactivate → restore", () => {
      const sessionID = "sess-lifecycle";
      const state = getOrCreateSessionState(sessionID);

      // ── Phase 1: Turn N — no blocks ──────────────────────────────
      const messages = [
        msg("user", "u1", [textPart("hello")], sessionID),
        msg("assistant", "a1", [toolPart("call-1", "data")]),
        msg("user", "u2", [textPart("again")], sessionID),
        msg("assistant", "a2", [toolPart("call-2", "done")]),
      ];

      contextPruningTransformHandler(messages, {
        enabled: true,
        dedup: { enabled: false },
        purgeErrors: { enabled: false },
      });

      // No blocks — no folding; messages keep their structure.
      assert.equal(messages.length, 4, "no messages removed without blocks");
      assert.equal(messages[0].info.id, "u1");
      assert.equal(messages[1].info.id, "a1");
      assert.equal(messages[2].info.id, "u2");
      assert.equal(messages[3].info.id, "a2");
      // No synthetic message injected.
      for (const m of messages) {
        const marker = (m.info as unknown as Record<string, unknown>).synthetic;
        assert.equal(marker, undefined, "no synthetic message without blocks");
      }
      // Block state is empty.
      assert.equal(state.blocks.size, 0);

      // ── Phase 2: Turn N+1 — create block, run handler ──────────
      createBlock(state, {
        anchorMessageId: "u2",
        messageIds: ["a1", "u2"],
        summary: "test summary.",
        compressedTokens: 1500,
        summaryTokens: 80,
      });

      const messages2 = [
        msg("user", "u1", [textPart("hello")], sessionID),
        msg("assistant", "a1", [toolPart("call-1", "data")]),
        msg("user", "u2", [textPart("again")], sessionID),
        msg("assistant", "a2", [toolPart("call-2", "done")]),
      ];

      contextPruningTransformHandler(messages2, {
        enabled: true,
        dedup: { enabled: false },
        purgeErrors: { enabled: false },
      });

      // After folding: u1 kept (force-kept), a1+u2 removed,
      // summary injected at u2's original position, a2 kept.
      // Result: [u1, summary(b1), a2]
      assert.equal(messages2.length, 3, "folded from 4 to 3 messages");
      assert.equal(messages2[0].info.id, "u1", "u1 preserved");

      // messages2[1] is the synthetic summary.
      assert.equal(
        (messages2[1].info as unknown as Record<string, unknown>).synthetic,
        true,
        "summary message has synthetic marker",
      );
      const summaryText =
        (messages2[1].parts?.[0] as { text?: string }).text ?? "";
      assert.ok(
        summaryText.startsWith("[压缩块 b1"),
        "summary starts with b1 prefix",
      );

      // messages2[2] is a2 (kept).
      assert.equal(messages2[2].info.id, "a2", "a2 preserved");

      // Block remains active (anchor still in message list).
      const blocks = [...state.blocks.values()];
      assert.equal(blocks.length, 1);
      assert.equal(blocks[0].active, true, "block still active");

      // ── Phase 3: Turn N+2 — anchor physically deleted ──────────
      // Simulate built-in compaction removing the anchor message u2.
      const messages3 = [
        msg("user", "u1", [textPart("hello")], sessionID),
        // a1 was covered by the block — should reappear after deactivation.
        msg("assistant", "a1", [toolPart("call-1", "data")]),
        // u2 is GONE (compacted away)
        msg("assistant", "a2", [toolPart("call-2", "done")]),
      ];

      contextPruningTransformHandler(messages3, {
        enabled: true,
        dedup: { enabled: false },
        purgeErrors: { enabled: false },
      });

      // Block was deactivated (anchor u2 not in messages3).
      assert.equal(
        blocks[0].active,
        false,
        "block deactivated after anchor removal",
      );

      // No folding occurs (inactive blocks are skipped).
      // a1 reappears (was covered by now-inactive block).
      // Result: [u1, a1, a2] (3 messages, same as input).
      assert.equal(messages3.length, 3, "still 3 messages after deactivation");
      assert.equal(messages3[0].info.id, "u1", "u1 preserved");
      assert.equal(
        messages3[1].info.id,
        "a1",
        "a1 reappears (no longer folded)",
      );
      assert.equal(messages3[2].info.id, "a2", "a2 preserved");

      // a1's content is intact (ref appended by Phase 3).
      const a1Part = messages3[1].parts?.[0] as SweepToolPart;
      assert.ok(
        (a1Part.state?.output as string)?.startsWith("data"),
        "a1 content preserved",
      );

      // No synthetic message present.
      for (const m of messages3) {
        const marker = (m.info as unknown as Record<string, unknown>).synthetic;
        assert.equal(
          marker,
          undefined,
          "no synthetic message after deactivation",
        );
      }
    });
  });

  // ===========================================================================
  // Forced flush (pendingViewChange flag) integration tests
  // ===========================================================================

  describe("forced flush (pendingViewChange flag)", () => {
    const FORCED_SESSION_IDS = [
      "sess-forced-compress",
      "sess-forced-batched",
      "sess-forced-deactivate",
      "sess-forced-clear",
      "sess-forced-zerotokens",
    ];
    TEST_SESSION_IDS.push(...FORCED_SESSION_IDS);

    it("(a) below-threshold pending marks + pendingViewChange=true → flushes with forced reason", () => {
      const sessionID = "sess-forced-compress";
      const state = getOrCreateSessionState(sessionID);

      // Pre-populate pending marks below typical threshold.
      // Each mark ~100 tokens, total ~300.
      const LONG_OUTPUT = "x".repeat(500);
      addMark(state, "call-pending-1", 100, false, "tool-output");
      addMark(state, "call-pending-2", 200, false, "tool-output");

      // Simulate compress command: set the view-change flag.
      state.pendingViewChange = true;

      const messages = [
        msg("user", "u1", [textPart("do it")], sessionID),
        msg(
          "assistant",
          "a1",
          [
            toolPart("call-pending-1", LONG_OUTPUT, { cmd: "echo hi" }),
            toolPart("call-pending-2", LONG_OUTPUT, { cmd: "echo hi" }),
          ],
          undefined,
          { input: 100000, output: 200 },
        ),
      ];

      contextPruningTransformHandler(messages, {
        enabled: true,
        protectedMessages: 0,
        releasedPercent: 5, // 5% of 100000 = 5000 threshold
        dedup: { enabled: true, thresholdContext: 0 },
        purgeErrors: {},
      });

      // Marks should be released despite being below threshold.
      assert.equal(
        pendingCount(state),
        0,
        "all pending marks released by forced flush",
      );
      assert.equal(reclaimedTokens(state), 300, "all pending tokens reclaimed");

      // Flag cleared.
      assert.equal(
        state.pendingViewChange,
        false,
        "flag cleared at end of phase",
      );

      // Log event should carry forced reason.
      const entries = _getBufferForTesting();
      const releaseLog = entries.find((e) => e.event === "marks_released") as
        | Record<string, unknown>
        | undefined;
      assert.ok(releaseLog, "expected marks_released log event");
      assert.equal(
        releaseLog.forced,
        "view_change",
        "log event carries forced reason",
      );
    });

    it("(b) below-threshold pending marks without view change → still batched (no forced field)", () => {
      const sessionID = "sess-forced-batched";
      const state = getOrCreateSessionState(sessionID);

      // Pre-populate pending marks below threshold (same as test a).
      addMark(state, "call-pending-1", 100, false, "tool-output");
      addMark(state, "call-pending-2", 200, false, "tool-output");

      // NO pendingViewChange flag — normal batching.

      const messages = [
        msg("user", "u1", [textPart("do it")], sessionID),
        msg(
          "assistant",
          "a1",
          [
            toolPart("call-pending-1", "output 1", { cmd: "echo hi" }),
            toolPart("call-pending-2", "output 2", { cmd: "echo hi" }),
          ],
          undefined,
          { input: 100000, output: 200 },
        ),
      ];

      contextPruningTransformHandler(messages, {
        enabled: true,
        protectedMessages: 0,
        releasedPercent: 5, // threshold = 5000, pending = 300, below
        dedup: { enabled: true, thresholdContext: 0 },
        purgeErrors: {},
      });

      // Marks stay pending.
      assert.ok(
        pendingCount(state) > 0,
        "pending marks remain pending below threshold",
      );
      assert.equal(
        reclaimedTokens(state),
        0,
        "no marks released below threshold",
      );

      // No marks_released event emitted (or if it is, no forced field).
      const entries = _getBufferForTesting();
      const releaseLog = entries.find((e) => e.event === "marks_released") as
        | Record<string, unknown>
        | undefined;
      if (releaseLog) {
        assert.equal(
          releaseLog.forced,
          undefined,
          "no forced field in normal batch log",
        );
      }

      // Flag remains false (was never set).
      assert.equal(state.pendingViewChange, false, "flag stays false");
    });

    it("(c) block deactivation turn flushes pending marks with forced reason", () => {
      const sessionID = "sess-forced-deactivate";
      const state = getOrCreateSessionState(sessionID);

      // Create an active block whose anchor is NOT in the message list.
      createBlock(state, {
        anchorMessageId: "u2",
        messageIds: ["a1", "u2"],
        summary: "test summary.",
        compressedTokens: 1500,
        summaryTokens: 80,
      });
      assert.equal(
        activeBlockCount(state),
        1,
        "block is active before transform",
      );

      // Add pending marks below threshold.
      addMark(state, "call-pending-1", 150, false, "tool-output");

      // Messages WITHOUT the anchor u2 — will trigger deactivation.
      const messages = [
        msg("user", "u1", [textPart("hello")], sessionID),
        msg("assistant", "a1", [toolPart("call-pending-1", "data")]),
        // u2 is absent → anchor missing
        msg("assistant", "a2", [toolPart("call-2", "done")], undefined, {
          input: 100000,
          output: 200,
        }),
      ];

      contextPruningTransformHandler(messages, {
        enabled: true,
        protectedMessages: 0,
        releasedPercent: 5, // pending=150 far below 5000 threshold
        dedup: { enabled: true, thresholdContext: 0 },
        purgeErrors: {},
      });

      // Block should be deactivated.
      assert.equal(
        activeBlockCount(state),
        0,
        "block deactivated by missing anchor",
      );

      // Pending marks should be released (forced by deactivation).
      assert.equal(
        pendingCount(state),
        0,
        "pending marks flushed after deactivation",
      );
      assert.ok(
        reclaimedTokens(state) >= 150,
        "marks reclaimed after deactivation",
      );

      // Log event should carry forced reason.
      const entries = _getBufferForTesting();
      const releaseLog = entries.find((e) => e.event === "marks_released") as
        | Record<string, unknown>
        | undefined;
      assert.ok(releaseLog, "expected marks_released log event");
      assert.equal(
        releaseLog.forced,
        "view_change",
        "log event carries forced reason from deactivation",
      );

      // Flag cleared.
      assert.equal(state.pendingViewChange, false, "flag cleared");
    });

    it("(d) flag cleared after flush turn; subsequent turns batch normally", () => {
      const sessionID = "sess-forced-clear";
      const state = getOrCreateSessionState(sessionID);

      // ── Turn 1: forced flush ──────────────────────────────────
      state.pendingViewChange = true;
      addMark(state, "call-turn1", 100, false, "tool-output");

      const turn1 = [
        msg("user", "u1", [textPart("turn 1")], sessionID),
        msg(
          "assistant",
          "a1",
          [toolPart("call-turn1", "output 1", { cmd: "echo hi" })],
          undefined,
          { input: 100000, output: 200 },
        ),
      ];

      contextPruningTransformHandler(turn1, {
        enabled: true,
        protectedMessages: 0,
        releasedPercent: 5,
        dedup: { enabled: true, thresholdContext: 0 },
        purgeErrors: {},
      });

      // Turn 1: marks released (forced flush).
      assert.equal(pendingCount(state), 0, "turn 1: marks flushed");
      assert.equal(reclaimedTokens(state), 100, "turn 1: marks reclaimed");
      assert.equal(state.pendingViewChange, false, "turn 1: flag cleared");

      // ── Turn 2: no view change, add new pending marks ────────
      addMark(state, "call-turn2", 200, false, "tool-output");
      // Pending now 200, threshold 5000 — well below.

      const turn2 = [
        msg("user", "u2", [textPart("turn 2")], sessionID),
        msg(
          "assistant",
          "a2",
          [toolPart("call-turn2", "output 2", { cmd: "echo hi" })],
          undefined,
          { input: 100000, output: 200 },
        ),
      ];

      contextPruningTransformHandler(turn2, {
        enabled: true,
        protectedMessages: 0,
        releasedPercent: 5,
        dedup: { enabled: true, thresholdContext: 0 },
        purgeErrors: {},
      });

      // Turn 2: marks NOT released (normal batching).
      assert.ok(
        pendingCount(state) > 0,
        "turn 2: pending marks stay pending (normal batching)",
      );
      // reclaimedTokens from turn 1 (100) + still-pending turn 2 (0)
      assert.equal(
        reclaimedTokens(state),
        100,
        "turn 2: only turn 1 marks reclaimed so far",
      );

      // No forced field in any marks_released event for this turn.
      const entries = _getBufferForTesting();
      const releaseEvents = entries.filter((e) => e.event === "marks_released");
      // There should be exactly 1 marks_released event (from turn 1).
      assert.equal(
        releaseEvents.length,
        1,
        "only one marks_released event across both turns",
      );

      // Flag remains false.
      assert.equal(state.pendingViewChange, false, "flag stays false");
    });

    it("(e) pendingViewChange=true + promptTokens=0 flushes marks with forced reason", () => {
      const sessionID = "sess-forced-zerotokens";
      const state = getOrCreateSessionState(sessionID);

      // Pre-populate pending marks below typical threshold.
      addMark(state, "call-pending-1", 100, false, "tool-output");
      addMark(state, "call-pending-2", 200, false, "tool-output");

      // Simulate a view-change event (compress fold debut / block
      // deactivation) without a completed assistant message in the
      // current turn → promptTokens === 0.
      state.pendingViewChange = true;

      // No assistant message with output tokens → promptTokens = 0.
      // findLastCompletedAssistant skips the assistant text-only
      // message, so lastAsst.index < 0 and tokens is null.
      const messages = [
        msg("user", "u1", [textPart("do it")], sessionID),
        msg("assistant", "a1", [textPart("thinking...")]),
      ];

      // Verify pre-conditions before calling the handler.
      assert.equal(pendingCount(state), 2, "two pending marks before handler");
      assert.equal(state.pendingViewChange, true, "flag set before handler");

      contextPruningTransformHandler(messages, {
        enabled: true,
        protectedMessages: 0,
        releasedPercent: 5,
        dedup: { enabled: false },
        purgeErrors: {},
      });

      // Marks should be released despite promptTokens === 0.
      assert.equal(
        pendingCount(state),
        0,
        "all pending marks released by forced flush",
      );
      assert.equal(reclaimedTokens(state), 300, "all pending tokens reclaimed");

      // Flag cleared at end of phase.
      assert.equal(
        state.pendingViewChange,
        false,
        "flag cleared at end of phase",
      );

      // Log event should carry forced reason.
      const entries = _getBufferForTesting();
      const releaseLog = entries.find((e) => e.event === "marks_released") as
        | Record<string, unknown>
        | undefined;
      assert.ok(releaseLog, "expected marks_released log event");
      assert.equal(
        releaseLog.forced,
        "view_change",
        "log event carries forced reason",
      );
      // promptTokens field is logged as 0 — sensible even when zero.
      assert.equal(releaseLog.promptTokens, 0, "promptTokens is zero");
    });
  });
});
