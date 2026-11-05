/**
 * Round-scoped context protection map.
 *
 * The map is the host-agnostic protection model of one round: every
 * non-hidden user instruction is protected, and the active tail
 * `[activeStart, messageCount)` is protected.  A compression range may
 * only touch ordinals outside both — the work that has already left the
 * active tail.
 *
 * The active tail unions two trailing windows, both measured backward
 * from the end of the transcript: a count of non-hidden messages and a
 * heuristic token budget.  A hidden message never occupies a count slot
 * and contributes no tokens.
 *
 * The map also carries the round's message count, so a query can tell a
 * valid ordinal from one the transcript no longer has: an ordinal
 * outside `[0, messageCount)` is not part of the active tail and is
 * never reported as protected.
 *
 * The map is plain data and frozen: the pipeline builds it once per
 * round, publishes it with the round view, and every later phase reads
 * the same snapshot.
 *
 * @module
 */

import type { ContextPruningConfig } from "../config-types.js";
import type { HostMessage } from "./lens.js";
import { estimateMessageHeuristic } from "./measure.js";

/**
 * One round's protected ordinals.
 *
 * `activeStart` is the inclusive start of the active tail, `messageCount`
 * is the transcript length of the same round, and the instructions are
 * the ordinals of every non-hidden user message, in ascending order.
 */
export interface ProtectionMap {
  /** First protected ordinal of the active tail. */
  readonly activeStart: number;
  /** Message count of the round the map was built for. */
  readonly messageCount: number;
  /** Ordinals of the non-hidden user instructions, ascending. */
  readonly instructions: readonly number[];
}

/**
 * Start ordinal of the message-count protection window.
 *
 * Counts back `n` non-hidden messages from the end of the transcript; a
 * hidden message never occupies a slot.  `n <= 0` yields
 * `history.length` (empty window); an `n` larger than the available
 * non-hidden messages yields `0` (protect everything).
 *
 * @param history - The transcript.
 * @param n - Number of trailing messages to protect.
 * @returns Start ordinal of the message-count window.
 */
function messageCountBoundary(history: HostMessage[], n: number): number {
  if (n <= 0) return history.length;
  let count = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].hidden) continue;
    count += 1;
    if (count >= n) return i;
  }
  return 0;
}

/**
 * Start ordinal of the token-budget protection window.
 *
 * Accumulates the heuristic estimate of messages backward until the
 * total reaches `activeTokens`; hidden messages contribute nothing.
 * `activeTokens <= 0` or an empty transcript yields
 * `history.length` (empty window); a budget exceeding the whole session
 * yields `0` (protect everything).
 *
 * @param history - The transcript.
 * @param activeTokens - Token budget to protect from the end.
 * @returns Start ordinal of the token window.
 */
function tokenCountBoundary(
  history: HostMessage[],
  activeTokens: number,
): number {
  if (activeTokens <= 0 || history.length === 0) return history.length;
  let accumulated = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].hidden) continue;
    accumulated += estimateMessageHeuristic(history[i]);
    if (accumulated >= activeTokens) return i;
  }
  return 0;
}

/**
 * Compute the start ordinal of the active tail.
 *
 * Both trailing windows extend to the end of the transcript, so the
 * union starts at the earlier boundary.
 *
 * @param history - The transcript.
 * @param activeMessages - Trailing message count to protect.
 * @param activeTokens - Trailing token budget to protect.
 * @returns Start ordinal of the active tail; `history.length` when both
 *   windows are empty.
 */
function activeStartOrdinal(
  history: HostMessage[],
  activeMessages: number,
  activeTokens: number,
): number {
  return Math.min(
    messageCountBoundary(history, activeMessages),
    tokenCountBoundary(history, activeTokens),
  );
}

/**
 * Copy a protection map into frozen plain data.
 *
 * The instruction list is copied and frozen, so the result no longer
 * shares state with the source map.
 *
 * @param map - The map to freeze (not mutated).
 * @returns An equivalent frozen map.
 */
export function freezeProtectionMap(map: ProtectionMap): ProtectionMap {
  return Object.freeze({
    activeStart: map.activeStart,
    messageCount: map.messageCount,
    instructions: Object.freeze([...map.instructions]),
  });
}

/**
 * Build one round's protection map from the transcript and explicit
 * active-tail sizes.
 *
 * @param history - The transcript.
 * @param activeMessages - Trailing non-hidden message count to
 *   protect.
 * @param activeTokens - Trailing heuristic token budget to protect.
 * @returns The frozen protection map.
 */
export function buildProtectionMap(
  history: HostMessage[],
  activeMessages: number,
  activeTokens: number,
): ProtectionMap {
  const instructions: number[] = [];
  for (let i = 0; i < history.length; i++) {
    const message = history[i];
    if (message.role === "user" && !message.hidden) instructions.push(i);
  }
  return freezeProtectionMap({
    activeStart: activeStartOrdinal(history, activeMessages, activeTokens),
    messageCount: history.length,
    instructions,
  });
}

/**
 * Build one round's protection map from the parsed context config.
 *
 * Both protection inputs must be configured: without
 * `activeMessages` or `activeTokens` the round has no map, and every
 * consumer (producers, release, report overlays) fails closed.
 *
 * @param history - The transcript.
 * @param config - The parsed context-pruning config.
 * @returns The frozen protection map, or undefined when a protection
 *   input is missing.
 */
export function configuredProtectionMap(
  history: HostMessage[],
  config: ContextPruningConfig,
): ProtectionMap | undefined {
  const activeMessages = config.activeMessages;
  const activeTokens = config.activeTokens;
  if (activeMessages === undefined || activeTokens === undefined) {
    return undefined;
  }
  return buildProtectionMap(history, activeMessages, activeTokens);
}

/**
 * Whether one ordinal is protected.
 *
 * A valid ordinal inside the active tail or at a user instruction is
 * protected; every other ordinal is work.  An ordinal outside
 * `[0, messageCount)` is invalid — the transcript of this round has no
 * such message — so it is never reported as protected.
 *
 * @param map - The round's protection map.
 * @param ordinal - The transcript ordinal.
 * @returns True when the ordinal must not be compressed.
 */
export function isProtectedOrdinal(
  map: ProtectionMap,
  ordinal: number,
): boolean {
  if (ordinal < 0 || ordinal >= map.messageCount) return false;
  if (ordinal >= map.activeStart) return true;
  return map.instructions.includes(ordinal);
}

/**
 * Whether a contiguous ordinal range is protected.
 *
 * A range is protected when its end crosses into the active tail, or
 * when it contains a user instruction.  A range ending exactly at
 * `activeStart` is free.
 *
 * @param map - The round's protection map.
 * @param start - First ordinal (inclusive).
 * @param end - Last ordinal (exclusive).
 * @returns True when the range must not be compressed.
 */
export function isProtectedRange(
  map: ProtectionMap,
  start: number,
  end: number,
): boolean {
  if (end > map.activeStart) return true;
  for (const ordinal of map.instructions) {
    if (ordinal < start) continue;
    if (ordinal >= end) break;
    return true;
  }
  return false;
}
