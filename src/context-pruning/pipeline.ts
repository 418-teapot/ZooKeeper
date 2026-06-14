/**
 * Context pruning pipeline — orchestrates the message transformation steps.
 *
 * Split architecture:
 *   prepareSession()  — compress-time: filter + assign IDs + dedup marking + purge-errors marking
 *   runPipeline()     — every-turn: filter + assign IDs + advanceTurn + apply prune + nudge + strip metadata
 *
 * @module
 */

import { markDuplicates } from "./dedup";
import { estimateTotalTokens } from "./estimator";
import { buildNudges } from "./nudge";
import { applyPruning } from "./prune";
import { applyCompression } from "./compress";
import { markPurgeErrors } from "./purge-errors";
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

// ── prepareSession (compress-time) ────────────────────────

/**
 * Prepare session state for context pruning — called once at session start
 * (or when the agent begins a new task, i.e. "compress-time").
 *
 * Steps:
 *   1. Filter malformed messages
 *   2. Assign message references (mNNNN)
 *   3. Dedup marking — writes to state.prune.tools
 *   4. Purge-errors marking — writes to state.prune.tools
 *
 * @param config - Context pruning configuration.
 * @param messages - The messages to prepare.
 * @param sessionId - The session identifier.
 */
export function prepareSession(
  config: ContextPruningConfig,
  messages: MessageRef[],
  sessionId: string,
): void {
  if (!config.enabled) return;
  const state = globalState.getOrCreate(sessionId, config.turnProtection);

  // Step 1: Filter malformed
  messages = messages.filter((m) => m.id && m.role && m.content !== undefined);

  // Step 1.5: Strip hallucinated <zoo:*> tags
  for (const m of messages) {
    if (m.content) {
      m.content = stripHallucinations(m.content);
    }
  }

  // Step 2: Assign message refs (mNNNN) and inject visible ID tag
  messages.forEach((m, i) => {
    if (!/^m\d{4,}$/.test(m.id) && !m.id.startsWith("dcp_c")) {
      m.id = `m${String(i).padStart(4, "0")}`;
      if (m.content && !m.content.includes("<zoo:message-id>")) {
        m.content = `<zoo:message-id>${m.id}</zoo:message-id>\n${m.content}`;
      }
    }
  });

  // Step 3: Dedup marking — writes to state.prune.tools
  markDuplicates(state, config, messages);

  // Step 4: Purge-errors marking — writes to state.prune.tools
  markPurgeErrors(state, config, messages);

  // Step 4.5: Sync compression blocks — deactivate orphaned blocks
  syncCompressionBlocks(state, messages);
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
 *   2b. Advance turn counter
 *   2c. Sync compression blocks (deactivate orphaned blocks)
 *   3. Apply prune (reads state.prune.tools)
 *   4. Build nudges (based on token thresholds)
 *   5. Strip stale metadata
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

  // ── Step 2b: Advance turn counter ─────────────────────
  globalState.advanceTurn(sessionId);

  // ── Step 2c: Sync compression blocks ─────────────────
  syncCompressionBlocks(state, working);

  // ── Step 3: Apply prune ──────────────────────────────
  const pruneResult = applyPruning(state, working);
  working = pruneResult.messages;
  stats.prunedOutputs = pruneResult.prunedOutputs;
  stats.prunedErrors = pruneResult.prunedErrors;

  // ── Step 3.5: Apply compression ──────────────────────
  if (config.compressEnabled) {
    working = applyCompression(state, config, working, stats);
  }

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
