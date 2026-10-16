/**
 * Deduplication producer over the host-agnostic context lens.
 *
 * Scans the transcript's invocation table for repeated completed tool
 * invocations — same tool name plus input parameters normalised for key
 * order and volatile fields — and writes pending prune marks for every
 * occurrence except the newest.  Marks anchor to the tool-output region:
 * key `(ordinal, regionIndex)` per `state.markKey`, `effective=false`
 * for the two-turn batch release lifecycle.  Input text, tool name and
 * status all come from the invocation entry — the pairing is produced at
 * projection time by the host adapter, never re-derived from message
 * layout here.  The module reads tool regions only through `TextRegion`
 * lenses and never rewrites any region text.
 *
 * Gating is shared with the purge-errors producer through
 * `producers/gate.ts`: the producer skips entirely below the
 * message-count floor and below the context-fraction threshold, and it
 * honours a caller-computed protected window (`protectedStartOrdinal`)
 * plus a predicate for messages already folded or pruned.  All gate
 * parameters (`minMessages`, `thresholdContext`) are required options
 * supplied by the caller from config.toml — the producer carries no
 * defaults and refuses to run when either is absent.  All other
 * semantics — signature normalisation, skip rules, and the
 * first-write-wins mark clamp (the shared `addPendingMark` in
 * `state.ts`) — are defined below.
 *
 * @module
 */

import type { Projection } from "../lens.js";
import { netReclaimTokens } from "../measure.js";
import { PRUNED_TOOL_OUTPUT_REPLACEMENT } from "../message-parts.js";
import { addPendingMark, markKey, type SessionState } from "../state.js";
import type { ProducerGateOptions, ProducerRunResult } from "./gate.js";
import { checkProducerGate } from "./gate.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Fields stripped from input objects at any depth when computing the
 * signature.
 */
const VOLATILE_FIELDS = new Set(["timestamp", "ts", "date"]);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Options for the lens dedup producer — the shared gate options (see
 * `producers/gate.ts`).
 */
export type DedupProducerOptions = ProducerGateOptions;

/**
 * Result of one dedup pass.
 */
export type DedupRunResult = ProducerRunResult;

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
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Run dedup over the transcript: scan the invocation table, group the
 * paired calls by signature, and write pending marks for every duplicate
 * except the newest.
 *
 * Gating order: an absent protected window skips everything (fail-safe),
 * then the message-count floor, then the context-fraction threshold.
 * Hidden messages still participate in the scan; the message-count floor
 * counts non-hidden messages.
 *
 * @param state - The session state; `state.marks` is read to skip
 *   already-claimed positions and written with new pending marks.
 * @param snapshot - The projection snapshot: the region view plus the
 *   invocation table this producer scans.
 * @param options - Dedup options; the gate parameters (`minMessages`,
 *   `thresholdContext`) are required.
 * @returns The number of new marks and their total reclaim tokens.
 */
export function runDedup(
  state: SessionState,
  snapshot: Projection,
  options: DedupProducerOptions,
): DedupRunResult {
  const messages = snapshot.messages;
  const prunedOrdinals = options.prunedOrdinals;

  const gate = checkProducerGate(snapshot, options);
  if (gate === null) return { created: 0, tokens: 0 };
  const protectedStartOrdinal = gate.protectedStartOrdinal;

  // Phase 1: positions already claimed by a mark (pending or effective)
  // never get a second mark.
  const alreadyMarked = new Set(state.marks.keys());

  // Phase 2: group paired tool invocations by signature.  The pairing
  // comes from the projection's invocation table — the producer never
  // re-derives it from message layout.  Calls the table does not pair,
  // calls still in flight (no linked output), and entries whose region
  // addresses do not resolve are abstained from (fail-closed).
  const sigMap = new Map<string, DedupEntry[]>();
  for (const invocation of snapshot.invocations) {
    const output = invocation.output;
    if (output === undefined) continue;
    const outputRegion = messages[output.ordinal]?.regions[output.regionIndex];
    if (outputRegion?.kind !== "tool-output") continue;
    const input = invocation.input;
    const inputRegion = messages[input.ordinal]?.regions[input.regionIndex];
    if (inputRegion?.kind !== "tool-input") continue;
    if (prunedOrdinals?.(output.ordinal)) continue;
    if (output.ordinal >= protectedStartOrdinal) continue;

    // Skip rules.
    const status = invocation.status;
    if (status !== undefined && status !== "completed") continue;
    const tool = invocation.name;
    if (options.protectedTools?.includes(tool)) continue;
    const key = markKey(output.ordinal, output.regionIndex);
    if (alreadyMarked.has(key)) continue;

    const outputText = outputRegion.get();
    const estimatedTokens = netReclaimTokens(
      outputText,
      PRUNED_TOOL_OUTPUT_REPLACEMENT,
    );
    const signature = makeSignature(tool, parseInputText(inputRegion.get()));

    let entries = sigMap.get(signature);
    if (!entries) {
      entries = [];
      sigMap.set(signature, entries);
    }
    entries.push({
      ordinal: output.ordinal,
      regionIndex: output.regionIndex,
      output: outputText,
      estimatedTokens,
    });
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
