/**
 * Context-pruning transform pipeline.
 *
 * Runs on the messages transform and drives the host-agnostic context
 * core (`src/core/context/`) through an injected `HostAdapter`.  The
 * pipeline is a strict phase sequence over the turn's transcript:
 *
 * 1. **State + read** — the plugin instance's `ContextRuntime`
 *    (`runtime.ts`, injected as a capability) yields the session state
 *    the compress/decompress tools share;
 *    `adapter.history()` maps the host messages to lens messages, and the
 *    prompt-side token total of the last completed assistant is extracted
 *    for the release gate.
 * 2. **Release** — `computeEdits` selects the round's region edits
 *    (effective marks plus pending marks passing the `releasedPercent`
 *    gate or the pending-view-change bypass),
 *    `adapter.applyEdits` writes them through the adapter lens, and
 *    `flipReleasedMarks` flips the released marks effective.  Both read
 *    the round's protection map: a mark anchored at a protected ordinal
 *    writes no placeholder and does not flip.  Runs FIRST so marks
 *    written last turn take effect this turn (the two-turn lifecycle).
 *    The `marks_released` log fires on a flip and reports the flipped
 *    marks apart from the written edits; the user notice fires only when
 *    an edit was actually written.
 * 3. **Fold** — `fold` computes the folded view; every active block
 *    that does not render is retired: a block whose span no longer
 *    validates or whose interval does not resolve against the unit grid
 *    moves to the stale status (record retained, with a diagnostic log
 *    of the interval and the cause), and a view change arms the
 *    pending-view-change flag that forces the next release.  Runs
 *    BEFORE the producers so they read this round's view.
 * 4. **Producers** — dedup / purge-errors run only when both their
 *    configured `thresholdContext` and `minMessages` are defined; a
 *    missing gate key skips the producer entirely.  They consume the
 *    round's protection map, so a region in the active tail or at a
 *    user instruction is never marked.  Their `prunedOrdinals` predicate
 *    comes from the folded view, so the lines the model no longer sees
 *    are exactly the lines they never mark.  Marks are pending for the
 *    next turn's release.
 * 5. **Number + materialize** — the round's folded view is numbered, the
 *    render plan is computed over that numbering
 *    (`core/context/render-plan.ts`), and `adapter.materialize` turns the
 *    plan into the host's messages (synthetic summary messages, per-round
 *    `[mN] ` line refs).  The numbering is published to the compression
 *    tools (`core/context/round-view.ts`, frozen) only after the commit.
 * 6. **Nudge** — `evaluateNudge` decides and renders the
 *    context-pressure reminder (transform-only synthetic message
 *    appended at the END via `adapter.appendUserMessage`, never
 *    ref-assigned), and the same decision point fires the optional
 *    transient-UI toast (human-facing, host-rendered).
 * 7. **Commit** — every phase runs on the draft of one
 *    `runtime.commit(permit, ...)`: the whole read-modify-write becomes the
 *    committed state only while the permit stays active and the write
 *    succeeded.  A draft that never commits leaves the caller's
 *    conversation, the session state and the pending-view-change flag
 *    untouched, and writes no success log, notice or toast.  Once the
 *    commit landed the round is done: the published round view, the
 *    notices, the toasts, the logs and the returned conversation follow it
 *    even when the permit lapsed right after it.
 *
 * The two-turn effect ("turn N marks apply on turn N+1") means that
 * marks produced by the current turn are NOT pruned during the same
 * turn.
 *
 * Enablement is decided by the caller (opencode.ts / pi.ts) from the
 * mode profile and by the hook unit's `create`: when `deps.adapter` is
 * undefined the unit contributes no transform handler (fail-closed).
 * `hasCompressTool` gates the nudge phase (it advertises windows the
 * registered `compress` tool would accept).
 *
 * Does NOT catch errors — the caller (`handleContextPruning`) wraps
 * this in try/catch so a pruning failure never disrupts the LLM turn.
 *
 * @module
 */

import { log } from "../../utils/logger.js";
import type { ContextPruningConfig } from "../config-types.js";
import type { WorkPermit } from "../lifecycle/index.js";
import type { ToastPayload, ToolHost } from "../ports/tool-host.js";
import type { TransformOutput } from "../unit.js";
import { formatTokens } from "./context-report.js";
import { type FoldExpiryReason, fold } from "./fold.js";
import type {
  HostAdapter,
  HostMessage,
  Projection,
  RegionEdit,
  ViewItem,
} from "./lens.js";
import { promptSideTokens } from "./measure.js";
import type { ModelLimitInfo } from "./model-limits.js";
import { type EligibilityConfig, evaluateNudge } from "./nudge.js";
import { runDedup } from "./producers/dedup.js";
import { runPurgeErrors } from "./producers/purge-errors.js";
import {
  configuredProtectionMap,
  type ProtectionMap,
} from "./protection-map.js";
import {
  computeEdits,
  flipReleasedMarks,
  pendingTokens,
  type ReleaseOptions,
  reclaimedTokens,
} from "./release.js";
import { planViewRender } from "./render-plan.js";
import {
  freezeNumberedView,
  freezeProjection,
  type RoundView,
} from "./round-view.js";
import type { ContextRuntime, RuntimeFlaggedState } from "./runtime.js";
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
 * A log entry a phase stages for the committed round.
 *
 * Phases stage their success entries instead of logging them, and the
 * handler emits them only after the commit succeeded — no success log
 * line ever describes an uncommitted round.  Diagnostic warns stay
 * immediate and are not staged.
 */
interface StagedLog {
  /** The event name of the entry. */
  event: string;
  /** The event's payload fields. */
  fields: Record<string, unknown>;
}

/**
 * State threaded through the pipeline phases.
 *
 * Phases communicate exclusively through this object: phase 1 fills the
 * read results, later phases update `messages` (the conversation array
 * is threaded, not copied) and the shared view/snapshot pair, and the
 * publish phase stores the numbered view plus the window-protection
 * inputs the nudge phase consumes.
 */
interface PipelinePhaseContext {
  /** Host adapter that projects and renders the conversation. */
  adapter: HostAdapter<unknown>;
  /** Unified context-pruning configuration. */
  config: ContextPruningConfig;
  /** Gates the nudge phase. */
  hasCompressTool?: boolean;
  /** Optional transient-UI port (source/level/text payload). */
  toast?: (payload: ToastPayload) => void;
  /** Session the host admitted the transform for. */
  sessionId: string;
  /** The draft session state the phases mutate. */
  state: RuntimeFlaggedState;
  /** Release notices to post once the commit succeeds. */
  notices: string[];
  /** Transient-UI payloads to fire once the commit succeeds. */
  toasts: ToastPayload[];
  /** Success log entries to emit once the commit succeeds. */
  logs: StagedLog[];
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
  /** The frozen round view the commit publishes to the tools. */
  roundView: RoundView;
  /** The frozen protection map shared by the nudge and the compress tool;
   * absent when the config defines no protection inputs. */
  protection?: ProtectionMap;
  /** The folded view items, read by the producers and rendered. */
  foldedItems: ViewItem[];
  /** The phantom threshold shared by the nudge and the compress tool. */
  eligibilityConfig: EligibilityConfig;
}

/**
 * The read phase's inputs — the handler arguments plus the extracted
 * session id, carried as a single object to keep the seam named.
 */
type PipelineInputs = Pick<
  PipelinePhaseContext,
  "adapter" | "config" | "hasCompressTool" | "toast" | "messages"
>;

// ---------------------------------------------------------------------------
// Phase 1: state + read
// ---------------------------------------------------------------------------

/**
 * Read the runtime's records and project the conversation.
 *
 * `adapter.history()` maps the host messages to lens messages, and the
 * prompt-side token total of the last completed assistant is extracted for
 * the release gate.  The model limit comes from the same runtime the
 * capture hook wrote it to.
 */
function readPhase(
  runtime: ContextRuntime,
  permit: WorkPermit,
  state: RuntimeFlaggedState,
  inputs: PipelineInputs,
): PipelinePhaseContext {
  const { adapter, messages, config } = inputs;
  const sessionId = permit.sessionID;
  const snapshot = adapter.history(messages);
  const view = snapshot.messages;
  const modelLimit = runtime.modelLimit(sessionId);
  // The protection map is one round snapshot built BEFORE the release
  // edits rewrite text: release changes placeholders, never ordinals, so
  // every later phase reads the same boundaries the reminder used.
  const protection = configuredProtectionMap(view, config);
  return {
    ...inputs,
    sessionId,
    state,
    messages,
    snapshot,
    view,
    promptTokens: promptSideTokens(view),
    modelLimit,
    contextLimit: modelLimit?.context,
    numbered: [],
    roundView: { projection: snapshot, numbered: [], protection },
    protection,
    foldedItems: [],
    notices: [],
    toasts: [],
    logs: [],
    eligibilityConfig: {
      thresholdTokens: config.compress?.thresholdTokens,
    },
  };
}

// ---------------------------------------------------------------------------
// Phase 2: release — start of turn
// ---------------------------------------------------------------------------

/**
 * Count the pending marks whose placeholder this release actually writes.
 *
 * `computeEdits` also re-applies every effective mark, so the raw edit
 * count overstates a release: only a pending mark is one this call folds.
 * A pending mark whose anchor fails the content check produces no edit, so
 * it counts nothing here even though it flips.  A pending mark whose region
 * already holds the placeholder — the previous round wrote it but its flip
 * did not persist — writes the same text again and reclaims nothing, so it
 * counts nothing either.  Must be read before `flipReleasedMarks`, which
 * makes every planned mark effective.
 *
 * @param state - The session state holding the marks.
 * @param edits - The edits the release call writes.
 * @param view - The transcript before the edits are applied.
 * @returns The written count and the written marks' reclaim tokens.
 */
function writtenTotals(
  state: RuntimeFlaggedState,
  edits: RegionEdit[],
  view: HostMessage[],
): { count: number; tokens: number } {
  // Addresses whose region text this call changes.  An edit the adapter
  // cannot write (no region index, no such region) changes nothing.
  const changing = new Set<string>();
  for (const edit of edits) {
    if (edit.regionIndex === undefined) continue;
    const region = view[edit.messageOrdinal]?.regions?.[edit.regionIndex];
    if (!region || region.get() === edit.text) continue;
    changing.add(`${edit.messageOrdinal}:${edit.regionIndex}`);
  }
  let count = 0;
  let tokens = 0;
  for (const mark of state.marks.values()) {
    if (mark.effective || mark.regionIndex === undefined) continue;
    if (!changing.has(`${mark.anchorOrdinal}:${mark.regionIndex}`)) continue;
    count++;
    tokens += mark.contentTokens ?? 0;
  }
  return { count, tokens };
}

/**
 * Release the round's region edits.
 *
 * Effective marks from earlier turns write their placeholders again
 * (the host reloads the transcript fresh each turn); pending marks flip
 * when the releasedPercent gate opens or the pending-view-change bypass
 * is armed (a fold view change, a compress / decompress tool call, or a
 * block that stopped folding last turn).  The flag is cleared on the same
 * state draft so it forces exactly one release, and it commits or fails
 * together with the state it rides on.
 *
 * Runs FIRST so marks written last turn take effect this turn (the
 * two-turn lifecycle).  The release edits are applied through the
 * adapter lens NOW, before the producers and the nudge eligibility
 * scan — those read region text (context gates, placeholder-prefixed
 * skip, reclaim estimates) and must observe the placeholder text.  The
 * `marks_released` log fires on a flip and reports the flipped marks and
 * the written edits apart: an anchor that fails the content check still
 * flips, so a release can write nothing.  The user notice fires only when
 * an edit was actually written, and it reports that written count.
 *
 * Both halves read the round's protection map: a mark anchored at a
 * protected ordinal writes no placeholder and does not flip, so the
 * model never sees the round's own live conversation pruned.  Without a
 * map the phase fails closed — no edit, no flip.
 */
function releasePhase(ctx: PipelinePhaseContext): void {
  const { adapter, config, state, sessionId } = ctx;
  const bypass = state.pendingViewChange === true;
  state.pendingViewChange = false;
  const curPendingTokens = pendingTokens(state);
  const releaseOptions: ReleaseOptions = {
    promptTokens: ctx.promptTokens,
    releasedPercent: config.releasedPercent,
    pendingViewChange: bypass,
    protection: ctx.protection,
  };
  const releaseEdits = computeEdits(state, ctx.view, releaseOptions);
  // Read against the view before the edits land: a region that already
  // holds its placeholder is a replay, not a fold this round.
  const written = writtenTotals(state, releaseEdits, ctx.view);
  ctx.messages = adapter.applyEdits(ctx.messages, releaseEdits);
  ctx.snapshot = adapter.history(ctx.messages);
  ctx.view = ctx.snapshot.messages;
  const released = flipReleasedMarks(state, releaseOptions);

  if (released.releasedCount > 0) {
    ctx.logs.push({
      event: "marks_released",
      fields: {
        sessionId,
        releasedCount: released.releasedCount,
        releasedTokens: released.releasedTokens,
        editCount: written.count,
        editTokens: written.tokens,
        pendingTokensBefore: curPendingTokens,
        promptTokens: ctx.promptTokens,
        ...(released.forced ? { forced: "view_change" } : {}),
      },
    });

    // Queue the user-visible notice: it is posted only after the commit
    // succeeds, so a lapsed permit reports no cleanup.  It reports the
    // written edits — a flip without an edit reclaimed nothing.
    if (written.count > 0) {
      ctx.notices.push(
        `上下文清理：已折叠 ${written.count} 个工具调用，约回收 ${formatTokens(written.tokens)} tokens`,
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
    state.pendingViewChange = true;
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
 * model cannot read.  Both producers consume the round's protection
 * map, so the active tail and every user instruction stay unmarked; an
 * absent map skips them with zero side effects.
 */
function producersPhase(ctx: PipelinePhaseContext): void {
  const { config, sessionId, state, snapshot } = ctx;
  const protection = ctx.protection;
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
        protection,
        protectedTools: dedupGate.protectedTools,
        prunedOrdinals,
      });
      if (result.created > 0) {
        ctx.logs.push({
          event: "dedup_marked",
          fields: {
            sessionId,
            markedCount: result.created,
            markedTokens: result.tokens,
          },
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
        protection,
        protectedTools: purgeGate.protectedTools,
        prunedOrdinals,
      });
      if (result.created > 0) {
        ctx.logs.push({
          event: "purge-errors_marked",
          fields: {
            sessionId,
            markedCount: result.created,
            markedTokens: result.tokens,
          },
        });
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Phase 5: publish + materialize the folded view
// ---------------------------------------------------------------------------

/**
 * Number and materialize the folded view.
 *
 * Per-round line refs used by the nudge and the compression tools (line
 * numbers are transient — valid for this round only).  The numbering runs
 * over the frozen snapshot the fold hashed, so the refs the model reads
 * and the refs the tools resolve cannot drift apart.  The round view —
 * including the protection map the read phase built — is frozen HERE,
 * before materializing renders the conversation: it must carry the
 * transcript the fold hashed, never the rendered one.  The commit
 * publishes it (see `contextPruningTransformHandler`).
 *
 * The render plan is computed here, once, over the lens the round's
 * edits landed in; the adapter only applies it.
 */
function publishPhase(ctx: PipelinePhaseContext): void {
  const { adapter, sessionId, state } = ctx;
  const numbered = numberView(
    ctx.foldedItems,
    (ordinal) => ctx.view[ordinal]?.hidden ?? true,
  );

  ctx.roundView = {
    projection: freezeProjection(ctx.snapshot),
    numbered: freezeNumberedView(numbered),
    protection: ctx.protection,
  };

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
    ctx.logs.push({
      event: "refs_assigned",
      fields: { sessionId, assigned: numbered.length },
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
 * the view the model was just rendered; the reclaim estimate measures
 * the pre-render projection, so it excludes the `[mN] ` line refs the
 * render injects.  The synthetic message is transform-only — appended at
 * the END, never persisted, never ref-assigned.
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
    protection: ctx.protection,
    ...ctx.eligibilityConfig,
  });
  if (decision === null || decision.text === null) return;

  ctx.messages = adapter.appendUserMessage(
    ctx.messages,
    "zoo-nudge",
    sessionId,
    decision.text,
  );

  // Stage the decision payload — every field is the post-write snapshot
  // the core evaluation persisted.
  ctx.logs.push({
    event: "nudge_injected",
    fields: {
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
    },
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
    ctx.toasts.push({
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
// Phase 7: summary
// ---------------------------------------------------------------------------

/** Effective-only accounting of one committed round. */
interface PruneSummary {
  /** Marks that are effective after this round. */
  prunedToolCount: number;
  /** Tokens reclaimed by the effective marks. */
  totalEff: number;
}

/**
 * Summarize the committed round.
 *
 * Effective-only accounting: pending marks are not yet visible, so neither
 * the count nor the reclaimed tokens include them.  The caller logs the
 * summary only after the commit succeeded.
 */
function summarizePhase(ctx: PipelinePhaseContext): PruneSummary {
  const state = ctx.state;
  let prunedToolCount = 0;
  for (const mark of state.marks.values()) {
    if (mark.effective) prunedToolCount += 1;
  }
  return { prunedToolCount, totalEff: reclaimedTokens(state) };
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * Run the context-pruning pipeline over the turn's transcript.
 *
 * Runs the host-agnostic context core over the turn's transcript (see
 * the module docstring for the phase order) inside one
 * `runtime.commit(permit, ...)`.  All host-specific operations go through
 * `adapter`; `messages` is treated as an opaque conversation.  The
 * user-visible notice and the nudge toast fire only after the commit
 * succeeded, and the log surface keeps its event contracts
 * (`prune_completed` counts effective marks only, `marks_released` carries
 * the forced field and reports the flipped marks and the written edits
 * apart, `nudge_injected` carries its payload).
 *
 * The adapter delivers into a private copy, so the input conversation is
 * never rewritten: a round that never committed returns it unchanged, and
 * a committed round returns the rendered conversation to use.
 *
 * @param runtime - The plugin instance's context records.
 * @param permit - The permit the host admitted this transform under.
 * @param adapter - The host adapter that projects and renders the host
 *   conversation.
 * @param messages - The session messages array from the transform output.
 * @param config - Unified context-pruning configuration.
 * @param notify - Optional callback for user-visible release notification.
 * @param hasCompressTool - Whether the `compress` tool is registered in
 *   the active mode profile.  Gates the nudge phase.  Defaults to false.
 * @param toast - Optional transient-UI port (source/level/text
 *   payload).  Fires on every nudge injection — the human-facing
 *   companion of the model nudge at the same watermark-ratchet
 *   decision point, adding no throttling state of its own.
 * @returns The conversation after pruning.
 */
export async function contextPruningTransformHandler(
  runtime: ContextRuntime,
  permit: WorkPermit,
  adapter: HostAdapter<unknown>,
  messages: unknown,
  config: ContextPruningConfig,
  notify?: (text: string) => void,
  hasCompressTool?: boolean,
  toast?: (payload: ToastPayload) => void,
): Promise<unknown> {
  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    return messages;
  }
  if (!permit.isActive()) return messages;

  const committed = await runtime.commit(permit, (state) => {
    const ctx = readPhase(runtime, permit, state, {
      adapter,
      messages,
      config,
      hasCompressTool,
      toast,
    });
    releasePhase(ctx);
    foldPhase(ctx);
    producersPhase(ctx);
    publishPhase(ctx);
    nudgePhase(ctx);
    return { ctx, summary: summarizePhase(ctx) };
  });
  if (committed === undefined) return messages;

  // The commit is the point of no return: the round's view, its notices and
  // its log lines belong to the committed state, so they follow the commit
  // even when the permit lapsed right after it.  Hand the compression tools
  // this round's address space: the transcript snapshot the fold ran over
  // plus the numbered view over it.  A `compress` call made mid-turn
  // therefore addresses exactly the `mN` lines the model was shown, with no
  // re-derivation from the host.
  runtime.publishRoundView(permit.sessionID, committed.ctx.roundView);

  for (const entry of committed.ctx.logs) {
    log.info({ hook: "context-pruning", event: entry.event, ...entry.fields });
  }
  for (const text of committed.ctx.notices) notify?.(text);
  for (const payload of committed.ctx.toasts) toast?.(payload);

  log.info({
    hook: "context-pruning",
    event: "prune_completed",
    sessionId: permit.sessionID,
    prunedToolCount: committed.summary.prunedToolCount,
    totalPruneTokens: committed.summary.totalEff,
    totalReclaimedTokens: committed.summary.totalEff,
  });

  return committed.ctx.messages;
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
 * `messages` type and may replace the array.  The pruned conversation is
 * written back into `output.messages` only for a committed round, so
 * downstream transform contributions observe the pruned view.
 *
 * @param runtime - The plugin instance's context records.
 * @param permit - The permit the host admitted this transform under.
 * @param output - The messages transform output.
 * @param config - Unified context-pruning configuration.
 * @param toolHost - Host tool services used to post the release
 *   notification and the nudge toast.  Undefined when the host wires no
 *   tool host — both are skipped.
 * @param hasCompressTool - Whether the `compress` tool is registered.
 * @param adapter - The host adapter for projecting and mutating the
 *   conversation.
 */
export async function handleContextPruning(
  runtime: ContextRuntime,
  permit: WorkPermit,
  output: TransformOutput,
  config: ContextPruningConfig,
  toolHost: ToolHost | undefined,
  hasCompressTool: boolean | undefined,
  adapter: HostAdapter<unknown>,
): Promise<void> {
  const sessionID = permit.sessionID;
  if (!permit.isActive()) return;
  try {
    output.messages = await contextPruningTransformHandler(
      runtime,
      permit,
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
