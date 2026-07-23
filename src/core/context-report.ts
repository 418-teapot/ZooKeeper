/**
 * Context report formatting for the `/dcp context` command.
 *
 * Pure display layer — all computation lives in `src/core/metrics.ts`.
 * Provides token/cache/percentage formatting helpers and the final
 * multi-line report string in Chinese (user-facing).
 *
 * @module
 */

import type { ContextReport } from "./metrics.js";

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

/**
 * Humanize a token count for display.
 *
 * - n < 1000 → bare number (e.g. "0", "500")
 * - n >= 1000 → X.XK or XK (e.g. "1.0K", "45.2K", "200K")
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
 * Format a percentage (0–1) for display.
 *
 * - 0 → "0%"
 * - 1 → "100%"
 * - Otherwise → one decimal place (e.g. "42.3%").
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
// Full report formatter
// ---------------------------------------------------------------------------

/**
 * Format a context report into a human-readable multi-line string.
 *
 * Output is in Chinese (user-facing), with a 60-character line width
 * constraint suitable for TUI chat windows.  Only the compact summary
 * lines are shown: 用量, 消息, 缓存 (and 剪枝 when prunedTokens > 0).
 * The detailed category breakdown (user/asst/tool/sys/misc with progress
 * bars) was dropped in favor of the TUI sidebar panel.
 *
 * @param report - The computed context report.
 * @param prunedTokens - Optional cumulative tokens reclaimed by pruning.
 * @returns Formatted string for display.
 */
export function formatContextReport(
  report: ContextReport,
  prunedTokens?: number,
): string {
  const lines: string[] = [];

  lines.push("━━ 上下文报告 ━━");
  lines.push("");

  // ── Usage line ──────────────────────────────────────────────────────
  lines.push(`用量  ~${formatTokens(report.total)} tokens`);

  // ── Message count ───────────────────────────────────────────────────
  lines.push(`消息  ${report.messageCount} 条`);

  // ── Cache hit rate ──────────────────────────────────────────────────
  if (report.cacheHitRate !== null) {
    lines.push(
      `缓存  ${formatPercent(report.cacheHitRate)}（基于最近一次 LLM 调用）`,
    );
  } else {
    lines.push("缓存  —（无最近 LLM 调用数据）");
  }

  // ── Pruned (context pruning) ────────────────────────────────────────
  if (prunedTokens && prunedTokens > 0) {
    lines.push(`剪枝  ${formatTokens(prunedTokens)} tokens（累计回收）`);
  }

  return lines.join("\n");
}
