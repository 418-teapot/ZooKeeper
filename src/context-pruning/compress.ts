/**
 * Heuristic range compression (Phase 3).
 *
 * When context exceeds the nudge threshold, automatically compresses all
 * messages before the protected turn boundary into a single placeholder.
 * This is purely heuristic — no LLM call is made (LLM-driven compression
 * comes in Phase 4).
 *
 * @module
 */

import { log } from "../utils/logger.js";
import { estimateTotalTokens } from "./estimator";
import {
  getFilePathsFromParameters,
  isFilePathProtected,
} from "./protected-patterns";
import type {
  CompressionBlock,
  ContextPruningConfig,
  MessageRef,
  PipelineStats,
  SessionState,
} from "./types";

/**
 * Apply heuristic range compression to messages that exceed the context
 * threshold.
 *
 * Algorithm steps:
 *   1. Gate check — return unchanged if compression is disabled
 *   2. Token check — return unchanged if total tokens <= nudge threshold
 *   3. Find protection boundary by counting assistant messages from the end
 *   4. Build a single CompressionBlock covering all messages before the
 *      boundary
 *   5. Replace the compressed range with a placeholder message
 *   6. Update session state and pipeline stats
 *
 * @param state - Session state (compression blocks, active blocks).
 * @param config - Context pruning configuration (thresholds, mode).
 * @param messages - The current working message array.
 * @param stats - Pipeline statistics accumulator (mutated in place).
 * @returns A new message array with the compressed range replaced, or the
 *   original array if no compression was applied.
 */
export function applyCompression(
  state: SessionState,
  config: ContextPruningConfig,
  messages: MessageRef[],
  stats: PipelineStats,
): MessageRef[] {
  try {
    // ── Step 1: Gate check ────────────────────────────────
    if (!config.compressEnabled) return messages;

    // ── Step 2: Token check ───────────────────────────────
    const totalTokens = estimateTotalTokens(messages);
    if (totalTokens <= config.nudgeThresholdTokens) return messages;

    // ── Step 3: Find protection boundary ──────────────────
    // Walk messages backward counting assistant messages.
    // The last `turnProtection` assistant messages (and everything after them)
    // are protected from compression.
    let lastProtectedAssistantIndex = -1;
    let assistantCount = 0;

    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "assistant") {
        assistantCount++;
        if (assistantCount <= config.turnProtection) {
          lastProtectedAssistantIndex = i;
        }
        if (assistantCount > config.turnProtection) {
          break;
        }
      }
    }

    let boundaryIndex: number;
    if (lastProtectedAssistantIndex < 0) {
      // No protected assistant found — all are beyond the protection window.
      // Compress the entire message array.
      boundaryIndex = messages.length;
    } else {
      boundaryIndex = lastProtectedAssistantIndex;
    }

    // If no messages are before the boundary, there's nothing to compress
    if (boundaryIndex <= 0) return messages;

    // D12: Don't compress if the entire active context is protected
    if (boundaryIndex >= messages.length) return messages;

    // ── Step 4: Build compression block ───────────────────
    const range = messages.slice(0, boundaryIndex);

    // ── Step 4a: Protected file check ─────────────────────
    // Before compressing, verify that no message in the range contains tool
    // calls whose parameters reference protected file paths.  If any are
    // found, skip compression entirely to avoid losing context about files
    // the user has asked us to protect.
    const patterns = config.protectedFilePatterns;
    if (patterns.length > 0) {
      let hasProtected = false;
      for (const msg of range) {
        if (!msg.toolCalls) continue;
        for (const tc of msg.toolCalls) {
          const filePaths = getFilePathsFromParameters(tc.parameters);
          for (const fp of filePaths) {
            if (isFilePathProtected(fp, patterns)) {
              hasProtected = true;
              break;
            }
          }
          if (hasProtected) break;
        }
        if (hasProtected) break;
      }
      if (hasProtected) {
        log(
          "compress",
          "protected_files_skipped",
          "<unknown>",
          undefined,
          "debug",
        );
        return messages;
      }
    }
    const blockId = state.nextBlockId++;
    const compressedTokens = estimateTotalTokens(range);
    const summaryTokens = 50;

    // Extract topic from the first assistant message in the compressible range
    const firstAssistant = range.find((m) => m.role === "assistant");
    let topic = "earlier conversation";
    if (firstAssistant) {
      topic = firstAssistant.content
        .replace(/```[\s\S]*?```/g, "") // strip code blocks
        .replace(/\s{2,}/g, " ") // collapse whitespace
        .trim()
        .slice(0, 60)
        .trim();
      if (!topic) topic = "earlier conversation";
    }

    // Collect direct message and tool call IDs from the range
    const directMessageIds = range.map((m) => m.id);
    const directToolIds: string[] = [];
    for (const msg of range) {
      if (msg.toolCalls) {
        for (const tc of msg.toolCalls) {
          directToolIds.push(tc.id);
        }
      }
    }

    const block: CompressionBlock = {
      blockId,
      runId: state.nextRunId++,
      active: true,
      deactivatedByUser: false,
      compressedTokens,
      summaryTokens,
      mode: config.compressMode,
      topic,
      // Lifecycle tracking
      createdAt: Date.now(),
      anchorMessageId: range[0].id,
      compressMessageId: `dcp_c${blockId}`,
      durationMs: 0,
      consumedBlockIds: [],
      parentBlockIds: [],
      includedBlockIds: [],
      // Existing fields
      startId: range[0].id,
      endId: range[range.length - 1].id,
      directMessageIds,
      directToolIds,
      effectiveMessageIds: [...directMessageIds],
      effectiveToolIds: [...directToolIds],
      summary: `Compressed ${range.length} messages on "${topic}"`,
    };

    // ── Step 5: Create placeholder message ────────────────
    const placeholder: MessageRef = {
      id: `dcp_c${blockId}`,
      role: "user",
      content: `[Compressed: ${block.topic} — ${range.length} messages / ${compressedTokens} tokens removed]\n<zoo:block-id>${blockId}</zoo:block-id>`,
    };

    // ── Step 5.5: Deactivate consumed blocks ─────────────
    // Any existing block whose effective messages overlap with the new
    // compression range is deactivated.
    const rangeIds = new Set(range.map((m) => m.id));
    const now = Date.now();
    for (const [existingBlockId, existingBlock] of state.blocksById) {
      if (!existingBlock.active) continue;
      const hasOverlap = existingBlock.effectiveMessageIds.some((id) =>
        rangeIds.has(id),
      );
      if (!hasOverlap) continue;
      existingBlock.active = false;
      existingBlock.deactivatedAt = now;
      existingBlock.deactivatedByBlockId = blockId;
      if (!existingBlock.parentBlockIds.includes(blockId)) {
        existingBlock.parentBlockIds.push(blockId);
      }
      if (!block.consumedBlockIds.includes(existingBlockId)) {
        block.consumedBlockIds.push(existingBlockId);
      }
      state.activeBlockIds.delete(existingBlockId);
      state.activeByAnchorMessageId.delete(existingBlock.anchorMessageId);
      for (const msgId of existingBlock.effectiveMessageIds) {
        const entry = state.byMessageId.get(msgId);
        if (entry) {
          entry.activeBlockIds = entry.activeBlockIds.filter(
            (id) => id !== existingBlockId,
          );
        }
      }
    }

    // ── Step 6: Update session state ──────────────────────
    state.blocksById.set(blockId, block);
    state.activeBlockIds.add(blockId);
    state.activeByAnchorMessageId.set(block.anchorMessageId, blockId);
    for (const msg of range) {
      state.byMessageId.set(msg.id, {
        tokenCount: Math.ceil(msg.content.length / 4),
        allBlockIds: [blockId],
        activeBlockIds: [blockId],
      });
    }
    state.totalPrunedTokens += compressedTokens;
    state.totalCompressedTokens += compressedTokens;

    // ── Step 7: Update pipeline stats ─────────────────────
    stats.compressedTokens += compressedTokens;
    stats.summaryTokens += summaryTokens;

    // Clear nudge counter after compression to avoid stale reminder
    state.nudgeCounter = 0;

    // ── Return new message array ──────────────────────────
    return [placeholder, ...messages.slice(boundaryIndex)];
  } catch (e) {
    log("compress", "error", "", undefined, "error", { error: String(e) });
    return messages;
  }
}
