/**
 * Per-session model context-limit registry.
 *
 * Captured from the host's model-surface hook, which receives the active
 * model's `limit.context` and `id`.  Keyed by session ID so the
 * context-pruning nudge phase can resolve percentage thresholds against
 * the real window.
 *
 * Memory-only — no persistence, no framework dependencies.  One registry
 * belongs to one `ContextRuntime` (see `runtime.ts`), so two plugin
 * instances in the same process never share a captured limit; the
 * instance's session records drop the entries on a stop.
 *
 * @module
 */

/** Captured model metadata for one session. */
export interface ModelLimitInfo {
  /** Active model ID (e.g. `"gpt-5"`). */
  modelId: string;
  /** Model context window (tokens). */
  context: number;
}

/** Per-session capture of the active model's context limit. */
export interface ModelLimitRegistry {
  /**
   * Record the active model's context limit for a session.
   *
   * Missing session IDs and non-finite limits are ignored (no entry).
   *
   * @param sessionId - The session identifier.
   * @param context - The model context window (tokens).
   * @param modelId - The active model ID.
   */
  set(sessionId: string, context: number, modelId: string): void;
  /**
   * Read the captured limit of a session.
   *
   * @param sessionId - The session identifier.
   * @returns The captured info, or `undefined` when no entry exists.
   */
  get(sessionId: string): ModelLimitInfo | undefined;
  /** Drop the captured limit of a session. */
  clear(sessionId: string): void;
}

/**
 * Create an empty model-limit registry.
 *
 * @returns The registry; its entries live only as long as the caller
 *   keeps it.
 */
export function createModelLimitRegistry(): ModelLimitRegistry {
  const limits = new Map<string, ModelLimitInfo>();
  return {
    set(sessionId, context, modelId) {
      if (!sessionId || !Number.isFinite(context) || !modelId) return;
      limits.set(sessionId, { context, modelId });
    },
    get(sessionId) {
      return limits.get(sessionId);
    },
    clear(sessionId) {
      limits.delete(sessionId);
    },
  };
}
