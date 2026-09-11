/**
 * Decompression core — the inverse of the ordinal compression phase.
 *
 * The `decompress` tool addresses a compression block by its persistent
 * `b<N>` id (the block map key) and either restores it or recalls its
 * summary:
 *
 * - **restore** — the block is active (`status === "active"`): move it
 *   to `consumed` so the next fold round stops folding its interval and
 *   the original messages reappear in the view.  View expansion is the
 *   fold phase's job — this module never touches the transcript.  A
 *   context-limit gate rejects restores that would push the estimated
 *   prompt over `maxFillPercent` of the model window.
 * - **recall** — the block is in a terminal status (`consumed` by a
 *   wider block or by an earlier restore, or `stale` — its span no
 *   longer verifies): the restore is refused and the operation resolves to
 *   read-only recall — the persisted summary body, truncated to
 *   `RECALL_MAX_CHARS` and framed by a note stating that no original text
 *   is being restored.  Idempotent, zero state change.  A stale recall
 *   labels itself as such: the summary survives, the original text it
 *   addressed does not.
 *
 * Pure logic module with zero framework dependencies — the tool adapter
 * layer supplies the current token estimate and the model context limit
 * and drives the restore gate.  All errors are loud Chinese guidance
 * messages — the model self-corrects by re-picking a valid block id from
 * the visible view.
 *
 * @module
 */

import type { HostMessage } from "./lens.js";
import { type Block, RECALL_MAX_CHARS, type SessionState } from "./state.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Result of resolving a `b<N>` decompress target.
 *
 * - `{ kind: "restore", blockId, block }` — the block is active;
 *   move it to `consumed` so the next fold round un-folds the original
 *   messages.
 * - `{ kind: "recall", blockId, block }` — the block is in a terminal
 *   status; the restore is refused and the operation reads its summary
 *   body instead.
 */
export type ResolveTargetResult =
  | { kind: "restore"; blockId: number; block: Block }
  | { kind: "recall"; blockId: number; block: Block };

/**
 * Result of the restore context-limit gate.
 *
 * `{ allowed: false, reason }` carries a Chinese guidance message quoting
 * the estimated post-restore tokens, the current and post-restore fill
 * rates, the limit×percent threshold, the net delta (the expansion the
 * restore will bring back), and the alternative (compress other segments
 * first to free space).
 */
export type GateResult = { allowed: true } | { allowed: false; reason: string };

/**
 * Restore data returned by `applyDecompress`.
 *
 * Carries everything the tool adapter needs to report the restore
 * without reaching into the transcript: the block id (`b<N>`), the
 * summary body, the covered interval, the message count that will
 * reappear in the view, and the token accounting (`restoredTokens` is
 * the net expansion — `compressedTokens - summaryTokens`).
 */
export interface DecompressRestoreResult {
  /** Block id (`b<N>`). */
  blockId: number;
  /** The block's summary body. */
  summary: string;
  /** First covered ordinal (inclusive). */
  start: number;
  /** Last covered ordinal (exclusive). */
  end: number;
  /** Number of transcript messages that reappear in the view. */
  messageCount: number;
  /** Net token expansion of the restore. */
  restoredTokens: number;
  /** Estimated tokens of the covered original messages. */
  compressedTokens: number;
  /** Estimated tokens of the summary body. */
  summaryTokens: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Compose the loud not-found error for a block id.
 *
 * Actionable guidance: the message lists every block number currently in
 * the state, so the model can re-pick a valid id from the visible view
 * instead of guessing.
 *
 * @param state - The session state (blocks map).
 * @param blockId - The unresolved block id.
 * @returns The Chinese not-found error text.
 */
function notFoundError(state: SessionState, blockId: number): string {
  const ids = [...state.blocks.keys()].sort((a, b) => a - b);
  if (ids.length === 0) {
    return `压缩块 b${blockId} 不存在。当前会话没有已创建的压缩块。`;
  }
  return (
    `压缩块 b${blockId} 不存在。当前会话共有 ${ids.length} 个压缩块：` +
    `${ids.map((id) => `b${id}`).join("、")}。` +
    `压缩块头形如 "[Block bN · K 条]"，请勿凭记忆编造编号。`
  );
}

// ---------------------------------------------------------------------------
// resolveTarget
// ---------------------------------------------------------------------------

/**
 * Parse a `b<N>` target id and resolve it against the session state.
 *
 * The id must match `b` followed by a positive integer (`b3`); anything
 * else — `"3"`, `"b0"`, `"b-1"`, `"bx"`, `""` — throws a loud Chinese
 * format error explaining where valid ids appear in the visible view
 * (block headers `[Block bN · K 条]` and superseded index lines
 * `--- bN: <title> ---`).  A well-formed id that matches no block throws
 * a loud Chinese not-found error listing the currently available block
 * numbers.  Valid ids resolve to the block by its numeric id — the block
 * map key, `bN` being the block id.
 *
 * @param state - The session state (blocks map).
 * @param ref - The target id (e.g. `"b3"`).
 * @returns The resolved target — `"restore"` for active blocks,
 *   `"recall"` for terminal ones (the restore is refused and the summary
 *   body is read instead).
 */
export function resolveTarget(
  state: SessionState,
  ref: string,
): ResolveTargetResult {
  const match = /^b([1-9]\d*)$/.exec(ref);
  if (match === null) {
    throw new Error(
      `decompress 目标 "${ref}" 格式非法：只接受 "b<N>" 形式（N 为正整数，如 "b3"）。` +
        `有效编号可从当前会话可见内容中获取——压缩块头形如 "[Block bN · K 条]"，` +
        `索引行形如 "--- bN: <title> ---"，请勿凭记忆编造编号。`,
    );
  }
  const blockId = Number(match[1]);
  const block = state.blocks.get(blockId);
  if (block === undefined) {
    throw new Error(notFoundError(state, blockId));
  }
  return block.status === "active"
    ? { kind: "restore", blockId, block }
    : { kind: "recall", blockId, block };
}

// ---------------------------------------------------------------------------
// evaluateGate
// ---------------------------------------------------------------------------

/**
 * Evaluate the restore context-limit gate.
 *
 * Computes `after = currentPromptTokens + (compressedTokens - summaryTokens)`
 * — the block's net view occupancy (the delta).  Pruned tool outputs are
 * still placeholders at gate time, making this a conservative
 * over-estimate — acceptable.
 *
 * - `contextLimit === undefined` skips the gate (allowed) — no limit
 *   means nothing to check against.
 * - `maxFillPercent === undefined || maxFillPercent === 0` also skips
 *   the gate (allowed) — an unset or zero ceiling means no fill limit.
 * - `after > contextLimit × maxFillPercent / 100` is rejected with a
 *   Chinese reason quoting the estimated post-restore tokens, the
 *   current and post-restore fill rates, the limit×percent threshold,
 *   the delta, and guidance to compress other segments first.  The
 *   boundary `after == threshold` passes.
 *
 * @param currentPromptTokens - Current estimated prompt tokens.
 * @param block - The block being restored.
 * @param blockId - The block id (`b<N>`), quoted in the rejection reason.
 * @param contextLimit - The model context window in tokens, or undefined
 *   to skip the gate.
 * @param maxFillPercent - Max fill threshold as a percentage of the
 *   limit; undefined or 0 skips the gate.
 * @returns The gate verdict.
 */
export function evaluateGate(
  currentPromptTokens: number,
  block: Block,
  blockId: number,
  contextLimit: number | undefined,
  maxFillPercent: number | undefined,
): GateResult {
  if (contextLimit === undefined) return { allowed: true };
  if (maxFillPercent === undefined || maxFillPercent === 0) {
    return { allowed: true };
  }
  const delta = block.compressedTokens - block.summaryTokens;
  const after = currentPromptTokens + delta;
  const threshold = (contextLimit * maxFillPercent) / 100;
  if (after > threshold) {
    const currentPct = Math.round((currentPromptTokens / contextLimit) * 100);
    const afterPct = Math.round((after / contextLimit) * 100);
    return {
      allowed: false,
      reason:
        `恢复压缩块 b${blockId} 后，预计上下文约 ${after} tokens` +
        `（当前约 ${currentPromptTokens} tokens，填充率将由约 ${currentPct}%` +
        ` 升至约 ${afterPct}%），超过解压阈值 ${threshold} tokens` +
        `（${maxFillPercent}% × ${contextLimit}）。` +
        `本次解压将回胀约 ${delta} tokens（原内容 ${block.compressedTokens}` +
        ` - 摘要 ${block.summaryTokens}）。请先压缩其他片段腾出空间后，再恢复该压缩块。`,
    };
  }
  return { allowed: true };
}

// ---------------------------------------------------------------------------
// applyDecompress
// ---------------------------------------------------------------------------

/**
 * Apply a restore to an active block.
 *
 * Looks the block up by its numeric id, moves it to `consumed` (the
 * next fold round naturally expands its interval — view expansion is the
 * fold phase's responsibility, never this module's), and returns the
 * restore data the adapter reports (summary, interval, message count,
 * and token accounting).  The transcript is never touched.
 *
 * Defensive: a missing block throws the same loud not-found error as
 * `resolveTarget`; a block in a terminal status throws a loud error —
 * duplicate restores are refused (the normal path never reaches this,
 * because `resolveTarget` resolves terminal blocks to recall).  A stale
 * block is told apart from a consumed one because its original content
 * is gone for good, not merely unfolded.
 *
 * @param state - The session state (blocks map mutated).
 * @param blockId - The block id (`b<N>`).
 * @param history - The current transcript (read-only, never mutated);
 *   bounds the message count when the block interval lies within the
 *   transcript.
 * @returns The restore data.
 */
export function applyDecompress(
  state: SessionState,
  blockId: number,
  history: HostMessage[],
): DecompressRestoreResult {
  const block = state.blocks.get(blockId);
  if (block === undefined) {
    throw new Error(notFoundError(state, blockId));
  }
  if (block.status !== "active") {
    throw new Error(
      block.status === "stale"
        ? `压缩块 b${blockId} 已失效，无法恢复：其中的原始消息已发生变化，` +
            `原文无法取回。再次调用 decompress 只能读取仍保存的摘要。`
        : `压缩块 b${blockId} 已不能恢复原文（它已经恢复过，或已被更大的压缩块覆盖）。` +
            `如需回顾结论，请再次调用 decompress 读取保存的摘要；本次不会恢复原文。`,
    );
  }
  block.status = "consumed";
  const messageCount = Math.max(
    0,
    Math.min(block.end, history.length) - block.start,
  );
  return {
    blockId,
    summary: block.summary,
    start: block.start,
    end: block.end,
    messageCount,
    restoredTokens: block.compressedTokens - block.summaryTokens,
    compressedTokens: block.compressedTokens,
    summaryTokens: block.summaryTokens,
  };
}

// ---------------------------------------------------------------------------
// Recall summary truncation
// ---------------------------------------------------------------------------

/**
 * Truncate a recalled summary body to `RECALL_MAX_CHARS` characters.
 *
 * When the summary exceeds the cap, the first `RECALL_MAX_CHARS`
 * characters are kept and a Chinese tail note is appended stating that
 * the summary was truncated and how many characters were omitted.
 * Otherwise the summary is returned unchanged.
 *
 * @param summary - The block's persisted summary body.
 * @returns The possibly-truncated summary.
 */
export function truncateRecallSummary(summary: string): string {
  if (summary.length <= RECALL_MAX_CHARS) return summary;
  const omitted = summary.length - RECALL_MAX_CHARS;
  return (
    summary.slice(0, RECALL_MAX_CHARS) +
    `\n[摘要过长已截断：省略 ${omitted} 字符，省略部分无法取回]`
  );
}

/**
 * Compose the recall output of one block.
 *
 * Recall is the read-only branch of decompress: it returns the persisted
 * summary body and changes nothing.  Because a tool result that reads
 * like prose is easy to mistake for restored original text, the body is
 * always framed by a status note naming the block id, stating that the
 * original text is NOT being restored, and (for a stale block) that the
 * summary is all that survives of the span.
 *
 * @param block - The recalled block.
 * @param blockId - The block id (`b<N>`), named in the status note.
 * @returns The framed recall text the tool returns.
 */
export function recallOutput(block: Block, blockId: number): string {
  const body = truncateRecallSummary(block.summary);
  const note =
    block.status === "stale"
      ? `【只读召回 · 未恢复原文】压缩块 b${blockId} 已失效：其原文区间已无法核对，原文不可能再被恢复，` +
        `以下是仅存的持久化摘要（视图未变动）：`
      : `【仅返回摘要，未恢复原文】压缩块 b${blockId} 已经恢复过，或已被更大的压缩块覆盖。` +
        `本次调用不改变状态，以下是保存的摘要：`;
  return `${note}\n${body}`;
}
