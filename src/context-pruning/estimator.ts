/**
 * Token counting helpers for the context pruning subsystem.
 *
 * Uses a hybrid approach:
 * 1. API-reported tokens from completed assistant messages (precise)
 * 2. `text.length / 4` heuristic for messages added after the last
 *    completed assistant (approximate, < 5 % of total)
 *
 * The `estimateTotalTokens()` and `estimateTokens()` functions are
 * framework-agnostic heuristics that work with `MessageRef[]` and plain
 * text respectively.  `getContextTokens()` is the full hybrid approach
 * that uses the OpenCode message format (used by the framework adapter).
 *
 * @module
 */

import type { MessageRef } from "./types";

/**
 * Estimate token count for a plain text string using `text.length / 4`.
 *
 * @param text - The text to estimate.
 * @returns Estimated token count, rounded up.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Estimate total tokens for an array of MessageRef objects.
 *
 * Sums `content.length / 4` for every message in the array.
 *
 * @param messages - The messages to estimate.
 * @returns Estimated total token count.
 */
export function estimateTotalTokens(messages: MessageRef[]): number {
  let total = 0;
  for (const msg of messages) {
    // Skip placeholder/compressed messages (they double-count)
    if (msg.content.startsWith("[Compressed:") || msg.content.startsWith("[pruned:")) continue;
    if (msg.id.startsWith("dcp_c")) continue;
    total += estimateTokens(msg.content);
    if (msg.toolCalls) {
      for (const tc of msg.toolCalls) {
        total += estimateTokens(tc.toolName);
        total += estimateTokens(JSON.stringify(tc.parameters));
      }
    }
    if (msg.toolResults) {
      for (const tr of msg.toolResults) {
        total += estimateTokens(tr.output);
        if (tr.error) total += estimateTokens(tr.error);
      }
    }
  }
  return total;
}

/**
 * Get total context token usage using the hybrid approach.
 *
 * 1. Find the last completed assistant message (where `tokens.output > 0`)
 *    and sum its API-reported tokens.
 * 2. For any messages added after that point, estimate tokens using
 *    the `text.length / 4` heuristic.
 * 3. Total = API-reported + heuristic estimate.
 *
 * This function operates on the OpenCode message format and is intended
 * for use by framework adapters (future: OpenCode, pi, oh-my-pi).
 *
 * @param messages - Array of message objects matching the OpenCode shape.
 * @returns Estimated total token count.
 */
export function getContextTokens(
  messages: Array<{
    info: {
      role: string;
      tokens?: {
        input: number;
        output: number;
        reasoning: number;
        cache?: { read: number; write: number };
      };
    };
    parts: Array<{ type: string; text?: string }>;
  }>,
): number {
  // Step 1: Find last completed assistant message (tokens.output > 0 means completed)
  let lastAssistantIndex = -1;
  let reportedTokens = 0;

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.info.role !== "assistant") continue;
    const tokens = msg.info.tokens;
    if (!tokens || (tokens.output ?? 0) <= 0) continue; // skip streaming/incomplete
    lastAssistantIndex = i;
    reportedTokens =
      (tokens.input ?? 0) +
      (tokens.output ?? 0) +
      (tokens.reasoning ?? 0) +
      (tokens.cache?.read ?? 0) +
      (tokens.cache?.write ?? 0);
    break;
  }

  // Step 2: Estimate tokens for messages from the last assistant onward
  // (includes the assistant's own tool calls and outputs)
  let estimatedNewTokens = 0;
  for (let i = Math.max(0, lastAssistantIndex); i < messages.length; i++) {
    estimatedNewTokens += estimateMessageHeuristic(messages[i]);
  }

  return reportedTokens + estimatedNewTokens;
}

/**
 * Fallback heuristic: `text.length / 4`.
 *
 * Only used for in-progress messages that have not been through an
 * LLM call yet.
 *
 * @param msg - A message entry with a `parts` array.
 * @returns Estimated token count for the message.
 */
function estimateMessageHeuristic(msg: {
  parts: Array<{ type: string; text?: string }>;
}): number {
  let chars = 0;
  for (const part of msg.parts) {
    if (part.text) chars += part.text.length;
  }
  return Math.ceil(chars / 4);
}
