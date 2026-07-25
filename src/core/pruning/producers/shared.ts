/**
 * Shared utilities for pruning producers.
 *
 * Provides turn‑protection logic and token‑reclaim estimation that are
 * common across multiple producers (dedup, purge-errors, …).
 *
 * @module
 */

import type { ContextMessageEntry } from "../../metrics.js";
import { estimateTokenCount } from "../../metrics.js";
import type { SweepToolPart } from "../types.js";
import { getCallId } from "../types.js";

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
export function collectProtectedCallIDs(
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
// Token reclaim estimation
// ---------------------------------------------------------------------------

/**
 * Compute net token reclaim when replacing content with a placeholder.
 *
 * Returns `estimateTokenCount(content) - estimateTokenCount(placeholder)`,
 * clamped to 0 (never negative — a negative reclaim means no benefit).
 *
 * @param content - The original tool output content (may be nullish).
 * @param placeholder - The placeholder text to replace with.
 * @returns The estimated tokens saved, >= 0.
 */
export function netReclaimTokens(
  content: unknown,
  placeholder: string,
): number {
  const rawDiff = estimateTokenCount(content) - estimateTokenCount(placeholder);
  return rawDiff > 0 ? rawDiff : 0;
}
