/**
 * Compression block fold consumer -- the transform phase of the block lifecycle.
 *
 * Provides both a pure read-only preview function (`previewFold`) and the
 * existing in-place transform (`foldCompressedBlocks`) that delegates to it.
 *
 * Prefix-cache discipline: operates on a copy, never edits stored messages
 * in place.  The entire segment is removed and the summary is appended at
 * the anchor position.
 *
 * @module
 */

import type { ContextMessageEntry } from "../metrics.js";
import type { CompressionBlock } from "./blocks.js";
import { firstUserMessageIndex } from "./shared.js";
import type { SessionState } from "./types.js";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Compute the folded message view for a given set of compression blocks.
 *
 * Pure function -- accepts messages and an explicit block array, returns a
 * NEW array.  Does NOT mutate the input arrays and does NOT read any module
 * state or logging.
 *
 * Semantics (identical to `foldCompressedBlocks`):
 * - Only `active` blocks participate in folding.
 * - Blocks whose `anchorMessageId` is not present in `messages` are skipped.
 * - For each active block whose anchor IS present: the synthetic summary
 *   message (`buildSyntheticMessage`) is injected at the anchor position;
 *   all covered messages (those whose id is in the block's `messageIds`)
 *   are removed.
 * - The first non-ignored user message in the conversation is force-kept
 *   even when covered (defensive).
 * - When the anchor IS the first user message, both the original message
 *   and the synthetic summary are kept.
 *
 * @param messages - The full message array (not mutated).
 * @param blocks - Explicit array of compression blocks (not mutated).
 * @returns A new folded message array.
 */
export function previewFold(
  messages: ContextMessageEntry[],
  blocks: CompressionBlock[],
): ContextMessageEntry[] {
  // Collect active block lookup structures.
  const coveredIds = new Set<string>();
  const anchorToBlock = new Map<string, CompressionBlock>();

  for (const block of blocks) {
    if (!block.active) continue;
    for (const mid of block.messageIds) {
      coveredIds.add(mid);
    }
    anchorToBlock.set(block.anchorMessageId, block);
  }

  // No active blocks -- return a copy (identity match with foldCompressedBlocks).
  if (anchorToBlock.size === 0) {
    return [...messages];
  }

  // Find the index of the first non-ignored user message for force-keep.
  const firstUserIdx = firstUserMessageIndex(messages);

  // Build the folded message list by iterating the original messages.
  const folded: ContextMessageEntry[] = [];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    const msgId = msg.info.id;

    // If this message is an anchor for an active block, inject the
    // synthetic summary message at this position.  The anchor itself
    // is covered (it is inside messageIds) and will be removed unless
    // it is also the first user message.
    const block = anchorToBlock.get(msgId);
    if (block) {
      const syntheticMsg = buildSyntheticMessage(block);
      folded.push(syntheticMsg);
      // When the anchor IS also the first user message, keep the
      // original alongside the synthetic summary (defensive).
      if (i === firstUserIdx) {
        folded.push(msg);
      }
      continue;
    }

    // Force-keep the first user message even if covered by a block.
    if (i === firstUserIdx && coveredIds.has(msgId)) {
      folded.push(msg);
      continue;
    }

    // Skip covered messages (they are folded into the summary).
    if (coveredIds.has(msgId)) {
      continue;
    }

    // Keep all other messages unchanged.
    folded.push(msg);
  }

  return folded;
}

/**
 * Fold active compression blocks into synthetic summary messages.
 *
 * Thin shell over `previewFold`: gathers active blocks from the session
 * state, delegates to `previewFold`, then replaces `messages` in place.
 *
 * Sub-agent sessions with an empty block set are O(1) no-op.
 *
 * @param state - The session state (reads `blocks` map only).
 * @param messages - The message array to fold (mutated in place).
 */
export function foldCompressedBlocks(
  state: SessionState,
  messages: ContextMessageEntry[],
): void {
  // O(1) no-op for sub-agent sessions with no compression blocks.
  if (state.blocks.size === 0) return;

  // Collect active blocks from the state map.
  const activeBlocks: CompressionBlock[] = [];
  for (const [, block] of state.blocks) {
    if (block.active) {
      activeBlocks.push(block);
    }
  }

  // No active blocks -- nothing to fold.
  if (activeBlocks.length === 0) return;

  // Delegate to the pure function.
  const folded = previewFold(messages, activeBlocks);

  // Replace the messages array in place (prefix-cache discipline:
  // whole-segment removal + appended injection, never in-place edit).
  messages.length = 0;
  messages.push(...folded);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a synthetic summary message for an active compression block.
 *
 * The message carries a `synthetic: true` marker at the info level so
 * downstream code can identify it.  Its text IS the block summary, which
 * production summaries already start with — the canonical
 * `[Compression Block bN]` header — so no extra prefix is added.
 *
 * @param block - The active compression block.
 * @returns A synthetic user message entry.
 */
function buildSyntheticMessage(block: CompressionBlock): ContextMessageEntry {
  return {
    info: {
      role: "user",
      id: `zoo-fold-b${block.blockId}`,
      synthetic: true,
    },
    parts: [{ type: "text", text: block.summary }],
  };
}
