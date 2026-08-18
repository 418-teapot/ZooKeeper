/**
 * Deduplication producer over the host-agnostic context lens.
 *
 * Scans the transcript for repeated completed tool invocations — same
 * tool name plus input parameters normalised for key order and volatile
 * fields — and writes pending prune marks for every occurrence except
 * the newest.  Marks anchor to the tool-output region: key
 * `(ordinal, regionIndex)` per `state.markKey`, `effective=false` for
 * the two-turn batch release lifecycle.  The module reads tool regions
 * only through `TextRegion` lenses and never rewrites any region text.
 *
 * Gating is self-contained: the producer skips entirely below the
 * message-count floor and below the context-fraction threshold, and it
 * honours a caller-computed protected window (`protectedStartOrdinal`)
 * plus a predicate for messages already folded or pruned.  All other
 * semantics — signature normalisation, skip rules, defaults, and the
 * first-write-wins mark clamp — are migrated verbatim from the legacy
 * `pruning/producers/dedup.ts`.
 *
 * @module
 */

import type { HostMessage } from "../lens.js";
import { measureMessages, netReclaimTokens } from "../measure.js";
import { PRUNED_TOOL_OUTPUT_REPLACEMENT } from "../message-parts.js";
import { markKey, RECALL_MAX_CHARS, type SessionState } from "../state.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Minimum non-hidden message count before dedup runs (default). */
const DEFAULT_MIN_MESSAGES = 20;

/** Fraction of the model context limit that opens the gate (default). */
const DEFAULT_THRESHOLD_CONTEXT = 0.4;

/** Tool names excluded from dedup by default, matched case-sensitively. */
const DEFAULT_PROTECTED_TOOLS = ["batch"];

/**
 * Fields stripped from input objects at any depth when computing the
 * signature — the legacy volatile-field list, kept verbatim.
 */
const VOLATILE_FIELDS = new Set(["timestamp", "ts", "date"]);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Options for the lens dedup producer.
 */
export interface DedupProducerOptions {
  /**
   * Minimum non-hidden message count before the producer runs.
   * Defaults to 20; the producer skips when the count is not greater.
   */
  minMessages?: number;
  /**
   * Fraction of `contextLimit` that must be reached for marks to be
   * produced.  Defaults to 0.4; equality opens the gate.
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
   * the protected-messages / protected-tokens window; undefined skips
   * the producer entirely (legacy fail-safe when the window is not
   * configured).  `messages.length` is an empty window.
   */
  protectedStartOrdinal?: number;
  /**
   * Tool names excluded from dedup, matched case-sensitively.
   * Defaults to `["batch"]`.
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
 * Result of one dedup pass.
 */
export interface DedupRunResult {
  /** Number of new pending marks written. */
  created: number;
  /** Total estimated reclaim tokens of the new marks. */
  tokens: number;
}

/**
 * One candidate tool-output region grouped by signature.
 */
interface DedupEntry {
  ordinal: number;
  regionIndex: number;
  output: string;
  estimatedTokens: number;
}

// ---------------------------------------------------------------------------
// Signature helpers
// ---------------------------------------------------------------------------

/**
 * Recursively normalise an input value for signature computation.
 *
 * - null / undefined → omitted (return undefined)
 * - arrays → each element normalised, filtered for undefineds
 * - objects → keys sorted, volatile fields stripped, values normalised
 * - primitives → returned as-is
 *
 * @param input - The value to normalise.
 * @returns Normalised value, or undefined when the value is omitted.
 */
function normalizeInput(input: unknown): unknown {
  if (input === null || input === undefined) return undefined;
  if (Array.isArray(input)) {
    return input.map(normalizeInput).filter((v) => v !== undefined);
  }
  if (typeof input === "object") {
    const record = input as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      if (VOLATILE_FIELDS.has(key)) continue;
      const val = normalizeInput(record[key]);
      if (val !== undefined) {
        sorted[key] = val;
      }
    }
    return sorted;
  }
  return input;
}

/**
 * Parse a tool-input region text into the value signature normalisation
 * expects.  Non-JSON text (parse failure) is used verbatim.
 *
 * @param text - The input region text.
 * @returns The parsed value, or the raw text on parse failure.
 */
function parseInputText(text: string): unknown {
  if (!text) return text;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

/**
 * Build a dedup signature for a tool invocation.
 *
 * Format: `${tool}::${JSON.stringify(normalisedInput)}`
 *
 * @param tool - The tool name.
 * @param input - The raw tool input value.
 * @returns A stable signature string.
 */
function makeSignature(tool: string, input: unknown): string {
  return `${tool}::${JSON.stringify(normalizeInput(input))}`;
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
 * Run dedup over the transcript: scan tool-output regions, group them
 * by signature, and write pending marks for every duplicate except the
 * newest.
 *
 * Gating order mirrors the legacy hook: an absent protected window
 * skips everything (fail-safe), then the message-count floor, then the
 * context-fraction threshold.  Hidden messages still participate in the
 * scan (the legacy producer scanned ignored messages too); the
 * message-count floor counts non-hidden messages.
 *
 * @param state - The session state; `state.marks` is read to skip
 *   already-claimed positions and written with new pending marks.
 * @param messages - The transcript.
 * @param options - Dedup options; all fields optional.
 * @returns The number of new marks and their total reclaim tokens.
 */
export function runDedup(
  state: SessionState,
  messages: HostMessage[],
  options: DedupProducerOptions = {},
): DedupRunResult {
  const minMessages = options.minMessages ?? DEFAULT_MIN_MESSAGES;
  const thresholdContext =
    options.thresholdContext ?? DEFAULT_THRESHOLD_CONTEXT;
  const protectedTools = options.protectedTools ?? DEFAULT_PROTECTED_TOOLS;
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

  // Phase 1: positions already claimed by a mark (pending or effective)
  // never get a second mark.
  const alreadyMarked = new Set(state.marks.keys());

  // Phase 2: group tool-output regions by signature.
  const sigMap = new Map<string, DedupEntry[]>();
  for (let ordinal = 0; ordinal < messages.length; ordinal++) {
    const msg = messages[ordinal];
    if (!msg?.regions) continue;
    if (prunedOrdinals?.(ordinal)) continue;
    if (ordinal >= protectedStartOrdinal) continue;

    // The input text of a tool-output region is the nearest preceding
    // tool-input region in the same message (each call's input/output
    // pair is adjacent in the host layout; the lens carries no ids).
    let inputText = "";
    for (let regionIndex = 0; regionIndex < msg.regions.length; regionIndex++) {
      const region = msg.regions[regionIndex];
      if (!region) continue;
      if (region.kind === "tool-input") {
        inputText = region.get();
        continue;
      }
      if (region.kind !== "tool-output") continue;

      // Skip rules (migrated verbatim from the legacy producer).
      const status = region.tool?.status;
      if (status !== undefined && status !== "completed") continue;
      const tool = region.tool?.name ?? "";
      if (protectedTools.includes(tool)) continue;
      const key = markKey(ordinal, regionIndex);
      if (alreadyMarked.has(key)) continue;

      const output = region.get();
      const estimatedTokens = netReclaimTokens(
        output,
        PRUNED_TOOL_OUTPUT_REPLACEMENT,
      );
      const signature = makeSignature(tool, parseInputText(inputText));

      let entries = sigMap.get(signature);
      if (!entries) {
        entries = [];
        sigMap.set(signature, entries);
      }
      entries.push({ ordinal, regionIndex, output, estimatedTokens });
    }
  }

  // Phase 3: mark older duplicates, keep the newest.
  let created = 0;
  let tokens = 0;
  const now = Date.now();

  for (const entries of sigMap.values()) {
    if (entries.length < 2) continue; // No duplicate — skip.

    // Sort by position (oldest first).
    entries.sort(
      (a, b) => a.ordinal - b.ordinal || a.regionIndex - b.regionIndex,
    );

    // Keep the newest (last entry), mark all older ones.
    for (let i = 0; i < entries.length - 1; i++) {
      const entry = entries[i];

      // Zero-benefit skip: replacing a short output with the placeholder
      // would increase context rather than save.
      if (entry.estimatedTokens <= 0) continue;

      if (
        addPendingMark(
          state,
          entry.ordinal,
          entry.regionIndex,
          entry.output,
          entry.estimatedTokens,
          now,
        )
      ) {
        created += 1;
        tokens += entry.estimatedTokens;
      }
    }
  }

  return { created, tokens };
}
