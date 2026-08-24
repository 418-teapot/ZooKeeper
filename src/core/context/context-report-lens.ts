/**
 * Lens-based context report producer — host-agnostic sibling of the v1
 * `computeContextReport` in the OpenCode adapter.
 *
 * Consumes the host-agnostic lens transcript (`HostMessage[]`) and
 * produces the same `ContextReport` the v1 adapter computes, with
 * field-for-field parity (proven by the parity tests in
 * `context-report-lens.test.ts`).
 *
 * Semantics (mirroring the v1 reference):
 * - `messageCount` — non-hidden messages.
 * - `exact` — API-reported tokens of the last completed assistant
 *   (input + output + reasoning + cache read + cache write).
 * - `cacheHitRate` — `cacheRead / (input + cacheRead + cacheWrite)` of
 *   that assistant, or null when no completed assistant exists or the
 *   denominator is zero.
 * - `heuristic` — CJK-aware estimate of every non-hidden message after
 *   the last completed assistant.
 * - `total` — exact + heuristic.
 * - categories: `user` / `tool` from part-level heuristics, `assistant`
 *   from API-reported `tokens.output` (with a text-only heuristic
 *   fallback), `system` as the residual `total − user − assistant −
 *   tool` (clamped at 0).
 *
 * The one behavior rewrite vs v1: pruned tool calls are recognized by
 * the placeholder text rather than a call-id set — a tool-output region
 * whose text starts with `PRUNED_TOOL_OUTPUT_REPLACEMENT` is pruned, so
 * its tool category contribution is `input + placeholder` instead of
 * `input + output`.  This mirrors the v1 post-prune reality where the
 * LLM sees the original input plus the replacement placeholder.
 *
 * Compaction boundary: category statistics (user/tool/assistant) only
 * reflect messages at/after the last message marked `compaction` (a
 * host-native compaction summary); messages before it are historical and
 * excluded.  The total/exact/heuristic/messageCount fields are
 * unaffected — they always cover the whole transcript, mirroring the v1
 * `computeContextReport` (where only `catStartIdx` is boundary-aware).
 *
 * The dual-scope ("模型可见 vs 存储") message counts are exposed as a
 * separate helper (`countFoldedMessages`) so the `ContextReport` type
 * stays unchanged — the formatter receives those counts via
 * `FormatContextReportOptions`, exactly as it does today.
 *
 * @module
 */

import type { ContextReport } from "./context-report.js";
import type { HostMessage, ViewItem } from "./lens.js";
import {
  estimateMessageHeuristic,
  estimateTokenCount,
  findLastCompletedAssistant,
} from "./measure.js";
import { PRUNED_TOOL_OUTPUT_REPLACEMENT } from "./message-parts.js";

// ---------------------------------------------------------------------------
// Compaction boundary
// ---------------------------------------------------------------------------

/**
 * Compute the start ordinal for the report's category breakdown.
 *
 * The category statistics only reflect messages at/after the last
 * compaction-marked message (a host-native compaction summary); the
 * transcript interval before it is historical and excluded.  Returns 0
 * when no compaction message exists, so the category breakdown then
 * covers the whole transcript from the first message — the same
 * no-boundary semantics as the v1 `catStartIdx` (0, not -1).
 *
 * @param messages - The lens transcript.
 * @returns The start ordinal for category statistics (the ordinal of the
 *   last compaction-marked message, or 0 when none exists).
 */
function categoryStartIndex(messages: HostMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.compaction === true) return i;
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Report producer
// ---------------------------------------------------------------------------

/**
 * Compute a context report from the host-agnostic lens transcript.
 *
 * Mirrors the v1 `computeContextReport` semantics field-for-field (see
 * the module docstring).  Hidden messages are skipped by estimation,
 * the heuristic tail, and the category breakdown, and excluded from
 * `messageCount`.  Category statistics start at the last compaction
 * boundary (see `categoryStartIndex`).
 *
 * @param messages - The lens transcript (host-projected, ordinal-aligned).
 * @returns The computed context report.
 */
export function computeContextReportLens(
  messages: HostMessage[] | undefined | null,
): ContextReport {
  const transcript = messages ?? [];

  const messageCount = transcript.filter((m) => !m?.hidden).length;

  // ── Step 0: Find compaction boundary ──────────────────────────────
  // After compaction, category statistics only reflect messages at/after
  // the boundary; total (based on last completed assistant) is unchanged.
  const catStartIdx = categoryStartIndex(transcript);

  // ── Step 1: Find the last completed assistant ──────────────────────
  const { index: lastAssistantIdx, exactTokens } =
    findLastCompletedAssistant(transcript);
  const exact = lastAssistantIdx >= 0 ? exactTokens : 0;

  let cacheHitRate: number | null = null;
  if (lastAssistantIdx >= 0) {
    const usage = transcript[lastAssistantIdx]?.usage;
    if (usage) {
      const cacheRead = usage.cacheRead ?? 0;
      const cacheWrite = usage.cacheWrite ?? 0;
      const inputTokens = usage.input ?? 0;
      const denominator = inputTokens + cacheRead + cacheWrite;
      if (denominator > 0) {
        cacheHitRate = cacheRead / denominator;
      }
    }
  }

  // ── Heuristic for messages after the last assistant (or all) ────────
  let heuristic = 0;
  const startIdx = lastAssistantIdx >= 0 ? lastAssistantIdx + 1 : 0;
  for (let i = startIdx; i < transcript.length; i++) {
    heuristic += estimateMessageHeuristic(transcript[i]);
  }

  const total = exact + heuristic;

  // ── Category breakdown (boundary-aware) ─────────────────────────────
  // user / tool: part-level (region-level) CJK-aware heuristic.
  // assistant: API exact output when available, else text-only heuristic
  // fallback (tool regions excluded — they already landed in tool).
  let userTokens = 0;
  let toolTokens = 0;
  let assistantTokens = 0;

  for (let i = catStartIdx; i < transcript.length; i++) {
    const msg = transcript[i];
    if (!msg || msg.hidden) continue;
    for (const region of msg.regions) {
      if (!region) continue;
      if (region.kind === "tool-input") {
        toolTokens += estimateTokenCount(region.get());
      } else if (region.kind === "tool-output") {
        toolTokens += region.get().startsWith(PRUNED_TOOL_OUTPUT_REPLACEMENT)
          ? estimateTokenCount(PRUNED_TOOL_OUTPUT_REPLACEMENT)
          : estimateTokenCount(region.get());
      } else if (msg.role === "user") {
        userTokens += estimateTokenCount(region.get());
      }
    }
  }

  for (let i = catStartIdx; i < transcript.length; i++) {
    const msg = transcript[i];
    if (!msg || msg.hidden) continue;
    if (msg.role !== "assistant") continue;
    const apiOutput = msg.usage?.output ?? 0;
    if (apiOutput > 0) {
      assistantTokens += apiOutput;
    } else {
      for (const region of msg.regions) {
        if (!region) continue;
        if (region.kind === "tool-input" || region.kind === "tool-output") {
          continue;
        }
        assistantTokens += estimateTokenCount(region.get());
      }
    }
  }

  // ── System (residual) ───────────────────────────────────────────────
  const systemTokens = Math.max(
    0,
    total - userTokens - assistantTokens - toolTokens,
  );

  return {
    total,
    exact,
    heuristic,
    messageCount,
    cacheHitRate,
    categories: {
      user: userTokens,
      assistant: assistantTokens,
      tool: toolTokens,
      system: systemTokens,
    },
  };
}

// ---------------------------------------------------------------------------
// Dual-scope message counts
// ---------------------------------------------------------------------------

/**
 * Dual-scope message counts of a folded view ("模型可见 vs 存储").
 *
 * `storageMessageCount` is the number of non-hidden messages in storage.
 * `foldedMessageCount` is the model-visible count over the folded view
 * items: each summary item counts as one (the synthetic user message is
 * not hidden), and each original item counts when its backing message is
 * not hidden.
 *
 * @param items - The folded view items, in view order.
 * @param messages - The lens transcript aligned 1:1 with the items'
 *   original ordinals.
 * @returns The two non-hidden message counts.
 */
export function countFoldedMessages(
  items: ViewItem[],
  messages: HostMessage[],
): { foldedMessageCount: number; storageMessageCount: number } {
  const storageMessageCount = messages.filter((m) => !m?.hidden).length;
  let foldedMessageCount = 0;
  for (const item of items) {
    if (item.type === "summary") {
      foldedMessageCount += 1;
    } else {
      const msg = messages[item.ordinal];
      if (msg && !msg.hidden) foldedMessageCount += 1;
    }
  }
  return { foldedMessageCount, storageMessageCount };
}
