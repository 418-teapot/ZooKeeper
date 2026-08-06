/**
 * Context-nudge decision layer — single-anchor watermark.
 *
 * Pure, framework-free functions that decide WHEN a context-pressure
 * reminder should be injected (threshold resolution + watermark
 * evaluation) and WHAT payload to attach (compressible-window refs +
 * reclaim estimate).  Zero IO, zero clock, zero module-level state —
 * every value enters through a function parameter.
 *
 * **Single-anchor watermark:** all persisted state is one number
 * (`lastNudgeTokens`).  On each evaluation
 * `anchor = min(last ?? tokens, tokens)` ratchets the anchor down
 * whenever context shrinks (after compression) and holds it flat while
 * context is frozen — no special branches for either case.  A nudge
 * fires only when the token level is past the `min`/`max` band AND the
 * distance from the anchor has grown past the per-level interval
 * (`growthTokens` for gentle, `floor(growthTokens / 2)` for urgent).
 * The first evaluation of a session only establishes the baseline
 * (delta is 0, so it never fires) — existing sessions start silent.
 *
 * @module
 */

import type { ContextMessageEntry } from "../metrics.js";
import type { CompressionConfig } from "./compress.js";
import {
  estimateSegmentTokens,
  firstUserMessageIndex,
  lastUserMessageIndex,
  tokenBoundary,
} from "./compress.js";
import { protectedBoundary } from "./shared.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Raw nudge configuration (what the caller reads from config.toml).
 *
 * Each threshold accepts either an absolute token count or a percentage
 * string (`"60%"` → `round(percent × contextLimit)`).  Caps bound the
 * resolved thresholds via `min(cap, value)`; growth has no cap.
 */
export interface NudgeConfig {
  /** Gentle-band entry threshold (absolute tokens or `"NN%"`). */
  minContext: number | string;
  /** Upper bound for `minContext` after percentage resolution. */
  minContextCap: number;
  /** Urgent-band entry threshold (absolute tokens or `"NN%"`). */
  maxContext: number | string;
  /** Upper bound for `maxContext` after percentage resolution. */
  maxContextCap: number;
  /** Gentle re-nudge interval (absolute tokens or `"NN%"`); urgent is half. */
  growthTokens: number | string;
}

/**
 * Resolved nudge thresholds for the current context window.
 */
export interface NudgeThresholds {
  /** Gentle band entry: tokens >= min → `"gentle"` level. */
  min: number;
  /** Urgent band entry: tokens >= max → `"urgent"` level. */
  max: number;
  /** Gentle re-nudge interval; urgent uses `floor(growthTokens / 2)`. */
  growthTokens: number;
}

/**
 * Result of a single watermark evaluation.
 *
 * `newAnchor` is ALWAYS present — the caller persists it on every call
 * (even when `level` is null) so the ratchet keeps following context
 * downward between triggers.  A message should be injected only when
 * `level` is set.
 */
export interface NudgeEvaluation {
  /** Level to surface, or null when no nudge should be injected. */
  level: "gentle" | "urgent" | null;
  /** Anchor to persist — `promptTokens` when triggered, else `anchor`. */
  newAnchor: number;
}

/**
 * Configuration for the compressible-window computation.
 *
 * Alias of the compression planner's `CompressionConfig` — the nudge
 * advertises exactly the window the compress path would accept, so it
 * consumes the same triple-protection inputs (message-count, token
 * budget, phantom threshold).  The alias is kept so call sites read as
 * "prune-fold configuration" without duplicating the interface body.
 */
export type PruneFoldConfig = CompressionConfig;

/**
 * Eligibility payload for a nudge message.
 *
 * `startRef` / `endRef` address the compressible window — the same
 * triple-protection boundaries the `compress` tool enforces, with the
 * first user message excluded.  Both refs are INCLUSIVE window bounds;
 * the model picks its own contiguous sub-range inside them.
 * `reclaimTokens` estimates what compressing the whole window would free.
 */
export interface NudgeEligibility {
  /** Ref of the first eligible message holding a ref (window start, inclusive). */
  startRef: string;
  /** Ref of the last eligible message holding a ref (window end, inclusive). */
  endRef: string;
  /** Heuristic token estimate of the eligible window. */
  reclaimTokens: number;
}

// ---------------------------------------------------------------------------
// Threshold resolution
// ---------------------------------------------------------------------------

/**
 * Matches a percentage string: one optional decimal fraction + one `%`.
 * Exported — the config parser in `src/opencode.ts` validates nudge
 * thresholds with the same syntax, so the pattern lives here only.
 */
export const NUDGE_PERCENT_RE = /^(\d+(?:\.\d+)?)%$/;

/**
 * Resolve a raw threshold value (absolute number or percentage string).
 *
 * Percentage strings multiply the context limit and round to an integer.
 * Returns `null` for wrong types, malformed percentages, and non-finite
 * results (a non-finite context limit would otherwise leak through).
 *
 * @param raw - The raw config value.
 * @param contextLimit - The current model context window (tokens).
 * @returns The resolved value, or `null`.
 */
function resolveRawValue(
  raw: number | string,
  contextLimit: number,
): number | null {
  if (typeof raw === "number") {
    if (!Number.isFinite(raw)) return null;
    return raw;
  }
  if (typeof raw === "string") {
    const match = NUDGE_PERCENT_RE.exec(raw);
    if (!match) return null;
    const percent = Number(match[1]);
    if (!Number.isFinite(percent)) return null;
    const value = Math.round((percent / 100) * contextLimit);
    return Number.isFinite(value) ? value : null;
  }
  return null;
}

/**
 * Resolve raw nudge configuration into thresholds for a context window.
 *
 * For each of `minContext` / `maxContext`: absolute values pass through,
 * percentage strings resolve against `contextLimit`, then the result is
 * clamped via `min(cap, value)`.  `growthTokens` resolves the same way
 * but is NEVER capped.
 *
 * Returns `null` on ANY invalid input — wrong type, malformed percentage
 * string, non-finite caps, non-positive resolved values, or `min >= max`
 * after resolution.  The caller treats `null` as "nudge subsystem
 * disabled" and skips evaluation entirely.
 *
 * @param config - Raw nudge configuration.
 * @param contextLimit - The current model context window (tokens).
 * @returns Resolved thresholds, or `null`.
 */
export function resolveThresholds(
  config: NudgeConfig,
  contextLimit: number,
): NudgeThresholds | null {
  if (
    !Number.isFinite(config.minContextCap) ||
    !Number.isFinite(config.maxContextCap)
  ) {
    return null;
  }
  const min = resolveRawValue(config.minContext, contextLimit);
  const max = resolveRawValue(config.maxContext, contextLimit);
  const growth = resolveRawValue(config.growthTokens, contextLimit);
  if (min === null || max === null || growth === null) return null;

  const minResolved = Math.min(config.minContextCap, min);
  const maxResolved = Math.min(config.maxContextCap, max);
  if (minResolved <= 0 || maxResolved <= 0 || growth <= 0) return null;
  if (minResolved >= maxResolved) return null;
  return { min: minResolved, max: maxResolved, growthTokens: growth };
}

// ---------------------------------------------------------------------------
// Watermark evaluation
// ---------------------------------------------------------------------------

/**
 * Evaluate the single-anchor watermark for one prompt snapshot.
 *
 * `anchor = min(last ?? tokens, tokens)` — a ratchet that follows context
 * downward automatically (after compression the anchor drops with the
 * watermark) and holds flat while context is frozen, with no special
 * branches.  Level is `"urgent"` at/above `max`, `"gentle"` at/above
 * `min`, else null.  A trigger fires only when a level is set AND the
 * distance from the anchor has grown past the level's interval
 * (`growthTokens` gentle, `floor(growthTokens / 2)` urgent); on trigger
 * the anchor moves to the current tokens, otherwise it stays at `anchor`.
 *
 * The returned `newAnchor` must be persisted by the caller on EVERY call
 * (including non-triggers) — that persistence is what makes the ratchet
 * monotonic between evaluations.  A message is injected only when
 * `level` is set.
 *
 * @param lastNudgeTokens - Persisted anchor from the previous evaluation
 *   (`undefined` on the first evaluation of a session).
 * @param promptTokens - Current estimated prompt tokens.
 * @param thresholds - Resolved thresholds (from `resolveThresholds`).
 * @returns The evaluation — level (or null) plus the anchor to persist.
 */
export function evaluateNudge(
  lastNudgeTokens: number | undefined,
  promptTokens: number,
  thresholds: NudgeThresholds,
): NudgeEvaluation {
  const anchor = Math.min(lastNudgeTokens ?? promptTokens, promptTokens);
  const level =
    promptTokens >= thresholds.max
      ? "urgent"
      : promptTokens >= thresholds.min
        ? "gentle"
        : null;
  if (level !== null) {
    const interval =
      level === "urgent"
        ? Math.floor(thresholds.growthTokens / 2)
        : thresholds.growthTokens;
    if (promptTokens - anchor >= interval) {
      return { level, newAnchor: promptTokens };
    }
  }
  return { level: null, newAnchor: anchor };
}

// ---------------------------------------------------------------------------
// Eligibility payload
// ---------------------------------------------------------------------------

/**
 * Compute the eligibility payload for a nudge message.
 *
 * Derives the compressible window from the SAME boundaries the compress
 * path enforces (triple protection + first-user-message exclusion), so
 * the nudge never advertises a range the `compress` tool would reject:
 *
 * - `endIdx = min(protectedBoundary, tokenBoundary, lastUserMessageIndex)`
 * - `startIdx = firstUserMessageIndex + 1` (the first user message is
 *   never compressible)
 *
 * `startRef` is the FIRST ref-holding message at/after `startIdx`;
 * `endRef` is the LAST ref-holding message before `endIdx`.
 * `reclaimTokens` is the heuristic estimate of the whole window
 * `[startIdx, endIdx)` (over the message view the caller passes in — no
 * folding happens here).
 *
 * Returns `null` when there is no user message, the window is empty, no
 * ref-holding message exists inside it, or the window estimate falls
 * below `config.thresholdTokens` (a compress in this window would be a
 * phantom-gate no-op rejection).
 *
 * @param messages - The session message view (folded or raw).
 * @param config - Window protection configuration (message count, token
 *   budget, phantom threshold).
 * @param refForMessage - Lookup from message ID to its assigned ref
 *   (injected so this module stays free of the ref registry).
 * @returns The eligibility payload, or `null`.
 */
export function computeEligibility(
  messages: ContextMessageEntry[],
  config: PruneFoldConfig,
  refForMessage: (messageId: string) => string | undefined,
): NudgeEligibility | null {
  const endIdx = Math.min(
    protectedBoundary(messages, config.protectedMessages),
    tokenBoundary(messages, config.protectedTokens),
    lastUserMessageIndex(messages),
  );
  const firstUserIdx = firstUserMessageIndex(messages);
  if (firstUserIdx < 0) return null;
  const startIdx = firstUserIdx + 1;
  if (startIdx >= endIdx) return null;

  // First ref-holding message inside the window (inclusive start bound).
  let startRef: string | undefined;
  for (let i = startIdx; i < endIdx; i++) {
    const messageId = messages[i]?.info?.id;
    if (!messageId) continue;
    const ref = refForMessage(messageId);
    if (ref) {
      startRef = ref;
      break;
    }
  }
  if (!startRef) return null;

  // Last ref-holding message inside the window (inclusive end bound).
  let endRef: string | undefined;
  for (let i = endIdx - 1; i >= startIdx; i--) {
    const messageId = messages[i]?.info?.id;
    if (!messageId) continue;
    const ref = refForMessage(messageId);
    if (ref) {
      endRef = ref;
      break;
    }
  }
  if (!endRef) return null;

  const reclaimTokens = estimateSegmentTokens(messages, {
    startIndex: startIdx,
    endIndex: endIdx,
  });

  // Phantom alignment: a compress inside this window would be rejected
  // as a no-op, so the nudge stays silent.
  if (reclaimTokens < config.thresholdTokens) return null;

  return { startRef, endRef, reclaimTokens };
}
