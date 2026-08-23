/**
 * Tests for the pure edit computation of the release phase
 * (`release.computeEdits`) and the flip step (`flipReleasedMarks`).
 *
 * Two layers:
 * 1. **Selection** — for a given state, transcript, and options,
 *    `computeEdits` returns exactly the edits the release phase would
 *    write: effective marks always, pending marks only when the
 *    releasedPercent gate flips them, and never for unresolvable
 *    anchors (vanished messages, out-of-range region indices, marks
 *    without a region index).  The placeholder text mirrors the
 *    release discriminator: tool-output anchors carry the output
 *    placeholder, tool-input anchors the error-input placeholder.
 * 2. **Round result** — applying the selected edits through the
 *    testkit backing and flipping the released marks yields the
 *    transcript region texts the release phase produces, across
 *    gate-open/closed and defensive-anchor fixtures.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { HostMessage, RegionEdit } from "./lens.js";
import {
  makeAssistantMsg,
  makeToolMsg,
  setRegionText,
} from "./lens-testkit.js";
import {
  PRUNED_TOOL_ERROR_INPUT_REPLACEMENT,
  PRUNED_TOOL_OUTPUT_REPLACEMENT,
} from "./message-parts.js";
import {
  computeEdits,
  flipReleasedMarks,
  type ReleaseOptions,
} from "./release.js";
import { markKey, type SessionState } from "./state.js";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

/** Output long enough to reclaim tokens against the output placeholder. */
const LONG_OUTPUT = "x".repeat(500);

/** A fresh empty lens session state. */
function makeNewState(): SessionState {
  return { blocks: new Map(), marks: new Map() };
}

/**
 * Seed a lens mark for the given region.
 *
 * `regionIndex` is optional: pass undefined to seed a mark without a
 * region index (the unresolvable-anchor shape).
 */
function seedMark(
  state: SessionState,
  ordinal: number,
  regionIndex: number | undefined,
  effective: boolean,
  tokens = 100,
): void {
  state.marks.set(markKey(ordinal, regionIndex), {
    anchorOrdinal: ordinal,
    ...(regionIndex !== undefined ? { regionIndex } : {}),
    content: "content snapshot",
    contentTokens: tokens,
    effective,
    markedAt: 1,
  });
}

/** An assistant message with two bash calls (four regions: in/out/in/out). */
function twoCallAssistant(): HostMessage {
  return makeAssistantMsg({
    toolCalls: [
      { name: "bash", input: '{"cmd":"ls"}', output: LONG_OUTPUT },
      { name: "bash", input: '{"cmd":"pwd"}', output: LONG_OUTPUT },
    ],
  });
}

/** Apply edits through the testkit backing, mirroring the adapter loop. */
function applyEdits(messages: HostMessage[], edits: RegionEdit[]): void {
  for (const edit of edits) {
    if (edit.regionIndex === undefined) continue;
    setRegionText(messages[edit.messageOrdinal], edit.regionIndex, edit.text);
  }
}

/** All region texts of a transcript, flattened in ordinal order. */
function regionTexts(messages: HostMessage[]): string[] {
  return messages.flatMap((message) =>
    message.regions.map((region) => region.get()),
  );
}

/**
 * Run the release round over independently seeded copies and return the
 * applied transcript texts.
 *
 * The full release contract: `computeEdits` selects the round's edits,
 * they are applied through the testkit backing, and
 * `flipReleasedMarks` flips the released marks.  Only the resulting
 * region texts are asserted — the expected texts are literal in each
 * test.
 *
 * @param seed - Seeds the mark collection on the state.
 * @param messages - Builds a fresh transcript.
 * @param options - Release gate inputs.
 * @returns All region texts of the applied transcript, in ordinal order.
 */
function runRelease(
  seed: (state: SessionState) => void,
  messages: () => HostMessage[],
  options: ReleaseOptions,
): string[] {
  const lens = messages();
  const state = makeNewState();
  seed(state);
  const edits = computeEdits(state, lens, options);
  applyEdits(lens, edits);
  flipReleasedMarks(state, options);
  return regionTexts(lens);
}

// ===========================================================================
// computeEdits selection
// ===========================================================================

describe("computeEdits selection", () => {
  it("effective output marks yield the output placeholder at the anchor region", () => {
    const state = makeNewState();
    const lens = [makeToolMsg("bash", '{"cmd":"ls"}', LONG_OUTPUT)];
    seedMark(state, 0, 1, true, 100);
    const edits = computeEdits(state, lens, {
      promptTokens: 100_000,
      releasedPercent: 5,
      pendingViewChange: false,
    });
    assert.deepEqual(edits, [
      {
        messageOrdinal: 0,
        regionIndex: 1,
        text: PRUNED_TOOL_OUTPUT_REPLACEMENT,
      },
    ]);
  });

  it("effective tool-input marks yield the error-input placeholder", () => {
    const state = makeNewState();
    const lens = [makeToolMsg("bash", '"ls"', "boom", { status: "error" })];
    seedMark(state, 0, 0, true, 100);
    const edits = computeEdits(state, lens, {
      promptTokens: 100_000,
      releasedPercent: 5,
      pendingViewChange: false,
    });
    assert.deepEqual(edits, [
      {
        messageOrdinal: 0,
        regionIndex: 0,
        text: PRUNED_TOOL_ERROR_INPUT_REPLACEMENT,
      },
    ]);
  });

  it("pending marks below the threshold — no release edits", () => {
    const state = makeNewState();
    const lens = [makeToolMsg("bash", '{"cmd":"ls"}', LONG_OUTPUT)];
    seedMark(state, 0, 1, false, 100);
    const edits = computeEdits(state, lens, {
      promptTokens: 100_000,
      releasedPercent: 5,
      pendingViewChange: false,
    });
    assert.deepEqual(edits, []);
  });

  it("releasedPercent 0 — every pending mark appears as an edit", () => {
    const state = makeNewState();
    const lens = [
      makeAssistantMsg({
        toolCalls: [
          { name: "bash", input: "ls", output: LONG_OUTPUT },
          { name: "bash", input: "pwd", output: LONG_OUTPUT },
        ],
      }),
    ];
    seedMark(state, 0, 1, false, 100);
    seedMark(state, 0, 3, false, 200);
    const edits = computeEdits(state, lens, {
      promptTokens: 100_000,
      releasedPercent: 0,
      pendingViewChange: false,
    });
    assert.deepEqual(edits, [
      {
        messageOrdinal: 0,
        regionIndex: 1,
        text: PRUNED_TOOL_OUTPUT_REPLACEMENT,
      },
      {
        messageOrdinal: 0,
        regionIndex: 3,
        text: PRUNED_TOOL_OUTPUT_REPLACEMENT,
      },
    ]);
  });

  it("pendingViewChange forces pending edits regardless of the threshold", () => {
    const state = makeNewState();
    const lens = [makeToolMsg("bash", '{"cmd":"ls"}', LONG_OUTPUT)];
    seedMark(state, 0, 1, false, 100);
    const edits = computeEdits(state, lens, {
      promptTokens: 100_000,
      releasedPercent: 90,
      pendingViewChange: true,
    });
    assert.deepEqual(edits, [
      {
        messageOrdinal: 0,
        regionIndex: 1,
        text: PRUNED_TOOL_OUTPUT_REPLACEMENT,
      },
    ]);
  });

  it("releasedPercent undefined without a bypass — effective marks only", () => {
    const state = makeNewState();
    const lens = [
      makeToolMsg("bash", '{"cmd":"ls"}', LONG_OUTPUT),
      makeToolMsg("bash", '{"cmd":"pwd"}', LONG_OUTPUT),
    ];
    seedMark(state, 0, 1, true, 100);
    seedMark(state, 1, 1, false, 100);
    const edits = computeEdits(state, lens, {
      promptTokens: 100_000,
      releasedPercent: undefined,
      pendingViewChange: false,
    });
    assert.deepEqual(edits, [
      {
        messageOrdinal: 0,
        regionIndex: 1,
        text: PRUNED_TOOL_OUTPUT_REPLACEMENT,
      },
    ]);
  });

  it("vanished anchor message — no edit", () => {
    const state = makeNewState();
    const lens = [makeToolMsg("bash", '{"cmd":"ls"}', LONG_OUTPUT)];
    seedMark(state, 3, 1, true, 100);
    const edits = computeEdits(state, lens, {
      promptTokens: 100_000,
      releasedPercent: 5,
      pendingViewChange: false,
    });
    assert.deepEqual(edits, []);
  });

  it("out-of-range region index — no edit", () => {
    const state = makeNewState();
    const lens = [makeToolMsg("bash", '{"cmd":"ls"}', LONG_OUTPUT)];
    seedMark(state, 0, 5, true, 100);
    const edits = computeEdits(state, lens, {
      promptTokens: 100_000,
      releasedPercent: 5,
      pendingViewChange: false,
    });
    assert.deepEqual(edits, []);
  });

  it("mark without a region index — no edit", () => {
    const state = makeNewState();
    const lens = [makeToolMsg("bash", '{"cmd":"ls"}', LONG_OUTPUT)];
    seedMark(state, 0, undefined, true, 100);
    const edits = computeEdits(state, lens, {
      promptTokens: 100_000,
      releasedPercent: 5,
      pendingViewChange: false,
    });
    assert.deepEqual(edits, []);
  });

  it("empty or nullish transcript — no edits", () => {
    const state = makeNewState();
    seedMark(state, 0, 1, true, 100);
    const options: ReleaseOptions = {
      promptTokens: 100_000,
      releasedPercent: 0,
      pendingViewChange: false,
    };
    assert.deepEqual(computeEdits(state, [], options), []);
    assert.deepEqual(computeEdits(state, undefined, options), []);
    assert.deepEqual(computeEdits(state, null, options), []);
  });

  it("is pure — no mark flips, no text writes", () => {
    const state = makeNewState();
    const lens = [makeToolMsg("bash", '{"cmd":"ls"}', LONG_OUTPUT)];
    seedMark(state, 0, 1, false, 100);
    const before = regionTexts(lens);
    const edits = computeEdits(state, lens, {
      promptTokens: 100_000,
      releasedPercent: 0,
      pendingViewChange: false,
    });
    assert.ok(edits.length > 0, "gate-released edit selected");
    assert.deepEqual(regionTexts(lens), before, "transcript untouched");
    assert.equal(
      state.marks.get(markKey(0, 1))?.effective,
      false,
      "mark pending",
    );
  });
});

// ===========================================================================
// Release round result
// ===========================================================================

describe("release round result", () => {
  it("mixed effective and gate-released marks land their placeholders", () => {
    const texts = runRelease(
      (state) => {
        seedMark(state, 0, 1, true, 100);
        seedMark(state, 0, 3, false, 200);
        seedMark(state, 1, 1, false, 300);
      },
      () => [twoCallAssistant(), twoCallAssistant()],
      { promptTokens: 100_000, releasedPercent: 0, pendingViewChange: false },
    );
    assert.deepEqual(texts, [
      '{"cmd":"ls"}',
      PRUNED_TOOL_OUTPUT_REPLACEMENT,
      '{"cmd":"pwd"}',
      PRUNED_TOOL_OUTPUT_REPLACEMENT,
      '{"cmd":"ls"}',
      PRUNED_TOOL_OUTPUT_REPLACEMENT,
      '{"cmd":"pwd"}',
      LONG_OUTPUT,
    ]);
  });

  it("error-input and output marks both land across a gate flip", () => {
    const texts = runRelease(
      (state) => {
        // Equality at 5% of 100_000 = 5000 pending tokens.
        seedMark(state, 0, 0, false, 3000); // tool-input
        seedMark(state, 0, 1, false, 2000); // tool-output
      },
      () => [makeToolMsg("bash", '"ls"', LONG_OUTPUT)],
      { promptTokens: 100_000, releasedPercent: 5, pendingViewChange: false },
    );
    assert.deepEqual(texts, [
      PRUNED_TOOL_ERROR_INPUT_REPLACEMENT,
      PRUNED_TOOL_OUTPUT_REPLACEMENT,
    ]);
  });

  it("closed gate — only effective marks are replaced", () => {
    const texts = runRelease(
      (state) => {
        seedMark(state, 0, 1, true, 100);
        seedMark(state, 1, 1, false, 100);
      },
      () => [twoCallAssistant(), twoCallAssistant()],
      {
        promptTokens: 100_000,
        releasedPercent: undefined,
        pendingViewChange: false,
      },
    );
    assert.deepEqual(texts, [
      '{"cmd":"ls"}',
      PRUNED_TOOL_OUTPUT_REPLACEMENT,
      '{"cmd":"pwd"}',
      LONG_OUTPUT,
      '{"cmd":"ls"}',
      LONG_OUTPUT,
      '{"cmd":"pwd"}',
      LONG_OUTPUT,
    ]);
  });

  it("pendingViewChange bypass releases at promptTokens 0", () => {
    const texts = runRelease(
      (state) => {
        seedMark(state, 0, 1, false, 100);
        seedMark(state, 0, 3, false, 200);
      },
      () => [twoCallAssistant()],
      { promptTokens: 0, releasedPercent: 5, pendingViewChange: true },
    );
    assert.deepEqual(texts, [
      '{"cmd":"ls"}',
      PRUNED_TOOL_OUTPUT_REPLACEMENT,
      '{"cmd":"pwd"}',
      PRUNED_TOOL_OUTPUT_REPLACEMENT,
    ]);
  });

  it("defensive anchors leave only the resolvable region replaced", () => {
    const texts = runRelease(
      (state) => {
        seedMark(state, 0, 1, true, 100); // valid
        seedMark(state, 7, 1, true, 100); // vanished message
        seedMark(state, 0, 9, false, 100); // out-of-range region
        seedMark(state, 1, undefined, false, 100); // no region index
      },
      () => [twoCallAssistant()],
      { promptTokens: 100_000, releasedPercent: 0, pendingViewChange: false },
    );
    assert.deepEqual(texts, [
      '{"cmd":"ls"}',
      PRUNED_TOOL_OUTPUT_REPLACEMENT,
      '{"cmd":"pwd"}',
      LONG_OUTPUT,
    ]);
  });

  it("re-release over an already-replaced transcript keeps the texts stable", () => {
    const seed = (state: SessionState): void => {
      seedMark(state, 0, 1, true, 100);
    };
    // First release.
    const first = runRelease(seed, () => [twoCallAssistant()], {
      promptTokens: 100_000,
      releasedPercent: 5,
      pendingViewChange: false,
    });
    // Second release over the same already-replaced transcript — both
    // passes carry the same placeholder text.
    const second = runRelease(seed, () => [twoCallAssistant()], {
      promptTokens: 100_000,
      releasedPercent: 5,
      pendingViewChange: false,
    });
    assert.deepEqual(first, [
      '{"cmd":"ls"}',
      PRUNED_TOOL_OUTPUT_REPLACEMENT,
      '{"cmd":"pwd"}',
      LONG_OUTPUT,
    ]);
    assert.deepEqual(second, first);
  });
});
