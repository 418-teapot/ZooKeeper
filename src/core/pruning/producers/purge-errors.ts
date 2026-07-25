/**
 * Purge-errors producer — mark failed tool call inputs for pruning.
 *
 * Scans session messages for tool parts in error state.  Surviving the
 * skip chain (already marked / within protection window / protected
 * tool / zero benefit), writes a pending mark via
 * `addMark(state, ..., effective=false, "tool-error-input")` for batch
 * release.
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
import { getCallId, PRUNED_TOOL_ERROR_INPUT_REPLACEMENT } from "../types.js";
import { collectProtectedCallIDs } from "./shared.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Options for the purge-errors strategy.
 *
 * `turnProtection` and `protectedTools` are read by `runPurgeErrors`;
 * gating fields (enabled, thresholdTokens) are consumed by the hook.
 */
export interface PurgeErrorsOptions {
  /** Number of most recent assistant steps to protect from purge. */
  turnProtection?: number;
  /** Tool names that are excluded from purge (default `["question"]`). */
  protectedTools?: string[];
}

/**
 * A single purge-errors mark produced by `runPurgeErrors`.
 */
export interface PurgeErrorsMark {
  /** The tool call identifier that was marked for pruning. */
  callID: string;
  /** The tool name (e.g. "bash", "read"). */
  tool: string;
  /** Estimated token count reclaimed by pruning this tool's input. */
  estimatedTokens: number;
  /** Message index in the messages array. */
  messageIndex: number;
  /** Part index within the message's parts array. */
  partIndex: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Collect top-level string field values from an input for token estimation.
 *
 * Aligned with `pruneToolErrors` replacement semantics:
 * - If `input` is a string → returns `[input]` (the whole string is one field).
 * - If `input` is a flat object → returns all top-level string values as
 *   separate entries.  Nested objects, arrays, and non-string primitives
 *   within the input are NOT counted, because they are NOT replaced by
 *   `pruneToolErrors`.
 * - null / undefined / arrays / primitives → empty array.
 *
 * Each returned element corresponds to one field that will be independently
 * replaced with `PRUNED_TOOL_ERROR_INPUT_REPLACEMENT` by the prune phase.
 *
 * @param input - The tool part input value.
 * @returns Array of top-level string values, one per replaceable field.
 */
function collectTopLevelStringFields(input: unknown): string[] {
  if (typeof input === "string") {
    return [input];
  }
  if (input !== null && typeof input === "object" && !Array.isArray(input)) {
    const fields: string[] = [];
    for (const v of Object.values(input as Record<string, unknown>)) {
      if (typeof v === "string") {
        fields.push(v);
      }
    }
    return fields;
  }
  // null, undefined, arrays, numbers, booleans — no replaceable strings.
  return [];
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Run purge-errors: scan session messages for error-status tool parts and
 * mark their callIDs via `addMark(state, ..., effective=false,
 * "tool-error-input")`.
 *
 * Skip chain (short-circuits on first match):
 * 1. Part without a callID → skip.
 * 2. callID already in `state.marks` → skip (idempotent).
 * 3. callID within the turn-protection window → skip.
 * 4. Tool name in `protectedTools` → skip (default `["question"]`).
 * 5. Input content yields zero or negative net reclaim tokens → skip.
 *
 * All marks are written as non-effective (pending) for batch release.
 * Only **error**-status tool parts are considered — completed / running /
 * pending parts are left for dedup / sweep producers.
 *
 * @param state - The session state (must have `marks` map).
 * @param messages - The session messages array.
 * @param options - Purge-errors options (`turnProtection`, `protectedTools`).
 * @returns Array of new purge-errors marks (empty when nothing was marked).
 */
export function runPurgeErrors(
  state: SessionState,
  messages: ContextMessageEntry[],
  options: PurgeErrorsOptions,
): PurgeErrorsMark[] {
  const turnProtection = options.turnProtection ?? 5;
  const protectedTools = options.protectedTools ?? ["question"];
  const protectedCallIDs = collectProtectedCallIDs(messages, turnProtection);
  const newMarks: PurgeErrorsMark[] = [];

  for (let mi = 0; mi < messages.length; mi++) {
    const msg = messages[mi];
    if (!msg.parts) continue;

    for (let pi = 0; pi < msg.parts.length; pi++) {
      const part = msg.parts[pi] as SweepToolPart;
      if (part.type !== "tool") continue;

      // ── Filter: only error-status parts ──────────────────────────
      const status = part.state
        ? (part.state as { status?: string }).status
        : undefined;
      if (status !== "error") continue;

      // ── Skip chain 1: no callID ──────────────────────────────────
      const callID = getCallId(part);
      if (!callID) continue;

      // ── Skip chain 2: already marked ─────────────────────────────
      if (state.marks.has(callID)) continue;

      // ── Skip chain 3: within protection window ──────────────────
      if (protectedCallIDs.has(callID)) continue;

      // ── Skip chain 4: protected tool ────────────────────────────
      const toolName = part.tool ?? "";
      if (protectedTools.includes(toolName)) continue;

      // ── Skip chain 5: zero benefit ──────────────────────────────
      const fields = collectTopLevelStringFields(part.state?.input);
      if (fields.length === 0) continue;

      // Per-field estimation: each replaceable field incurs one
      // placeholder cost, matching pruneToolErrors replacement
      // semantics (N fields → N placeholders).
      let totalContentTokens = 0;
      for (const f of fields) {
        totalContentTokens += estimateTokenCount(f);
      }
      const totalPlaceholderTokens =
        fields.length * estimateTokenCount(PRUNED_TOOL_ERROR_INPUT_REPLACEMENT);
      const estimatedTokens =
        totalContentTokens > totalPlaceholderTokens
          ? totalContentTokens - totalPlaceholderTokens
          : 0;
      if (estimatedTokens <= 0) continue;

      // ── Hit: write mark ─────────────────────────────────────────
      if (addMark(state, callID, estimatedTokens, false, "tool-error-input")) {
        newMarks.push({
          callID,
          tool: toolName,
          estimatedTokens,
          messageIndex: mi,
          partIndex: pi,
        });
      }
    }
  }

  return newMarks;
}
