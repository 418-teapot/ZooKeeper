/**
 * Tests for the range-mode compression core (resolveSpan / validateRange /
 * applyRange).
 *
 * Covers: plain range compression happy path, cross-block consumption via a
 * synthetic summary ref (deactivation + messageIds union + summary append),
 * all validation errors (reversed order, protection zone, first user message,
 * partial overlap, phantom gate), stale/unknown refs, negative-benefit gate
 * evaluated on the merged summary, token no-double-counting, multi-block
 * append ordered by anchor position, deactivatedAt persistence, and the
 * syncBlocks no-resurrection regression.
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { type ContextMessageEntry, estimateTokenCount } from "../metrics.js";
import { type CompressionBlock, syncBlocks } from "./blocks.js";
import {
  BLOCK_HEADER_TEMPLATE,
  type CompressionConfig,
  segmentInOutTokens,
} from "./compress.js";
import { previewFold } from "./fold.js";
import {
  _clearAllSessionsForTesting,
  deleteSessionState,
  getOrCreateSessionState,
  loadSessionState,
  removeSession,
  type SessionState,
  saveSessionState,
} from "./marks.js";
import {
  _clearAllRefsForTesting,
  assignMessageRefs,
  getMessageIdByRef,
} from "./message-refs.js";
import {
  applyRange,
  resolveSpan,
  SUPERSEDED_BLOCKS_LEAD_IN,
  validateRange,
} from "./range.js";

// ---------------------------------------------------------------------------
// Constants & helpers
// ---------------------------------------------------------------------------

const TEST_SESSION_ID = "sess-range-test";

const CONFIG: CompressionConfig = {
  protectedMessages: 0,
  protectedTokens: 0,
  thresholdTokens: 50,
};

/** A long output string that makes a tool part dominate token estimates. */
const LONG_OUTPUT = "x".repeat(400);

/** Ref string for a zero-based message-array index (m0001 = index 0). */
function refFor(index: number): string {
  return `m${String(index + 1).padStart(4, "0")}`;
}

function makeUserMsg(id: string, text: string): ContextMessageEntry {
  return {
    info: { role: "user", id } as ContextMessageEntry["info"],
    parts: [{ type: "text", text }] as ContextMessageEntry["parts"],
  };
}

function makeAssistantMsg(id: string, text: string): ContextMessageEntry {
  return {
    info: { role: "assistant", id } as ContextMessageEntry["info"],
    parts: [{ type: "text", text }] as ContextMessageEntry["parts"],
  };
}

function makeToolMsg(
  id: string,
  tool: string,
  callID: string,
  output: string,
): ContextMessageEntry {
  return {
    info: { role: "assistant", id } as ContextMessageEntry["info"],
    parts: [
      { type: "tool", callID, tool, state: { input: { cmd: "x" }, output } },
    ] as unknown as ContextMessageEntry["parts"],
  };
}

/**
 * Standard 10-message conversation.
 *
 * Indices 0-9: u0 (first user), a1/u2/a3/u4/a5/u6/a7 (tool-heavy), u8 (last
 * user), a9.  Last user at index 8 → protection boundary = 8, so ranges may
 * end at most at index 8 (exclusive endIndex <= 8).
 */
function standardConversation(): ContextMessageEntry[] {
  return [
    makeUserMsg("u0", "开场问题"),
    makeToolMsg("a1", "bash", "c1", LONG_OUTPUT),
    makeUserMsg("u2", "第二段请求"),
    makeToolMsg("a3", "bash", "c3", LONG_OUTPUT),
    makeUserMsg("u4", "第四段请求"),
    makeToolMsg("a5", "bash", "c5", LONG_OUTPUT),
    makeUserMsg("u6", "第六段请求"),
    makeToolMsg("a7", "bash", "c7", LONG_OUTPUT),
    makeUserMsg("u8", "最后一个问题"),
    makeAssistantMsg("a9", "回答完毕"),
  ];
}

/** Run the full resolve → validate → apply pipeline. */
function compressRange(
  sessionId: string,
  messages: ContextMessageEntry[],
  state: SessionState,
  startRef: string,
  endRef: string,
  modelSummary: string,
  title: string,
): CompressionBlock {
  const span = resolveSpan(sessionId, messages, state, startRef, endRef);
  validateRange(span, messages, state, CONFIG);
  return applyRange(state, span, messages, modelSummary, title);
}

/**
 * Simulate the fold-layer ref assignment: fold the raw array through
 * `previewFold`, then let `assignMessageRefs` hand the synthetic summary
 * messages their next mNNNN refs (mirrors the real transform pipeline).
 */
function assignFoldedRefs(
  sessionId: string,
  messages: ContextMessageEntry[],
  state: SessionState,
): void {
  const activeBlocks: CompressionBlock[] = [];
  for (const [, block] of state.blocks) {
    if (block.active) activeBlocks.push(block);
  }
  assignMessageRefs(sessionId, previewFold(messages, activeBlocks));
}

// ---------------------------------------------------------------------------
// Teardown
// ---------------------------------------------------------------------------

afterEach(() => {
  deleteSessionState(TEST_SESSION_ID);
  removeSession(TEST_SESSION_ID);
  _clearAllSessionsForTesting();
  _clearAllRefsForTesting();
});

// ===========================================================================
// resolveSpan
// ===========================================================================

describe("resolveSpan", () => {
  it("maps plain refs to array indices with empty touchedBlocks", () => {
    const messages = standardConversation();
    assignMessageRefs(TEST_SESSION_ID, messages);
    const state = getOrCreateSessionState(TEST_SESSION_ID);

    const span = resolveSpan(
      TEST_SESSION_ID,
      messages,
      state,
      refFor(1),
      refFor(6),
    );
    assert.deepEqual(span.segment, { startIndex: 1, endIndex: 6 });
    assert.deepEqual(span.touchedBlocks, []);
  });

  it("throws on an unknown ref", () => {
    const messages = standardConversation();
    assignMessageRefs(TEST_SESSION_ID, messages);
    const state = getOrCreateSessionState(TEST_SESSION_ID);

    assert.throws(
      () => resolveSpan(TEST_SESSION_ID, messages, state, "m9999", refFor(1)),
      /不存在/,
    );
  });

  it("throws when the ref's message is absent from the raw array", () => {
    const messages = standardConversation();
    assignMessageRefs(TEST_SESSION_ID, messages);
    const state = getOrCreateSessionState(TEST_SESSION_ID);

    // Give u0 a ref, then drop it from the array (compacted away).
    const trimmed = messages.slice(1);
    assert.throws(
      () => resolveSpan(TEST_SESSION_ID, trimmed, state, refFor(0), refFor(2)),
      /不在当前会话/,
    );
  });

  it("expands a synthetic summary ref to the block's original span", () => {
    const messages = standardConversation();
    assignMessageRefs(TEST_SESSION_ID, messages);
    const state = getOrCreateSessionState(TEST_SESSION_ID);

    compressRange(
      TEST_SESSION_ID,
      messages,
      state,
      refFor(2),
      refFor(6),
      "第一段压缩摘要。",
      "第一段主题",
    );
    assignFoldedRefs(TEST_SESSION_ID, messages, state);
    const synthRef = "m0011";
    assert.equal(getMessageIdByRef(TEST_SESSION_ID, synthRef), "zoo-fold-b1");

    // Synthetic ref as the END endpoint → block span [2, 6), endIndex 6.
    const span = resolveSpan(
      TEST_SESSION_ID,
      messages,
      state,
      refFor(1),
      synthRef,
    );
    assert.deepEqual(span.segment, { startIndex: 1, endIndex: 6 });
    assert.deepEqual(
      span.touchedBlocks.map((b) => b.blockId),
      [1],
    );
  });

  it("throws on a stale ref pointing at a consumed block", () => {
    const messages = standardConversation();
    assignMessageRefs(TEST_SESSION_ID, messages);
    const state = getOrCreateSessionState(TEST_SESSION_ID);

    compressRange(
      TEST_SESSION_ID,
      messages,
      state,
      refFor(2),
      refFor(6),
      "第一段压缩摘要。",
      "第一段主题",
    );
    assignFoldedRefs(TEST_SESSION_ID, messages, state);
    const synthRef = "m0011";

    // Consume block 1 via a wider recompression.
    compressRange(
      TEST_SESSION_ID,
      messages,
      state,
      refFor(1),
      refFor(6),
      "更宽的压缩摘要。",
      "更宽主题",
    );

    assert.throws(
      () => resolveSpan(TEST_SESSION_ID, messages, state, synthRef, refFor(1)),
      /已被重新压缩/,
    );
  });

  it("throws on a ref pointing at a missing block", () => {
    const messages = [
      ...standardConversation(),
      makeUserMsg("zoo-fold-b99", "幽灵摘要"),
    ];
    assignMessageRefs(TEST_SESSION_ID, messages);
    const state = getOrCreateSessionState(TEST_SESSION_ID);

    assert.equal(getMessageIdByRef(TEST_SESSION_ID, "m0011"), "zoo-fold-b99");
    assert.throws(
      () => resolveSpan(TEST_SESSION_ID, messages, state, "m0011", refFor(1)),
      /已被重新压缩/,
    );
  });

  it("throws a format error on a malformed synthetic id suffix", () => {
    const messages = [
      ...standardConversation(),
      makeUserMsg("zoo-fold-bXYZ", "幽灵摘要"),
    ];
    assignMessageRefs(TEST_SESSION_ID, messages);
    const state = getOrCreateSessionState(TEST_SESSION_ID);

    assert.equal(getMessageIdByRef(TEST_SESSION_ID, "m0011"), "zoo-fold-bXYZ");
    assert.throws(
      () => resolveSpan(TEST_SESSION_ID, messages, state, "m0011", refFor(1)),
      /格式非法/,
    );
  });
});

// ===========================================================================
// validateRange
// ===========================================================================

describe("validateRange", () => {
  it("throws on reversed endpoint order", () => {
    const messages = standardConversation();
    assignMessageRefs(TEST_SESSION_ID, messages);
    const state = getOrCreateSessionState(TEST_SESSION_ID);

    const span = resolveSpan(
      TEST_SESSION_ID,
      messages,
      state,
      refFor(6),
      refFor(1),
    );
    assert.deepEqual(span.segment, { startIndex: 6, endIndex: 1 });
    assert.throws(
      () => validateRange(span, messages, state, CONFIG),
      /顺序颠倒/,
    );
  });

  it("throws when the range reaches the protection zone", () => {
    const messages = standardConversation();
    assignMessageRefs(TEST_SESSION_ID, messages);
    const state = getOrCreateSessionState(TEST_SESSION_ID);

    // Last user message u8 @ 8 → boundary 8; endIndex 10 > 8.
    const span = resolveSpan(
      TEST_SESSION_ID,
      messages,
      state,
      refFor(1),
      refFor(9),
    );
    assert.throws(
      () => validateRange(span, messages, state, CONFIG),
      /保护区域/,
    );
  });

  it("throws when the range contains the first user message", () => {
    const messages = standardConversation();
    assignMessageRefs(TEST_SESSION_ID, messages);
    const state = getOrCreateSessionState(TEST_SESSION_ID);

    const span = resolveSpan(
      TEST_SESSION_ID,
      messages,
      state,
      refFor(0),
      refFor(5),
    );
    assert.throws(
      () => validateRange(span, messages, state, CONFIG),
      /第一条用户消息/,
    );
  });

  it("throws on partial block overlap (anchor outside the range)", () => {
    const messages = standardConversation();
    assignMessageRefs(TEST_SESSION_ID, messages);
    const state = getOrCreateSessionState(TEST_SESSION_ID);

    // Block 1 covers [2, 6) with anchor u2 @ 2.
    compressRange(
      TEST_SESSION_ID,
      messages,
      state,
      refFor(2),
      refFor(6),
      "第一段压缩摘要。",
      "第一段主题",
    );

    // [4, 8) intersects the block's span but excludes its anchor.
    const span = resolveSpan(
      TEST_SESSION_ID,
      messages,
      state,
      refFor(4),
      refFor(8),
    );
    assert.throws(
      () => validateRange(span, messages, state, CONFIG),
      /部分重叠/,
    );
  });

  it("throws on partial overlap when the anchor is inside but the block extends beyond the range", () => {
    const messages = standardConversation();
    assignMessageRefs(TEST_SESSION_ID, messages);
    const state = getOrCreateSessionState(TEST_SESSION_ID);

    // Block 1 covers [2, 6) with anchor u2 @ 2.
    compressRange(
      TEST_SESSION_ID,
      messages,
      state,
      refFor(2),
      refFor(6),
      "第一段压缩摘要。",
      "第一段主题",
    );

    // [2, 5) contains the anchor (u2 @ 2) but cuts off a5 @ 5 — the block
    // is only partially covered and must not be consumed.
    const span = resolveSpan(
      TEST_SESSION_ID,
      messages,
      state,
      refFor(2),
      refFor(5),
    );
    assert.throws(
      () => validateRange(span, messages, state, CONFIG),
      /部分重叠/,
    );
  });

  it("throws on the phantom gate (segment below threshold)", () => {
    const messages: ContextMessageEntry[] = [
      makeUserMsg("u0", "开场"),
      makeAssistantMsg("a1", "好的"),
      makeUserMsg("u2", "继续"),
      makeAssistantMsg("a3", "收到"),
      makeUserMsg("u4", "明白"),
      makeAssistantMsg("a5", "完成"),
      makeUserMsg("u6", "最后问题"),
      makeAssistantMsg("a7", "回复完毕"),
    ];
    assignMessageRefs(TEST_SESSION_ID, messages);
    const state = getOrCreateSessionState(TEST_SESSION_ID);

    // [1, 5) is a handful of tokens — far below the 50-token threshold.
    const span = resolveSpan(
      TEST_SESSION_ID,
      messages,
      state,
      refFor(1),
      refFor(5),
    );
    assert.throws(
      () => validateRange(span, messages, state, CONFIG),
      /收益过低|低于压缩阈值/,
    );
  });
});

// ===========================================================================
// applyRange — plain range
// ===========================================================================

describe("applyRange — plain range", () => {
  it("creates a block for a valid plain range", () => {
    const messages = standardConversation();
    assignMessageRefs(TEST_SESSION_ID, messages);
    const state = getOrCreateSessionState(TEST_SESSION_ID);

    const summary = "用户请求执行命令，助手完成了操作。";
    const block = compressRange(
      TEST_SESSION_ID,
      messages,
      state,
      refFor(1),
      refFor(6),
      summary,
      "执行命令主题",
    );

    assert.equal(block.blockId, 1);
    assert.equal(block.active, true);
    assert.equal(block.title, "执行命令主题");
    assert.equal(block.anchorMessageId, "a1");
    assert.deepEqual(block.messageIds, ["a1", "u2", "a3", "u4", "a5"]);
    assert.ok(
      block.summary.startsWith(
        "[Compression Block b1] 执行命令主题 — 5 messages, ~",
      ),
    );
    // Plain range: header keeps the command-path format (no net
    // annotation) when no blocks are consumed.
    const headerLine = block.summary.split("\n")[0];
    assert.match(
      headerLine,
      /^\[Compression Block b1\] 执行命令主题 — 5 messages, ~\d+ in, ~\d+ out$/,
    );
    assert.ok(block.summary.includes(summary));
    assert.ok(!block.summary.includes(SUPERSEDED_BLOCKS_LEAD_IN));
    assert.ok(block.compressedTokens > 0);
    assert.ok(block.summaryTokens < block.compressedTokens);
    assert.equal(block.deactivatedAt, undefined);
    assert.equal(state.dirty, true);
  });
});

// ===========================================================================
// applyRange — consumption path
// ===========================================================================

describe("applyRange — cross-block consumption", () => {
  it("consumes a block addressed by its summary ref (deactivate + union + append)", () => {
    const messages = standardConversation();
    assignMessageRefs(TEST_SESSION_ID, messages);
    const state = getOrCreateSessionState(TEST_SESSION_ID);

    // First compression: [2, 6) → block 1 (anchor u2 @ 2).
    compressRange(
      TEST_SESSION_ID,
      messages,
      state,
      refFor(2),
      refFor(6),
      "第一段压缩摘要。",
      "第一段主题",
    );
    assignFoldedRefs(TEST_SESSION_ID, messages, state);
    const synthRef = "m0011";
    assert.equal(getMessageIdByRef(TEST_SESSION_ID, synthRef), "zoo-fold-b1");

    // Second compression: [1, 6) with the synthetic ref as the END endpoint.
    const span = resolveSpan(
      TEST_SESSION_ID,
      messages,
      state,
      refFor(1),
      synthRef,
    );
    validateRange(span, messages, state, CONFIG);

    const b2 = applyRange(
      state,
      span,
      messages,
      "第二次压缩摘要。",
      "第二次主题",
    );
    assert.equal(b2.blockId, 2);
    assert.equal(b2.title, "第二次主题");

    // Block 1 consumed: inactive with a deactivatedAt timestamp.
    const consumed = state.blocks.get("1");
    assert.ok(consumed !== undefined);
    assert.equal(consumed.active, false);
    assert.equal(typeof consumed.deactivatedAt, "number");

    // messageIds = union, ordered by array position.
    assert.deepEqual(b2.messageIds, ["a1", "u2", "a3", "u4", "a5"]);

    // Merged summary: header + model summary + superseded index lines.
    // The consumed block's full body is NOT appended — only a one-line
    // index entry carrying its title.
    assert.ok(
      b2.summary.startsWith(
        "[Compression Block b2] 第二次主题 — 5 messages, ~",
      ),
    );
    assert.ok(b2.summary.includes("第二次压缩摘要。"));
    assert.ok(b2.summary.includes(SUPERSEDED_BLOCKS_LEAD_IN));
    assert.ok(b2.summary.includes("--- b1: 第一段主题 ---"));
    assert.ok(!b2.summary.includes("第一段压缩摘要。"));

    // No double counting: consumed block's compressedTokens is subtracted.
    const { inTokens, outTokens } = segmentInOutTokens(messages, span.segment);
    assert.equal(
      b2.compressedTokens,
      inTokens + outTokens - consumed.compressedTokens,
    );

    // Header carries the truthful net figure when blocks are consumed:
    // `~X in, ~Y out (net ~Z after consumed blocks)` with Z the net
    // compressible tokens (recomputed independently of the stored value).
    const b2Header = b2.summary.split("\n")[0];
    assert.match(
      b2Header,
      /^\[Compression Block b2\] 第二次主题 — 5 messages, ~\d+ in, ~\d+ out \(net ~\d+ after consumed blocks\)$/,
    );
    assert.ok(
      b2Header.includes(
        `(net ~${inTokens + outTokens - consumed.compressedTokens} after consumed blocks)`,
      ),
      `expected net ~${inTokens + outTokens - consumed.compressedTokens} in header, got: ${b2Header}`,
    );
    assert.equal(state.dirty, true);
  });

  it("does not double-count tokens when recompressing over a previous block", () => {
    const messages = standardConversation();
    assignMessageRefs(TEST_SESSION_ID, messages);
    const state = getOrCreateSessionState(TEST_SESSION_ID);

    compressRange(
      TEST_SESSION_ID,
      messages,
      state,
      refFor(2),
      refFor(6),
      "第一段压缩摘要。",
      "第一段主题",
    );
    const b1 = state.blocks.get("1");
    assert.ok(b1 !== undefined);
    const b1CompressedTokens = b1.compressedTokens;

    // Wider recompression [1, 8) fully consumes block 1 via the
    // anchor-inside-range path (no synthetic endpoint).
    const span = resolveSpan(
      TEST_SESSION_ID,
      messages,
      state,
      refFor(1),
      refFor(8),
    );
    validateRange(span, messages, state, CONFIG);
    assert.deepEqual(
      span.touchedBlocks.map((b) => b.blockId),
      [1],
    );

    const b2 = applyRange(
      state,
      span,
      messages,
      "更宽的压缩摘要。",
      "更宽主题",
    );
    const { inTokens, outTokens } = segmentInOutTokens(messages, span.segment);
    assert.equal(
      b2.compressedTokens,
      inTokens + outTokens - b1CompressedTokens,
    );
    assert.ok(b2.compressedTokens > 0);
    // The consumed record is untouched apart from deactivation.
    assert.equal(b1.compressedTokens, b1CompressedTokens);
  });

  it("throws on negative benefit evaluated over the merged summary", () => {
    const messages = standardConversation();
    assignMessageRefs(TEST_SESSION_ID, messages);
    const state = getOrCreateSessionState(TEST_SESSION_ID);

    // Block 1: [2, 6) — a compact summary that passes block 1's own
    // negative-benefit gate.
    compressRange(
      TEST_SESSION_ID,
      messages,
      state,
      refFor(2),
      refFor(6),
      "第一段压缩摘要。",
      "第一段主题",
    );
    const b1 = state.blocks.get("1");
    assert.ok(b1 !== undefined);

    // Second compression [1, 6) consumes block 1.
    const span = resolveSpan(
      TEST_SESSION_ID,
      messages,
      state,
      refFor(1),
      refFor(6),
    );
    validateRange(span, messages, state, CONFIG);
    assert.deepEqual(
      span.touchedBlocks.map((b) => b.blockId),
      [1],
    );

    // Reconstruct the merged summary exactly as applyRange builds it and
    // prove the gate is evaluated on it.  The consumed body is NOT carried
    // over (only a one-line index entry), so the model summary itself must
    // push the merged text over the net benefit while the pre-merge gate
    // would still pass for a short summary.
    const longModelSummary = "y".repeat(750);
    const { inTokens, outTokens } = segmentInOutTokens(messages, span.segment);
    const netBenefit = inTokens + outTokens - b1.compressedTokens;
    const merged = [
      `${BLOCK_HEADER_TEMPLATE} 长主题 — 5 messages, ~${inTokens} in, ~${outTokens} out (net ~${netBenefit} after consumed blocks)`,
      longModelSummary,
      SUPERSEDED_BLOCKS_LEAD_IN,
      "--- b1: 第一段主题 ---",
    ].join("\n");
    assert.ok(
      estimateTokenCount(merged) >= netBenefit,
      `merged summary (${estimateTokenCount(merged)}) must not be below net benefit (${netBenefit})`,
    );

    assert.throws(
      () => applyRange(state, span, messages, longModelSummary, "长主题"),
      /收益为负/,
    );

    // Failure safety: nothing was mutated by the rejected compression.
    assert.equal(b1.active, true);
    assert.equal(b1.deactivatedAt, undefined);
    assert.equal(state.blocks.size, 1);
  });

  it("throws a dedicated no-new-content error when the range covers only an existing block's span", () => {
    const messages = standardConversation();
    assignMessageRefs(TEST_SESSION_ID, messages);
    const state = getOrCreateSessionState(TEST_SESSION_ID);

    // Block 1 covers [2, 6); recompressing exactly that span adds no new
    // compressible content (compressedTokens === 0).
    compressRange(
      TEST_SESSION_ID,
      messages,
      state,
      refFor(2),
      refFor(6),
      "第一段压缩摘要。",
      "第一段主题",
    );

    const span = resolveSpan(
      TEST_SESSION_ID,
      messages,
      state,
      refFor(2),
      refFor(6),
    );
    validateRange(span, messages, state, CONFIG);
    assert.deepEqual(
      span.touchedBlocks.map((b) => b.blockId),
      [1],
    );

    // Prove the precondition: net compressible tokens are exactly 0.
    const { inTokens, outTokens } = segmentInOutTokens(messages, span.segment);
    const consumedTokens = span.touchedBlocks[0].compressedTokens;
    assert.equal(inTokens + outTokens - consumedTokens, 0);

    // The dedicated error fires — distinct from the generic
    // negative-benefit message — and nothing is mutated.
    assert.throws(
      () => applyRange(state, span, messages, "重复压缩摘要。", "重复主题"),
      (err: unknown) =>
        err instanceof Error &&
        /没有带来新的可压缩内容/.test(err.message) &&
        /均已被现有压缩块覆盖/.test(err.message) &&
        !/收益为负/.test(err.message),
    );
    const b1 = state.blocks.get("1");
    assert.ok(b1 !== undefined);
    assert.equal(b1.active, true);
    assert.equal(b1.deactivatedAt, undefined);
    assert.equal(state.blocks.size, 1);
  });

  it("recompresses starting at a consumed block's summary ref (anchor self-collision)", () => {
    const messages = standardConversation();
    assignMessageRefs(TEST_SESSION_ID, messages);
    const state = getOrCreateSessionState(TEST_SESSION_ID);

    // Block 1 covers [2, 6) anchored at u2 (index 2).
    compressRange(
      TEST_SESSION_ID,
      messages,
      state,
      refFor(2),
      refFor(6),
      "第一段压缩摘要。",
      "第一段主题",
    );
    assignFoldedRefs(TEST_SESSION_ID, messages, state);
    const synthRef = "m0011";
    assert.equal(getMessageIdByRef(TEST_SESSION_ID, synthRef), "zoo-fold-b1");

    // Second compression starts AT block 1's summary ref (the natural
    // extend-the-compressed-region flow) and ends beyond it: startIndex
    // resolves to block 1's anchor index 2.
    const span = resolveSpan(
      TEST_SESSION_ID,
      messages,
      state,
      synthRef,
      refFor(8),
    );
    validateRange(span, messages, state, CONFIG);
    assert.deepEqual(
      span.touchedBlocks.map((b) => b.blockId),
      [1],
    );

    // The touched (to-be-consumed) block is excluded from the
    // createBlock idempotency check → creation succeeds at the same
    // anchor message id.
    const b2 = applyRange(state, span, messages, "延伸压缩摘要。", "延伸主题");
    assert.equal(b2.blockId, 2);
    assert.equal(b2.anchorMessageId, "u2");
    assert.equal(b2.title, "延伸主题");

    // Old block consumed: inactive with a deactivatedAt timestamp.
    const consumed = state.blocks.get("1");
    assert.ok(consumed !== undefined);
    assert.equal(consumed.active, false);
    assert.equal(typeof consumed.deactivatedAt, "number");

    // messageIds = union of the range and the consumed block, in array
    // position order.
    assert.deepEqual(b2.messageIds, ["u2", "a3", "u4", "a5", "u6", "a7"]);

    // Merged summary: superseded index entry with the consumed block's
    // title; the consumed block's full body is NOT carried over.
    assert.ok(b2.summary.includes(SUPERSEDED_BLOCKS_LEAD_IN));
    assert.ok(b2.summary.includes("--- b1: 第一段主题 ---"));
    assert.ok(!b2.summary.includes("第一段压缩摘要。"));

    // No double counting: the consumed block's compressedTokens is
    // subtracted from the range's gross estimate.
    const { inTokens, outTokens } = segmentInOutTokens(messages, span.segment);
    assert.equal(
      b2.compressedTokens,
      inTokens + outTokens - consumed.compressedTokens,
    );
    assert.equal(state.dirty, true);
  });

  it("absorbs a fully-covered inactive block at the anchor (stale record no longer blocks re-creation)", () => {
    const messages = standardConversation();
    assignMessageRefs(TEST_SESSION_ID, messages);
    const state = getOrCreateSessionState(TEST_SESSION_ID);

    // Block 1 covers [2, 6) anchored at u2 (index 2).
    compressRange(
      TEST_SESSION_ID,
      messages,
      state,
      refFor(2),
      refFor(6),
      "第一段压缩摘要。",
      "第一段主题",
    );
    const b1 = state.blocks.get("1");
    assert.ok(b1 !== undefined);

    // Simulate a stale block: deactivated without being merged.  The
    // range [2, 8) FULLY covers its messages, so the record is carried
    // on coveredInactiveBlocks and excluded from the anchor check instead
    // of spuriously colliding.
    b1.active = false;

    const span = resolveSpan(
      TEST_SESSION_ID,
      messages,
      state,
      refFor(2),
      refFor(8),
    );
    validateRange(span, messages, state, CONFIG);
    assert.deepEqual(span.touchedBlocks, []);
    assert.deepEqual(
      span.coveredInactiveBlocks.map((b) => b.blockId),
      [1],
    );

    // Re-creation at the shared anchor succeeds; the inactive record is
    // netted out and gets an index line, but its deactivatedAt is untouched.
    const b2 = applyRange(state, span, messages, "新摘要。", "新主题");
    assert.equal(b2.blockId, 2);
    assert.equal(b2.anchorMessageId, "u2");
    const { inTokens, outTokens } = segmentInOutTokens(messages, span.segment);
    assert.equal(
      b2.compressedTokens,
      inTokens + outTokens - b1.compressedTokens,
    );
    assert.ok(b2.summary.includes("--- b1: 第一段主题 ---"));
    assert.equal(b1.active, false);
    assert.equal(b1.deactivatedAt, undefined);
  });

  it("still fails loudly when a partially-covered inactive block occupies the anchor", () => {
    const messages = standardConversation();
    assignMessageRefs(TEST_SESSION_ID, messages);
    const state = getOrCreateSessionState(TEST_SESSION_ID);

    // Block 1 covers [2, 6) anchored at u2 (index 2).
    compressRange(
      TEST_SESSION_ID,
      messages,
      state,
      refFor(2),
      refFor(6),
      "第一段压缩摘要。",
      "第一段主题",
    );
    const b1 = state.blocks.get("1");
    assert.ok(b1 !== undefined);

    // Deactivated without being merged.  [2, 5) covers the anchor (u2)
    // but cuts off the tail (a5) → the block is only PARTIALLY covered
    // and therefore ignored entirely — it is NOT excluded from the
    // anchor-idempotency check, so re-creation at u2 still fails loudly.
    b1.active = false;

    const span = resolveSpan(
      TEST_SESSION_ID,
      messages,
      state,
      refFor(2),
      refFor(5),
    );
    validateRange(span, messages, state, CONFIG);
    assert.deepEqual(span.touchedBlocks, []);
    assert.deepEqual(span.coveredInactiveBlocks, []);

    assert.throws(
      () => applyRange(state, span, messages, "摘要", "摘要主题"),
      /锚点/,
    );
    assert.equal(state.blocks.size, 1);
    assert.equal(b1.active, false);
  });

  it("appends multiple consumed blocks ordered by anchor position", () => {
    const messages: ContextMessageEntry[] = [
      makeUserMsg("u0", "开场问题"),
      makeToolMsg("a1", "bash", "c1", LONG_OUTPUT),
      makeUserMsg("u2", "第二段请求"),
      makeToolMsg("a3", "bash", "c3", LONG_OUTPUT),
      makeUserMsg("u4", "第四段请求"),
      makeToolMsg("a5", "bash", "c5", LONG_OUTPUT),
      makeUserMsg("u6", "第六段请求"),
      makeToolMsg("a7", "bash", "c7", LONG_OUTPUT),
      makeUserMsg("u8", "第八段请求"),
      makeToolMsg("a9", "bash", "c9", LONG_OUTPUT),
      makeUserMsg("u10", "第十段请求"),
      makeToolMsg("a11", "bash", "c11", LONG_OUTPUT),
      makeUserMsg("u12", "最后一个问题"),
      makeAssistantMsg("a13", "回答完毕"),
    ];
    assignMessageRefs(TEST_SESSION_ID, messages);
    const state = getOrCreateSessionState(TEST_SESSION_ID);

    // Block 1 (id 1) anchored at index 4, block 2 (id 2) anchored at
    // index 2 — created in REVERSE anchor order so the map iteration
    // yields touchedBlocks unsorted by anchor position.
    compressRange(
      TEST_SESSION_ID,
      messages,
      state,
      refFor(4),
      refFor(7),
      "第一块摘要。",
      "第一块主题",
    );
    compressRange(
      TEST_SESSION_ID,
      messages,
      state,
      refFor(2),
      refFor(4),
      "第二块摘要。",
      "第二块主题",
    );

    // Third compression [1, 9) consumes both blocks.
    const span = resolveSpan(
      TEST_SESSION_ID,
      messages,
      state,
      refFor(1),
      refFor(9),
    );
    validateRange(span, messages, state, CONFIG);
    const touched = span.touchedBlocks.map((b) => b.blockId);
    assert.deepEqual(touched, [1, 2]); // map order: block 1 (anchor 4) first.

    const b3 = applyRange(state, span, messages, "第三块摘要。", "第三块主题");
    assert.equal(b3.title, "第三块主题");

    // Index entries sorted by blockId: b1 before b2, regardless of the
    // map iteration order.  Bodies are NOT carried over — only the
    // one-line index entries with each consumed block's title.
    assert.ok(b3.summary.includes(SUPERSEDED_BLOCKS_LEAD_IN));
    assert.ok(
      b3.summary.indexOf("--- b1: 第一块主题 ---") <
        b3.summary.indexOf("--- b2: 第二块主题 ---"),
    );
    assert.ok(!b3.summary.includes("第二块摘要。"));
    assert.ok(!b3.summary.includes("第一块摘要。"));

    // messageIds = union of range + both blocks, array-position order.
    assert.deepEqual(b3.messageIds, [
      "a1",
      "u2",
      "a3",
      "u4",
      "a5",
      "u6",
      "a7",
      "u8",
    ]);
    assert.equal(state.blocks.get("1")?.active, false);
    assert.equal(state.blocks.get("2")?.active, false);
  });

  it("renders a graceful placeholder for a consumed block without a title", () => {
    const messages = standardConversation();
    assignMessageRefs(TEST_SESSION_ID, messages);
    const state = getOrCreateSessionState(TEST_SESSION_ID);

    // Block 1 covers [2, 6); simulate a dev-era block persisted without a
    // title (read back with an undefined title).
    compressRange(
      TEST_SESSION_ID,
      messages,
      state,
      refFor(2),
      refFor(6),
      "第一段压缩摘要。",
      "第一段主题",
    );
    const b1 = state.blocks.get("1");
    assert.ok(b1 !== undefined);
    b1.title = undefined;

    const span = resolveSpan(
      TEST_SESSION_ID,
      messages,
      state,
      refFor(1),
      refFor(6),
    );
    validateRange(span, messages, state, CONFIG);
    const b2 = applyRange(
      state,
      span,
      messages,
      "第二次压缩摘要。",
      "第二次主题",
    );
    assert.ok(b2.summary.includes("--- b1: （无标题） ---"));
    assert.ok(!b2.summary.includes("--- b1:  ---"));
  });

  it("does not resurrect consumed blocks via syncBlocks", () => {
    const messages = standardConversation();
    assignMessageRefs(TEST_SESSION_ID, messages);
    const state = getOrCreateSessionState(TEST_SESSION_ID);

    compressRange(
      TEST_SESSION_ID,
      messages,
      state,
      refFor(2),
      refFor(6),
      "第一段压缩摘要。",
      "第一段主题",
    );
    const span = resolveSpan(
      TEST_SESSION_ID,
      messages,
      state,
      refFor(1),
      refFor(6),
    );
    validateRange(span, messages, state, CONFIG);
    const b2 = applyRange(
      state,
      span,
      messages,
      "更宽的压缩摘要。",
      "更宽主题",
    );
    assert.equal(b2.blockId, 2);

    const b1 = state.blocks.get("1");
    assert.ok(b1 !== undefined);
    assert.equal(b1.active, false);

    // Fold-layer liveness sync must leave the consumed block dead.
    state.dirty = false;
    syncBlocks(state, messages);

    assert.equal(state.blocks.get("1")?.active, false);
    assert.equal(state.blocks.get("2")?.active, true);
    assert.equal(state.dirty, false);
  });
});

// ===========================================================================
// gen-3 recompression — inactive predecessor blocks
// ===========================================================================

/**
 * 14-message conversation for the gen-3 chain:
 * b1 [2, 6) is consumed by b2 [2, 10); the gen-3 range re-covers b2's whole
 * span plus newer content.  Indices: u0=0 a1=1 u2=2 a3=3 u4=4 a5=5 u6=6
 * a7=7 u8=8 a9=9 u10=10 a11=11 u12=12 a13=13.  Last user u12 @ 12 →
 * protection boundary 12, so ranges may end at most at index 12.
 */
function gen3Conversation(): ContextMessageEntry[] {
  return [
    makeUserMsg("u0", "开场问题"),
    makeToolMsg("a1", "bash", "c1", LONG_OUTPUT),
    makeUserMsg("u2", "第二段请求"),
    makeToolMsg("a3", "bash", "c3", LONG_OUTPUT),
    makeUserMsg("u4", "第四段请求"),
    makeToolMsg("a5", "bash", "c5", LONG_OUTPUT),
    makeUserMsg("u6", "第六段请求"),
    makeToolMsg("a7", "bash", "c7", LONG_OUTPUT),
    makeUserMsg("u8", "第八段请求"),
    makeToolMsg("a9", "bash", "c9", LONG_OUTPUT),
    makeUserMsg("u10", "第十段请求"),
    makeToolMsg("a11", "bash", "c11", LONG_OUTPUT),
    makeUserMsg("u12", "最后一个问题"),
    makeAssistantMsg("a13", "回答完毕"),
  ];
}

/**
 * Build the gen-3 chain: b1 [2, 6) then b2 [2, 10) consuming b1 via b1's
 * synthetic summary ref (both anchored at u2).  Returns the raw messages,
 * the state, both predecessor blocks, and b2's synthetic summary ref for
 * the gen-3 range endpoints.
 */
function setupGen3Chain(): {
  messages: ContextMessageEntry[];
  state: SessionState;
  b1: CompressionBlock;
  b2: CompressionBlock;
  b2SynthRef: string;
} {
  const messages = gen3Conversation();
  assignMessageRefs(TEST_SESSION_ID, messages);
  const state = getOrCreateSessionState(TEST_SESSION_ID);

  // b1: [2, 6) anchored at u2.
  compressRange(
    TEST_SESSION_ID,
    messages,
    state,
    refFor(2),
    refFor(6),
    "第一段压缩摘要。",
    "第一段主题",
  );
  const b1 = state.blocks.get("1");
  assert.ok(b1 !== undefined);
  assignFoldedRefs(TEST_SESSION_ID, messages, state);
  const b1SynthRef = "m0015"; // 14 raw messages (m0001..m0014) + zoo-fold-b1.
  assert.equal(getMessageIdByRef(TEST_SESSION_ID, b1SynthRef), "zoo-fold-b1");

  // b2: [2, 10) starting at b1's summary ref — consumes b1, same anchor u2.
  compressRange(
    TEST_SESSION_ID,
    messages,
    state,
    b1SynthRef,
    refFor(10),
    "第二次压缩摘要。",
    "第二次主题",
  );
  const b2 = state.blocks.get("2");
  assert.ok(b2 !== undefined);
  assert.equal(b2.active, true);
  assert.equal(b2.anchorMessageId, "u2");
  assignFoldedRefs(TEST_SESSION_ID, messages, state);
  const b2SynthRef = "m0016"; // zoo-fold-b2 follows b1's synthetic ref.
  assert.equal(getMessageIdByRef(TEST_SESSION_ID, b2SynthRef), "zoo-fold-b2");

  return { messages, state, b1, b2, b2SynthRef };
}

describe("gen-3 recompression (inactive predecessor blocks)", () => {
  it("re-creates at the shared anchor without a spurious collision", () => {
    const { messages, state, b2SynthRef } = setupGen3Chain();

    // Gen-3 range: b2's summary ref as the start, covering beyond b2's end.
    const span = resolveSpan(
      TEST_SESSION_ID,
      messages,
      state,
      b2SynthRef,
      refFor(12),
    );
    validateRange(span, messages, state, CONFIG);
    assert.deepEqual(
      span.touchedBlocks.map((b) => b.blockId),
      [2],
    );
    assert.deepEqual(
      span.coveredInactiveBlocks.map((b) => b.blockId),
      [1],
    );

    // The inactive b1 (same anchor u2) no longer collides: it is excluded
    // from the anchor-idempotency check together with the touched b2.
    const b3 = applyRange(
      state,
      span,
      messages,
      "第三次压缩摘要。",
      "第三次主题",
    );
    assert.equal(b3.blockId, 3);
    assert.equal(b3.anchorMessageId, "u2");
    assert.equal(b3.title, "第三次主题");
    // Union = range messages (which already contain every message id of
    // the fully-covered inactive predecessor), in array-position order.
    assert.deepEqual(b3.messageIds, [
      "u2",
      "a3",
      "u4",
      "a5",
      "u6",
      "a7",
      "u8",
      "a9",
      "u10",
      "a11",
    ]);
  });

  it("nets out BOTH predecessor blocks' compressedTokens (exact arithmetic)", () => {
    const { messages, state, b1, b2, b2SynthRef } = setupGen3Chain();

    const span = resolveSpan(
      TEST_SESSION_ID,
      messages,
      state,
      b2SynthRef,
      refFor(12),
    );
    validateRange(span, messages, state, CONFIG);
    const b3 = applyRange(
      state,
      span,
      messages,
      "第三次压缩摘要。",
      "第三次主题",
    );

    const { inTokens, outTokens } = segmentInOutTokens(messages, span.segment);
    assert.equal(
      b3.compressedTokens,
      inTokens + outTokens - b2.compressedTokens - b1.compressedTokens,
    );
    assert.ok(b3.compressedTokens > 0);

    // Invariant: Σ over ALL block records == the raw tokens of the range —
    // no double counting at any generation depth.
    const sumOverAllRecords = [...state.blocks.values()].reduce(
      (s, b) => s + b.compressedTokens,
      0,
    );
    assert.equal(sumOverAllRecords, inTokens + outTokens);
  });

  it("lists both superseded blocks in the index, sorted by blockId", () => {
    const { messages, state, b2SynthRef } = setupGen3Chain();

    const span = resolveSpan(
      TEST_SESSION_ID,
      messages,
      state,
      b2SynthRef,
      refFor(12),
    );
    validateRange(span, messages, state, CONFIG);
    const b3 = applyRange(
      state,
      span,
      messages,
      "第三次压缩摘要。",
      "第三次主题",
    );

    assert.ok(b3.summary.includes(SUPERSEDED_BLOCKS_LEAD_IN));
    const idxB1 = b3.summary.indexOf("--- b1: 第一段主题 ---");
    const idxB2 = b3.summary.indexOf("--- b2: 第二次主题 ---");
    assert.ok(idxB1 >= 0, "b1 index line missing");
    assert.ok(idxB2 >= 0, "b2 index line missing");
    assert.ok(idxB1 < idxB2, "b1 must sort before b2");
    assert.ok(!b3.summary.includes("第一段压缩摘要。"));
    assert.ok(!b3.summary.includes("第二次压缩摘要。"));
  });

  it("fires the no-new-content gate for a range equal to the consumed block's exact span", () => {
    const { messages, state, b1, b2, b2SynthRef } = setupGen3Chain();

    // Range exactly [2, 10) = b2's span (b2's summary ref as both endpoints).
    const span = resolveSpan(
      TEST_SESSION_ID,
      messages,
      state,
      b2SynthRef,
      b2SynthRef,
    );
    validateRange(span, messages, state, CONFIG);
    assert.deepEqual(span.segment, { startIndex: 2, endIndex: 10 });
    assert.deepEqual(
      span.touchedBlocks.map((b) => b.blockId),
      [2],
    );
    assert.deepEqual(
      span.coveredInactiveBlocks.map((b) => b.blockId),
      [1],
    );

    // Prove the precondition: net == 0 once BOTH predecessors are netted.
    const { inTokens, outTokens } = segmentInOutTokens(messages, span.segment);
    assert.equal(
      inTokens + outTokens - b2.compressedTokens - b1.compressedTokens,
      0,
    );

    // The dedicated no-new-content error fires — loud, no block created.
    assert.throws(
      () => applyRange(state, span, messages, "重复压缩摘要。", "重复主题"),
      (err: unknown) =>
        err instanceof Error &&
        /没有带来新的可压缩内容/.test(err.message) &&
        !/收益为负/.test(err.message),
    );
    assert.equal(state.blocks.size, 2);
    assert.equal(b1.active, false);
    assert.equal(b2.active, true);
  });

  it("ignores a partially-covered inactive block (no error, no net subtraction)", () => {
    const messages = standardConversation();
    assignMessageRefs(TEST_SESSION_ID, messages);
    const state = getOrCreateSessionState(TEST_SESSION_ID);

    // b1: [2, 6) anchored at u2; deactivated without consumption so its
    // content becomes ordinary view content again.
    compressRange(
      TEST_SESSION_ID,
      messages,
      state,
      refFor(2),
      refFor(6),
      "第一段压缩摘要。",
      "第一段主题",
    );
    const b1 = state.blocks.get("1");
    assert.ok(b1 !== undefined);
    b1.active = false;

    // [4, 8) intersects b1's span but only covers part of it (u4, a5
    // inside; u2, a3 outside).
    const span = resolveSpan(
      TEST_SESSION_ID,
      messages,
      state,
      refFor(4),
      refFor(8),
    );
    validateRange(span, messages, state, CONFIG);

    // Partially covered inactive block: ignored entirely.
    assert.deepEqual(span.touchedBlocks, []);
    assert.deepEqual(span.coveredInactiveBlocks, []);

    // No subtraction: the net equals the raw segment estimate.
    const b2 = applyRange(state, span, messages, "新摘要。", "新主题");
    const { inTokens, outTokens } = segmentInOutTokens(messages, span.segment);
    assert.equal(b2.compressedTokens, inTokens + outTokens);
    assert.equal(b2.anchorMessageId, "u4");
    assert.ok(!b2.summary.includes(SUPERSEDED_BLOCKS_LEAD_IN));
    assert.equal(b1.deactivatedAt, undefined);
  });

  it("does not touch the deactivatedAt of an already-inactive predecessor", () => {
    const { messages, state, b1, b2, b2SynthRef } = setupGen3Chain();
    const b1DeactivatedAt = b1.deactivatedAt;
    assert.equal(typeof b1DeactivatedAt, "number");
    assert.equal(b2.deactivatedAt, undefined);

    const span = resolveSpan(
      TEST_SESSION_ID,
      messages,
      state,
      b2SynthRef,
      refFor(12),
    );
    validateRange(span, messages, state, CONFIG);
    const b3 = applyRange(
      state,
      span,
      messages,
      "第三次压缩摘要。",
      "第三次主题",
    );
    assert.equal(b3.blockId, 3);

    // b1 stays untouched (already inactive); b2 is consumed by b3.
    assert.equal(b1.deactivatedAt, b1DeactivatedAt);
    assert.equal(b1.active, false);
    assert.equal(b2.active, false);
    assert.equal(typeof b2.deactivatedAt, "number");
  });
});

// ===========================================================================
// deactivatedAt persistence
// ===========================================================================

describe("deactivatedAt persistence", () => {
  it("round-trips deactivatedAt through save/load", () => {
    const messages = standardConversation();
    assignMessageRefs(TEST_SESSION_ID, messages);
    const state = getOrCreateSessionState(TEST_SESSION_ID);

    compressRange(
      TEST_SESSION_ID,
      messages,
      state,
      refFor(2),
      refFor(6),
      "第一段压缩摘要。",
      "第一段主题",
    );
    const span = resolveSpan(
      TEST_SESSION_ID,
      messages,
      state,
      refFor(1),
      refFor(6),
    );
    validateRange(span, messages, state, CONFIG);
    applyRange(state, span, messages, "更宽的压缩摘要。", "更宽主题");

    const consumed = state.blocks.get("1");
    assert.ok(consumed !== undefined);
    assert.equal(typeof consumed.deactivatedAt, "number");
    const savedDeactivatedAt = consumed.deactivatedAt;

    saveSessionState(TEST_SESSION_ID, state);
    removeSession(TEST_SESSION_ID);
    _clearAllSessionsForTesting();

    const restored = loadSessionState(TEST_SESSION_ID);
    assert.ok(restored !== null);
    const b1 = restored.blocks.get("1");
    assert.ok(b1 !== undefined);
    assert.equal(b1.active, false);
    assert.equal(b1.deactivatedAt, savedDeactivatedAt);
    assert.equal(b1.title, "第一段主题");

    // Active blocks keep deactivatedAt undefined (strict validation intact).
    const b2 = restored.blocks.get("2");
    assert.ok(b2 !== undefined);
    assert.equal(b2.active, true);
    assert.equal(b2.deactivatedAt, undefined);
    assert.equal(b2.title, "更宽主题");
  });
});
