/**
 * Sweep producer — `/dcp sweep` mark logic.
 *
 * Selects tool call IDs from session messages and writes marks via
 * `addMark(state, ..., effective=true)` (immediate release semantics).
 *
 * Two selection modes matching the original `/dcp sweep` semantics:
 * - No count: find the last non-ignored user message, then mark all
 *   tool parts AFTER that index.
 * - Numeric count: walk backward collecting N most recent tool parts.
 *
 * Unified producer model: this is just a function that reads messages
 * and writes marks — no strategy framework, no registry.
 *
 * **First-come-first-served semantics:** if a callID has already been
 * marked (pending or effective), addMark is idempotent and skips — the
 * first writer's mark stands.  The number of newly-created marks
 * reported by `runSweep` may therefore be less than the number of
 * selected tool call IDs.
 *
 * @module
 */

import type { ContextMessageEntry } from "../../metrics.js";
import { addMark } from "../marks.js";
import { lastUserMessageIndex, netReclaimTokens } from "../shared.js";
import type { SessionState, SweepToolPart } from "../types.js";
import { getCallId, PRUNED_TOOL_OUTPUT_REPLACEMENT } from "../types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Options for the sweep producer.
 */
export interface SweepOptions {
  /** Maximum number of tool outputs to mark.  Undefined or negative → "no count" mode (mark all tool parts after the last user message). */
  count?: number;
}

/**
 * A single sweep mark produced by `runSweep`.
 */
export interface SweepMark {
  /** Tool call identifier. */
  callID: string;
  /** Estimated token count reclaimed by pruning this tool's output. */
  estimatedTokens: number;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Run sweep: collect tool call IDs from session messages and mark them
 * via `addMark(state, ..., effective=true)`.
 *
 * Two modes:
 * - No count (`undefined`): find the last non-ignored user message,
 *   then mark all tool parts AFTER that index.
 * - Numeric count: walk backwards collecting tool part callIDs until
 *   N are gathered (or all messages are exhausted).
 *
 * In both modes, callIDs already present in `state.marks` are skipped
 * (addMark's idempotency naturally prevents duplicate marking).
 * All marks are written with `effective=true` (immediate release).
 *
 * @param state - The session state (must have `marks` map).
 * @param messages - The session messages array.
 * @param options - Optional sweep options (`count`).  `undefined`
 *   options or a missing/negative `count` selects the no-count mode.
 * @returns Array of SweepMark items describing what was newly marked.
 */
export function runSweep(
  state: SessionState,
  messages: ContextMessageEntry[],
  options?: SweepOptions,
): SweepMark[] {
  const result: SweepMark[] = [];
  const count = options?.count;

  if (count === undefined || count < 0) {
    // ── No count: mark all tool callIDs after last user message ──
    // Find the last non-ignored user message.
    const lastUserIdx = lastUserMessageIndex(messages);

    // If no user message found, there is nothing to mark.
    if (lastUserIdx >= messages.length) return result;

    // Mark tool parts after lastUserIdx.
    for (let i = lastUserIdx + 1; i < messages.length; i++) {
      const msg = messages[i];
      if (!msg.parts) continue;
      for (const part of msg.parts) {
        const toolPart = part as SweepToolPart;
        if (toolPart.type !== "tool") continue;
        const callID = getCallId(toolPart);
        if (!callID) continue;

        const estimatedTokens = netReclaimTokens(
          toolPart.state?.output,
          PRUNED_TOOL_OUTPUT_REPLACEMENT,
        );

        // addMark is idempotent: skips if already marked.
        if (addMark(state, callID, estimatedTokens, true, "tool-output")) {
          result.push({ callID, estimatedTokens });
        }
      }
    }
  } else {
    // ── Numeric count: walk backward (messages & parts) until N ──
    // Both the message list and parts within each message are walked
    // in reverse so that we mark the N most recent tool callIDs.
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
        if (!callID) continue;

        // Skip if already marked.
        if (state.marks.has(callID)) continue;

        const estimatedTokens = netReclaimTokens(
          toolPart.state?.output,
          PRUNED_TOOL_OUTPUT_REPLACEMENT,
        );

        if (addMark(state, callID, estimatedTokens, true, "tool-output")) {
          result.push({ callID, estimatedTokens });
        }
      }
    }
  }

  return result;
}
