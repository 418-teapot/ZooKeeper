/**
 * Tests for the lens-based purge-errors producer (`producers/purge-errors.ts`).
 *
 * Two layers:
 * 1. **Purge semantics** — the lens producer's decisions over
 *    `HostMessage` transcripts are pinned literally: marks every
 *    error-status call's input region (across messages and within one
 *    message), skips non-error statuses, absent statuses, text-only
 *    messages, protected tools, zero-benefit inputs, and already-marked
 *    calls (idempotent re-runs), and honours the message-count
 *    protection window.
 * 2. **Lens-specific semantics** — self-gating defaults (minMessages=20,
 *    thresholdContext=0.5), the protected-window fail-safe, the folded/
 *    pruned ordinal predicate, the call-level idempotency across both
 *    region keys, and the canon-invariance linkage (acceptance:
 *    replacing an error input with the placeholder never changes
 *    `canon`).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { canon } from "../canon.js";
import type { HostMessage } from "../lens.js";
import { regionsOfKind } from "../lens.js";
import { makeAssistantMsg, makeMsg, makeToolMsg } from "../lens-testkit.js";
import {
  estimateTokenCount,
  measureMessages,
  netReclaimTokens,
} from "../measure.js";
import { PRUNED_TOOL_ERROR_INPUT_REPLACEMENT } from "../message-parts.js";
import { markKey, type SessionState } from "../state.js";
import {
  type PurgeErrorsProducerOptions,
  runPurgeErrors,
} from "./purge-errors.js";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

/** Input long enough to reclaim tokens against the error-input placeholder. */
const LONG_INPUT = "very long command ".repeat(50);

/** Input too short to reclaim tokens against the error-input placeholder. */
const SHORT_INPUT = "ls";

/** Output long enough to reclaim tokens against the output placeholder. */
const LONG_OUTPUT = "detailed error trace ".repeat(20);

/** Output too short to reclaim tokens against the output placeholder. */
const SHORT_OUTPUT = "err";

/** Model limit used to open the context-fraction gate. */
const MODEL_LIMIT = 1_000_000;

/**
 * Net reclaim of one LONG_INPUT mark: ceil(900/4) = 225 tokens minus the
 * error-input placeholder estimate of 18 tokens.
 */
const INPUT_MARK_TOKENS = 207;

/** One tool call in a fixture message. */
interface CallSpec {
  tool: string;
  input: string;
  output: string;
  status?: string;
}

/** An error-status call with the given fields. */
function errCall(
  tool = "bash",
  input = LONG_INPUT,
  output = LONG_OUTPUT,
  status = "error",
): CallSpec {
  return { tool, input, output, status };
}

/** Build the lens assistant message for the given calls. */
function lensMsg(calls: CallSpec[]): HostMessage {
  return makeAssistantMsg({
    toolCalls: calls.map((call) => ({
      name: call.tool,
      input: call.input,
      output: call.output,
      status: call.status,
    })),
  });
}

/** A fresh empty lens session state. */
function makeNewState(): SessionState {
  return { blocks: new Map(), marks: new Map() };
}

/**
 * Purge-errors options with both gates open over the given transcript
 * (empty protection window, no protected tools).
 */
function purgeOptions(
  messages: HostMessage[],
  overrides: Partial<PurgeErrorsProducerOptions> = {},
): PurgeErrorsProducerOptions {
  return {
    minMessages: 0,
    contextLimit: MODEL_LIMIT,
    thresholdContext: 0,
    protectedStartOrdinal: messages.length,
    ...overrides,
  };
}

/**
 * Run purge-errors with the common open options over a fresh state and
 * return the created mark keys (sorted) and the reported reclaim tokens.
 */
function runOpen(
  messages: HostMessage[],
  overrides: Partial<PurgeErrorsProducerOptions> = {},
): { keys: string[]; tokens: number } {
  const state = makeNewState();
  const result = runPurgeErrors(
    state,
    messages,
    purgeOptions(messages, overrides),
  );
  return { keys: [...state.marks.keys()].sort(), tokens: result.tokens };
}

// ===========================================================================
// Purge semantics
// ===========================================================================

describe("purge semantics", () => {
  it("marks an error-status call's input region and returns pending marks", () => {
    const lens = [lensMsg([errCall()])];
    const state = makeNewState();
    const result = runPurgeErrors(state, lens, purgeOptions(lens));
    assert.equal(result.created, 1);
    assert.equal(result.tokens, INPUT_MARK_TOKENS);
    const mark = state.marks.get(markKey(0, 0));
    assert.ok(mark);
    assert.equal(mark.effective, false, "mark must be pending");
    assert.equal(mark.anchorOrdinal, 0);
    assert.equal(mark.regionIndex, 0);
    assert.equal(mark.content, LONG_INPUT);
    assert.equal(mark.contentTokens, INPUT_MARK_TOKENS);
    assert.equal(state.marks.has(markKey(0, 1)), false, "never output-region");
  });

  it("marks multiple error calls across different messages", () => {
    const lens = [lensMsg([errCall()]), lensMsg([errCall("read")])];
    const { keys, tokens } = runOpen(lens);
    assert.deepEqual(keys, [markKey(0, 0), markKey(1, 0)]);
    assert.equal(tokens, 2 * INPUT_MARK_TOKENS);
  });

  it("marks multiple error calls within a single message", () => {
    const lens = [lensMsg([errCall(), errCall("read")])];
    const { keys, tokens } = runOpen(lens);
    assert.deepEqual(keys, [markKey(0, 0), markKey(0, 2)]);
    assert.equal(tokens, 2 * INPUT_MARK_TOKENS);
  });

  it("skips calls already marked (re-runs are idempotent)", () => {
    const lens = [lensMsg([errCall()])];
    const state = makeNewState();
    assert.equal(runPurgeErrors(state, lens, purgeOptions(lens)).created, 1);
    const second = runPurgeErrors(state, lens, purgeOptions(lens));
    assert.equal(second.created, 0);
    assert.equal(second.tokens, 0);
    assert.equal(state.marks.size, 1);
  });

  it("honours the message-count protection window", () => {
    // Protected ordinals [2, 4) are excluded from the scan entirely.
    // Each input "call-a".repeat(20) = 120 chars → ceil(120/4) = 30
    // tokens, net 30 − 18 (placeholder) = 12 per mark.
    const lens = [
      lensMsg([errCall("bash", "call-a".repeat(20), "out-a")]),
      lensMsg([errCall("bash", "call-b".repeat(20), "out-b")]),
      lensMsg([errCall("bash", "call-c".repeat(20), "out-c")]),
      lensMsg([errCall("bash", "call-d".repeat(20), "out-d")]),
    ];
    const { keys, tokens } = runOpen(lens, { protectedStartOrdinal: 2 });
    assert.deepEqual(keys, [markKey(0, 0), markKey(1, 0)]);
    assert.equal(tokens, 24);
  });

  it("protects all messages when the window covers the whole transcript", () => {
    const lens = [lensMsg([errCall()]), lensMsg([errCall()])];
    assert.deepEqual(runOpen(lens, { protectedStartOrdinal: 0 }), {
      keys: [],
      tokens: 0,
    });
  });

  it("an empty protection window disables the protection", () => {
    const lens = [lensMsg([errCall()]), lensMsg([errCall()])];
    const { keys, tokens } = runOpen(lens, { protectedStartOrdinal: 2 });
    assert.deepEqual(keys, [markKey(0, 0), markKey(1, 0)]);
    assert.equal(tokens, 2 * INPUT_MARK_TOKENS);
  });

  it("skips tools in the protectedTools list", () => {
    const lens = [lensMsg([errCall("question")])];
    assert.deepEqual(runOpen(lens, { protectedTools: ["question"] }), {
      keys: [],
      tokens: 0,
    });
  });

  it("marks tools not in the protectedTools list", () => {
    const lens = [lensMsg([errCall("read")])];
    const result = runOpen(lens, { protectedTools: ["bash"] });
    assert.deepEqual(result.keys, [markKey(0, 0)]);
    assert.equal(result.tokens, INPUT_MARK_TOKENS);
  });

  it("skips zero-benefit calls when the input is shorter than the placeholder", () => {
    const short = [lensMsg([errCall("bash", SHORT_INPUT, LONG_OUTPUT)])];
    assert.deepEqual(runOpen(short), { keys: [], tokens: 0 });
    const empty = [lensMsg([errCall("bash", "", LONG_OUTPUT)])];
    assert.deepEqual(runOpen(empty), { keys: [], tokens: 0 });
  });

  it("marks when the input exceeds the placeholder", () => {
    const lens = [lensMsg([errCall()])];
    const result = runOpen(lens);
    assert.deepEqual(result.keys, [markKey(0, 0)]);
    assert.equal(result.tokens, INPUT_MARK_TOKENS);
  });

  it("ignores completed-status calls", () => {
    const lens = [
      lensMsg([errCall("bash", LONG_INPUT, LONG_OUTPUT, "completed")]),
    ];
    assert.deepEqual(runOpen(lens), { keys: [], tokens: 0 });
  });

  it("ignores running-status calls", () => {
    const lens = [
      lensMsg([errCall("bash", LONG_INPUT, LONG_OUTPUT, "running")]),
    ];
    assert.deepEqual(runOpen(lens), { keys: [], tokens: 0 });
  });

  it("ignores pending-status calls", () => {
    const lens = [
      lensMsg([errCall("bash", LONG_INPUT, LONG_OUTPUT, "pending")]),
    ];
    assert.deepEqual(runOpen(lens), { keys: [], tokens: 0 });
  });

  it("ignores calls without a status field", () => {
    // No status property at all (the `errCall` default would inject one).
    const lens = [
      lensMsg([{ tool: "bash", input: LONG_INPUT, output: LONG_OUTPUT }]),
    ];
    assert.deepEqual(runOpen(lens), { keys: [], tokens: 0 });
  });

  it("ignores text-only messages and non-tool content", () => {
    const lens = [makeMsg("assistant", ["hello"]), lensMsg([errCall()])];
    const result = runOpen(lens);
    assert.deepEqual(result.keys, [markKey(1, 0)]);
    assert.equal(result.tokens, INPUT_MARK_TOKENS);
  });
});

// ===========================================================================
// Lens-specific gating semantics
// ===========================================================================

describe("lens-specific gating semantics", () => {
  it("fail-safe: undefined protectedStartOrdinal skips with zero side effects", () => {
    const state = makeNewState();
    const lens = [lensMsg([errCall()])];
    const result = runPurgeErrors(state, lens, {
      minMessages: 0,
      contextLimit: MODEL_LIMIT,
      thresholdContext: 0,
    });
    assert.deepEqual(result, { created: 0, tokens: 0 });
    assert.equal(state.marks.size, 0);
  });

  it("message-count gate: default minMessages 20 skips at 20, runs above", () => {
    const atTwenty = Array.from({ length: 20 }, () =>
      makeToolMsg("bash", LONG_INPUT, LONG_OUTPUT, { status: "error" }),
    );
    const state20 = makeNewState();
    const r20 = runPurgeErrors(state20, atTwenty, {
      contextLimit: MODEL_LIMIT,
      thresholdContext: 0,
      protectedStartOrdinal: atTwenty.length,
    });
    assert.equal(r20.created, 0);
    assert.equal(state20.marks.size, 0);

    const above = [
      ...atTwenty,
      makeToolMsg("bash", LONG_INPUT, LONG_OUTPUT, { status: "error" }),
    ];
    const state21 = makeNewState();
    const r21 = runPurgeErrors(state21, above, {
      contextLimit: MODEL_LIMIT,
      thresholdContext: 0,
      protectedStartOrdinal: above.length,
    });
    assert.equal(r21.created, 21); // one input mark per error call
  });

  it("context gate: below threshold skips, at threshold opens, above runs", () => {
    const lens = [lensMsg([errCall()])];
    const total = measureMessages(lens).total;

    const below = makeNewState();
    const rBelow = runPurgeErrors(below, lens, {
      minMessages: 0,
      contextLimit: MODEL_LIMIT,
      thresholdContext: 0.5,
      protectedStartOrdinal: lens.length,
    });
    assert.equal(rBelow.created, 0);

    // Equality opens the gate (legacy "equal opens" semantics).
    const at = makeNewState();
    const rAt = runPurgeErrors(at, lens, {
      minMessages: 0,
      contextLimit: total,
      thresholdContext: 1,
      protectedStartOrdinal: lens.length,
    });
    assert.equal(rAt.created, 1);

    const above = makeNewState();
    const rAbove = runPurgeErrors(above, lens, {
      minMessages: 0,
      contextLimit: 1,
      thresholdContext: 0.5,
      protectedStartOrdinal: lens.length,
    });
    assert.equal(rAbove.created, 1);
  });

  it("context gate: default thresholdContext 0.5 opens at half the limit", () => {
    const lens = [lensMsg([errCall()])];
    const total = measureMessages(lens).total;

    // total / (2 * total) == 0.5 — equality with the default opens.
    const at = makeNewState();
    const rAt = runPurgeErrors(at, lens, {
      minMessages: 0,
      contextLimit: 2 * total,
      protectedStartOrdinal: lens.length,
    });
    assert.equal(rAt.created, 1);

    // total / (3 * total) < 0.5 — closed.
    const below = makeNewState();
    const rBelow = runPurgeErrors(below, lens, {
      minMessages: 0,
      contextLimit: 3 * total,
      protectedStartOrdinal: lens.length,
    });
    assert.equal(rBelow.created, 0);
  });

  it("context gate: undefined context limit skips (fail-closed)", () => {
    const state = makeNewState();
    const lens = [lensMsg([errCall()])];
    const result = runPurgeErrors(state, lens, {
      minMessages: 0,
      thresholdContext: 0.5,
      protectedStartOrdinal: lens.length,
    });
    assert.equal(result.created, 0);
    assert.equal(state.marks.size, 0);
  });

  it("no default protectedTools (legacy purge-errors had none)", () => {
    const state = makeNewState();
    const lens = [lensMsg([errCall("question")])];
    const result = runPurgeErrors(state, lens, {
      minMessages: 0,
      contextLimit: MODEL_LIMIT,
      thresholdContext: 0,
      protectedStartOrdinal: lens.length,
    });
    assert.equal(result.created, 1);
  });
});

// ===========================================================================
// Lens-specific skip and mark semantics
// ===========================================================================

describe("lens-specific skip and mark semantics", () => {
  it("skips ordinals reported as folded or pruned via prunedOrdinals", () => {
    const state = makeNewState();
    const lens = [lensMsg([errCall()]), lensMsg([errCall()])];
    const result = runPurgeErrors(state, lens, {
      minMessages: 0,
      contextLimit: MODEL_LIMIT,
      thresholdContext: 0,
      protectedStartOrdinal: lens.length,
      prunedOrdinals: (ordinal) => ordinal === 0,
    });
    assert.equal(result.created, 1); // only the second call survives
    assert.equal(state.marks.size, 1);
    assert.ok(state.marks.has(markKey(1, 0)));
  });

  it("hidden messages' error calls still participate", () => {
    const state = makeNewState();
    const lens = [
      makeToolMsg("bash", LONG_INPUT, LONG_OUTPUT, {
        status: "error",
        hidden: true,
      }),
      makeToolMsg("bash", LONG_INPUT, LONG_OUTPUT, { status: "error" }),
    ];
    const result = runPurgeErrors(state, lens, {
      minMessages: 0,
      contextLimit: MODEL_LIMIT,
      thresholdContext: 0,
      protectedStartOrdinal: lens.length,
    });
    assert.equal(result.created, 2);
    assert.ok(state.marks.has(markKey(0, 0)));
    assert.ok(state.marks.has(markKey(1, 0)));
  });

  it("an existing mark on either region of the call suppresses the whole call", () => {
    // Pre-existing input mark.
    const stateA = makeNewState();
    stateA.marks.set(markKey(0, 0), {
      anchorOrdinal: 0,
      regionIndex: 0,
      content: "preexisting",
      contentTokens: 5,
      effective: false,
      markedAt: 1,
    });
    const lens = [lensMsg([errCall()])];
    const rA = runPurgeErrors(stateA, lens, {
      minMessages: 0,
      contextLimit: MODEL_LIMIT,
      thresholdContext: 0,
      protectedStartOrdinal: lens.length,
    });
    assert.equal(rA.created, 0);
    assert.equal(stateA.marks.size, 1);
    assert.equal(stateA.marks.get(markKey(0, 0))?.content, "preexisting");

    // Pre-existing output mark (e.g. written by dedup) also suppresses.
    const stateB = makeNewState();
    stateB.marks.set(markKey(0, 1), {
      anchorOrdinal: 0,
      regionIndex: 1,
      content: "deduped",
      contentTokens: 9,
      effective: false,
      markedAt: 1,
    });
    const rB = runPurgeErrors(stateB, lens, {
      minMessages: 0,
      contextLimit: MODEL_LIMIT,
      thresholdContext: 0,
      protectedStartOrdinal: lens.length,
    });
    assert.equal(rB.created, 0);
    assert.equal(stateB.marks.size, 1);
  });

  it("never writes output-region marks", () => {
    const state = makeNewState();
    const lens = [lensMsg([errCall("bash", LONG_INPUT, SHORT_OUTPUT)])];
    const result = runPurgeErrors(state, lens, {
      minMessages: 0,
      contextLimit: MODEL_LIMIT,
      thresholdContext: 0,
      protectedStartOrdinal: lens.length,
    });
    assert.equal(result.created, 1);
    assert.ok(state.marks.has(markKey(0, 0)));
    assert.equal(state.marks.has(markKey(0, 1)), false);
  });

  it("marks anchor to the tool-input region with the input reclaim", () => {
    const state = makeNewState();
    const lens = [lensMsg([errCall()])];
    runPurgeErrors(state, lens, {
      minMessages: 0,
      contextLimit: MODEL_LIMIT,
      thresholdContext: 0,
      protectedStartOrdinal: lens.length,
    });

    const inputMark = state.marks.get(markKey(0, 0));
    assert.ok(inputMark);
    assert.equal(inputMark.anchorOrdinal, 0);
    assert.equal(inputMark.regionIndex, 0);
    assert.equal(lens[0].regions[inputMark.regionIndex].kind, "tool-input");
    assert.equal(
      inputMark.contentTokens,
      netReclaimTokens(LONG_INPUT, PRUNED_TOOL_ERROR_INPUT_REPLACEMENT),
    );
  });

  it("writes pending marks with a truncated content snapshot", () => {
    const big = "x".repeat(20_000);
    const state = makeNewState();
    const lens = [makeToolMsg("bash", big, LONG_OUTPUT, { status: "error" })];
    const result = runPurgeErrors(state, lens, {
      minMessages: 0,
      contextLimit: MODEL_LIMIT,
      thresholdContext: 0,
      protectedStartOrdinal: lens.length,
    });
    assert.equal(result.created, 1);
    const inputMark = state.marks.get(markKey(0, 0));
    assert.ok(inputMark);
    assert.equal(inputMark.content.length, 16_000);
    assert.equal(inputMark.content, "x".repeat(16_000));
    // contentTokens still reflects the full-content reclaim.
    assert.equal(
      inputMark.contentTokens,
      estimateTokenCount(big) -
        estimateTokenCount(PRUNED_TOOL_ERROR_INPUT_REPLACEMENT),
    );
  });

  it("uses the legacy placeholder constant verbatim", () => {
    assert.equal(
      PRUNED_TOOL_ERROR_INPUT_REPLACEMENT,
      "[Input removed due to failed tool call - information no longer relevant]",
    );
  });
});

// ===========================================================================
// Canon invariance (acceptance: purge never changes the block hash input)
// ===========================================================================

describe("canon invariance under purge-errors", () => {
  it("replacing the error input with the placeholder leaves canon unchanged", () => {
    const msg = makeAssistantMsg({
      text: "checking the failure",
      thinking: "reasoning trace",
      toolCalls: [
        {
          name: "bash",
          input: LONG_INPUT,
          output: LONG_OUTPUT,
          status: "error",
        },
      ],
    });
    const before = canon(msg);
    regionsOfKind(msg, "tool-input")[0].set(
      PRUNED_TOOL_ERROR_INPUT_REPLACEMENT,
    );
    assert.equal(canon(msg), before);
  });

  it("end-to-end: applying the producer's marks keeps canon stable", () => {
    const lens = [makeMsg("user", ["do it"]), lensMsg([errCall()])];
    const state = makeNewState();
    const before = canon(lens[1]);
    const result = runPurgeErrors(state, lens, {
      minMessages: 0,
      contextLimit: MODEL_LIMIT,
      thresholdContext: 0,
      protectedStartOrdinal: lens.length,
    });
    assert.equal(result.created, 1);

    // Simulate the release phase: replace every marked input region
    // with the error-input placeholder.
    for (const mark of state.marks.values()) {
      lens[mark.anchorOrdinal].regions[mark.regionIndex ?? -1].set(
        PRUNED_TOOL_ERROR_INPUT_REPLACEMENT,
      );
    }
    assert.equal(canon(lens[1]), before);
  });
});
