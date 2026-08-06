/**
 * Compression block state layer — model, lifecycle, and persistence mirror.
 *
 * **Semantic contract:** blocks never delete — they only deactivate (active
 * set to `false`).  Deactivated blocks are not re-processed by syncBlocks.
 *
 * Two-phase discipline:
 * - Commands (createBlock, syncBlocks) write state + set dirty.
 * - Transforms (fold.ts) only read state.
 *
 * This module mirrors the marks layer at the "segment" dimension:
 * same persistence file, same strict validation, same atomic write,
 * same "never delete" policy.
 *
 * @module
 */

import type { SessionState } from "./types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A single compression block.
 *
 * - `blockId` — auto-incremented integer, derived as max(existing) + 1.
 * - `active` — `true` while the anchor message still exists in the
 *   current message view; `false` once the anchor is lost.
 * - `anchorMessageId` — the message ID of the synthetic summary message
 *   that replaces the compressed segment.
 * - `messageIds` — ordered list of message IDs that this block covers.
 * - `summary` — deterministic text summary of the compressed segment.
 * - `title` — one-line topic label shown in the block header and used as
 *   the index entry when a wider recompression consumes this block.
 *   Required at creation (the `CompressionPlan` always carries one) but
 *   optional on read: dev-era persisted files predate the field, so a
 *   loaded block may have an undefined title.
 * - `compressedTokens` — estimated token count of the original messages.
 * - `summaryTokens` — estimated token count of the summary text.
 * - `deactivatedBy` — reserved for future use; zero logic.
 * - `deactivatedAt` — Unix timestamp (ms) of deactivation.  Set when the
 *   block is consumed by a range-mode recompression.
 * - `createdAt` — Unix timestamp (ms) of creation.
 */
export interface CompressionBlock {
  blockId: number;
  active: boolean;
  anchorMessageId: string;
  messageIds: string[];
  summary: string;
  /** Required at creation (CompressionPlan); optional on read (dev-era files). */
  title?: string;
  compressedTokens: number;
  summaryTokens: number;
  deactivatedBy?: string;
  deactivatedAt?: number;
  createdAt: number;
}

/**
 * Compression plan produced by the compression producer (compress.ts)
 * and consumed by `createBlock`.
 *
 * The plan describes a single contiguous segment to compress.
 */
export interface CompressionPlan {
  /** Message ID that will become the anchor for the synthetic summary. */
  anchorMessageId: string;
  /** Ordered list of message IDs to be compressed. */
  messageIds: string[];
  /** Deterministic summary text. */
  summary: string;
  /** One-line topic label for the block header / consumption index entry. */
  title: string;
  /** Estimated token count of the original messages. */
  compressedTokens: number;
  /** Estimated token count of the summary. */
  summaryTokens: number;
}

// ---------------------------------------------------------------------------
// Core operations
// ---------------------------------------------------------------------------

/**
 * Derive the next block ID from the current block map.
 *
 * Returns `max(existing blockId) + 1`, or `1` when the map is empty.
 * Naturally continues correctly after state is restored from persistence.
 *
 * @param blocks - The current blocks map.
 * @returns The next block ID.
 */
function nextBlockId(blocks: Map<string, CompressionBlock>): number {
  let max = 0;
  for (const [, block] of blocks) {
    if (block.blockId > max) max = block.blockId;
  }
  return max + 1;
}

/**
 * Create a new compression block in the session state.
 *
 * Assigns a monotonically increasing `blockId` derived from the current
 * map contents.  The new block is immediately `active`.
 *
 * Idempotent: if a block already exists with the same `anchorMessageId`
 * (same segment), does nothing and returns `null` — unless that block's
 * id is listed in `excludeBlockIds`.  Callers that create a replacement
 * for a block they are about to consume (create-before-consume order)
 * pass the consumed block ids so the re-creation at the same anchor is
 * not mistaken for a duplicate.
 *
 * @param state - The session state (must have a `blocks` map).
 * @param plan - The compression plan describing the segment.
 * @param excludeBlockIds - Block ids to skip in the anchor-idempotency
 *   check (blocks scheduled for consumption by the caller).
 * @returns The created block, or `null` if a block for the same anchor
 *   already exists.
 */
export function createBlock(
  state: SessionState,
  plan: CompressionPlan,
  excludeBlockIds?: ReadonlySet<number> | readonly number[],
): CompressionBlock | null {
  // Idempotency: check if a block already exists for this anchor,
  // skipping blocks the caller is about to consume.
  const excluded = new Set(excludeBlockIds ?? []);
  for (const [, block] of state.blocks) {
    if (excluded.has(block.blockId)) continue;
    if (block.anchorMessageId === plan.anchorMessageId) {
      return null;
    }
  }

  const blockId = nextBlockId(state.blocks);
  const key = String(blockId);
  const now = Date.now();

  const block: CompressionBlock = {
    blockId,
    active: true,
    anchorMessageId: plan.anchorMessageId,
    messageIds: [...plan.messageIds],
    summary: plan.summary,
    title: plan.title,
    compressedTokens: plan.compressedTokens,
    summaryTokens: plan.summaryTokens,
    createdAt: now,
  };

  state.blocks.set(key, block);
  state.dirty = true;
  return block;
}

/**
 * Filter active compression blocks whose anchor message still exists.
 *
 * Pure function -- returns a new array of blocks whose `anchorMessageId`
 * is present in the `messages` id set.  Does NOT mutate the input arrays.
 *
 * This is the single source of truth for "block liveness": a block is
 * considered "live" when it is active and its anchor message id exists
 * in the current message view.  The same id-set logic is used by
 * `syncBlocks` for deactivation decisions.
 *
 * @param blocks - Array of compression blocks (not mutated).
 * @param messages - The current message array (not mutated).
 * @returns A new array containing only live blocks.
 */
export function liveBlocks(
  blocks: CompressionBlock[],
  messages: ReadonlyArray<{ info: { id: string } }>,
): CompressionBlock[] {
  const anchorIds = new Set<string>();
  for (const msg of messages) {
    anchorIds.add(msg.info.id);
  }

  return blocks.filter(
    (block) => block.active && anchorIds.has(block.anchorMessageId),
  );
}

/**
 * Synchronise blocks with the current message view.
 *
 * For each *active* block, checks whether its `anchorMessageId` still
 * exists in the `messages` array using the same id-set logic as `liveBlocks`.
 * If the anchor is missing (compacted away or otherwise deleted), the block
 * is deactivated (`active = false`).
 *
 * Already-deactivated blocks are NOT re-processed.
 *
 * @param state - The session state.
 * @param messages - The current message array (transform-phase view).
 */
export function syncBlocks(
  state: SessionState,
  messages: ReadonlyArray<{ info: { id: string } }>,
): void {
  const anchorIds = new Set<string>();
  for (const msg of messages) {
    anchorIds.add(msg.info.id);
  }

  for (const [, block] of state.blocks) {
    if (!block.active) continue; // Already deactivated — skip.
    if (!anchorIds.has(block.anchorMessageId)) {
      block.active = false;
      state.dirty = true;
    }
  }
}

// ---------------------------------------------------------------------------
// Derived stats (pure functions — read-only over state.blocks)
// ---------------------------------------------------------------------------

/**
 * Count of active compression blocks.
 *
 * @param state - The session state.
 * @returns Number of blocks with `active === true`.
 */
export function activeBlockCount(state: SessionState): number {
  let count = 0;
  for (const [, block] of state.blocks) {
    if (block.active) count++;
  }
  return count;
}

/**
 * Sum of net reclaimed tokens across all active blocks.
 *
 * Net reclaimed = `compressedTokens - summaryTokens` for each active
 * block.  Only active blocks are counted (the "active scope").
 *
 * @param state - The session state.
 * @returns Total net reclaimed tokens from active blocks.
 */
export function activeReclaimedTokens(state: SessionState): number {
  let sum = 0;
  for (const [, block] of state.blocks) {
    if (block.active) {
      sum += block.compressedTokens - block.summaryTokens;
    }
  }
  return sum;
}

/**
 * Sum of net reclaimed tokens across ALL blocks (active + inactive).
 *
 * Cumulative over the entire lifecycle of the session — deactivated
 * blocks continue contributing to this total.
 *
 * @param state - The session state.
 * @returns Total net reclaimed tokens from all blocks ever created.
 */
export function cumulativeReclaimedTokens(state: SessionState): number {
  let sum = 0;
  for (const [, block] of state.blocks) {
    sum += block.compressedTokens - block.summaryTokens;
  }
  return sum;
}
