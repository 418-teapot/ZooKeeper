/**
 * Tests for the pure edit computation of the release phase
 * (`release.computeEdits`) and the flip step (`flipReleasedMarks`).
 *
 * Two layers:
 * 1. **Selection** — for a given state, transcript, and options,
 *    `computeEdits` returns exactly the edits the release phase would
 *    write: unprotected effective marks always, pending marks only when
 *    the releasedPercent gate flips them, and never for unresolvable
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
import {
  makeAssistantMsg,
  makeState,
  makeToolMsg,
  setRegionText,
} from "../../testkits/context.js";
import type { HostMessage, RegionEdit } from "./lens.js";
import {
  PRUNED_TOOL_ERROR_INPUT_REPLACEMENT,
  PRUNED_TOOL_OUTPUT_REPLACEMENT,
} from "./message-parts.js";
import { buildProtectionMap, type ProtectionMap } from "./protection-map.js";
import {
  computeEdits,
  flipReleasedMarks,
  materializeEffectiveMarks,
  type ReleaseOptions,
} from "./release.js";
import { contentFingerprint } from "./spanhash.js";
import { markKey, RECALL_MAX_CHARS, type SessionState } from "./state.js";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

/** Output long enough to reclaim tokens against the output placeholder. */
const LONG_OUTPUT = "x".repeat(500);

/**
 * The round's protection map with both windows disabled: nothing is
 * protected, so every seeded mark is eligible.
 *
 * @param history - The transcript.
 * @returns The frozen protection map.
 */
function openProtection(history: HostMessage[]): ProtectionMap {
  return buildProtectionMap(history, 0, 0);
}

/**
 * Seed a lens mark for the given region.
 *
 * `regionIndex` is optional: pass undefined to seed a mark without a
 * region index (the unresolvable-anchor shape).  `content` is the mark's
 * content snapshot and defaults to the fixture's long tool output, so it
 * matches the region it addresses unless a test states otherwise.  The
 * stored snapshot and the fingerprint are the ones `addPendingMark`
 * writes for the same content: a truncated snapshot over the full-text
 * fingerprint.
 */
function seedMark(
  state: SessionState,
  ordinal: number,
  regionIndex: number | undefined,
  effective: boolean,
  tokens = 100,
  content = LONG_OUTPUT,
): void {
  seedUnhashed(state, ordinal, regionIndex, effective, tokens, content);
  const key = markKey(ordinal, regionIndex);
  const mark = state.marks.get(key);
  if (mark !== undefined) mark.contentHash = contentFingerprint(content);
}

/**
 * Seed a mark that carries no content fingerprint.
 *
 * The shape of a file written before fingerprints existed, or of a
 * hand-written record: the anchor check has no proof of the content.
 */
function seedUnhashed(
  state: SessionState,
  ordinal: number,
  regionIndex: number | undefined,
  effective: boolean,
  tokens = 100,
  content = LONG_OUTPUT,
): void {
  state.marks.set(markKey(ordinal, regionIndex), {
    anchorOrdinal: ordinal,
    ...(regionIndex !== undefined ? { regionIndex } : {}),
    content: content.slice(0, RECALL_MAX_CHARS),
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
  const state = makeState();
  seed(state);
  const roundOptions: ReleaseOptions = {
    protection: openProtection(lens),
    ...options,
  };
  const edits = computeEdits(state, lens, roundOptions);
  applyEdits(lens, edits);
  flipReleasedMarks(state, roundOptions);
  return regionTexts(lens);
}

// ===========================================================================
// computeEdits selection
// ===========================================================================

describe("computeEdits selection", () => {
  it("effective output marks yield the output placeholder at the anchor region", () => {
    const state = makeState();
    const lens = [makeToolMsg("bash", '{"cmd":"ls"}', LONG_OUTPUT)];
    seedMark(state, 0, 1, true, 100);
    const edits = computeEdits(state, lens, {
      protection: openProtection(lens),
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
    const state = makeState();
    const lens = [makeToolMsg("bash", '"ls"', "boom", { status: "error" })];
    seedMark(state, 0, 0, true, 100, '"ls"');
    const edits = computeEdits(state, lens, {
      protection: openProtection(lens),
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
    const state = makeState();
    const lens = [makeToolMsg("bash", '{"cmd":"ls"}', LONG_OUTPUT)];
    seedMark(state, 0, 1, false, 100);
    const edits = computeEdits(state, lens, {
      protection: openProtection(lens),
      promptTokens: 100_000,
      releasedPercent: 5,
      pendingViewChange: false,
    });
    assert.deepEqual(edits, []);
  });

  it("releasedPercent 0 — every pending mark appears as an edit", () => {
    const state = makeState();
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
      protection: openProtection(lens),
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
    const state = makeState();
    const lens = [makeToolMsg("bash", '{"cmd":"ls"}', LONG_OUTPUT)];
    seedMark(state, 0, 1, false, 100);
    const edits = computeEdits(state, lens, {
      protection: openProtection(lens),
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
    const state = makeState();
    const lens = [
      makeToolMsg("bash", '{"cmd":"ls"}', LONG_OUTPUT),
      makeToolMsg("bash", '{"cmd":"pwd"}', LONG_OUTPUT),
    ];
    seedMark(state, 0, 1, true, 100);
    seedMark(state, 1, 1, false, 100);
    const edits = computeEdits(state, lens, {
      protection: openProtection(lens),
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
    const state = makeState();
    const lens = [makeToolMsg("bash", '{"cmd":"ls"}', LONG_OUTPUT)];
    seedMark(state, 3, 1, true, 100);
    const edits = computeEdits(state, lens, {
      protection: openProtection(lens),
      promptTokens: 100_000,
      releasedPercent: 5,
      pendingViewChange: false,
    });
    assert.deepEqual(edits, []);
  });

  it("out-of-range region index — no edit", () => {
    const state = makeState();
    const lens = [makeToolMsg("bash", '{"cmd":"ls"}', LONG_OUTPUT)];
    seedMark(state, 0, 5, true, 100);
    const edits = computeEdits(state, lens, {
      protection: openProtection(lens),
      promptTokens: 100_000,
      releasedPercent: 5,
      pendingViewChange: false,
    });
    assert.deepEqual(edits, []);
  });

  it("mark without a region index — no edit", () => {
    const state = makeState();
    const lens = [makeToolMsg("bash", '{"cmd":"ls"}', LONG_OUTPUT)];
    seedMark(state, 0, undefined, true, 100);
    const edits = computeEdits(state, lens, {
      protection: openProtection(lens),
      promptTokens: 100_000,
      releasedPercent: 5,
      pendingViewChange: false,
    });
    assert.deepEqual(edits, []);
  });

  it("empty or nullish transcript — no edits", () => {
    const state = makeState();
    seedMark(state, 0, 1, true, 100);
    const options: ReleaseOptions = {
      protection: openProtection([]),
      promptTokens: 100_000,
      releasedPercent: 0,
      pendingViewChange: false,
    };
    assert.deepEqual(computeEdits(state, [], options), []);
    assert.deepEqual(computeEdits(state, undefined, options), []);
    assert.deepEqual(computeEdits(state, null, options), []);
  });

  it("is pure — no mark flips, no text writes", () => {
    const state = makeState();
    const lens = [makeToolMsg("bash", '{"cmd":"ls"}', LONG_OUTPUT)];
    seedMark(state, 0, 1, false, 100);
    const before = regionTexts(lens);
    const edits = computeEdits(state, lens, {
      protection: openProtection(lens),
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
        seedMark(state, 0, 0, false, 3000, '"ls"'); // tool-input
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

// ===========================================================================
// Anchor content check
// ===========================================================================

describe("anchor content check", () => {
  const gate: ReleaseOptions = {
    promptTokens: 100_000,
    releasedPercent: 0,
    pendingViewChange: false,
  };

  it("shifted ordinal over foreign content — no edit", () => {
    const state = makeState();
    const lens = [makeToolMsg("bash", '{"cmd":"ls"}', "new output")];
    seedMark(state, 0, 1, true, 100, "old output");
    const edits = computeEdits(state, lens, {
      ...gate,
      protection: openProtection(lens),
    });
    assert.deepEqual(edits, []);
  });

  it("shifted anchor keeps the current text through a release round", () => {
    const lens = [makeToolMsg("bash", '{"cmd":"ls"}', "new output")];
    const state = makeState();
    seedMark(state, 0, 1, false, 100, "old output");
    const options: ReleaseOptions = {
      ...gate,
      protection: openProtection(lens),
    };
    applyEdits(lens, computeEdits(state, lens, options));
    const flipped = flipReleasedMarks(state, options);
    assert.deepEqual(regionTexts(lens), ['{"cmd":"ls"}', "new output"]);
    assert.equal(flipped.releasedCount, 1, "the flip is independent");
    assert.equal(state.marks.get(markKey(0, 1))?.effective, true);
  });

  it("matching snapshot still writes the placeholder", () => {
    const lens = [makeToolMsg("bash", '{"cmd":"ls"}', LONG_OUTPUT)];
    const state = makeState();
    seedMark(state, 0, 1, true, 100);
    const options: ReleaseOptions = {
      ...gate,
      protection: openProtection(lens),
    };
    applyEdits(lens, computeEdits(state, lens, options));
    assert.equal(lens[0].regions[1].get(), PRUNED_TOOL_OUTPUT_REPLACEMENT);
  });

  it("placeholder already in place — replay stays stable", () => {
    const lens = [makeToolMsg("bash", '{"cmd":"ls"}', "old output")];
    const state = makeState();
    seedMark(state, 0, 1, true, 100, "old output");
    const options: ReleaseOptions = {
      ...gate,
      protection: openProtection(lens),
    };
    applyEdits(lens, computeEdits(state, lens, options));
    applyEdits(lens, computeEdits(state, lens, options));
    assert.equal(lens[0].regions[1].get(), PRUNED_TOOL_OUTPUT_REPLACEMENT);
  });

  it("region longer than the recall cap — the anchor matches", () => {
    const head = "y".repeat(RECALL_MAX_CHARS);
    const long = `${head}original tail`;
    const lens = [makeToolMsg("bash", '{"cmd":"ls"}', long)];
    const state = makeState();
    seedMark(state, 0, 1, true, 100, long);
    const edits = computeEdits(state, lens, {
      ...gate,
      protection: openProtection(lens),
    });
    assert.deepEqual(edits, [
      {
        messageOrdinal: 0,
        regionIndex: 1,
        text: PRUNED_TOOL_OUTPUT_REPLACEMENT,
      },
    ]);
  });

  it("change beyond the recall cap — no edit", () => {
    const head = "y".repeat(RECALL_MAX_CHARS);
    const lens = [makeToolMsg("bash", '{"cmd":"ls"}', `${head}changed tail`)];
    const state = makeState();
    seedMark(state, 0, 1, true, 100, `${head}original tail`);
    const edits = computeEdits(state, lens, {
      ...gate,
      protection: openProtection(lens),
    });
    assert.deepEqual(edits, []);
  });

  it("snapshot differing inside the cap — no edit", () => {
    const long = "y".repeat(RECALL_MAX_CHARS);
    const lens = [makeToolMsg("bash", '{"cmd":"ls"}', long)];
    const state = makeState();
    seedMark(state, 0, 1, true, 100, `z${long.slice(1, RECALL_MAX_CHARS)}`);
    const edits = computeEdits(state, lens, {
      ...gate,
      protection: openProtection(lens),
    });
    assert.deepEqual(edits, []);
  });

  it("mark without a fingerprint — fails closed, no edit", () => {
    const lens = [makeToolMsg("bash", '{"cmd":"ls"}', LONG_OUTPUT)];
    const state = makeState();
    seedUnhashed(state, 0, 1, true);
    const edits = computeEdits(state, lens, {
      ...gate,
      protection: openProtection(lens),
    });
    assert.deepEqual(edits, []);
  });

  it("mark without a fingerprint over its placeholder — replay allowed", () => {
    const lens = [
      makeToolMsg("bash", '{"cmd":"ls"}', PRUNED_TOOL_OUTPUT_REPLACEMENT),
    ];
    const state = makeState();
    seedUnhashed(state, 0, 1, true);
    const edits = computeEdits(state, lens, {
      ...gate,
      protection: openProtection(lens),
    });
    assert.deepEqual(edits, [
      {
        messageOrdinal: 0,
        regionIndex: 1,
        text: PRUNED_TOOL_OUTPUT_REPLACEMENT,
      },
    ]);
  });
});

// ===========================================================================
// Read-side materialization
// ===========================================================================

describe("materializeEffectiveMarks anchor check", () => {
  it("shifted anchor over foreign content — the new text stays visible", () => {
    const lens = [makeToolMsg("bash", '{"cmd":"ls"}', "new output")];
    const state = makeState();
    seedMark(state, 0, 1, true, 100, "old output");
    const view = materializeEffectiveMarks(lens, state, openProtection(lens));
    assert.equal(view[0].regions[1].get(), "new output");
    assert.equal(view, lens, "no overlay");
  });

  it("matching snapshot — the placeholder replaces the stored original", () => {
    const lens = [makeToolMsg("bash", '{"cmd":"ls"}', LONG_OUTPUT)];
    const state = makeState();
    seedMark(state, 0, 1, true, 100);
    const view = materializeEffectiveMarks(lens, state, openProtection(lens));
    assert.equal(view[0].regions[1].get(), PRUNED_TOOL_OUTPUT_REPLACEMENT);
    assert.equal(view[0].regions[0].get(), '{"cmd":"ls"}');
  });

  it("change beyond the recall cap — the new text stays visible", () => {
    const head = "y".repeat(RECALL_MAX_CHARS);
    const lens = [makeToolMsg("bash", '{"cmd":"ls"}', `${head}changed tail`)];
    const state = makeState();
    seedMark(state, 0, 1, true, 100, `${head}original tail`);
    const view = materializeEffectiveMarks(lens, state, openProtection(lens));
    assert.equal(view, lens, "no overlay");
    assert.equal(view[0].regions[1].get(), `${head}changed tail`);
  });

  it("mark without a fingerprint — the stored original stays visible", () => {
    const lens = [makeToolMsg("bash", '{"cmd":"ls"}', LONG_OUTPUT)];
    const state = makeState();
    seedUnhashed(state, 0, 1, true);
    const view = materializeEffectiveMarks(lens, state, openProtection(lens));
    assert.equal(view, lens, "no overlay");
  });

  it("tool-input anchor — the error-input placeholder", () => {
    const lens = [makeToolMsg("bash", '"ls"', "boom", { status: "error" })];
    const state = makeState();
    seedMark(state, 0, 0, true, 100, '"ls"');
    const view = materializeEffectiveMarks(lens, state, openProtection(lens));
    assert.equal(view[0].regions[0].get(), PRUNED_TOOL_ERROR_INPUT_REPLACEMENT);
  });

  it("pending marks and missing anchors are not overlaid", () => {
    const lens = [makeToolMsg("bash", '{"cmd":"ls"}', "new output")];
    const state = makeState();
    seedMark(state, 0, 1, false, 100, "new output");
    seedMark(state, 5, 1, true, 100, "elsewhere");
    const view = materializeEffectiveMarks(lens, state, openProtection(lens));
    assert.equal(view, lens, "no overlay");
  });
});
