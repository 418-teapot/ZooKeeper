/**
 * Context report formatting for the `/dcp context` command.
 *
 * Pure display layer -- all computation lives in `src/core/metrics.ts`.
 * Provides token/cache/percentage formatting helpers and the final
 * multi-line report string in Chinese (user-facing).
 *
 * @module
 */

import type { ContextReport } from "./metrics.js";
import {
  activeBlockCount,
  activeReclaimedTokens,
  type SessionState,
} from "./pruning/index.js";

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

/**
 * Humanize a token count for display.
 *
 * - n < 1000 -> bare number (e.g. "0", "500")
 * - n >= 1000 -> X.XK or XK (e.g. "1.0K", "45.2K", "200K")
 *
 * @param n - Token count.
 * @returns Formatted string.
 */
export function formatTokens(n: number): string {
  if (n >= 1000) {
    const val = n / 1000;
    return val >= 1000 ? `${Math.round(val)}K` : `${val.toFixed(1)}K`;
  }
  return String(Math.round(n));
}

/**
 * Build a 10-character progress bar using block & dot characters.
 *
 * @param ratio - Value between 0 and 1.
 * @returns A string like "███████░░░".
 */
export function progressBar(ratio: number, width: number = 10): string {
  const clamped = Math.max(0, Math.min(1, ratio));
  const filled = Math.round(clamped * width);
  return "█".repeat(filled) + "░".repeat(width - filled);
}

/**
 * Format a percentage (0-1) for display.
 *
 * - 0 -> "0%"
 * - 1 -> "100%"
 * - Otherwise -> one decimal place (e.g. "42.3%").
 *
 * @param ratio - Value between 0 and 1.
 * @returns Formatted string like "42.3%".
 */
export function formatPercent(ratio: number): string {
  const pct = ratio * 100;
  if (pct === 0) return "0%";
  if (pct === 100) return "100%";
  return `${pct.toFixed(1)}%`;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Optional parameters for {@link formatContextReport}.
 *
 * All fields are optional -- omitted fields are treated as absent/zero
 * and their corresponding lines are omitted from the report.
 */
export interface FormatContextReportOptions {
  /** Cumulative tokens reclaimed by pruning (from marks). */
  prunedTokens?: number;
  /** Count of marks still pending batch release. */
  pendingCount?: number;
  /** Total tokens still pending batch release. */
  pendingTokens?: number;
  /** Session state for deriving compression block stats. */
  state?: SessionState;
  /** Non-ignored message count in the folded view (模型可见). */
  foldedMessageCount?: number;
  /** Non-ignored message count in storage (存储). */
  storageMessageCount?: number;
}

// ---------------------------------------------------------------------------
// Full report formatter
// ---------------------------------------------------------------------------

/**
 * Format a context report into a human-readable multi-line string.
 *
 * Output is in Chinese (user-facing), with a 60-character line width
 * constraint suitable for TUI chat windows.  Only the compact summary
 * lines are shown: 用量, 缓存, 消息, 回收 (when pruned or pending).
 * The detailed category breakdown (user/asst/tool/sys with progress
 * bars) was dropped in favor of the TUI sidebar panel.
 *
 * Labels are padded with 4 trailing spaces so values align at one column.
 * Continuation lines (e.g. 待生效) use 8 spaces indent to align with the
 * value column (accounting for CJK double-width display).
 *
 * @param report - The computed context report.
 * @param opts - Optional display parameters.
 * @returns Formatted string for display.
 */
export function formatContextReport(
  report: ContextReport,
  opts?: FormatContextReportOptions,
): string {
  const {
    prunedTokens,
    pendingCount,
    pendingTokens,
    state,
    foldedMessageCount,
    storageMessageCount,
  } = opts ?? {};

  const lines: string[] = [];

  lines.push("━━ 上下文报告 ━━");
  lines.push("");

  // ── Usage line ────────────────────────────────────────────────────────
  lines.push(`用量    ~${formatTokens(report.total)} tokens`);

  // ── Cache hit rate ────────────────────────────────────────────────────
  if (report.cacheHitRate !== null) {
    lines.push(`缓存    ${formatPercent(report.cacheHitRate)}`);
  } else {
    lines.push(`缓存    —`);
  }

  // ── Message count ─────────────────────────────────────────────────────
  // Dual-scope when both folded and storage counts are available and
  // differ; single-count fallback otherwise.
  const folded = foldedMessageCount ?? report.messageCount;
  const storage = storageMessageCount ?? report.messageCount;
  if (folded === storage) {
    lines.push(`消息    ${report.messageCount} 条`);
  } else {
    lines.push(`消息    模型可见 ${folded} 条 · 存储 ${storage} 条`);
  }

  // ── Reclaim section ──────────────────────────────────────────────────
  // 已生效 = cumulative pruned tokens + active-block net reclaimed.
  // 待生效 appears only when pendingCount > 0.
  const blockCnt = state ? activeBlockCount(state) : 0;
  const blockReclaimed = state ? activeReclaimedTokens(state) : 0;
  let blockCovered = 0;
  if (state) {
    for (const [, block] of state.blocks) {
      if (block.active) {
        blockCovered += block.messageIds.length;
      }
    }
  }
  const pruneVal = prunedTokens ?? 0;
  const totalReclaimed = pruneVal + blockReclaimed;
  const hasPending = (pendingCount ?? 0) > 0;

  if (totalReclaimed > 0 || hasPending) {
    const parentheticalParts: string[] = [];
    if (blockCnt > 0) {
      parentheticalParts.push(`${blockCnt} 个压缩块，折叠 ${blockCovered} 条`);
    }
    if (pruneVal > 0) {
      parentheticalParts.push(`累计剪枝 ~${formatTokens(pruneVal)}`);
    }
    const parenthetical =
      parentheticalParts.length > 0
        ? `（${parentheticalParts.join("，")}）`
        : "";

    lines.push(
      `回收    已生效 ~${formatTokens(totalReclaimed)}${parenthetical}`,
    );

    if (hasPending) {
      lines.push(
        `        待生效 ~${formatTokens(pendingTokens ?? 0)}（${pendingCount} 个剪枝标记）`,
      );
    }
  }

  return lines.join("\n");
}
