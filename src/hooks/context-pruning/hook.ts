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
import { getModelLimit } from "../../core/model-limits.js";
import {
  CONTEXT_NUDGE_LEVELS,
  CONTEXT_NUDGE_TEMPLATE,
} from "../../core/prompts.js";
import {
  activeBlockCount,
  assignMessageRefs,
  foldCompressedBlocks,
  getLastCompactionBoundaryId,
  injectMessageRefs,
  resetMessageRefs,
  setLastCompactionBoundaryId,
  snapshotRefs,
  stripHallucinatedRefs,
  stripRefsFromString,
  syncBlocks,
  ZOO_MSG_ID_CANONICAL_END_REGEX,
} from "../../core/pruning/index.js";
import {
  getOrCreateSessionState,
  pendingTokens as pendingTokensDerived,
  reclaimedTokens as reclaimedTokensDerived,
  releaseBatch,
  saveSessionState,
} from "../../core/pruning/marks.js";
import { getMessageRefById } from "../../core/pruning/message-refs.js";
import type { NudgeConfig } from "../../core/pruning/nudge.js";
import {
  computeEligibility,
  evaluateNudge,
  resolveThresholds,
} from "../../core/pruning/nudge.js";
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
  thresholdContext?: number;
  /** Tool names excluded from this strategy.  Undefined → empty list (neutral). */
  protectedTools?: string[];
}

/**
 * Per-subsystem gate config for the compression strategy.
 *
 * Strictly parsed: the section is absent (`undefined`) unless all three
 * keys are present and valid.  `enabled` is the hook-level gate —
 * `false` is parsed but disabled (no tool registration, no nudge).
 * The token thresholds are defined whenever the section is returned.
 */
export interface CompressConfig {
  /** Hook-level enable gate.  `false` → parsed but disabled. */
  enabled?: boolean;
  /**
   * Minimum estimated tokens a segment must have to bypass the phantom
   * gate.  Present whenever the section is returned.
   */
  thresholdTokens?: number;
  /**
   * Token budget to protect from the end of the session (CJK heuristic).
   * Present whenever the section is returned.
   */
  protectedTokens?: number;
}

/**
 * Context-nudge subsystem configuration (`[zoo.context.nudge]`).
 *
 * Extends the pure decision-layer `NudgeConfig` with a hook-level
 * enable gate.  When the section is absent the field is `undefined`
 * and the subsystem is silently absent; when present all six keys are
 * required — any missing, wrong-typed, or malformed value invalidates
 * the whole section (no fallbacks; the config parse already warned).
 */
export interface ContextNudgeConfig extends NudgeConfig {
  /** Hook-level enable gate.  `false` → parsed but disabled (no injection). */
  enabled?: boolean;
}

/**
 * Per-subsystem gate config for the decompression strategy.
 *
 * Strictly parsed: the section is absent (`undefined`) unless both
 * keys are present and valid.  `enabled` is the hook-level gate —
 * `false` is parsed but disabled (no tool registration).
 * `rejectPercent` is defined whenever the section is returned.
 */
export interface DecompressConfig {
  /** Hook-level enable gate.  `false` → parsed but disabled. */
  enabled?: boolean;
  /**
   * Rejection threshold (percent): restore of an active compression
   * block is rejected when the estimated post-restore tokens exceed
   * context_limit × rejectPercent / 100.  Present whenever the
   * section is returned.
   */
  rejectPercent?: number;
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
   * transform no-ops: the entire pipeline (Phases 1–7) is skipped.  Undefined → disabled.
   */
  enabled?: boolean;
  /**
   * Number of most recent non-ignored messages to protect (shared).
   * Undefined → skip all producers (they early-return).
   */
  protectedMessages?: number;
  /**
   * Minimum percentage of prompt-side total that pending marks must
   * reach before batch release.  Undefined → skip release check.
   */
  releasedPercent?: number;
  /**
   * Context-nudge subsystem config (`[zoo.context.nudge]`).  Undefined
   * → the subsystem is silently absent (no reminders injected).
   */
  nudge?: ContextNudgeConfig;
  /** Dedup producer gate & options. */
  dedup: ProducerGateConfig;
  /** Purge-errors producer gate & options. */
  purgeErrors: ProducerGateConfig;
  /**
   * Compress strategy gate & options (`[zoo.context.compress]`).
   * Undefined → the subsystem is silently absent (no tool, no nudge).
   */
  compress?: CompressConfig;
  /**
   * Decompress strategy gate & options (`[zoo.context.decompress]`).
   * Undefined → the subsystem is silently absent (no tool).
   */
  decompress?: DecompressConfig;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * Handle the messages.transform hook for context pruning.
 *
 * Seven-phase transform pipeline:
 *
 * **Phase 1 (Fold):** sync and fold compression blocks so downstream
 * phases see a folded view.
 *
 * **Phase 2 (Clean):** prune previously-marked tool outputs (`tool-output`
 * action) and tool error inputs (`tool-error-input` action) from the last
 * turn.  Marks from previous rounds take effect now.
 *
 * **Phase 3 (Gate + Mark):** evaluate each producer's gate independently
 * (enabled + prompt-side threshold).  Producers whose gate passes create
 * pending marks for the *next* turn.
 *
 * **Phase 4 (Message refs):** strip hallucinated refs, detect compaction
 * boundary changes, assign and inject message references.
 *
 * **Phase 5 (Batch release):** after all producers run, if the accumulated
 * pending tokens reach `releaseThresholdPercent` of the prompt-side total,
 * all pending marks are flipped to effective at once.
 *
 * **Phase 6 (Nudge):** inject a context-pressure reminder when the prompt
 * is past the configured thresholds and has grown past the re-nudge
 * interval since the last anchor (`state.nudges`, persisted via the
 * normal dirty flag).  The synthetic message is transform-only — never
 * persisted, never ref-assigned (Phase 6 runs after Phase 4).
 *
 * **Phase 7 (Finalize):** clear the view-change flag and persist state to
 * disk when dirty.
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

  // ── Phase 1: Sync and fold compression blocks ──────────────
  // Runs before Phase 2 so downstream phases see the folded view
  // (compressed segments removed, synthetic summary injected).  The
  // two-step sequence ensures syncBlocks always evaluates on the raw
  // (pre-fold) message list so anchor-missing detection is accurate.
  if (state.blocks.size > 0) {
    const activeBefore = activeBlockCount(state);
    syncBlocks(state, messages);
    const activeAfter = activeBlockCount(state);
    if (activeBefore > activeAfter) {
      log(
        "context-pruning",
        "compress_deactivated",
        sessionId,
        undefined,
        "info",
        { deactivatedCount: activeBefore - activeAfter },
      );
      // Deactivation changes the folded view (prefix changes, cache
      // breaks), so pending prune marks should flush immediately
      // without waiting for the released_percent threshold.
      state.pendingViewChange = true;
    }
    foldCompressedBlocks(state, messages);
  }

  // ── Phase 2: Clean — prune previously marked parts ─────────────
  // Marks from previous dedup / sweep / purge-errors rounds take
  // effect now.  Both output pruning and error-input pruning run
  // unconditionally — they only touch effective marks.
  const markedCallIDs: string[] = [...state.marks.entries()]
    .filter(([, mark]) => mark.effective)
    .map(([callID]) => callID);
  const replacedOutputs = pruneToolOutputs(state, messages);
  const replacedInputs = pruneToolErrors(state, messages);

  // ── Phase 3: Gate + Mark (table-driven) ────────────────────────
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
          turnProtection: config.protectedMessages,
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
          turnProtection: config.protectedMessages,
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
    const threshold = producer.gate.thresholdContext;
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

  // ── Phase 4: Message refs (strip → compaction check → assign → inject) ──

  // Detect non-canonical (fuzzy) tag stripping by comparing
  // each text/tool-output string before vs after stripHallucinatedRefs.
  // Only warn when something was stripped that was NOT the exact canonical
  // trailing tag.  At most one warn per call.
  if (sessionId) {
    const saved: string[] = [];
    for (const msg of messages) {
      if (!msg.parts) continue;
      for (const part of msg.parts) {
        const p = part as unknown as Record<string, unknown>;
        if (part?.type === "text" && typeof p.text === "string") {
          saved.push(p.text);
        }
        if (part?.type === "tool") {
          const state = p.state as Record<string, unknown> | undefined;
          if (state && typeof state.output === "string") {
            saved.push(state.output);
          }
        }
      }
    }

    stripHallucinatedRefs(messages);

    for (const original of saved) {
      if (
        stripRefsFromString(original) !== original &&
        !ZOO_MSG_ID_CANONICAL_END_REGEX.test(original)
      ) {
        log(
          "context-pruning",
          "fuzzy_ref_stripped",
          sessionId,
          undefined,
          "warn",
          { fragment: original.slice(-200) },
        );
        break;
      }
    }
  } else {
    stripHallucinatedRefs(messages);
  }

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

  // ── Phase 5: Batch release (unified) ───────────────────────────
  // Release all pending marks into effective when the accumulated
  // token value reaches releaseThresholdPercent of prompt-side total.
  // When pendingViewChange is set, bypass the threshold gate and
  // flush immediately (the view is changing anyway — cache is
  // already broken from the fold / deactivation / new block).
  // Simplified from: (promptTokens>0 || pendingViewChange) &&
  //   (releasedPercent!==undefined || pendingViewChange) =>
  //   pendingViewChange || (promptTokens>0 && releasedPercent!==undefined)
  if (
    state.pendingViewChange ||
    (promptTokens > 0 && config.releasedPercent !== undefined)
  ) {
    const curPendingTokens = pendingTokensDerived(state);
    if (curPendingTokens > 0) {
      const releasePct = config.releasedPercent;
      const batchThreshold =
        releasePct !== undefined ? (promptTokens * releasePct) / 100 : 0;
      if (state.pendingViewChange || curPendingTokens >= batchThreshold) {
        const released = releaseBatch(state);
        const forcedReason = state.pendingViewChange
          ? "view_change"
          : undefined;
        log("context-pruning", "marks_released", sessionId, undefined, "info", {
          releasedCount: released.count,
          releasedTokens: released.tokens,
          byAction: released.byAction,
          pendingTokensBefore: curPendingTokens,
          promptTokens,
          ...(forcedReason ? { forced: forcedReason } : {}),
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
            `上下文清理：已折叠 ${released.count} 个工具调用，约回收 ${formatTokens(released.tokens)} tokens（${actionParts.join("、")}）`,
          );
        }
      }
    }
  }

  // ── Phase 6: Nudge — context-pressure reminders ────────────────
  // Injects a synthetic reminder when the prompt is past the configured
  // thresholds AND has grown past the re-nudge interval since the last
  // anchor.  Runs only when every gate holds: not a sub-agent session,
  // the compress tool available (strictly-parsed compress section with
  // `enabled: true` — the nudge advertises compressible windows the tool
  // would accept), nudge config present with `enabled: true` (the
  // strict parser guarantees a boolean here), a model context limit
  // captured for this session, and a completed assistant message
  // (promptTokens is real — same-view discipline as Phase 3).
  const compressCfg = config.compress;
  const nudgeConfig = config.nudge;
  if (
    !isSubAgent &&
    compressCfg?.enabled === true &&
    nudgeConfig?.enabled === true &&
    lastAsst.index >= 0
  ) {
    const modelLimit = getModelLimit(sessionId);
    if (modelLimit) {
      // Null thresholds → subsystem disabled (the config parse already
      // warned once) — skip evaluation silently.
      const thresholds = resolveThresholds(nudgeConfig, modelLimit.context);
      if (thresholds) {
        const evaluation = evaluateNudge(
          state.nudges?.lastNudgeTokens,
          promptTokens,
          thresholds,
        );

        // Persist the anchor on EVERY evaluation (the ratchet follows
        // context downward between triggers); mark dirty only when the
        // value actually changed.
        const prevAnchor = state.nudges?.lastNudgeTokens;
        state.nudges = {
          ...(state.nudges ?? {}),
          lastNudgeTokens: evaluation.newAnchor,
        };
        if (prevAnchor !== evaluation.newAnchor) {
          state.dirty = true;
        }

        if (evaluation.level !== null) {
          // `protectedMessages` is a lenient top-level key and the token
          // thresholds exist only when the compress section was strictly
          // parsed — any of them missing means there is no compressible
          // window to advertise; treat eligibility as null (no injection,
          // the anchor is still persisted above).
          const eligibility =
            config.protectedMessages === undefined ||
            compressCfg.protectedTokens === undefined ||
            compressCfg.thresholdTokens === undefined
              ? null
              : computeEligibility(
                  messages,
                  {
                    protectedMessages: config.protectedMessages,
                    protectedTokens: compressCfg.protectedTokens,
                    thresholdTokens: compressCfg.thresholdTokens,
                  },
                  (messageId) => getMessageRefById(sessionId, messageId),
                );
          // No eligible window (all protected / no refs / phantom) → skip
          // injection; the anchor is already persisted above.
          if (eligibility) {
            const copy = CONTEXT_NUDGE_LEVELS[evaluation.level];
            const percent = Math.round(
              (promptTokens / modelLimit.context) * 100,
            );
            // replaceAll: {endRef} appears twice in the template.
            const text = CONTEXT_NUDGE_TEMPLATE.replaceAll(
              "{HEADER}",
              copy.header,
            )
              .replaceAll("{tokens}", String(promptTokens))
              .replaceAll("{percent}", `${percent}%`)
              .replaceAll("{limit}", String(modelLimit.context))
              .replaceAll("{startRef}", eligibility.startRef)
              .replaceAll("{endRef}", eligibility.endRef)
              .replaceAll("{reclaim}", String(eligibility.reclaimTokens))
              .replaceAll("{ACTION}", copy.action)
              .replaceAll("{EQUATION}", copy.equation);

            // Transform-only synthetic message: appended at the END after
            // Phase 4 (so it never enters ref assignment) and never
            // persisted (no session.prompt call — invisible in storage).
            messages.push({
              info: {
                id: "zoo-nudge",
                role: "user",
                sessionID: sessionId,
              },
              parts: [{ type: "text", text }],
            });

            log(
              "context-pruning",
              "nudge_injected",
              sessionId,
              undefined,
              "info",
              {
                // `nudgeLevel` instead of `level` — the logger reserves
                // `level` for the entry's log level.
                nudgeLevel: evaluation.level,
                tokens: promptTokens,
                anchor: evaluation.newAnchor,
                startRef: eligibility.startRef,
                endRef: eligibility.endRef,
                reclaimTokens: eligibility.reclaimTokens,
              },
            );
          }
        }
      }
    }
  }

  // ── Phase 7: Finalize — clear view-change flag + persist ────────
  // Always cleared after the release check phase, regardless of
  // whether any marks were flushed.
  state.pendingViewChange = false;

  if (state.dirty) {
    // Refresh the ref snapshot (piggyback — never per-turn writes) so
    // the persist keeps refs stable across a restart.  Phase 4 above
    // always leaves a runtime registry when the session has refs.
    const refsSnapshot = snapshotRefs(sessionId);
    if (refsSnapshot) state.refs = refsSnapshot;
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
