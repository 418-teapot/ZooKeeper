/**
 * Session state layer — compression blocks, prune marks, and the cleanup
 * rules that keep the two collections consistent.
 *
 * Blocks and marks live in the same session state but in separate maps
 * with disjoint keys: blocks are keyed by their persistent block id,
 * marks by `(anchorOrdinal, regionIndex?)`.  Identity is ordinal-only —
 * no host message identity anywhere.  Block ids come from a persistent
 * monotonic counter (`allocateBlockId`), so an id never addresses two
 * different histories over a session's life.  Blocks are never removed
 * from the map: a block that stops folding its interval keeps its
 * record — and with it its title and summary, the recall contract of the
 * decompress tool — and only changes lifecycle status.  The cleanup
 * rules in this module are the single place that reconciles the two
 * collections when a compression range lands
 * (`clearConsumedBlockRange`); a block whose content disappears — e.g. a
 * host revert removes a message it covers — is invalidated by the span
 * check at fold time, which moves it to stale via `markStale`.
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
 * The single source of truth for the truncation length used by the
 * decompress recall path (`truncateRecallSummary`) and by all three prune
 * producers' mark content snapshots (`producers/dedup.ts`,
 * `producers/sweep.ts`, `producers/purge-errors.ts`), which import this
 * constant.
 */
export const RECALL_MAX_CHARS = 16000;

/**
 * Lifecycle status of a compression block.
 *
 * A block starts `active` and moves to one of two terminal states; it
 * never returns to active and never leaves the block map.
 *
 * - `"active"` — the block folds its interval into a summary item, and
 *   a restore can expand it back.
 * - `"consumed"` — a wider compression swallowed the block, or a
 *   restore expanded it.  Its interval is ordinary content again; its
 *   summary stays recallable.
 * - `"stale"` — the block can no longer vouch for its interval: the
 *   span hash stopped matching (content changed or the transcript was
 *   cut) or a revert removed a message it covers.  The record degrades
 *   to "readable but no longer verifiable": its title and summary stay
 *   recallable, but restoring would republish an interval that no
 *   longer points at the original content, so restore is refused.
 */
export type BlockStatus = "active" | "consumed" | "stale";

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
  /** Lifecycle status; only `"active"` blocks fold their interval. */
  status: BlockStatus;
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
 * Nudge watermark state.
 *
 * All three numbers are token counts; each is optional and defaults to
 * "unset" (no watermark, no booked reclaim), so a state written before a
 * field existed loads unchanged.
 */
export interface Nudges {
  /** Single-anchor watermark token count (0 is a valid watermark). */
  lastNudgeTokens?: number;
  /**
   * Reclaimed tokens not yet visible in the measured prompt-side total.
   *
   * A compression books what it took out of the view here, so the water
   * level drops the moment the tokens are gone instead of waiting for the
   * next API measurement of the smaller view.  The bookkeeping is
   * one-shot: it is cleared as soon as a measurement arrives that
   * already reflects the reclaim.
   */
  pendingReclaimTokens?: number;
  /**
   * The measured prompt-side total that `pendingReclaimTokens` discounts.
   *
   * Any other measurement is taken from a view the compression already
   * shrank, so the booked reclaim is consumed once the measured total
   * moves off this value — never subtracted twice.
   */
  reclaimMeasurement?: number;
}

/**
 * Per-session state — the union of the block and mark collections plus
 * the nudge watermark and the block-id sequence.
 *
 * `blocks` is keyed by a persistent block id (see `allocateBlockId`);
 * `marks` is keyed by `markKey(anchorOrdinal, regionIndex?)`.  The two
 * collections never share keys, so their cleanup rules cannot collide.
 */
export interface SessionState {
  /** Blocks keyed by block id. */
  blocks: Map<number, Block>;
  /** Marks keyed by `(anchorOrdinal, regionIndex?)`. */
  marks: Map<string, Mark>;
  /** Nudge watermark state; undefined when no watermark has been set. */
  nudges?: Nudges;
  /**
   * Id to hand out to the next created block.
   *
   * It only ever moves forward and is never derived from the live block
   * collection, so an id is never re-issued.  Optional for states
   * without a counter (an older on-disk record, or a freshly built
   * in-memory state); `allocateBlockId` falls back to
   * `deriveNextBlockId` in that case.
   */
  nextBlockId?: number;
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
 * Derive the id a block collection would hand out next.
 *
 * Returns `max(existing id) + 1`, or `1` for an empty map.  This is the
 * fallback used when no persistent counter is set; `allocateBlockId`
 * combines it with the counter so an id is never re-issued even when the
 * counter is stale.
 *
 * @param blocks - The current block map.
 * @returns The id following the highest one present.
 */
export function deriveNextBlockId(blocks: ReadonlyMap<number, Block>): number {
  let max = 0;
  for (const id of blocks.keys()) {
    if (id > max) max = id;
  }
  return max + 1;
}

/**
 * Allocate the id for a newly created block.
 *
 * The session's persistent `nextBlockId` is the single source of block
 * identity: it advances on every allocation and never moves back, so ids
 * stay distinct across a session no matter what later happens to the
 * blocks that held them.  A state without the field (loaded from an
 * older on-disk record, or built fresh in memory) falls back to
 * `max(existing id) + 1` on first allocation rather than erroring.
 *
 * @param state - The session state (`nextBlockId` advanced).
 * @returns The allocated block id.
 */
export function allocateBlockId(state: SessionState): number {
  const migrated = deriveNextBlockId(state.blocks);
  const id = Math.max(state.nextBlockId ?? 0, migrated);
  state.nextBlockId = id + 1;
  return id;
}

/**
 * Check whether any active block overlaps the interval `[start, end)`.
 *
 * **Caller invariant:** before landing a new compression block, the
 * caller must verify the interval has no overlap with any active block
 * — a new block must never fold an interval an active block already
 * folds.  This helper is that verification; the fold-time span check
 * keeps the invariant satisfiable over time by moving blocks whose
 * interval no longer validates to the stale status (`markStale`), after
 * which they stop counting as overlaps.
 *
 * Intervals are half-open, so touching edges (`end === block.start` or
 * `start === block.end`) do not overlap.  Terminal-status blocks never
 * count.
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
    if (block.status !== "active") continue;
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
 * Move active blocks to the `"stale"` status.
 *
 * The transition is the whole record of an invalidation: the block
 * keeps its interval, title, summary and stored hash so the loss stays
 * diagnosable and the summary stays recallable, and it stops folding.
 * Blocks that are not active are skipped — stale and consumed are
 * terminal, so an already-transitioned block is never re-aged.
 *
 * @param state - The session state (block records mutated).
 * @param blockIds - The ids to transition; unknown ids are ignored.
 * @returns The number of blocks that changed status in this call.
 */
export function markStale(
  state: SessionState,
  blockIds: Iterable<number>,
): number {
  let changed = 0;
  for (const id of blockIds) {
    const block = state.blocks.get(id);
    if (block === undefined || block.status !== "active") continue;
    block.status = "stale";
    changed += 1;
  }
  return changed;
}
