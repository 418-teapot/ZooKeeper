/**
 * Purge-errors producer over the host-agnostic context lens.
 *
 * Scans the transcript's invocation table for failed tool calls —
 * entries whose `status` is `"error"` — and writes a pending prune mark
 * for the call's tool-input region (replaced with
 * `PRUNED_TOOL_ERROR_INPUT_REPLACEMENT`).  Marks anchor to the
 * tool-input region only: key `(ordinal, regionIndex)` per
 * `state.markKey`, `effective=false` for the two-turn batch release
 * lifecycle.  Name, status and input address all come from the
 * invocation entry — the pairing is produced at projection time by the
 * host adapter, never re-derived from message layout here.  The module
 * reads tool regions only through `TextRegion` lenses and never
 * rewrites any region text.
 *
 * Gating is self-contained: the producer skips entirely without a
 * caller-computed protected window, below the message-count floor, and
 * below the context-fraction threshold; a `prunedOrdinals` predicate
 * excludes messages already folded or pruned.  All other semantics —
 * error-status determination, skip rules, the input zero-benefit gate,
 * and the placeholder — are defined below: only the failed call's input
 * is pruned, never its output.
 *
 * **Idempotency.**  A call whose region already holds a mark is never
 * re-marked.  The check covers both region keys of the call — the
 * tool-input key this producer writes and the linked tool-output key the
 * dedup/sweep producers write — so a call claimed by any producer is
 * left alone.  The output half comes from the invocation entry's output
 * address; a call whose output is not paired yet (in flight) has no
 * output key to check.
 *
 * **Content accounting.**  Following the shared producer convention
 * (see `producers/dedup.ts`), a mark's `contentTokens` carries the net
 * reclaim estimate — content estimate minus the placeholder estimate —
 * so the release phase can sum marks directly, and `content` is the
 * original region text truncated to the canonical snapshot cap.
 *
 * @module
 */

import type { Projection } from "../lens.js";
import { measureMessages, netReclaimTokens } from "../measure.js";
import { PRUNED_TOOL_ERROR_INPUT_REPLACEMENT } from "../message-parts.js";
import { markKey, RECALL_MAX_CHARS, type SessionState } from "../state.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Minimum non-hidden message count before purge-errors runs (default). */
const DEFAULT_MIN_MESSAGES = 20;

/** Fraction of the model context limit that opens the gate (default). */
const DEFAULT_THRESHOLD_CONTEXT = 0.5;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Options for the lens purge-errors producer.
 */
export interface PurgeErrorsProducerOptions {
  /**
   * Minimum non-hidden message count before the producer runs.
   * Defaults to 20; the producer skips when the count is not greater.
   */
  minMessages?: number;
  /**
   * Fraction of `contextLimit` that must be reached for marks to be
   * produced.  Defaults to 0.5; equality opens the gate.
   */
  thresholdContext?: number;
  /**
   * Model context window in tokens.  Undefined closes the gate
   * (fail-closed — the fraction cannot be evaluated).
   */
  contextLimit?: number;
  /**
   * First protected ordinal (inclusive): error calls at or after this
   * ordinal are never marked.  Computed by the caller from the
   * protected-messages window; undefined skips the producer entirely
   * (fail-safe when the window is not configured).
   * `messages.length` is an empty window.
   */
  protectedStartOrdinal?: number;
  /**
   * Tool names excluded from the strategy, matched case-sensitively.
   * Undefined → no exclusions (unlike dedup, which has its own default
   * list).
   */
  protectedTools?: string[];
  /**
   * Predicate over message ordinals reporting messages already folded
   * into a compression block or otherwise pruned; their tool calls are
   * never marked.
   */
  prunedOrdinals?: (ordinal: number) => boolean;
}

/**
 * Result of one purge-errors pass.
 */
export interface PurgeErrorsRunResult {
  /** Number of new pending marks written. */
  created: number;
  /** Total estimated reclaim tokens of the new marks. */
  tokens: number;
}

// ---------------------------------------------------------------------------
// Mark write
// ---------------------------------------------------------------------------

/**
 * Write a pending prune mark, first-write-wins.
 *
 * The clamp — a position that already holds a mark is never overwritten
 * — keeps mark writes idempotent: `state.ts` exposes no `addMark` helper,
 * so the write guard lives in this module until the release-gate phase
 * centralises mark writes.
 *
 * @param state - The session state to write into.
 * @param ordinal - The message ordinal the mark anchors to.
 * @param regionIndex - The tool region index within the message; absent
 *   means an empty key and the mark is refused (defensive).
 * @param content - The original region text (content snapshot).
 * @param contentTokens - Estimated reclaim tokens of the region.
 * @param now - Timestamp for the mark.
 * @returns True when the mark was written, false when the position was
 *   already claimed or the key is empty.
 */
function addPendingMark(
  state: SessionState,
  ordinal: number,
  regionIndex: number | undefined,
  content: string,
  contentTokens: number,
  now: number,
): boolean {
  if (regionIndex === undefined) return false;
  const key = markKey(ordinal, regionIndex);
  if (state.marks.has(key)) return false;
  state.marks.set(key, {
    anchorOrdinal: ordinal,
    regionIndex,
    content: content.slice(0, RECALL_MAX_CHARS),
    contentTokens,
    effective: false,
    markedAt: now,
  });
  return true;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Run purge-errors over the transcript: scan the invocation table for
 * error-status calls and write pending marks for their input regions.
 *
 * Gating order: an absent protected window skips everything (fail-safe),
 * then the message-count floor, then the context-fraction threshold.
 * Hidden messages still participate in the scan; the message-count floor
 * counts non-hidden messages.
 *
 * Per error call the skip chain is:
 * 1. Protected window / already-folded-or-pruned ordinal → skip.
 * 2. Tool name in `protectedTools` → skip (no default list).
 * 3. A mark already held by either of the call's regions — its
 *    tool-input key or its linked tool-output key — → skip the whole
 *    call (the output-region key covers marks written by the dedup and
 *    sweep producers).
 * 4. Input reclaim not positive — input text estimate does not exceed
 *    the error-input placeholder estimate — → skip the call entirely.
 *
 * When the call survives, only its tool-input region is marked; the
 * output region is never touched.
 *
 * @param state - The session state; `state.marks` is read to skip
 *   already-claimed calls and written with new pending marks.
 * @param snapshot - The projection snapshot: the region view plus the
 *   invocation table this producer scans.
 * @param options - Purge-errors options; all fields optional.
 * @returns The number of new marks and their total reclaim tokens.
 */
export function runPurgeErrors(
  state: SessionState,
  snapshot: Projection,
  options: PurgeErrorsProducerOptions = {},
): PurgeErrorsRunResult {
  const messages = snapshot.messages;
  const minMessages = options.minMessages ?? DEFAULT_MIN_MESSAGES;
  const thresholdContext =
    options.thresholdContext ?? DEFAULT_THRESHOLD_CONTEXT;
  const protectedTools = options.protectedTools;
  const prunedOrdinals = options.prunedOrdinals;

  // Fail-safe: without a protection window the producer is skipped with
  // zero side effects.
  if (options.protectedStartOrdinal === undefined) {
    return { created: 0, tokens: 0 };
  }
  const protectedStartOrdinal = options.protectedStartOrdinal;

  if (!messages || messages.length === 0) {
    return { created: 0, tokens: 0 };
  }
  const measured = measureMessages(messages);
  if (measured.messageCount <= minMessages) {
    return { created: 0, tokens: 0 };
  }

  // Context gate: unknown model limit closes the gate; equality opens it.
  if (options.contextLimit === undefined) {
    return { created: 0, tokens: 0 };
  }
  if (measured.total < options.contextLimit * thresholdContext) {
    return { created: 0, tokens: 0 };
  }

  let created = 0;
  let tokens = 0;
  const now = Date.now();

  // Each error invocation of the projection's table is one failed call.
  // Entries the table does not pair are never re-derived from layout —
  // they simply do not appear here (fail-closed).
  for (const invocation of snapshot.invocations) {
    if (invocation.status !== "error") continue;
    const inputRef = invocation.input;
    if (prunedOrdinals?.(inputRef.ordinal)) continue;
    if (inputRef.ordinal >= protectedStartOrdinal) continue;
    if (protectedTools?.includes(invocation.name)) continue;

    const inputRegion =
      messages[inputRef.ordinal]?.regions[inputRef.regionIndex];
    if (inputRegion?.kind !== "tool-input") continue; // bad ref — abstain

    // Call-level idempotency: an existing mark on either region of the
    // call suppresses the whole call.  The output-region key is never
    // written here, but the dedup/sweep producers may hold it —
    // resolved through the invocation's output address.
    if (state.marks.has(markKey(inputRef.ordinal, inputRef.regionIndex))) {
      continue;
    }
    const outputRef = invocation.output;
    if (
      outputRef !== undefined &&
      state.marks.has(markKey(outputRef.ordinal, outputRef.regionIndex))
    ) {
      continue;
    }

    const input = inputRegion.get();
    const inputReclaim = netReclaimTokens(
      input,
      PRUNED_TOOL_ERROR_INPUT_REPLACEMENT,
    );
    // Zero-benefit gate: without positive input reclaim the call is
    // skipped entirely.
    if (inputReclaim <= 0) continue;

    if (
      addPendingMark(
        state,
        inputRef.ordinal,
        inputRef.regionIndex,
        input,
        inputReclaim,
        now,
      )
    ) {
      created += 1;
      tokens += inputReclaim;
    }
  }

  return { created, tokens };
}
