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
  return String(n);
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
 * constraint suitable for TUI chat windows.  Shows five category rows
 * (user / asst / tool / sys / misc) with a header noting that asst
 * uses API exact tokens and the rest are heuristic estimates.
 *
 * @param report - The computed context report.
 * @returns Formatted string for display.
 */
export function formatContextReport(report: ContextReport): string {
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

  // ── Category breakdown ──────────────────────────────────────────────
  lines.push("");
  lines.push("分类占比（asst 为 API 精确，其余为估算）：");

  const catLabels: Array<[string, number]> = [
    ["user", report.categories.user],
    ["asst", report.categories.assistant],
    ["tool", report.categories.tool],
    ["sys", report.categories.system],
    ["misc", report.categories.misc],
  ];

  const maxLabelLen = Math.max(...catLabels.map(([l]) => l.length));

  for (const [label, value] of catLabels) {
    const pct = report.total > 0 ? value / report.total : 0;
    const paddedLabel = label.padEnd(maxLabelLen);
    lines.push(
      `${paddedLabel} ${progressBar(pct)} ${formatTokens(value).padStart(6)} ${formatPercent(pct).padStart(5)}`,
    );
  }

  // ── Footnote ─────────────────────────────────────────────────────────
  lines.push("注：sys 为系统 prompt 估算（含工具定义），misc 为其他残差");

  // ── Total footer ────────────────────────────────────────────────────
  lines.push("".padEnd(28, "━"));
  const totalFmt = formatTokens(report.total);
  lines.push(`总计 ${totalFmt.padStart(6)} ${formatPercent(1).padStart(5)}`);

  return lines.join("\n");
}
