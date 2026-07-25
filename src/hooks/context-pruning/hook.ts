/**
 * Context pruning transform handler — the sweep phase entry point.
 *
 * Called from the `experimental.chat.messages.transform` hook.
 * Reads effective marks from `state.marks` (written by producers)
 * and replaces marked tool outputs with the placeholder text.
 *
 * @module
 */

import { formatTokens } from "../../core/context-report.js";
import type { ContextMessageEntry } from "../../core/metrics.js";
import { findLastCompletedAssistant } from "../../core/metrics.js";
import {
  getOrCreateSessionState,
  pendingTokens as pendingTokensDerived,
  reclaimedTokens as reclaimedTokensDerived,
  releaseBatch,
  saveSessionState,
} from "../../core/pruning/marks.js";
import type { DedupOptions } from "../../core/pruning/producers/dedup.js";
import { runDedup } from "../../core/pruning/producers/dedup.js";
import { pruneToolOutputs } from "../../core/pruning/prune.js";
import { log } from "../../utils/logger.js";

/**
 * Handle the messages.transform hook for context pruning.
 *
 * Two-phase clean-then-mark, gated by a 100K threshold:
 *
 * 1. Clean — prune previously-marked tool outputs from the last turn
 *    (marks from the previous dedup/sweep round take effect now).
 * 2. Gate — check whether `config.enabled` and the last completed
 *    assistant message's prompt-side total
 *    (`input + cache.read + cache.write`) >= `config.thresholdTokens`.
 * 3. Mark — if the gate passes, run dedup to find duplicate tool
 *    invocations and mark older copies for the *next* turn.
 *
 * The two-turn effect ("turn N marks apply on turn N+1") means that
 * marks produced by `runDedup` are NOT pruned during the same turn.
 *
 * Does NOT catch errors — the caller (opencode.ts) wraps this in
 * try/catch so a pruning failure never disrupts the LLM turn.
 *
 * @param messages - The session messages array from the transform output.
 * @param config - Dedup options with enabled gate and threshold.
 */
export function contextPruningTransformHandler(
  messages: ContextMessageEntry[] | null | undefined,
  config: DedupOptions = {},
  notify?: (text: string) => void,
): void {
  if (!messages || messages.length === 0) return;

  // Extract session ID from the first message.
  const firstMsg = messages[0];
  const sessionId = firstMsg?.info?.sessionID;
  if (!sessionId) return;

  // Get or create state — new session ID naturally creates fresh state.
  const state = getOrCreateSessionState(sessionId);

  // ── Phase 1: Clean — prune previously marked tool outputs ──────
  // Marks from previous dedup/sweep rounds take effect now.
  const markedCallIDs: string[] = [...state.marks.entries()]
    .filter(([, mark]) => mark.effective)
    .map(([callID]) => callID);
  const replacedOutputs = pruneToolOutputs(state, messages);

  // ── Phase 2: Gate + Mark — automatic dedup ─────────────────────
  // New marks will apply starting from the *next* turn.
  if (config.enabled !== false) {
    const lastAsst = findLastCompletedAssistant(messages);
    const threshold = config.thresholdTokens ?? 100000;
    const promptTokens =
      (lastAsst.tokens?.input ?? 0) +
      (lastAsst.tokens?.cache?.read ?? 0) +
      (lastAsst.tokens?.cache?.write ?? 0);
    if (lastAsst.index >= 0 && promptTokens >= threshold) {
      const dedupMarks = runDedup(state, messages, {
        turnProtection: config.turnProtection,
        protectedTools: config.protectedTools,
      });

      if (dedupMarks.length > 0) {
        log("context-pruning", "dedup_marked", sessionId, undefined, "info", {
          markedCount: dedupMarks.length,
          markedTokens: dedupMarks.reduce(
            (sum, m) => sum + m.estimatedTokens,
            0,
          ),
        });
      }

      // ── Batch release check ────────────────────────────────────
      // Release pending (non-effective) marks into effective when the
      // accumulated token value reaches releaseThresholdPercent of prompt-side total.
      const curPendingTokens = pendingTokensDerived(state);
      if (curPendingTokens > 0) {
        const releasePct = config.releaseThresholdPercent ?? 5;
        const batchThreshold = (promptTokens * releasePct) / 100;
        if (curPendingTokens >= batchThreshold) {
          const released = releaseBatch(state);
          log(
            "context-pruning",
            "dedup_released",
            sessionId,
            undefined,
            "info",
            {
              releasedCount: released.count,
              releasedTokens: released.tokens,
              pendingTokensBefore: curPendingTokens,
              promptTokens,
            },
          );

          // Notify the session chat with a user-visible ignored message.
          // Fire-and-forget — the caller (opencode.ts) wraps this in
          // an async prompt that must never block the transform.
          if (released.count > 0 && notify) {
            notify(
              `去重：已折叠 ${released.count} 个重复工具输出，约释放 ${formatTokens(released.tokens)} tokens`,
            );
          }
        }
      }
    }
  }

  // ── Phase 3: Persist to disk when dirty ────────────────────────
  // saveSessionState already catches all errors internally.
  if (state.dirty) {
    saveSessionState(sessionId, state);
    state.dirty = false;
  }

  // ── Phase 4: Log prune completion ──────────────────────────────
  const totalEff = reclaimedTokensDerived(state);
  log("context-pruning", "prune_completed", sessionId, undefined, "info", {
    prunedToolCount: markedCallIDs.length,
    totalPruneTokens: totalEff,
    totalReclaimedTokens: totalEff,
  });

  if (replacedOutputs.length > 0) {
    log("context-pruning", "prune_detail", sessionId, undefined, "info", {
      markedCallIDs,
      replacedOutputs,
    });
  }
}
