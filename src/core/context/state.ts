/**
 * Session state layer — compression blocks, prune marks, and the cleanup
 * rules that keep the two collections consistent.
 *
 * Blocks and marks live in the same session state but in separate maps
 * with disjoint keys: blocks are keyed by their monotonic block id,
 * marks by `(anchorOrdinal, regionIndex?)`.  Identity is ordinal-only —
 * no host message identity anywhere.  The cleanup rules in this module
 * are the single place that reconciles the two collections when a
 * compression range lands (`clearConsumedBlockRange`), when a revert
 * removes covered ordinals (`deactivateCovering`), and when deactivated
 * blocks are reclaimed (`clearInactiveBlocks`).
 *
 * This module is pure state semantics — persistence lives in
 * `store.ts`; view construction belongs to the fold/render phases.
 *
 * @module
 */

import type { BlockSpan } from "./lens.js";
import type { HashedSpan } from "./spanhash.js";

/**
 * Canonical character cap for persisted text snapshots (~4K tokens).
 *
 * The legacy core's single truncation length, shared by the decompress
 * recall path (`decompress.truncateRecallSummary`) and the prune
 * producers' mark content snapshots: `producers/dedup.ts` imports this
 * constant; `producers/sweep.ts` and `producers/purge-errors.ts` keep a
 * local copy of the same value.
 */
export const RECALL_MAX_CHARS = 16000;

/**
 * A compression block — a pure-data declaration over a transcript
 * interval.
 *
 * The interface extends both contracts it must satisfy: `BlockSpan`
 * (the fields the fold view reads — start/end/title/summary) and
 * `HashedSpan` (start/end/spanHash — the fields content
 * self-verification compares).  The span hash is computed by the
 * compression phase at creation; this layer only stores and reads the
 * field.
 */
export interface Block extends BlockSpan, HashedSpan {
  /** Whether the block currently folds its interval. */
  active: boolean;
  /** Estimated tokens of the covered messages at creation. */
  compressedTokens: number;
  /** Estimated tokens of the summary text. */
  summaryTokens: number;
  /** Unix timestamp (ms) of creation. */
  createdAt: number;
}

/**
 * A prune mark — a pending or released claim over one tool-output
 * region.
 *
 * A mark anchors to the message ordinal and, when the message carries
 * more than one tool-output region, to the region index within the
 * message.  `effective === false` means the mark is pending; the
 * two-turn lifecycle flips pending marks to effective on release.  Marks
 * never carry host message identity — identity is purely ordinal.
 */
export interface Mark {
  /** Ordinal of the message the mark anchors to. */
  anchorOrdinal: number;
  /** Index of the covered tool-output region within the message. */
  regionIndex?: number;
  /** Snapshot of the region content at mark time. */
  content: string;
  /** Estimated token count of the content. */
  contentTokens?: number;
  /** False while the mark is pending; true once released. */
  effective: boolean;
  /** Unix timestamp (ms) of when the mark was created. */
  markedAt: number;
  /**
   * Unix timestamp (ms) of when the mark became effective; set on the
   * release flip (and at creation for immediately-effective marks).
   */
  effectiveAt?: number;
  /**
   * Unix timestamp (ms) of when the mark was released from the pending
   * collection; set together with `effectiveAt` in the current
   * lifecycle, kept separate for future divergence.
   */
  releasedAt?: number;
}

/**
 * Nudge watermark state, mirroring the legacy watermark shape.
 */
export interface Nudges {
  /** Single-anchor watermark token count (0 is a valid watermark). */
  lastNudgeTokens?: number;
}

/**
 * Per-session state — the union of the block and mark collections plus
 * the nudge watermark.
 *
 * `blocks` is keyed by a monotonically increasing block id (see
 * `nextBlockId`); `marks` is keyed by `markKey(anchorOrdinal,
 * regionIndex?)`.  The two collections never share keys, so their
 * cleanup rules cannot collide.
 */
export interface SessionState {
  /** Blocks keyed by block id. */
  blocks: Map<number, Block>;
  /** Marks keyed by `(anchorOrdinal, regionIndex?)`. */
  marks: Map<string, Mark>;
  /** Nudge watermark state; undefined when no watermark has been set. */
  nudges?: Nudges;
}

/**
 * Compose the map key for a mark.
 *
 * The key is `(anchorOrdinal, regionIndex?)`: plain `"5"` for a mark
 * without a region index, `"5:0"` for one with.  The two shapes never
 * collide because the ordinal-only form never carries a colon.
 *
 * @param anchorOrdinal - The message ordinal the mark anchors to.
 * @param regionIndex - Optional region index within the message.
 * @returns The mark map key.
 */
export function markKey(anchorOrdinal: number, regionIndex?: number): string {
  return regionIndex === undefined
    ? `${anchorOrdinal}`
    : `${anchorOrdinal}:${regionIndex}`;
}

/**
 * Derive the next block id from the current block map.
 *
 * Returns `max(existing id) + 1`, or `1` when the map is empty.  The
 * map is the single source of block identity, so ids continue correctly
 * across persistence round-trips.  Ids of reclaimed blocks may be
 * reused after `clearInactiveBlocks` removes them.
 *
 * @param blocks - The current block map.
 * @returns The next block id.
 */
export function nextBlockId(blocks: ReadonlyMap<number, Block>): number {
  let max = 0;
  for (const id of blocks.keys()) {
    if (id > max) max = id;
  }
  return max + 1;
}

/**
 * Check whether any active block overlaps the interval `[start, end)`.
 *
 * **Caller invariant:** before landing a new compression block, the
 * caller must verify the interval has no overlap with any active block
 * — a new block must never fold an interval an active block already
 * folds.  This helper is that verification; `deactivateCovering` and
 * `clearInactiveBlocks` are the transitions that keep the invariant
 * satisfiable over time.
 *
 * Intervals are half-open, so touching edges (`end === block.start` or
 * `start === block.end`) do not overlap.  Inactive blocks never count.
 *
 * @param state - The session state.
 * @param start - First ordinal (inclusive).
 * @param end - Last ordinal (exclusive).
 * @returns True when an active block's interval intersects `[start, end)`.
 */
export function hasActiveOverlap(
  state: SessionState,
  start: number,
  end: number,
): boolean {
  for (const block of state.blocks.values()) {
    if (!block.active) continue;
    // Non-empty intersection of two half-open intervals; correct even
    // for an empty query interval, which overlaps nothing.
    if (Math.max(block.start, start) < Math.min(block.end, end)) {
      return true;
    }
  }
  return false;
}

/**
 * Consume pending marks covered by a newly landed compression block.
 *
 * Called when a compression range lands (block creation): every pending
 * mark whose anchor ordinal falls inside `[start, end)` is swallowed —
 * removed from the collection — and its content tokens are accumulated
 * into the return value, which the caller attributes to the new block's
 * `compressedTokens` so no token is counted twice.  Effective marks are
 * left untouched: their pruning is a visible, already-written fact and
 * their tokens are already counted in prior reclamation totals.
 *
 * @param state - The session state.
 * @param start - First covered ordinal (inclusive).
 * @param end - Last covered ordinal (exclusive).
 * @returns The sum of `contentTokens` of the swallowed pending marks.
 */
export function clearConsumedBlockRange(
  state: SessionState,
  start: number,
  end: number,
): number {
  let swallowedTokens = 0;
  for (const [key, mark] of [...state.marks]) {
    if (mark.effective) continue;
    if (mark.anchorOrdinal >= start && mark.anchorOrdinal < end) {
      swallowedTokens += mark.contentTokens ?? 0;
      state.marks.delete(key);
    }
  }
  return swallowedTokens;
}

/**
 * Deactivate every active block that anchors at or covers the ordinal.
 *
 * A block deactivates when the message at the given ordinal is removed
 * by a host revert: blocks that start exactly at the ordinal (anchored
 * to the removed message) and blocks whose interval contains the ordinal
 * both lose content they vouched for.  Deactivated blocks can no longer
 * be decompressed and are never consumed by later compression; blocks
 * entirely below or above the ordinal stay active (content loss beyond
 * the boundary is caught by span validation during folding).
 *
 * @param state - The session state.
 * @param ordinal - The removed message ordinal.
 */
export function deactivateCovering(state: SessionState, ordinal: number): void {
  for (const block of state.blocks.values()) {
    if (!block.active) continue;
    if (block.start <= ordinal && ordinal < block.end) {
      block.active = false;
    }
  }
}

/**
 * Reclaim memory held by deactivated blocks.
 *
 * Removes every inactive block from the map, keeping only active ones.
 * Reclamation is a deliberate trade: after this runs, `nextBlockId` no
 * longer sees the removed ids, so a later block may reuse one — callers
 * must only reclaim when no live reference to the removed blocks can
 * occur.
 *
 * @param state - The session state.
 */
export function clearInactiveBlocks(state: SessionState): void {
  for (const [id, block] of [...state.blocks]) {
    if (!block.active) state.blocks.delete(id);
  }
}
