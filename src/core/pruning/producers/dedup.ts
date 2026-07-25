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

import type { ContextMessageEntry } from "../../metrics.js";
import { estimateTokenCount } from "../../metrics.js";
import type { SessionState } from "../marks.js";
import { addMark } from "../marks.js";
import type { SweepToolPart } from "../types.js";
import { getCallId, PRUNED_TOOL_OUTPUT_REPLACEMENT } from "../types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Options for the dedup strategy.
 *
 * `enabled`, `thresholdTokens`, and `releaseThresholdPercent` are consumed
 * by the hook for gating and batch release; `runDedup` only reads
 * `turnProtection` and `protectedTools`.
 */
export interface DedupOptions {
  /** Hook-level gate — runDedup does not check this. */
  enabled?: boolean;
  /** Hook-level gate — minimum context tokens before scanning. */
  thresholdTokens?: number;
  /** Number of most recent assistant steps to protect from dedup. */
  turnProtection?: number;
  /** Tool names that are excluded from dedup. */
  protectedTools?: string[];
  /**
   * Minimum percentage of prompt-side total tokens that pending dedup
   * marks must reach before they are batch-released into effective marks
   * and applied on the next turn.  Default 5 (%).
   */
  releaseThresholdPercent?: number;
}

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
// Turn protection
// ---------------------------------------------------------------------------

/**
 * Collect tool callIDs that fall within the protected window.
 *
 * When the messages array contains step-start parts, the most recent
 * `turnProtection` assistant steps (counted by messages containing a
 * `step-start` part) are protected from dedup.  When no step-start part
 * exists, falls back to protecting the last `turnProtection` tool calls.
 *
 * @param messages - The session messages array.
 * @param turnProtection - Number of steps / tool calls to protect.
 * @returns Set of protected callIDs.
 */
function collectProtectedCallIDs(
  messages: ContextMessageEntry[],
  turnProtection: number,
): Set<string> {
  const protectedIDs = new Set<string>();
  if (turnProtection <= 0) return protectedIDs;

  // ── Step 1: detect step-start presence ──────────────────────────
  let hasStepStart = false;
  for (const msg of messages) {
    if (!msg.parts) continue;
    for (const part of msg.parts) {
      const p = part as { type: string };
      if (p.type === "step-start") {
        hasStepStart = true;
        break;
      }
    }
    if (hasStepStart) break;
  }

  if (hasStepStart) {
    // ── Step 2a: find all step-start indices ──────────────────────
    const stepStartIndices: number[] = [];
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      if (!msg.parts) continue;
      for (const part of msg.parts) {
        if ((part as { type: string }).type === "step-start") {
          stepStartIndices.push(i);
          break;
        }
      }
    }

    // ── Step 2b: compute protected zone start index ──────────────
    let protectedFromIdx: number;
    if (stepStartIndices.length > turnProtection) {
      // There are more steps than the protection window.
      // Protect from the (turnProtection)-th step from the end.
      protectedFromIdx =
        stepStartIndices[stepStartIndices.length - turnProtection];
    } else {
      // Fewer or equal steps than protection window → protect all.
      protectedFromIdx = 0;
    }

    // ── Step 2c: collect tool callIDs in protected zone ──────────
    for (let i = protectedFromIdx; i < messages.length; i++) {
      const msg = messages[i];
      if (!msg.parts) continue;
      for (const part of msg.parts) {
        const toolPart = part as SweepToolPart;
        if (toolPart.type !== "tool") continue;
        const callID = getCallId(toolPart);
        if (callID) protectedIDs.add(callID);
      }
    }
  } else {
    // ── Step 3: fallback — protect last N tool calls ─────────────
    let collected = 0;
    for (
      let i = messages.length - 1;
      i >= 0 && collected < turnProtection;
      i--
    ) {
      const msg = messages[i];
      if (!msg.parts) continue;
      for (
        let p = msg.parts.length - 1;
        p >= 0 && collected < turnProtection;
        p--
      ) {
        const part = msg.parts[p] as SweepToolPart;
        if (part.type !== "tool") continue;
        const callID = getCallId(part);
        if (callID) {
          protectedIDs.add(callID);
          collected++;
        }
      }
    }
  }

  return protectedIDs;
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
  protectedTools: string[],
): boolean {
  const callID = getCallId(part);
  if (!callID) return true;

  if (alreadyMarked.has(callID)) return true;
  if (protectedCallIDs.has(callID)) return true;

  if (part.tool && protectedTools.includes(part.tool)) return true;

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
  const turnProtection = options.turnProtection ?? 5;
  const protectedTools = options.protectedTools ?? [];

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
      rawDiff: number;
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
      const outputTokens = estimateTokenCount(part.state?.output);
      const placeholderTokens = estimateTokenCount(
        PRUNED_TOOL_OUTPUT_REPLACEMENT,
      );
      const rawDiff = outputTokens - placeholderTokens;
      const estimatedTokens = Math.max(0, rawDiff);

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
        rawDiff,
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
      if (entry.rawDiff <= 0) continue;

      // addMark is idempotent: already-marked callIDs return false.
      // This naturally prevents double-counting on re-runs.
      if (!addMark(state, entry.callID, entry.estimatedTokens, false)) {
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
