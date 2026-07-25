/**
 * Pruning logic — the sweep phase of mark-sweep context pruning.
 *
 * Provides `pruneToolOutputs` which replaces effective-marked tool
 * outputs with a placeholder string.  The mark phase is handled by
 * producers (sweep.ts, dedup.ts) which write to `state.marks`.
 *
 * @module
 */

import type { ContextMessageEntry } from "../metrics.js";
import type { SessionState } from "./marks.js";
import type { SweepToolPart } from "./types.js";
import { getCallId, PRUNED_TOOL_OUTPUT_REPLACEMENT } from "./types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Result item from `pruneToolOutputs` describing a single replaced output.
 */
export interface PruneReplacement {
  /** Tool call identifier. */
  callID: string;
  /** Length of the original output (string len or JSON-stringified len). */
  beforeLen: number;
  /** Length of the placeholder replacement. */
  afterLen: number;
}

// ---------------------------------------------------------------------------
// Prune (sweep phase)
// ---------------------------------------------------------------------------

/**
 * Prune tool outputs that have been effective-marked in the session state.
 *
 * Walks each message's parts array.  For every tool part whose
 * `callID` has an effective mark in `state.marks`, its `state.output`
 * is replaced IN-PLACE with `PRUNED_TOOL_OUTPUT_REPLACEMENT`.
 *
 * Non-effective (pending) marks are NOT applied — they await batch
 * release via `releaseBatch`.
 *
 * Token accounting is NOT performed here — it happens at mark-time
 * (producers) when estimated token counts are first recorded.  This
 * avoids double-counting across transform turns since the transform
 * reloads messages fresh from DB each turn but marks accumulate.
 *
 * This function mutates `messages` in place and reads `state.marks`.
 * It does NOT mutate state or stats.
 *
 * @param state - The session state (must have `marks` map).
 * @param messages - Array of session message entries (mutated in place).
 * @returns Array of `PruneReplacement` objects describing each replaced
 *   output (empty array when no effective marks exist or no matches found).
 */
export function pruneToolOutputs(
  state: SessionState,
  messages: ContextMessageEntry[],
): PruneReplacement[] {
  if (state.marks.size === 0) return [];

  const replacedOutputs: PruneReplacement[] = [];

  // Replace ALL matching effective outputs in place.
  for (const msg of messages) {
    if (!msg.parts) continue;
    for (const part of msg.parts) {
      const toolPart = part as SweepToolPart;
      if (toolPart.type !== "tool") continue;
      const callID = getCallId(toolPart);
      if (!callID) continue;

      const mark = state.marks.get(callID);
      if (!mark?.effective) continue;

      const originalOutput = toolPart.state?.output;

      // Capture before-length for diagnostic logging.
      const beforeLen =
        originalOutput != null
          ? typeof originalOutput === "string"
            ? originalOutput.length
            : JSON.stringify(originalOutput).length
          : 0;
      const afterLen = PRUNED_TOOL_OUTPUT_REPLACEMENT.length;
      replacedOutputs.push({ callID, beforeLen, afterLen });

      // Replace output in place.
      if (toolPart.state) {
        toolPart.state.output = PRUNED_TOOL_OUTPUT_REPLACEMENT;
      } else {
        // Ensure state object exists even if it was absent.
        (toolPart as unknown as Record<string, unknown>).state = {
          output: PRUNED_TOOL_OUTPUT_REPLACEMENT,
        };
      }
    }
  }

  // NOTE: marks is NOT cleared — it accumulates per DCP semantics.
  // The map persists for TUI visibility and is only reset via
  // deleteSessionState (session.deleted) or compaction.

  return replacedOutputs;
}
