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
 * **Batch mode (`compressRanges`):** a single call accepts N ranges.  All
 * ranges are resolved and validated against the SAME message snapshot and
 * state before anything is applied — an invalid range rejects the whole
 * call with an error naming the offending range (1-based) and leaves the
 * state untouched.  Cross-range rules: ranges must not overlap each other
 * and a range must not consume a block created earlier in the same call.
 * Only after every range passes every gate is the whole batch applied.
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
  segmentInOutTokens,
  tokenBoundary,
} from "./compress.js";
import { getMessageIdByRef } from "./message-refs.js";
import {
  firstUserMessageIndex,
  lastUserMessageIndex,
  protectedBoundary,
} from "./shared.js";
import type { SessionState } from "./types.js";

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

/**
 * A single range requested in a batch compress call.
 *
 * `fromRef` / `toRef` are message refs (the `[startIndex, endIndex)`
 * exclusive-end convention), `title` becomes the new block's one-line
 * topic label, and `summary` replaces the whole span.  A single-range
 * call is simply a length-1 array.
 */
export interface CompressRangeInput {
  fromRef: string;
  toRef: string;
  title: string;
  summary: string;
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
 * Fully prepared (and gate-checked) payload of a range application.
 *
 * Produced by `computePreparedApply` with ZERO state mutation: message-id
 * union, token accounting, merged summary, and both apply-time gates
 * (no-new-content, negative-benefit).  The anchor-collision gate is a
 * separate pure check (`assertAnchorFree`) because it needs the state.
 */
interface PreparedRangeApply {
  anchorMessageId: string;
  messageIds: string[];
  summary: string;
  title: string;
  compressedTokens: number;
  summaryTokens: number;
}

/**
 * Compute the block payload for a validated range and run the two pure
 * apply-time gates — WITHOUT mutating state.
 *
 * Builds the message-id union (range + consumed blocks) in array-position
 * order, accounts tokens without double counting (subtracting consumed
 * and fully-covered-inactive compressed tokens), and merges the model
 * summary with one-line index entries.  Then fires the no-new-content gate
 * (net compressible tokens <= 0) and the negative-benefit gate (merged
 * summary not smaller than the net benefit) — both throw before any
 * mutation, so a rejected range leaves the state untouched.
 *
 * @param span - The validated span (touchedBlocks / coveredInactiveBlocks
 *   consumed by the accounting).
 * @param messages - The raw session messages array.
 * @param modelSummary - The model-written summary for the range.
 * @param title - One-line topic label for the new block (non-empty).
 * @returns The prepared payload (not yet persisted).
 */
function computePreparedApply(
  span: ResolvedSpan,
  messages: ContextMessageEntry[],
  modelSummary: string,
  title: string,
): PreparedRangeApply {
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

  return {
    anchorMessageId: messages[startIndex].info.id,
    messageIds,
    summary: finalSummary,
    title,
    compressedTokens,
    summaryTokens,
  };
}

/**
 * Pure anchor-collision gate: reject the range when an existing block
 * (not about to be consumed, not covered-inactive) already owns the
 * range's start anchor.
 *
 * Mirrors the idempotency check inside `createBlock` (which mutates):
 * the touched (to-be-consumed) blocks AND the fully-covered inactive
 * blocks are excluded so re-compression starting at a consumed block's
 * anchor re-uses that message id by design.  Running the check here —
 * before any block is created — keeps the batch pre-flight mutation-free.
 *
 * @param state - The session state (read-only here).
 * @param span - The validated span (exclusion sets).
 * @param messages - The raw session messages array (for the error text).
 * @param prepared - The prepared payload carrying the anchor message id.
 */
function assertAnchorFree(
  state: SessionState,
  span: ResolvedSpan,
  messages: ContextMessageEntry[],
  prepared: PreparedRangeApply,
): void {
  const excludedBlockIds = new Set([
    ...span.touchedBlocks.map((b) => b.blockId),
    ...span.coveredInactiveBlocks.map((b) => b.blockId),
  ]);
  for (const [, block] of state.blocks) {
    if (excludedBlockIds.has(block.blockId)) continue;
    if (block.anchorMessageId === prepared.anchorMessageId) {
      throw new Error(
        `无法创建压缩块：范围起点（index ${span.segment.startIndex}）的锚点消息 ${messages[span.segment.startIndex].info.id} 已被现有压缩块的锚点占用。请将起点选在该消息之前（位置更早）的可见消息，或改用该压缩块的摘要 ref 作为终点。`,
      );
    }
  }
}

/**
 * Commit a prepared range apply: create the block, consume the touched
 * blocks, and backfill the `b<N>` placeholder.  Runs only after every
 * gate (including the anchor check) passed, so it cannot fail.
 *
 * @param state - The session state (mutated).
 * @param span - The validated span (touchedBlocks consumed).
 * @param prepared - The gate-checked payload.
 * @returns The newly created block.
 */
function commitPreparedApply(
  state: SessionState,
  span: ResolvedSpan,
  prepared: PreparedRangeApply,
): CompressionBlock {
  const excludedBlockIds = [
    ...span.touchedBlocks,
    ...span.coveredInactiveBlocks,
  ].map((b) => b.blockId);
  const created = createBlock(
    state,
    {
      anchorMessageId: prepared.anchorMessageId,
      messageIds: prepared.messageIds,
      summary: prepared.summary,
      title: prepared.title,
      compressedTokens: prepared.compressedTokens,
      summaryTokens: prepared.summaryTokens,
    },
    excludedBlockIds,
  );
  if (created === null) {
    throw new Error(
      `无法创建压缩块：范围起点（index ${span.segment.startIndex}）的锚点消息 ${prepared.anchorMessageId} 已被现有压缩块的锚点占用。请将起点选在该消息之前（位置更早）的可见消息，或改用该压缩块的摘要 ref 作为终点。`,
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
 * 3. The anchor-collision gate runs BEFORE `createBlock` so a genuine
 *    collision (a block NOT about to be consumed) throws without having
 *    deactivated anything.  The touched (to-be-consumed) blocks AND the
 *    covered inactive blocks are excluded from the anchor-idempotency
 *    check so re-creating at a consumed block's anchor (including a
 *    superseded predecessor's) is allowed.
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
  const prepared = computePreparedApply(span, messages, modelSummary, title);
  assertAnchorFree(state, span, messages, prepared);
  return commitPreparedApply(state, span, prepared);
}

// ---------------------------------------------------------------------------
// compressRanges — batch compression
// ---------------------------------------------------------------------------

/**
 * Reject ranges whose spans overlap each other.
 *
 * Ranges are positions on the SAME message snapshot, so overlapping spans
 * would double-cover messages — the second block would absorb content the
 * first already claimed.  Reported against both 1-based indices.
 *
 * @param spans - The resolved spans, in request order.
 */
function assertNoSpanOverlap(spans: ResolvedSpan[]): void {
  for (let i = 1; i < spans.length; i++) {
    const seg = spans[i].segment;
    for (let j = 0; j < i; j++) {
      const prev = spans[j].segment;
      if (seg.startIndex < prev.endIndex && seg.endIndex > prev.startIndex) {
        throw new Error(
          `第 ${i + 1} 个范围与第 ${j + 1} 个范围重叠（[${seg.startIndex}, ${seg.endIndex}) 与 [${prev.startIndex}, ${prev.endIndex})）。ranges 必须互不重叠，请调整边界后重试。`,
        );
      }
    }
  }
}

/**
 * Reject a range that would consume a block created earlier in the same
 * call.
 *
 * `validateRange` decides consumption against the state as it exists
 * BEFORE this call — a block created by an earlier range of the same batch
 * is not yet registered, so the consumption would slip through validation
 * and silently deactivate a block the call just created.  This check
 * simulates the message-id set each range's block WILL carry (span ∪
 * touched blocks) and rejects any later range whose span fully covers an
 * earlier range's set.
 *
 * @param spans - The resolved spans, in request order.
 * @param messages - The raw session messages array (position map).
 */
function assertNoSameCallConsumption(
  spans: ResolvedSpan[],
  messages: ContextMessageEntry[],
): void {
  const idToIndex = new Map<string, number>();
  for (let i = 0; i < messages.length; i++) {
    idToIndex.set(messages[i].info.id, i);
  }

  const wouldBeSets = spans.map((s) => {
    const ids = new Set<string>();
    for (let k = s.segment.startIndex; k < s.segment.endIndex; k++) {
      ids.add(messages[k].info.id);
    }
    for (const block of s.touchedBlocks) {
      for (const mid of block.messageIds) ids.add(mid);
    }
    return ids;
  });

  for (let i = 1; i < spans.length; i++) {
    const seg = spans[i].segment;
    for (let j = 0; j < i; j++) {
      let fullyCovered = true;
      for (const mid of wouldBeSets[j]) {
        const idx = idToIndex.get(mid);
        if (idx === undefined) continue; // Message no longer in the view.
        if (idx < seg.startIndex || idx >= seg.endIndex) {
          fullyCovered = false;
          break;
        }
      }
      if (fullyCovered) {
        throw new Error(
          `第 ${i + 1} 个范围将消费第 ${j + 1} 个范围刚创建的压缩块：同一调用内不允许消费本调用创建的块。请将这两个范围合并为一个更大的范围，或调整边界避免覆盖其他范围的消息。`,
        );
      }
    }
  }
}

/**
 * Batch-compress N ranges atomically against the same message snapshot.
 *
 * Pipeline:
 * 1. Resolve + validate EVERY range (ordering / protection / first-user /
 *    partial overlap / phantom gates) — the first failure aborts with an
 *    error naming the 1-based range index and zero state change.
 * 2. Cross-range rules: no overlapping spans; no range may consume a block
 *    created by an earlier range of the same call.
 * 3. Pre-flight the apply-time gates (no-new-content, negative-benefit,
 *    anchor collision) for every range — again with zero mutation, so an
 *    apply-time failure on ANY range also aborts the whole call.
 * 4. Apply every range in order (single mutation pass, one persisted
 *    write at the caller).
 *
 * Single-range calls are simply length-1 arrays; behavior matches
 * `resolveSpan` + `validateRange` + `applyRange` on that one range.
 *
 * @param sessionId - The session identifier (ref registry scope).
 * @param messages - The raw session messages array (no synthetic entries).
 * @param state - The session state (mutated only on full-batch success).
 * @param config - Compression configuration (protection + threshold).
 * @param ranges - The requested ranges, in order.
 * @returns The newly created blocks, in request order.
 */
export function compressRanges(
  sessionId: string,
  messages: ContextMessageEntry[],
  state: SessionState,
  config: CompressionConfig,
  ranges: CompressRangeInput[],
): CompressionBlock[] {
  // ── Phase 1: resolve + validate all ranges (zero mutation) ─────────
  const spans: ResolvedSpan[] = [];
  for (let i = 0; i < ranges.length; i++) {
    try {
      const span = resolveSpan(
        sessionId,
        messages,
        state,
        ranges[i].fromRef,
        ranges[i].toRef,
      );
      validateRange(span, messages, state, config);
      spans.push(span);
    } catch (err) {
      throw new Error(
        `第 ${i + 1} 个范围校验失败：${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // ── Phase 2: cross-range rules (zero mutation) ─────────────────────
  assertNoSameCallConsumption(spans, messages);
  assertNoSpanOverlap(spans);

  // ── Phase 3: pre-flight apply-time gates (zero mutation) ───────────
  const prepared: Array<{ span: ResolvedSpan; apply: PreparedRangeApply }> = [];
  for (let i = 0; i < ranges.length; i++) {
    try {
      const apply = computePreparedApply(
        spans[i],
        messages,
        ranges[i].summary,
        ranges[i].title,
      );
      assertAnchorFree(state, spans[i], messages, apply);
      prepared.push({ span: spans[i], apply });
    } catch (err) {
      throw new Error(
        `第 ${i + 1} 个范围校验失败：${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // ── Phase 4: apply the whole batch (single mutation pass) ──────────
  const created: CompressionBlock[] = [];
  for (const { span, apply } of prepared) {
    created.push(commitPreparedApply(state, span, apply));
  }
  return created;
}
