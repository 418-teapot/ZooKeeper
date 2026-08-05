/**
 * Decompression core — the inverse of the range-mode compression pipeline.
 *
 * The `decompress` tool addresses a compression block by its `b<N>` id and
 * either restores it or recalls its summary:
 *
 * - **restore** — the block is active (`active === true`): deactivate it so
 *   the next transform round un-folds it and the original messages reappear
 *   in the view.  The deactivation cause is recorded as
 *   `deactivatedBy = "user"` to distinguish it from blocks consumed by a
 *   wider recompression, which leave `deactivatedBy` unset.
 * - **recall** — the block is inactive (consumed by a bigger block, its
 *   anchor invalidated, or previously restored): read-only and idempotent,
 *   returns the persisted summary body.  Re-calling recall on the same
 *   block never errors.
 *
 * Pure logic module with zero framework dependencies — the tool adapter
 * layer (opencode tool hook) supplies the context limit and drives the
 * restore gate.  All errors are loud Chinese guidance messages — the model
 * self-corrects by re-picking a valid block id from the visible view.
 *
 * @module
 */

import type { CompressionBlock } from "./blocks.js";
import type { SessionState } from "./marks.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Maximum character length of a recalled summary body (~4K tokens).
 * Longer summaries are truncated with a Chinese tail note.
 */
export const RECALL_MAX_CHARS = 16000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Result of resolving a `b<N>` decompress target.
 *
 * - `{ kind: "restore", block }` — the block is active; deactivate it so
 *   the next transform round un-folds the original messages.
 * - `{ kind: "recall", block }` — the block is inactive; read its summary.
 */
export type ResolveTargetResult =
  | { kind: "restore"; block: CompressionBlock }
  | { kind: "recall"; block: CompressionBlock };

/**
 * Result of the restore context-limit gate.
 *
 * `{ allowed: false, reason }` carries a Chinese guidance message quoting
 * the estimated post-restore tokens, the limit×percent threshold, the net
 * delta (the expansion the restore will bring back), and the alternative
 * (compress other segments first to free space).
 */
export type GateResult = { allowed: true } | { allowed: false; reason: string };

// ---------------------------------------------------------------------------
// resolveTarget
// ---------------------------------------------------------------------------

/**
 * Parse a `b<N>` target id and resolve it against the session state.
 *
 * The id must match `b` followed by a positive integer (`b3`); anything
 * else — `"3"`, `"b0"`, `"b-1"`, `"bx"`, `""` — throws a loud Chinese
 * format error explaining where valid ids appear in the visible view
 * (block headers `[Compression Block bN]` and superseded index lines
 * `--- bN: <title> ---`).  A well-formed id that matches no block throws
 * a loud Chinese not-found error.  Valid ids resolve to the block by its
 * numeric id (`String(blockId)` map key).
 *
 * @param state - The session state (blocks map).
 * @param blockId - The target id (e.g. `"b3"`).
 * @returns The resolved target — `"restore"` for active blocks,
 *   `"recall"` for inactive ones.
 */
export function resolveTarget(
  state: SessionState,
  blockId: string,
): ResolveTargetResult {
  const match = /^b([1-9]\d*)$/.exec(blockId);
  if (match === null) {
    throw new Error(
      `decompress 目标 "${blockId}" 格式非法：只接受 "b<N>" 形式（N 为正整数，如 "b3"）。有效编号可从当前会话可见内容中获取——压缩块头形如 "[Compression Block bN]"，索引行形如 "--- bN: <title> ---"，请勿凭记忆编造编号。`,
    );
  }
  const block = state.blocks.get(match[1]);
  if (block === undefined) {
    throw new Error(
      `压缩块 b${match[1]} 不存在。有效编号可从当前会话可见内容中获取——压缩块头形如 "[Compression Block bN]"，索引行形如 "--- bN: <title> ---"，请勿凭记忆编造编号。`,
    );
  }
  return block.active ? { kind: "restore", block } : { kind: "recall", block };
}

// ---------------------------------------------------------------------------
// evaluateGate
// ---------------------------------------------------------------------------

/**
 * Evaluate the restore context-limit gate.
 *
 * Computes `after = currentPromptTokens + (compressedTokens - summaryTokens)`
 * — the block's net view occupancy (the delta).  Pruned tool outputs are
 * still placeholders at gate time, making this a conservative over-estimate
 * — acceptable.
 *
 * - `contextLimit === undefined` skips the gate (allowed) — mirrors the
 *   nudge subsystem's missing-limit behavior.
 * - `after > contextLimit × rejectPercent / 100` is rejected with a
 *   Chinese reason quoting the estimated post-restore tokens, the
 *   limit×percent threshold, the delta, and guidance to compress other
 *   segments first.  The boundary `after == threshold` passes.
 *
 * @param currentPromptTokens - Current estimated prompt tokens.
 * @param block - The block being restored.
 * @param contextLimit - The model context window in tokens, or undefined
 *   to skip the gate.
 * @param rejectPercent - Reject threshold as a percentage of the limit.
 * @returns The gate verdict.
 */
export function evaluateGate(
  currentPromptTokens: number,
  block: CompressionBlock,
  contextLimit: number | undefined,
  rejectPercent: number,
): GateResult {
  if (contextLimit === undefined) return { allowed: true };
  const delta = block.compressedTokens - block.summaryTokens;
  const after = currentPromptTokens + delta;
  const threshold = (contextLimit * rejectPercent) / 100;
  if (after > threshold) {
    return {
      allowed: false,
      reason: `恢复压缩块 b${block.blockId} 后预计上下文约 ${after} tokens，超过解压阈值 ${threshold} tokens（${rejectPercent}% × ${contextLimit}）。本次解压将回胀约 ${delta} tokens（原内容 ${block.compressedTokens} - 摘要 ${block.summaryTokens}）。请先压缩其他片段腾出空间后，再恢复该压缩块。`,
    };
  }
  return { allowed: true };
}

// ---------------------------------------------------------------------------
// applyDecompress
// ---------------------------------------------------------------------------

/**
 * Apply a restore deactivation to an active block.
 *
 * Marks the block inactive with `deactivatedBy = "user"` (distinguishing
 * it from blocks consumed by a wider recompression, which leave the field
 * unset) and stamps `deactivatedAt`.  Sets `state.dirty = true`.  Pure
 * mutation — no persistence; the caller saves the state.
 *
 * @param state - The session state (dirty flag mutated).
 * @param block - The block to deactivate.
 */
export function applyDecompress(
  state: SessionState,
  block: CompressionBlock,
): void {
  block.active = false;
  block.deactivatedBy = "user";
  block.deactivatedAt = Date.now();
  state.dirty = true;
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
    `\n[摘要过长已截断：省略 ${omitted} 字符]`
  );
}
