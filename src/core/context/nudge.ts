/**
 * Context-nudge decision and injection over the host-agnostic lens.
 *
 * The nudge subsystem decides WHEN a context-pressure reminder should be
 * injected (threshold resolution + single-anchor watermark evaluation)
 * and WHAT payload to attach (compressible-window refs + reclaim
 * estimate, rendered through the shared templates in `prompts.ts`).
 *
 * Threshold resolution and the watermark math operate over host-agnostic
 * inputs; the token level comes from the API usage carried by the last
 * completed assistant message, while the eligibility window is measured
 * over the FOLDED, numbered view — the same `mN` address space the model
 * is shown.
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
 * **Measured level:** the API measurement of the water level lags the
 * view — the usage of the last completed assistant describes the prompt
 * that call was billed for, so a compression that happens later in the
 * same round is invisible to it until the NEXT call is billed.  A
 * compression therefore books its reclaim (`creditReclaim`), and the
 * booked amount discounts the measured total until a different
 * measurement arrives; a fresh measurement is taken from the already
 * shrunk view, so the discount is consumed rather than applied again.
 *
 * **Window coordinates:** the compressible window, its refs and its
 * reclaim estimate all live in the numbered view, never in raw transcript
 * ordinals — a folded interval still holds its original text in the raw
 * transcript, so measuring there would advertise tokens the view no
 * longer shows.  Only the protection boundary stays in ordinal space,
 * because that is the space the `compress` gates are defined in; it is
 * translated to view lines by requiring a line to sit ENTIRELY below it.
 * Lines folded into a summary contribute no reclaim (their tokens are
 * already spent), which keeps the estimate at what a new compression
 * could still free.
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
import type { NumberedItem } from "./view-refs.js";
import { itemInterval } from "./view-refs.js";

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
 * protection boundaries the `compress` tool enforces, with the first user
 * message excluded — as per-round view lines.  Both refs are INCLUSIVE
 * window bounds; the model picks its own contiguous sub-range inside
 * them.  `reclaimTokens` estimates what compressing the whole window
 * would free, counting only the content the view still shows in full.
 */
export interface NudgeEligibility {
  /** Ref of the first view line of the window (inclusive). */
  startRef: string;
  /** Ref of the last view line of the window (inclusive). */
  endRef: string;
  /** Estimated tokens a compression of the whole window would free. */
  reclaimTokens: number;
}

/**
 * Context inputs for one nudge evaluation.
 *
 * Bundles the model context window (percentage resolution + header
 * percent) with the compressible-window inputs and this round's numbered
 * view.
 */
export interface NudgeInjectOptions extends EligibilityConfig {
  /** The current model context window (tokens). */
  contextLimit: number;
  /** This round's numbered folded view — the `mN` address space the model
   * holds, and the coordinate system the window is measured in. */
  numbered: NumberedItem[];
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
 * Book a compression's reclaim against the water level.
 *
 * The reclaim is a one-shot discount on the measured prompt-side total:
 * the usage figures the nudge measures are written by the API call that
 * preceded the compression, so without this booking the level keeps
 * counting tokens the view no longer shows.
 *
 * Repeated compressions of the same stale measurement accumulate — each
 * booked amount is real content removed from the view.
 *
 * @param state - The session state (mutated).
 * @param reclaimTokens - Tokens the compression took out of the view.
 */
export function creditReclaim(
  state: SessionState,
  reclaimTokens: number,
): void {
  if (!Number.isFinite(reclaimTokens) || reclaimTokens <= 0) return;
  const nudges = { ...(state.nudges ?? {}) };
  nudges.pendingReclaimTokens =
    (nudges.pendingReclaimTokens ?? 0) + Math.round(reclaimTokens);
  state.nudges = nudges;
}

/**
 * Clear the booked reclaim.
 *
 * Drops the discount and the measurement it was anchored to, so the next
 * evaluation reads the measurement at face value.
 *
 * @param state - The session state (mutated).
 */
function consumeReclaimCredit(state: SessionState): void {
  if (
    state.nudges?.pendingReclaimTokens === undefined &&
    state.nudges?.reclaimMeasurement === undefined
  ) {
    return;
  }
  const nudges = { ...(state.nudges ?? {}) };
  delete nudges.pendingReclaimTokens;
  delete nudges.reclaimMeasurement;
  state.nudges = nudges;
}

/**
 * The measured prompt-side total after the booked reclaim, if any.
 *
 * The discount is anchored to the measurement it was granted against
 * (`state.nudges.reclaimMeasurement`): while the measurement is that
 * same value the compression is not billed yet and the discount applies;
 * any other measurement comes from a view the compression already shrank,
 * so the discount is consumed here and the value is reported as measured
 * (the same tokens are never subtracted twice).
 *
 * Unlike `measureLevel` this never writes state, so a caller reporting
 * the level (logs, transient UI) can read the number the decision used.
 *
 * @param state - The session state.
 * @param measured - The raw prompt-side total of the last completed
 *   assistant message.
 * @returns The water level in tokens.
 */
export function readLevel(state: SessionState, measured: number): number {
  const credit = state.nudges?.pendingReclaimTokens ?? 0;
  if (credit <= 0) return measured;
  const anchored = state.nudges?.reclaimMeasurement;
  if (anchored !== undefined && anchored !== measured) return measured;
  return Math.max(0, measured - credit);
}

/**
 * Read the water level for this evaluation and persist the credit state.
 *
 * Same value as `readLevel`, plus it records the measurement a live
 * discount is anchored to and clears a discount a newer measurement has
 * already absorbed.
 *
 * @param state - The session state (mutated).
 * @param measured - The raw prompt-side total.
 * @returns The water level in tokens.
 */
function measureLevel(state: SessionState, measured: number): number {
  const credit = state.nudges?.pendingReclaimTokens ?? 0;
  if (credit <= 0) {
    consumeReclaimCredit(state);
    return measured;
  }
  const anchored = state.nudges?.reclaimMeasurement;
  if (anchored !== undefined && anchored !== measured) {
    consumeReclaimCredit(state);
    return measured;
  }
  if (anchored === undefined) {
    state.nudges = {
      ...(state.nudges ?? {}),
      reclaimMeasurement: measured,
    };
  }
  return Math.max(0, measured - credit);
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
 * 3. The token level is the measured prompt-side total with the booked
 *    reclaim discounted off it (see `measureLevel`).  `anchor = min(last
 *    ?? tokens, tokens)` ratchets downward; the level is `"urgent"`
 *    at/above `max`, `"gentle"` at/above `min`, else null.
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
 * @param state - The session state; `state.nudges` carries the watermark
 *   and the reclaim booking, both read and persisted here.
 * @param messages - The transcript — the raw view the usage figures and
 *   the protection boundaries are read from.
 * @param config - Raw nudge configuration; `undefined` disables.
 * @param options - Context window, protection inputs, and this round's
 *   numbered view (the window's coordinate system).
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

  const promptTokens = measureLevel(state, promptSideTokens(messages));
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

  const eligibility = computeEligibility(messages, options.numbered, options);
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
 * What one view line contributes to a compressible window.
 *
 * A line addresses either a single transcript message or a whole folded
 * block, so it carries the ordinal interval it stands for (the same
 * mapping `resolveEndpoint` uses) plus the tokens a new compression of
 * that line could still free.
 */
interface ViewLine {
  /** The line's per-round ref (`mN`) — the address the model writes. */
  ref: string;
  /** First transcript ordinal the line covers (inclusive). */
  start: number;
  /** Last transcript ordinal the line covers (exclusive). */
  end: number;
  /** Tokens a compression of this line frees (0 once it is folded). */
  reclaimTokens: number;
}

/**
 * Project the numbered view into the lines the window is measured over.
 *
 * Numbering is dense over the visible view, so every line holds a ref
 * (hidden messages carry none and are absent here) and the lines are in
 * ascending ordinal order.  A summary line is already folded: its text
 * is what a compression of that interval would have to keep, so it
 * frees nothing new and is counted as zero reclaim.
 *
 * @param history - The transcript the view was folded from.
 * @param numbered - This round's numbered folded view.
 * @returns One entry per view line, in view order.
 */
function viewLines(
  history: HostMessage[],
  numbered: NumberedItem[],
): ViewLine[] {
  const lines: ViewLine[] = [];
  for (const { n, item } of numbered) {
    const { start, end } = itemInterval(item);
    lines.push({
      ref: `m${n}`,
      start,
      end,
      reclaimTokens:
        item.type === "original"
          ? estimateMessageHeuristic(history[item.ordinal])
          : 0,
    });
  }
  return lines;
}

/**
 * Compute the eligibility payload for a nudge message.
 *
 * The window is a run of VIEW LINES, measured in this round's numbered
 * view — the same `mN` address space the model sees and the `compress`
 * tool resolves.  Its bounds come from the SAME gates the compress path
 * enforces (protection window + last-user cap from the end, first-user
 * exclusion from the start), which are defined over transcript ordinals;
 * a line joins the window only when the interval it stands for sits
 * entirely inside them, so the advertised range can never be one
 * `compress` would reject as reaching into protection or clipping an
 * active block.
 *
 * `reclaimTokens` sums the not-yet-folded content of the window: an
 * interval that is already a summary contributes nothing, so repeated
 * compressions never re-bill the same tokens.
 *
 * Returns `null` when there is no user message, no view line, the window
 * is empty, or the estimate falls below `config.thresholdTokens` (a
 * compress in this window would be a no-op the gates reject).
 *
 * @param history - The transcript the view was folded from.
 * @param numbered - This round's numbered folded view.
 * @param config - Window protection configuration (message count, token
 *   budget, phantom threshold).
 * @returns The eligibility payload, or `null`.
 */
export function computeEligibility(
  history: HostMessage[],
  numbered: NumberedItem[],
  config: EligibilityConfig,
): NudgeEligibility | null {
  const lastUser = findLastUserOrdinal(history);
  const boundary = Math.min(
    computeProtectedStartOrdinal(
      history,
      config.protectedMessages,
      config.protectedTokens,
    ),
    lastUser >= 0 ? lastUser : history.length,
  );
  const firstUserIdx = findFirstUserOrdinal(history);
  if (firstUserIdx < 0) return null;

  // Both gates are monotone over the ascending lines, so they cut a
  // prefix (at or below the first user message) and a suffix (reaching
  // into the protection boundary) off one contiguous window.
  const lines = viewLines(history, numbered);
  let from = 0;
  while (from < lines.length && lines[from].start <= firstUserIdx) from += 1;
  let to = lines.length;
  while (to > from && lines[to - 1].end > boundary) to -= 1;
  if (from >= to) return null;

  let reclaimTokens = 0;
  for (let i = from; i < to; i++) {
    reclaimTokens += lines[i].reclaimTokens;
  }

  // Nothing left to free: the window is folded content only, so a
  // compress here would be rejected for bringing no new content.
  if (reclaimTokens <= 0) return null;

  // Phantom alignment: a compress inside this window would be rejected
  // as a no-op, so the nudge stays silent.
  if (reclaimTokens < config.thresholdTokens) return null;

  return {
    startRef: lines[from].ref,
    endRef: lines[to - 1].ref,
    reclaimTokens,
  };
}
