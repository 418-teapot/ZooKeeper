/**
 * Context token measurement over the host-agnostic lens.
 *
 * Hybrid estimation semantics: API-reported exact token counts from the
 * last completed assistant message take precedence, and every other
 * message is estimated with the CJK-aware heuristic (CJK /1.5, other /4,
 * per-region ceil).  Messages are read exclusively through `TextRegion`
 * lenses — this module never unpacks host message structures.
 *
 * @module
 */

import type { HostMessage, TextRegion } from "./lens.js";
import { PRUNED_TOOL_OUTPUT_REPLACEMENT } from "./message-parts.js";

// Re-exported so sibling lens-domain modules (e.g. the release phase)
// consume the placeholder contract without naming the v1-shaped source
// module.  The estimation here interprets these exact strings.
export {
  PRUNED_TOOL_ERROR_INPUT_REPLACEMENT,
  PRUNED_TOOL_OUTPUT_REPLACEMENT,
} from "./message-parts.js";

// ---------------------------------------------------------------------------
// Text heuristic
// ---------------------------------------------------------------------------

/**
 * Estimate token count for a plain string using a CJK-aware heuristic.
 *
 * CJK characters (Unicode ranges: U+4E00–U+9FFF, U+3400–U+4DBF,
 * U+3000–U+303F, U+FF00–U+FFEF) are divided by 1.5; all others by 4.
 * The result is rounded up via `Math.ceil`.
 *
 * @param text - Input string.
 * @returns Estimated token count.
 */
function estimateStringTokens(text: string): number {
  if (!text) return 0;
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (
      (code >= 0x4e00 && code <= 0x9fff) || // CJK Unified Ideographs
      (code >= 0x3400 && code <= 0x4dbf) || // CJK Extension A
      (code >= 0x3000 && code <= 0x303f) || // CJK Symbols & Punctuation
      (code >= 0xff00 && code <= 0xffef) // Fullwidth / Halfwidth forms
    ) {
      cjk++;
    } else {
      other++;
    }
  }
  return Math.ceil(cjk / 1.5 + other / 4);
}

/**
 * Estimate token count for an arbitrary value.
 *
 * - null / undefined → 0
 * - string → `estimateStringTokens`
 * - other → JSON.stringify first, then `estimateStringTokens`
 *
 * @param val - The value to estimate.
 * @returns Estimated token count.
 */
export function estimateTokenCount(val: unknown): number {
  if (val == null) return 0;
  const str = typeof val === "string" ? val : JSON.stringify(val);
  return estimateStringTokens(str);
}

// ---------------------------------------------------------------------------
// Message-level heuristic
// ---------------------------------------------------------------------------

/**
 * Predicate identifying tool-output regions whose output has already been
 * pruned (replaced by a placeholder).
 *
 * The caller decides how a pruned position is recognized — for example by
 * binding a mark keyed by `(ordinal, regionIndex)` in a closure.  The
 * estimator only asks whether a given tool-output region is pruned; other
 * region kinds are never consulted.
 */
export type PrunedRegionPredicate = (region: TextRegion) => boolean;

/**
 * Estimate token count for a single message using the CJK-aware heuristic.
 *
 * A hidden message counts as 0 and is skipped entirely.  The text of every
 * region — content, thinking, tool-input, and tool-output — is estimated
 * with the per-region ceil rule and the results summed (no pooled ceil).
 * When `prunedToolOutput` marks a tool-output region as pruned, that
 * region contributes the placeholder estimate instead of its text, keeping
 * the "input + placeholder" accounting for pruned tool calls; the sibling
 * tool-input region is still counted normally.
 *
 * Defensive: returns 0 for falsy messages, hidden messages, empty region
 * lists, and null region entries.
 *
 * @param msg - The message to estimate.
 * @param prunedToolOutput - Optional predicate for pruned tool-output regions.
 * @returns Estimated token count, or 0 when the message has no content.
 */
export function estimateMessageHeuristic(
  msg: HostMessage | undefined | null,
  prunedToolOutput?: PrunedRegionPredicate,
): number {
  if (!msg || msg.hidden) return 0;
  let tokens = 0;
  for (const region of msg.regions) {
    if (!region) continue;
    if (
      region.kind === "tool-output" &&
      prunedToolOutput &&
      prunedToolOutput(region)
    ) {
      tokens += estimateTokenCount(PRUNED_TOOL_OUTPUT_REPLACEMENT);
      continue;
    }
    const text = region.get();
    if (text) {
      tokens += estimateStringTokens(text);
    }
  }
  return tokens;
}

// ---------------------------------------------------------------------------
// Whole-session estimation
// ---------------------------------------------------------------------------

/**
 * Result of locating the last completed assistant message.
 */
export interface LastCompletedAssistantResult {
  /** Ordinal of the found message, or -1 when none exists. */
  index: number;
  /** Sum of all API-reported token fields of that message. */
  exactTokens: number;
}

/**
 * Find the last completed assistant message.
 *
 * A completed assistant has `role === "assistant"` and
 * `usage.output > 0`.  The exact token sum adds the five API-reported
 * components: input + output + reasoning + cache read + cache write.
 * Hidden messages remain eligible — the host may still report exact usage
 * for them.  Null entries in the transcript are skipped.
 *
 * @param messages - The transcript.
 * @returns The found ordinal and exact sum, or index -1 when none exists.
 */
export function findLastCompletedAssistant(
  messages: HostMessage[],
): LastCompletedAssistantResult {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg?.role !== "assistant") continue;
    const usage = msg.usage;
    if (!usage || (usage.output ?? 0) <= 0) continue;
    const exactTokens =
      (usage.input ?? 0) +
      (usage.output ?? 0) +
      (usage.reasoning ?? 0) +
      (usage.cacheRead ?? 0) +
      (usage.cacheWrite ?? 0);
    return { index: i, exactTokens };
  }
  return { index: -1, exactTokens: 0 };
}

/**
 * Result of measuring a whole transcript.
 */
export interface MessageMeasure {
  /** API-reported exact tokens from the last completed assistant. */
  exact: number;
  /** Heuristic estimate for messages after the last completed assistant. */
  heuristic: number;
  /** Exact + heuristic. */
  total: number;
  /** Number of non-hidden messages. */
  messageCount: number;
}

/**
 * Measure a whole transcript.
 *
 * Exact tokens come from the last completed assistant message (see
 * `findLastCompletedAssistant`); every message after it is estimated
 * heuristically, with hidden messages contributing 0.  When no completed
 * assistant exists the whole transcript is estimated heuristically.
 * Hidden messages are excluded from `messageCount`.
 *
 * @param messages - The transcript; nullish and empty inputs yield zeros.
 * @returns The measured result.
 */
export function measureMessages(
  messages: HostMessage[] | undefined | null,
): MessageMeasure {
  if (!messages || messages.length === 0) {
    return { exact: 0, heuristic: 0, total: 0, messageCount: 0 };
  }
  const { index, exactTokens } = findLastCompletedAssistant(messages);
  const exact = index >= 0 ? exactTokens : 0;
  let heuristic = 0;
  const startIdx = index >= 0 ? index + 1 : 0;
  for (let i = startIdx; i < messages.length; i++) {
    heuristic += estimateMessageHeuristic(messages[i]);
  }
  const messageCount = messages.filter((m) => !m?.hidden).length;
  return { exact, heuristic, total: exact + heuristic, messageCount };
}

// ---------------------------------------------------------------------------
// Reclaim estimation
// ---------------------------------------------------------------------------

/**
 * Compute net token reclaim when replacing content with a placeholder.
 *
 * `estimateTokenCount(content) - estimateTokenCount(placeholder)`, clamped
 * to 0 — a negative reclaim means the replacement saves nothing.  Nullish
 * content estimates as 0 tokens.
 *
 * @param content - The original content to be replaced.
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
