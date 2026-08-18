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
 * The releasedPercent gate is migrated verbatim from the legacy hook's
 * Phase 5:
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
 * clears it after the phase (mirroring the legacy Phase 7 finalize).
 *
 * The module never touches `state.nudges`: the nudge watermark is updated
 * by the nudge phase independently, so release and nudge watermarks do not
 * interact (legacy Phase 5 vs Phase 6).
 *
 * @module
 */

import type { HostMessage, TextRegion } from "./lens.js";
import {
  PRUNED_TOOL_ERROR_INPUT_REPLACEMENT,
  PRUNED_TOOL_OUTPUT_REPLACEMENT,
} from "./measure.js";
import type { SessionState } from "./state.js";

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
 * Mirrors the legacy `releaseBatch` return semantics — the number of marks
 * actually flipped and their total estimated reclaim tokens — plus whether
 * the release was forced by the pendingViewChange bypass.
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
 * Write a mark's placeholder into its anchor region.
 *
 * Defensive by construction: an out-of-range anchor ordinal (the message
 * was compacted or folded away), an out-of-range region index, or a mark
 * without a region index is skipped silently — matching the legacy apply,
 * which iterates the live transcript and never errors on vanished
 * messages.  Re-applying to an already-replaced region writes the same
 * placeholder again, which is stable.
 *
 * @param messages - The transcript.
 * @param anchorOrdinal - The mark's message ordinal.
 * @param regionIndex - The mark's region index within the message.
 */
function applyMark(
  messages: HostMessage[],
  anchorOrdinal: number,
  regionIndex: number | undefined,
): void {
  if (regionIndex === undefined) return;
  const msg = messages[anchorOrdinal];
  if (!msg?.regions) return;
  const region = msg.regions[regionIndex];
  if (!region) return;
  region.set(placeholderFor(region));
}

/**
 * Run the release phase: apply effective marks, then evaluate the
 * releasedPercent gate and flip pending marks that pass it.
 *
 * Pipeline position: the start of a turn, before the producers.  The
 * phase is a no-op for an empty or nullish transcript (the legacy hook
 * returned before any phase), and a closed gate keeps pending marks
 * pending — they accumulate across turns until the threshold is reached,
 * the view-change bypass fires, or `releasedPercent: 0` opens the gate
 * for any positive pending total.
 *
 * @param state - The session state; marks are flipped in place.
 * @param messages - The transcript; effective marks write their
 *   placeholders into the anchor regions.
 * @param options - Gate inputs and the optional flip timestamp.
 * @returns The release result: flipped count, flipped tokens, forced flag.
 */
export function releaseMarks(
  state: SessionState,
  messages: HostMessage[] | undefined | null,
  options: ReleaseOptions,
): ReleaseResult {
  if (!messages || messages.length === 0) {
    return { releasedCount: 0, releasedTokens: 0, forced: false };
  }
  const now = options.now ?? Date.now();

  // Apply phase: every effective mark (flipped in an earlier turn) writes
  // its placeholder.  Host reloads restore the original text each turn,
  // so this must run on every release call, not only on flips.
  for (const mark of state.marks.values()) {
    if (!mark.effective) continue;
    applyMark(messages, mark.anchorOrdinal, mark.regionIndex);
  }

  // Release phase: the legacy hook's Phase 5 gate, verbatim.
  let releasedCount = 0;
  let releasedTokens = 0;
  let forced = false;
  if (
    options.pendingViewChange ||
    (options.promptTokens > 0 && options.releasedPercent !== undefined)
  ) {
    const curPendingTokens = pendingTokens(state);
    if (curPendingTokens > 0) {
      const batchThreshold =
        options.releasedPercent !== undefined
          ? (options.promptTokens * options.releasedPercent) / 100
          : 0;
      if (options.pendingViewChange || curPendingTokens >= batchThreshold) {
        forced = options.pendingViewChange;
        for (const mark of state.marks.values()) {
          if (mark.effective) continue;
          mark.effective = true;
          mark.effectiveAt = now;
          mark.releasedAt = now;
          releasedCount++;
          releasedTokens += mark.contentTokens ?? 0;
          applyMark(messages, mark.anchorOrdinal, mark.regionIndex);
        }
      }
    }
  }

  return { releasedCount, releasedTokens, forced };
}
