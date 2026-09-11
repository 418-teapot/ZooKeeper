/**
 * Ordinal-based compression core — model-driven folding of contiguous
 * transcript spans.
 *
 * A compression request describes one or more contiguous spans of the
 * current view; each span becomes a new block over its ordinal interval.
 * Endpoints are addressed by per-round line numbers and resolved
 * against the numbered view (`resolveSpan`): an original item maps to
 * its unit interval, a summary item to its block's whole interval, and a
 * reversed pair of refs is rejected with an order error.  Every gate
 * (`validateRange`) then runs against the same transcript and block
 * snapshot — the first gate that fails returns an actionable Chinese error
 * text naming the span in the model's own address space (the closed line
 * refs such as `m2` through `m9`, never the internal half-open ordinal interval), and a
 * failed range never mutates state.
 *
 * Batch semantics (`compressRanges`): all ranges resolve, validate, and
 * pass the apply-time gates against the SAME snapshot before anything is
 * applied — a block created by an earlier range of the call is invisible
 * to the later ranges' validation, and cross-range rules (no overlapping
 * spans, no consuming a sibling range's would-be block) reject the whole
 * call.  Only after every range passes is the whole batch applied in a
 * single mutation pass.  Persistence is the caller's responsibility: this
 * module only mutates the in-memory session state.
 *
 * Token accounting: a block's `compressedTokens` is the heuristic
 * estimate of its interval plus the pending-mark tokens swallowed by the
 * landed range (`clearConsumedBlockRange`), minus the compressed tokens
 * of the fully-covered active blocks it consumes and of the absorbed
 * inactive records whose content those blocks already fold away — so
 * previously compressed content is never counted twice, while content
 * that is visible in the view again counts as fresh compression
 * material.  The stored summary carries the model text plus one-line
 * index entries (`--- bN: title ---`) for every absorbed block.
 *
 * @module
 */

import type { HostMessage, Projection } from "./lens.js";
import { findFirstUserOrdinal, findLastUserOrdinal } from "./lens.js";
import { estimateMessageHeuristic, estimateTokenCount } from "./measure.js";
import { computeSpanHash } from "./spanhash.js";
import type { Block, SessionState } from "./state.js";
import { allocateBlockId, clearConsumedBlockRange } from "./state.js";
import type { NumberedItem } from "./view-refs.js";
import {
  itemAtOrdinal,
  itemInterval,
  refAtOrdinal,
  resolveRange,
} from "./view-refs.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Fixed lead-in separating the model summary from the one-line index
 * entries of consumed blocks in the merged block summary.
 */
export const SUPERSEDED_BLOCKS_LEAD_IN = "=== Superseded Blocks ===";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A single range requested in a batch compress call.
 *
 * `fromRef` / `toRef` are per-round view line numbers (`"m3"` or
 * `"[m3]"`); `title` becomes the new block's one-line topic label and
 * `summary` replaces the whole span.  A single-range call is simply a
 * length-1 array.
 */
export interface CompressRangeInput {
  /** Start endpoint line ref. */
  fromRef: string;
  /** End endpoint line ref; its message is part of the compressed span. */
  toRef: string;
  /** One-line topic label for the new block. */
  title: string;
  /** Summary text replacing the whole span. */
  summary: string;
}

/**
 * Compression configuration for the gate layer.
 *
 * The fields mirror the parsed `[zoo.context]` configuration the tool
 * adapter supplies — the protection windows and the phantom threshold —
 * plus the optional per-call range upper bound.
 */
export interface CompressOptions {
  /** Number of most recent non-hidden messages to protect. */
  protectedMessages: number;
  /** Token budget protected from the end of the session (CJK heuristic). */
  protectedTokens: number;
  /** Minimum estimated tokens a range must carry to pass the phantom gate. */
  thresholdTokens: number;
  /** Upper bound on ranges per call; excess ranges fail the whole call. */
  maxRanges?: number;
}

/**
 * Result of resolving two endpoint refs against the current view.
 */
export type SpanResolution = { start: number; end: number } | { error: string };

/**
 * A block discovered by the swallow gate, paired with its persistent id.
 *
 * Block ids are the block-map keys (`bN`); the index lines and the token
 * netting need them, and the `Block` record itself does not carry one.
 */
export interface ConsumedBlockRef {
  /** Persistent block id (the block-map key). */
  id: number;
  /** The block record. */
  block: Block;
}

/**
 * Outcome of running every validation gate over one resolved range.
 *
 * Zero-mutation: the swallowed / covered-inactive collections describe
 * what an apply would do but change nothing themselves.
 */
export interface RangeValidation {
  /** Actionable Chinese error text, or null when every gate passed. */
  error: string | null;
  /**
   * Active blocks fully covered by the range — consumed (moved to
   * `"consumed"`) when the range is applied.
   */
  swallowed: ConsumedBlockRef[];
  /**
   * Terminal-status blocks (consumed or stale) fully covered by the
   * range — absorbed records that get an index line.  Their tokens are
   * netted out only when an active block consumed by the same range
   * already folds their interval away (see
   * `nettedCoveredInactiveTokens`).
   */
  coveredInactive: ConsumedBlockRef[];
}

/**
 * One rejected range of a batch call, with its 1-based request index.
 *
 * The `error` text describes the failing range and may include its own
 * user-facing range label. The caller still prefixes each failure with its
 * request index so batch errors can be located unambiguously.
 */
export interface RangeFailure {
  /** 1-based range index in the request order. */
  index: number;
  /** The original range input as submitted. */
  range: CompressRangeInput;
  /** Actionable Chinese error text (the failing gate's message). */
  error: string;
}

/**
 * Result of a batch compress call.
 *
 * Atomic by construction: when any range fails any gate, `created` is
 * empty and the state is untouched — the failures are reported
 * per-range.  On success `failed` is empty and `created` carries the new
 * blocks in request order.
 */
export interface CompressResult {
  /** The created blocks, in request order; empty when any range failed. */
  created: Block[];
  /** Per-range failures; empty on success. */
  failed: RangeFailure[];
  /** Count of pending marks swallowed by the created blocks. */
  swallowedMarks: number;
  /**
   * Whole-call failure (e.g. the range count exceeds `maxRanges`);
   * absent otherwise.
   */
  error?: string;
}

// ---------------------------------------------------------------------------
// Error-text labels — internal ordinals → the model's line refs
// ---------------------------------------------------------------------------

/**
 * Render a resolved ordinal interval in the address space the model holds.
 *
 * Gates reject a span the model addressed by two line refs, so the error
 * names it back the same way — a closed `[m2..m9]` (both endpoints
 * included, the spelling the tool contract documents).  When a boundary
 * ordinal occupies no visible line (folded into a block, or a hidden
 * message) the internal ordinals are quoted only as diagnosis, next to
 * the instruction to re-read the view, because no ref exists that the
 * model could act on.
 *
 * @param items - The numbered view items of the current round.
 * @param start - First ordinal of the interval (inclusive).
 * @param end - Last ordinal of the interval (exclusive).
 * @returns A user-facing range label, or guidance to reread the current view.
 */
function spanLabel(items: NumberedItem[], start: number, end: number): string {
  const from = refAtOrdinal(items, start);
  const to = end > start ? refAtOrdinal(items, end - 1) : from;
  if (from !== undefined && to !== undefined) return `范围 ${from} 至 ${to}`;
  return "当前范围无法用本轮可见行号完整定位，请重新读取当前视图后选择范围";
}

/**
 * The summary line a folded block occupies in the current view.
 *
 * The partial-overlap gate can only point the model at a boundary it can
 * actually write: an active block whose interval the fold renders as one
 * summary line is addressable through that line's ref.  A block that is
 * not folded in this round's view (its span expired, so the fold expanded
 * it back into originals) has no line to name — the interval comparison
 * rejects a coincidental original item, and the caller then guides on the
 * block id alone.
 *
 * @param items - The numbered view items of the current round.
 * @param block - The block being discussed.
 * @returns The ref text (`"m4"`), or undefined when the block occupies no line.
 */
function blockViewRef(items: NumberedItem[], block: Block): string | undefined {
  const entry = itemAtOrdinal(items, block.start);
  if (entry === undefined || entry.item.type !== "summary") return undefined;
  const { start, end } = itemInterval(entry.item);
  return start === block.start && end === block.end ? `m${entry.n}` : undefined;
}

// ---------------------------------------------------------------------------
// Protection window
// ---------------------------------------------------------------------------

/**
 * Start ordinal of the message-count protection window.
 *
 * Counts back `n` non-hidden messages from the end of the transcript; a
 * hidden message never occupies a protection slot.  The returned ordinal
 * is inclusive: `[boundary, history.length)` is the protected window.
 * `n <= 0` yields `history.length` (empty window); an `n` larger than
 * the available non-hidden messages yields `0` (protect everything).
 *
 * @param history - The transcript.
 * @param n - Number of trailing messages to protect.
 * @returns Start ordinal of the message-count window.
 */
function messageCountBoundary(history: HostMessage[], n: number): number {
  if (n <= 0) return history.length;
  let count = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].hidden) continue;
    count += 1;
    if (count >= n) return i;
  }
  return 0;
}

/**
 * Start ordinal of the token-budget protection window.
 *
 * Accumulates the heuristic estimate of messages from the end (backward)
 * until the cumulative total reaches `protectedTokens`; hidden messages
 * contribute nothing.  `protectedTokens <= 0` or an empty transcript
 * yields `history.length` (empty window); a budget exceeding the whole
 * session yields `0` (protect everything).
 *
 * @param history - The transcript.
 * @param protectedTokens - Token budget to protect from the end.
 * @returns Start ordinal of the token window.
 */
function tokenCountBoundary(
  history: HostMessage[],
  protectedTokens: number,
): number {
  if (protectedTokens <= 0 || history.length === 0) return history.length;
  let accumulated = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].hidden) continue;
    accumulated += estimateMessageHeuristic(history[i]);
    if (accumulated >= protectedTokens) return i;
  }
  return 0;
}

/**
 * Compute the start ordinal of the combined protection window.
 *
 * Both windows extend to the end of the transcript, so their union starts
 * at the earlier of the two boundaries.  Hidden messages are skipped by
 * the message-count window and contribute no tokens to the token window.
 *
 * @param history - The transcript.
 * @param protectedMessages - Trailing message count to protect.
 * @param protectedTokens - Trailing token budget to protect.
 * @returns Start ordinal of the protected window; `history.length` when
 *   both windows are empty.
 */
export function computeProtectedStartOrdinal(
  history: HostMessage[],
  protectedMessages: number,
  protectedTokens: number,
): number {
  return Math.min(
    messageCountBoundary(history, protectedMessages),
    tokenCountBoundary(history, protectedTokens),
  );
}

// ---------------------------------------------------------------------------
// resolveSpan — endpoint refs → ordinal interval
// ---------------------------------------------------------------------------

/**
 * Append a covered-content hint to an out-of-view resolution error.
 *
 * A line ref that fails because the line does not exist may address
 * content the model remembers from an earlier round but that a block now
 * folds away — covered ordinals occupy no line.  When active blocks
 * exist, the plain out-of-view error is enriched with their ids and the
 * decompress option so the model can recover the content before
 * retrying.  Non-out-of-view errors (bad ref format) pass through
 * unchanged.
 *
 * @param error - The plain resolution error text.
 * @param state - The session state (block collection).
 * @returns The enriched error text.
 */
function enrichCoveredOrdinalHint(error: string, state: SessionState): string {
  if (!error.includes("不存在")) return error;
  const activeIds: number[] = [];
  for (const [id, block] of state.blocks) {
    if (block.status === "active") activeIds.push(id);
  }
  if (activeIds.length === 0) return error;
  const blockList = activeIds.map((id) => `b${id}`).join("、");
  return (
    `${error} 若目标内容已被压缩块（${blockList}）覆盖而不再占行号，` +
    `可先用 decompress 恢复该块后再压缩。`
  );
}

/**
 * Resolve two endpoint refs into a contiguous ordinal interval.
 *
 * Both endpoints are resolved independently through the view layer
 * (`resolveRange`): an original item maps to `[ordinal, ordinal + 1)`, a
 * summary item to its block's whole interval, and a reversed pair of
 * refs is rejected with an order error.  A failing ref returns the
 * actionable error (enriched with the covered-content hint when active
 * blocks exist).
 *
 * @param items - The numbered view items of the current round.
 * @param state - The session state (block collection for error hints).
 * @param fromRef - The start endpoint ref.
 * @param toRef - The end endpoint ref.
 * @returns The resolved interval, or an actionable error.
 */
export function resolveSpan(
  items: NumberedItem[],
  state: SessionState,
  fromRef: string,
  toRef: string,
): SpanResolution {
  const resolved = resolveRange(fromRef, toRef, items);
  if ("error" in resolved) {
    return { error: enrichCoveredOrdinalHint(resolved.error, state) };
  }
  return { start: resolved.start, end: resolved.end };
}

// ---------------------------------------------------------------------------
// validateRange — per-range gates
// ---------------------------------------------------------------------------

/**
 * Sum the heuristic token estimate over an ordinal interval.
 *
 * @param history - The transcript.
 * @param start - First ordinal (inclusive).
 * @param end - Last ordinal (exclusive).
 * @returns The summed estimate.
 */
function estimateIntervalTokens(
  history: HostMessage[],
  start: number,
  end: number,
): number {
  let total = 0;
  for (let i = start; i < end; i++) {
    total += estimateMessageHeuristic(history[i]);
  }
  return total;
}

/**
 * Run every validation gate over a resolved ordinal interval.
 *
 * Gates, in evaluation order:
 *
 * 1. **Protection zone** — the range must not reach into the protected
 *    window: the start of the union of the trailing message-count and
 *    token-budget windows, itself limited by the ordinal of the last
 *    non-hidden user message.
 * 2. **First user** — the range must not contain the first non-hidden
 *    user message.
 * 3. **Overlap / swallow** — an active block intersecting the range must
 *    be fully covered (swallowed) or the range is rejected as a partial
 *    overlap; a fully-covered block in a terminal status is carried on
 *    `coveredInactive` as an absorbed record (index line, plus token
 *    netting where its content is still folded), a partially-covered one
 *    is ignored entirely.
 * 4. **Mid-pair** — a range cutting between the two halves of a tool
 *    call is rejected in either direction: a call inside with its linked
 *    result outside, or a result inside with its call outside.  The
 *    projection's invocation table addresses both halves beside the
 *    call, and cutting between them would leave the render to widen the
 *    summary, which loses the block-id label.  Hosts whose pairs always
 *    live in one message (the OpenCode adapter) are structurally
 *    unaffected.
 * 5. **Phantom** — the interval's heuristic estimate must reach
 *    `thresholdTokens`.
 *
 * Every rejection is worded in the model's address space: the rejected
 * span and the boundary it must move are named by current-round line refs
 * (`items`), so the model can fix the call without translating internal
 * ordinals.  An interval bound that occupies no line is reported as such
 * with a re-read instruction instead of a fabricated ref.
 *
 * Zero-mutation: the returned collections describe the apply, they do
 * not consume anything.  The apply-time gates (no-new-content,
 * negative-benefit) run later on the prepared payload.
 *
 * @param snapshot - The projection snapshot (region view plus the
 *   invocation table feeding the mid-pair gate).
 * @param items - The numbered view items of the current round (the
 *   address space the rejected range is reported back in).
 * @param state - The session state (block collection, read-only here).
 * @param options - Protection windows and the phantom threshold.
 * @param start - First ordinal (inclusive).
 * @param end - Last ordinal (exclusive).
 * @returns The gate outcome.
 */
export function validateRange(
  snapshot: Projection,
  items: NumberedItem[],
  state: SessionState,
  options: CompressOptions,
  start: number,
  end: number,
): RangeValidation {
  const history = snapshot.messages;
  const failed = (error: string): RangeValidation => ({
    error,
    swallowed: [],
    coveredInactive: [],
  });
  const span = spanLabel(items, start, end);

  // ── Protection-zone gate ───────────────────────────────────────────
  const protectedStart = computeProtectedStartOrdinal(
    history,
    options.protectedMessages,
    options.protectedTokens,
  );
  const lastUser = findLastUserOrdinal(history);
  const lastUserBoundary = lastUser >= 0 ? lastUser : history.length;
  const boundary = Math.min(protectedStart, lastUserBoundary);
  if (end > boundary) {
    // `boundary` is exclusive: the last compressible ordinal is the one
    // before it, and the model needs that line (or the knowledge that no
    // such line exists) rather than the raw boundary ordinal.
    const lastFree = refAtOrdinal(items, boundary - 1);
    if (lastFree === undefined) {
      return failed(
        `${span} 无法压缩：本轮可见的最近对话内容都在保护范围内。` +
          `请等对话继续产生更多历史后再选择范围；本轮内重复提交不会成功。`,
      );
    }
    const firstProtected = refAtOrdinal(items, boundary);
    return failed(
      `${span} 包含受到保护的最近对话内容` +
        `${firstProtected === undefined ? "" : `（从 ${firstProtected} 开始）`}，不能压缩。` +
        `请将终点改为 ${lastFree} 或更早。`,
    );
  }

  // ── First-user gate ────────────────────────────────────────────────
  const firstUser = findFirstUserOrdinal(history);
  if (firstUser >= 0 && start <= firstUser && firstUser < end) {
    const ref = refAtOrdinal(items, firstUser);
    return failed(
      `${span} 包含会话的第一条用户消息` +
        (ref === undefined
          ? "（该消息不占当轮视图行号，无法按行号定位）。"
          : `（${ref}）。`) +
        `第一条用户消息不可压缩，请将起点调整到该消息之后。`,
    );
  }

  // ── Overlap / swallow discovery ────────────────────────────────────
  const swallowed: ConsumedBlockRef[] = [];
  const coveredInactive: ConsumedBlockRef[] = [];
  for (const [id, block] of state.blocks) {
    // Non-empty intersection of two half-open intervals.
    const intersects = Math.max(block.start, start) < Math.min(block.end, end);
    if (!intersects) continue;
    const fullyCovered = start <= block.start && block.end <= end;
    if (block.status === "active") {
      if (!fullyCovered) {
        const blockRef = blockViewRef(items, block);
        return failed(
          `${span} 与活跃压缩块 b${id}` +
            (blockRef === undefined
              ? "（本轮视图中不占摘要行）"
              : `（摘要行 ${blockRef}）`) +
            ` 部分重叠：压缩块只能整块消费。` +
            (blockRef === undefined
              ? "请扩大范围以完整覆盖该块，或收窄范围到完全不触碰它。"
              : `请将范围扩展到完整覆盖 ${blockRef}，或收窄范围到完全不触碰 ${blockRef}。`),
        );
      }
      swallowed.push({ id, block });
    } else if (fullyCovered) {
      // Terminal-status block fully re-covered: it folds nothing of its
      // own, so it is never consumed again, but the record is absorbed —
      // carried so it gets an index line, and so its tokens are netted
      // when a swallowed active block already folds its interval away.
      // Partially covered terminal blocks are ordinary content again and
      // ignored entirely.
      coveredInactive.push({ id, block });
    }
  }

  // ── Mid-pair gate ──────────────────────────────────────────────────
  // A tool call and its result must fold as a pair: a range that covers
  // one half of an invocation but not the other would create a block
  // whose summary interval the render would have to widen to swallow the
  // orphaned half — which breaks the block-id label lookup for
  // decompression.  Both directions are gated: the call inside / result
  // outside, and the result inside / call outside.  The pairing comes
  // from the projection's invocation table; calls still in flight (no
  // linked output) and hosts whose pairs always live in one message (the
  // OpenCode adapter) are structurally unaffected.
  for (const invocation of snapshot.invocations) {
    const output = invocation.output;
    if (output === undefined) continue;
    if (
      invocation.input.ordinal >= start &&
      invocation.input.ordinal < end &&
      (output.ordinal < start || output.ordinal >= end)
    ) {
      const ref = refAtOrdinal(items, output.ordinal);
      return failed(
        `${span} 在工具调用和对应结果之间截断：工具 ${invocation.name} ` +
          `链接的工具结果在区间之外` +
          (ref === undefined
            ? "（该结果不占当轮视图行号）。工具调用与其结果必须成对压缩，请将范围扩展到包含该工具结果。"
            : `（${ref}）。工具调用与其结果必须成对压缩，请将终点扩展到包含 ${ref}。`),
      );
    }
    // Reverse direction: the range covers the result half while its call
    // sits before the start boundary (a call always precedes its result,
    // so the "outside" side can only be below `start`).
    if (
      output.ordinal >= start &&
      output.ordinal < end &&
      invocation.input.ordinal < start
    ) {
      const ref = refAtOrdinal(items, invocation.input.ordinal);
      return failed(
        `${span} 在工具调用和对应结果之间截断：工具 ` +
          `${invocation.name}，其调用在区间之外` +
          (ref === undefined
            ? "（该调用不占当轮视图行号）。工具调用与其结果必须成对压缩，请将范围扩展到包含该工具调用。"
            : `（${ref}）。工具调用与其结果必须成对压缩，请将起点前移到包含 ${ref}。`),
      );
    }
  }

  // ── Phantom gate ───────────────────────────────────────────────────
  const segTokens = estimateIntervalTokens(history, start, end);
  if (segTokens < options.thresholdTokens) {
    return failed(
      `${span} 预计只有约 ${segTokens} tokens，低于最小压缩规模` +
        ` ${options.thresholdTokens}，无法带来足够收益。请扩大到更多同一主题的历史；` +
        `如果没有适合合并的内容，请不要压缩这段。`,
    );
  }

  return { error: null, swallowed, coveredInactive };
}

// ---------------------------------------------------------------------------
// Apply-time gates and payload preparation
// ---------------------------------------------------------------------------

/**
 * A gate-checked payload ready to be committed.
 */
interface PreparedRange {
  /** The merged summary text stored on the new block. */
  summary: string;
  /** Heuristic estimate of the merged summary text. */
  summaryTokens: number;
}

/**
 * Collect the pending marks anchored inside an interval.
 *
 * Read-only counterpart of the `clearConsumedBlockRange` accounting:
 * effective marks are never swallowed, so only non-effective marks whose
 * anchor ordinal falls in `[start, end)` count.
 *
 * @param state - The session state.
 * @param start - First ordinal (inclusive).
 * @param end - Last ordinal (exclusive).
 * @returns The summed content tokens and the count of the pending marks.
 */
function pendingMarkStats(
  state: SessionState,
  start: number,
  end: number,
): { tokens: number; count: number } {
  let tokens = 0;
  let count = 0;
  for (const mark of state.marks.values()) {
    if (mark.effective) continue;
    if (mark.anchorOrdinal >= start && mark.anchorOrdinal < end) {
      tokens += mark.contentTokens ?? 0;
      count += 1;
    }
  }
  return { tokens, count };
}

/**
 * Merge the model summary with one-line index entries of absorbed blocks.
 *
 * Every record whose content the new block absorbs gets an index line —
 * both the consumed (swallowed) active blocks and the fully-covered
 * inactive ones — sorted by block id.  The consumed bodies are never
 * carried over, and a missing title renders as `（无标题）`.  A
 * whitespace-only model summary is dropped.
 *
 * @param modelSummary - The model-written summary for the range.
 * @param validation - The validated range (absorbed block collections).
 * @returns The merged summary text.
 */
function mergeSummary(
  modelSummary: string,
  validation: RangeValidation,
): string {
  const indexBlocks = [
    ...validation.swallowed,
    ...validation.coveredInactive,
  ].sort((a, b) => a.id - b.id);
  if (indexBlocks.length === 0) {
    return modelSummary.trim().length > 0 ? modelSummary : "";
  }
  const lines: string[] = [];
  if (modelSummary.trim().length > 0) lines.push(modelSummary);
  lines.push(SUPERSEDED_BLOCKS_LEAD_IN);
  for (const { id, block } of indexBlocks) {
    lines.push(`--- b${id}: ${block.title ?? "（无标题）"} ---`);
  }
  return lines.join("\n");
}

/**
 * Sum the compressed tokens of the absorbed records the range nets out.
 *
 * A terminal-status block folds nothing of its own: its interval shows
 * in the view either as ordinary messages (restored, or invalidated by a
 * content change) or inside the summary of an active block that consumed
 * it.  Only the second case is netted.  A consuming block's own
 * `compressedTokens` was computed with the swallowed interval taken out,
 * so the range's raw interval estimate has to take those tokens out
 * through the absorbed record as well, otherwise the same content is
 * counted twice.  A record whose content is back in the view is fresh
 * compression material, and netting it would erase the very gain the
 * range is claiming.
 *
 * @param validation - The gate outcome for the range.
 * @returns The compressed tokens to subtract from the range estimate.
 */
function nettedCoveredInactiveTokens(validation: RangeValidation): number {
  return validation.coveredInactive.reduce((sum, ref) => {
    // Strict containment: an absorbed record sharing a consuming block's
    // interval exactly describes the same content that block already
    // counts in full, so only the block is netted.
    const nested = validation.swallowed.some(
      (parent) =>
        parent.block.start <= ref.block.start &&
        ref.block.end <= parent.block.end &&
        (parent.block.start < ref.block.start ||
          ref.block.end < parent.block.end),
    );
    return nested ? sum + ref.block.compressedTokens : sum;
  }, 0);
}

/**
 * Prepare a validated range's payload and run the apply-time gates.
 *
 * Zero-mutation: builds the merged summary and the token arithmetic, then
 * fires the no-new-content gate (net compressible tokens <= 0) and the
 * negative-benefit gate (merged summary not smaller than the net
 * benefit) — both reject before any mutation.  The pending-mark tokens
 * swallowed by the landed range are included in the net figure.
 *
 * @param history - The transcript.
 * @param state - The session state (read-only here).
 * @param range - The resolved range with its validated title and summary.
 * @param validation - The gate outcome (absorbed block collections).
 * @returns The prepared payload, or the failing gate's error.
 */
function prepareRange(
  history: HostMessage[],
  state: SessionState,
  range: { start: number; end: number; title: string; summary: string },
  validation: RangeValidation,
): { prepared: PreparedRange; error: string | null } {
  const intervalTokens = estimateIntervalTokens(
    history,
    range.start,
    range.end,
  );
  const markTokens = pendingMarkStats(state, range.start, range.end).tokens;
  const consumedTokens = validation.swallowed.reduce(
    (sum, ref) => sum + ref.block.compressedTokens,
    0,
  );
  const coveredInactiveTokens = nettedCoveredInactiveTokens(validation);
  const compressedTokens =
    intervalTokens + markTokens - consumedTokens - coveredInactiveTokens;

  // ── No-new-content gate ────────────────────────────────────────────
  if (compressedTokens <= 0) {
    return {
      prepared: { summary: "", summaryTokens: 0 },
      error:
        "范围内没有带来新的可压缩内容（所涉及的消息均已被现有压缩块覆盖），" +
        "请扩大范围以包含尚未压缩的新消息。",
    };
  }

  const summary = mergeSummary(range.summary, validation);
  const summaryTokens = estimateTokenCount(summary);

  // ── Negative-benefit gate on the merged summary ────────────────────
  if (summaryTokens >= compressedTokens) {
    return {
      prepared: { summary, summaryTokens },
      error:
        `压缩收益为负：合并后的摘要约 ${summaryTokens} tokens，不低于待压缩内容` +
        `约 ${compressedTokens} tokens。请提供更精简的摘要或扩大压缩范围。`,
    };
  }

  return { prepared: { summary, summaryTokens }, error: null };
}

/**
 * Commit a prepared range: consume the swallowed blocks, swallow the
 * pending marks of the landed interval, and create the new block.
 *
 * Runs only after every gate passed, so it cannot fail.  The block's
 * `compressedTokens` is computed with the authoritative
 * `clearConsumedBlockRange` return (the same figure the apply-time gates
 * saw pre-flight), and its `spanHash` is computed over the interval at
 * creation so `validateBlock` can self-verify the coverage later.
 *
 * @param snapshot - The projection snapshot (span hash resolves tool
 *   names through the invocation table).
 * @param state - The session state (mutated).
 * @param range - The resolved range with its validated title.
 * @param validation - The gate outcome (swallowed blocks consumed).
 * @param prepared - The gate-checked payload.
 * @returns The newly created block plus the count of swallowed marks.
 */
function commitPreparedRange(
  snapshot: Projection,
  state: SessionState,
  range: { start: number; end: number; title: string },
  validation: RangeValidation,
  prepared: PreparedRange,
): { block: Block; markCount: number } {
  const history = snapshot.messages;
  const markStats = pendingMarkStats(state, range.start, range.end);
  for (const { block } of validation.swallowed) {
    block.status = "consumed";
  }
  const clearedTokens = clearConsumedBlockRange(state, range.start, range.end);
  const intervalTokens = estimateIntervalTokens(
    history,
    range.start,
    range.end,
  );
  const consumedTokens = validation.swallowed.reduce(
    (sum, ref) => sum + ref.block.compressedTokens,
    0,
  );
  const coveredInactiveTokens = nettedCoveredInactiveTokens(validation);

  const id = allocateBlockId(state);
  const block: Block = {
    start: range.start,
    end: range.end,
    title: range.title,
    summary: prepared.summary,
    spanHash: computeSpanHash(snapshot, range.start, range.end),
    status: "active",
    compressedTokens:
      intervalTokens + clearedTokens - consumedTokens - coveredInactiveTokens,
    summaryTokens: prepared.summaryTokens,
    createdAt: Date.now(),
  };
  state.blocks.set(id, block);
  return { block, markCount: markStats.count };
}

// ---------------------------------------------------------------------------
// Batch compression
// ---------------------------------------------------------------------------

/**
 * Validate a single range's title (loud Chinese guidance).
 *
 * The title becomes the block's one-line index entry when a wider
 * recompression consumes this block, so it must be short and non-empty.
 * Control characters would split the single-line index lines, and runs
 * of 3+ hyphens would visually merge with the `--- b<N>: <title> ---`
 * separators — both rejected so the model retries.  The text names the
 * offending field only; the caller labels it with the failing range's
 * 1-based index.
 *
 * @param title - The raw title string.
 * @returns The trimmed, validated title.
 * @throws The guidance error (relative to the range) when the title is invalid.
 */
function validateRangeTitle(title: string): string {
  const trimmed = title.trim();
  if (trimmed.length === 0) {
    throw new Error(
      `title 不能为空：请用一行不超过 80 字符的主题说明` +
        `概括这段压缩内容（将来此块被更大范围压缩时，该主题会作为索引行展示）。`,
    );
  }
  for (let i = 0; i < trimmed.length; i++) {
    const code = trimmed.charCodeAt(i);
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) {
      throw new Error(`title 必须用单行纯文本概括主题，不含换行或控制字符。`);
    }
  }
  if (/-{3,}/.test(trimmed)) {
    throw new Error(
      `title 不能包含三个及以上连续连字符（---），` +
        `否则会破坏压缩块索引行的分隔格式。请改用其他标点（如破折号 ——）或文字分隔。`,
    );
  }
  if (trimmed.length > 80) {
    throw new Error(
      `title 过长（${trimmed.length} 字符，超过 80 字符上限）：` +
        `请压缩到 80 字符以内后重试。一行主题足够，详细内容请放进 summary。`,
    );
  }
  return trimmed;
}

/**
 * A range that passed resolution and gate validation.
 */
interface ValidatedRange {
  /** 1-based request index. */
  index: number;
  /** The original range input. */
  range: CompressRangeInput;
  /** The trimmed title. */
  title: string;
  /** The resolved ordinal interval. */
  start: number;
  /** The resolved ordinal interval (exclusive). */
  end: number;
}

/**
 * Batch-compress N ranges atomically against the same snapshot.
 *
 * Pipeline:
 * 1. Per-range input checks (maxRanges overflow, title rules) and
 *    endpoint resolution — failures are collected, not thrown.
 * 2. Per-range gate validation against the same transcript and block
 *    snapshot — a block created by an earlier range of the call is not
 *    yet registered, so it cannot influence a later range's gates.
 * 3. Cross-range rules: no overlapping spans; no range may consume the
 *    would-be block of an earlier range of the same call.
 * 4. Apply-time gates (no-new-content, negative-benefit) pre-flight for
 *    every range — again with zero mutation.
 * 5. Apply the whole batch in a single mutation pass, computing each
 *    block's span hash at creation and swallowing the pending marks the
 *    landed intervals cover.
 *
 * Any failure anywhere rejects the whole call: `created` is empty and
 * the state is untouched.  A single-range call is a length-1 array.
 *
 * @param snapshot - The projection snapshot (region view plus the
 *   invocation table feeding the mid-pair gate and the span hashes).
 * @param items - The numbered view items of the current round.
 * @param state - The session state (mutated only on full-batch success).
 * @param options - Protection windows, phantom threshold, range bound.
 * @param ranges - The requested ranges, in order.
 * @returns The created blocks, the per-range failures, and the swallowed
 *   pending-mark count.
 */
export function compressRanges(
  snapshot: Projection,
  items: NumberedItem[],
  state: SessionState,
  options: CompressOptions,
  ranges: CompressRangeInput[],
): CompressResult {
  const history = snapshot.messages;
  // ── Whole-call input gate ──────────────────────────────────────────
  if (options.maxRanges !== undefined && ranges.length > options.maxRanges) {
    return {
      created: [],
      failed: [],
      swallowedMarks: 0,
      error:
        `一次调用最多提交 ${options.maxRanges} 个压缩范围，本次提交了 ` +
        `${ranges.length} 个。请分批提交：每批不超过 ${options.maxRanges} ` +
        `个范围，分多次调用完成。`,
    };
  }

  // ── Phase 1: titles + endpoint resolution (zero mutation) ──────────
  const failures: RangeFailure[] = [];
  const validated: ValidatedRange[] = [];
  for (let i = 0; i < ranges.length; i++) {
    const range = ranges[i];
    let title: string;
    try {
      title = validateRangeTitle(range.title);
    } catch (err) {
      failures.push({
        index: i + 1,
        range,
        error: err instanceof Error ? err.message : String(err),
      });
      continue;
    }
    const span = resolveSpan(items, state, range.fromRef, range.toRef);
    if ("error" in span) {
      failures.push({ index: i + 1, range, error: span.error });
      continue;
    }
    validated.push({
      index: i + 1,
      range,
      title,
      start: span.start,
      end: span.end,
    });
  }
  if (failures.length > 0)
    return { created: [], failed: failures, swallowedMarks: 0 };

  // ── Phase 2: per-range gates against the same snapshot ─────────────
  const gateResults: RangeValidation[] = [];
  for (const entry of validated) {
    const result = validateRange(
      snapshot,
      items,
      state,
      options,
      entry.start,
      entry.end,
    );
    if (result.error !== null) {
      failures.push({
        index: entry.index,
        range: entry.range,
        error: result.error,
      });
    }
    gateResults.push(result);
  }
  if (failures.length > 0)
    return { created: [], failed: failures, swallowedMarks: 0 };

  // ── Phase 3: cross-range rules (zero mutation) ─────────────────────
  for (let i = 1; i < validated.length; i++) {
    const seg = validated[i];
    for (let j = 0; j < i; j++) {
      const prev = validated[j];
      if (prev.start >= seg.start && prev.end <= seg.end) {
        failures.push({
          index: seg.index,
          range: seg.range,
          error:
            `第 ${seg.index} 个范围（${spanLabel(items, seg.start, seg.end)}）会消费第 ${prev.index} 个范围` +
            `（${spanLabel(items, prev.start, prev.end)}）产生的压缩块：` +
            `同一调用内不允许消费本调用创建的块。请将这两个范围合并为一个更大的范围，` +
            `或调整边界避免覆盖其他范围的消息。`,
        });
      }
    }
  }
  if (failures.length > 0)
    return { created: [], failed: failures, swallowedMarks: 0 };

  for (let i = 1; i < validated.length; i++) {
    const seg = validated[i];
    for (let j = 0; j < i; j++) {
      const prev = validated[j];
      if (seg.start < prev.end && seg.end > prev.start) {
        failures.push({
          index: seg.index,
          range: seg.range,
          error:
            `第 ${seg.index} 个范围（${spanLabel(items, seg.start, seg.end)}）与第 ${prev.index} 个范围` +
            `（${spanLabel(items, prev.start, prev.end)}）重叠。` +
            `ranges 必须互不重叠，请调整边界后重试。`,
        });
      }
    }
  }
  if (failures.length > 0)
    return { created: [], failed: failures, swallowedMarks: 0 };

  // ── Phase 4: apply-time gates pre-flight (zero mutation) ───────────
  const preparedList: Array<{
    entry: ValidatedRange;
    result: RangeValidation;
    prepared: PreparedRange;
  }> = [];
  for (let i = 0; i < validated.length; i++) {
    const entry = validated[i];
    const result = gateResults[i];
    const outcome = prepareRange(
      history,
      state,
      {
        start: entry.start,
        end: entry.end,
        title: entry.title,
        summary: entry.range.summary,
      },
      result,
    );
    if (outcome.error !== null) {
      failures.push({
        index: entry.index,
        range: entry.range,
        error: outcome.error,
      });
      continue;
    }
    preparedList.push({ entry, result, prepared: outcome.prepared });
  }
  if (failures.length > 0)
    return { created: [], failed: failures, swallowedMarks: 0 };

  // ── Phase 5: apply the whole batch (single mutation pass) ──────────
  const created: Block[] = [];
  let swallowedMarks = 0;
  for (const { entry, result, prepared } of preparedList) {
    const applied = commitPreparedRange(
      snapshot,
      state,
      { start: entry.start, end: entry.end, title: entry.title },
      result,
      prepared,
    );
    created.push(applied.block);
    swallowedMarks += applied.markCount;
  }
  return { created, failed: [], swallowedMarks };
}
