/**
 * Context-nudge decision and injection over the host-agnostic lens.
 *
 * The nudge subsystem decides WHEN a context-pressure reminder should be
 * injected (threshold resolution + single-anchor watermark evaluation)
 * and WHAT payload to attach (compressible-window refs + reclaim
 * estimate, rendered through the shared templates in `prompts.ts`).
 *
 * Threshold resolution and the watermark math operate over host-agnostic
 * inputs; the token level and the eligibility window are derived from
 * the lens transcript through the measurement machinery
 * (`measure.ts` / `compress.ts`).
 *
 * **Denominator semantics:** the level comparison uses the *prompt-side
 * total* of the last completed assistant message — `input + cacheRead +
 * cacheWrite` — fed into `evaluateNudge`.  `MessageMeasure.exact` is NOT
 * used here: it also sums `output` and `reasoning`, which nudge
 * evaluation deliberately excludes, so using it would shift every trigger
 * boundary.
 *
 * **Single-anchor watermark:** all persisted state is one number
 * (`state.nudges.lastNudgeTokens`).  On each evaluation
 * `anchor = min(last ?? tokens, tokens)` ratchets the anchor down
 * whenever context shrinks (after compression) and holds it flat while
 * context is frozen — no special branches for either case.  A nudge
 * fires only when the token level is past the `min`/`max` band AND the
 * distance from the anchor has grown past the per-level interval
 * (`growthTokens` for gentle, `floor(growthTokens / 2)` for urgent).
 * The first evaluation of a session only establishes the baseline
 * (delta is 0, so it never fires) — existing sessions start silent.
 * `evaluateNudge` persists the anchor on EVERY call (even when nothing
 * fires), so the ratchet keeps following context downward between
 * triggers; a nudge message is injected only when a level fires AND an
 * eligible compressible window exists.
 *
 * @module
 */

import { CONTEXT_NUDGE_LEVELS, CONTEXT_NUDGE_TEMPLATE } from "../prompts.js";
import { computeProtectedStartOrdinal } from "./compress.js";
import type { HostMessage } from "./lens.js";
import { findFirstUserOrdinal, findLastUserOrdinal } from "./lens.js";
import {
  estimateMessageHeuristic,
  findLastCompletedAssistant,
} from "./measure.js";
import type { SessionState } from "./state.js";

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
 * Nudge level exposed by the evaluation; drives the text copy slots.
 */
export type NudgeLevel = "gentle" | "urgent";

/**
 * Configuration for the compressible-window computation.
 *
 * The window the nudge advertises is exactly the window the compress
 * path would accept (message-count protection, token-budget protection,
 * phantom threshold), so it consumes the same triple-protection inputs
 * as the compression gates.
 */
export interface EligibilityConfig {
  /** Number of most recent non-hidden messages to protect. */
  protectedMessages: number;
  /** Token budget protected from the end of the session (CJK heuristic). */
  protectedTokens: number;
  /** Minimum estimated tokens a window must carry to bypass the phantom gate. */
  thresholdTokens: number;
}

/**
 * Eligibility payload for a nudge message.
 *
 * `startRef` / `endRef` address the compressible window — the same
 * triple-protection boundaries the `compress` tool enforces, with the
 * first user message excluded.  Both refs are INCLUSIVE window bounds;
 * the model picks its own contiguous sub-range inside them.  The ref
 * strings are supplied by the caller (per-round line numbers in the
 * current architecture); this module only locates their holder
 * messages.  `reclaimTokens` estimates what compressing the whole
 * window would free.
 */
export interface NudgeEligibility {
  /** Ref of the first eligible message holding a ref (window start, inclusive). */
  startRef: string;
  /** Ref of the last eligible message holding a ref (window end, inclusive). */
  endRef: string;
  /** Heuristic token estimate of the eligible window. */
  reclaimTokens: number;
}

/**
 * Context inputs for one nudge evaluation.
 *
 * Bundles the model context window (percentage resolution + header
 * percent) with the compressible-window inputs and the ref lookup.
 */
export interface NudgeInjectOptions extends EligibilityConfig {
  /** The current model context window (tokens). */
  contextLimit: number;
  /** Map a message ordinal to its per-round line ref, or undefined when
   * the message carries no ref (hidden / not injectable). */
  refForOrdinal: (ordinal: number) => string | undefined;
}

// ---------------------------------------------------------------------------
// Threshold resolution
// ---------------------------------------------------------------------------

/**
 * Matches a percentage string: one optional decimal fraction + one `%`.
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
// Watermark evaluation + injection
// ---------------------------------------------------------------------------

/**
 * Compute the prompt-side total of the last completed assistant message.
 *
 * Sums `input + cache read + cache write`, output and reasoning excluded.
 * The completion detection reuses the measurement machinery, so a
 * streaming or text-only assistant (no API output) is not completed and
 * yields 0.
 *
 * @param messages - The transcript.
 * @returns The prompt-side total, or 0 when no completed assistant exists.
 */
function promptSideTokens(messages: HostMessage[]): number {
  const { index } = findLastCompletedAssistant(messages);
  if (index < 0) return 0;
  const usage = messages[index]?.usage;
  return (
    (usage?.input ?? 0) + (usage?.cacheRead ?? 0) + (usage?.cacheWrite ?? 0)
  );
}

/**
 * Render the nudge text for a fired level from the shared templates.
 *
 * Fills the copy slots of `CONTEXT_NUDGE_TEMPLATE` from
 * `CONTEXT_NUDGE_LEVELS` with the current token level, the header
 * percent, and the eligible window refs.
 *
 * @param level - The fired level.
 * @param promptTokens - The prompt-side token total (header tokens).
 * @param contextLimit - The model context window (percent + limit).
 * @param eligibility - The eligible compressible window.
 * @returns The assembled reminder text.
 */
function renderNudgeText(
  level: NudgeLevel,
  promptTokens: number,
  contextLimit: number,
  eligibility: NudgeEligibility,
): string {
  const copy = CONTEXT_NUDGE_LEVELS[level];
  const percent = Math.round((promptTokens / contextLimit) * 100);
  return CONTEXT_NUDGE_TEMPLATE.replaceAll("{HEADER}", copy.header)
    .replaceAll("{tokens}", String(promptTokens))
    .replaceAll("{percent}", `${percent}%`)
    .replaceAll("{limit}", String(contextLimit))
    .replaceAll("{startRef}", eligibility.startRef)
    .replaceAll("{endRef}", eligibility.endRef)
    .replaceAll("{reclaim}", String(eligibility.reclaimTokens))
    .replaceAll("{ACTION}", copy.action)
    .replaceAll("{TEACHING}", copy.teaching)
    .replaceAll("{EQUATION}", copy.equation);
}

/**
 * Evaluate the nudge decision for one prompt snapshot and inject the
 * reminder text when it fires.
 *
 * The full decision flow, driven by the single-anchor watermark:
 *
 * 1. An absent or invalid `config` (thresholds fail to resolve) disables
 *    the subsystem — nothing runs and the watermark is untouched.
 * 2. Without a completed assistant message there is no real token level
 *    — the evaluation is skipped (watermark untouched).
 * 3. The token level is the prompt-side total (see `promptSideTokens`).
 *    `anchor = min(last ?? tokens, tokens)` ratchets downward; the level
 *    is `"urgent"` at/above `max`, `"gentle"` at/above `min`, else null.
 * 4. A trigger fires when a level is set AND the distance from the anchor
 *    has grown past the level's interval (`growthTokens` gentle,
 *    `floor(growthTokens / 2)` urgent); on trigger the anchor moves to
 *    the current tokens, otherwise it stays at `anchor`.
 * 5. The anchor is persisted on EVERY evaluation (the ratchet follows
 *    context downward between triggers), a no-op when unchanged.
 * 6. When a level fires AND an eligible compressible window exists, the
 *    reminder text is assembled from the shared templates and returned;
 *    otherwise `null` (the anchor was still persisted).
 *
 * @param state - The session state; `state.nudges.lastNudgeTokens` is
 *   read and persisted.
 * @param messages - The transcript (folded view).
 * @param config - Raw nudge configuration; `undefined` disables.
 * @param options - Context window, protection inputs, and the ref lookup.
 * @returns The reminder text, or `null` when nothing should be injected.
 */
export function evaluateNudge(
  state: SessionState,
  messages: HostMessage[],
  config: NudgeConfig | undefined,
  options: NudgeInjectOptions,
): string | null {
  if (config === undefined) return null;
  const thresholds = resolveThresholds(config, options.contextLimit);
  if (thresholds === null) return null;

  const { index } = findLastCompletedAssistant(messages);
  if (index < 0) return null;

  const promptTokens = promptSideTokens(messages);
  const anchor = Math.min(
    state.nudges?.lastNudgeTokens ?? promptTokens,
    promptTokens,
  );
  const level: NudgeLevel | null =
    promptTokens >= thresholds.max
      ? "urgent"
      : promptTokens >= thresholds.min
        ? "gentle"
        : null;
  let newAnchor = anchor;
  let fired = false;
  if (level !== null) {
    const interval =
      level === "urgent"
        ? Math.floor(thresholds.growthTokens / 2)
        : thresholds.growthTokens;
    if (promptTokens - anchor >= interval) {
      newAnchor = promptTokens;
      fired = true;
    }
  }

  // Persist the anchor on EVERY evaluation; a no-op when unchanged.
  const prevAnchor = state.nudges?.lastNudgeTokens;
  if (prevAnchor !== newAnchor) {
    state.nudges = { ...(state.nudges ?? {}), lastNudgeTokens: newAnchor };
  }

  if (!fired || level === null) return null;

  const eligibility = computeEligibility(
    messages,
    options,
    options.refForOrdinal,
  );
  if (eligibility === null) return null;

  return renderNudgeText(
    level,
    promptTokens,
    options.contextLimit,
    eligibility,
  );
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
 * - `endIdx = min(protectedStart, lastUserOrdinal)` where
 *   `protectedStart` is the union of the trailing message-count and
 *   token-budget windows, and the last non-hidden user message caps the
 *   window from the end.
 * - `startIdx = firstUserOrdinal + 1` (the first user message is never
 *   compressible).
 *
 * `startRef` is the FIRST ref-holding message at/after `startIdx`;
 * `endRef` is the LAST ref-holding message before `endIdx`.
 * `reclaimTokens` is the heuristic estimate of the whole window
 * `[startIdx, endIdx)` (no folding happens here).
 *
 * Returns `null` when there is no user message, the window is empty, no
 * ref-holding message exists inside it, or the window estimate falls
 * below `config.thresholdTokens` (a compress in this window would be a
 * phantom-gate no-op rejection).
 *
 * @param history - The transcript.
 * @param config - Window protection configuration (message count, token
 *   budget, phantom threshold).
 * @param refForOrdinal - Lookup from message ordinal to its per-round
 *   line ref (injected so this module stays free of the view layer).
 * @returns The eligibility payload, or `null`.
 */
export function computeEligibility(
  history: HostMessage[],
  config: EligibilityConfig,
  refForOrdinal: (ordinal: number) => string | undefined,
): NudgeEligibility | null {
  const lastUser = findLastUserOrdinal(history);
  const endIdx = Math.min(
    computeProtectedStartOrdinal(
      history,
      config.protectedMessages,
      config.protectedTokens,
    ),
    lastUser >= 0 ? lastUser : history.length,
  );
  const firstUserIdx = findFirstUserOrdinal(history);
  if (firstUserIdx < 0) return null;
  const startIdx = firstUserIdx + 1;
  if (startIdx >= endIdx) return null;

  // First ref-holding message inside the window (inclusive start bound).
  let startRef: string | undefined;
  for (let i = startIdx; i < endIdx; i++) {
    const ref = refForOrdinal(i);
    if (ref) {
      startRef = ref;
      break;
    }
  }
  if (!startRef) return null;

  // Last ref-holding message inside the window (inclusive end bound).
  let endRef: string | undefined;
  for (let i = endIdx - 1; i >= startIdx; i--) {
    const ref = refForOrdinal(i);
    if (ref) {
      endRef = ref;
      break;
    }
  }
  if (!endRef) return null;

  let reclaimTokens = 0;
  for (let i = startIdx; i < endIdx; i++) {
    reclaimTokens += estimateMessageHeuristic(history[i]);
  }

  // Phantom alignment: a compress inside this window would be rejected
  // as a no-op, so the nudge stays silent.
  if (reclaimTokens < config.thresholdTokens) return null;

  return { startRef, endRef, reclaimTokens };
}
