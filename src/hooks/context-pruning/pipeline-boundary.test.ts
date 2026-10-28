/**
 * Tests for the pipeline's fold boundary and the coverage it hands on.
 *
 * The pi host splits a tool call across two messages (assistant
 * `toolCall`, then a `toolResult`), so `computeUnits` builds units that
 * span both.  Phase 3 therefore reports a block whose endpoint falls
 * inside such a unit as a `boundary` failure, and phase 4 must treat only
 * the intervals the fold actually replaced as model-invisible.
 *
 * - A boundary failure retires the block, logs
 *   `reason: "boundary-misaligned"` with no hash fields (the span still
 *   hashes — only its boundaries fail), and never re-ages the terminal
 *   block in a later round.
 * - The producer coverage comes from the folded view: a rendered block's
 *   lines are never marked, and the lines a retired block left visible
 *   still are.
 *
 * Runs go through the real transform handler over the shared session
 * state manager; session files are cleaned up in teardown.
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { createPiAdapter } from "../../adapters/pi/adapter.js";
import type { PiAgentMessage } from "../../adapters/pi/types.js";
import {
  _resetForTesting as _resetModelLimitsForTesting,
  setModelLimit,
} from "../../core/context/model-limits.js";
import { contextPruningTransformHandler } from "../../core/context/pipeline.js";
import {
  _resetContextStateManagerForTesting,
  getContextStateManager,
} from "../../core/context/runtime.js";
import { computeSpanHash } from "../../core/context/spanhash.js";
import { markKey } from "../../core/context/state.js";
import {
  assistantMessage,
  textPart,
  toolCallPart,
  toolResultMessage,
  userMessage,
} from "../../testkits/pi-messages.js";
import { _getBufferForTesting, _resetForTesting } from "../../utils/logger.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Session IDs used by tests in this file (for persisted-file cleanup). */
const TEST_SESSION_IDS = ["sess-pipeline-boundary", "sess-pipeline-coverage"];

/** Projection-only adapter; the hash seeding needs no session id. */
const adapter = createPiAdapter(() => undefined);

/** Model limit used to open the producer context gates. */
const MODEL_LIMIT = 1_000_000;

/** Long tool output so dedup reclaims tokens. */
const LONG_OUTPUT = "x".repeat(2000);

afterEach(() => {
  const manager = getContextStateManager();
  for (const sid of TEST_SESSION_IDS) {
    manager.store.delete(sid);
  }
  _resetContextStateManagerForTesting();
  _resetForTesting();
  _resetModelLimitsForTesting();
});

/**
 * A four-message transcript whose middle unit spans ordinals 1 and 2:
 * the assistant's tool call and its result fold as one unit, so ordinal
 * 2 lies inside a unit rather than on a seam.
 */
function boundaryTurn(): PiAgentMessage[] {
  return [
    userMessage([textPart("first prompt")]),
    assistantMessage([toolCallPart("call-1", "bash", { cmd: "ls" })]),
    toolResultMessage("call-1", "bash", [textPart("first output")]),
    userMessage([textPart("next prompt")]),
  ];
}

/** Seed an active block over `[start, end)` hashing the given transcript. */
function seedBlocks(
  sessionID: string,
  transcript: PiAgentMessage[],
  intervals: Array<[number, number]>,
): void {
  const projection = adapter.history(transcript);
  const state = getContextStateManager().get(sessionID);
  intervals.forEach(([start, end], index) => {
    state.blocks.set(index + 1, {
      start,
      end,
      title: "会话开场",
      summary: "packed summary",
      spanHash: computeSpanHash(projection, start, end),
      status: "active",
      compressedTokens: 100,
      summaryTokens: 10,
      createdAt: 1000,
    });
  });
}

/** The producers stay closed: gated-out config never marks. */
const NO_PRODUCERS = { dedup: {}, purgeErrors: {} };

// ---------------------------------------------------------------------------
// Phase 3: boundary expiry at pipeline level
// ---------------------------------------------------------------------------

describe("pipeline boundary expiry", () => {
  it("retires a block whose endpoint falls inside a unit", () => {
    const sessionID = TEST_SESSION_IDS[0];
    const pi = createPiAdapter(() => sessionID);
    const transcript = boundaryTurn();
    seedBlocks(sessionID, transcript, [[0, 2]]);
    const before = _getBufferForTesting().length;

    contextPruningTransformHandler(pi, boundaryTurn(), NO_PRODUCERS);

    assert.equal(
      getContextStateManager().get(sessionID).blocks.get(1)?.status,
      "stale",
      "the unaddressable block is retired",
    );
    const entries = _getBufferForTesting()
      .slice(before)
      .filter((e) => e.event === "compress_block_stale");
    assert.equal(entries.length, 1, "one stale log for the block");
    const entry = entries[0];
    assert.equal(entry.blockId, 1);
    assert.equal(entry.reason, "boundary-misaligned");
    assert.deepEqual([entry.start, entry.end], [0, 2]);
    assert.equal(entry.historyLength, 4);
    assert.equal(entry.title, "会话开场");
    // The span still hashes; only its boundaries fail, so no hash
    // comparison describes the failure.
    assert.ok(!("storedHash" in entry), "no stored hash on a boundary log");
    assert.ok(!("currentHash" in entry), "no current hash on a boundary log");
  });

  it("never re-ages the retired block in a later round", () => {
    const sessionID = TEST_SESSION_IDS[0];
    const pi = createPiAdapter(() => sessionID);
    seedBlocks(sessionID, boundaryTurn(), [[0, 2]]);
    contextPruningTransformHandler(pi, boundaryTurn(), NO_PRODUCERS);
    const before = _getBufferForTesting().length;

    contextPruningTransformHandler(pi, boundaryTurn(), NO_PRODUCERS);

    const entries = _getBufferForTesting()
      .slice(before)
      .filter((e) => e.event === "compress_block_stale");
    assert.equal(entries.length, 0, "the terminal block logs nothing again");
  });
});

// ---------------------------------------------------------------------------
// Phase 4: producer coverage comes from the view
// ---------------------------------------------------------------------------

/**
 * A 24-message transcript with three identical calls, so dedup sees the
 * outputs at ordinals 2, 5 and 8 and marks the two older ones.  The last
 * assistant carries the token report that opens the context gate.
 */
function dedupTurn(): PiAgentMessage[] {
  const messages: PiAgentMessage[] = [
    userMessage([textPart("prompt 0")]),
    assistantMessage([toolCallPart("call-1", "bash", { cmd: "ls" })]),
    toolResultMessage("call-1", "bash", [textPart(LONG_OUTPUT)]),
    userMessage([textPart("prompt 3")]),
    assistantMessage([toolCallPart("call-2", "bash", { cmd: "ls" })]),
    toolResultMessage("call-2", "bash", [textPart(LONG_OUTPUT)]),
    userMessage([textPart("prompt 6")]),
    assistantMessage([toolCallPart("call-3", "bash", { cmd: "ls" })]),
    toolResultMessage("call-3", "bash", [textPart(LONG_OUTPUT)]),
  ];
  for (let i = messages.length; i < 23; i++) {
    messages.push(
      i % 2 === 0
        ? userMessage([textPart(`prompt ${i}`)])
        : assistantMessage([textPart(`reply ${i}`)]),
    );
  }
  messages.push(
    assistantMessage([textPart("done")], { input: 100000, output: 200 }),
  );
  return messages;
}

describe("producer coverage from the folded view", () => {
  it("marks only lines the fold left visible", () => {
    const sessionID = TEST_SESSION_IDS[1];
    const pi = createPiAdapter(() => sessionID);
    setModelLimit(sessionID, MODEL_LIMIT, "test-model");
    const transcript = dedupTurn();

    // [0, 3) spans two units and renders; [5, 7) starts inside the
    // call/result unit [4, 6), so it is retired as a boundary failure and
    // its ordinals stay visible.
    seedBlocks(sessionID, transcript, [
      [0, 3],
      [5, 7],
    ]);

    contextPruningTransformHandler(pi, dedupTurn(), {
      protectedMessages: 0,
      compress: { protectedTokens: 0, thresholdTokens: 0 },
      dedup: { minMessages: 20, thresholdContext: 100000 },
      purgeErrors: {},
    });

    const state = getContextStateManager().get(sessionID);
    assert.equal(state.blocks.get(1)?.status, "active", "block 1 renders");
    assert.equal(state.blocks.get(2)?.status, "stale", "block 2 was retired");
    assert.equal(
      state.marks.has(markKey(2, 0)),
      false,
      "the folded line is model-invisible and never marked",
    );
    assert.equal(
      state.marks.has(markKey(5, 0)),
      true,
      "the retired interval is visible and still marked",
    );
    assert.equal(
      state.marks.size,
      1,
      "exactly the visible duplicate is marked",
    );
  });
});
