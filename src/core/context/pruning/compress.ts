/**
 * Compression boundary and token-estimation helpers for context pruning.
 *
 * Provides the pure token-accumulation boundary (`tokenBoundary`), the
 * segment in/out token split (`segmentInOutTokens`), the segment heuristic
 * estimate (`estimateSegmentTokens`), and the shared block-header template
 * used by the range-mode compress pipeline and the fold view.  The former
 * mechanical planning pipeline (planner / mechanical summary / mechanical
 * title derivation) was retired with the `/dcp compress` command's move
 * to a model-driven path — see `docs/context-pruning-design.md` §4.7.
 *
 * @module
 */

import type { ContextMessageEntry } from "../metrics.js";
import {
  estimateMessageHeuristic,
  estimateTokenCount,
  isMessageIgnored,
} from "../metrics.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Configuration for the compression gates (protection + phantom threshold).
 */
export interface CompressionConfig {
  /** Number of most recent non-ignored messages to protect from compression. */
  protectedMessages: number;
  /** Token budget to protect from the end of the session (CJK heuristic). */
  protectedTokens: number;
  /** Minimum estimated tokens a segment must have to bypass the phantom gate. */
  thresholdTokens: number;
}

/**
 * A contiguous `[startIndex, endIndex)` span of the messages array.
 *
 * Shared by the range-mode compress pipeline (`resolveSpan` / `validateRange`)
 * and the segment token-estimation helpers.
 */
export interface CompressionSegment {
  /** Inclusive start index in the messages array. */
  startIndex: number;
  /** Exclusive end index in the messages array. */
  endIndex: number;
  /** Precomputed input token estimate (set for accepted segments). */
  inTokens?: number;
  /** Precomputed output token estimate (set for accepted segments). */
  outTokens?: number;
}

/** Header prefix containing the block-id placeholder (`b<N>`). */
export const BLOCK_HEADER_TEMPLATE = "[Compression Block b<N>]";

// ---------------------------------------------------------------------------
// Token-accumulation boundary
// ---------------------------------------------------------------------------

/**
 * Compute the inclusive start index of the token-protection window.
 *
 * Messages are accumulated from the end (backward) until the cumulative
 * heuristic estimate reaches `protectedTokens`.  Ignored messages do not
 * contribute to the cumulative total.
 *
 * @param messages - The session messages array.
 * @param protectedTokens - Token budget to protect from the end.
 * @returns Inclusive start index of the protection window.  0 = all messages
 *   protected; `messages.length` = empty window.
 */
export function tokenBoundary(
  messages: ContextMessageEntry[],
  protectedTokens: number,
): number {
  if (protectedTokens <= 0 || messages.length === 0) return messages.length;

  let accumulated = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (!isMessageIgnored(messages[i])) {
      accumulated += estimateMessageHeuristic(messages[i]);
      if (accumulated >= protectedTokens) return i;
    }
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Segment in/out token estimation
// ---------------------------------------------------------------------------

/** Minimal tool-part shape used by the segment token estimation. */
interface PartWithToolFields {
  type: string;
  tool?: string;
  callID?: string;
  state?: {
    input?: unknown;
    output?: unknown;
    status?: string;
  };
  text?: string;
}

/**
 * Sum estimated input and output tokens for a contiguous message segment.
 *
 * - Input tokens: user text + tool part inputs.
 * - Output tokens: assistant text + tool part outputs.
 *
 * Exported for use by the range-mode compress pipeline (token accounting).
 *
 * @returns `{ inTokens, outTokens }` — heuristic token estimates.
 */
export function segmentInOutTokens(
  messages: ContextMessageEntry[],
  segment: CompressionSegment,
): { inTokens: number; outTokens: number } {
  let inTokens = 0;
  let outTokens = 0;
  for (let mi = segment.startIndex; mi < segment.endIndex; mi++) {
    const msg = messages[mi];
    if (!msg.parts) continue;
    for (const part of msg.parts) {
      const p = part as PartWithToolFields;
      if (p.type === "tool" && p.state) {
        inTokens += estimateTokenCount(p.state.input);
        outTokens += estimateTokenCount(p.state.output);
      } else if (p.text) {
        if (msg.info?.role === "user") {
          inTokens += estimateTokenCount(p.text);
        } else if (msg.info?.role === "assistant") {
          outTokens += estimateTokenCount(p.text);
        } else {
          // System or other roles — count as input.
          inTokens += estimateTokenCount(p.text);
        }
      }
    }
  }
  return { inTokens, outTokens };
}

// ---------------------------------------------------------------------------
// Segment token estimation
// ---------------------------------------------------------------------------

/**
 * Estimate total heuristic tokens for a contiguous segment of messages.
 *
 * Used by the range-mode compress pipeline for the phantom gate and by
 * the nudge eligibility computation.
 *
 * @param messages - The full session messages array.
 * @param segment - The segment to estimate.
 * @returns Heuristic token count (sum of per-message estimates).
 */
export function estimateSegmentTokens(
  messages: ContextMessageEntry[],
  segment: CompressionSegment,
): number {
  let total = 0;
  for (let i = segment.startIndex; i < segment.endIndex; i++) {
    total += estimateMessageHeuristic(messages[i]);
  }
  return total;
}
