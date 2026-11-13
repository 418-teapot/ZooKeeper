/**
 * Context report data types and formatting helpers.
 *
 * Declares the report data types (`ContextReport`,
 * `ContextCategoryBreakdown`) and the pure display helpers — the report
 * values are computed by the lens producer (`context-report-lens.ts`
 * over the host-agnostic lens), and the context panel renders them.
 *
 * @module
 */

// ---------------------------------------------------------------------------
// Report types (display-agnostic — only data)
// ---------------------------------------------------------------------------

/**
 * Heuristic category breakdown of token usage.
 *
 * - user / tool — CJK-aware part-level heuristic (CJK /1.5, other /4).
 * - assistant — API-reported `tokens.output` when available, else
 *   part-level heuristic fallback.
 * - system — everything not attributable to messages (system prompt +
 *   tool definitions + estimation slack): `total − user − assistant − tool`.
 */
export interface ContextCategoryBreakdown {
  user: number;
  assistant: number;
  tool: number;
  system: number;
}

/**
 * Complete context report (computation result, no formatting).
 */
export interface ContextReport {
  /** Total tokens (exact + heuristic). */
  total: number;
  /** API-reported tokens from the last completed assistant. */
  exact: number;
  /** Heuristic estimate for messages after the last assistant. */
  heuristic: number;
  /** Cache hit ratio (0–1), or null when unavailable. */
  cacheHitRate: number | null;
  /** Heuristic category breakdown. */
  categories: ContextCategoryBreakdown;
}

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
