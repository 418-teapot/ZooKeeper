/**
 * Context-pruning transform pipeline.
 *
 * Runs on the messages transform and drives the host-agnostic context
 * core (`src/core/context/`) through an injected `HostAdapter`.  The
 * pipeline is a strict phase sequence over the turn's transcript:
 *
 * 1. **State + read** — the process-wide shared `SessionStateManager`
 *    (`getContextStateManager`) yields the session state (shared with
 *    the compress/decompress tools and the /dcp command — never a
 *    private manager); `adapter.history()` maps the host messages to
 *    lens messages, and the prompt-side token total of the last
 *    completed assistant is extracted for the release gate.
 * 2. **Release** — `computeEdits` selects the round's region edits
 *    (effective marks plus pending marks passing the `releasedPercent`
 *    gate or the pending-view-change bypass), `adapter.applyEdits`
 *    writes them through the adapter lens, and `flipReleasedMarks`
 *    flips the released marks effective.  Runs FIRST so marks written
 *    last turn take effect this turn (the two-turn lifecycle).  The
 *    notify callback and the `marks_released` log fire on a flip.
 * 3. **Fold** — `fold` computes the folded view; every active block
 *    that does not render is retired: a block whose span no longer
 *    validates or whose interval does not resolve against the unit grid
 *    moves to the stale status (record retained, with a diagnostic log
 *    of the interval and the cause), and a view change arms the
 *    pending-view-change flag that forces the next release.  Runs
 *    BEFORE the producers so they read this round's view.
 * 4. **Producers** — dedup / purge-errors run only when both their
 *    configured `thresholdContext` and `minMessages` are defined; a
 *    missing gate key skips the producer entirely.  Their
 *    `prunedOrdinals` predicate comes from the folded view, so the
 *    lines the model no longer sees are exactly the lines they never
 *    mark.  Marks are pending for the next turn's release.
 * 5. **Publish + materialize** — the round's folded view is numbered and
 *    published to the compression tools (`core/context/round-view.ts`,
 *    frozen), the render plan is computed over that numbering
 *    (`core/context/render-plan.ts`), and `adapter.materialize` turns the
 *    plan into the host's messages (synthetic summary messages, per-round
 *    `[mN] ` line refs).
 * 6. **Nudge** — `evaluateNudge` decides and renders the
 *    context-pressure reminder (transform-only synthetic message
 *    appended at the END via `adapter.appendUserMessage`, never
 *    ref-assigned), and the same decision point fires the optional
 *    transient-UI toast (human-facing, host-rendered).
 * 7. **Manual compress** — the `/dcp compress` one-shot
 *    `pendingManualTrigger` flag injects the synthetic user command
 *    driving the `compress` tool.
 * 8. **Persist** — the session state is written back to the shared
 *    store, followed by the `prune_completed` summary log.
 *
 * The two-turn effect ("turn N marks apply on turn N+1") means that
 * marks produced by the current turn are NOT pruned during the same
 * turn.
 *
 * Enablement is decided by the caller (opencode.ts / pi.ts) from the
 * mode profile and by the hook unit's `create`: when `deps.adapter` is
 * undefined the unit contributes no transform handler (fail-closed).
 * `hasCompressTool` gates the nudge and manual-compress phases (they
 * advertise windows the registered `compress` tool would accept).
 *
 * Does NOT catch errors — the caller (`handleContextPruning`) wraps
 * this in try/catch so a pruning failure never disrupts the LLM turn.
 *
 * @module
 */

import { log } from "../../utils/logger.js";
import type { ContextPruningConfig } from "../config-types.js";
import type { ToastPayload, ToolHost } from "../ports/tool-host.js";
import { MANUAL_COMPRESS_TEMPLATE } from "../prompts.js";
import type { TransformOutput } from "../unit.js";
import { computeProtectedStartOrdinal } from "./compress.js";
import { formatTokens } from "./context-report.js";
import { type FoldExpiryReason, fold } from "./fold.js";
import type { HostAdapter, HostMessage, Projection, ViewItem } from "./lens.js";
import { promptSideTokens } from "./measure.js";
import { getModelLimit, type ModelLimitInfo } from "./model-limits.js";
import {
  computeEligibility,
  type EligibilityConfig,
  evaluateNudge,
} from "./nudge.js";
import { runDedup } from "./producers/dedup.js";
import { runPurgeErrors } from "./producers/purge-errors.js";
import {
  computeEdits,
  flipReleasedMarks,
  pendingTokens,
  type ReleaseOptions,
  reclaimedTokens,
} from "./release.js";
import { planViewRender } from "./render-plan.js";
import { publishRoundView } from "./round-view.js";
import {
  consumePendingViewChange,
  getContextStateManager,
  getRuntimeFlaggedState,
  type RuntimeFlaggedState,
  setPendingViewChange,
} from "./runtime.js";
import type { SessionStateManager } from "./session-state.js";
import { checkSpan } from "./spanhash.js";
import { type Block, markStale } from "./state.js";
import { itemInterval, type NumberedItem, numberView } from "./view-refs.js";

// ---------------------------------------------------------------------------
// Pipeline helpers
// ---------------------------------------------------------------------------

/**
 * Convert an absolute prompt-side threshold into the producers'
 * model-context fraction.
 *
 * The producers gate on `measured.total >= contextLimit × fraction`, so
 * the fraction `absolute / contextLimit` preserves a configured absolute
 * value.
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

// ---------------------------------------------------------------------------
// Phase context
// ---------------------------------------------------------------------------

/**
 * State threaded through the pipeline phases.
 *
 * Phases communicate exclusively through this object: phase 1 fills the
 * read results, later phases update `messages` (the conversation array
 * is threaded, not copied) and the shared view/snapshot pair, and the
 * publish phase stores the numbered view plus the window-protection
 * inputs the nudge and manual-compress phases consume.
 */
interface PipelinePhaseContext {
  /** Host adapter that projects and renders the conversation. */
  adapter: HostAdapter<unknown>;
  /** Unified context-pruning configuration. */
  config: ContextPruningConfig;
  /** Optional callback for user-visible release notification. */
  notify?: (text: string) => void;
  /** Gates the nudge and manual-compress phases. */
  hasCompressTool?: boolean;
  /** Optional transient-UI port (source/level/text payload). */
  toast?: (payload: ToastPayload) => void;
  /** Session ID extracted from the first message. */
  sessionId: string;
  /** The process-wide shared session state manager. */
  manager: SessionStateManager;
  /** The session state (blocks, marks, runtime flags). */
  state: RuntimeFlaggedState;
  /** The conversation array; phases replace it as they render. */
  messages: unknown;
  /** The current projection snapshot of `messages`. */
  snapshot: Projection;
  /** The lens messages of `snapshot`. */
  view: HostMessage[];
  /** Prompt-side token total of the last completed assistant. */
  promptTokens: number;
  /** The model limit captured for this session, when known. */
  modelLimit: ModelLimitInfo | undefined;
  /** The model context window, when known. */
  contextLimit: number | undefined;
  /** This round's numbered view over the fold. */
  numbered: NumberedItem[];
  /** The folded view items, read by the producers and rendered. */
  foldedItems: ViewItem[];
  /** Window protection inputs shared by the nudge, its log line, and
   * the manual-compress window. */
  eligibilityConfig: EligibilityConfig;
}

/**
 * The read phase's inputs — the handler arguments plus the extracted
 * session id, carried as a single object to keep the seam named.
 */
type PipelineInputs = Pick<
  PipelinePhaseContext,
  | "adapter"
  | "config"
  | "notify"
  | "hasCompressTool"
  | "toast"
  | "sessionId"
  | "messages"
>;

// ---------------------------------------------------------------------------
// Phase 1: state + read
// ---------------------------------------------------------------------------

/**
 * Read the shared session state and project the conversation.
 *
 * The process-wide shared manager (hook/tool/dcp single instance)
 * yields the session state; `adapter.history()` maps the host messages
 * to lens messages, and the prompt-side token total of the last
 * completed assistant is extracted for the release gate.
 */
function readPhase(inputs: PipelineInputs): PipelinePhaseContext {
  const { adapter, messages, config, sessionId } = inputs;
  const manager = getContextStateManager();
  const state = getRuntimeFlaggedState(sessionId);
  const snapshot = adapter.history(messages);
  const view = snapshot.messages;
  const modelLimit = getModelLimit(sessionId);
  return {
    ...inputs,
    manager,
    state,
    messages,
    snapshot,
    view,
    promptTokens: promptSideTokens(view),
    modelLimit,
    contextLimit: modelLimit?.context,
    numbered: [],
    foldedItems: [],
    eligibilityConfig: {
      protectedMessages: config.protectedMessages,
      protectedTokens: config.compress?.protectedTokens,
      thresholdTokens: config.compress?.thresholdTokens,
    },
  };
}

// ---------------------------------------------------------------------------
// Phase 2: release — start of turn
// ---------------------------------------------------------------------------

/**
 * Release the round's region edits.
 *
 * Effective marks from earlier turns write their placeholders again
 * (the host reloads the transcript fresh each turn); pending marks flip
 * when the releasedPercent gate opens or the pending-view-change bypass
 * is armed (a fold view change, a compress / decompress tool call, or a
 * block that stopped folding last turn).  The flag is consumed and
 * cleared here so it forces exactly one release; it arrives only
 * through the runtime map (`setPendingViewChange`) — never through a
 * state-object field.
 *
 * Runs FIRST so marks written last turn take effect this turn (the
 * two-turn lifecycle).  The release edits are applied through the
 * adapter lens NOW, before the producers and the nudge eligibility
 * scan — those read region text (context gates, placeholder-prefixed
 * skip, reclaim estimates) and must observe the placeholder text.  The
 * notify callback and the `marks_released` log fire on a flip.
 */
function releasePhase(ctx: PipelinePhaseContext): void {
  const { adapter, config, state, sessionId } = ctx;
  const bypass = consumePendingViewChange(sessionId);
  const curPendingTokens = pendingTokens(state);
  const releaseOptions: ReleaseOptions = {
    promptTokens: ctx.promptTokens,
    releasedPercent: config.releasedPercent,
    pendingViewChange: bypass,
  };
  const releaseEdits = computeEdits(state, ctx.view, releaseOptions);
  ctx.messages = adapter.applyEdits(ctx.messages, releaseEdits);
  ctx.snapshot = adapter.history(ctx.messages);
  ctx.view = ctx.snapshot.messages;
  const released = flipReleasedMarks(state, releaseOptions);

  if (released.releasedCount > 0) {
    log.info({
      hook: "context-pruning",
      event: "marks_released",
      sessionId,
      releasedCount: released.releasedCount,
      releasedTokens: released.releasedTokens,
      pendingTokensBefore: curPendingTokens,
      promptTokens: ctx.promptTokens,
      ...(released.forced ? { forced: "view_change" } : {}),
    });

    // Notify the session chat with a user-visible ignored message.
    // Fire-and-forget — the host tool host's `notify` port owns
    // delivery and must never block the transform.
    if (ctx.notify) {
      ctx.notify(
        `上下文清理：已折叠 ${released.releasedCount} 个工具调用，约回收 ${formatTokens(released.releasedTokens)} tokens`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Phase 3: fold + block maintenance
// ---------------------------------------------------------------------------

/**
 * Log fields describing why an active block did not render.
 *
 * Keyed by the fold's expiry reason, so a new `FoldExpiryReason` fails the
 * type check until it names its diagnostic fields.  A `boundary` failure
 * leaves the span hash intact, so no hash comparison describes it; a hash
 * failure re-derives the precise span-check reason and both hashes.
 */
const EXPIRY_DIAGNOSTICS: Record<
  FoldExpiryReason,
  (snapshot: Projection, block: Block) => Record<string, unknown>
> = {
  boundary: () => ({ reason: "boundary-misaligned" }),
  "hash-invalid": (snapshot, block) => {
    const check = checkSpan(snapshot, block);
    return {
      reason: check.reason,
      storedHash: check.storedHash,
      currentHash: check.currentHash,
    };
  },
};

/**
 * Fold the view and maintain block records.
 *
 * Every active block that does not render moves to the stale status and
 * is reported with the cause the fold observed: `hash-invalid` (the span
 * no longer validates — anchor messages vanished or content changed) or
 * `boundary` (the interval no longer resolves against the unit grid).
 * The transition keeps the record — interval, title, summary and stored
 * hash — so the loss stays diagnosable and the summary recallable.
 * Staling and any other fold change arm the view-change flag that forces
 * the next release regardless of the releasedPercent threshold.
 */
function foldPhase(ctx: PipelinePhaseContext): void {
  const { sessionId, state, snapshot } = ctx;
  const folded = fold(snapshot, state);
  if (folded.expired.length > 0) {
    for (const { id, reason } of folded.expired) {
      const block = state.blocks.get(id);
      if (block === undefined) continue;
      const entry = {
        hook: "context-pruning",
        event: "compress_block_stale",
        sessionId,
        blockId: id,
        start: block.start,
        end: block.end,
        historyLength: snapshot.messages.length,
        ...(block.title !== undefined ? { title: block.title } : {}),
      };
      log.warn({ ...entry, ...EXPIRY_DIAGNOSTICS[reason](snapshot, block) });
    }
    markStale(
      state,
      folded.expired.map((entry) => entry.id),
    );
  }
  if (folded.viewChanged) {
    setPendingViewChange(sessionId);
  }
  ctx.foldedItems = folded.items;
}

// ---------------------------------------------------------------------------
// Phase 4: producers (dedup / purge-errors)
// ---------------------------------------------------------------------------

/**
 * Run the mark producers (dedup / purge-errors).
 *
 * A producer runs only when BOTH of its gate keys (threshold_context
 * and min_messages) are configured; a missing key skips it.  A
 * configured threshold is converted to a context-limit fraction, which
 * needs a known model limit — when it cannot be evaluated the producer
 * fails closed.  New marks are pending for the NEXT turn's release
 * (two-turn lifecycle).
 *
 * Runs AFTER the fold: the `prunedOrdinals` predicate is the union of
 * this round's summary intervals, so a producer never marks a line the
 * model cannot read.
 */
function producersPhase(ctx: PipelinePhaseContext): void {
  const { config, sessionId, state, snapshot } = ctx;
  const protectedTokens = config.compress?.protectedTokens;
  const protectedStartOrdinal =
    config.protectedMessages === undefined || protectedTokens === undefined
      ? undefined
      : computeProtectedStartOrdinal(
          ctx.view,
          config.protectedMessages,
          protectedTokens,
        );
  // Coverage comes from this round's view: the ordinals a summary item
  // replaced are exactly the ones the model no longer reads, so the
  // predicate cannot drift from what was rendered.
  const covered = new Set<number>();
  for (const item of ctx.foldedItems) {
    if (item.type !== "summary") continue;
    const { start, end } = itemInterval(item);
    for (let ordinal = start; ordinal < end; ordinal++) covered.add(ordinal);
  }
  const prunedOrdinals = (ordinal: number): boolean => covered.has(ordinal);

  const dedupGate = config.dedup;
  if (
    dedupGate?.thresholdContext !== undefined &&
    dedupGate.minMessages !== undefined
  ) {
    const thresholdContext = fractionOf(
      dedupGate.thresholdContext,
      ctx.contextLimit,
    );
    if (thresholdContext !== undefined) {
      const result = runDedup(state, snapshot, {
        minMessages: dedupGate.minMessages,
        thresholdContext,
        contextLimit: ctx.contextLimit,
        protectedStartOrdinal,
        protectedTools: dedupGate.protectedTools,
        prunedOrdinals,
      });
      if (result.created > 0) {
        log.info({
          hook: "context-pruning",
          event: "dedup_marked",
          sessionId,
          markedCount: result.created,
          markedTokens: result.tokens,
        });
      }
    }
  }

  const purgeGate = config.purgeErrors;
  if (
    purgeGate?.thresholdContext !== undefined &&
    purgeGate.minMessages !== undefined
  ) {
    const thresholdContext = fractionOf(
      purgeGate.thresholdContext,
      ctx.contextLimit,
    );
    if (thresholdContext !== undefined) {
      const result = runPurgeErrors(state, snapshot, {
        minMessages: purgeGate.minMessages,
        thresholdContext,
        contextLimit: ctx.contextLimit,
        protectedStartOrdinal,
        protectedTools: purgeGate.protectedTools,
        prunedOrdinals,
      });
      if (result.created > 0) {
        log.info({
          hook: "context-pruning",
          event: "purge-errors_marked",
          sessionId,
          markedCount: result.created,
          markedTokens: result.tokens,
        });
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Phase 5: publish + materialize the folded view
// ---------------------------------------------------------------------------

/**
 * Publish and materialize the folded view.
 *
 * Per-round line refs used by the nudge, the manual-compress window and
 * the compression tools (line numbers are transient — valid for this
 * round only).  Numbering and the round-view publication run BEFORE
 * the view is materialized: the frozen snapshot handed to the tools must
 * carry the transcript exactly as the fold hashed it, and materializing
 * rewrites the host messages (line-number prefixes, synthetic summary
 * messages) — publishing afterwards would capture a view the fold never
 * hashed.
 *
 * The render plan is computed here, once, over the lens the round's
 * edits landed in; the adapter only applies it.  Numbering is the
 * published numbering, so the refs the model reads and the refs the
 * tools resolve cannot drift apart.
 */
function publishPhase(ctx: PipelinePhaseContext): void {
  const { adapter, sessionId, state } = ctx;
  const numbered = numberView(
    ctx.foldedItems,
    (ordinal) => ctx.view[ordinal]?.hidden ?? true,
  );

  // Hand the compression tools this round's address space: the
  // transcript snapshot the fold ran over plus the numbered view over
  // it.  A `compress` call made mid-turn therefore addresses exactly
  // the `mN` lines the model was shown, with no re-derivation from the
  // host.
  publishRoundView(sessionId, { projection: ctx.snapshot, numbered });

  // Rebuilds the host messages through the adapter: the plan says which
  // messages survive, which carries each unit's dense `[mN] ` line ref,
  // and what each folded block's summary text is.  The returned array is
  // threaded through every subsequent step.
  ctx.messages = adapter.materialize(
    ctx.messages,
    planViewRender(ctx.view, ctx.foldedItems, numbered, state),
  );

  ctx.numbered = numbered;
  if (numbered.length > 0) {
    // Line-ref allocation (per-round dense line numbers) — the
    // observability sentinel for a completed pruning round.
    log.info({
      hook: "context-pruning",
      event: "refs_assigned",
      sessionId,
      assigned: numbered.length,
    });
  }
}

// ---------------------------------------------------------------------------
// Phase 6: nudge — context-pressure reminders
// ---------------------------------------------------------------------------

/**
 * Inject the context-pressure nudge and fire the companion toast.
 *
 * Runs only when every gate holds: the compress tool registered in the
 * active mode profile, a strictly-parsed nudge section present, and a
 * model context limit captured for this session.  The core decides
 * threshold resolution, the watermark ratchet (persisted on every
 * evaluation) and the eligibility window, and renders the message from
 * the shared prompts.ts templates.  The window is measured over this
 * round's numbered view, so the refs it advertises are addresses in
 * the view the model was just rendered.  The synthetic message is
 * transform-only — appended at the END, never persisted, never
 * ref-assigned.
 */
function nudgePhase(ctx: PipelinePhaseContext): void {
  const { adapter, config, sessionId, state, view, toast, numbered } = ctx;
  const modelLimit = ctx.modelLimit;
  const nudgeConfig = config.nudge;
  if (!(ctx.hasCompressTool && nudgeConfig !== undefined && modelLimit)) {
    return;
  }
  const decision = evaluateNudge(state, view, nudgeConfig, {
    contextLimit: modelLimit.context,
    numbered,
    ...ctx.eligibilityConfig,
  });
  if (decision === null || decision.text === null) return;

  ctx.messages = adapter.appendUserMessage(
    ctx.messages,
    "zoo-nudge",
    sessionId,
    decision.text,
  );

  // Log the decision payload — every field is the post-write snapshot
  // the core evaluation persisted.
  log.info({
    hook: "context-pruning",
    event: "nudge_injected",
    sessionId,
    // `nudgeLevel` instead of `level` — the logger reserves `level`
    // for the entry's log level.
    nudgeLevel: decision.level,
    tokens: decision.promptTokens,
    measuredTokens: decision.measuredTokens,
    anchor: decision.anchor,
    ...(decision.eligibility
      ? {
          startRef: decision.eligibility.startRef,
          endRef: decision.eligibility.endRef,
          reclaimTokens: decision.eligibility.reclaimTokens,
        }
      : {}),
  });

  // Human-facing companion of the model nudge (one decision, two
  // audiences): a transient toast on the same watermark-ratchet
  // decision point — no extra throttling state.  Fire-and-forget; the
  // port renders source/level uniformly and silently drops when the
  // host has no UI surface.
  if (toast && decision.level !== null) {
    const percent = Math.round(
      (decision.promptTokens / modelLimit.context) * 100,
    );
    toast({
      source: "context-pruning",
      level: decision.level === "urgent" ? "warning" : "info",
      text:
        decision.level === "urgent"
          ? `上下文吃紧：已用 ${percent}%`
          : `上下文渐满：已用 ${percent}%`,
    });
  }
}

// ---------------------------------------------------------------------------
// Phase 7: manual compress trigger — synthetic user command
// ---------------------------------------------------------------------------

/**
 * Inject the `/dcp compress` one-shot synthetic user command.
 *
 * `/dcp compress` sets a one-shot in-memory flag on the shared state;
 * the NEXT transform appends a synthetic user message (id
 * `zoo-manual-compress`) that the model treats as a direct instruction
 * to call the `compress` tool.  Runs after the view render so the
 * message never enters ref numbering, and never calls session.prompt
 * (transform-only, invisible in storage).  The flag is cleared after
 * the phase — one-shot, never re-injected on later turns.  A stale
 * trigger (compress tool unregistered or thresholds missing) is
 * cleared so it never fires later.
 */
function manualCompressPhase(ctx: PipelinePhaseContext): void {
  const { adapter, config, sessionId, state, view } = ctx;
  const manualCfg = config.compress;
  if (state.pendingManualTrigger !== true) return;

  if (
    ctx.hasCompressTool &&
    manualCfg?.protectedTokens !== undefined &&
    manualCfg?.thresholdTokens !== undefined
  ) {
    const eligibility =
      config.protectedMessages === undefined
        ? null
        : computeEligibility(view, ctx.numbered, {
            protectedMessages: config.protectedMessages,
            protectedTokens: manualCfg.protectedTokens,
            thresholdTokens: manualCfg.thresholdTokens,
          });
    const windowLine = eligibility
      ? `可压缩窗口：${eligibility.startRef}–${eligibility.endRef}（约 ${eligibility.reclaimTokens} tokens，两端 ref 均为包含边界）。你可以在此窗口内选择连续子范围，fromRef 与 toRef 都指向要压缩的消息本身。`
      : "未检测到明确的可压缩窗口（全部内容均在保护区内）。如你判断仍有已完成且无需逐字保留的历史，请自行选择合适的范围压缩。";
    const text = MANUAL_COMPRESS_TEMPLATE.replace("{WINDOW}", windowLine);

    // Synthetic user command appended at the very END — never
    // persisted, never ref-assigned.
    ctx.messages = adapter.appendUserMessage(
      ctx.messages,
      "zoo-manual-compress",
      sessionId,
      text,
    );
    state.pendingManualTrigger = false;

    log.info({
      hook: "context-pruning",
      event: "manual_compress_injected",
      sessionId,
      ...(eligibility
        ? {
            startRef: eligibility.startRef,
            endRef: eligibility.endRef,
            reclaimTokens: eligibility.reclaimTokens,
          }
        : { eligibility: null }),
    });
  } else {
    // Compress tool / section unavailable — a stale trigger can never
    // produce a meaningful command.  Clear the flag so it never fires
    // later (the /dcp compress registration gate normally prevents
    // this state).
    state.pendingManualTrigger = false;
    log.warn({
      hook: "context-pruning",
      event: "manual_compress_skipped",
      sessionId,
      reason: "compress tool not registered or thresholds missing",
    });
  }
}

// ---------------------------------------------------------------------------
// Phase 8: persist
// ---------------------------------------------------------------------------

/**
 * Persist the session state and log the prune completion.
 *
 * Effective-only accounting: pending marks are not yet visible, so
 * neither the count nor the reclaimed tokens include them.
 */
function persistPhase(ctx: PipelinePhaseContext): void {
  const { manager, sessionId, state } = ctx;
  manager.save(sessionId);

  let prunedToolCount = 0;
  for (const mark of state.marks.values()) {
    if (mark.effective) prunedToolCount += 1;
  }
  const totalEff = reclaimedTokens(state);
  log.info({
    hook: "context-pruning",
    event: "prune_completed",
    sessionId,
    prunedToolCount,
    totalPruneTokens: totalEff,
    totalReclaimedTokens: totalEff,
  });
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
 * user-visible cleanup notice; the log surface keeps its event
 * contracts (`prune_completed` counts effective marks only,
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
 * @param toast - Optional transient-UI port (source/level/text
 *   payload).  Fires on every nudge injection — the human-facing
 *   companion of the model nudge at the same watermark-ratchet
 *   decision point, adding no throttling state of its own.
 * @returns The conversation after pruning.
 */
export function contextPruningTransformHandler(
  adapter: HostAdapter<unknown>,
  messages: unknown,
  config: ContextPruningConfig,
  notify?: (text: string) => void,
  hasCompressTool?: boolean,
  toast?: (payload: ToastPayload) => void,
): unknown {
  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    return messages;
  }

  // Extract session ID from the first message through the adapter.
  const sessionId = adapter.sessionId(messages);
  if (!sessionId) return messages;

  const ctx = readPhase({
    adapter,
    messages,
    config,
    notify,
    hasCompressTool,
    toast,
    sessionId,
  });
  releasePhase(ctx);
  foldPhase(ctx);
  producersPhase(ctx);
  publishPhase(ctx);
  nudgePhase(ctx);
  manualCompressPhase(ctx);
  persistPhase(ctx);

  return ctx.messages;
}

// ---------------------------------------------------------------------------
// Transform wrapper
// ---------------------------------------------------------------------------

/**
 * Run context pruning on the messages transform output.
 *
 * Wraps `contextPruningTransformHandler` in try/catch so a pruning
 * failure never disrupts the LLM turn, and wires the release
 * notification through the host tool host's `notify` port (which
 * resolves the session agent before posting) and the nudge toast
 * through the optional `toast` port.  The transform output arrives as
 * the core `TransformOutput` shape; the host adapter owns the concrete
 * `messages` type and may replace the array.  The returned conversation
 * is written back into `output.messages` so downstream transform
 * contributions observe the pruned view.
 *
 * @param output - The messages transform output.
 * @param config - Unified context-pruning configuration.
 * @param toolHost - Host tool services used to post the release
 *   notification and the nudge toast.  Undefined when the host wires no
 *   tool host — both are skipped.
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
      // Fire-and-forget toast port (nudge companion): same wiring path
      // as the release notice.  The optional call covers hosts that
      // implement ToolHost without `toast`; the host implementation
      // owns the no-UI silent drop.
      toolHost
        ? (payload: ToastPayload) => {
            toolHost.toast?.(sessionID, payload);
          }
        : undefined,
    );
  } catch (err) {
    log.error({
      hook: "plugin",
      event: "handler_crashed",
      sessionId: sessionID,
      handler: "contextPruning",
      error: String(err),
    });
  }
}
