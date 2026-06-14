/**
 * LLM-driven compress tool definition (Phase 4).
 *
 * Registers a tool that the LLM can call to manually trigger compression of
 * conversation ranges, providing its own summaries. This enables smarter
 * compression decisions compared to the automatic heuristic compression.
 *
 * Includes content protection checks — ranges containing protected file paths
 * or protected tools are skipped with a note in the return string.
 *
 * @module
 */

import config from "../../config.toml" with { type: "toml" };
import { log } from "../utils/logger.js";
import { applyMessageCompression } from "./compress-message";
import { loadContextConfig } from "./config-loader";
import { estimateTokens } from "./estimator";
import {
  getFilePathsFromParameters,
  isFilePathProtected,
  isToolNameProtected,
} from "./protected-patterns";
import { globalState } from "./state";
import type {
  CompressionBlock,
  ContextPruningConfig,
  SessionState,
} from "./types";

// ---------------------------------------------------------------------------
// Config loading
// ---------------------------------------------------------------------------

/**
 * Load context pruning configuration from config.toml.
 *
 * When the TOML is unavailable or malformed the function logs a warning and
 * returns a conservative default with pruning **disabled** (enabled=false)
 * so that a broken config never silently enables pruning.
 *
 * @returns A fully resolved ContextPruningConfig.
 */
function loadConfig(): ContextPruningConfig {
  try {
    const rawToml = config as Record<string, unknown>;
    const zooSection = (rawToml?.zoo ?? {}) as Record<string, unknown>;
    return loadContextConfig(zooSection);
  } catch (err) {
    log("context-pruning", "config_load_failed", "", undefined, "warn", {
      error: String(err),
    });
    return loadContextConfig({ context: { enabled: false } }, undefined);
  }
}

// ---------------------------------------------------------------------------
// Protected-content helpers (best-effort via dedup cache)
// ---------------------------------------------------------------------------

/**
 * Parse the JSON parameters portion from a dedup cache signature.
 *
 * The dedup signature format is `<toolName>::<JSON-stringified-params>`,
 * so this extracts everything after the first `::` separator.
 *
 * @param signature - The dedup cache entry signature.
 * @returns Parsed parameters, or `null` if parsing fails.
 */
function parseDedupParams(signature: string): Record<string, unknown> | null {
  const sep = "::";
  const idx = signature.indexOf(sep);
  if (idx === -1) return null;
  try {
    return JSON.parse(signature.substring(idx + sep.length)) as Record<
      string,
      unknown
    >;
  } catch {
    return null;
  }
}

/**
 * Check whether the message ID range [startId, endId] overlaps with any
 * dedup-cached tool call whose parameters reference a protected file path.
 *
 * Uses the dedup cache as the best-available source of tool parameters in
 * the compress-tool (which does not have access to full message content).
 * When no parameters are available (cache miss) the check is skipped.
 *
 * @param state      - Current session state.
 * @param startId    - Start of the message ID range (inclusive).
 * @param endId      - End of the message ID range (inclusive).
 * @param patterns   - Glob patterns for protected file paths (from config).
 * @returns `true` if at least one protected file path was found.
 */
function hasProtectedFilePathsInRange(
  state: SessionState,
  startId: string,
  endId: string,
  patterns: string[],
): boolean {
  if (patterns.length === 0) return false;

  for (const entry of state.dedupCache.values()) {
    // Overlap test: does this entry's range intersect [startId, endId]?
    if (entry.firstSeenAt <= endId && entry.latestSeenAt >= startId) {
      const params = parseDedupParams(entry.signature);
      if (!params) continue;
      const filePaths = getFilePathsFromParameters(params);
      for (const fp of filePaths) {
        if (isFilePathProtected(fp, patterns)) {
          return true;
        }
      }
    }
  }
  return false;
}

/**
 * Check whether the message ID range [startId, endId] contains any tool
 * call whose name matches a protected tool pattern.
 *
 * Relies on the dedup cache as the best-available source (see
 * {@link hasProtectedFilePathsInRange}).
 *
 * @param state          - Current session state.
 * @param startId        - Start of the message ID range (inclusive).
 * @param endId          - End of the message ID range (inclusive).
 * @param protectedTools - List of protected tool name patterns (from config).
 * @returns `true` if at least one protected tool was found in range.
 */
function hasProtectedToolsInRange(
  state: SessionState,
  startId: string,
  endId: string,
  protectedTools: string[],
): boolean {
  if (protectedTools.length === 0) return false;

  for (const entry of state.dedupCache.values()) {
    if (entry.firstSeenAt <= endId && entry.latestSeenAt >= startId) {
      if (isToolNameProtected(entry.toolName, protectedTools)) {
        return true;
      }
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

/**
 * Compress tool definition conforming to OpenCode's tool registration
 * interface.
 */
export const compressToolDef = {
  description:
    "Compress a range of conversation messages to free context space. Use this when the context is getting full and there are completed tasks whose details are no longer needed.",

  args: {
    topic: {
      type: "string",
      description: "Short label (3-5 words) describing what was compressed",
    },
    ranges: {
      type: "array",
      items: {
        type: "object",
        properties: {
          startId: {
            type: "string",
            description: "First message ID to compress",
          },
          endId: {
            type: "string",
            description: "Last message ID to compress",
          },
          summary: {
            type: "string",
            description: "Concise summary of key information preserved",
          },
        },
        required: ["startId", "endId", "summary"],
      },
      description: "Ranges of messages to compress",
    },
  },

  /**
   * Execute the compress tool.
   *
   * 1. Validate inputs (topic, ranges, overlap detection)
   * 2. Ask for permission via context.ask() (non-fatal if denied)
   * 3. Set metadata title via context.metadata() (non-fatal if fails)
   * 4. Get session state from globalState
   * 5. For each range: create CompressionBlock, deactivate consumed blocks,
   *    update state, count savings. Single-message ranges delegate to
   *    applyMessageCompression for message-mode block creation.
   * 6. Return a human-readable summary string
   *
   * @param args - Tool arguments with topic and ranges.
   * @param context - OpenCode execution context (includes sessionID and
   *   messageID for compressMessageId tracking).
   * @returns Human-readable result string.
   */
  async execute(
    args: {
      topic: string;
      ranges: Array<{
        startId: string;
        endId: string;
        summary: string;
      }>;
    },
    context: {
      sessionID: string;
      messageID: string;
      ask: (input: {
        permission: string;
        patterns: string[];
        always: string[];
        metadata: Record<string, unknown>;
      }) => Promise<void>;
      metadata: (input: { title?: string }) => void;
    },
  ): Promise<string> {
    // ── Step 1: Input validation ─────────────────────────
    if (typeof args.topic !== "string" || args.topic.trim().length === 0) {
      return "Compression skipped: topic must be a non-empty string";
    }
    if (!Array.isArray(args.ranges) || args.ranges.length === 0) {
      return "Compression skipped: ranges must be a non-empty array";
    }
    for (let ri = 0; ri < args.ranges.length; ri++) {
      const r = args.ranges[ri];
      if (typeof r.startId !== "string" || r.startId.trim().length === 0) {
        return `Compression skipped: range ${ri} has an empty or missing startId`;
      }
      if (typeof r.endId !== "string" || r.endId.trim().length === 0) {
        return `Compression skipped: range ${ri} has an empty or missing endId`;
      }
      if (typeof r.summary !== "string" || r.summary.trim().length === 0) {
        return `Compression skipped: range ${ri} has an empty or missing summary`;
      }
      if (r.startId > r.endId) {
        return `Compression skipped: range ${ri} has startId "${r.startId}" after endId "${r.endId}"`;
      }
    }
    // Check for overlapping ranges (lexicographic comparison on zero-padded IDs)
    const sorted = [...args.ranges].sort((a, b) =>
      a.startId.localeCompare(b.startId),
    );
    for (let si = 1; si < sorted.length; si++) {
      if (sorted[si].startId <= sorted[si - 1].endId) {
        return (
          `Compression skipped: ranges must not overlap (` +
          `"${sorted[si - 1].startId}-${sorted[si - 1].endId}" ` +
          `overlaps with "${sorted[si].startId}-${sorted[si].endId}")`
        );
      }
    }

    // ── Step 2: Ask for permission ──────────────────────────
    try {
      await context.ask({
        permission: "compress",
        patterns: ["context-pruning"],
        always: ["compress"],
        metadata: {
          topic: args.topic,
          rangeCount: args.ranges.length,
        },
      });
    } catch {
      // Permission denied — non-fatal, skip compression gracefully
      return "Compression skipped: permission not granted";
    }

    // ── Step 3: Set metadata title ──────────────────────────
    try {
      context.metadata({
        title: `Compress: ${args.topic}`,
      });
    } catch {
      // Metadata failure is non-fatal — continue
    }

    // ── Step 4: Get session state ───────────────────────────
    const state = globalState.get(context.sessionID);
    if (!state) {
      return `Compression skipped: no active session found for ${context.sessionID}`;
    }

    // ── Step 5: Load config for protection checks ──────────
    const ctxConfig = loadConfig();
    const { protectedFilePatterns, protectedTools: protectedToolPatterns } =
      ctxConfig;

    // ── Step 6: Process each range ─────────────────────────
    let totalTokenSavings = 0;
    let totalSummaryTokens = 0;
    let totalMessagesCompressed = 0;
    let successCount = 0;
    let skippedFileRanges = 0;
    let skippedToolRanges = 0;

    for (const range of args.ranges) {
      // ── Content protection checks ──────────────────────────
      const { startId, endId } = range;

      if (
        hasProtectedFilePathsInRange(
          state,
          startId,
          endId,
          protectedFilePatterns,
        )
      ) {
        skippedFileRanges++;
        continue;
      }

      if (
        hasProtectedToolsInRange(state, startId, endId, protectedToolPatterns)
      ) {
        skippedToolRanges++;
        continue;
      }

      try {
        const { summary } = range;

        // ── Single-message range: delegate to applyMessageCompression ──
        if (startId === endId) {
          applyMessageCompression(
            state,
            [],
            startId,
            summary,
            context.messageID,
          );
          const msgBlock = state.blocksById.get(state.nextBlockId - 1);
          if (msgBlock && msgBlock.compressedTokens > 0) {
            totalTokenSavings += Math.max(
              0,
              msgBlock.compressedTokens - msgBlock.summaryTokens,
            );
          }
          totalMessagesCompressed++;
          successCount++;
          continue;
        }

        // ── Multi-message range: create a range block ────
        const blockId = state.nextBlockId++;
        const summaryTokens = estimateTokens(summary);
        const now = Date.now();
        const block: CompressionBlock = {
          blockId,
          runId: state.nextRunId++,
          active: true,
          deactivatedByUser: false,
          compressedTokens: 0, // unknown without messages array — set by pipeline
          summaryTokens,
          mode: "range",
          topic: args.topic,
          createdAt: now,
          anchorMessageId: startId,
          compressMessageId: context.messageID, // Real tool execution message ID
          durationMs: 0,
          consumedBlockIds: [],
          parentBlockIds: [],
          includedBlockIds: [],
          startId,
          endId,
          directMessageIds: [],
          directToolIds: [],
          effectiveMessageIds: [],
          effectiveToolIds: [],
          summary,
        };

        // ── Deactivate consumed blocks ──────────────────
        // Any existing active block whose effective messages overlap with
        // this new block's range is deactivated.  Uses precise
        // effectiveMessageIds intersection (same pattern as
        // compress.ts:160-163) to avoid false positives from raw string
        // comparison when effectiveMessageIds don't fully span the range.
        const rangeMessageIds = new Set<string>();
        for (const msgId of state.byMessageId.keys()) {
          if (msgId >= startId && msgId <= endId) {
            rangeMessageIds.add(msgId);
          }
        }
        const usePreciseOverlap = rangeMessageIds.size > 0;
        for (const [existingBlockId, existingBlock] of state.blocksById) {
          if (!existingBlock.active) continue;
          const hasOverlap = usePreciseOverlap
            ? existingBlock.effectiveMessageIds.some((id) =>
                rangeMessageIds.has(id),
              )
            : existingBlock.startId <= endId && existingBlock.endId >= startId;
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

        state.blocksById.set(blockId, block);
        state.activeBlockIds.add(blockId);
        state.activeByAnchorMessageId.set(startId, blockId);

        // ── Register in byMessageId index ──────────────
        // Each message in the range gets a MessageBlockEntry pointing to
        // this block.  tokenCount is 0 (unknown without message content);
        // the pipeline will update it when scanning.  The important thing
        // is that activeBlockIds includes this block so the pipeline knows
        // each message is compressed by this block.
        for (const msgId of rangeMessageIds) {
          const existing = state.byMessageId.get(msgId);
          if (existing) {
            if (!existing.allBlockIds.includes(blockId)) {
              existing.allBlockIds.push(blockId);
            }
            if (!existing.activeBlockIds.includes(blockId)) {
              existing.activeBlockIds.push(blockId);
            }
          } else {
            state.byMessageId.set(msgId, {
              tokenCount: 0, // pipeline updates when scanning
              allBlockIds: [blockId],
              activeBlockIds: [blockId],
            });
          }
        }

        // Count known message IDs in this range for reporting.
        // rangeMessageIds was built from byMessageId keys earlier so it
        // already contains all known message IDs in [startId, endId].
        totalMessagesCompressed += rangeMessageIds.size;
        totalSummaryTokens += summaryTokens;
        successCount++;
      } catch (rangeErr) {
        log("compress-tool", "error", "", undefined, "error", {
          error: String(rangeErr),
          startId: range.startId,
          endId: range.endId,
        });
      }
    }

    // ── Step 7: Return summary ─────────────────────────────
    const totalDisplay = formatTokenSavings(
      totalMessagesCompressed,
      totalTokenSavings,
      totalSummaryTokens,
    );
    let result = `Compressed ${successCount} ranges (${totalDisplay}) on topic: ${args.topic}`;
    const notes: string[] = [];
    if (skippedFileRanges > 0) {
      notes.push(
        `(skipped ${skippedFileRanges} range${skippedFileRanges > 1 ? "s" : ""} with protected files)`,
      );
    }
    if (skippedToolRanges > 0) {
      notes.push(
        `(skipped ${skippedToolRanges} range${skippedToolRanges > 1 ? "s" : ""} with protected tools)`,
      );
    }
    if (notes.length > 0) {
      result += ` ${notes.join(" ")}`;
    }
    return result;
  },
};

/**
 * Format a human-readable count of compressed messages and token savings.
 *
 * When actual token savings are known (single-message range) they are
 * reported as part of the string.  For multi-message ranges where the
 * pipeline has not yet computed compressed tokens, the summary token
 * size is shown alongside the message count.
 *
 * @param messagesCompressed - Number of individual messages compressed.
 * @param tokenSavings - Estimated token savings (compressed - summary).
 * @param summaryTokens - Total tokens consumed by all summaries (0 when unknown).
 * @returns Formatted string like "5 messages, ~3400 tokens freed".
 */
function formatTokenSavings(
  messagesCompressed: number,
  tokenSavings: number,
  summaryTokens: number,
): string {
  if (messagesCompressed > 0 && tokenSavings > 0) {
    return `${messagesCompressed} messages, ~${tokenSavings} tokens freed`;
  }
  if (messagesCompressed > 0 && summaryTokens > 0) {
    return `${messagesCompressed} messages compressed, ~${summaryTokens} tokens in summaries`;
  }
  if (messagesCompressed > 0) {
    return `${messagesCompressed} messages compressed`;
  }
  if (summaryTokens > 0) {
    return `~${summaryTokens} tokens in summaries`;
  }
  return "no messages compressed";
}
