/**
 * Context pruning transform handler — the new-core pipeline entry point.
 *
 * Called from the messages-transform hook.  The legacy seven-phase
 * pipeline is replaced by the host-agnostic context core
 * (`src/core/context/`) driven through an injected `HostAdapter`:
 *
 * 1. **State** — the process-wide shared `SessionStateManager`
 *    (`getContextStateManager`) yields the session state (shared with
 *    the compress/decompress tools and the /dcp command — never a
 *    private manager).
 * 2. **Read** — `adapter.history()` maps the host messages to lens
 *    messages; the prompt-side token total of the last completed
 *    assistant is extracted for the release gate.
 * 3. **Release** — `computeEdits` selects the round's region edits
 *    (effective marks plus pending marks passing the `releasedPercent`
 *    gate or the `pendingViewChange` bypass), `adapter.applyEdits`
 *    writes them through the adapter lens, and `flipReleasedMarks`
 *    flips the released marks effective.  Runs FIRST so marks written
 *    last turn take effect this turn (the two-turn lifecycle).  The
 *    notify callback and the `marks_released` log fire on a flip.
 * 4. **Producers** — dedup / purge-errors run only when their
 *    configured `thresholdContext` is defined (legacy gating); sweep
 *    always runs with the new core's defaults.  Marks are pending for
 *    the next turn's release.
 * 5. **Fold** — `fold` computes the folded view; expired (hash-
 *    invalidated) blocks are deactivated, inactive blocks reclaimed
 *    (`clearInactiveBlocks`), and a view change arms the per-session
 *    `pendingViewChange` flag that forces the next release.
 * 6. **Materialize** — `adapter.renderView` rebuilds the host messages in
 *    place (synthetic summary messages, per-round `[mN] ` line refs).
 * 7. **Nudge / manual compress** — `evaluateNudge` decides and renders
 *    the context-pressure reminder (transform-only synthetic message
 *    appended at the END via `adapter.appendUserMessage`, never
 *    ref-assigned); the `/dcp compress` one-shot
 *    `pendingManualTrigger` flag injects the synthetic user command
 *    driving the `compress` tool.
 * 8. **Save** — the session state is written back to the shared store.
 *
 * The two-turn effect ("turn N marks apply on turn N+1") means that
 * marks produced by the current turn are NOT pruned during the same
 * turn.
 *
 * Enablement is decided by the caller (opencode.ts / pi.ts) from the
 * mode profile and by the unit's `create`: when `deps.adapter` is
 * undefined the unit contributes no transform handler (fail-closed).
 * `hasCompressTool` gates the nudge and manual-compress phases (they
 * advertise windows the registered `compress` tool would accept).
 *
 * Does NOT catch errors — the caller (`handleContextPruning`) wraps
 * this in try/catch so a pruning failure never disrupts the LLM turn.
 *
 * @module
 */

import type { ToolHost } from "../../core/client/tool-host.js";
import type { ContextPruningConfig } from "../../core/config-types.js";
import { computeProtectedStartOrdinal } from "../../core/context/compress.js";
import { formatTokens } from "../../core/context/context-report.js";
import { fold } from "../../core/context/fold.js";
import type { HostAdapter, HostMessage } from "../../core/context/lens.js";
import { findLastCompletedAssistant } from "../../core/context/measure.js";
import { getModelLimit } from "../../core/context/model-limits.js";
import {
  computeEligibility,
  evaluateNudge,
  resolveThresholds,
} from "../../core/context/nudge.js";
import { runDedup } from "../../core/context/producers/dedup.js";
import { runPurgeErrors } from "../../core/context/producers/purge-errors.js";
import { runSweep } from "../../core/context/producers/sweep.js";
import {
  computeEdits,
  flipReleasedMarks,
  pendingTokens,
  type ReleaseOptions,
  reclaimedTokens,
} from "../../core/context/release.js";
import {
  consumePendingViewChange,
  getContextStateManager,
  getRuntimeFlaggedState,
} from "../../core/context/runtime.js";
import { validateBlock } from "../../core/context/spanhash.js";
import {
  clearInactiveBlocks,
  type SessionState,
} from "../../core/context/state.js";
import { numberView } from "../../core/context/view-refs.js";
import { MANUAL_COMPRESS_TEMPLATE } from "../../core/prompts.js";
import type { TransformOutput } from "../../core/slots.js";
import { log } from "../../utils/logger.js";

// ---------------------------------------------------------------------------
// Module-level view-change flags
// ---------------------------------------------------------------------------

/**
 * Per-session `pendingViewChange` flags owned by this module.
 *
 * `fold` reports a view change (`viewChanged`) when a block did not
 * participate in the fold (deactivation or span-hash expiry); the flag
 * is armed here and consumed by the NEXT turn's release phase, which
 * clears it.  Never persisted — loss on restart is benign.
 */
const viewChangeFlags = new Map<string, boolean>();

/** Test affordance: drop the module-level view-change flags. */
export function _resetViewChangeFlagsForTesting(): void {
  viewChangeFlags.clear();
}

// ---------------------------------------------------------------------------
// Pipeline helpers
// ---------------------------------------------------------------------------

/**
 * Compute the prompt-side token total of the last completed assistant.
 *
 * Mirrors the legacy hook's extraction: `input + cacheRead +
 * cacheWrite`, output and reasoning excluded.
 *
 * @param view - The lens transcript.
 * @returns The prompt-side total, or 0 without a completed assistant.
 */
function promptSideTokens(view: HostMessage[]): number {
  const { index } = findLastCompletedAssistant(view);
  if (index < 0) return 0;
  const usage = view[index]?.usage;
  return (
    (usage?.input ?? 0) + (usage?.cacheRead ?? 0) + (usage?.cacheWrite ?? 0)
  );
}

/**
 * Convert a legacy absolute prompt-side threshold into the new-core
 * producers' model-context fraction.
 *
 * The legacy hook gated producers on `promptTokens >= absolute`; the new
 * producers gate on `measured.total >= contextLimit × fraction`, so the
 * fraction `absolute / contextLimit` preserves the configured value.
 *
 * @param absolute - The configured absolute threshold.
 * @param contextLimit - The model context window.
 * @returns The fraction, or undefined when it cannot be evaluated.
 */
function fractionOf(
  absolute: number,
  contextLimit: number | undefined,
): number | undefined {
  if (contextLimit === undefined || contextLimit <= 0) return undefined;
  return absolute / contextLimit;
}

/**
 * Collect the ordinals covered by active, hash-valid blocks.
 *
 * The producers' `prunedOrdinals` predicate — messages folded into a
 * block are never marked.  Validated the same way fold decides
 * survival, so the predicate and the fold never disagree.
 *
 * @param state - The session state.
 * @param view - The lens transcript.
 * @returns The covered ordinals.
 */
function coveredOrdinalsOf(
  state: SessionState,
  view: HostMessage[],
): Set<number> {
  const covered = new Set<number>();
  for (const block of state.blocks.values()) {
    if (!block.active || !validateBlock(view, block)) continue;
    for (let ordinal = block.start; ordinal < block.end; ordinal++) {
      covered.add(ordinal);
    }
  }
  return covered;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * Run the context-pruning pipeline over the turn's transcript.
 *
 * Runs the host-agnostic context core over the turn's transcript (see
 * the module docstring for the phase order).  All host-specific
 * operations go through `adapter`; `messages` is treated as an opaque
 * conversation.  `notify` fires exactly once per batch release with a
 * user-visible cleanup notice; the log surface preserves the legacy
 * event contracts (`prune_completed` counts effective marks only,
 * `marks_released` carries the forced field, `nudge_injected` /
 * `manual_compress_injected` carry their payloads).
 *
 * The returned conversation may be the input array mutated in place or a
 * replacement array produced by a pure adapter.  Callers must always use
 * the returned value and must not rely on in-place mutation.
 *
 * @param adapter - The host adapter that projects and renders the host
 *   conversation.
 * @param messages - The session messages array from the transform output.
 * @param config - Unified context-pruning configuration.
 * @param notify - Optional callback for user-visible release notification.
 * @param hasCompressTool - Whether the `compress` tool is registered in
 *   the active mode profile.  Gates the nudge and manual-compress
 *   phases.  Defaults to false.
 * @returns The conversation after pruning.
 */
export function contextPruningTransformHandler(
  adapter: HostAdapter<unknown>,
  messages: unknown,
  config: ContextPruningConfig = {
    dedup: {},
    purgeErrors: {},
  },
  notify?: (text: string) => void,
  hasCompressTool?: boolean,
): unknown {
  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    return messages;
  }

  // Extract session ID from the first message through the adapter.
  const sessionId = adapter.sessionId(messages);
  if (!sessionId) return messages;

  // ── Phase 1: state + read ─────────────────────────────────────────
  // The process-wide shared manager (hook/tool/dcp single instance).
  const manager = getContextStateManager();
  const state = getRuntimeFlaggedState(sessionId);
  let view = adapter.history(messages);
  const promptTokens = promptSideTokens(view);

  // ── Phase 2: release — start of turn ──────────────────────────────
  // Effective marks from earlier turns write their placeholders again
  // (the host reloads the transcript fresh each turn); pending marks
  // flip when the releasedPercent gate opens or the pendingViewChange
  // bypass is armed (fold view change, compress / decompress tool call
  // or block deactivation last turn).  The flag is consumed and
  // cleared here, mirroring the legacy Phase 5/7 hand-off.  The bypass
  // arrives through the module-level maps only — the fold view-change
  // flag local to this module and the runtime map armed by the tools
  // (`setPendingViewChange`) — never through a state-object field.
  const releaseFlag = viewChangeFlags.get(sessionId) ?? false;
  const toolFlag = consumePendingViewChange(sessionId);
  const curPendingTokens = pendingTokens(state);
  const releaseOptions: ReleaseOptions = {
    promptTokens,
    releasedPercent: config.releasedPercent,
    pendingViewChange: releaseFlag || toolFlag,
  };
  // The release edits are applied through the adapter lens NOW, before
  // the producers and the nudge eligibility scan — those read region
  // text (context gates, placeholder-prefixed skip, reclaim estimates)
  // and must observe the placeholder text.
  const releaseEdits = computeEdits(state, view, releaseOptions);
  messages = adapter.applyEdits(messages, releaseEdits);
  view = adapter.history(messages);
  const released = flipReleasedMarks(state, releaseOptions);
  viewChangeFlags.delete(sessionId);

  if (released.releasedCount > 0) {
    log("context-pruning", "marks_released", sessionId, undefined, "info", {
      releasedCount: released.releasedCount,
      releasedTokens: released.releasedTokens,
      pendingTokensBefore: curPendingTokens,
      promptTokens,
      ...(released.forced ? { forced: "view_change" } : {}),
    });

    // Notify the session chat with a user-visible ignored message.
    // Fire-and-forget — the caller (opencode.ts) wraps this in
    // an async prompt that must never block the transform.
    if (notify) {
      notify(
        `上下文清理：已折叠 ${released.releasedCount} 个工具调用，约回收 ${formatTokens(released.releasedTokens)} tokens`,
      );
    }
  }

  // ── Phase 3: producers (dedup / purge-errors / sweep) ─────────────
  // Table-driven gating mirrors the legacy hook: a producer whose
  // prompt-side threshold is not configured is skipped; configured
  // thresholds are converted to context-limit fractions.  Sweep has no
  // legacy hook phase and runs with the new core's defaults (0.8 of
  // the model limit, no protected tools).  New marks are pending for
  // the NEXT turn's release (two-turn lifecycle).
  const modelLimit = getModelLimit(sessionId);
  const contextLimit = modelLimit?.context;
  const protectedStartOrdinal =
    config.protectedMessages === undefined
      ? undefined
      : computeProtectedStartOrdinal(
          view,
          config.protectedMessages,
          config.compress?.protectedTokens ?? 0,
        );
  const covered = coveredOrdinalsOf(state, view);
  const prunedOrdinals = (ordinal: number): boolean => covered.has(ordinal);

  if (config.dedup?.thresholdContext !== undefined) {
    const result = runDedup(state, view, {
      thresholdContext: fractionOf(config.dedup.thresholdContext, contextLimit),
      contextLimit,
      protectedStartOrdinal,
      protectedTools: config.dedup.protectedTools,
      prunedOrdinals,
    });
    if (result.created > 0) {
      log("context-pruning", "dedup_marked", sessionId, undefined, "info", {
        markedCount: result.created,
        markedTokens: result.tokens,
      });
    }
  }

  if (config.purgeErrors?.thresholdContext !== undefined) {
    const result = runPurgeErrors(state, view, {
      thresholdContext: fractionOf(
        config.purgeErrors.thresholdContext,
        contextLimit,
      ),
      contextLimit,
      protectedStartOrdinal,
      protectedTools: config.purgeErrors.protectedTools,
      prunedOrdinals,
    });
    if (result.created > 0) {
      log(
        "context-pruning",
        "purge-errors_marked",
        sessionId,
        undefined,
        "info",
        {
          markedCount: result.created,
          markedTokens: result.tokens,
        },
      );
    }
  }

  const sweepResult = runSweep(state, view, {
    contextLimit,
    protectedStartOrdinal,
    prunedOrdinals,
  });
  if (sweepResult.created > 0) {
    log("context-pruning", "sweep_marked", sessionId, undefined, "info", {
      markedCount: sweepResult.created,
      markedTokens: sweepResult.tokens,
    });
  }

  // ── Phase 4: fold + block maintenance ─────────────────────────────
  // Blocks that no longer validate (anchor messages vanished or
  // content changed) are deactivated and reported; deactivation and
  // any other fold change arm the view-change flag that forces the
  // next release regardless of the releasedPercent threshold.
  const folded = fold(view, state);
  if (folded.expiredBlockIds.length > 0) {
    for (const id of folded.expiredBlockIds) {
      const block = state.blocks.get(id);
      if (block) block.active = false;
    }
    log(
      "context-pruning",
      "compress_deactivated",
      sessionId,
      undefined,
      "info",
      {
        deactivatedCount: folded.expiredBlockIds.length,
      },
    );
  }
  if (folded.viewChanged) {
    viewChangeFlags.set(sessionId, true);
  }
  clearInactiveBlocks(state);

  // ── Phase 5: materialize the folded view ──────────────────────────
  // Rebuilds the host messages through the adapter (synthetic summary
  // messages, per-round dense `[mN] ` line refs on the injectable
  // regions).  The returned array is threaded through every subsequent
  // step.
  messages = adapter.renderView(messages, folded.items, state);

  // Per-round line refs used by the nudge and manual-compress windows
  // (line numbers are transient — valid for this round only).
  const numbered = numberView(folded.items, (ordinal) => view[ordinal].hidden);
  if (numbered.length > 0) {
    // Line-ref allocation (per-round dense line numbers) — the
    // observability sentinel for a completed pruning round, mirroring
    // the legacy refs_assigned event.
    log("context-pruning", "refs_assigned", sessionId, undefined, "info", {
      assigned: numbered.length,
    });
  }
  const lineByOrdinal = new Map<number, number>();
  for (const { n, item } of numbered) {
    if (item.type === "original") lineByOrdinal.set(item.ordinal, n);
  }
  const refForOrdinal = (ordinal: number): string | undefined => {
    const line = lineByOrdinal.get(ordinal);
    return line === undefined ? undefined : `m${line}`;
  };

  // ── Phase 6: nudge — context-pressure reminders ───────────────────
  // Runs only when every gate holds: the compress tool registered in
  // the active mode profile, a strictly-parsed nudge section present,
  // and a model context limit captured for this session.  The core
  // decides threshold resolution, the watermark ratchet (persisted on
  // every evaluation) and the eligibility window, and renders the
  // message from the shared prompts.ts templates.  The synthetic
  // message is transform-only — appended at the END, never persisted,
  // never ref-assigned.
  const nudgeConfig = config.nudge;
  if (hasCompressTool && nudgeConfig !== undefined && modelLimit) {
    const nudgeText = evaluateNudge(state, view, nudgeConfig, {
      contextLimit: modelLimit.context,
      protectedMessages: config.protectedMessages ?? 0,
      protectedTokens: config.compress?.protectedTokens ?? 0,
      thresholdTokens: config.compress?.thresholdTokens ?? 0,
      refForOrdinal,
    });
    if (nudgeText !== null) {
      messages = adapter.appendUserMessage(
        messages,
        "zoo-nudge",
        sessionId,
        nudgeText,
      );

      // Log the decision payload (the eligibility window is recomputed
      // here; it is pure over the same inputs the core just used).
      const eligibility = computeEligibility(
        view,
        {
          protectedMessages: config.protectedMessages ?? 0,
          protectedTokens: config.compress?.protectedTokens ?? 0,
          thresholdTokens: config.compress?.thresholdTokens ?? 0,
        },
        refForOrdinal,
      );
      const thresholds = resolveThresholds(nudgeConfig, modelLimit.context);
      const level =
        thresholds === null
          ? null
          : promptTokens >= thresholds.max
            ? "urgent"
            : "gentle";
      log("context-pruning", "nudge_injected", sessionId, undefined, "info", {
        // `nudgeLevel` instead of `level` — the logger reserves
        // `level` for the entry's log level.
        nudgeLevel: level,
        tokens: promptTokens,
        anchor: state.nudges?.lastNudgeTokens,
        ...(eligibility
          ? {
              startRef: eligibility.startRef,
              endRef: eligibility.endRef,
              reclaimTokens: eligibility.reclaimTokens,
            }
          : {}),
      });
    }
  }

  // ── Phase 6b: Manual compress trigger — synthetic user command ────
  // `/dcp compress` sets a one-shot in-memory flag on the shared state;
  // the NEXT transform appends a synthetic user message (id
  // `zoo-manual-compress`) that the model treats as a direct
  // instruction to call the `compress` tool.  Runs after the view
  // render so the message never enters ref numbering, and never calls
  // session.prompt (transform-only, invisible in storage).  The flag
  // is cleared after the phase — one-shot, never re-injected on later
  // turns.
  const manualCfg = config.compress;
  if (state.pendingManualTrigger === true) {
    if (
      hasCompressTool &&
      manualCfg?.protectedTokens !== undefined &&
      manualCfg?.thresholdTokens !== undefined
    ) {
      const eligibility =
        config.protectedMessages === undefined
          ? null
          : computeEligibility(
              view,
              {
                protectedMessages: config.protectedMessages,
                protectedTokens: manualCfg.protectedTokens,
                thresholdTokens: manualCfg.thresholdTokens,
              },
              refForOrdinal,
            );
      const windowLine = eligibility
        ? `可压缩窗口：${eligibility.startRef}–${eligibility.endRef}（约 ${eligibility.reclaimTokens} tokens，两端 ref 均为包含边界）。你可以在此窗口内选择连续子范围；compress 的 toRef 为排他边界——传入某条消息之后的 ref 才会包含该消息。`
        : "未检测到明确的可压缩窗口（全部内容均在保护区内）。如你判断仍有已完成且无需逐字保留的历史，请自行选择合适的范围压缩。";
      const text = MANUAL_COMPRESS_TEMPLATE.replace("{WINDOW}", windowLine);

      // Synthetic user command appended at the very END — never
      // persisted, never ref-assigned.
      messages = adapter.appendUserMessage(
        messages,
        "zoo-manual-compress",
        sessionId,
        text,
      );
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

  // ── Phase 7: persist ──────────────────────────────────────────────
  manager.save(sessionId);

  // ── Log prune completion ──────────────────────────────────────────
  // Effective-only accounting: pending marks are not yet visible, so
  // neither the count nor the reclaimed tokens include them.
  let prunedToolCount = 0;
  for (const mark of state.marks.values()) {
    if (mark.effective) prunedToolCount += 1;
  }
  const totalEff = reclaimedTokens(state);
  log("context-pruning", "prune_completed", sessionId, undefined, "info", {
    prunedToolCount,
    totalPruneTokens: totalEff,
    totalReclaimedTokens: totalEff,
  });

  return messages;
}

// ---------------------------------------------------------------------------
// Transform wrapper (sunk from the host entry point)
// ---------------------------------------------------------------------------

/**
 * Run context pruning on the messages transform output.
 *
 * Wraps `contextPruningTransformHandler` in try/catch so a pruning
 * failure never disrupts the LLM turn, and wires the release
 * notification through the host tool host's `notify` port, which
 * resolves the session agent before posting.  The transform output
 * arrives as the core `TransformOutput` shape; the host adapter owns
 * the concrete `messages` type and may replace the array.  The returned
 * conversation is written back into `output.messages` so downstream
 * transform contributions observe the pruned view.
 *
 * @param output - The messages transform output.
 * @param config - Unified context-pruning configuration.
 * @param toolHost - Host tool services used to post the release
 *   notification.  Undefined when the host wires no tool host — the
 *   notification is skipped.
 * @param hasCompressTool - Whether the `compress` tool is registered.
 * @param adapter - The host adapter for projecting and mutating the
 *   conversation.
 */
export function handleContextPruning(
  output: TransformOutput,
  config: ContextPruningConfig,
  toolHost: ToolHost | undefined,
  hasCompressTool: boolean | undefined,
  adapter: HostAdapter<unknown>,
): void {
  const sessionID = adapter.sessionId(output.messages) ?? "";
  try {
    output.messages = contextPruningTransformHandler(
      adapter,
      output.messages,
      config,
      // Fire-and-forget: post the release notice through the host tool
      // host.  Must NOT await — the transform hook must never block.
      toolHost
        ? (text: string) => {
            void toolHost.notify(sessionID, text);
          }
        : undefined,
      hasCompressTool,
    );
  } catch (err) {
    log("plugin", "handler_crashed", sessionID, undefined, "error", {
      handler: "contextPruning",
      error: String(err),
    });
  }
}
