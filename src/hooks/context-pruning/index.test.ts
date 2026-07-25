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
  deleteSessionState,
  getOrCreateSessionState,
  loadSessionState,
  PRUNED_TOOL_OUTPUT_REPLACEMENT,
} from "../../core/pruning/index.js";
import {
  _clearAllSessionsForTesting,
  addMark,
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
  "sess-enabled-false",
  "sess-gate-cache-read-at",
  "sess-gate-cache-read-below",
  "sess-gate-cache-read-write-at",
  "sess-log-mixed",
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
    addMark(state, "call-1", 100, true);
    addMark(state, "call-2", 200, true);

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
    assert.equal(state.marks.size, 2);
    // reclaimedTokens reflects the effective marks (100 + 200).
    assert.equal(reclaimedTokens(state), 300);
  });

  it("reuses existing state for repeat calls on same session", () => {
    const sessionID = "sess-repeat";
    const state = getOrCreateSessionState(sessionID);
    addMark(state, "call-1", 50, true);

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
    // reclaimedTokens reflects the effective mark.
    assert.equal(reclaimedTokens(state), 50);

    // Second call with same session but new marks.
    addMark(state, "call-2", 30, true);
    const moreMessages = [
      msg("user", "u2", [textPart("more")], sessionID),
      msg("assistant", "a2", [toolPart("call-2", "new data")]),
    ];

    contextPruningTransformHandler(moreMessages);

    assert.equal(
      (moreMessages[1].parts?.[0] as SweepToolPart).state?.output,
      PRUNED_TOOL_OUTPUT_REPLACEMENT,
    );
    // reclaimedTokens accumulates across marks.
    assert.equal(reclaimedTokens(state), 80);
  });

  it("persists state to disk after transform when dirty", () => {
    const sessionID = "sess-persist";
    const state = getOrCreateSessionState(sessionID);
    addMark(state, "call-1", 100, true);

    const messages = [
      msg("user", "u1", [textPart("hello")], sessionID),
      msg("assistant", "a1", [toolPart("call-1", "original output")]),
    ];

    contextPruningTransformHandler(messages);

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
    addMark(state, "call-sweep-1", 50, true);

    // Turn N messages: one pre-marked call + duplicate tool calls that
    // will be deduped.  The last assistant has tokens.input >= 100K to
    // pass the gate.  releaseThresholdPercent=0 ensures pending is always
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
      thresholdTokens: 100000,
      turnProtection: 0,
      releaseThresholdPercent: 0, // Always release pending immediately for test.
    });

    // Phase 1 (clean) — pre-existing marks ARE replaced.
    assert.equal(
      (messages[1].parts?.[0] as SweepToolPart).state?.output,
      PRUNED_TOOL_OUTPUT_REPLACEMENT,
    );

    // Phase 2 (mark) — dedup ran; older duplicate is marked.
    // With releaseThresholdPercent=0, releaseBatch fires immediately, flipping
    // the dedup mark to effective=true (pendingCount becomes 0).
    assert.ok(state.marks.size > 0);

    // But the newly-marked outputs are NOT yet replaced in this turn.
    assert.equal(
      (messages[1].parts?.[2] as SweepToolPart).state?.output,
      LONG_OUTPUT,
    );
    assert.equal(
      (messages[1].parts?.[3] as SweepToolPart).state?.output,
      LONG_OUTPUT,
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
      thresholdTokens: 100000,
      releaseThresholdPercent: 0,
    });

    // The older duplicate (call-dedup-1) is now pruned.
    const parts2 = messages2[1].parts ?? [];
    assert.equal(
      (parts2[0] as SweepToolPart).state?.output,
      PRUNED_TOOL_OUTPUT_REPLACEMENT,
    );
    // The newer duplicate (call-dedup-2) is not marked — it's the keeper.
    assert.equal((parts2[1] as SweepToolPart).state?.output, LONG_OUTPUT);
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
      thresholdTokens: 100000,
    });

    // Gate closed — no dedup marks created.
    assert.equal(state.marks.size, 0);
    // Outputs untouched.
    assert.equal(
      (messages[1].parts?.[0] as SweepToolPart).state?.output,
      LONG_OUTPUT,
    );
    assert.equal(
      (messages[1].parts?.[1] as SweepToolPart).state?.output,
      LONG_OUTPUT,
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
      thresholdTokens: 100000,
      turnProtection: 0,
    });

    // Gate open — dedup runs, older duplicate marked (non-effective).
    assert.ok(pendingCount(state) > 0);
    // Outputs NOT replaced (marks fresh for next turn).
    assert.equal(
      (messages[1].parts?.[0] as SweepToolPart).state?.output,
      LONG_OUTPUT,
    );
    assert.equal(
      (messages[1].parts?.[1] as SweepToolPart).state?.output,
      LONG_OUTPUT,
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
      thresholdTokens: 100000,
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
      thresholdTokens: 100000,
      turnProtection: 0,
    });

    // Gate open — total = 500 + 99500 = 100000 >= threshold.
    assert.ok(pendingCount(state) > 0);
    assert.equal(
      (messages[1].parts?.[0] as SweepToolPart).state?.output,
      LONG_OUTPUT,
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
      thresholdTokens: 100000,
    });

    // Gate closed — total = 500 + 99499 = 99999 < threshold.
    assert.equal(state.marks.size, 0);
    assert.equal(
      (messages[1].parts?.[0] as SweepToolPart).state?.output,
      LONG_OUTPUT,
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
      thresholdTokens: 100000,
      turnProtection: 0,
    });

    // Gate open — total = 50000 + 40000 + 10000 = 100000 >= threshold.
    assert.ok(pendingCount(state) > 0);
    assert.equal(
      (messages[1].parts?.[0] as SweepToolPart).state?.output,
      LONG_OUTPUT,
    );
  });

  it("gate: enabled=false skips dedup but prune still runs", () => {
    const sessionID = "sess-enabled-false";
    const state = getOrCreateSessionState(sessionID);

    // Pre-populate a mark to verify prune still runs.
    addMark(state, "call-sweep-1", 50, true);

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
      enabled: false,
      thresholdTokens: 100000,
    });

    // Prune still runs — pre-existing mark replaced.
    assert.equal(
      (messages[1].parts?.[0] as SweepToolPart).state?.output,
      PRUNED_TOOL_OUTPUT_REPLACEMENT,
    );

    // Dedup skipped — no new marks.
    assert.equal(state.marks.size, 1); // Only the pre-existing sweep mark.
  });

  // ===========================================================================
  // parseContextConfig defaults
  // ===========================================================================

  it("parseContextConfig returns defaults when [zoo.context] is absent", () => {
    const config = parseContextConfig({});
    assert.equal(config.enabled, true);
    assert.equal(config.thresholdTokens, 100000);
    assert.equal(config.turnProtection, 5);
    assert.deepEqual(config.protectedTools, ["question"]);
  });

  it("parseContextConfig reads [zoo.context] section with two-layer structure", () => {
    const config = parseContextConfig({
      context: {
        turn_protection: 3,
        dedup: {
          enabled: false,
          threshold_tokens: 64000,
          protected_tools: ["task", "read"],
        },
      },
    });
    assert.equal(config.enabled, false);
    assert.equal(config.thresholdTokens, 64000);
    assert.equal(config.turnProtection, 3);
    assert.deepEqual(config.protectedTools, ["task", "read"]);
  });

  it("parseContextConfig falls back to defaults for non-boolean enabled", () => {
    const config = parseContextConfig({
      context: { dedup: { enabled: "false" } },
    });
    // "false" is not boolean -> fallback to true.
    assert.equal(config.enabled, true);
  });

  it("parseContextConfig falls back to defaults for non-finite threshold_tokens", () => {
    const config = parseContextConfig({
      context: { dedup: { threshold_tokens: Infinity } },
    });
    assert.equal(config.thresholdTokens, 100000);

    const config2 = parseContextConfig({
      context: { dedup: { threshold_tokens: NaN } },
    });
    assert.equal(config2.thresholdTokens, 100000);

    const config3 = parseContextConfig({
      context: { dedup: { threshold_tokens: "100000" } },
    });
    assert.equal(config3.thresholdTokens, 100000);
  });

  it("parseContextConfig falls back to defaults for non-finite turn_protection", () => {
    const config = parseContextConfig({
      context: { turn_protection: NaN },
    });
    assert.equal(config.turnProtection, 5);

    const config2 = parseContextConfig({
      context: { turn_protection: Infinity },
    });
    assert.equal(config2.turnProtection, 5);

    const config3 = parseContextConfig({
      context: { turn_protection: "3" },
    });
    assert.equal(config3.turnProtection, 5);
  });

  it("parseContextConfig falls back to defaults for non-string-array protected_tools", () => {
    const config = parseContextConfig({
      context: { dedup: { protected_tools: "task" } },
    });
    assert.deepEqual(config.protectedTools, ["question"]);

    const config2 = parseContextConfig({
      context: { dedup: { protected_tools: [123, "read"] } },
    });
    assert.deepEqual(config2.protectedTools, ["question"]);

    const config3 = parseContextConfig({
      context: { dedup: { protected_tools: [] } },
    });
    assert.deepEqual(config3.protectedTools, []);
  });

  it("parseContextConfig preserves valid zero and negative values", () => {
    const config = parseContextConfig({
      context: {
        turn_protection: 0,
        dedup: {
          enabled: false,
          threshold_tokens: 0,
          protected_tools: [],
        },
      },
    });
    assert.equal(config.enabled, false);
    assert.equal(config.thresholdTokens, 0);
    assert.equal(config.turnProtection, 0);
    assert.deepEqual(config.protectedTools, []);
  });

  // ===========================================================================
  // parseContextConfig — releaseThresholdPercent
  // ===========================================================================

  it("parseContextConfig reads release_threshold_percent from config", () => {
    const config = parseContextConfig({
      context: { dedup: { release_threshold_percent: 10 } },
    });
    assert.equal(config.releaseThresholdPercent, 10);
  });

  it("parseContextConfig defaults releaseThresholdPercent to 5 for non-number types", () => {
    const config = parseContextConfig({
      context: { dedup: { release_threshold_percent: "10" } },
    });
    assert.equal(config.releaseThresholdPercent, 5);
  });

  it("parseContextConfig defaults releaseThresholdPercent to 5 for Infinity/NaN", () => {
    const config1 = parseContextConfig({
      context: { dedup: { release_threshold_percent: Infinity } },
    });
    assert.equal(config1.releaseThresholdPercent, 5);

    const config2 = parseContextConfig({
      context: { dedup: { release_threshold_percent: NaN } },
    });
    assert.equal(config2.releaseThresholdPercent, 5);
  });

  it("parseContextConfig accepts 0 as valid releaseThresholdPercent (no batching)", () => {
    const config = parseContextConfig({
      context: { dedup: { release_threshold_percent: 0 } },
    });
    assert.equal(config.releaseThresholdPercent, 0);
  });

  it("parseContextConfig defaults releaseThresholdPercent to 5 for negative values", () => {
    const config = parseContextConfig({
      context: { dedup: { release_threshold_percent: -1 } },
    });
    assert.equal(config.releaseThresholdPercent, 5);
  });

  it("parseContextConfig defaults releaseThresholdPercent to 5 when absent", () => {
    const config = parseContextConfig({});
    assert.equal(config.releaseThresholdPercent, 5);
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
    // releaseThresholdPercent=5 -> threshold=5000. 125 < 5000 -> no release.
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
      thresholdTokens: 100000,
      turnProtection: 0,
      releaseThresholdPercent: 5,
    });

    // Dedup ran -> mark is pending (non-effective).
    assert.ok(pendingCount(state) > 0);
    // No effective marks yet (not released).
    assert.equal(reclaimedTokens(state), 0);
    // Outputs not replaced.
    assert.equal(
      (messages[1].parts?.[0] as SweepToolPart).state?.output,
      LONG_OUTPUT,
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
      thresholdTokens: 100000,
      turnProtection: 0,
      releaseThresholdPercent: 5,
    });

    // Still not effective (pending tokens still below threshold,
    // no new marks added so pending hasn't grown).
    assert.equal(reclaimedTokens(state), 0, "marks still pending");
  });

  it("batch: marks released when pending reaches threshold, pruned next turn", () => {
    const sessionID = "sess-batch-at";
    const state = getOrCreateSessionState(sessionID);

    // Use a very low releaseThresholdPercent to trigger immediate release.
    // promptTokens=100000, releaseThresholdPercent=0.001 -> threshold=1
    // Any positive pending tokens will trigger release.
    const lotOfOutput = "x".repeat(2000); // ~500 tokens

    // Turn N: 20 duplicate calls so pending sum is large.
    // Actually simpler: set releaseThresholdPercent=0 so 0 >= threshold always.
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

    // With releaseThresholdPercent=0, any positive pending triggers immediate release.
    contextPruningTransformHandler(messages, {
      enabled: true,
      thresholdTokens: 100000,
      turnProtection: 0,
      releaseThresholdPercent: 0,
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

    // But this turn's outputs are NOT replaced yet (Phase 1 ran before release).
    assert.equal(
      (messages[1].parts?.[0] as SweepToolPart).state?.output,
      lotOfOutput,
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
      thresholdTokens: 100000,
      turnProtection: 0,
      releaseThresholdPercent: 0,
    });

    const parts2 = messages2[1].parts ?? [];
    // call-1 (older duplicate) should now be pruned.
    assert.equal(
      (parts2[0] as SweepToolPart).state?.output,
      PRUNED_TOOL_OUTPUT_REPLACEMENT,
    );
    // call-2 (keeper) unchanged.
    assert.equal((parts2[1] as SweepToolPart).state?.output, lotOfOutput);
  });

  it("batch: accumulation across multiple turns before release", () => {
    const sessionID = "sess-batch-accumulate";
    const state = getOrCreateSessionState(sessionID);

    // Each mark ~104 tokens (LONG_OUTPUT=500 chars ~125 tokens,
    // placeholder ~21 tokens, diff=104). With promptTokens=100000,
    // releaseThresholdPercent=0.8, threshold=800. Need ~8 marks to trigger.
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
      thresholdTokens: 100000,
      turnProtection: 0,
      releaseThresholdPercent: 0.8,
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
      thresholdTokens: 100000,
      turnProtection: 0,
      releaseThresholdPercent: 0.8,
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
      thresholdTokens: 100000,
      turnProtection: 0,
      releaseThresholdPercent: 0.8,
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
    addMark(state, "call-sweep", 200, true);

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
      thresholdTokens: 100000,
      turnProtection: 0,
      releaseThresholdPercent: 5, // Normal threshold
    });

    // Sweep mark is in tools and should be pruned.
    assert.equal(
      (messages[1].parts?.[0] as SweepToolPart).state?.output,
      PRUNED_TOOL_OUTPUT_REPLACEMENT,
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
        thresholdTokens: 100000,
        turnProtection: 0,
        releaseThresholdPercent: 0,
      },
      notify,
    );

    // Dedup ran → pending released → notify called once.
    assert.equal(notifyCalls.length, 1);
    // Text contains count and token info.
    const text = notifyCalls[0];
    assert.ok(text.includes("去重"), "should contain dedup keyword");
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
      thresholdTokens: 100000,
      turnProtection: 0,
      releaseThresholdPercent: 0,
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
        thresholdTokens: 100000,
        turnProtection: 0,
        releaseThresholdPercent: 0,
      },
      notify,
    );

    // No duplicates → no marks → no release → no notify.
    assert.equal(notifyCalls.length, 0);
    assert.equal(state.marks.size, 0);
  });

  it("notify: not called when pending tokens below batch threshold", () => {
    const sessionID = "sess-batch-notify-below";

    // With releaseThresholdPercent=5 and promptTokens=100000, threshold is 5000.
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
        thresholdTokens: 100000,
        turnProtection: 0,
        releaseThresholdPercent: 5,
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
    // Regression: Phase 4 log must report effective-only counts, not
    // total marks (which would inflate both prunedToolCount and
    // totalReclaimedTokens with pending marks not yet applied).
    const sessionID = "sess-log-mixed";
    const state = getOrCreateSessionState(sessionID);

    // 2 effective marks (already released).
    addMark(state, "call-eff-1", 200, true);
    addMark(state, "call-eff-2", 300, true);
    // 1 pending mark (not yet released).
    addMark(state, "call-pending-1", 500, false);

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

    contextPruningTransformHandler(messages);

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

    // totalPruneTokens is a compatibility alias — same value.
    assert.equal(
      pruneCompleted.totalPruneTokens,
      500,
      "totalPruneTokens should also equal effective-only tokens",
    );
  });
});
