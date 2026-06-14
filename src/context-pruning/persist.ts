/**
 * Disk JSON persistence for session state.
 *
 * Provides save (debounced), load, delete, and TTL-based cleanup of
 * serialised {@link SessionState} objects.  Maps/Sets are converted to
 * arrays for JSON round-trip safety.  All I/O errors are silently
 * swallowed and logged via the {@link log} utility.
 *
 * @module
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { log } from "../utils/logger.js";
import type {
  CompressionBlock,
  DedupEntry,
  ErrorEntry,
  MessageBlockEntry,
  SessionState,
} from "./types";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Storage directory under the user's home directory. */
const STORAGE_DIR = join(homedir(), ".zoo", "storage");

/** Debounce delay before writing to disk (milliseconds). */
const DEBOUNCE_MS = 1_000;

/** Default session TTL for {@link cleanupExpiredSessions} (30 minutes). */
const DEFAULT_TTL_MS = 30 * 60 * 1_000;

// ---------------------------------------------------------------------------
// Debounce state
// ---------------------------------------------------------------------------

/** Per-session debounce timers. */
const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

// ---------------------------------------------------------------------------
// Serialized shape
// ---------------------------------------------------------------------------

/**
 * JSON-safe serialised form of {@link SessionState}.
 *
 * All `Map` fields are converted to arrays of `[key, value]` pairs; all
 * `Set` fields are converted to plain arrays.
 */
interface PersistedState {
  sessionId: string;
  blocksById: Array<[number, CompressionBlock]>;
  byMessageId: Array<[string, MessageBlockEntry]>;
  activeBlockIds: number[];
  activeByAnchorMessageId: Array<[string, number]>;
  dedupCache: Array<[string, DedupEntry]>;
  errorTracking: Array<[string, ErrorEntry]>;
  protectedTurns: number;
  turnCount: number;
  nudgeCounter: number;
  nextBlockId: number;
  nextRunId: number;
  prune: {
    tools: Array<[string, number]>;
    prunedCallIds: string[];
  };
  lastAccessedAt: number;
  totalPrunedTokens: number;
  totalCompressedTokens: number;
}

// ---------------------------------------------------------------------------
// File path helpers
// ---------------------------------------------------------------------------

/**
 * Build the on-disk file path for a given session ID.
 *
 * @param sessionId - The session identifier.
 * @returns The absolute file path.
 */
function filepath(sessionId: string): string {
  return join(STORAGE_DIR, `opencode-${sessionId}.json`);
}

/**
 * Ensure a directory exists, creating it recursively if necessary.
 *
 * All errors are silently swallowed.
 *
 * @param dir - The directory path.
 */
function ensureDir(dir: string): void {
  try {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  } catch {
    // Silently swallow
  }
}

// ---------------------------------------------------------------------------
// Serialization helpers
// ---------------------------------------------------------------------------

/**
 * Convert an in-memory {@link SessionState} to a plain JSON-serialisable
 * {@link PersistedState}.
 *
 * Maps become arrays of `[key, value]` pairs; Sets become arrays.
 *
 * @param state - The live session state.
 * @returns The serialised representation.
 */
function serializeState(state: SessionState): PersistedState {
  return {
    sessionId: state.sessionId,
    blocksById: [...state.blocksById.entries()],
    byMessageId: [...state.byMessageId.entries()],
    activeBlockIds: [...state.activeBlockIds],
    activeByAnchorMessageId: [...state.activeByAnchorMessageId.entries()],
    dedupCache: [...state.dedupCache.entries()],
    errorTracking: [...state.errorTracking.entries()],
    protectedTurns: state.protectedTurns,
    turnCount: state.turnCount,
    nudgeCounter: state.nudgeCounter,
    nextBlockId: state.nextBlockId,
    nextRunId: state.nextRunId,
    prune: {
      tools: [...state.prune.tools.entries()],
      prunedCallIds: [...state.prune.prunedCallIds],
    },
    lastAccessedAt: state.lastAccessedAt,
    totalPrunedTokens: state.totalPrunedTokens,
    totalCompressedTokens: state.totalCompressedTokens,
  };
}

/**
 * Reconstruct an in-memory {@link SessionState} from a previously
 * serialised {@link PersistedState}.
 *
 * Arrays of `[key, value]` pairs become Maps; arrays become Sets.
 *
 * @param data - The serialised representation.
 * @returns The live session state.
 */
function deserializeState(data: PersistedState): SessionState {
  return {
    sessionId: data.sessionId,
    blocksById: new Map(data.blocksById),
    byMessageId: new Map(data.byMessageId),
    activeBlockIds: new Set(data.activeBlockIds),
    activeByAnchorMessageId: new Map(data.activeByAnchorMessageId),
    dedupCache: new Map(data.dedupCache),
    errorTracking: new Map(data.errorTracking),
    protectedTurns: data.protectedTurns,
    turnCount: data.turnCount,
    nudgeCounter: data.nudgeCounter,
    nextBlockId: data.nextBlockId,
    nextRunId: data.nextRunId,
    prune: {
      tools: new Map(data.prune.tools),
      prunedCallIds: new Set(data.prune.prunedCallIds),
    },
    lastAccessedAt: data.lastAccessedAt,
    totalPrunedTokens: data.totalPrunedTokens,
    totalCompressedTokens: data.totalCompressedTokens,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Serialise a session state and write it to disk.
 *
 * Writes are debounced per session — calling this function again within
 * {@link DEBOUNCE_MS} (1 s) for the same session cancels the previous
 * pending write and schedules a new one.
 *
 * Never throws.  I/O errors are logged via {@link log} with event
 * `"persist_error"`.
 *
 * @param state - The session state to persist.
 */
export function saveSessionState(state: SessionState): void {
  const sid = state.sessionId;

  // Cancel any pending write for this session
  const existing = debounceTimers.get(sid);
  if (existing !== undefined) {
    clearTimeout(existing);
  }

  // Schedule a new write
  const timer = setTimeout(() => {
    debounceTimers.delete(sid);
    try {
      ensureDir(STORAGE_DIR);
      const data = serializeState(state);
      writeFileSync(filepath(sid), JSON.stringify(data, null, 2), "utf-8");
      log("context-pruning", "persist_save", sid, undefined, "info");
    } catch (err: unknown) {
      log("context-pruning", "persist_error", sid, undefined, "error", {
        error: String(err),
      });
    }
  }, DEBOUNCE_MS);

  debounceTimers.set(sid, timer);
}

/**
 * Validate that a parsed {@link PersistedState} has the expected shape.
 *
 * Checks for the presence and correct type of required fields.  Malformed
 * or missing fields cause the function to return `false` so the caller can
 * discard the corrupt state gracefully rather than crash.
 *
 * @param data - The parsed JSON object to validate.
 * @returns `true` when the shape matches expectations.
 */
function validatePersistedState(data: unknown): data is PersistedState {
  if (!data || typeof data !== "object") return false;

  const d = data as Record<string, unknown>;

  // Required string fields
  if (typeof d.sessionId !== "string") return false;

  // Required array fields
  if (!Array.isArray(d.blocksById)) return false;
  if (!Array.isArray(d.byMessageId)) return false;
  if (!Array.isArray(d.activeBlockIds)) return false;
  if (!Array.isArray(d.activeByAnchorMessageId)) return false;
  if (!Array.isArray(d.dedupCache)) return false;
  if (!Array.isArray(d.errorTracking)) return false;

  // Required number fields
  if (typeof d.protectedTurns !== "number") return false;
  if (typeof d.turnCount !== "number") return false;
  if (typeof d.nudgeCounter !== "number") return false;
  if (typeof d.nextBlockId !== "number") return false;
  if (typeof d.nextRunId !== "number") return false;
  if (typeof d.lastAccessedAt !== "number") return false;
  if (typeof d.totalPrunedTokens !== "number") return false;
  if (typeof d.totalCompressedTokens !== "number") return false;

  // Required nested prune object
  if (!d.prune || typeof d.prune !== "object") return false;
  const prune = d.prune as Record<string, unknown>;
  if (!Array.isArray(prune.tools)) return false;
  if (!Array.isArray(prune.prunedCallIds)) return false;

  return true;
}

/**
 * Read a session state from disk and deserialise it.
 *
 * Returns `null` when the file does not exist, when the JSON is malformed,
 * or when shape validation fails.  Never throws.
 *
 * @param sessionId - The session identifier.
 * @returns The deserialised session state, or `null`.
 */
export function loadSessionState(sessionId: string): SessionState | null {
  try {
    const fp = filepath(sessionId);
    if (!existsSync(fp)) return null;

    const raw = readFileSync(fp, "utf-8");
    const parsed: unknown = JSON.parse(raw);

    if (!validatePersistedState(parsed)) {
      log("context-pruning", "persist_error", sessionId, undefined, "warn", {
        error: "Invalid persisted state shape — discarding",
      });
      return null;
    }

    log("context-pruning", "persist_load", sessionId, undefined, "info");
    return deserializeState(parsed);
  } catch (err: unknown) {
    log("context-pruning", "persist_error", sessionId, undefined, "error", {
      error: String(err),
    });
    return null;
  }
}

/**
 * Cancel a pending debounced save for a session.
 *
 * If a debounce timer is scheduled for the given session, it is cleared
 * and removed so that no stale write fires after a delete or destroy.
 *
 * @param sessionId - The session identifier whose pending save to cancel.
 */
export function cancelPendingSave(sessionId: string): void {
  const existing = debounceTimers.get(sessionId);
  if (existing !== undefined) {
    clearTimeout(existing);
    debounceTimers.delete(sessionId);
  }
}

/**
 * Cancel ALL pending debounced saves.
 *
 * Iterates every active debounce timer, clears it, and empties the
 * internal map.  Primarily intended for {@link ContextPruningState.destroy}
 * to prevent zombie writes after teardown.
 */
export function cancelAllPendingSaves(): void {
  for (const [, timer] of debounceTimers) {
    clearTimeout(timer);
  }
  debounceTimers.clear();
}

/**
 * Delete the persisted state file for a session.
 *
 * Never throws.  I/O errors are logged via {@link log} with event
 * `"persist_error"`.
 *
 * @param sessionId - The session identifier whose file should be removed.
 */
export function deletePersistedState(sessionId: string): void {
  try {
    const fp = filepath(sessionId);
    if (existsSync(fp)) {
      unlinkSync(fp);
    }
  } catch (err: unknown) {
    log("context-pruning", "persist_error", sessionId, undefined, "error", {
      error: String(err),
    });
  }
}

/**
 * Scan the storage directory and delete session files older than `ttlMs`.
 *
 * Default TTL is 30 minutes.  Only files matching the pattern
 * `opencode-<sessionId>.json` are considered.  Never throws.
 *
 * @param ttlMs - Time-to-live in milliseconds (default 30 min).
 */
export function cleanupExpiredSessions(ttlMs?: number): void {
  const maxAge = ttlMs ?? DEFAULT_TTL_MS;

  try {
    const dir = STORAGE_DIR;
    if (!existsSync(dir)) return;

    const now = Date.now();
    const files = readdirSync(dir);
    const pattern = /^opencode-(.+)\.json$/;

    for (const file of files) {
      const match = pattern.exec(file);
      if (!match) continue;

      try {
        const fp = join(dir, file);
        const mtime = statSync(fp).mtimeMs;

        // Skip files that are still young by mtime
        if (now - mtime <= maxAge) continue;

        // Double-check against lastAccessedAt stored in the file.
        // mtime only reflects the last write; a session that was loaded
        // from disk and only read (no mutations) will have an old mtime
        // but a recent lastAccessedAt.  We only delete when BOTH the
        // file mtime AND the embedded lastAccessedAt have expired.
        try {
          const raw = readFileSync(fp, "utf-8");
          const parsed: unknown = JSON.parse(raw);
          if (validatePersistedState(parsed)) {
            if (now - parsed.lastAccessedAt <= maxAge) {
              // Session was recently accessed — keep the file
              continue;
            }
          }
        } catch {
          // File is corrupt or unreadable; fall through to deletion
        }

        unlinkSync(fp);
      } catch {
        // Skip individual file errors
      }
    }
  } catch {
    // Silently swallow
  }
}
