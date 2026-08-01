/**
 * Range-mode compression core — model-driven compression of a contiguous
 * visible-history span.
 *
 * Pure logic module with zero framework dependencies.  The tool adapter
 * layer (opencode tool hook) fetches the raw messages, ensures the ref
 * registry is populated, then drives this pipeline:
 *
 * 1. `resolveSpan` — endpoint refs → `[startIndex, endIndex)` segment.
 *    A ref pointing at a synthetic summary message resolves to the covered
 *    block's original span (cross-block consumption).
 * 2. `validateRange` — ordering / protection-zone / first-user / partial
 *    overlap / phantom gates.  Fully-covered active blocks are recorded on
 *    `span.touchedBlocks` for consumption; fully-covered INACTIVE blocks
 *    (superseded by an earlier generation) are recorded on
 *    `span.coveredInactiveBlocks` so their compressed tokens are netted out
 *    and their anchors are not mistaken for collisions.
 * 3. `applyRange` — deactivates consumed blocks, merges the model summary
 *    with one-line index entries of the consumed blocks, accounts tokens
 *    without double counting, and creates the new block.
 *
 * **Core semantic:** compression = replacing a contiguous span of visible
 * history with one summary.  Endpoints are addressed by mNNNN refs only
 * (never bN block ids).  All errors are loud Chinese guidance messages —
 * the model self-corrects by re-picking refs.
 *
 * @module
 */

import { type ContextMessageEntry, estimateTokenCount } from "../metrics.js";
import { type CompressionBlock, createBlock } from "./blocks.js";
import {
  BLOCK_HEADER_TEMPLATE,
  type CompressionConfig,
  type CompressionSegment,
  estimateSegmentTokens,
  firstUserMessageIndex,
  lastUserMessageIndex,
  segmentInOutTokens,
  tokenBoundary,
} from "./compress.js";
import type { SessionState } from "./marks.js";
import { getMessageIdByRef } from "./message-refs.js";
import { protectedBoundary } from "./producers/shared.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Prefix of synthetic summary-message ids (`zoo-fold-b<N>`). */
const SYNTHETIC_PREFIX = "zoo-fold-b";

/**
 * Fixed lead-in separating the model summary from the one-line index
 * entries of consumed blocks in the merged block summary.
 */
export const SUPERSEDED_BLOCKS_LEAD_IN = "=== Superseded Blocks ===";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Result of endpoint resolution.
 *
 * - `segment` — the resolved span using the existing `[startIndex, endIndex)`
 *   exclusive-end convention.
 * - `touchedBlocks` — active blocks addressed via their synthetic summary
 *   refs (or added later by `validateRange`); consumed by `applyRange`.
 * - `coveredInactiveBlocks` — inactive (superseded) blocks whose messages are
 *   fully covered by the range, discovered by `validateRange`.  Not consumed
 *   (already inactive) but their compressed tokens are netted out of the new
 *   block and their anchors are excluded from the collision check.
 */
export interface ResolvedSpan {
  segment: CompressionSegment;
  touchedBlocks: CompressionBlock[];
  coveredInactiveBlocks: CompressionBlock[];
}

// ---------------------------------------------------------------------------
// resolveSpan
// ---------------------------------------------------------------------------

/**
 * Resolve a single endpoint ref to a message-array index.
 *
 * ref → `getMessageIdByRef` → raw message id.  A `zoo-fold-b<N>` id maps to
 * the covered block's original span (first covered index for the start
 * endpoint, last covered index + 1 for the end endpoint) and records the
 * block on `touchedBlocks`.  Unknown refs, stale blocks, and messages absent
 * from the raw array all throw loud Chinese guidance errors.
 *
 * @param sessionId - The session identifier (ref registry scope).
 * @param messages - The raw session messages array (no synthetic entries).
 * @param state - The session state (blocks map for span resolution).
 * @param ref - The endpoint ref (e.g. `"m0003"`).
 * @param touchedBlocks - Accumulator for blocks addressed by this ref.
 * @param kind - Whether the ref addresses the start or end endpoint.
 * @returns The resolved index in the messages array.
 */
function resolveEndpoint(
  sessionId: string,
  messages: ContextMessageEntry[],
  state: SessionState,
  ref: string,
  touchedBlocks: CompressionBlock[],
  kind: "start" | "end",
): number {
  const msgId = getMessageIdByRef(sessionId, ref);
  if (msgId === undefined) {
    throw new Error(
      `ref "${ref}" 不存在。压缩工具只接受当前会话中可见消息的 ref（如 "m0001"、"m0012"），请从当前可见消息中选择。`,
    );
  }

  // Synthetic summary-message id → resolve to the block's original span.
  if (msgId.startsWith(SYNTHETIC_PREFIX)) {
    const blockId = parseInt(msgId.slice(SYNTHETIC_PREFIX.length), 10);
    if (Number.isNaN(blockId)) {
      throw new Error(
        `ref "${ref}" 指向的合成摘要 id "${msgId}" 格式非法（应为 "zoo-fold-b<N>" 形式）。请选择当前可见消息的 ref 或该压缩块的摘要 ref。`,
      );
    }
    const block = state.blocks.get(String(blockId));
    if (!block?.active) {
      throw new Error(
        `ref "${ref}" 指向的压缩块 b${blockId} 的内容已被重新压缩，请使用更新的摘要 ref 或选择该块以外的可见消息 ref。`,
      );
    }

    // Map the block's covered message ids to raw-array indices.
    const covered = new Set(block.messageIds);
    const indices: number[] = [];
    for (let i = 0; i < messages.length; i++) {
      if (covered.has(messages[i].info.id)) indices.push(i);
    }
    if (indices.length === 0) {
      throw new Error(
        `压缩块 b${block.blockId} 覆盖的消息不在当前会话消息中，无法解析其原始范围。`,
      );
    }

    if (!touchedBlocks.some((b) => b.blockId === block.blockId)) {
      touchedBlocks.push(block);
    }
    return kind === "start" ? indices[0] : indices[indices.length - 1] + 1;
  }

  // Plain message id → its position in the raw array.
  const idx = messages.findIndex((m) => m.info.id === msgId);
  if (idx === -1) {
    throw new Error(
      `ref "${ref}" 对应的消息（${msgId}）不在当前会话中，无法解析其位置，请选择当前可见的消息 ref。`,
    );
  }
  return idx;
}

/**
 * Resolve two endpoint refs into a contiguous `[startIndex, endIndex)`
 * segment, expanding synthetic summary refs to the covered block spans.
 *
 * @param sessionId - The session identifier (ref registry scope).
 * @param messages - The raw session messages array (no synthetic entries).
 * @param state - The session state (blocks map for span resolution).
 * @param startRef - The start endpoint ref.
 * @param endRef - The end endpoint ref (exclusive).
 * @returns The resolved segment plus blocks touched by synthetic refs.
 */
export function resolveSpan(
  sessionId: string,
  messages: ContextMessageEntry[],
  state: SessionState,
  startRef: string,
  endRef: string,
): ResolvedSpan {
  const touchedBlocks: CompressionBlock[] = [];
  const startIndex = resolveEndpoint(
    sessionId,
    messages,
    state,
    startRef,
    touchedBlocks,
    "start",
  );
  const endIndex = resolveEndpoint(
    sessionId,
    messages,
    state,
    endRef,
    touchedBlocks,
    "end",
  );
  return {
    segment: { startIndex, endIndex },
    touchedBlocks,
    coveredInactiveBlocks: [],
  };
}

// ---------------------------------------------------------------------------
// validateRange
// ---------------------------------------------------------------------------

/**
 * Validate a resolved span against every compression gate.
 *
 * Throws loud Chinese guidance errors on: reversed endpoint order (refs are
 * addresses, not sequence numbers), protection-zone violation (triple
 * boundary shared with the command path), a range containing the session's
 * first user message, partial overlap with an active block, and the phantom
 * gate (segment below `config.thresholdTokens`).
 *
 * Active blocks whose message ids intersect the range are consumed when the
 * range FULLY covers every message id of the block that is still present in
 * the view — the block is appended to `span.touchedBlocks` (deduplicated).
 * Otherwise the overlap is partial (the anchor inside or not) and rejected.
 * Ignored messages inside the range are treated positionally and simply
 * included.
 *
 * INACTIVE blocks get the same full-coverage test but a different outcome:
 * a fully-covered inactive block is NOT consumed (it is already inactive) —
 * it is carried on `span.coveredInactiveBlocks` so `applyRange` can net out
 * its compressed tokens and exclude its anchor from the collision check.  A
 * partially-covered inactive block is ignored entirely: its messages are
 * ordinary view content again (no error, no accounting).
 *
 * @param span - The resolved span (touchedBlocks / coveredInactiveBlocks
 *   are mutated).
 * @param messages - The raw session messages array.
 * @param state - The session state (blocks map).
 * @param config - Compression configuration (protection + threshold).
 */
export function validateRange(
  span: ResolvedSpan,
  messages: ContextMessageEntry[],
  state: SessionState,
  config: CompressionConfig,
): void {
  const { startIndex, endIndex } = span.segment;

  // ── Reversed order ──────────────────────────────────────────────────
  if (startIndex >= endIndex) {
    throw new Error(
      `范围起点与终点顺序颠倒（起点 index ${startIndex} >= 终点 index ${endIndex}）。ref 是地址而非序号，数值上可能不连续——请选择位置更早的 ref 作为起点、位置更晚的 ref 作为终点。`,
    );
  }

  // ── Protection zone (triple boundary, same as the command path) ─────
  const msgBoundary = protectedBoundary(messages, config.protectedMessages);
  const tokBoundary = tokenBoundary(messages, config.protectedTokens);
  const lastUserIdx = lastUserMessageIndex(messages);
  const boundary = Math.min(msgBoundary, tokBoundary, lastUserIdx);
  if (endIndex > boundary) {
    throw new Error(
      `范围 [${startIndex}, ${endIndex}) 触及保护区域（边界 ${boundary}）。最近的对话内容受到保护、不可压缩，请将终点往前调整。`,
    );
  }

  // ── First user message ──────────────────────────────────────────────
  const firstUserIdx = firstUserMessageIndex(messages);
  if (
    firstUserIdx >= 0 &&
    firstUserIdx >= startIndex &&
    firstUserIdx < endIndex
  ) {
    throw new Error(
      `范围 [${startIndex}, ${endIndex}) 包含会话的第一条用户消息（index ${firstUserIdx}）。第一条用户消息不可压缩，请调整起点。`,
    );
  }

  // ── Partial block overlap / consumption ─────────────────────────────
  const idToIndex = new Map<string, number>();
  for (let i = 0; i < messages.length; i++) {
    idToIndex.set(messages[i].info.id, i);
  }
  for (const [, block] of state.blocks) {
    let intersects = false;
    let fullyCovered = true;
    for (const mid of block.messageIds) {
      const idx = idToIndex.get(mid);
      if (idx === undefined) continue; // Message no longer in the view.
      if (idx >= startIndex && idx < endIndex) {
        intersects = true;
      } else {
        fullyCovered = false;
      }
    }
    if (!intersects) continue;
    if (block.active) {
      if (!fullyCovered) {
        // The anchor may lie inside the range while the block still extends
        // beyond it — consuming it would double-count the overflow tail.
        throw new Error(
          `范围与活跃压缩块 b${block.blockId} 部分重叠：该块覆盖的消息未被完整包含（范围 [${startIndex}, ${endIndex}) 只覆盖了该块的一部分）。跨块压缩必须完整消费整个块——请扩大范围以完整覆盖该块，或改用该块的摘要 ref 作为边界。`,
        );
      }
      if (!span.touchedBlocks.some((b) => b.blockId === block.blockId)) {
        span.touchedBlocks.push(block);
      }
    } else if (fullyCovered) {
      // Inactive (superseded) block fully re-covered by the range: NOT
      // consumed (already inactive), but its content is absorbed into the
      // new block — carry it so the tokens are netted and the anchor does
      // not spuriously collide.  Partially covered inactive blocks are
      // ordinary content again and are ignored entirely.
      if (
        !span.coveredInactiveBlocks.some((b) => b.blockId === block.blockId)
      ) {
        span.coveredInactiveBlocks.push(block);
      }
    }
  }

  // ── Phantom gate ────────────────────────────────────────────────────
  const segTokens = estimateSegmentTokens(messages, span.segment);
  if (segTokens < config.thresholdTokens) {
    throw new Error(
      `范围 [${startIndex}, ${endIndex}) 预计仅 ~${segTokens} tokens，低于压缩阈值 ${config.thresholdTokens}，收益过低。请选择更大的压缩范围。`,
    );
  }
}

// ---------------------------------------------------------------------------
// applyRange
// ---------------------------------------------------------------------------

/**
 * Apply a validated range compression: consume touched blocks, merge the
 * model summary with one-line index entries of the consumed blocks, account
 * tokens without double counting, and create the new block.
 *
 * Execution order guarantees failure safety:
 * 1. The no-new-content gate rejects ranges whose net compressible tokens
 *    are <= 0 (every covered message is already compressed) BEFORE any
 *    mutation.
 * 2. The negative-benefit gate runs on the MERGED summary (plan R3) BEFORE
 *    any mutation — a low-benefit request leaves the state untouched.
 * 3. `createBlock` runs before consumption so a genuine anchor collision
 *    (a block NOT about to be consumed) throws without having deactivated
 *    anything.  The touched (to-be-consumed) blocks AND the covered inactive
 *    blocks are excluded from the anchor-idempotency check so re-creating at
 *    a consumed block's anchor (including a superseded predecessor's) is
 *    allowed.
 *
 * Consumed blocks are deactivated (`active = false` + `deactivatedAt`) but
 * never deleted; their `compressedTokens` is subtracted so previously
 * compressed content is never counted twice (plan decision 7).  Fully
 * covered INACTIVE blocks (superseded by an earlier generation) are likewise
 * subtracted — they are not consumed again, so their `deactivatedAt` is
 * untouched.  Only the consumed blocks' one-line index entries
 * (`--- b<N>: <title> ---`) are merged into the new summary — their full
 * bodies are NOT carried over.
 *
 * @param state - The session state (mutated).
 * @param span - The validated span (touchedBlocks are consumed;
 *   coveredInactiveBlocks are netted out).
 * @param messages - The raw session messages array.
 * @param modelSummary - The model-written summary for the range.
 * @param title - One-line topic label for the new block (non-empty).
 * @returns The newly created block.
 */
export function applyRange(
  state: SessionState,
  span: ResolvedSpan,
  messages: ContextMessageEntry[],
  modelSummary: string,
  title: string,
): CompressionBlock {
  const { startIndex, endIndex } = span.segment;

  // ── Message-id union (range + consumed blocks), array-position order ─
  const coveredIds = new Set<string>();
  for (let i = startIndex; i < endIndex; i++) {
    coveredIds.add(messages[i].info.id);
  }
  for (const block of span.touchedBlocks) {
    for (const mid of block.messageIds) coveredIds.add(mid);
  }
  const messageIds: string[] = [];
  for (const msg of messages) {
    if (coveredIds.has(msg.info.id)) messageIds.push(msg.info.id);
  }

  // ── Token accounting (no double counting, plan decision 7) ──────────
  // The gross range estimate double-counts content already compressed by
  // earlier generations: subtract the active blocks consumed now AND the
  // inactive (superseded) blocks whose content the new block re-absorbs,
  // restoring "Σ over ALL block records == total compressed tokens".
  const { inTokens, outTokens } = segmentInOutTokens(messages, span.segment);
  const consumedTokens = span.touchedBlocks.reduce(
    (sum, b) => sum + b.compressedTokens,
    0,
  );
  const coveredInactiveTokens = span.coveredInactiveBlocks.reduce(
    (sum, b) => sum + b.compressedTokens,
    0,
  );
  const compressedTokens =
    inTokens + outTokens - consumedTokens - coveredInactiveTokens;

  // ── Final summary: header + model summary + superseded index lines ──
  // Every record whose content the new block absorbs gets an index line —
  // both the consumed (touched) blocks and the fully-covered inactive ones.
  const consumedSorted = [
    ...span.touchedBlocks,
    ...span.coveredInactiveBlocks,
  ].sort((a, b) => a.blockId - b.blockId);

  const headerBase = `${BLOCK_HEADER_TEMPLATE} ${title} — ${messageIds.length} messages, ~${inTokens} in, ~${outTokens} out`;
  // Truthful token figures when blocks are consumed: the gross range
  // estimate double-counts already-compressed content, so append the net
  // figure (the same value stored as compressedTokens).
  const header =
    span.touchedBlocks.length > 0 || span.coveredInactiveBlocks.length > 0
      ? `${headerBase} (net ~${compressedTokens} after consumed blocks)`
      : headerBase;
  const lines: string[] = [header];
  if (modelSummary.trim().length > 0) lines.push(modelSummary);
  if (consumedSorted.length > 0) {
    lines.push(SUPERSEDED_BLOCKS_LEAD_IN);
    for (const block of consumedSorted) {
      lines.push(`--- b${block.blockId}: ${block.title ?? "（无标题）"} ---`);
    }
  }
  const finalSummary = lines.join("\n");

  // ── No-new-content gate ─────────────────────────────────────────────
  // A non-positive net means the range brings no NEW compressible content:
  // every covered message was already part of a consumed block (or the
  // consumed blocks reference messages no longer in the view).  The generic
  // negative-benefit message quoting `~0 tokens` would be misleading, so a
  // dedicated guidance error fires instead.
  if (compressedTokens <= 0) {
    throw new Error(
      "范围内没有带来新的可压缩内容（所涉及的消息均已被现有压缩块覆盖），请扩大范围以包含尚未压缩的新消息。",
    );
  }

  // ── Negative-benefit gate on the MERGED summary (plan R3) ───────────
  const summaryTokens = estimateTokenCount(finalSummary);
  if (summaryTokens >= compressedTokens) {
    throw new Error(
      `压缩收益为负：合并后的摘要约 ${summaryTokens} tokens，不低于待压缩内容约 ${compressedTokens} tokens。请提供更精简的摘要或扩大压缩范围。`,
    );
  }

  // ── Create the block BEFORE consuming so a failure leaves state clean ─
  // The touched (to-be-consumed) blocks AND the fully-covered inactive
  // blocks are excluded from the anchor-idempotency check: re-compression
  // starting at a consumed block's anchor re-uses that message id by design,
  // including when an older inactive record at the same anchor is
  // re-absorbed by the new block.
  const excludedBlockIds = [
    ...span.touchedBlocks,
    ...span.coveredInactiveBlocks,
  ].map((b) => b.blockId);
  const created = createBlock(
    state,
    {
      anchorMessageId: messages[startIndex].info.id,
      messageIds,
      summary: finalSummary,
      title,
      compressedTokens,
      summaryTokens,
    },
    excludedBlockIds,
  );
  if (created === null) {
    throw new Error(
      `无法创建压缩块：范围起点（index ${startIndex}）的锚点消息 ${messages[startIndex].info.id} 已被现有压缩块的锚点占用。请将起点选在该消息之前（位置更早）的可见消息，或改用该压缩块的摘要 ref 作为终点。`,
    );
  }

  // ── Consume touched blocks (records never deleted) ──────────────────
  const now = Date.now();
  for (const block of span.touchedBlocks) {
    block.active = false;
    block.deactivatedAt = now;
  }
  if (span.touchedBlocks.length > 0) state.dirty = true;

  // ── Backfill the `b<N>` placeholder with the real block id ──────────
  created.summary = created.summary.replace(
    BLOCK_HEADER_TEMPLATE,
    `[Compression Block b${created.blockId}]`,
  );
  return created;
}
