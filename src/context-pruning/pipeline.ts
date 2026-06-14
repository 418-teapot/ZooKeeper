/**
 * Context pruning pipeline — orchestrates the message transformation steps.
 *
 * Split architecture:
 *   prepareSession()  — every-turn: ensure session state exists
 *   runPipeline()     — every-turn: filter + assign IDs + advanceTurn + sync blocks + dedup + purge-errors + apply prune + nudge + strip metadata
 *
 * syncCompressionBlocks is called only once per turn, from runPipeline,
 * after ID assignment (P3), so it always sees the final mNNNN-format IDs.
 *
 * @module
 */

import { applyCompression } from "./compress";
import { markDuplicates } from "./dedup";
import { estimateTotalTokens } from "./estimator";
import { buildNudges } from "./nudge";
import { applyPruning } from "./prune";
import { markPurgeErrors } from "./purge-errors";
import { saveSessionState } from "./persist";
import { globalState } from "./state";
import type {
  ContextPruningConfig,
  MessageRef,
  PipelineInput,
  PipelineOutput,
  PipelineStats,
  SessionState,
} from "./types";

// ── stripHallucinations ──────────────────────────────────

/**
 * Strip hallucinated `<zoo:*>` XML tags from message content.
 *
 * LLMs sometimes generate fake system tags. This prevents them from
 * interfering with block reference resolution and message ID tracking.
 */
function stripHallucinations(content: string): string {
  return content
    .replace(/<zoo:message-id>.*?<\/zoo:message-id>/g, "")
    .replace(/<zoo:block-id>.*?<\/zoo:block-id>/g, "");
}

// ── prepareSession (state init) ────────────────────────────

/**
 * Ensure session state exists for context pruning — called every turn.
 *
 * State creation (getOrCreate) is also done inside runPipeline, so this
 * function is purely a convenience / explicit-init export for callers
 * that want to guarantee state exists before runPipeline.
 *
 * NOTE: syncCompressionBlocks is NOT called here — it runs once from
 * runPipeline after ID assignment (P3) so that block anchorMessageIds
 * always match the mNNNN-format IDs visible at pipeline runtime.
 *
 * @param config - Context pruning configuration.
 * @param messages - Unused (kept for API compatibility).
 * @param sessionId - The session identifier.
 */
export function prepareSession(
  config: ContextPruningConfig,
  _messages: MessageRef[],
  sessionId: string,
): void {
  if (!config.enabled) return;
  globalState.getOrCreate(sessionId, config.turnProtection);
}

// ── syncCompressionBlocks ──────────────────────────────────

/**
 * Sync compression blocks — deactivate blocks whose origin messages have
 * been removed from the active message array (e.g., by OpenCode compaction).
 *
 * @param state - Session state (compression blocks, active blocks).
 * @param messages - The current working message array.
 */
export function syncCompressionBlocks(
  state: SessionState,
  messages: MessageRef[],
): void {
  const messageIds = new Set(messages.map((m) => m.id));
  const now = Date.now();

  for (const [blockId, block] of state.blocksById) {
    if (!block.active) continue;

    // Check if the block should be deactivated
    let shouldDeactivate = false;

    // D4: Deactivated by user
    if (block.deactivatedByUser) {
      shouldDeactivate = true;
    }

    // If the block's anchor message no longer exists, deactivate the block
    if (!messageIds.has(block.anchorMessageId)) {
      shouldDeactivate = true;
    }

    // D3: If compressMessageId points to a message no longer present, deactivate
    if (block.compressMessageId && !messageIds.has(block.compressMessageId)) {
      shouldDeactivate = true;
    }

    if (shouldDeactivate) {
      block.active = false;
      block.deactivatedAt = now;
      state.activeBlockIds.delete(blockId);
      state.activeByAnchorMessageId.delete(block.anchorMessageId);

      // D19: Clean up byMessageId entries for consumed blocks
      for (const msgId of block.effectiveMessageIds) {
        const entry = state.byMessageId.get(msgId);
        if (entry) {
          entry.activeBlockIds = entry.activeBlockIds.filter(
            (id) => id !== blockId,
          );
        }
      }
    }
  }
}

// ── runPipeline (every-turn) ──────────────────────────────

/**
 * Run the every-turn pruning pipeline on a set of messages.
 *
 * Called every turn to:
 *   1. Filter malformed messages
 *   2. Assign message references (mNNNN)
 *   2b. Sync compression blocks (deactivate orphaned blocks) — after ID
 *       assignment so block anchorMessageIds match the mNNNN-format IDs
 *   2c. Advance turn counter
 *   2d. Dedup marking — writes to state.prune.tools
 *   2e. Purge-errors marking — writes to state.prune.tools
 *   3. Apply prune (reads state.prune.tools)
 *   4. Build nudges (based on token thresholds)
 *   5. Strip stale metadata
 *
 * syncCompressionBlocks is called here (step 2c) because messages have
 * been assigned mNNNN IDs in step 2.  This is the only call to
 * syncCompressionBlocks per turn — prepareSession no longer calls it.
 *
 * @param input - Pipeline input with session ID, messages, and config.
 * @returns Pipeline output with filtered messages, nudges, and stats.
 */
export function runPipeline(input: PipelineInput): PipelineOutput {
  const { sessionId, messages, config } = input;
  let working = [...messages];
  const stats: PipelineStats = {
    dedupRemoved: 0,
    errorPurged: 0,
    compressedTokens: 0,
    summaryTokens: 0,
    prunedOutputs: 0,
    prunedErrors: 0,
  };

  const state = globalState.getOrCreate(sessionId, config.turnProtection);

  // ── Step 1: Filter malformed ──────────────────────────
  working = working.filter((m) => m.id && m.role && m.content !== undefined);

  // ── Step 1.5: Strip hallucinated <zoo:*> tags ─────────
  for (const m of working) {
    if (m.content) {
      m.content = stripHallucinations(m.content);
    }
    // Also strip hallucinations from tool result output/error fields
    if (m.toolResults) {
      for (const tr of m.toolResults) {
        if (tr.output) {
          tr.output = stripHallucinations(tr.output);
        }
        if (tr.error) {
          tr.error = stripHallucinations(tr.error);
        }
      }
    }
  }

  // ── Step 2: Assign message refs ───────────────────────
  // Scan for max existing ref number to avoid ID collisions with
  // messages that were compressed out of the array but still mapped
  // in state.byMessageId.
  let nextId = 0;
  for (const m of working) {
    const match = /^m(\d{4,})$/.exec(m.id);
    if (match) {
      nextId = Math.max(nextId, parseInt(match[1], 10) + 1);
    }
  }
  // Also scan byMessageId for IDs compressed out of the working array
  for (const key of state.byMessageId.keys()) {
    const match = /^m(\d{4,})$/.exec(key);
    if (match) {
      nextId = Math.max(nextId, parseInt(match[1], 10) + 1);
    }
  }
  working.forEach((m) => {
    if (!/^m\d{4,}$/.test(m.id) && !m.id.startsWith("dcp_c")) {
      m.id = `m${String(nextId).padStart(4, "0")}`;
      nextId++;
      if (m.content && !m.content.includes("<zoo:message-id>")) {
        m.content = `<zoo:message-id>${m.id}</zoo:message-id>\n${m.content}`;
      }
    }
  });

  // ── Step 2c: Sync compression blocks ─────────────────
  syncCompressionBlocks(state, working);

  // ── Advance turn counter (before marking steps so turnCount
  //     is correct for markPurgeErrors error age calculation) ──
  globalState.advanceTurn(sessionId);

  // ── Step 2d: Dedup marking — writes to state.prune.tools ──
  markDuplicates(state, config, working);

  // ── Step 2e: Purge-errors marking — writes to state.prune.tools ──
  markPurgeErrors(state, config, working);

  // ── Step 3: Apply prune ──────────────────────────────
  const pruneResult = applyPruning(state, working);
  working = pruneResult.messages;
  stats.prunedOutputs = pruneResult.prunedOutputs;
  stats.prunedErrors = pruneResult.prunedErrors;

  // ── Step 3.5: Apply compression ──────────────────────
  if (config.compressEnabled) {
    working = applyCompression(state, config, working, stats);
  }

  // ── Persist state after compression (captures totalPrunedTokens,
  //     totalCompressedTokens, blocksById updates) ──────────
  saveSessionState(state);

  // ── Step 4: Build nudges ─────────────────────────────
  const totalTokens = estimateTotalTokens(working);
  const nudges = buildNudges(totalTokens, config, state);

  // ── Step 5: Strip stale metadata (keep on last assistant) ──
  // TODO(Phase 4): implement model-aware per-part metadata stripping like DCP's stripStaleMetadata
  const lastAssistantIdx = working.reduce(
    (idx, m, i) => (m.role === "assistant" ? i : idx),
    -1,
  );
  for (let i = 0; i < working.length; i++) {
    const msg = working[i];
    if (msg.metadata && i < lastAssistantIdx) {
      delete msg.metadata._provider;
      delete msg.metadata._raw;
    }
  }

  return { messages: working, nudges, stats };
}
