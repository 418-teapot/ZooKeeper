/**
 * Automatic deduplication of repeated tool calls (producer).
 *
 * Detects duplicate tool invocations by comparing their tool name and
 * normalised input parameters.  Older duplicates are marked via
 * `addMark(state, ..., effective=false)` for batch release.
 *
 * Unified producer model: this is just a function that reads messages
 * and writes marks — no strategy framework, no registry.
 *
 * @module
 */

import {
  getCallId,
  PRUNED_TOOL_OUTPUT_REPLACEMENT,
} from "../../message-parts.js";
import type { ContextMessageEntry } from "../../metrics.js";
import { addMark } from "../marks.js";
import type { ProducerOptions } from "../shared.js";
import { collectProtectedCallIDs, netReclaimTokens } from "../shared.js";
import type { SessionState, SweepToolPart } from "../types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Options for the dedup producer.
 *
 * Alias of the shared `ProducerOptions` — `runDedup` only reads
 * `turnProtection` and `protectedTools`.  Hook-level gating (enabled,
 * thresholdTokens) and batch-release (releaseThresholdPercent) are
 * managed by the handler config.
 */
export type DedupOptions = ProducerOptions;

/**
 * A single dedup mark produced by `runDedup`.
 */
export interface DedupMark {
  /** The tool call identifier that was marked for pruning. */
  callID: string;
  /** The tool name (e.g. "bash", "read"). */
  tool: string;
  /** Estimated token count reclaimed by pruning this tool output. */
  estimatedTokens: number;
  /** Message index in the messages array. */
  messageIndex: number;
  /** Part index within the message's parts array. */
  partIndex: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Fields to strip from input objects at any depth.
 * These are known volatile fields that would cause false-negative mismatches.
 */
const VOLATILE_FIELDS = new Set(["timestamp", "ts", "date"]);

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
 * @returns Normalised value, or undefined if the value should be omitted.
 */
function normalizeInput(input: unknown): unknown {
  if (input === null || input === undefined) return undefined;
  if (Array.isArray(input)) {
    const mapped = input.map(normalizeInput).filter((v) => v !== undefined);
    return mapped;
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
 * Build a dedup signature for a tool invocation.
 *
 * Format: `${tool}::${JSON.stringify(normalisedInput)}`
 *
 * @param tool - The tool name.
 * @param input - The raw tool input parameters.
 * @returns A stable signature string.
 */
function makeSignature(tool: string, input: unknown): string {
  return `${tool}::${JSON.stringify(normalizeInput(input))}`;
}

// ---------------------------------------------------------------------------
// Helper — check if a tool part should be skipped
// ---------------------------------------------------------------------------

/**
 * Determine whether a tool part should be excluded from dedup.
 *
 * @param part - The tool part to check.
 * @param alreadyMarked - Set of callIDs already in state.marks.
 * @param protectedCallIDs - Set of protected callIDs.
 * @param protectedTools - Array of tool names to skip.
 * @returns `true` if the part should be skipped.
 */
function shouldSkipPart(
  part: SweepToolPart,
  alreadyMarked: Set<string>,
  protectedCallIDs: Set<string>,
  protectedTools: string[] | undefined,
): boolean {
  const callID = getCallId(part);
  if (!callID) return true;

  if (alreadyMarked.has(callID)) return true;
  if (protectedCallIDs.has(callID)) return true;

  if (part.tool && protectedTools?.includes(part.tool)) return true;

  // Skip non-completed parts (error / running / pending).
  // Error parts are left for purge-errors strategy.
  const status = part.state
    ? (part.state as { status?: string }).status
    : undefined;
  if (status !== undefined && status !== "completed") return true;

  return false;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Run dedup: scan session messages for duplicate tool invocations and mark
 * older duplicates via `addMark(state, ..., effective=false)`.
 *
 * This function:
 * - Reads `state.marks` to skip already-marked callIDs (prevents
 *   double-marking, now naturally handled by addMark's idempotency).
 * - Writes new marks via `addMark(..., effective=false)` for batch
 *   release (flipped to effective by `releaseBatch`).
 * - Sets `state.dirty = true` when at least one new mark was added.
 *
 * @param state - The session state (must have `marks` map).
 * @param messages - The session messages array.
 * @param options - Dedup options (`turnProtection`, `protectedTools`).
 * @returns Array of new dedup marks (empty when nothing was marked).
 */
export function runDedup(
  state: SessionState,
  messages: ContextMessageEntry[],
  options: DedupOptions,
): DedupMark[] {
  // Undefined turnProtection → skip (no fallback — "fail to skip").
  if (options.turnProtection === undefined) return [];
  const turnProtection = options.turnProtection;
  const protectedTools = options.protectedTools;

  // ── Phase 1: collect protected callIDs ───────────────────────────
  // Single marks.has() check covers both effective and pending marks.
  const alreadyMarked = new Set(state.marks.keys());
  const protectedCallIDs = collectProtectedCallIDs(messages, turnProtection);

  // ── Phase 2: build signature map ────────────────────────────────
  // signature -> array of { callID, tool, part info, token estimates }
  const sigMap = new Map<
    string,
    Array<{
      callID: string;
      tool: string;
      messageIndex: number;
      partIndex: number;
      estimatedTokens: number;
    }>
  >();

  for (let mi = 0; mi < messages.length; mi++) {
    const msg = messages[mi];
    if (!msg.parts) continue;
    for (let pi = 0; pi < msg.parts.length; pi++) {
      const part = msg.parts[pi] as SweepToolPart;
      if (part.type !== "tool") continue;

      if (
        shouldSkipPart(part, alreadyMarked, protectedCallIDs, protectedTools)
      ) {
        continue;
      }

      const callID = getCallId(part);
      if (!callID) continue;

      const signature = makeSignature(part.tool ?? "", part.state?.input);
      const estimatedTokens = netReclaimTokens(
        part.state?.output,
        PRUNED_TOOL_OUTPUT_REPLACEMENT,
      );

      let entries = sigMap.get(signature);
      if (!entries) {
        entries = [];
        sigMap.set(signature, entries);
      }
      entries.push({
        callID,
        tool: part.tool ?? "",
        messageIndex: mi,
        partIndex: pi,
        estimatedTokens,
      });
    }
  }

  // ── Phase 3: mark older duplicates ──────────────────────────────
  const newMarks: DedupMark[] = [];

  for (const entries of sigMap.values()) {
    if (entries.length < 2) continue; // No duplicate — skip.

    // Sort by position (oldest first).
    entries.sort((a, b) => {
      if (a.messageIndex !== b.messageIndex) {
        return a.messageIndex - b.messageIndex;
      }
      return a.partIndex - b.partIndex;
    });

    // Keep the newest (last entry), mark all older ones.
    for (let i = 0; i < entries.length - 1; i++) {
      const entry = entries[i];

      // Skip zero-benefit marks: when output is shorter than the
      // placeholder, replacement would increase context rather than save.
      if (entry.estimatedTokens <= 0) continue;

      // addMark is idempotent: already-marked callIDs return false.
      // This naturally prevents double-counting on re-runs.
      if (
        !addMark(
          state,
          entry.callID,
          entry.estimatedTokens,
          false,
          "tool-output",
        )
      ) {
        // Already marked — defensive check (should not happen since
        // Phase 2 filters for alreadyMarked, but handle gracefully).
        continue;
      }

      newMarks.push({
        callID: entry.callID,
        tool: entry.tool,
        estimatedTokens: entry.estimatedTokens,
        messageIndex: entry.messageIndex,
        partIndex: entry.partIndex,
      });
    }
  }

  return newMarks;
}
