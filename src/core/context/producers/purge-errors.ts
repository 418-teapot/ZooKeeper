/**
 * Purge-errors producer over the host-agnostic context lens.
 *
 * Scans the transcript for failed tool calls — regions whose tool
 * metadata carries `status === "error"` — and writes a pending prune
 * mark for the call's tool-input region (replaced with
 * `PRUNED_TOOL_ERROR_INPUT_REPLACEMENT`).  Marks anchor to the
 * tool-input region only: key `(ordinal, regionIndex)` per
 * `state.markKey`, `effective=false` for the two-turn batch release
 * lifecycle.  The module reads tool regions only through `TextRegion`
 * lenses and never rewrites any region text.
 *
 * Gating is self-contained: the producer skips entirely without a
 * caller-computed protected window, below the message-count floor, and
 * below the context-fraction threshold; a `prunedOrdinals` predicate
 * excludes messages already folded or pruned.  All other semantics —
 * error-status determination, skip rules, the input zero-benefit gate,
 * and the placeholder — are migrated verbatim from the legacy
 * `pruning/producers/purge-errors.ts`, which prunes the failed call's
 * input only and never touches its output.
 *
 * **Idempotency.**  The legacy producer skipped a call whose callID
 * already held a mark (the marks map is callID-scoped and shared with
 * the dedup/sweep producers).  The lens equivalent checks both region
 * keys of the call — the tool-input key this producer writes and the
 * linked tool-output key the dedup/sweep producers write — so a call
 * claimed by any producer is never re-marked.  The output half is
 * resolved through the input region's positional `ToolMeta.output`
 * reference when the host supplies one (pi — the pair spans two
 * messages) and falls back to the same-message sibling scan otherwise
 * (v1 — both halves of a call live in one message).
 *
 * **Content accounting.**  Following the shared producer convention
 * (see `producers/dedup.ts`), a mark's `contentTokens` carries the net
 * reclaim estimate — content estimate minus the placeholder estimate —
 * so the release phase can sum marks directly, and `content` is the
 * original region text truncated to the canonical snapshot cap.
 *
 * @module
 */

import type { HostMessage } from "../lens.js";
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
   * (legacy fail-safe when the window is not configured).
   * `messages.length` is an empty window.
   */
  protectedStartOrdinal?: number;
  /**
   * Tool names excluded from the strategy, matched case-sensitively.
   * Undefined → no exclusions — the legacy purge-errors producer had
   * no default list (unlike dedup, whose default list is its own).
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
// Region pairing
// ---------------------------------------------------------------------------

/**
 * Find the tool-output region that belongs to a tool-input region.
 *
 * Two host layouts are supported:
 *
 * - **Positional reference (pi).**  The input region's `ToolMeta.output`
 *   carries the address of the linked tool-output region — the message
 *   ordinal and region index of the tool-result half of the call, which
 *   lives in its own message.  This is the host-agnostic core vocabulary
 *   and is preferred whenever present.
 * - **Same-message sibling (v1).**  The lens carries no call
 *   identifiers, so pairing falls back on the v1 layout contract: each
 *   call's input/output pair is adjacent, and both regions of a call
 *   share the same tool name and status.  The sibling is the first
 *   region after the input whose kind is `tool-output` with a matching
 *   tool name and an `"error"` status.
 *
 * The output region itself is never marked — it is looked up only so
 * the call-level idempotency check can test the output-region mark key
 * (see `runPurgeErrors`).
 *
 * @param messages - The transcript.
 * @param inputOrdinal - Ordinal of the message holding the call.
 * @param inputIndex - Index of the tool-input region within that message.
 * @param toolName - The call's tool name.
 * @returns The output region's `(ordinal, regionIndex)`, or undefined
 *   when none exists.
 */
function findErrorOutputRegion(
  messages: HostMessage[],
  inputOrdinal: number,
  inputIndex: number,
  toolName: string,
): { ordinal: number; regionIndex: number } | undefined {
  const inputRegion = messages[inputOrdinal]?.regions[inputIndex];

  // Positional reference (pi): the address points at the linked
  // tool-result message's tool-output region.  Defensive: the address
  // must resolve to a real tool-output region of the same tool.
  const ref = inputRegion?.tool?.output;
  if (ref !== undefined) {
    const regionIndex = ref.regionIndex ?? 0;
    const region = messages[ref.ordinal]?.regions[regionIndex];
    if (region?.kind === "tool-output" && region.tool?.name === toolName) {
      return { ordinal: ref.ordinal, regionIndex };
    }
    return undefined;
  }

  // Same-message sibling (v1): scan forward for the adjacent output.
  const msg = messages[inputOrdinal];
  for (let i = inputIndex + 1; i < msg.regions.length; i++) {
    const region = msg.regions[i];
    if (!region) continue;
    if (region.kind !== "tool-output") continue;
    if (region.tool?.name !== toolName) continue;
    if (region.tool?.status !== "error") continue;
    return { ordinal: inputOrdinal, regionIndex: i };
  }
  return undefined;
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
 * Run purge-errors over the transcript: scan error-status tool calls
 * and write pending marks for their input regions.
 *
 * Gating order mirrors the legacy hook: an absent protected window
 * skips everything (fail-safe), then the message-count floor, then the
 * context-fraction threshold.  Hidden messages still participate in the
 * scan (the legacy producer scanned ignored messages too); the
 * message-count floor counts non-hidden messages.
 *
 * Per error call the skip chain is migrated verbatim from the legacy
 * producer:
 *
 * 1. Protected window / already-folded-or-pruned ordinal → skip.
 * 2. Tool name in `protectedTools` → skip (no default list).
 * 3. A mark already held by either of the call's regions — its
 *    tool-input key or its linked tool-output key — → skip the whole
 *    call (the legacy callID-scoped idempotency, migrated to region
 *    keys; the output-region key covers marks written by the dedup and
 *    sweep producers).
 * 4. Input reclaim not positive — input text estimate does not exceed
 *    the error-input placeholder estimate (the legacy string-input
 *    zero-benefit rule) — → skip the call entirely.
 *
 * When the call survives, only its tool-input region is marked; the
 * output region is never touched, matching the legacy producer.
 *
 * @param state - The session state; `state.marks` is read to skip
 *   already-claimed calls and written with new pending marks.
 * @param messages - The transcript.
 * @param options - Purge-errors options; all fields optional.
 * @returns The number of new marks and their total reclaim tokens.
 */
export function runPurgeErrors(
  state: SessionState,
  messages: HostMessage[],
  options: PurgeErrorsProducerOptions = {},
): PurgeErrorsRunResult {
  const minMessages = options.minMessages ?? DEFAULT_MIN_MESSAGES;
  const thresholdContext =
    options.thresholdContext ?? DEFAULT_THRESHOLD_CONTEXT;
  const protectedTools = options.protectedTools;
  const prunedOrdinals = options.prunedOrdinals;

  // Fail-safe: without a protection window the producer is skipped with
  // zero side effects (legacy contract when the window is not set).
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

  for (let ordinal = 0; ordinal < messages.length; ordinal++) {
    const msg = messages[ordinal];
    if (!msg?.regions) continue;
    if (prunedOrdinals?.(ordinal)) continue;
    if (ordinal >= protectedStartOrdinal) continue;

    // Each error tool-input region is one failed call.
    for (let i = 0; i < msg.regions.length; i++) {
      const inputRegion = msg.regions[i];
      if (!inputRegion) continue;
      if (inputRegion.kind !== "tool-input") continue;
      if (inputRegion.tool?.status !== "error") continue;

      const toolName = inputRegion.tool?.name ?? "";
      if (protectedTools?.includes(toolName)) continue;

      // Call-level idempotency (legacy callID-scoped): an existing mark
      // on either region of the call suppresses the whole call.  The
      // output-region key is never written here, but the dedup/sweep
      // producers may hold it — resolved through the positional
      // reference on pi (cross-message) or the same-message sibling on
      // v1.
      const outputRegion = findErrorOutputRegion(
        messages,
        ordinal,
        i,
        toolName,
      );
      if (state.marks.has(markKey(ordinal, i))) continue;
      if (
        outputRegion !== undefined &&
        state.marks.has(markKey(outputRegion.ordinal, outputRegion.regionIndex))
      ) {
        continue;
      }

      const input = inputRegion.get();
      const inputReclaim = netReclaimTokens(
        input,
        PRUNED_TOOL_ERROR_INPUT_REPLACEMENT,
      );
      // Zero-benefit gate (migrated verbatim): without positive input
      // reclaim the call is skipped entirely.
      if (inputReclaim <= 0) continue;

      if (addPendingMark(state, ordinal, i, input, inputReclaim, now)) {
        created += 1;
        tokens += inputReclaim;
      }
    }
  }

  return { created, tokens };
}
