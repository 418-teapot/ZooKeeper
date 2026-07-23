/**
 * Pruning logic — the sweep phase of mark-sweep context pruning.
 *
 * Provides `pruneToolOutputs` (replaces marked tool outputs with a
 * placeholder string) and `collectSweepCallIDs` (collects call IDs
 * from session messages for the mark phase).
 *
 * @module
 */

import type { ContextMessageEntry } from "../metrics.js";
import { estimateTokenCount } from "../metrics.js";
import type { SessionState } from "./state.js";
import type { SweepToolPart } from "./types.js";
import { PRUNED_TOOL_OUTPUT_REPLACEMENT } from "./types.js";

// ---------------------------------------------------------------------------
// Sweep (prune) callID collection
// ---------------------------------------------------------------------------

/**
 * Result item from `collectSweepCallIDs`.
 */
export interface SweepMark {
  /** Tool call identifier. */
  callID: string;
  /** Estimated token count reclaimed by pruning this tool's output. */
  estimatedTokens: number;
}

/**
 * Determine whether a message is an "ignored" user message.
 *
 * A user message is considered ignored when:
 * - Its `info.ignored` field is truthy, OR
 * - All of its parts have `ignored: true`
 *
 * @param msg - The message entry to check.
 * @returns `true` if the message should be skipped.
 */
function isMessageIgnored(msg: ContextMessageEntry): boolean {
  const info = msg.info as unknown as Record<string, unknown>;
  if (info.ignored) return true;

  const parts = msg.parts;
  if (!parts || parts.length === 0) return false;
  return parts.every((p) => {
    const textPart = p as { ignored?: boolean };
    return textPart.ignored === true;
  });
}

/**
 * Extract the callID from a part, checking multiple possible field names.
 *
 * OpenCode SDK may expose the call identifier as `callID` or `callId`.
 *
 * @param part - A message part.
 * @returns The call identifier string, or undefined.
 */
function getCallId(part: unknown): string | undefined {
  const p = part as Record<string, unknown>;
  return (p.callID as string) ?? (p.callId as string) ?? undefined;
}

/**
 * Collect tool call IDs for the `/dcp sweep` command.
 *
 * Two modes:
 * - No count (`undefined`): find the last non-ignored user message,
 *   then collect all tool part callIDs AFTER that index.
 * - Numeric count: walk backwards collecting tool part callIDs until
 *   N are gathered (or all messages are exhausted).
 *
 * In both modes, callIDs already present in `alreadyMarked` are
 * skipped (pre- filtered out) to prevent duplicate marking.
 *
 * @param messages - The session messages array.
 * @param alreadyMarked - Set of callIDs already in `state.prune.tools`.
 * @param count - Optional maximum number of tool outputs to mark.
 * @returns Array of SweepMark items (callID + estimated tokens).
 */
export function collectSweepCallIDs(
  messages: ContextMessageEntry[],
  alreadyMarked: Set<string>,
  count?: number,
): SweepMark[] {
  const result: SweepMark[] = [];

  if (count === undefined || count < 0) {
    // ── No count: collect all tool callIDs after last user message ──
    // Find the last non-ignored user message.
    let lastUserIdx = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.info.role === "user" && !isMessageIgnored(msg)) {
        lastUserIdx = i;
        break;
      }
    }

    // If no user message found, there is nothing to collect.
    if (lastUserIdx < 0) return result;

    // Collect tool parts after lastUserIdx.
    for (let i = lastUserIdx + 1; i < messages.length; i++) {
      const msg = messages[i];
      if (!msg.parts) continue;
      for (const part of msg.parts) {
        const toolPart = part as SweepToolPart;
        if (toolPart.type !== "tool") continue;
        const callID = getCallId(toolPart);
        if (!callID || alreadyMarked.has(callID)) continue;
        result.push({
          callID,
          estimatedTokens:
            estimateTokenCount(toolPart.state?.output) -
            estimateTokenCount(PRUNED_TOOL_OUTPUT_REPLACEMENT),
        });
      }
    }
  } else {
    // ── Numeric count: walk backward (messages & parts) until N ──
    // Both the message list and parts within each message are walked
    // in reverse so that we collect the N most recent tool callIDs.
    for (let i = messages.length - 1; i >= 0; i--) {
      if (result.length >= count) break;
      const msg = messages[i];
      if (!msg.parts || msg.parts.length === 0) continue;
      // Parts within a message are walked backward too.
      for (let p = msg.parts.length - 1; p >= 0; p--) {
        if (result.length >= count) break;
        const part = msg.parts[p];
        const toolPart = part as SweepToolPart;
        if (toolPart.type !== "tool") continue;
        const callID = getCallId(toolPart);
        if (!callID || alreadyMarked.has(callID)) continue;
        result.push({
          callID,
          estimatedTokens:
            estimateTokenCount(toolPart.state?.output) -
            estimateTokenCount(PRUNED_TOOL_OUTPUT_REPLACEMENT),
        });
      }
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Prune (sweep phase)
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

/**
 * Prune tool outputs that have been marked in the session state.
 *
 * Walks each message's parts array.  For every tool part whose
 * `callID` is found in `state.prune.tools`, its `state.output` is
 * replaced IN-PLACE with `PRUNED_TOOL_OUTPUT_REPLACEMENT`.
 *
 * Token accounting (`stats.totalPruneTokens`) is NOT performed here —
 * it happens at mark-time (sweep command / strategies) when the
 * estimated token counts are first recorded.  This avoids double-
 * counting across transform turns since the transform reloads messages
 * fresh from DB each turn but prune.tools accumulates per DCP semantics.
 *
 * This function mutates `messages` in place and reads `state.prune.tools`.
 * It does NOT mutate `state.stats`.
 *
 * @param state - The session state (must have `prune.tools` map).
 * @param messages - Array of session message entries (mutated in place).
 * @returns Array of `PruneReplacement` objects describing each replaced
 *   output (empty array when no marks exist or no matches found).
 */
export function pruneToolOutputs(
  state: SessionState,
  messages: ContextMessageEntry[],
): PruneReplacement[] {
  const tools = state.prune.tools;
  if (tools.size === 0) return [];

  const replacedOutputs: PruneReplacement[] = [];

  // Replace ALL matching outputs in place.
  for (const msg of messages) {
    if (!msg.parts) continue;
    for (const part of msg.parts) {
      const toolPart = part as SweepToolPart;
      if (toolPart.type !== "tool") continue;
      const callID = getCallId(toolPart);
      if (!callID) continue;
      if (!tools.has(callID)) continue;

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

  // NOTE: prune.tools is NOT cleared — it accumulates per DCP semantics.
  // The map persists for TUI visibility and is only reset via
  // deleteSessionState (session.deleted) or compaction.

  return replacedOutputs;
}
