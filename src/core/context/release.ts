/**
 * Release phase of the mark lifecycle over the host-agnostic lens.
 *
 * The release phase runs at the **start** of a turn, before the producers
 * write new marks — the pipeline position that realises the two-turn
 * lifecycle: a pending mark created in turn N is flipped to effective and
 * applied (its placeholder written) by the release call of turn N+1, so
 * the model never sees the same turn's own pruning.  Effective marks are
 * re-applied on every call because the host reloads the transcript fresh
 * each turn; re-writing an already-replaced region is stable.
 *
 * The release gate decides whether pending marks flip this turn:
 *
 *   eligible    = pending marks anchored outside the protection map
 *   gate opens  = pendingViewChange || (promptTokens > 0 && releasedPercent !== undefined)
 *   threshold   = releasedPercent !== undefined ? promptTokens * releasedPercent / 100 : 0
 *   release     = pendingViewChange || eligibleTokens >= threshold
 *
 * `promptTokens` is the prompt-side total (last completed assistant's
 * input + cache read + cache write), the gate denominator — not the model
 * limit.  A `pendingViewChange` flag bypasses the gate entirely: when the
 * view changed last turn (fold debut, a block turning stale, a compress or
 * decompress tool call) the cache is broken anyway, so every eligible
 * pending mark flushes unconditionally, even with `promptTokens === 0` or
 * an undefined `releasedPercent`.  The flag bypasses the batch threshold
 * only — it never bypasses protection.  The flag is read here but owned by
 * the caller, which clears it after the phase.
 *
 * Protection applies when the phase takes effect: a mark anchored at a
 * protected ordinal (the active tail or a user instruction, per
 * `isProtectedOrdinal`) writes no placeholder and does not flip.  An
 * ordinal outside the round's transcript is not protected — the anchor
 * vanished, so the mark still flips but writes no edit.  A protected
 * effective mark keeps its record and is re-applied once its ordinal
 * leaves the protected region; a protected pending mark stays pending.
 * Without the round's protection map the phase fails closed — no edit is
 * generated and no pending mark flips.
 *
 * The whole phase runs off one internal release plan, shared by
 * `computeEdits` and `flipReleasedMarks`, so the edit set and the flip set
 * always agree.
 *
 * The module never touches `state.nudges`: the nudge watermark is updated
 * by the nudge phase independently, so release and nudge watermarks do not
 * interact.
 *
 * `materializeEffectiveMarks` is the read-side twin of `computeEdits`: a
 * consumer that reports over storage overlays the effective marks through
 * it so the report counts exactly what the release phase writes into the
 * model-bound copy.  It reads the same protection map, so a protected
 * mark is reported with its stored text.
 *
 * @module
 */

import type { HostMessage, RegionEdit, TextRegion } from "./lens.js";
import {
  PRUNED_TOOL_ERROR_INPUT_REPLACEMENT,
  PRUNED_TOOL_OUTPUT_REPLACEMENT,
} from "./measure.js";
import { isProtectedOrdinal, type ProtectionMap } from "./protection-map.js";
import type { Mark, SessionState } from "./state.js";

// ---------------------------------------------------------------------------
// Derived stats
// ---------------------------------------------------------------------------

/**
 * Count of marks that are not yet effective (pending batch release).
 *
 * @param state - The session state.
 * @returns Number of pending (non-effective) marks.
 */
export function pendingCount(state: SessionState): number {
  let count = 0;
  for (const mark of state.marks.values()) {
    if (!mark.effective) count++;
  }
  return count;
}

/**
 * Total estimated reclaim tokens of all pending (non-effective) marks.
 *
 * @param state - The session state.
 * @returns Sum of `contentTokens` across non-effective marks.
 */
export function pendingTokens(state: SessionState): number {
  let sum = 0;
  for (const mark of state.marks.values()) {
    if (!mark.effective) sum += mark.contentTokens ?? 0;
  }
  return sum;
}

/**
 * Total estimated reclaim tokens of all effective marks.
 *
 * @param state - The session state.
 * @returns Sum of `contentTokens` across effective marks.
 */
export function reclaimedTokens(state: SessionState): number {
  let sum = 0;
  for (const mark of state.marks.values()) {
    if (mark.effective) sum += mark.contentTokens ?? 0;
  }
  return sum;
}

// ---------------------------------------------------------------------------
// Release phase
// ---------------------------------------------------------------------------

/**
 * Options for the release phase.
 */
export interface ReleaseOptions {
  /**
   * Prompt-side token total (last completed assistant's input + cache
   * read + cache write); the gate denominator.
   */
  promptTokens: number;
  /**
   * `released_percent` threshold; undefined closes the gate entirely
   * (pending retained unless the view-change bypass applies).
   */
  releasedPercent?: number;
  /**
   * View-change flag: when true the gate is bypassed and every eligible
   * pending mark flushes unconditionally.  It never bypasses protection.
   */
  pendingViewChange: boolean;
  /**
   * This round's protection map.  Undefined fails closed: no edit is
   * generated and no pending mark flips.
   */
  protection?: ProtectionMap;
  /**
   * Timestamp for marks flipped by this call; defaults to `Date.now()`.
   */
  now?: number;
}

/**
 * Result of one release call.
 *
 * Reports the number of marks flipped from pending to effective by this
 * call, their total estimated reclaim tokens, and whether the release
 * was forced by the pendingViewChange bypass.
 */
export interface ReleaseResult {
  /** Marks flipped from pending to effective by this call. */
  releasedCount: number;
  /** Total estimated reclaim tokens of the flipped marks. */
  releasedTokens: number;
  /** True when the flip happened due to the view-change bypass. */
  forced: boolean;
}

/**
 * Pick the placeholder for a mark's region.
 *
 * The `Mark` type carries no prune-action field, so the discriminator is
 * the anchor region's kind: a `tool-input` mark (written by the
 * purge-errors producer for a failed call) is replaced with the
 * error-input placeholder; every other mark — tool-output anchors from
 * the dedup producer — uses the output placeholder.
 *
 * @param region - The region the mark anchors to.
 * @returns The verbatim placeholder constant for the region's kind.
 */
function placeholderFor(region: TextRegion): string {
  return region.kind === "tool-input"
    ? PRUNED_TOOL_ERROR_INPUT_REPLACEMENT
    : PRUNED_TOOL_OUTPUT_REPLACEMENT;
}

/**
 * The gate's release plan for this call.
 *
 * Shared by the edit selection and the mark flip, so both always operate
 * on the same eligible pending marks.
 */
interface ReleasePlan {
  /** True when the view-change bypass opened the gate. */
  forced: boolean;
  /** Pending marks released by this call, in collection order. */
  marks: Mark[];
}

/**
 * Build the release plan for this call.
 *
 * The gate formula, shared by the edit selection and the mark flip:
 *
 *   eligible    = pending marks anchored outside the protection map
 *   gate opens  = pendingViewChange || (promptTokens > 0 && releasedPercent !== undefined)
 *   threshold   = releasedPercent !== undefined ? promptTokens * releasedPercent / 100 : 0
 *   release     = pendingViewChange || eligibleTokens >= threshold
 *
 * The batch threshold measures the eligible tokens only: a pending mark
 * sitting in the protected region never counts toward releasing the
 * others.  A closed gate — an absent protection map, no bypass and no
 * releasedPercent, `promptTokens` 0, or no eligible tokens — yields
 * `null`.
 *
 * @param state - The session state; only the marks are read.
 * @param options - Gate inputs, as for `computeEdits`.
 * @returns The release plan, or null when the gate stays closed.
 */
function releasePlan(
  state: SessionState,
  options: ReleaseOptions,
): ReleasePlan | null {
  const protection = options.protection;
  if (protection === undefined) return null;
  if (
    !options.pendingViewChange &&
    !(options.promptTokens > 0 && options.releasedPercent !== undefined)
  ) {
    return null;
  }
  const marks: Mark[] = [];
  let eligibleTokens = 0;
  for (const mark of state.marks.values()) {
    if (mark.effective) continue;
    if (isProtectedOrdinal(protection, mark.anchorOrdinal)) continue;
    marks.push(mark);
    eligibleTokens += mark.contentTokens ?? 0;
  }
  if (eligibleTokens <= 0) return null;
  const batchThreshold =
    options.releasedPercent !== undefined
      ? (options.promptTokens * options.releasedPercent) / 100
      : 0;
  if (!options.pendingViewChange && eligibleTokens < batchThreshold) {
    return null;
  }
  return { forced: options.pendingViewChange, marks };
}

/**
 * Build the edit one mark would write, or undefined when the anchor is
 * not resolvable on the current transcript.
 *
 * A mark without a region index, a vanished anchor message, or an
 * out-of-range region index produces no edit — the application site is
 * gone, so nothing is written.
 *
 * @param messages - The transcript.
 * @param mark - The mark to translate.
 * @returns The region edit, or undefined for an unresolvable anchor.
 */
function editFor(messages: HostMessage[], mark: Mark): RegionEdit | undefined {
  if (mark.regionIndex === undefined) return undefined;
  const region = messages[mark.anchorOrdinal]?.regions?.[mark.regionIndex];
  if (!region) return undefined;
  return {
    messageOrdinal: mark.anchorOrdinal,
    regionIndex: mark.regionIndex,
    text: placeholderFor(region),
  };
}

/**
 * Compute the region edits the release phase would write, without
 * applying them.
 *
 * Pure selection: for the given state, transcript, and options it
 * returns every unprotected effective mark's placeholder plus the
 * placeholder of every pending mark the release plan flips this call.
 * An effective mark whose anchor is currently protected writes nothing
 * this round (its record stays).  Unresolvable anchors produce no edit
 * (see `editFor`).  An absent protection map yields no edits.  The plan
 * is shared with `flipReleasedMarks`, so the edit set and the flip set
 * always agree on which pending marks are released.
 *
 * The function never mutates `state` or `messages`: it only reads them
 * to select the edits; applying the result is the caller's job.
 *
 * @param state - The session state; only `marks` is read.
 * @param messages - The transcript; only anchor regions are read.
 * @param options - Gate inputs, including this round's protection map.
 * @returns The edits the release phase would write.
 */
export function computeEdits(
  state: SessionState,
  messages: HostMessage[] | undefined | null,
  options: ReleaseOptions,
): RegionEdit[] {
  const protection = options.protection;
  if (protection === undefined) return [];
  if (!messages || messages.length === 0) return [];
  const edits: RegionEdit[] = [];

  // Apply phase: every unprotected effective mark (flipped in an earlier
  // turn) writes its placeholder.  Host reloads restore the original text
  // each turn, so effective marks participate every round until their
  // ordinal enters the protected region.
  for (const mark of state.marks.values()) {
    if (!mark.effective) continue;
    if (isProtectedOrdinal(protection, mark.anchorOrdinal)) continue;
    const edit = editFor(messages, mark);
    if (edit !== undefined) edits.push(edit);
  }

  // Release phase: the pending marks the release plan flips this call
  // join the edit batch.
  const plan = releasePlan(state, options);
  if (plan === null) return edits;
  for (const mark of plan.marks) {
    const edit = editFor(messages, mark);
    if (edit !== undefined) edits.push(edit);
  }

  return edits;
}

/**
 * Overlay the effective prune marks onto a transcript as placeholders.
 *
 * The read-side twin of `computeEdits`: where that returns the edits the
 * release phase writes into the model-bound copy, this returns a
 * transcript whose effective-mark regions read back the same placeholder
 * — so a consumer that reports over storage (the sidebar, `/dcp`) counts
 * a pruned tool call as `input + placeholder` instead of the stored
 * original output.  Both share the `(ordinal, regionIndex)` address
 * vocabulary, `isProtectedOrdinal` and `placeholderFor`, so the report
 * and the transform always agree on what was pruned and where.
 *
 * The overlay follows the release phase's protection: an effective mark
 * inside the protection map writes nothing, so it is not overlaid here
 * either and its stored original stays visible.  Pending marks are not
 * overlaid — they are not yet written to any view.  An unresolvable
 * anchor (missing message or region, or a mark without a region index)
 * is skipped, exactly as `editFor` does, and a transcript with no
 * overlaid mark is returned by reference.
 *
 * @param messages - The transcript; ordinals must align with the marks.
 * @param state - The session state holding the mark map.
 * @param protection - The protection map of the same snapshot;
 *   undefined overlays nothing (fail-closed: no known write target).
 * @returns The transcript with the unprotected effective marks
 *   overlaid.
 */
export function materializeEffectiveMarks(
  messages: HostMessage[],
  state: SessionState,
  protection: ProtectionMap | undefined,
): HostMessage[] {
  if (protection === undefined) return messages;
  const indicesByOrdinal = new Map<number, number[]>();
  for (const mark of state.marks.values()) {
    if (!mark.effective || mark.regionIndex === undefined) continue;
    if (isProtectedOrdinal(protection, mark.anchorOrdinal)) continue;
    const indices = indicesByOrdinal.get(mark.anchorOrdinal);
    if (indices) indices.push(mark.regionIndex);
    else indicesByOrdinal.set(mark.anchorOrdinal, [mark.regionIndex]);
  }
  if (indicesByOrdinal.size === 0) return messages;

  const result = messages.slice();
  for (const [ordinal, indices] of indicesByOrdinal) {
    const message = messages[ordinal];
    if (!message) continue;
    const regions = message.regions.slice();
    let changed = false;
    for (const regionIndex of indices) {
      const region = regions[regionIndex];
      if (!region) continue;
      regions[regionIndex] = {
        kind: region.kind,
        get: () => placeholderFor(region),
      };
      changed = true;
    }
    if (changed) result[ordinal] = { ...message, regions };
  }
  return result;
}

/**
 * Flip the pending marks the release plan releases, with no region
 * writes.
 *
 * The state half of the release phase: every pending mark of the plan is
 * marked effective (with `effectiveAt` / `releasedAt`) — even a mark
 * whose anchor is unresolvable on the transcript, matching the two-turn
 * lifecycle where the flip is independent of the write.  A pending mark
 * anchored inside the protection map is not part of the plan and stays
 * pending.  The placeholder text for flipped marks is produced by
 * `computeEdits`; applying those edits is the caller's job.
 *
 * The plan is shared with `computeEdits` (see `releasePlan`), so the
 * flipped set and the edit set never diverge.  A closed gate leaves
 * every pending mark pending.
 *
 * @param state - The session state; pending marks are flipped in place.
 * @param options - Gate inputs and the optional flip timestamp.
 * @returns The release result: flipped count, flipped tokens, forced flag.
 */
export function flipReleasedMarks(
  state: SessionState,
  options: ReleaseOptions,
): ReleaseResult {
  const plan = releasePlan(state, options);
  if (plan === null) {
    return { releasedCount: 0, releasedTokens: 0, forced: false };
  }
  const now = options.now ?? Date.now();
  let releasedCount = 0;
  let releasedTokens = 0;
  for (const mark of plan.marks) {
    mark.effective = true;
    mark.effectiveAt = now;
    mark.releasedAt = now;
    releasedCount++;
    releasedTokens += mark.contentTokens ?? 0;
  }
  return { releasedCount, releasedTokens, forced: plan.forced };
}
