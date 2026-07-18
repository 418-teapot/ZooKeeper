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
 * @returns Result with the found index, or index -1 if none found.
 */
function _scanCompletedAssistant(
  messages: ContextMessageEntry[],
  reverse: boolean,
): LastAssistantResult {
  const start = reverse ? messages.length - 1 : 0;
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

  // ── Step 3: Category breakdown ─────────────────────────────────────
  // User / tool  categories: part-level CJK-aware heuristic.
  // Assistant category: API exact tokens.output when available,
  // otherwise falls back to `estimateMessageHeuristic`.
  let userTokens = 0;
  let assistantTokens = 0;
  let toolTokens = 0;

  for (const msg of messages) {
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
  for (const msg of messages) {
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

  // ── Step 4: System prompt estimation (DCP-style) ──────────────────
  // First LLM invocation input ≈ system prompt + first user message
  // (+ tool definitions).  system ≈ first completed assistant's
  // (input + cache.read + cache.write) − first user message heuristic.
  let systemTokens = 0;
  const firstAsst = findFirstCompletedAssistant(messages);
  if (firstAsst.index >= 0 && firstAsst.tokens) {
    const firstAsstInput =
      (firstAsst.tokens.input ?? 0) +
      (firstAsst.tokens.cache?.read ?? 0) +
      (firstAsst.tokens.cache?.write ?? 0);
    // Find the first user message (if any).
    let firstUserMsg: ContextMessageEntry | undefined;
    for (const msg of messages) {
      if (msg?.info?.role === "user") {
        firstUserMsg = msg;
        break;
      }
    }
    if (firstUserMsg) {
      const userHeuristic = estimateMessageHeuristic(firstUserMsg);
      systemTokens = Math.max(0, firstAsstInput - userHeuristic);
    }
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
