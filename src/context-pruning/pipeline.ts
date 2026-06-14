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
import { markPurgeErrors } from "./purge-errors";
import { globalState } from "./state";
import type {
  ContextPruningConfig,
  MessageRef,
  PipelineInput,
  PipelineOutput,
  PipelineStats,
} from "./types";

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

  // Step 2: Assign message refs (mNNNN)
  messages.forEach((m, i) => {
    m.id = `m${String(i).padStart(4, "0")}`;
  });

  // Step 3: Dedup marking — writes to state.prune.tools
  markDuplicates(state, config, messages);

  // Step 4: Purge-errors marking — writes to state.prune.tools
  markPurgeErrors(state, config, messages);
}

// ── runPipeline (every-turn) ──────────────────────────────

/**
 * Run the every-turn pruning pipeline on a set of messages.
 *
 * Called every turn to:
 *   1. Filter malformed messages
 *   2. Assign message references (mNNNN)
 *   2b. Advance turn counter
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

  // ── Step 2: Assign message refs ───────────────────────
  working.forEach((m, i) => {
    m.id = `m${String(i).padStart(4, "0")}`;
  });

  // ── Step 2b: Advance turn counter ─────────────────────
  globalState.advanceTurn(sessionId);

  // ── Step 3: Apply prune ──────────────────────────────
  const pruneResult = applyPruning(state, working);
  working = pruneResult.messages;
  stats.prunedOutputs = pruneResult.prunedOutputs;
  stats.prunedErrors = pruneResult.prunedErrors;

  // ── Step 4: Build nudges ─────────────────────────────
  const totalTokens = estimateTotalTokens(working);
  const nudges = buildNudges(totalTokens, config);

  // ── Step 5: Strip stale metadata ─────────────────────
  for (const msg of working) {
    if (msg.metadata) {
      // Remove cross-provider metadata fields
      delete msg.metadata._provider;
      delete msg.metadata._raw;
    }
  }

  return { messages: working, nudges, stats };
}
