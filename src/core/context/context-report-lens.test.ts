/**
 * Tests for the lens context report producer (`computeContextReportLens`)
 * and the dual-scope message counter (`countFoldedMessages`).
 *
 * Fixtures are built directly as lens `HostMessage`s (through the core
 * testkit), so the tests no longer depend on the OpenCode v1 adapter.
 * Expected reports are hand-computed literals from the estimator
 * definition (CJK /1.5, other /4, per-region ceil) and the API-usage
 * rules, independent of the producer's own arithmetic.  Covered:
 * multi-turn dialog with cache usage, hidden messages, no completed
 * assistant, compaction boundary, pruned tool placeholder, and the
 * zero-denominator cache case.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  makeAssistantMsg,
  makeBlock,
  makeMark,
  makeMsg,
  makeState,
  makeToolMsg,
} from "../../testkits/context.js";
import {
  computeContextReportLens,
  countFoldedMessages,
  foldedLensTranscript,
} from "./context-report-lens.js";
import type { HostMessage, ViewItem } from "./lens.js";
import { PRUNED_TOOL_OUTPUT_REPLACEMENT } from "./message-parts.js";
import { materializeEffectiveMarks } from "./release.js";
import { markKey, type SessionState } from "./state.js";

// ---------------------------------------------------------------------------
// Fixture helper
// ---------------------------------------------------------------------------

/** Build a host-native compaction summary message. */
function compactionMsg(text: string): HostMessage {
  return {
    role: "assistant",
    hidden: false,
    regions: [{ kind: "content", get: () => text }],
    compaction: true,
  };
}

// ---------------------------------------------------------------------------
// computeContextReportLens
// ---------------------------------------------------------------------------

describe("computeContextReportLens", () => {
  it("returns an all-zero report for an empty transcript", () => {
    assert.deepEqual(computeContextReportLens([]), {
      total: 0,
      exact: 0,
      heuristic: 0,
      messageCount: 0,
      cacheHitRate: null,
      categories: { user: 0, assistant: 0, tool: 0, system: 0 },
    });
  });

  it("uses the last completed assistant as exact and the tail as heuristic", () => {
    // user "Hello" (5 → 2); assistant usage {input:200, output:50} (exact
    // 250) text "OK"; trailing user text lands in the heuristic.
    const messages: HostMessage[] = [
      makeMsg("user", ["Hello"]),
      makeAssistantMsg({ text: "OK", usage: { input: 200, output: 50 } }),
    ];
    assert.deepEqual(computeContextReportLens(messages), {
      total: 250,
      exact: 250,
      heuristic: 0,
      messageCount: 2,
      cacheHitRate: 0, // read 0 / (input 200 + 0 + 0)
      categories: { user: 2, assistant: 50, tool: 0, system: 198 },
    });
  });

  it("excludes hidden messages from the count and categories", () => {
    const messages: HostMessage[] = [
      makeMsg("user", ["Hello"]),
      makeMsg("user", ["secret"], { hidden: true }),
      makeAssistantMsg({ text: "OK", usage: { input: 100, output: 20 } }),
    ];
    assert.deepEqual(computeContextReportLens(messages), {
      total: 120,
      exact: 120,
      heuristic: 0,
      messageCount: 2,
      cacheHitRate: 0,
      categories: { user: 2, assistant: 20, tool: 0, system: 98 },
    });
  });

  it("falls back to pure heuristics without a completed assistant", () => {
    const messages: HostMessage[] = [
      makeMsg("user", ["Hello"]), // ceil(5/4) = 2
      makeAssistantMsg({ text: "thinking" }), // ceil(8/4) = 2
    ];
    assert.deepEqual(computeContextReportLens(messages), {
      total: 4,
      exact: 0,
      heuristic: 4,
      messageCount: 2,
      cacheHitRate: null,
      categories: { user: 2, assistant: 2, tool: 0, system: 0 },
    });
  });

  it("returns a null cache rate when the denominator is zero", () => {
    const messages: HostMessage[] = [
      makeAssistantMsg({
        text: "x",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      }),
    ];
    assert.equal(computeContextReportLens(messages).cacheHitRate, null);
  });

  it("restricts categories to the last compaction boundary", () => {
    // Pre-boundary: user "Old question" (12 → 3), assistant
    // {input:1000, output:200}, both excluded from categories.
    // Boundary: compaction summary "Previous conversation condensed"
    // (31 → 8, no API output → heuristic fallback).
    // Post-boundary: user "New question" (12 → 3), assistant
    // {input:300, output:60}.  Total = exact 360 (last completed).
    const messages: HostMessage[] = [
      makeMsg("user", ["Old question"]),
      makeAssistantMsg({
        text: "Old answer",
        usage: { input: 1000, output: 200 },
      }),
      compactionMsg("Previous conversation condensed"),
      makeMsg("user", ["New question"]),
      makeAssistantMsg({
        text: "New answer",
        usage: { input: 300, output: 60 },
      }),
    ];
    assert.deepEqual(computeContextReportLens(messages), {
      total: 360,
      exact: 360,
      heuristic: 0,
      messageCount: 5,
      cacheHitRate: 0,
      categories: { user: 3, assistant: 68, tool: 0, system: 289 },
    });
  });

  it("counts a pruned tool output as input plus placeholder", () => {
    // tool input "echo pruned" (11 → 3); output is the pruned placeholder
    // (77 chars → 20 tokens).  Assistant API output 100.
    const messages: HostMessage[] = [
      makeMsg("user", ["Run command"]), // 11 → 3
      makeToolMsg("bash", "echo pruned", PRUNED_TOOL_OUTPUT_REPLACEMENT, {
        usage: { input: 500, output: 100 },
      }),
    ];
    assert.deepEqual(computeContextReportLens(messages), {
      total: 600,
      exact: 600,
      heuristic: 0,
      messageCount: 2,
      cacheHitRate: 0,
      categories: { user: 3, assistant: 100, tool: 23, system: 474 },
    });
  });

  it("tolerates a nullish transcript", () => {
    assert.equal(computeContextReportLens(undefined).total, 0);
    assert.equal(computeContextReportLens(null).total, 0);
  });
});

// ---------------------------------------------------------------------------
// effective prune marks over a storage transcript
// ---------------------------------------------------------------------------

/**
 * The host keeps the pre-prune original text in storage and writes the
 * placeholder only into the model-bound copy, so a report over storage
 * must overlay the effective marks itself.  These tests run the exact
 * caller pipeline (`computeContextReportLens(materializeEffectiveMarks(
 * messages, state))`) and assert the tool category against hand-computed
 * literals: pruned calls count `input + placeholder`, pending or absent
 * marks leave the raw output in place, and a region that is already a
 * placeholder is not counted twice.
 */
describe("computeContextReportLens over a marks-overlaid transcript", () => {
  const reportOver = (
    messages: HostMessage[],
    state: SessionState,
  ): ReturnType<typeof computeContextReportLens> =>
    computeContextReportLens(materializeEffectiveMarks(messages, state));

  /** A user turn plus one tool call whose output is still the original. */
  function rawToolTranscript(): HostMessage[] {
    return [
      makeMsg("user", ["Run command"]), // 11 → 3
      makeToolMsg("bash", "echo pruned", "raw output text", {
        // 11 → 3 (input); 15 → 4 (raw output)
        usage: { input: 500, output: 100 },
      }),
    ];
  }

  it("counts an effective mark's raw tool output as input plus placeholder", () => {
    const state = makeState();
    state.marks.set(
      markKey(1, 1),
      makeMark({
        anchorOrdinal: 1,
        regionIndex: 1,
        content: "raw output text",
        effective: true,
      }),
    );

    const report = reportOver(rawToolTranscript(), state);

    // tool = input "echo pruned" (3) + placeholder (77 → 20) = 23
    assert.equal(report.categories.tool, 23);
    // total is exact only (the tool message is the last completed assistant).
    assert.equal(report.total, 600);
  });

  it("leaves a pending mark's raw output in place", () => {
    const state = makeState();
    state.marks.set(
      markKey(1, 1),
      makeMark({
        anchorOrdinal: 1,
        regionIndex: 1,
        content: "raw output text",
        effective: false,
      }),
    );

    const report = reportOver(rawToolTranscript(), state);

    // tool = input "echo pruned" (3) + raw output (15 → 4) = 7
    assert.equal(report.categories.tool, 7);
  });

  it("counts the raw output when no mark addresses it", () => {
    const report = reportOver(rawToolTranscript(), makeState());
    assert.equal(report.categories.tool, 7);
  });

  it("does not double count a text placeholder a mark also addresses", () => {
    const messages: HostMessage[] = [
      makeMsg("user", ["Run command"]),
      makeToolMsg("bash", "echo pruned", PRUNED_TOOL_OUTPUT_REPLACEMENT, {
        usage: { input: 500, output: 100 },
      }),
    ];
    const state = makeState();
    state.marks.set(
      markKey(1, 1),
      makeMark({
        anchorOrdinal: 1,
        regionIndex: 1,
        content: PRUNED_TOOL_OUTPUT_REPLACEMENT,
        effective: true,
      }),
    );

    const report = reportOver(messages, state);

    // placeholder counted once: input 3 + placeholder 20 = 23 (not 40).
    assert.equal(report.categories.tool, 23);
  });
});

// ---------------------------------------------------------------------------
// foldedLensTranscript — folded view materialization
// ---------------------------------------------------------------------------

describe("foldedLensTranscript", () => {
  it("returns undefined when no item is a summary", () => {
    const messages = [makeMsg("user", ["a"]), makeMsg("assistant", ["b"])];
    const items: ViewItem[] = [
      { type: "original", start: 0, end: 1 },
      { type: "original", start: 1, end: 2 },
    ];
    assert.equal(foldedLensTranscript(items, messages, makeState()), undefined);
  });

  it("copies originals verbatim and renders summaries via the block map", () => {
    const messages = [
      makeMsg("user", ["a"]),
      makeMsg("assistant", ["b"]),
      makeMsg("user", ["c"]),
    ];
    const state = makeState();
    state.blocks.set(7, makeBlock(messages, 0, 1));
    const items: ViewItem[] = [
      {
        type: "summary",
        block: { start: 0, end: 1, summary: "summary [0, 1)" },
      },
      { type: "original", start: 1, end: 3 },
    ];

    const folded = foldedLensTranscript(items, messages, state);

    assert.ok(folded);
    assert.equal(folded.length, 3);
    assert.equal(folded[0].role, "user");
    assert.equal(
      folded[0].regions[0].get(),
      "[Block b7 · 1 条]\nsummary [0, 1)",
    );
    // Original items copy by ordinal reference; a unit may span messages.
    assert.equal(folded[1], messages[1]);
    assert.equal(folded[2], messages[2]);
  });

  it("renders the bare label when no active block covers the interval", () => {
    const messages = [makeMsg("user", ["a"])];
    const items: ViewItem[] = [
      { type: "summary", block: { start: 0, end: 1, summary: "gone" } },
    ];

    const folded = foldedLensTranscript(items, messages, makeState());

    assert.ok(folded);
    assert.equal(folded[0].regions[0].get(), "[Block 1 条]\ngone");
  });
});

// ---------------------------------------------------------------------------
// countFoldedMessages — dual-scope message counts
// ---------------------------------------------------------------------------

describe("countFoldedMessages", () => {
  it("counts summary items as one each and originals by hidden flag", () => {
    const messages: HostMessage[] = [
      makeHiddenUser(),
      makeUser(),
      makeHiddenUser(),
      makeUser(),
    ];
    const items: ViewItem[] = [
      { type: "summary", block: { start: 0, end: 2, summary: "s" } },
      { type: "original", start: 2, end: 3 },
      { type: "original", start: 3, end: 4 },
    ];
    const counts = countFoldedMessages(items, messages);
    // storage: non-hidden = 2 (idx 1, 3).  folded: summary=1 + original
    // idx2 (hidden→0) + original idx3 (non-hidden→1) = 2.
    assert.equal(counts.storageMessageCount, 2);
    assert.equal(counts.foldedMessageCount, 2);
  });

  it("folded count differs from storage when a block folds hidden and visible", () => {
    const messages: HostMessage[] = [
      makeUser(), // 0
      makeHiddenUser(), // 1
      makeUser(), // 2
      makeUser(), // 3
    ];
    const items: ViewItem[] = [
      { type: "original", start: 0, end: 1 },
      // Block covers ordinals 1..3 (hidden + 2 visible) → one summary.
      { type: "summary", block: { start: 1, end: 4, summary: "s" } },
    ];
    const counts = countFoldedMessages(items, messages);
    // storage: non-hidden = 3 (0, 2, 3).  folded: original 0 (1) + summary (1) = 2.
    assert.equal(counts.storageMessageCount, 3);
    assert.equal(counts.foldedMessageCount, 2);
  });
});

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeUser(): HostMessage {
  return { role: "user", hidden: false, regions: [] };
}

function makeHiddenUser(): HostMessage {
  return { role: "user", hidden: true, regions: [] };
}
