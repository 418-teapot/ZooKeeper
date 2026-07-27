/**
 * Context pruning transform handler — the sweep phase entry point.
 *
 * Called from the `experimental.chat.messages.transform` hook.
 * Reads effective marks from `state.marks` (written by producers)
 * and replaces marked tool parts with placeholder text.
 *
 * @module
 */

import { formatTokens } from "../../core/context-report.js";
import type { ContextMessageEntry } from "../../core/metrics.js";
import {
  findCompactionBoundary,
  findLastCompletedAssistant,
} from "../../core/metrics.js";
import {
  assignMessageRefs,
  getLastCompactionBoundaryId,
  injectMessageRefs,
  resetMessageRefs,
  setLastCompactionBoundaryId,
  stripHallucinatedRefs,
} from "../../core/pruning/index.js";
import {
  getOrCreateSessionState,
  pendingTokens as pendingTokensDerived,
  reclaimedTokens as reclaimedTokensDerived,
  releaseBatch,
  saveSessionState,
} from "../../core/pruning/marks.js";
import type { DedupOptions } from "../../core/pruning/producers/dedup.js";
import { runDedup } from "../../core/pruning/producers/dedup.js";
import type { PurgeErrorsOptions } from "../../core/pruning/producers/purge-errors.js";
import { runPurgeErrors } from "../../core/pruning/producers/purge-errors.js";
import { pruneToolErrors, pruneToolOutputs } from "../../core/pruning/prune.js";
import { log } from "../../utils/logger.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Per-subsystem gate config for a pruning strategy (dedup / purge-errors).
 */
export interface ProducerGateConfig {
  /** Hook-level enable gate.  Undefined → runs unless explicitly false. */
  enabled?: boolean;
  /**
   * Minimum prompt-side total tokens (input + cache.read + cache.write)
   * before this producer runs.  Undefined → skip producer.
   */
  thresholdTokens?: number;
  /** Tool names excluded from this strategy.  Undefined → empty list (neutral). */
  protectedTools?: string[];
}

/**
 * Unified context-pruning configuration.
 *
 * Replaces the old flat `DedupOptions` used by the hook.  Each
 * producer (dedup, purge-errors) has its own gate sub-config;
 * `turnProtection` and `releaseThresholdPercent` remain shared.
 */
export interface ContextPruningConfig {
  /**
   * Master enable switch.  When not explicitly true the entire
   * transform no-ops: no Phase 1/2/2.5, no batch release, no
   * persistence.  Undefined → disabled.
   */
  enabled?: boolean;
  /**
   * Number of most recent assistant steps to protect (shared).
   * Undefined → skip all producers (they early-return).
   */
  turnProtection?: number;
  /**
   * Minimum percentage of prompt-side total that pending marks must
   * reach before batch release.  Undefined → skip release check.
   */
  releaseThresholdPercent?: number;
  /** Dedup producer gate & options. */
  dedup: ProducerGateConfig;
  /** Purge-errors producer gate & options. */
  purgeErrors: ProducerGateConfig;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * Handle the messages.transform hook for context pruning.
 *
 * Two-phase clean-then-mark:
 *
 * **Phase 1 (Clean):** prune previously-marked tool outputs (`tool-output`
 * action) and tool error inputs (`tool-error-input` action) from the last
 * turn.  Marks from previous rounds take effect now.
 *
 * **Phase 2 (Mark / Gate + Producer Loop):** evaluate each producer's
 * gate independently (enabled + prompt-side threshold).  Producers whose
 * gate passes create pending marks for the *next* turn.
 *
 * **Batch release:** after all producers run, if the accumulated pending
 * tokens reach `releaseThresholdPercent` of the prompt-side total, all
 * pending marks are flipped to effective at once.
 *
 * The two-turn effect ("turn N marks apply on turn N+1") means that
 * marks produced by the current turn are NOT pruned during the same turn.
 *
 * Does NOT catch errors — the caller (opencode.ts) wraps this in
 * try/catch so a pruning failure never disrupts the LLM turn.
 *
 * @param messages - The session messages array from the transform output.
 * @param config - Unified context-pruning configuration.
 * @param notify - Optional callback for user-visible release notification.
 * @param isSubAgent - When true, the first non-ignored user message in
 *   the session gets no message ref (positional semantics for
 *   sub-agent/task sessions — the first user message is skipped).
 */
export function contextPruningTransformHandler(
  messages: ContextMessageEntry[] | null | undefined,
  config: ContextPruningConfig = {
    dedup: {},
    purgeErrors: {},
  },
  notify?: (text: string) => void,
  isSubAgent?: boolean,
): void {
  if (!messages || messages.length === 0) return;

  // Master enable switch — entire transform no-ops unless
  // explicitly enabled (default false).
  if (config.enabled !== true) return;

  // Extract session ID from the first message.
  const firstMsg = messages[0];
  const sessionId = firstMsg?.info?.sessionID;
  if (!sessionId) return;

  // Get or create state — new session ID naturally creates fresh state.
  const state = getOrCreateSessionState(sessionId);

  // ── Phase 1: Clean — prune previously marked parts ─────────────
  // Marks from previous dedup / sweep / purge-errors rounds take
  // effect now.  Both output pruning and error-input pruning run
  // unconditionally — they only touch effective marks.
  const markedCallIDs: string[] = [...state.marks.entries()]
    .filter(([, mark]) => mark.effective)
    .map(([callID]) => callID);
  const replacedOutputs = pruneToolOutputs(state, messages);
  const replacedInputs = pruneToolErrors(state, messages);

  // ── Phase 2: Gate + Mark (table-driven) ────────────────────────
  // New marks will apply starting from the *next* turn.
  const lastAsst = findLastCompletedAssistant(messages);
  const promptTokens =
    (lastAsst.tokens?.input ?? 0) +
    (lastAsst.tokens?.cache?.read ?? 0) +
    (lastAsst.tokens?.cache?.write ?? 0);

  const producers: Array<{
    name: string;
    gate: ProducerGateConfig;
    run: () => { marks: { estimatedTokens: number }[] };
  }> = [
    {
      name: "dedup",
      gate: config.dedup ?? {},
      run: () => {
        const marks = runDedup(state, messages, {
          turnProtection: config.turnProtection,
          protectedTools: config.dedup?.protectedTools,
        } satisfies DedupOptions);
        return { marks };
      },
    },
    {
      name: "purge-errors",
      gate: config.purgeErrors ?? {},
      run: () => {
        const marks = runPurgeErrors(state, messages, {
          turnProtection: config.turnProtection,
          protectedTools: config.purgeErrors?.protectedTools,
        } satisfies PurgeErrorsOptions);
        return { marks };
      },
    },
  ];

  for (const producer of producers) {
    // Evaluate gate: enabled (default true) and prompt threshold.
    // undefined threshold → skip (no fallback).
    if (producer.gate.enabled === false) continue;
    const threshold = producer.gate.thresholdTokens;
    if (threshold === undefined) continue;
    if (lastAsst.index < 0 || promptTokens < threshold) continue;

    const { marks } = producer.run();

    if (marks.length > 0) {
      log(
        "context-pruning",
        `${producer.name}_marked`,
        sessionId,
        undefined,
        "info",
        {
          markedCount: marks.length,
          markedTokens: marks.reduce(
            (sum: number, m: { estimatedTokens: number }) =>
              sum + m.estimatedTokens,
            0,
          ),
        },
      );
    }
  }

  // ── Phase 3: Message refs (strip → compaction check → assign → inject) ──
  stripHallucinatedRefs(messages);

  // Detect compaction boundary changes so refs renumber from m0001 when
  // the session history is compacted.
  const boundaryIdx = findCompactionBoundary(messages);
  const currentBoundaryId =
    boundaryIdx >= 0 ? (messages[boundaryIdx]?.info?.id ?? null) : null;
  const prevBoundaryId = getLastCompactionBoundaryId(sessionId);
  let boundaryReset = false;
  if (currentBoundaryId !== prevBoundaryId) {
    resetMessageRefs(sessionId);
    setLastCompactionBoundaryId(sessionId, currentBoundaryId);
    boundaryReset = true;
  }

  const assigned = assignMessageRefs(sessionId, messages, isSubAgent);
  const injected = injectMessageRefs(sessionId, messages);

  if (assigned > 0 || boundaryReset) {
    log("context-pruning", "refs_assigned", sessionId, undefined, "info", {
      assigned,
      injected,
      boundaryReset,
    });
  }

  // ── Batch release check (unified) ──────────────────────────────
  // Release all pending marks into effective when the accumulated
  // token value reaches releaseThresholdPercent of prompt-side total.
  // Only evaluate when prompt data is available (promptTokens > 0)
  // and releaseThresholdPercent is configured (undefined → skip).
  if (promptTokens > 0 && config.releaseThresholdPercent !== undefined) {
    const curPendingTokens = pendingTokensDerived(state);
    if (curPendingTokens > 0) {
      const releasePct = config.releaseThresholdPercent;
      const batchThreshold = (promptTokens * releasePct) / 100;
      if (curPendingTokens >= batchThreshold) {
        const released = releaseBatch(state);
        log("context-pruning", "marks_released", sessionId, undefined, "info", {
          releasedCount: released.count,
          releasedTokens: released.tokens,
          byAction: released.byAction,
          pendingTokensBefore: curPendingTokens,
          promptTokens,
        });

        // Notify the session chat with a user-visible ignored message.
        // Fire-and-forget — the caller (opencode.ts) wraps this in
        // an async prompt that must never block the transform.
        if (released.count > 0 && notify) {
          const actionParts: string[] = [];
          for (const [action, info] of Object.entries(released.byAction)) {
            if (info.count > 0) {
              actionParts.push(`${action} ${info.count} 组`);
            }
          }
          notify(
            `上下文清理：已折叠 ${released.count} 个工具调用，约释放 ${formatTokens(released.tokens)} tokens（${actionParts.join("、")}）`,
          );
        }
      }
    }
  }

  // ── Persist to disk when dirty ──────────────────────────────
  if (state.dirty) {
    saveSessionState(sessionId, state);
    state.dirty = false;
  }

  // ── Log prune completion ──────────────────────────────────────
  const totalEff = reclaimedTokensDerived(state);
  log("context-pruning", "prune_completed", sessionId, undefined, "info", {
    prunedToolCount: markedCallIDs.length,
    totalPruneTokens: totalEff,
    totalReclaimedTokens: totalEff,
  });

  if (replacedOutputs.length > 0 || replacedInputs.length > 0) {
    log("context-pruning", "prune_detail", sessionId, undefined, "info", {
      markedCallIDs,
      replacedOutputs,
      replacedInputs,
    });
  }
}
