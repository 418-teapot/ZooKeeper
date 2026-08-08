/**
 * Shared utilities for the context-pruning module.
 *
 * Provides turn-protection logic, user-message boundary scans, and
 * token-reclaim estimation common to the compression planner, the
 * nudge subsystem, and the pruning producers (dedup, purge-errors,
 * sweep).
 *
 * @module
 */

import { getCallId } from "../message-parts.js";
import type { ContextMessageEntry } from "../metrics.js";
import { estimateTokenCount, isMessageIgnored } from "../metrics.js";
import type { SweepToolPart } from "./types.js";

// ---------------------------------------------------------------------------
// Shared producer options
// ---------------------------------------------------------------------------

/**
 * Options common to the pruning producers (dedup, purge-errors).
 *
 * Both producers read `turnProtection` and `protectedTools`; hook-level
 * gating (thresholdContext) and batch-release settings are managed by
 * the handler config.
 */
export interface ProducerOptions {
  /** Number of most recent assistant steps to protect from the strategy. */
  turnProtection?: number;
  /** Tool names that are excluded from the strategy.  Undefined → empty list (neutral). */
  protectedTools?: string[];
}

// ---------------------------------------------------------------------------
// Message-count protection boundary
// ---------------------------------------------------------------------------

/**
 * Compute the start index of the protection window by counting back N
 * non-ignored messages from the end of the array.
 *
 * Messages whose `isMessageIgnored` returns true are skipped — they do
 * not count toward the window.  This ensures that system-injected (ignored)
 * messages never consume protection slots.
 *
 * The returned index is inclusive: messages at `[boundary, messages.length)`
 * are inside the protected window.
 *
 * @param messages - The session messages array.
 * @param n - Number of messages to protect.  When <= 0 the boundary is at
 *   `messages.length` (empty window).  When N exceeds the available
 *   non-ignored messages the boundary is 0 (protect everything).
 * @returns Start index of the protected window (inclusive).
 */
export function protectedBoundary(
  messages: ContextMessageEntry[],
  n: number,
): number {
  if (n <= 0) return messages.length;

  let count = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (!isMessageIgnored(messages[i])) {
      count++;
      if (count >= n) return i;
    }
  }
  return 0;
}

// ---------------------------------------------------------------------------
// User-message boundary helpers
// ---------------------------------------------------------------------------

/**
 * Find the index of the last non-ignored user message.
 *
 * @param messages - The session messages array.
 * @returns Index, or `messages.length` if no non-ignored user message found.
 */
export function lastUserMessageIndex(messages: ContextMessageEntry[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.info?.role === "user" && !isMessageIgnored(messages[i])) {
      return i;
    }
  }
  return messages.length;
}

/**
 * Find the index of the first non-ignored user message in the session.
 *
 * Ignored messages are skipped to avoid treating injected /dcp reports
 * or other synthetic user-role messages as the "real" first user message.
 *
 * @param messages - The session messages array.
 * @returns Index, or -1 if no non-ignored user message found.
 */
export function firstUserMessageIndex(messages: ContextMessageEntry[]): number {
  for (let i = 0; i < messages.length; i++) {
    if (messages[i]?.info?.role === "user" && !isMessageIgnored(messages[i])) {
      return i;
    }
  }
  return -1;
}

// ---------------------------------------------------------------------------
// Protected callIDs (shared across producers)
// ---------------------------------------------------------------------------

/**
 * Collect tool callIDs that fall within the protected window.
 *
 * The window is computed by counting back `turnProtection` non-ignored
 * messages from the end of the array (via `protectedBoundary`).  Every
 * tool callID found at or after the boundary is added to the returned set.
 *
 * @param messages - The session messages array.
 * @param turnProtection - Number of messages to protect.
 * @returns Set of protected callIDs.
 */
export function collectProtectedCallIDs(
  messages: ContextMessageEntry[],
  turnProtection: number,
): Set<string> {
  const protectedIDs = new Set<string>();
  if (turnProtection <= 0) return protectedIDs;

  const boundaryIdx = protectedBoundary(messages, turnProtection);

  for (let i = boundaryIdx; i < messages.length; i++) {
    const msg = messages[i];
    if (!msg.parts) continue;
    for (const part of msg.parts) {
      const toolPart = part as SweepToolPart;
      if (toolPart.type !== "tool") continue;
      const callID = getCallId(toolPart);
      if (callID) protectedIDs.add(callID);
    }
  }

  return protectedIDs;
}

// ---------------------------------------------------------------------------
// Token reclaim estimation
// ---------------------------------------------------------------------------

/**
 * Compute net token reclaim when replacing content with a placeholder.
 *
 * Returns `estimateTokenCount(content) - estimateTokenCount(placeholder)`,
 * clamped to 0 (never negative — a negative reclaim means no benefit).
 *
 * @param content - The original tool output content (may be nullish).
 * @param placeholder - The placeholder text to replace with.
 * @returns The estimated tokens saved, >= 0.
 */
export function netReclaimTokens(
  content: unknown,
  placeholder: string,
): number {
  const rawDiff = estimateTokenCount(content) - estimateTokenCount(placeholder);
  return rawDiff > 0 ? rawDiff : 0;
}
