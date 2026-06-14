/**
 * Context Metrics hook for ZooKeeper OpenCode plugin.
 *
 * Phase 0 of Dynamic Context Pruning — adds observability before any pruning
 * logic.  On every LLM turn, estimates the total context token usage using a
 * hybrid approach:
 *
 *   1. Find the last completed assistant message (where `tokens.output > 0`)
 *      and sum its API-reported tokens.
 *   2. For any messages after that point, estimate tokens using
 *      `text.length / 4` heuristic.
 *   3. Total = API-reported + heuristic estimate.
 *
 * Results are logged via the file-based logger so we can calibrate pruning
 * thresholds later.
 *
 * @module
 */

import { log } from "../../utils/logger.js";

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
  messages?: ContextMessageEntry[];
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
// Handler
// ---------------------------------------------------------------------------

/**
 * Measure estimated context token count and message count from the messages
 * array.
 *
 * Uses a hybrid strategy:
 * - Finds the last **completed** assistant message (role === "assistant" AND
 *   `tokens.output > 0`) and sums its API-reported token fields.
 * - Any messages added after that point are estimated via `text.length / 4`.
 * - If no completed assistant message is found, all messages are estimated
 *   heuristically.
 *
 * Results are logged at `"info"` level via the file-based logger.  When the
 * messages array is empty, a `"debug"` log is emitted instead.
 *
 * This is a pure synchronous function — no async needed.
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
  let lastAssistantIndex = -1;
  let exactTokens = 0;
  let sessionId = "";

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.info.role !== "assistant") continue;
    const tokens = msg.info.tokens;
    if (!tokens || (tokens.output ?? 0) <= 0) continue;

    lastAssistantIndex = i;
    exactTokens =
      (tokens.input ?? 0) +
      (tokens.output ?? 0) +
      (tokens.reasoning ?? 0) +
      (tokens.cache?.read ?? 0) +
      (tokens.cache?.write ?? 0);
    sessionId = msg.info.sessionID ?? "";
    break;
  }

  // ── Step 2: Estimate heuristic tokens for messages after last
  // completed assistant, or all messages if none found ──────────────
  let estimatedNewTokens = 0;
  const startIdx = lastAssistantIndex >= 0 ? lastAssistantIndex + 1 : 0;

  for (let i = startIdx; i < messages.length; i++) {
    estimatedNewTokens += estimateMessageHeuristic(messages[i]);
  }

  // If no completed assistant was found we use pure heuristic for all
  // messages (the estimate above already covered everything).
  if (lastAssistantIndex < 0) {
    exactTokens = 0;
  }

  const total = exactTokens + estimatedNewTokens;

  // ── Step 3: Extract agent name from the last user message ──────────
  let agentName: string | undefined;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.info.role === "user") {
      agentName = msg.info.agent;
      break;
    }
  }

  log("context-metrics", "context_measured", sessionId, undefined, "info", {
    estimated_tokens: total,
    message_count: messages.length,
    exact_tokens: exactTokens,
    estimated_new_tokens: estimatedNewTokens,
    agent: agentName ?? "unknown",
  });

  return {
    estimated_tokens: total,
    message_count: messages.length,
    exact_tokens: exactTokens,
    estimated_new_tokens: estimatedNewTokens,
    agent: agentName ?? "unknown",
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Estimate token count for a single message using `text.length / 4`.
 *
 * Iterates over the message's `parts` array and sums `part.text?.length`
 * for each part, then divides by 4 and rounds up.
 *
 * Messages with no parts or empty parts yield `0`.
 *
 * @param msg - The message entry to estimate.
 * @returns Estimated token count (rounded up), or 0 if no text found.
 */
export function estimateMessageHeuristic(msg: ContextMessageEntry): number {
  const parts = msg.parts;
  if (!parts || parts.length === 0) return 0;

  let chars = 0;
  for (const part of parts) {
    if (part.text) {
      chars += part.text.length;
    }
  }
  return Math.ceil(chars / 4);
}
