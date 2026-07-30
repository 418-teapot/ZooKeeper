/**
 * Shared utilities for pruning producers.
 *
 * Provides turn‑protection logic and token‑reclaim estimation that are
 * common across multiple producers (dedup, purge-errors, …).
 *
 * @module
 */

import type { ContextMessageEntry } from "../../metrics.js";
import { estimateTokenCount, isMessageIgnored } from "../../metrics.js";
import type { SweepToolPart } from "../types.js";
import { getCallId } from "../types.js";

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
