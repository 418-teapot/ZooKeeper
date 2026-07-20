/**
 * Context metrics — single measurement module for ZooKeeper.
 *
 * Provides types and functions for measuring estimated context token
 * usage using a hybrid approach: API-reported tokens from the last completed
 * assistant message plus CJK-aware heuristic estimates (CJK /1.5, other /4)
 * for subsequent messages.
 *
 * This module is the **sole** source of all measurement logic:
 * - `estimateMessageHeuristic` — tool-aware per-message estimator
 * - `findLastCompletedAssistant` — shared skeleton for the reverse search
 * - `measureContext` — hook-friendly, logs + returns `ContextMetricsResult`
 * - `computeContextReport` — full report with cache rate + category breakdown
 *
 * All functions have no OpenCode framework dependencies.
 *
 * @module
 */

import { log } from "../utils/logger.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Token information on a completed assistant message.
 */
export interface ContextTokenInfo {
  input?: number;
  output?: number;
  reasoning?: number;
  cache?: {
    read?: number;
    write?: number;
  };
}

/**
 * Minimal shape of `info` within a message entry.
 */
export interface ContextMessageInfo {
  role: string;
  id: string;
  sessionID?: string;
  tokens?: ContextTokenInfo;
  agent?: string;
  /** Whether this message is a compaction summary placeholder. */
  summary?: boolean;
}

/**
 * A text part within a message's `parts` array.
 */
export interface ContextTextPart {
  type: string;
  text?: string;
}

/**
 * A single message entry in the hook output.
 */
export interface ContextMessageEntry {
  info: ContextMessageInfo;
  parts?: ContextTextPart[];
}

/**
 * Output object passed to the messages.transform hook.
 */
export interface ContextMetricsOutput {
  messages?: ContextMessageEntry[] | null;
}

/**
 * Result returned by `measureContext`.
 */
export interface ContextMetricsResult {
  estimated_tokens: number;
  message_count: number;
  exact_tokens: number;
  estimated_new_tokens: number;
  agent: string;
}

// ---------------------------------------------------------------------------
// Report types (display-agnostic — only data)
// ---------------------------------------------------------------------------

/**
 * Heuristic category breakdown of token usage.
 *
 * - user / tool — CJK-aware part-level heuristic (CJK /1.5, other /4).
 * - assistant — API-reported `tokens.output` when available, else
 *   part-level heuristic fallback.
 * - system — DCP-style estimate of the system prompt and tool
 *   definitions: (first assistant (input + cache)) − first user heuristic.
 * - misc — residual that absorbs non-text parts, reasoning gap,
 *   estimation noise, etc.
 */
export interface ContextCategoryBreakdown {
  user: number;
  assistant: number;
  tool: number;
  system: number;
  misc: number;
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
  /** Total message count. */
  messageCount: number;
  /** Cache hit ratio (0–1), or null when unavailable. */
  cacheHitRate: number | null;
  /** Heuristic category breakdown. */
  categories: ContextCategoryBreakdown;
}

// ---------------------------------------------------------------------------
// Helpers — tool-part-aware estimation
// ---------------------------------------------------------------------------

/**
 * Minimal tool part shape that may appear inside a message's parts array.
 */
interface PartWithToolState {
  type: string;
  text?: string;
  state?: {
    input?: unknown;
    output?: unknown;
  };
}

/**
 * Estimate token count for a plain string using a CJK-aware heuristic.
 *
 * CJK characters (Unicode ranges: U+4E00–U+9FFF, U+3400–U+4DBF,
 * U+3000–U+303F, U+FF00–U+FFEF) are divided by 1.5; all others by 4.
 * The result is rounded up via `Math.ceil`.
 *
 * @param text - Input string.
 * @returns Estimated token count.
 */
function estimateStringTokens(text: string): number {
  if (!text) return 0;
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (
      (code >= 0x4e00 && code <= 0x9fff) || // CJK Unified Ideographs
      (code >= 0x3400 && code <= 0x4dbf) || // CJK Extension A
      (code >= 0x3000 && code <= 0x303f) || // CJK Symbols & Punctuation
      (code >= 0xff00 && code <= 0xffef) // Fullwidth / Halfwidth forms
    ) {
      cjk++;
    } else {
      other++;
    }
  }
  return Math.ceil(cjk / 1.5 + other / 4);
}

/**
 * Estimate token count for an arbitrary value.
 *
 * - null / undefined → 0
 * - string → `estimateStringTokens`
 * - other → JSON.stringify first, then `estimateStringTokens`
 */
function estimateTokenCount(val: unknown): number {
  if (val == null) return 0;
  const str = typeof val === "string" ? val : JSON.stringify(val);
  return estimateStringTokens(str);
}

/**
 * Estimate token count for a single message using CJK-aware heuristic.
 *
 * Text parts are estimated via `estimateStringTokens`; tool parts via
 * `estimateTokenCount` (input + output).  Parts of other types or
 * without text/tool content contribute 0.
 *
 * **Defensive:** returns 0 for falsy messages or parts arrays.
 *
 * @param msg - The message entry to estimate.
 * @returns Estimated token count, or 0 if no content found.
 */
export function estimateMessageHeuristic(
  msg: ContextMessageEntry | undefined | null,
): number {
  if (!msg) return 0;
  const parts = msg.parts;
  if (!parts || parts.length === 0) return 0;

  let tokens = 0;
  for (const part of parts) {
    if (!part) continue;
    const extPart = part as PartWithToolState;
    if (extPart.type === "tool" && extPart.state) {
      tokens +=
        estimateTokenCount(extPart.state.input) +
        estimateTokenCount(extPart.state.output);
    } else if (extPart.text) {
      tokens += estimateStringTokens(extPart.text);
    }
  }
  return tokens;
}

/**
 * Compute the token contribution of a single part and its display
 * category.  Uses the CJK-aware estimator.
 *
 * @returns `{ tokens, category }` where category is one of
 *   "user" / "assistant" / "tool" / "none".
 */
function partTokensAndCategory(
  part: PartWithToolState,
  msgRole: string,
): { tokens: number; category: "user" | "assistant" | "tool" | "none" } {
  if (!part) return { tokens: 0, category: "none" };
  if (part.type === "tool" && part.state) {
    const tokens =
      estimateTokenCount(part.state.input) +
      estimateTokenCount(part.state.output);
    return { tokens, category: "tool" };
  }

  if (part.text) {
    const tokens = estimateStringTokens(part.text);
    if (msgRole === "user") return { tokens, category: "user" };
    if (msgRole === "assistant") return { tokens, category: "assistant" };
    return { tokens, category: "none" };
  }

  return { tokens: 0, category: "none" };
}

// ---------------------------------------------------------------------------
// Shared skeleton
// ---------------------------------------------------------------------------

/**
 * Result of finding the last completed assistant message.
 */
export interface LastAssistantResult {
  /** Index of the found message, or -1 if none. */
  index: number;
  /** Sum of all API-reported token fields. */
  exactTokens: number;
  /** Session ID from the found message. */
  sessionId: string;
  /** Raw token info (for cache rate calculation). */
  tokens: ContextTokenInfo | null;
}

/**
 * Internal helper: scan messages for a completed assistant.
 *
 * A completed assistant has `role === "assistant"` and
 * `tokens.output > 0`.  Scans in the given direction.
 *
 * @param messages - The messages array.
 * @param reverse - When true, scan from the end (last); when false,
 *   scan from the beginning (first).
 * @param startIdx - Start offset for forward scans (ignored when
 *   `reverse` is true).
 * @returns Result with the found index, or index -1 if none found.
 */
function _scanCompletedAssistant(
  messages: ContextMessageEntry[],
  reverse: boolean,
  startIdx = 0,
): LastAssistantResult {
  const start = reverse ? messages.length - 1 : startIdx;
  const end = reverse ? -1 : messages.length;
  const step = reverse ? -1 : 1;

  for (let i = start; reverse ? i > end : i < end; i += step) {
    const msg = messages[i];
    if (msg?.info?.role !== "assistant") continue;
    const tokens = msg.info?.tokens;
    if (!tokens || (tokens.output ?? 0) <= 0) continue;

    const exactTokens =
      (tokens.input ?? 0) +
      (tokens.output ?? 0) +
      (tokens.reasoning ?? 0) +
      (tokens.cache?.read ?? 0) +
      (tokens.cache?.write ?? 0);

    return {
      index: i,
      exactTokens,
      sessionId: msg.info.sessionID ?? "",
      tokens,
    };
  }

  return { index: -1, exactTokens: 0, sessionId: "", tokens: null };
}

/**
 * Find the last **completed** assistant message in a messages array.
 *
 * Delegates to `_scanCompletedAssistant` (reverse scan).
 *
 * @param messages - Non-empty messages array.
 * @returns Result object with index (-1 if not found) and token info.
 */
export function findLastCompletedAssistant(
  messages: ContextMessageEntry[],
): LastAssistantResult {
  return _scanCompletedAssistant(messages, true);
}

/**
 * Find the first **completed** assistant message in a messages array.
 *
 * Delegates to `_scanCompletedAssistant` (forward scan).
 * Used by `computeContextReport` for DCP-style system prompt estimation.
 *
 * @param messages - Non-empty messages array.
 * @returns Result object with index (-1 if not found) and token info.
 */
export function findFirstCompletedAssistant(
  messages: ContextMessageEntry[],
): LastAssistantResult {
  return _scanCompletedAssistant(messages, false);
}

/**
 * Find the last compaction boundary message in a messages array.
 *
 * A compaction boundary is an assistant message with `summary === true`,
 * inserted by the host after session compaction.  Messages before this
 * boundary are historical and should be excluded from the category breakdown
 * in `computeContextReport`.
 *
 * @param messages - The messages array.
 * @returns Index of the last summary message, or -1 if none found.
 */
export function findCompactionBoundary(
  messages: ContextMessageEntry[],
): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg?.info?.summary === true) {
      return i;
    }
  }
  return -1;
}

// ---------------------------------------------------------------------------
// measureContext — hook-friendly, logging
// ---------------------------------------------------------------------------

/**
 * Measure estimated context token count and message count from the messages
 * array.
 *
 * Uses the shared `findLastCompletedAssistant` skeleton and the tool-aware
 * `estimateMessageHeuristic` estimator.
 *
 * Results are logged at `"info"` level via the file-based logger.  When the
 * messages array is empty, a `"debug"` log is emitted instead.
 *
 * @param output - The hook output object whose `messages` array is examined.
 * @returns Context metrics including estimated total, message count, exact
 *   portion, and heuristic portion.
 */
export function measureContext(
  output: ContextMetricsOutput,
): ContextMetricsResult {
  const messages = output.messages;

  // ── Edge case: empty / undefined messages ──────────────────────────
  if (!messages || messages.length === 0) {
    log("context-metrics", "context_measured", "", undefined, "debug", {
      reason: "no_messages",
      estimated_tokens: 0,
      message_count: 0,
      exact_tokens: 0,
      estimated_new_tokens: 0,
      agent: "unknown",
    });
    return {
      estimated_tokens: 0,
      message_count: 0,
      exact_tokens: 0,
      estimated_new_tokens: 0,
      agent: "unknown",
    };
  }

  // ── Step 1: Find the last completed assistant message ──────────────
  const {
    index: lastAssistantIndex,
    exactTokens,
    sessionId,
  } = findLastCompletedAssistant(messages);

  // ── Step 2: Estimate heuristic tokens for messages after last
  // completed assistant, or all messages if none found ──────────────
  let estimatedNewTokens = 0;
  const startIdx = lastAssistantIndex >= 0 ? lastAssistantIndex + 1 : 0;

  for (let i = startIdx; i < messages.length; i++) {
    estimatedNewTokens += estimateMessageHeuristic(messages[i]);
  }

  const effectiveExact = lastAssistantIndex >= 0 ? exactTokens : 0;
  const total = effectiveExact + estimatedNewTokens;

  // ── Step 3: Extract agent name from the last user message ──────────
  let agentName: string | undefined;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg?.info?.role !== "user") continue;
    agentName = msg.info?.agent;
    break;
  }

  log("context-metrics", "context_measured", sessionId, undefined, "info", {
    estimated_tokens: total,
    message_count: messages.length,
    exact_tokens: effectiveExact,
    estimated_new_tokens: estimatedNewTokens,
    agent: agentName ?? "unknown",
  });

  return {
    estimated_tokens: total,
    message_count: messages.length,
    exact_tokens: effectiveExact,
    estimated_new_tokens: estimatedNewTokens,
    agent: agentName ?? "unknown",
  };
}

// ---------------------------------------------------------------------------
// computeContextReport — full dcp report (no logging side effects)
// ---------------------------------------------------------------------------

/**
 * Compute a context report from an array of session messages.
 *
 * Uses the shared `findLastCompletedAssistant` skeleton.
 * Category breakdown: user / tool use a CJK-aware part-level heuristic;
 * assistant uses API-reported `tokens.output` (with heuristic fallback);
 * system is estimated via the DCP formula: `(first completed assistant's
 * input + cache) − first user message heuristic`; misc absorbs the
 * residual (reasoning gap, non-text parts, etc.).  No reasoning split.
 *
 * @param messages - Session messages (raw, straight from API).
 * @returns A structured context report.
 */
export function computeContextReport(
  messages: ContextMessageEntry[],
): ContextReport {
  const messageCount = messages.length;

  // ── Step 0: Find compaction boundary ──────────────────────────────
  // After compaction, category statistics only reflect messages at/after
  // the boundary; total (based on last completed assistant) is unchanged.
  const boundaryIdx = findCompactionBoundary(messages);
  const catStartIdx = boundaryIdx >= 0 ? boundaryIdx : 0;

  // ── Step 1: Find the last completed assistant ──────────────────────
  const {
    index: lastAssistantIdx,
    exactTokens,
    tokens,
  } = findLastCompletedAssistant(messages);

  const exact = lastAssistantIdx >= 0 ? exactTokens : 0;
  let cacheHitRate: number | null = null;

  if (tokens) {
    const cacheRead = tokens.cache?.read ?? 0;
    const cacheWrite = tokens.cache?.write ?? 0;
    const inputTokens = tokens.input ?? 0;
    const cacheDenominator = inputTokens + cacheRead + cacheWrite;
    if (cacheDenominator > 0) {
      cacheHitRate = cacheRead / cacheDenominator;
    }
  }

  // ── Step 2: Heuristic for messages after last assistant (or all) ──
  let heuristic = 0;
  const startIdx = lastAssistantIdx >= 0 ? lastAssistantIdx + 1 : 0;
  for (let i = startIdx; i < messageCount; i++) {
    heuristic += estimateMessageHeuristic(messages[i]);
  }

  const total = exact + heuristic;

  // ── Step 3: Category breakdown (boundary-aware) ────────────────────
  // Only count messages at/after the compaction boundary (or all when
  // no boundary exists).  User / tool categories: part-level CJK-aware
  // heuristic.  Assistant category: API exact tokens.output when
  // available, otherwise falls back to `estimateMessageHeuristic`.
  let userTokens = 0;
  let assistantTokens = 0;
  let toolTokens = 0;

  for (let i = catStartIdx; i < messageCount; i++) {
    const msg = messages[i];
    if (!msg?.parts) continue;
    const role = msg.info?.role ?? "";
    for (const part of msg.parts) {
      if (!part) continue;
      const extPart = part as PartWithToolState;
      const { tokens, category } = partTokensAndCategory(extPart, role);
      if (category === "user") {
        userTokens += tokens;
      } else if (category === "tool") {
        toolTokens += tokens;
      }
      // "assistant" and "none" categories from parts are absorbed
      // by misc — assistant is handled via API exact below.
    }
  }

  // Assistant: prefer API-reported output, fall back to heuristic
  for (let i = catStartIdx; i < messageCount; i++) {
    const msg = messages[i];
    if (msg?.info?.role !== "assistant") continue;
    const apiOutput = msg.info?.tokens?.output ?? 0;
    if (apiOutput > 0) {
      assistantTokens += apiOutput;
    } else {
      // No API tokens — use part-level heuristic fallback.
      // Tool parts within this message are already counted above.
      if (msg?.parts) {
        for (const part of msg.parts) {
          if (!part) continue;
          const extPart = part as PartWithToolState;
          // Only count text parts; tool parts already in toolTokens.
          if (extPart.type !== "tool" && extPart.text) {
            assistantTokens += estimateStringTokens(extPart.text);
          }
        }
      }
    }
  }

  // ── Step 4: System prompt estimation (DCP-style, boundary-aware) ──
  // After compaction, use the first completed assistant and first user
  // message at or after the boundary for the DCP formula.
  let systemTokens = 0;
  const firstAsstAfter = _scanCompletedAssistant(messages, false, catStartIdx);
  if (firstAsstAfter.index >= 0 && firstAsstAfter.tokens) {
    const firstAsstInput =
      (firstAsstAfter.tokens.input ?? 0) +
      (firstAsstAfter.tokens.cache?.read ?? 0) +
      (firstAsstAfter.tokens.cache?.write ?? 0);
    // Find the first user message at or after the boundary.
    let firstUserMsg: ContextMessageEntry | undefined;
    for (let i = catStartIdx; i < messageCount; i++) {
      if (messages[i]?.info?.role === "user") {
        firstUserMsg = messages[i];
        break;
      }
    }
    if (firstUserMsg) {
      const userHeuristic = estimateMessageHeuristic(firstUserMsg);
      systemTokens = Math.max(0, firstAsstInput - userHeuristic);
    }
  }

  // ── Step 5: Consistency scaling ────────────────────────────────────
  // When the heuristic category sum exceeds total (possible due to
  // overlap between category heuristics and API-reported tokens), scale
  // each category proportionally so the sum equals total.  This ensures
  // that every category percentage is ≤ 100% in the TUI display.
  const catSum = userTokens + assistantTokens + toolTokens + systemTokens;
  if (catSum > total && total > 0) {
    const factor = total / catSum;
    userTokens = userTokens * factor;
    assistantTokens = assistantTokens * factor;
    toolTokens = toolTokens * factor;
    systemTokens = systemTokens * factor;
  }

  const misc = Math.max(
    0,
    total - userTokens - assistantTokens - toolTokens - systemTokens,
  );

  return {
    total,
    exact,
    heuristic,
    messageCount,
    cacheHitRate,
    categories: {
      user: userTokens,
      assistant: assistantTokens,
      tool: toolTokens,
      system: systemTokens,
      misc,
    },
  };
}

// ---------------------------------------------------------------------------
// Cache trend and cumulative
// ---------------------------------------------------------------------------

/**
 * Result of comparing the last two assistant messages' cache hit rates.
 */
export interface CacheTrendResult {
  /** Cache hit rate of the last completed assistant message (0–1), or null. */
  lastRate: number | null;
  /** Cache hit rate of the previous completed assistant message (0–1), or null. */
  previousRate: number | null;
  /**
   * Trend delta in percentage points (positive = up, negative = down),
   * or null when there is no previous assistant with valid data.
   */
  trend: number | null;
  /** Whether both last and previous rates are available for trend display. */
  hasTrendData: boolean;
  /**
   * Display label for the trend arrow.
   *
   * - `"↑X.X"` when trend > 0
   * - `"↓X.X"` when trend < 0
   * - `"-"` when trend is exactly 0
   * - `null` when there is no previous assistant (`hasTrendData === false`)
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
  /** Total denominator (sum of input + read + write) across all assistants. */
  totalDenominator: number;
}

/**
 * Compute the cache hit rate for a single message entry.
 *
 * This function does **not** validate the message's role; role filtering is
 * the caller's responsibility.  It returns a rate for any entry that has
 * token data.
 *
 * Uses the ZooKeeper convention:
 * `rate = cache.read / (input + cache.read + cache.write)`.
 *
 * Returns `null` when the denominator is zero or the message has no token
 * data.
 *
 * @param msg - A message entry (caller must filter by role as needed).
 * @returns Cache hit rate (0–1), or null if not computable.
 */
export function computeAssistantCacheRate(
  msg: ContextMessageEntry,
): number | null {
  if (!msg?.info?.tokens) return null;
  const tokens = msg.info.tokens;
  const cacheRead = tokens.cache?.read ?? 0;
  const cacheWrite = tokens.cache?.write ?? 0;
  const inputTokens = tokens.input ?? 0;
  const denominator = inputTokens + cacheRead + cacheWrite;
  if (denominator <= 0) return null;
  return cacheRead / denominator;
}

/**
 * Compare the last two assistant messages' cache hit rates.
 *
 * Scans the messages array from the end, identifying the last two assistant
 * messages with valid token data.  Trend is the difference in percentage
 * points: `(lastRate − previousRate) × 100`.
 *
 * The trend label is `"↑X.X"` / `"↓X.X"` / `"-"` (for zero) when two
 * assistants are available, or `null` when only one or fewer exist.
 *
 * @param messages - Session messages array.
 * @returns Trend result with last/previous rates and a display label.
 */
export function computeCacheTrend(
  messages: ContextMessageEntry[],
): CacheTrendResult {
  let lastRate: number | null = null;
  let previousRate: number | null = null;

  // Scan in reverse to find the last two assistants with valid rates.
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg?.info?.role !== "assistant") continue;
    const rate = computeAssistantCacheRate(msg);
    if (rate === null) continue;
    if (lastRate === null) {
      lastRate = rate;
    } else if (previousRate === null) {
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
  if (hasTrendData && trend !== null) {
    if (trend > 0) {
      trendLabel = `\u2191${trend.toFixed(1)}`;
    } else if (trend < 0) {
      trendLabel = `\u2193${Math.abs(trend).toFixed(1)}`;
    } else {
      trendLabel = "-";
    }
  }

  return { lastRate, previousRate, trend, hasTrendData, trendLabel };
}

/**
 * Compute cumulative cache hit rate by summing all assistant messages'
 * tokens.
 *
 * This is the **message-sum fallback** — prefer session-level aggregates
 * (see `Session.tokens`) when available, since they reflect the full session
 * without truncation.  The rate follows the ZooKeeper convention:
 * `totalRead / (totalInput + totalRead + totalWrite)`.
 *
 * @param messages - Session messages array.
 * @returns Cumulative cache result.
 */
export function computeCumulativeCacheRate(
  messages: ContextMessageEntry[],
): CumulativeCacheResult {
  let totalInput = 0;
  let totalRead = 0;
  let totalWrite = 0;

  for (const msg of messages) {
    if (msg?.info?.role !== "assistant") continue;
    const tokens = msg.info.tokens;
    if (!tokens) continue;
    totalInput += tokens.input ?? 0;
    totalRead += tokens.cache?.read ?? 0;
    totalWrite += tokens.cache?.write ?? 0;
  }

  const denominator = totalInput + totalRead + totalWrite;
  return {
    cumulativeRate: denominator > 0 ? totalRead / denominator : null,
    totalRead,
    totalDenominator: denominator,
  };
}
