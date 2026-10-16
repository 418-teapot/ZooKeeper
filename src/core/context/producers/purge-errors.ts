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
 * Gating is shared with the dedup producer through `producers/gate.ts`:
 * the producer skips entirely without a caller-computed protected
 * window, below the message-count floor, and below the context-fraction
 * threshold; a `prunedOrdinals` predicate excludes messages already
 * folded or pruned.  All other semantics — error-status determination,
 * skip rules, the input zero-benefit gate, and the placeholder — are
 * defined below: only the failed call's input is pruned, never its
 * output.  The mark write itself is the shared first-write-wins
 * `addPendingMark` in `state.ts`.
 *
 * **Idempotency.**  A call whose region already holds a mark is never
 * re-marked.  The check covers both region keys of the call — the
 * tool-input key this producer writes and the linked tool-output key the
 * dedup producer writes — so a call claimed by any producer is
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
import { netReclaimTokens } from "../measure.js";
import { PRUNED_TOOL_ERROR_INPUT_REPLACEMENT } from "../message-parts.js";
import { addPendingMark, markKey, type SessionState } from "../state.js";
import type { ProducerGateOptions, ProducerRunResult } from "./gate.js";
import { checkProducerGate } from "./gate.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Options for the lens purge-errors producer — the shared gate options
 * (see `producers/gate.ts`).
 */
export type PurgeErrorsProducerOptions = ProducerGateOptions;

/**
 * Result of one purge-errors pass.
 */
export type PurgeErrorsRunResult = ProducerRunResult;

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
 * 2. Tool name in `protectedTools` → skip (undefined means no
 *    exclusions — neutral, never a default list).
 * 3. A mark already held by either of the call's regions — its
 *    tool-input key or its linked tool-output key — → skip the whole
 *    call (the output-region key covers marks written by the dedup
 *    producer).
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
 * @param options - Purge-errors options; the gate parameters
 *   (`minMessages`, `thresholdContext`) are required.
 * @returns The number of new marks and their total reclaim tokens.
 */
export function runPurgeErrors(
  state: SessionState,
  snapshot: Projection,
  options: PurgeErrorsProducerOptions,
): PurgeErrorsRunResult {
  const messages = snapshot.messages;
  const prunedOrdinals = options.prunedOrdinals;

  const gate = checkProducerGate(snapshot, options);
  if (gate === null) return { created: 0, tokens: 0 };
  const protectedStartOrdinal = gate.protectedStartOrdinal;

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
    if (options.protectedTools?.includes(invocation.name)) continue;

    const inputRegion =
      messages[inputRef.ordinal]?.regions[inputRef.regionIndex];
    if (inputRegion?.kind !== "tool-input") continue; // bad ref — abstain

    // Call-level idempotency: an existing mark on either region of the
    // call suppresses the whole call.  The output-region key is never
    // written here, but the dedup producer may hold it —
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
