/**
 * Lens-based cache and token statistics for the TUI sidebar.
 *
 * Aggregates the API-reported `usage` fields of the host-agnostic lens
 * transcript into the sidebar's cache/input/output breakdown, the cache
 * hit-rate trend between the last two completed assistants, and the
 * cumulative cache hit rate.  These are the lens replacements for the
 * v1 adapter's `computeTokenBreakdown` / `computeCacheTrend` /
 * `computeCumulativeCacheRate`, so the sidebar and `/dcp` share one
 * measurement pipeline and no host message structures are unpacked.
 *
 * All three read `HostMessage.usage` only: a message without usage
 * contributes nothing, and the cache-rate convention is
 * `cacheRead / (input + cacheRead + cacheWrite)` — the same denominator
 * the report's cache hit rate uses.
 *
 * @module
 */

import type { HostMessage } from "./lens.js";

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

/**
 * Token breakdown across assistant messages.
 *
 * Aggregates cache.read, uncached input, and output from every assistant
 * message with usage data.  `total` is the sum of the three components
 * and serves as the denominator for percentage display.
 */
export interface TokenBreakdownResult {
  /** Total cache read tokens across all assistants. */
  cacheRead: number;
  /** Total uncached input tokens across all assistants. */
  input: number;
  /** Total output tokens across all assistants. */
  output: number;
  /** Sum of cacheRead + input + output. */
  total: number;
}

/**
 * Result of comparing the last two assistant messages' cache hit rates.
 */
export interface CacheTrendResult {
  /** Cache hit rate of the last completed assistant (0–1), or null. */
  lastRate: number | null;
  /** Cache hit rate of the previous completed assistant (0–1), or null. */
  previousRate: number | null;
  /** Trend delta in percentage points (positive = up), or null. */
  trend: number | null;
  /** Whether both last and previous rates are available for display. */
  hasTrendData: boolean;
  /**
   * Display label for the trend arrow.
   *
   * - `"↑X.X%"` when trend > 0
   * - `"↓X.X%"` when trend < 0
   * - `"-"` when trend is exactly 0
   * - `null` when there is no previous assistant
   */
  trendLabel: string | null;
}

/**
 * Cumulative cache hit rate derived from all assistant messages.
 */
export interface CumulativeCacheResult {
  /** Cumulative cache hit rate (0–1), or null when unavailable. */
  cumulativeRate: number | null;
  /** Total cache read tokens across all assistants. */
  totalRead: number;
  /** Total denominator (input + read + write) across all assistants. */
  totalDenominator: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Compute the cache hit rate of one message's usage.
 *
 * Callers are responsible for filtering by role.  Follows the ZooKeeper
 * convention `cacheRead / (input + cacheRead + cacheWrite)`; returns
 * null when the message carries no usage or the denominator is zero.
 *
 * @param message - The message whose usage is read.
 * @returns Cache hit rate (0–1), or null when not computable.
 */
function cacheRateOf(message: HostMessage): number | null {
  const usage = message.usage;
  if (!usage) return null;
  const cacheRead = usage.cacheRead ?? 0;
  const cacheWrite = usage.cacheWrite ?? 0;
  const input = usage.input ?? 0;
  const denominator = input + cacheRead + cacheWrite;
  if (denominator <= 0) return null;
  return cacheRead / denominator;
}

// ---------------------------------------------------------------------------
// Public statistics
// ---------------------------------------------------------------------------

/**
 * Compute a token breakdown across all assistant messages.
 *
 * Sums cache.read, input, and output from each assistant message that
 * carries usage data; non-assistant roles are ignored.  Missing fields
 * are treated as zero.
 *
 * @param messages - The lens transcript.
 * @returns The breakdown totals.
 */
export function computeTokenBreakdown(
  messages: HostMessage[],
): TokenBreakdownResult {
  let cacheRead = 0;
  let input = 0;
  let output = 0;

  for (const message of messages) {
    if (message?.role !== "assistant") continue;
    const usage = message.usage;
    if (!usage) continue;
    cacheRead += usage.cacheRead ?? 0;
    input += usage.input ?? 0;
    output += usage.output ?? 0;
  }

  return { cacheRead, input, output, total: cacheRead + input + output };
}

/**
 * Compare the last two assistant messages' cache hit rates.
 *
 * Scans in reverse for the last two assistant messages with a valid
 * rate.  The trend is the difference in percentage points
 * (`(lastRate − previousRate) × 100`); the label is `"↑X.X%"` /
 * `"↓X.X%"` / `"-"` (for zero), or null when fewer than two assistants
 * have a valid rate.
 *
 * @param messages - The lens transcript.
 * @returns The trend result with last/previous rates and a display label.
 */
export function computeCacheTrend(messages: HostMessage[]): CacheTrendResult {
  let lastRate: number | null = null;
  let previousRate: number | null = null;

  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message?.role !== "assistant") continue;
    const rate = cacheRateOf(message);
    if (rate === null) continue;
    if (lastRate === null) {
      lastRate = rate;
    } else {
      previousRate = rate;
      break;
    }
  }

  const hasTrendData = lastRate !== null && previousRate !== null;
  const trend =
    hasTrendData && lastRate !== null && previousRate !== null
      ? (lastRate - previousRate) * 100
      : null;

  let trendLabel: string | null = null;
  if (trend !== null) {
    if (trend > 0) trendLabel = `↑${trend.toFixed(1)}%`;
    else if (trend < 0) trendLabel = `↓${Math.abs(trend).toFixed(1)}%`;
    else trendLabel = "-";
  }

  return { lastRate, previousRate, trend, hasTrendData, trendLabel };
}

/**
 * Compute the cumulative cache hit rate across all assistant messages.
 *
 * This is the message-sum fallback — prefer session-level aggregates
 * (the host session's own token report) when available, since they
 * reflect the full session without truncation.  The rate follows the
 * ZooKeeper convention `totalRead / (totalInput + totalRead +
 * totalWrite)`.
 *
 * @param messages - The lens transcript.
 * @returns The cumulative cache result.
 */
export function computeCumulativeCacheRate(
  messages: HostMessage[],
): CumulativeCacheResult {
  let totalInput = 0;
  let totalRead = 0;
  let totalWrite = 0;

  for (const message of messages) {
    if (message?.role !== "assistant") continue;
    const usage = message.usage;
    if (!usage) continue;
    totalInput += usage.input ?? 0;
    totalRead += usage.cacheRead ?? 0;
    totalWrite += usage.cacheWrite ?? 0;
  }

  const denominator = totalInput + totalRead + totalWrite;
  return {
    cumulativeRate: denominator > 0 ? totalRead / denominator : null,
    totalRead,
    totalDenominator: denominator,
  };
}
