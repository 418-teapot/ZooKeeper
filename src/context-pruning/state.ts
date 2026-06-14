/**
 * Session state management for the context pruning subsystem.
 *
 * Manages in-memory session state including compression blocks, dedup
 * cache, and error tracking.  Sessions are automatically cleaned up
 * after a configurable TTL of inactivity.
 *
 * @module
 */

import {
  cancelAllPendingSaves,
  cancelPendingSave,
  cleanupExpiredSessions,
  deletePersistedState,
  loadSessionState,
  saveSessionState,
} from "./persist";
import type { SessionState } from "./types";

const DEFAULT_SESSION_TTL_MS = 30 * 60 * 1000; // 30 minutes
const DEFAULT_CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // every 5 minutes
const MAX_DEDUP_CACHE_SIZE = 1000;

class ContextPruningState {
  private sessions = new Map<string, SessionState>();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;
  private sessionTtlMs: number;
  private cleanupIntervalMs: number;

  /**
   * Create a new ContextPruningState instance.
   *
   * @param sessionTtlMs - Session TTL in milliseconds (default 30 min).
   * @param cleanupIntervalMs - Cleanup interval in milliseconds (default 5 min).
   */
  constructor(
    sessionTtlMs = DEFAULT_SESSION_TTL_MS,
    cleanupIntervalMs = DEFAULT_CLEANUP_INTERVAL_MS,
  ) {
    this.sessionTtlMs = sessionTtlMs;
    this.cleanupIntervalMs = cleanupIntervalMs;
    this.startCleanupInterval();
  }

  /**
   * Get an existing session or create a new one.
   *
   * @param sessionId - The session identifier.
   * @param protectedTurns - Number of recent turns to protect (default 2).
   * @returns The session state.
   */
  getOrCreate(sessionId: string, protectedTurns?: number): SessionState {
    let state = this.sessions.get(sessionId);
    if (!state) {
      // Try loading from disk first
      const loaded = loadSessionState(sessionId);
      if (loaded) {
        state = loaded;
      } else {
        state = {
          sessionId,
          blocksById: new Map(),
          byMessageId: new Map(),
          activeBlockIds: new Set(),
          activeByAnchorMessageId: new Map(),
          dedupCache: new Map(),
          errorTracking: new Map(),
          protectedTurns: protectedTurns ?? 2,
          turnCount: 0,
          nudgeCounter: 0,
          prune: { tools: new Map(), prunedCallIds: new Set() },
          nextBlockId: 1,
          nextRunId: 1,
          lastAccessedAt: Date.now(),
          totalPrunedTokens: 0,
          totalCompressedTokens: 0,
        };
      }
      this.sessions.set(sessionId, state);
      saveSessionState(state);
    }
    state.lastAccessedAt = Date.now();
    return state;
  }

  /**
   * Get an existing session without creating one.
   *
   * @param sessionId - The session identifier.
   * @returns The session state, or `undefined` if not found.
   */
  get(sessionId: string): SessionState | undefined {
    const state = this.sessions.get(sessionId);
    if (state) state.lastAccessedAt = Date.now();
    return state;
  }

  /**
   * Delete a session immediately.
   *
   * @param sessionId - The session identifier to remove.
   */
  delete(sessionId: string): void {
    this.sessions.delete(sessionId);
    cancelPendingSave(sessionId);
    deletePersistedState(sessionId);
  }

  /**
   * Track a tool call for dedup detection.
   *
   * @param sessionId - The session identifier.
   * @param toolName - The tool name.
   * @param parameters - The tool call parameters.
   * @param messageId - The message ID where the tool call occurred.
   * @returns `true` if this is a duplicate, `false` otherwise.
   */
  trackToolCall(
    sessionId: string,
    toolName: string,
    parameters: Record<string, unknown>,
    messageId: string,
  ): boolean {
    const state = this.getOrCreate(sessionId);
    const signature = this.buildSignature(toolName, parameters);
    const existing = state.dedupCache.get(signature);

    if (existing) {
      existing.latestSeenAt = messageId;
      saveSessionState(state);
      return true; // duplicate detected
    }

    state.dedupCache.set(signature, {
      toolName,
      signature,
      firstSeenAt: messageId,
      latestSeenAt: messageId,
      callCount: 1,
    });

    // Cap cache size — evict oldest entry when over limit
    if (state.dedupCache.size > MAX_DEDUP_CACHE_SIZE) {
      const firstKey = state.dedupCache.keys().next().value;
      if (firstKey !== undefined) {
        state.dedupCache.delete(firstKey);
      }
    }

    saveSessionState(state);

    return false; // not a duplicate
  }

  /**
   * Track an error tool call for purge-errors strategy.
   *
   * @param sessionId - The session identifier.
   * @param toolCallId - The tool call ID.
   * @param toolName - The tool name.
   * @param errorMessage - The error message.
   */
  trackError(
    sessionId: string,
    toolCallId: string,
    toolName: string,
    errorMessage: string,
  ): void {
    const state = this.getOrCreate(sessionId);
    state.errorTracking.set(toolCallId, {
      toolCallId,
      toolName,
      turnNumber: state.turnCount,
      errorMessage,
    });

    // Cap error tracking — evict oldest entry when over limit
    if (state.errorTracking.size > MAX_DEDUP_CACHE_SIZE) {
      const firstKey = state.errorTracking.keys().next().value;
      if (firstKey !== undefined) {
        state.errorTracking.delete(firstKey);
      }
    }

    saveSessionState(state);
  }

  /**
   * Advance the turn counter for a session.
   *
   * @param sessionId - The session identifier.
   */
  advanceTurn(sessionId: string): void {
    const state = this.getOrCreate(sessionId);
    state.turnCount++;
    // NOTE: save is deferred to runPipeline caller, which saves after compression.
  }

  /**
   * Build a deterministic signature from tool name and parameters.
   *
   * @param toolName - The tool name.
   * @param parameters - The tool call parameters.
   * @returns A string signature for dedup comparison.
   */
  private buildSignature(
    toolName: string,
    parameters: Record<string, unknown>,
  ): string {
    const normalized = this.normalizeParams(parameters);
    return `${toolName}::${JSON.stringify(normalized)}`;
  }

  /**
   * Normalize parameters by sorting keys.
   *
   * @param params - The parameters to normalize.
   * @returns A new object with sorted keys.
   */
  private normalizeParams(
    params: Record<string, unknown>,
  ): Record<string, unknown> {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(params).sort()) {
      sorted[key] = params[key];
    }
    return sorted;
  }

  /**
   * Start the periodic cleanup interval.
   */
  private startCleanupInterval(): void {
    this.cleanupTimer = setInterval(() => {
      this.runCleanup();
    }, this.cleanupIntervalMs);
  }

  /**
   * Run a single cleanup cycle — remove sessions whose TTL has expired.
   */
  private runCleanup(): void {
    const now = Date.now();
    for (const [sessionId, state] of this.sessions.entries()) {
      if (now - state.lastAccessedAt > this.sessionTtlMs) {
        this.sessions.delete(sessionId);
      }
    }
    cleanupExpiredSessions();
  }

  /**
   * Destroy all state and stop the cleanup timer.
   */
  destroy(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    cancelAllPendingSaves();
    this.sessions.clear();
    cleanupExpiredSessions();
  }
}

// Singleton instance
export const globalState = new ContextPruningState();

export { ContextPruningState, MAX_DEDUP_CACHE_SIZE };
