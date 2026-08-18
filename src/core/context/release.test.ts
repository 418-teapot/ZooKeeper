/**
 * Tests for the lens-based release phase (`release.ts`).
 *
 * Two layers:
 * 1. **Release decisions** — the gate formula is pinned with literal
 *    expectations over `HostMessage` transcripts and `SessionState`
 *    marks: the releasedPercent threshold (0 / below / equality / above /
 *    undefined), the promptTokens-0 closed gate, the pendingViewChange
 *    bypass, the placeholder texts written by effective marks, and a
 *    two-turn flow driving the lens dedup producer.
 * 2. **Lens-specific semantics** — the two-turn lifecycle (turn N marks
 *    stay pending and invisible; turn N+1 flips and applies), defensive
 *    anchors (vanished messages, out-of-range regions), idempotent
 *    re-release, and the derived stats.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { HostMessage } from "./lens.js";
import { makeAssistantMsg, makeToolMsg } from "./lens-testkit.js";
import {
  PRUNED_TOOL_ERROR_INPUT_REPLACEMENT,
  PRUNED_TOOL_OUTPUT_REPLACEMENT,
} from "./message-parts.js";
import { runDedup } from "./producers/dedup.js";
import {
  pendingCount,
  pendingTokens,
  type ReleaseResult,
  reclaimedTokens,
  releaseMarks,
} from "./release.js";
import { type Mark, markKey, type SessionState } from "./state.js";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

/** Output long enough to reclaim tokens against the output placeholder. */
const LONG_OUTPUT = "x".repeat(500);

/** Model limit used to open the producer context gates in flow runs. */
const MODEL_LIMIT = 1_000_000;

/** One tool call in a fixture message. */
interface CallSpec {
  tool: string;
  input: string;
  output: string;
  status?: string;
}

/** A bash call with the given fields. */
function bashCall(
  input = '{"cmd":"ls"}',
  output = LONG_OUTPUT,
  status?: string,
): CallSpec {
  return { tool: "bash", input, output, status };
}

/** Build the lens assistant message for the same calls. */
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
 * Seed a lens mark for the region the given side occupies: tool-input at
 * `2*partIndex`, tool-output at `2*partIndex+1`.
 */
function seedLensMark(
  state: SessionState,
  messageIndex: number,
  partIndex: number,
  side: "output" | "input",
  tokens: number,
  effective: boolean,
): void {
  const regionIndex = side === "input" ? 2 * partIndex : 2 * partIndex + 1;
  state.marks.set(markKey(messageIndex, regionIndex), {
    anchorOrdinal: messageIndex,
    regionIndex,
    content: "content snapshot",
    contentTokens: tokens,
    effective,
    markedAt: 1,
  });
}

/** Seed a lens mark with an explicit region index (defensive anchors). */
function rawSeed(
  state: SessionState,
  ordinal: number,
  regionIndex: number,
  tokens: number,
  effective: boolean,
): void {
  state.marks.set(markKey(ordinal, regionIndex), {
    anchorOrdinal: ordinal,
    regionIndex,
    content: "content snapshot",
    contentTokens: tokens,
    effective,
    markedAt: 1,
  });
}

/** New pipeline turn: release phase first, then the lens dedup producer. */
function newTurn(
  state: SessionState,
  messages: HostMessage[],
  promptTokens: number,
  releasedPercent: number,
  pendingViewChange: boolean,
): void {
  releaseMarks(state, messages, {
    promptTokens,
    releasedPercent,
    pendingViewChange,
  });
  runDedup(state, messages, {
    minMessages: 0,
    contextLimit: MODEL_LIMIT,
    thresholdContext: 0,
    protectedStartOrdinal: messages.length,
    protectedTools: [],
  });
}

// ===========================================================================
// Derived stats
// ===========================================================================

describe("derived stats", () => {
  it("pendingCount counts non-effective marks only", () => {
    const state = makeNewState();
    assert.equal(pendingCount(state), 0);
    rawSeed(state, 0, 1, 100, false);
    rawSeed(state, 1, 1, 50, true);
    rawSeed(state, 2, 1, 30, false);
    assert.equal(pendingCount(state), 2);
  });

  it("pendingTokens sums non-effective contentTokens", () => {
    const state = makeNewState();
    rawSeed(state, 0, 1, 100, false);
    rawSeed(state, 1, 1, 50, true);
    rawSeed(state, 2, 1, 30, false);
    assert.equal(pendingTokens(state), 130);
  });

  it("reclaimedTokens sums effective contentTokens", () => {
    const state = makeNewState();
    rawSeed(state, 0, 1, 100, false);
    rawSeed(state, 1, 1, 50, true);
    rawSeed(state, 2, 1, 30, true);
    assert.equal(reclaimedTokens(state), 80);
  });
});

// ===========================================================================
// Release decisions
// ===========================================================================

describe("release decisions (lens)", () => {
  /**
   * Seed two pending output marks on a two-message transcript and run
   * the release gate with the given inputs — the same input patterns
   * formerly driven through the legacy Phase 5 gate, now pinned as
   * literals.
   */
  function runLens(
    tokens: [number, number],
    promptTokens: number,
    releasedPercent: number | undefined,
    pendingViewChange: boolean,
  ): { result: ReleaseResult; markAt: (m: number) => Mark | undefined } {
    const lens = [lensMsg([bashCall()]), lensMsg([bashCall()])];
    const state = makeNewState();
    seedLensMark(state, 0, 0, "output", tokens[0], false);
    seedLensMark(state, 1, 0, "output", tokens[1], false);
    const result = releaseMarks(state, lens, {
      promptTokens,
      releasedPercent,
      pendingViewChange,
    });
    return { result, markAt: (m) => state.marks.get(markKey(m, 1)) };
  }

  it("releasedPercent 0 — releases all pending immediately", () => {
    const { result, markAt } = runLens([100, 200], 100_000, 0, false);
    assert.deepEqual(result, {
      releasedCount: 2,
      releasedTokens: 300,
      forced: false,
    });
    assert.equal(markAt(0)?.effective, true);
    assert.equal(markAt(1)?.effective, true);
  });

  it("below threshold — retains pending", () => {
    const { result, markAt } = runLens([100, 200], 100_000, 5, false);
    assert.deepEqual(result, {
      releasedCount: 0,
      releasedTokens: 0,
      forced: false,
    });
    assert.equal(markAt(0)?.effective, false);
    assert.equal(markAt(1)?.effective, false);
  });

  it("at threshold — equality opens the gate", () => {
    // 5% of 100000 = 5000; pending 3000 + 2000 = 5000.
    const { result } = runLens([3000, 2000], 100_000, 5, false);
    assert.deepEqual(result, {
      releasedCount: 2,
      releasedTokens: 5000,
      forced: false,
    });
  });

  it("above threshold — both release", () => {
    const { result } = runLens([4000, 2000], 100_000, 5, false);
    assert.deepEqual(result, {
      releasedCount: 2,
      releasedTokens: 6000,
      forced: false,
    });
  });

  it("releasedPercent undefined — skips entirely", () => {
    const { result, markAt } = runLens([100, 200], 100_000, undefined, false);
    assert.deepEqual(result, {
      releasedCount: 0,
      releasedTokens: 0,
      forced: false,
    });
    assert.equal(markAt(0)?.effective, false);
    assert.equal(markAt(1)?.effective, false);
  });

  it("promptTokens 0 — skips without a bypass", () => {
    const { result, markAt } = runLens([100, 200], 0, 5, false);
    assert.deepEqual(result, {
      releasedCount: 0,
      releasedTokens: 0,
      forced: false,
    });
    assert.equal(markAt(0)?.effective, false);
  });

  it("pendingViewChange — forces regardless of threshold", () => {
    const { result, markAt } = runLens([100, 200], 100_000, 5, true);
    assert.deepEqual(result, {
      releasedCount: 2,
      releasedTokens: 300,
      forced: true,
    });
    assert.equal(markAt(0)?.effective, true);
    assert.equal(markAt(1)?.effective, true);
  });

  it("pendingViewChange with promptTokens 0 — forces", () => {
    const { result } = runLens([100, 200], 0, 5, true);
    assert.deepEqual(result, {
      releasedCount: 2,
      releasedTokens: 300,
      forced: true,
    });
  });

  it("effective output marks write the output placeholder text", () => {
    const lens = [lensMsg([bashCall("ls", LONG_OUTPUT)])];
    const state = makeNewState();
    seedLensMark(state, 0, 0, "output", 100, true);
    releaseMarks(state, lens, {
      promptTokens: 100_000,
      releasedPercent: 5,
      pendingViewChange: false,
    });
    assert.equal(lens[0].regions[1].get(), PRUNED_TOOL_OUTPUT_REPLACEMENT);
  });

  it("effective error-input marks write the error-input placeholder text", () => {
    const lens = [lensMsg([bashCall("ls", "boom", "error")])];
    const state = makeNewState();
    seedLensMark(state, 0, 0, "input", 100, true);
    releaseMarks(state, lens, {
      promptTokens: 100_000,
      releasedPercent: 5,
      pendingViewChange: false,
    });
    assert.equal(lens[0].regions[0].get(), PRUNED_TOOL_ERROR_INPUT_REPLACEMENT);
  });

  it("two-turn flow: marks land pending, then flip and apply", () => {
    const promptTokens = 100_000;
    const releasedPercent = 0;
    const state = makeNewState();

    // Turn 1: two identical calls — dedup marks the older output.
    const turn1 = [lensMsg([bashCall("ls"), bashCall("ls")])];
    newTurn(state, turn1, promptTokens, releasedPercent, false);
    // C5-01: this turn's mark never prunes this turn's view.
    assert.ok(
      turn1[0].regions[1].get().startsWith("x"),
      "turn 1 output unchanged",
    );
    assert.equal(state.marks.get(markKey(0, 1))?.effective, false);

    // Turn 2: the old transcript plus a new duplicate pair.
    const turn2 = [
      lensMsg([bashCall("ls"), bashCall("ls")]),
      lensMsg([bashCall("ls"), bashCall("ls")]),
    ];
    newTurn(state, turn2, promptTokens, releasedPercent, false);
    // Turn 1's mark is now visible.
    assert.equal(
      turn2[0].regions[1].get(),
      PRUNED_TOOL_OUTPUT_REPLACEMENT,
      "turn 1 mark applied",
    );

    // Convergence: one more release flushes the last wave of pending
    // marks from the turn-2 dedup run.
    releaseMarks(state, turn2, {
      promptTokens,
      releasedPercent,
      pendingViewChange: false,
    });
    const claims = [...state.marks.values()];
    assert.equal(claims.length, 3);
    for (const mark of claims) {
      assert.equal(mark.effective, true, "all claims effective");
    }
    assert.equal(turn2[0].regions[3].get(), PRUNED_TOOL_OUTPUT_REPLACEMENT);
    assert.equal(turn2[1].regions[1].get(), PRUNED_TOOL_OUTPUT_REPLACEMENT);
  });
});

// ===========================================================================
// Two-turn lifecycle (lens-only)
// ===========================================================================

describe("two-turn lifecycle", () => {
  it("turn N pending stays invisible; turn N+1 flips and applies", () => {
    const state = makeNewState();
    const lens = [makeToolMsg("bash", '{"cmd":"ls"}', LONG_OUTPUT)];

    // Turn N: the release phase runs before the producers, so nothing is
    // pending yet; the producers then write their pending marks.
    const r1 = releaseMarks(state, lens, {
      promptTokens: 100_000,
      releasedPercent: 0,
      pendingViewChange: false,
    });
    assert.deepEqual(r1, {
      releasedCount: 0,
      releasedTokens: 0,
      forced: false,
    });
    seedLensMark(state, 0, 0, "output", 104, false);
    assert.equal(lens[0].regions[1].get(), LONG_OUTPUT, "turn N output intact");
    assert.equal(state.marks.get(markKey(0, 1))?.effective, false);

    // Turn N+1: the release phase flips the pending mark and applies it.
    const r2 = releaseMarks(state, lens, {
      promptTokens: 100_000,
      releasedPercent: 0,
      pendingViewChange: false,
    });
    assert.equal(r2.releasedCount, 1);
    assert.equal(r2.releasedTokens, 104);
    assert.equal(r2.forced, false);
    assert.equal(lens[0].regions[1].get(), PRUNED_TOOL_OUTPUT_REPLACEMENT);
    assert.equal(state.marks.get(markKey(0, 1))?.effective, true);
  });

  it("pre-seeded effective mark applies in the same release call", () => {
    const state = makeNewState();
    const lens = [makeToolMsg("bash", '{"cmd":"ls"}', LONG_OUTPUT)];
    rawSeed(state, 0, 1, 100, true);
    // promptTokens 0 and no bypass — the gate is closed, but the apply
    // phase still writes placeholders for every effective mark.
    const r = releaseMarks(state, lens, {
      promptTokens: 0,
      releasedPercent: 5,
      pendingViewChange: false,
    });
    assert.equal(lens[0].regions[1].get(), PRUNED_TOOL_OUTPUT_REPLACEMENT);
    assert.deepEqual(r, { releasedCount: 0, releasedTokens: 0, forced: false });
  });
});

// ===========================================================================
// releasedPercent gate (lens-only)
// ===========================================================================

describe("releasedPercent gate", () => {
  it("undefined skips entirely — pending retained across calls", () => {
    const state = makeNewState();
    const lens = [makeToolMsg("bash", '{"cmd":"ls"}', LONG_OUTPUT)];
    seedLensMark(state, 0, 0, "output", 100, false);
    const r = releaseMarks(state, lens, {
      promptTokens: 100_000,
      releasedPercent: undefined,
      pendingViewChange: false,
    });
    assert.deepEqual(r, { releasedCount: 0, releasedTokens: 0, forced: false });
    assert.equal(state.marks.get(markKey(0, 1))?.effective, false);
    assert.equal(lens[0].regions[1].get(), LONG_OUTPUT);
  });

  it("0 releases immediately when pending exists", () => {
    const state = makeNewState();
    const lens = [makeToolMsg("bash", '{"cmd":"ls"}', LONG_OUTPUT)];
    seedLensMark(state, 0, 0, "output", 100, false);
    const r = releaseMarks(state, lens, {
      promptTokens: 100_000,
      releasedPercent: 0,
      pendingViewChange: false,
    });
    assert.equal(r.releasedCount, 1);
    assert.equal(r.releasedTokens, 100);
    assert.equal(pendingCount(state), 0);
  });

  it("below threshold retains pending; marks accumulate across calls", () => {
    const state = makeNewState();
    const lens = [makeToolMsg("bash", '{"cmd":"ls"}', LONG_OUTPUT)];
    seedLensMark(state, 0, 0, "output", 100, false);
    const r1 = releaseMarks(state, lens, {
      promptTokens: 100_000,
      releasedPercent: 5,
      pendingViewChange: false,
    });
    assert.equal(r1.releasedCount, 0);
    seedLensMark(state, 0, 1, "output", 200, false);
    // Cumulative 300 still below the 5000 threshold.
    const r2 = releaseMarks(state, lens, {
      promptTokens: 100_000,
      releasedPercent: 5,
      pendingViewChange: false,
    });
    assert.equal(r2.releasedCount, 0);
    assert.equal(pendingTokens(state), 300);
  });

  it("equality at the threshold opens the gate", () => {
    const state = makeNewState();
    const lens = [makeToolMsg("bash", '{"cmd":"ls"}', LONG_OUTPUT)];
    seedLensMark(state, 0, 0, "output", 3000, false);
    seedLensMark(state, 0, 1, "output", 2000, false);
    const r = releaseMarks(state, lens, {
      promptTokens: 100_000,
      releasedPercent: 5,
      pendingViewChange: false,
    });
    assert.equal(r.releasedCount, 2);
    assert.equal(r.releasedTokens, 5000);
  });
});

// ===========================================================================
// pendingViewChange bypass (lens-only)
// ===========================================================================

describe("pendingViewChange bypass", () => {
  it("forces release below the threshold", () => {
    const state = makeNewState();
    const lens = [makeToolMsg("bash", '{"cmd":"ls"}', LONG_OUTPUT)];
    seedLensMark(state, 0, 0, "output", 100, false);
    const r = releaseMarks(state, lens, {
      promptTokens: 100_000,
      releasedPercent: 5,
      pendingViewChange: true,
    });
    assert.equal(r.releasedCount, 1);
    assert.equal(r.forced, true);
    assert.equal(pendingCount(state), 0);
    assert.equal(lens[0].regions[1].get(), PRUNED_TOOL_OUTPUT_REPLACEMENT);
  });

  it("forces release with releasedPercent undefined", () => {
    const state = makeNewState();
    const lens = [makeToolMsg("bash", '{"cmd":"ls"}', LONG_OUTPUT)];
    seedLensMark(state, 0, 0, "output", 100, false);
    const r = releaseMarks(state, lens, {
      promptTokens: 100_000,
      releasedPercent: undefined,
      pendingViewChange: true,
    });
    assert.equal(r.releasedCount, 1);
    assert.equal(r.forced, true);
  });

  it("forces release with promptTokens 0", () => {
    const state = makeNewState();
    const lens = [makeToolMsg("bash", '{"cmd":"ls"}', LONG_OUTPUT)];
    seedLensMark(state, 0, 0, "output", 100, false);
    const r = releaseMarks(state, lens, {
      promptTokens: 0,
      releasedPercent: 5,
      pendingViewChange: true,
    });
    assert.equal(r.releasedCount, 1);
    assert.equal(r.forced, true);
  });

  it("after the caller clears the flag, subsequent turns batch normally", () => {
    const state = makeNewState();
    const lens = [makeToolMsg("bash", '{"cmd":"ls"}', LONG_OUTPUT)];
    seedLensMark(state, 0, 0, "output", 100, false);

    // Turn 1: forced flush.
    const r1 = releaseMarks(state, lens, {
      promptTokens: 100_000,
      releasedPercent: 5,
      pendingViewChange: true,
    });
    assert.equal(r1.forced, true);
    assert.equal(r1.releasedCount, 1);

    // Turn 2: flag cleared by the caller (legacy Phase 7) — normal batching.
    seedLensMark(state, 0, 1, "output", 200, false);
    const r2 = releaseMarks(state, lens, {
      promptTokens: 100_000,
      releasedPercent: 5,
      pendingViewChange: false,
    });
    assert.equal(r2.forced, false);
    assert.equal(r2.releasedCount, 0);
    assert.equal(pendingCount(state), 1);
  });
});

// ===========================================================================
// Defensive anchors and idempotency (lens-only)
// ===========================================================================

describe("defensive anchors", () => {
  it("vanished anchor message — flip still happens, apply skipped", () => {
    const state = makeNewState();
    const lens = [makeToolMsg("bash", '{"cmd":"ls"}', LONG_OUTPUT)];
    // Anchor ordinal 3 does not exist in a one-message transcript.
    rawSeed(state, 3, 1, 100, false);
    const r = releaseMarks(state, lens, {
      promptTokens: 100_000,
      releasedPercent: 0,
      pendingViewChange: false,
    });
    assert.equal(r.releasedCount, 1);
    assert.equal(r.releasedTokens, 100);
    assert.equal(state.marks.get(markKey(3, 1))?.effective, true);
    assert.equal(lens[0].regions[1].get(), LONG_OUTPUT, "region untouched");
  });

  it("out-of-range region index — apply skipped, flip happens", () => {
    const state = makeNewState();
    const lens = [makeToolMsg("bash", '{"cmd":"ls"}', LONG_OUTPUT)];
    // The message has exactly two regions; region 5 does not exist.
    rawSeed(state, 0, 5, 100, false);
    const r = releaseMarks(state, lens, {
      promptTokens: 100_000,
      releasedPercent: 0,
      pendingViewChange: false,
    });
    assert.equal(r.releasedCount, 1);
    assert.equal(lens[0].regions[1].get(), LONG_OUTPUT, "region untouched");
  });

  it("mark without a region index — flips, apply skipped", () => {
    const state = makeNewState();
    const lens = [makeToolMsg("bash", '{"cmd":"ls"}', LONG_OUTPUT)];
    state.marks.set("7", {
      anchorOrdinal: 0,
      content: "content snapshot",
      contentTokens: 50,
      effective: false,
      markedAt: 1,
    });
    const r = releaseMarks(state, lens, {
      promptTokens: 100_000,
      releasedPercent: 0,
      pendingViewChange: false,
    });
    assert.equal(r.releasedCount, 1);
    assert.equal(r.releasedTokens, 50);
    assert.equal(lens[0].regions[1].get(), LONG_OUTPUT, "region untouched");
  });

  it("already-replaced region — re-apply is stable", () => {
    const state = makeNewState();
    const lens = [
      makeToolMsg("bash", '{"cmd":"ls"}', PRUNED_TOOL_OUTPUT_REPLACEMENT),
    ];
    rawSeed(state, 0, 1, 100, true);
    releaseMarks(state, lens, {
      promptTokens: 100_000,
      releasedPercent: 5,
      pendingViewChange: false,
    });
    assert.equal(
      lens[0].regions[1].get(),
      PRUNED_TOOL_OUTPUT_REPLACEMENT,
      "placeholder text stable",
    );
  });

  it("repeated release is idempotent — no double counting, texts stable", () => {
    const state = makeNewState();
    const lens = [
      makeAssistantMsg({
        toolCalls: [
          { name: "bash", input: '{"cmd":"ls"}', output: LONG_OUTPUT },
          { name: "bash", input: '{"cmd":"pwd"}', output: LONG_OUTPUT },
        ],
      }),
    ];
    seedLensMark(state, 0, 0, "output", 100, false);
    seedLensMark(state, 0, 1, "output", 200, false);

    const r1 = releaseMarks(state, lens, {
      promptTokens: 100_000,
      releasedPercent: 0,
      pendingViewChange: false,
    });
    assert.equal(r1.releasedCount, 2);
    assert.equal(r1.releasedTokens, 300);

    const r2 = releaseMarks(state, lens, {
      promptTokens: 100_000,
      releasedPercent: 0,
      pendingViewChange: false,
    });
    assert.deepEqual(r2, {
      releasedCount: 0,
      releasedTokens: 0,
      forced: false,
    });
    assert.equal(lens[0].regions[1].get(), PRUNED_TOOL_OUTPUT_REPLACEMENT);
    assert.equal(lens[0].regions[3].get(), PRUNED_TOOL_OUTPUT_REPLACEMENT);
  });
});
