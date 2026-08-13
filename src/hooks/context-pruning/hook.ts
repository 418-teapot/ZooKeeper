/**
 * Context pruning transform handler — the sweep phase entry point.
 *
 * Called from the `experimental.chat.messages.transform` hook.
 * Reads effective marks from `state.marks` (written by producers)
 * and replaces marked tool parts with placeholder text.
 *
 * @module
 */

import type {
  ContextPruningConfig,
  ProducerGateConfig,
} from "../../core/config-types.js";
import { formatTokens } from "../../core/context/context-report.js";
import type {
  ContextMessageEntry,
  ContextMetricsOutput,
} from "../../core/context/metrics.js";
import {
  findCompactionBoundary,
  findLastCompletedAssistant,
} from "../../core/context/metrics.js";
import { getModelLimit } from "../../core/context/model-limits.js";
import {
  activeBlockCount,
  assignMessageRefs,
  computeEligibility,
  type DedupOptions,
  evaluateNudge,
  foldCompressedBlocks,
  getLastCompactionBoundaryId,
  getMessageRefById,
  getOrCreateSessionState,
  injectMessageRefs,
  type PurgeErrorsOptions,
  pendingTokens as pendingTokensDerived,
  pruneToolErrors,
  pruneToolOutputs,
  reclaimedTokens as reclaimedTokensDerived,
  releaseBatch,
  resetMessageRefs,
  resolveThresholds,
  runDedup,
  runPurgeErrors,
  saveSessionState,
  setLastCompactionBoundaryId,
  snapshotRefs,
  stripHallucinatedRefs,
  stripRefsFromString,
  syncBlocks,
  ZOO_MSG_ID_CANONICAL_END_REGEX,
} from "../../core/context/pruning/index.js";
import {
  CONTEXT_NUDGE_LEVELS,
  CONTEXT_NUDGE_TEMPLATE,
  MANUAL_COMPRESS_TEMPLATE,
} from "../../core/prompts.js";
import { sessionAgentMap } from "../../core/session-state.js";
import { log } from "../../utils/logger.js";

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
 * (prompt-side threshold).  Producers whose gate passes create pending
 * marks for the *next* turn.
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
 * **Phase 6b (Manual compress trigger):** when `/dcp compress` armed the
 * one-shot `pendingManualTrigger` flag, append a synthetic user message
 * (`zoo-manual-compress`) driving the model to call the `compress` tool.
 * Transform-only (never persisted, never ref-assigned), and the flag is
 * cleared after injection.
 *
 * **Phase 7 (Finalize):** clear the view-change flag and persist state to
 * disk when dirty.
 *
 * The two-turn effect ("turn N marks apply on turn N+1") means that
 * marks produced by the current turn are NOT pruned during the same turn.
 *
 * Enablement is decided by the caller (opencode.ts) from the mode
 * profile: registering this hook unit runs the whole pipeline (Phases
 * 1–7) with no master switch, and `hasCompressTool` gates the nudge and
 * manual-compress phases (they advertise windows the registered
 * `compress` tool would accept).
 *
 * Does NOT catch errors — the caller (opencode.ts) wraps this in
 * try/catch so a pruning failure never disrupts the LLM turn.
 *
 * @param messages - The session messages array from the transform output.
 * @param config - Unified context-pruning configuration.
 * @param notify - Optional callback for user-visible release notification.
 * @param hasCompressTool - Whether the `compress` tool is registered in
 *   the active mode profile.  Gates the nudge (Phase 6) and manual
 *   compress (Phase 6b) phases.  Defaults to false.
 */
export function contextPruningTransformHandler(
  messages: ContextMessageEntry[] | null | undefined,
  config: ContextPruningConfig = {
    dedup: {},
    purgeErrors: {},
  },
  notify?: (text: string) => void,
  hasCompressTool?: boolean,
): void {
  if (!messages || messages.length === 0) return;

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
    // Evaluate gate: prompt threshold only (enablement comes from the
    // mode profile, not per-producer switches).
    // undefined threshold → skip (no fallback).
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

  const assigned = assignMessageRefs(sessionId, messages, config.anchorTokens);
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
  // anchor.  Runs only when every gate holds: the compress tool
  // registered in the active mode profile (the nudge advertises
  // compressible windows the tool would accept), a strictly-parsed
  // nudge section present (the strict parser guarantees a valid
  // threshold set here), a model context limit captured for this
  // session, and a completed assistant message (promptTokens is real —
  // same-view discipline as Phase 3).
  const compressCfg = config.compress;
  const nudgeConfig = config.nudge;
  if (hasCompressTool && nudgeConfig !== undefined && lastAsst.index >= 0) {
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
            compressCfg?.protectedTokens === undefined ||
            compressCfg?.thresholdTokens === undefined
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
              .replaceAll("{TEACHING}", copy.teaching)
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

  // ── Phase 6b: Manual compress trigger — synthetic user command ───
  // `/dcp compress` sets a one-shot in-memory flag; the NEXT transform
  // appends a synthetic user message (id `zoo-manual-compress`) that the
  // model treats as a direct instruction to call the `compress` tool.
  // Runs after Phase 4 so the message never enters ref assignment, and
  // never calls session.prompt (transform-only, invisible in storage).
  // The flag is cleared after the phase — one-shot, never re-injected
  // on later turns.
  const manualCfg = config.compress;
  if (state.pendingManualTrigger) {
    if (
      hasCompressTool &&
      manualCfg?.protectedTokens !== undefined &&
      manualCfg?.thresholdTokens !== undefined
    ) {
      const eligibility =
        config.protectedMessages === undefined
          ? null
          : computeEligibility(
              messages,
              {
                protectedMessages: config.protectedMessages,
                protectedTokens: manualCfg.protectedTokens,
                thresholdTokens: manualCfg.thresholdTokens,
              },
              (messageId) => getMessageRefById(sessionId, messageId),
            );
      const windowLine = eligibility
        ? `可压缩窗口：${eligibility.startRef}–${eligibility.endRef}（约 ${eligibility.reclaimTokens} tokens，两端 ref 均为包含边界）。你可以在此窗口内选择连续子范围；compress 的 toRef 为排他边界——传入某条消息之后的 ref 才会包含该消息。`
        : "未检测到明确的可压缩窗口（全部内容均在保护区内）。如你判断仍有已完成且无需逐字保留的历史，请自行选择合适的范围压缩。";
      const text = MANUAL_COMPRESS_TEMPLATE.replace("{WINDOW}", windowLine);

      // Synthetic user command appended at the very END — never
      // persisted, never ref-assigned.
      messages.push({
        info: {
          id: "zoo-manual-compress",
          role: "user",
          sessionID: sessionId,
        },
        parts: [{ type: "text", text }],
      });
      state.pendingManualTrigger = false;

      log(
        "context-pruning",
        "manual_compress_injected",
        sessionId,
        undefined,
        "info",
        {
          ...(eligibility
            ? {
                startRef: eligibility.startRef,
                endRef: eligibility.endRef,
                reclaimTokens: eligibility.reclaimTokens,
              }
            : { eligibility: null }),
        },
      );
    } else {
      // Compress tool / section unavailable — a stale trigger can never
      // produce a meaningful command.  Clear the flag so it never fires
      // later (the /dcp compress registration gate normally prevents
      // this state).
      state.pendingManualTrigger = false;
      log(
        "context-pruning",
        "manual_compress_skipped",
        sessionId,
        undefined,
        "warn",
        { reason: "compress tool not registered or thresholds missing" },
      );
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

// ---------------------------------------------------------------------------
// Transform wrapper (sunk from the host entry point)
// ---------------------------------------------------------------------------

/**
 * Resolve the current agent for a session.
 *
 * Resolution order:
 *   (a) `agentMap` (in-memory map populated solely by the message.updated
 *       handler — single source of truth)
 *   (b) `client.session.get()` API call — per-call fallback WITHOUT
 *       write-back to the map, so a mid-session agent change is reflected
 *       as soon as either the next message.updated or the next resolution
 *       happens.
 *   (c) `undefined` — current behavior preserved, debug log entry
 *
 * @param sessionID - The session identifier.
 * @param client - The host client (session.get availability checked).
 * @param agentMap - The in-memory session → agent map.
 * @returns The resolved agent name, or `undefined` when unknown.
 */
export async function resolveSessionAgent(
  sessionID: string,
  client: any,
  agentMap: Map<string, string>,
): Promise<string | undefined> {
  // (a) Check in-memory map first (fast, no I/O).
  const mapped = agentMap.get(sessionID);
  if (mapped) return mapped;

  // (b) Fallback to session API — read the agent from the session object.
  if (client?.session?.get) {
    try {
      const sessionInfo = await client.session.get({
        path: { id: sessionID },
      });
      if (sessionInfo?.agent) {
        return sessionInfo.agent;
      }
    } catch {
      // Session not found — fall through to (c).
    }
  }

  // (c) Unknown — log debug entry and return undefined.
  log(
    "context-pruning",
    "dedup_notify_no_agent",
    sessionID,
    undefined,
    "debug",
    {},
  );
  return undefined;
}

/**
 * Fire-and-forget notification for dedup batch release.
 *
 * Sends a silent (noReply + ignored) message to the session chat when the
 * agent is known; suppresses the notification entirely when the agent
 * cannot be resolved, logging the drop at warn level.
 *
 * @param sessionID - The session identifier.
 * @param client - The host client (session.prompt availability checked).
 * @param agentMap - The in-memory session → agent map.
 * @param text - The notification text.
 */
export function handleDedupNotify(
  sessionID: string,
  client: any,
  agentMap: Map<string, string>,
  text: string,
): void {
  const body: Record<string, unknown> = {
    noReply: true,
    parts: [{ type: "text", text, ignored: true }],
  };

  const send = () => {
    try {
      client?.session
        ?.prompt({
          path: { id: sessionID },
          body,
        })
        .catch((err: Error) => {
          log(
            "context-pruning",
            "dedup_notify_failed",
            sessionID,
            undefined,
            "warn",
            { error: String(err) },
          );
        });
    } catch (err) {
      log(
        "context-pruning",
        "dedup_notify_failed",
        sessionID,
        undefined,
        "warn",
        { error: String(err) },
      );
    }
  };

  // (a) Agent known from in-memory map — send immediately.
  const agent = agentMap.get(sessionID);
  if (agent) {
    body.agent = agent;
    send();
    return;
  }

  // (b)/(c) Agent not in map — try async fallback.
  resolveSessionAgent(sessionID, client, agentMap)
    .then((resolvedAgent) => {
      if (resolvedAgent) {
        body.agent = resolvedAgent;
        send();
        return;
      }
      // (c) Agent unresolved — suppress notification.
      log(
        "context-pruning",
        "dedup_notify_suppressed",
        sessionID,
        undefined,
        "warn",
        { reason: "agent unresolved" },
      );
    })
    .catch((err) => {
      log(
        "context-pruning",
        "dedup_notify_suppressed",
        sessionID,
        undefined,
        "warn",
        { reason: "agent unresolved", error: String(err) },
      );
    });
}

/**
 * Run context pruning on the messages transform output.
 *
 * Wraps `contextPruningTransformHandler` in try/catch so a pruning
 * failure never disrupts the LLM turn, and wires the dedup-release
 * notification to the shared `sessionAgentMap` (held by
 * `core/session-state.ts`).
 *
 * @param output - The messages transform output.
 * @param config - Unified context-pruning configuration.
 * @param client - The host client.
 * @param hasCompressTool - Whether the `compress` tool is registered.
 */
export function handleContextPruning(
  output: ContextMetricsOutput,
  config: ContextPruningConfig,
  client: any,
  hasCompressTool?: boolean,
): void {
  try {
    const sessionID = output.messages?.[0]?.info?.sessionID ?? "";

    contextPruningTransformHandler(
      output.messages,
      config,
      // Fire-and-forget: notify the session chat with dedup release info.
      // Must NOT await — the transform hook must never block.
      (text: string) =>
        handleDedupNotify(sessionID, client, sessionAgentMap, text),
      hasCompressTool,
    );
  } catch (err) {
    log(
      "plugin",
      "handler_crashed",
      output.messages?.[0]?.info?.sessionID ?? "",
      undefined,
      "error",
      { handler: "contextPruning", error: String(err) },
    );
  }
}
