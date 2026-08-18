/**
 * Sweep producer over the host-agnostic context lens.
 *
 * Marks expired tool outputs for placeholder replacement.  The window
 * opens right after the last non-hidden user message, so assistant tool
 * results produced since the user's last instruction are sweepable.
 * Marks anchor to the tool-output region — key `(ordinal, regionIndex)`
 * per `state.markKey`, `effective=false` for the two-turn batch release
 * lifecycle.  The module reads tool regions only through `TextRegion`
 * lenses and never rewrites any region text.
 *
 * Gating is self-contained: the producer skips entirely without a
 * caller-computed protected window, below the context-fraction
 * threshold (`sweep_threshold_context`, default 0.80 of the model
 * limit), and when the model limit is unknown (fail-closed).  The
 * window and skip rules — last non-hidden user message boundary,
 * already-pruned placeholder detection, folded-message exclusion,
 * completed-status filtering, and the block-protection switch
 * (`sweep_protected_blocks`, default false) — are migrated from the
 * legacy `/dcp sweep` semantics: with the switch off, tool outputs
 * inside an active compression block are still swept (the block's span
 * hash excludes tool-output text, so the block survives); with it on,
 * messages inside active blocks are skipped.
 *
 * The legacy sweep producer never consulted a `protectedTools` list, so
 * this producer does not either — every tool name is sweepable inside
 * the window.
 *
 * @module
 */

import type { HostMessage } from "../lens.js";
import { findLastUserOrdinal } from "../lens.js";
import { measureMessages, netReclaimTokens } from "../measure.js";
import { PRUNED_TOOL_OUTPUT_REPLACEMENT } from "../message-parts.js";
import { markKey, RECALL_MAX_CHARS, type SessionState } from "../state.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Fraction of the model context limit that opens the gate (default). */
const DEFAULT_THRESHOLD_CONTEXT = 0.8;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Options for the lens sweep producer.
 */
export interface SweepProducerOptions {
  /**
   * Fraction of `contextLimit` that must be reached for marks to be
   * produced.  Defaults to 0.80; equality opens the gate.
   */
  thresholdContext?: number;
  /**
   * Model context window in tokens.  Undefined closes the gate
   * (fail-closed — the fraction cannot be evaluated).
   */
  contextLimit?: number;
  /**
   * First protected ordinal (inclusive): tool-output regions at or
   * after this ordinal are never marked.  Computed by the caller from
   * the protected-messages window; undefined skips the producer
   * entirely (legacy fail-safe when the window is not configured).
   * `messages.length` is an empty window.
   */
  protectedStartOrdinal?: number;
  /**
   * Predicate over message ordinals reporting messages already folded
   * into a compression block or otherwise pruned; their tool calls are
   * never marked.
   */
  prunedOrdinals?: (ordinal: number) => boolean;
  /**
   * Whether messages inside an active compression block are protected
   * from sweeping.  Defaults to false — with the switch off, in-block
   * tool outputs may still be marked (the span hash excludes tool-output
   * text, so blocks survive the replacement).
   */
  sweepProtectedBlocks?: boolean;
}

/**
 * Result of one sweep pass.
 */
export interface SweepRunResult {
  /** Number of new pending marks written. */
  created: number;
  /** Total estimated reclaim tokens of the new marks. */
  tokens: number;
}

// ---------------------------------------------------------------------------
// Block coverage
// ---------------------------------------------------------------------------

/**
 * Check whether an ordinal falls inside any active compression block.
 *
 * @param state - The session state holding the block map.
 * @param ordinal - The message ordinal to test.
 * @returns True when an active block's interval contains the ordinal.
 */
function inActiveBlock(state: SessionState, ordinal: number): boolean {
  for (const block of state.blocks.values()) {
    if (!block.active) continue;
    if (block.start <= ordinal && ordinal < block.end) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Mark write
// ---------------------------------------------------------------------------

/**
 * Write a pending prune mark, first-write-wins.
 *
 * The clamp — a position that already holds a mark is never overwritten
 * — is the legacy `addMark` idempotency contract migrated here: the new
 * `state.ts` has no `addMark` helper yet, so the write guard lives in
 * this module until the release-gate phase centralises mark writes.
 *
 * @param state - The session state to write into.
 * @param ordinal - The message ordinal the mark anchors to.
 * @param regionIndex - The tool-output region index within the message;
 *   absent means an empty key and the mark is refused (defensive).
 * @param output - The original output text (content snapshot).
 * @param contentTokens - Estimated reclaim tokens of the output.
 * @param now - Timestamp for the mark.
 * @returns True when the mark was written, false when the position was
 *   already claimed or the key is empty.
 */
function addPendingMark(
  state: SessionState,
  ordinal: number,
  regionIndex: number | undefined,
  output: string,
  contentTokens: number,
  now: number,
): boolean {
  if (regionIndex === undefined) return false;
  const key = markKey(ordinal, regionIndex);
  if (state.marks.has(key)) return false;
  state.marks.set(key, {
    anchorOrdinal: ordinal,
    regionIndex,
    content: output.slice(0, RECALL_MAX_CHARS),
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
 * Run sweep over the transcript: mark every completed tool output after
 * the last non-hidden user message with a pending prune mark.
 *
 * Gating order mirrors the legacy hook: an absent protected window
 * skips everything (fail-safe), then the context-fraction threshold,
 * with an unknown model limit closing the gate.  Within the window the
 * skip chain is: folded-or-pruned ordinal (caller predicate), protected
 * window, hidden message, active-block interval (when the switch is
 * on), already-pruned output (placeholder-prefixed), and non-completed
 * call status.
 *
 * @param state - The session state; `state.marks` is read to skip
 *   already-claimed positions and written with new pending marks.
 * @param messages - The transcript.
 * @param options - Sweep options; all fields optional.
 * @returns The number of new marks and their total reclaim tokens.
 */
export function runSweep(
  state: SessionState,
  messages: HostMessage[],
  options: SweepProducerOptions = {},
): SweepRunResult {
  const thresholdContext =
    options.thresholdContext ?? DEFAULT_THRESHOLD_CONTEXT;
  const prunedOrdinals = options.prunedOrdinals;
  const sweepProtectedBlocks = options.sweepProtectedBlocks ?? false;

  // Fail-safe: without a protection window the producer is skipped with
  // zero side effects (legacy contract when the window is not set).
  if (options.protectedStartOrdinal === undefined) {
    return { created: 0, tokens: 0 };
  }
  const protectedStartOrdinal = options.protectedStartOrdinal;

  if (!messages || messages.length === 0) {
    return { created: 0, tokens: 0 };
  }

  // Context gate: unknown model limit closes the gate; equality opens it.
  if (options.contextLimit === undefined) {
    return { created: 0, tokens: 0 };
  }
  const measured = measureMessages(messages);
  if (measured.total < options.contextLimit * thresholdContext) {
    return { created: 0, tokens: 0 };
  }

  // Window: only tool outputs after the last non-hidden user message are
  // expired; without one there is nothing to sweep.
  const lastUserOrdinal = findLastUserOrdinal(messages);
  if (lastUserOrdinal < 0) {
    return { created: 0, tokens: 0 };
  }

  let created = 0;
  let tokens = 0;
  const now = Date.now();

  for (
    let ordinal = lastUserOrdinal + 1;
    ordinal < messages.length;
    ordinal++
  ) {
    const msg = messages[ordinal];
    if (!msg?.regions) continue;
    if (prunedOrdinals?.(ordinal)) continue;
    if (ordinal >= protectedStartOrdinal) continue;
    if (msg.hidden) continue;
    if (sweepProtectedBlocks && inActiveBlock(state, ordinal)) continue;

    for (let regionIndex = 0; regionIndex < msg.regions.length; regionIndex++) {
      const region = msg.regions[regionIndex];
      if (!region) continue;
      if (region.kind !== "tool-output") continue;

      // Only completed calls are expired.
      const status = region.tool?.status;
      if (status !== undefined && status !== "completed") continue;

      const output = region.get();
      // Already replaced in a previous round — never marked twice.
      if (output.startsWith(PRUNED_TOOL_OUTPUT_REPLACEMENT)) continue;

      const estimatedTokens = netReclaimTokens(
        output,
        PRUNED_TOOL_OUTPUT_REPLACEMENT,
      );

      if (
        addPendingMark(
          state,
          ordinal,
          regionIndex,
          output,
          estimatedTokens,
          now,
        )
      ) {
        created += 1;
        tokens += estimatedTokens;
      }
    }
  }

  return { created, tokens };
}
