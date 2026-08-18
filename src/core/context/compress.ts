/**
 * Ordinal-based compression core — model-driven folding of contiguous
 * transcript spans.
 *
 * A compression request describes one or more contiguous spans of the
 * current view; each span becomes a new block over its ordinal interval.
 * Endpoints are addressed by per-round line numbers and resolved through
 * the view layer (`resolveSpan`): an original item maps to its unit
 * interval, a summary item to its block's whole interval, and a reversed
 * pair of refs swaps instead of erroring.  Every gate (`validateRange`)
 * then runs against the same transcript and block snapshot — the first
 * gate that fails returns an actionable Chinese error text naming the
 * ordinal interval, and a failed range never mutates state.
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
 * of the fully-covered active blocks it consumes and the fully-covered
 * inactive blocks it absorbs — so previously compressed content is never
 * counted twice.  The stored summary carries the model text plus one-line
 * index entries (`--- bN: title ---`) for every absorbed block.
 *
 * @module
 */

import type { HostMessage } from "./lens.js";
import { findFirstUserOrdinal, findLastUserOrdinal } from "./lens.js";
import { estimateMessageHeuristic, estimateTokenCount } from "./measure.js";
import { computeSpanHash } from "./spanhash.js";
import type { Block, SessionState } from "./state.js";
import { clearConsumedBlockRange, nextBlockId } from "./state.js";
import type { NumberedItem } from "./view-refs.js";
import { resolveRange } from "./view-refs.js";

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
   * Active blocks fully covered by the range — consumed (deactivated)
   * when the range is applied.
   */
  swallowed: ConsumedBlockRef[];
  /**
   * Inactive blocks fully covered by the range — their compressed tokens
   * are netted out and they get an index line, but they are never
   * consumed again.
   */
  coveredInactive: ConsumedBlockRef[];
}

/**
 * One rejected range of a batch call, with its 1-based request index.
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
    if (block.active) activeIds.push(id);
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
 *    overlap; a fully-covered inactive block is carried on
 *    `coveredInactive` for token netting, a partially-covered one is
 *    ignored entirely.
 * 4. **Phantom** — the interval's heuristic estimate must reach
 *    `thresholdTokens`.
 *
 * Zero-mutation: the returned collections describe the apply, they do
 * not consume anything.  The apply-time gates (no-new-content,
 * negative-benefit) run later on the prepared payload.
 *
 * @param history - The transcript.
 * @param state - The session state (block collection, read-only here).
 * @param options - Protection windows and the phantom threshold.
 * @param start - First ordinal (inclusive).
 * @param end - Last ordinal (exclusive).
 * @returns The gate outcome.
 */
export function validateRange(
  history: HostMessage[],
  state: SessionState,
  options: CompressOptions,
  start: number,
  end: number,
): RangeValidation {
  const failed = (error: string): RangeValidation => ({
    error,
    swallowed: [],
    coveredInactive: [],
  });

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
    return failed(
      `范围 [${start}, ${end}) 触及保护区域（边界 ${boundary}）。` +
        `最近的对话内容受到保护、不可压缩，请将终点往前调整。`,
    );
  }

  // ── First-user gate ────────────────────────────────────────────────
  const firstUser = findFirstUserOrdinal(history);
  if (firstUser >= 0 && start <= firstUser && firstUser < end) {
    return failed(
      `范围 [${start}, ${end}) 包含会话的第一条用户消息（序数 ${firstUser}）。` +
        `第一条用户消息不可压缩，请调整起点。`,
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
    if (block.active) {
      if (!fullyCovered) {
        return failed(
          `范围与活跃压缩块 b${id} 部分重叠：该块覆盖的区间未被完整包含` +
            `（范围 [${start}, ${end}) 只覆盖了该块的一部分）。` +
            `跨块压缩必须完整消费整个块——请扩大范围以完整覆盖该块，` +
            `或改用该块摘要项的行号作为边界。`,
        );
      }
      swallowed.push({ id, block });
    } else if (fullyCovered) {
      // Inactive (superseded) block fully re-covered: not consumed (it is
      // already inactive) but its content is absorbed — carried so the
      // tokens are netted and it gets an index line.  Partially covered
      // inactive blocks are ordinary content again and ignored entirely.
      coveredInactive.push({ id, block });
    }
  }

  // ── Phantom gate ───────────────────────────────────────────────────
  const segTokens = estimateIntervalTokens(history, start, end);
  if (segTokens < options.thresholdTokens) {
    return failed(
      `范围 [${start}, ${end}) 预计仅约 ${segTokens} tokens，低于压缩阈值` +
        ` ${options.thresholdTokens}，收益过低。请选择更大的压缩范围。`,
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
  const coveredInactiveTokens = validation.coveredInactive.reduce(
    (sum, ref) => sum + ref.block.compressedTokens,
    0,
  );
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
 * Commit a prepared range: deactivate swallowed blocks, swallow the
 * pending marks of the landed interval, and create the new block.
 *
 * Runs only after every gate passed, so it cannot fail.  The block's
 * `compressedTokens` is computed with the authoritative
 * `clearConsumedBlockRange` return (the same figure the apply-time gates
 * saw pre-flight), and its `spanHash` is computed over the interval at
 * creation so `validateBlock` can self-verify the coverage later.
 *
 * @param history - The transcript.
 * @param state - The session state (mutated).
 * @param range - The resolved range with its validated title.
 * @param validation - The gate outcome (swallowed blocks consumed).
 * @param prepared - The gate-checked payload.
 * @returns The newly created block plus the count of swallowed marks.
 */
function commitPreparedRange(
  history: HostMessage[],
  state: SessionState,
  range: { start: number; end: number; title: string },
  validation: RangeValidation,
  prepared: PreparedRange,
): { block: Block; markCount: number } {
  const markStats = pendingMarkStats(state, range.start, range.end);
  for (const { block } of validation.swallowed) {
    block.active = false;
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
  const coveredInactiveTokens = validation.coveredInactive.reduce(
    (sum, ref) => sum + ref.block.compressedTokens,
    0,
  );

  const id = nextBlockId(state.blocks);
  const block: Block = {
    start: range.start,
    end: range.end,
    title: range.title,
    summary: prepared.summary,
    spanHash: computeSpanHash(history, range.start, range.end),
    active: true,
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
 * Validate a single range's title (loud Chinese guidance, range-indexed).
 *
 * The title becomes the block's one-line index entry when a wider
 * recompression consumes this block, so it must be short and non-empty.
 * Control characters would split the single-line index lines, and runs
 * of 3+ hyphens would visually merge with the `--- b<N>: <title> ---`
 * separators — both rejected so the model retries.
 *
 * @param title - The raw title string.
 * @param rangeIndex - The 1-based range index for the error message.
 * @returns The trimmed, validated title.
 * @throws The range-indexed guidance error when the title is invalid.
 */
function validateRangeTitle(title: string, rangeIndex: number): string {
  const trimmed = title.trim();
  if (trimmed.length === 0) {
    throw new Error(
      `第 ${rangeIndex} 个范围：title 不能为空：请用一行不超过 80 字符的主题说明` +
        `概括这段压缩内容（将来此块被更大范围压缩时，该主题会作为索引行展示）。`,
    );
  }
  for (let i = 0; i < trimmed.length; i++) {
    const code = trimmed.charCodeAt(i);
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) {
      throw new Error(
        `第 ${rangeIndex} 个范围：title 必须用单行纯文本概括主题，不含换行或控制字符。`,
      );
    }
  }
  if (/-{3,}/.test(trimmed)) {
    throw new Error(
      `第 ${rangeIndex} 个范围：title 不能包含三个及以上连续连字符（---），` +
        `否则会破坏压缩块索引行的分隔格式。请改用其他标点（如破折号 ——）或文字分隔。`,
    );
  }
  if (trimmed.length > 80) {
    throw new Error(
      `第 ${rangeIndex} 个范围：title 过长（${trimmed.length} 字符，超过 80 字符上限）：` +
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
 * @param history - The transcript.
 * @param items - The numbered view items of the current round.
 * @param state - The session state (mutated only on full-batch success).
 * @param options - Protection windows, phantom threshold, range bound.
 * @param ranges - The requested ranges, in order.
 * @returns The created blocks, the per-range failures, and the swallowed
 *   pending-mark count.
 */
export function compressRanges(
  history: HostMessage[],
  items: NumberedItem[],
  state: SessionState,
  options: CompressOptions,
  ranges: CompressRangeInput[],
): CompressResult {
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
      title = validateRangeTitle(range.title, i + 1);
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
      history,
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
            `第 ${seg.index} 个范围将消费第 ${prev.index} 个范围刚创建的压缩块：` +
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
            `第 ${seg.index} 个范围与第 ${prev.index} 个范围重叠` +
            `（[${seg.start}, ${seg.end}) 与 [${prev.start}, ${prev.end})）。` +
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
      history,
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
