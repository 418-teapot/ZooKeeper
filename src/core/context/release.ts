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
 *   gate opens  = pendingViewChange || (promptTokens > 0 && releasedPercent !== undefined)
 *   threshold   = releasedPercent !== undefined ? promptTokens * releasedPercent / 100 : 0
 *   release     = pendingViewChange || pendingTokens >= threshold
 *
 * `promptTokens` is the prompt-side total (last completed assistant's
 * input + cache read + cache write), the gate denominator — not the model
 * limit.  A `pendingViewChange` flag bypasses the gate entirely: when the
 * view changed last turn (fold debut, block deactivation, a compress or
 * decompress tool call) the cache is broken anyway, so every pending mark
 * flushes unconditionally, even with `promptTokens === 0` or an undefined
 * `releasedPercent`.  The flag is read here but owned by the caller, which
 * clears it after the phase.
 *
 * The module never touches `state.nudges`: the nudge watermark is updated
 * by the nudge phase independently, so release and nudge watermarks do not
 * interact.
 *
 * @module
 */

import type { HostMessage, RegionEdit, TextRegion } from "./lens.js";
import {
  PRUNED_TOOL_ERROR_INPUT_REPLACEMENT,
  PRUNED_TOOL_OUTPUT_REPLACEMENT,
} from "./measure.js";
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
   * View-change flag: when true the gate is bypassed and all pending
   * marks flush unconditionally.
   */
  pendingViewChange: boolean;
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
 * the dedup and sweep producers — uses the output placeholder.
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
 * Evaluate the releasedPercent gate.
 *
 * The gate formula, shared by the edit selection and the mark flip:
 *
 *   gate opens  = pendingViewChange || (promptTokens > 0 && releasedPercent !== undefined)
 *   threshold   = releasedPercent !== undefined ? promptTokens * releasedPercent / 100 : 0
 *   release     = pendingViewChange || pendingTokens >= threshold
 *
 * A closed gate (no bypass, no releasedPercent, promptTokens 0, zero
 * pending tokens, or pending tokens below the threshold) yields `null`.
 *
 * @param state - The session state; only the pending-token total is read.
 * @param options - Gate inputs, as for `computeEdits`.
 * @returns The forced flag, or null when the gate stays closed.
 */
function gateDecision(
  state: SessionState,
  options: ReleaseOptions,
): { forced: boolean } | null {
  if (
    !options.pendingViewChange &&
    !(options.promptTokens > 0 && options.releasedPercent !== undefined)
  ) {
    return null;
  }
  const curPendingTokens = pendingTokens(state);
  if (curPendingTokens <= 0) return null;
  const batchThreshold =
    options.releasedPercent !== undefined
      ? (options.promptTokens * options.releasedPercent) / 100
      : 0;
  if (!options.pendingViewChange && curPendingTokens < batchThreshold) {
    return null;
  }
  return { forced: options.pendingViewChange };
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
 * returns every effective mark's placeholder plus every pending mark
 * the releasedPercent gate would flip this call.  Unresolvable anchors
 * produce no edit (see `editFor`).  The gate decision is shared with
 * `flipReleasedMarks`, so the edit set and the flip set always agree on
 * which pending marks are released.
 *
 * The function never mutates `state` or `messages`: it only reads them
 * to select the edits; applying the result is the caller's job.
 *
 * @param state - The session state; only `marks` is read.
 * @param messages - The transcript; only anchor regions are read.
 * @param options - Gate inputs.
 * @returns The edits the release phase would write.
 */
export function computeEdits(
  state: SessionState,
  messages: HostMessage[] | undefined | null,
  options: ReleaseOptions,
): RegionEdit[] {
  if (!messages || messages.length === 0) return [];
  const edits: RegionEdit[] = [];

  // Apply phase: every effective mark (flipped in an earlier turn)
  // writes its placeholder.  Host reloads restore the original text
  // each turn, so effective marks always participate.
  for (const mark of state.marks.values()) {
    if (!mark.effective) continue;
    const edit = editFor(messages, mark);
    if (edit !== undefined) edits.push(edit);
  }

  // Release phase: pending marks that the gate would flip this call
  // join the edit batch.
  if (gateDecision(state, options) !== null) {
    for (const mark of state.marks.values()) {
      if (mark.effective) continue;
      const edit = editFor(messages, mark);
      if (edit !== undefined) edits.push(edit);
    }
  }

  return edits;
}

/**
 * Flip the pending marks the release gate releases, with no region
 * writes.
 *
 * The state half of the release phase: every pending mark is marked
 * effective (with `effectiveAt` / `releasedAt`) when the gate opens —
 * even a mark whose anchor is unresolvable on the transcript, matching
 * the two-turn lifecycle where the flip is independent of the write.
 * The placeholder text for flipped marks is produced by `computeEdits`;
 * applying those edits is the caller's job.
 *
 * The gate evaluation is shared with `computeEdits` (see
 * `gateDecision`), so the flipped set and the edit set never diverge.
 * A closed gate leaves every pending mark pending.
 *
 * @param state - The session state; pending marks are flipped in place.
 * @param options - Gate inputs and the optional flip timestamp.
 * @returns The release result: flipped count, flipped tokens, forced flag.
 */
export function flipReleasedMarks(
  state: SessionState,
  options: ReleaseOptions,
): ReleaseResult {
  if (gateDecision(state, options) === null) {
    return { releasedCount: 0, releasedTokens: 0, forced: false };
  }
  const now = options.now ?? Date.now();
  let releasedCount = 0;
  let releasedTokens = 0;
  for (const mark of state.marks.values()) {
    if (mark.effective) continue;
    mark.effective = true;
    mark.effectiveAt = now;
    mark.releasedAt = now;
    releasedCount++;
    releasedTokens += mark.contentTokens ?? 0;
  }
  return { releasedCount, releasedTokens, forced: options.pendingViewChange };
}
