/**
 * Per-message compression (Phase 4).
 *
 * When the LLM triggers compression via the compress tool, individual
 * messages can be compressed into a placeholder with an LLM-provided
 * summary. This is "message mode" — unlike heuristic range compression
 * which compresses a block of messages, this replaces a single message's
 * content with a summary placeholder.
 *
 * @module
 */

import { log } from "../utils/logger.js";
import { estimateTokens } from "./estimator";
import type { CompressionBlock, MessageRef, SessionState } from "./types";

/**
 * Apply per-message compression to a single message.
 *
 * 1. Creates a CompressionBlock (mode="message") covering one message
 * 2. If the message is found in the messages array, replaces its content
 *    with a placeholder like `[Compressed: {topic} — {summaryTokens} tokens]`
 * 3. Updates session state (blocksById, activeBlockIds, byMessageId)
 * 4. Returns the updated message array (unchanged if no content replacement)
 *
 * When called without a messages array (from LLM-driven compress tool where
 * the tool execute context does not include the full messages list), only the
 * block is created and state is updated; content replacement is skipped.
 *
 * On any error, the original messages array is returned unchanged.
 *
 * @param state - Session state.
 * @param messages - Current message array (empty array for tool-mode where
 *   only block creation is needed).
 * @param messageId - The ID of the message to compress.
 * @param summary - LLM-provided summary text.
 * @param compressMessageId - The real tool execution message ID from OpenCode
 *   (context.messageID). Used as the block's compressMessageId so the pipeline
 *   does not immediately deactivate the block via D3 logic.
 * @returns Updated message array with the compressed message replaced, or the
 *   original array if no content replacement was performed.
 */
export function applyMessageCompression(
  state: SessionState,
  messages: MessageRef[],
  messageId: string,
  summary: string,
  compressMessageId: string,
): MessageRef[] {
  try {
    // ── Step 1: Create compression block ───────────────────
    const blockId = state.nextBlockId++;
    const summaryTokens = estimateTokens(summary);

    // Compute compressed tokens based on whether message exists
    const index = messages.findIndex((m) => m.id === messageId);
    const target = index !== -1 ? messages[index] : undefined;
    const compressedTokens = target ? estimateTokens(target.content) : 0;
    const topic =
      summary
        .replace(/\s{2,}/g, " ")
        .trim()
        .slice(0, 60)
        .trim() || "compressed message";

    const block: CompressionBlock = {
      blockId,
      runId: state.nextRunId++,
      active: true,
      deactivatedByUser: false,
      compressedTokens,
      summaryTokens,
      mode: "message",
      topic,
      createdAt: Date.now(),
      anchorMessageId: messageId,
      compressMessageId, // Use real tool execution message ID
      durationMs: 0,
      consumedBlockIds: [],
      parentBlockIds: [],
      includedBlockIds: [],
      startId: messageId,
      endId: messageId,
      directMessageIds: [messageId],
      directToolIds: [],
      effectiveMessageIds: [messageId],
      effectiveToolIds: [],
      summary,
    };

    // ── Step 2: Update session state ───────────────────────
    state.blocksById.set(blockId, block);
    state.activeBlockIds.add(blockId);
    state.activeByAnchorMessageId.set(messageId, blockId);

    // ── Step 3: Update byMessageId index (before early return guard
    //    so tool-mode invocations with empty messages still register
    //    the block — critical for overlap detection) ───────────
    state.byMessageId.set(messageId, {
      tokenCount: compressedTokens,
      allBlockIds: [blockId],
      activeBlockIds: [blockId],
    });

    // If message not found in array (tool-mode, no content replacement), done
    if (!target) {
      return messages;
    }

    // ── Step 4: Replace message content with placeholder ──
    const placeholder: MessageRef = {
      ...target,
      content: `[Compressed: ${topic} — ${summaryTokens} tokens]\n<zoo:block-id>${blockId}</zoo:block-id>`,
    };

    const updated = [...messages];
    updated[index] = placeholder;

    // ── Return updated message array ───────────────────────
    return updated;
  } catch (e) {
    log("compress-message", "error", "", undefined, "error", {
      error: String(e),
    });
    return messages;
  }
}
