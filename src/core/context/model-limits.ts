/**
 * Per-session model context-limit registry.
 *
 * Captured from the `experimental.chat.system.transform` hook, which
 * receives the active model's `limit.context` and `id`.  Keyed by
 * session ID so the context-pruning nudge phase can resolve percentage
 * thresholds against the real window.
 *
 * Memory-only — no persistence, no framework dependencies.  The record is a
 * session resource (`session/resources.ts`), so a session stop drops
 * the entry on both stop modes; `_resetForTesting` drops them all.
 *
 * @module
 */

import type { ReleasedSessionResource } from "../session/resources.js";

// ---------------------------------------------------------------------------
// Module-level state
// ---------------------------------------------------------------------------

/**
 * Captured model metadata for one session.
 */
export interface ModelLimitInfo {
  /** Active model ID (e.g. `"gpt-5"`). */
  modelId: string;
  /** Model context window (tokens). */
  context: number;
}

/** Map of session ID → captured model limit info. */
const modelLimits = new Map<string, ModelLimitInfo>();

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Record the active model's context limit for a session.
 *
 * Called from the system.transform hook.  Missing session IDs and
 * non-finite limits are ignored (no entry stored).
 *
 * @param sessionId - The session identifier.
 * @param context - The model context window (tokens).
 * @param modelId - The active model ID.
 */
export function setModelLimit(
  sessionId: string,
  context: number,
  modelId: string,
): void {
  if (!sessionId || !Number.isFinite(context) || !modelId) return;
  modelLimits.set(sessionId, { context, modelId });
}

/**
 * Read the captured model limit for a session.
 *
 * @param sessionId - The session identifier.
 * @returns The captured limit info, or `undefined` when no entry exists.
 */
export function getModelLimit(sessionId: string): ModelLimitInfo | undefined {
  return modelLimits.get(sessionId);
}

/**
 * Drop the captured model limit for a session.
 *
 * @param sessionId - The session identifier.
 */
export function clearModelLimit(sessionId: string): void {
  modelLimits.delete(sessionId);
}

/**
 * The captured model limit is runtime-only: both stop modes drop it, because
 * the next transform re-captures it.
 */
export const modelLimitResource: ReleasedSessionResource = {
  name: "modelLimit",
  runtime: "release",
  release: clearModelLimit,
  delete: clearModelLimit,
};

// ---------------------------------------------------------------------------
// Testing seams
// ---------------------------------------------------------------------------

/**
 * Clear all captured model limits.
 *
 * Call in test teardown to prevent cross-test pollution.
 */
export function _resetForTesting(): void {
  modelLimits.clear();
}
