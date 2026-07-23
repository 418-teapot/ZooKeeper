/**
 * Session state management for context pruning.
 *
 * Maintains a module-level map of session states, each tracking
 * which tool outputs are marked for pruning and the cumulative
 * reclaimed token count.  Persists DCP-aligned state to
 * `~/.zoo/storage/` for cross-restart visibility.
 *
 * @module
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Per-session state for the mark-sweep pruning mechanism.
 *
 * - `sessionId` — the current session identifier.
 * - `prune.tools` — Map<callID, estimatedTokenCount> for tools marked
 *   during `/dcp sweep`.  Accumulates across turns (never cleared by
 *   prune).  Only cleared on session reset or deletion.
 * - `stats.totalPruneTokens` — cumulative token count reclaimed by pruning.
 * - `lastAccessedAt` — timestamp of the last state access.
 * - `dirty` — runtime-only flag; `true` when state was mutated since the
 *   last persist.  NOT serialised to disk.
 */
export interface SessionState {
  sessionId: string;
  prune: {
    tools: Map<string, number>;
  };
  stats: {
    totalPruneTokens: number;
  };
  lastAccessedAt: number;
  /** Runtime-only flag — NOT persisted to disk. */
  dirty: boolean;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Directory for persisted pruning state files. */
const STORAGE_DIR = join(homedir(), ".zoo", "storage");

/** TTL for stale session entries (30 minutes). */
const TTL_MS = 30 * 60 * 1000;

/** Regex for safe session IDs (alphanumeric, underscore, hyphen). */
const SAFE_SESSION_ID_RE = /^[a-zA-Z0-9_-]+$/;

// ---------------------------------------------------------------------------
// Module-level state
// ---------------------------------------------------------------------------

/** Map of session ID → SessionState. */
const sessions = new Map<string, SessionState>();

// ---------------------------------------------------------------------------
// Persistence helpers
// ---------------------------------------------------------------------------

/**
 * Validate that a session ID is safe for use as a filename component.
 *
 * Rejects IDs containing path separators, `..`, or other special chars
 * that could enable directory traversal.
 *
 * @param id - The session identifier to validate.
 * @returns `true` if the ID is safe (matches `/^[a-zA-Z0-9_-]+$/`).
 */
function isSafeSessionId(id: string): boolean {
  return SAFE_SESSION_ID_RE.test(id);
}

/**
 * Persisted state shape (DCP-aligned JSON).
 *
 * Mirrors DCP's `{ prune: { tools: Record<callID, tokenCount> },
 * stats: { totalPruneTokens }, lastUpdated }` structure.
 * Omitted DCP fields (prune.messages, nudges, manualMode, sessionName)
 * are not yet supported by ZooKeeper.
 */
interface PersistedState {
  prune: {
    tools: Record<string, number>;
  };
  stats: {
    totalPruneTokens: number;
  };
  lastUpdated: string;
}

/**
 * Read the persisted session state for a session from disk.
 *
 * Reads `~/.zoo/storage/{sessionId}.json`.  Returns `null` when
 * the file is missing or corrupt (defensive — never throws).
 *
 * @param sessionId - The session identifier.
 * @returns Parsed state with `prune.tools` as a Map and `stats`, or
 *   `null` on any failure.
 */
export function loadSessionState(sessionId: string): {
  prune: { tools: Map<string, number> };
  stats: { totalPruneTokens: number };
} | null {
  try {
    if (!isSafeSessionId(sessionId)) return null;
    const filePath = join(STORAGE_DIR, `${sessionId}.json`);
    if (!existsSync(filePath)) return null;
    const raw = readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw) as PersistedState;
    const tools = new Map(
      Object.entries(parsed.prune?.tools ?? {}).map(([id, count]) => [
        id,
        typeof count === "number" ? count : 0,
      ]),
    );
    const totalPruneTokens =
      typeof parsed.stats?.totalPruneTokens === "number"
        ? parsed.stats.totalPruneTokens
        : 0;
    return {
      prune: { tools },
      stats: { totalPruneTokens },
    };
  } catch {
    // Defensive: missing / corrupt file → null, never throw.
    return null;
  }
}

/**
 * Persist the session state to disk as an atomic write.
 *
 * Creates the `~/.zoo/storage/` directory if absent.  Writes to a temp
 * file `.{sessionId}.json.tmp` then renames atomically.  All errors
 * are swallowed — persistence failure must never crash the caller
 * (transform hook or TUI).
 *
 * JSON shape (DCP-aligned):
 * `{ prune: { tools: Record<callID, tokenCount> },
 *    stats: { totalPruneTokens },
 *    lastUpdated: ISO }`
 *
 * @param sessionId - The session identifier.
 * @param state - The session state to persist (`prune.tools` and
 *   `stats.totalPruneTokens` are extracted; other fields are ignored).
 */
export function saveSessionState(sessionId: string, state: SessionState): void {
  try {
    if (!isSafeSessionId(sessionId)) return;
    mkdirSync(STORAGE_DIR, { recursive: true });
    const filePath = join(STORAGE_DIR, `${sessionId}.json`);
    const tmpPath = join(STORAGE_DIR, `.${sessionId}.json.tmp`);
    const data: PersistedState = {
      prune: {
        tools: Object.fromEntries(state.prune.tools),
      },
      stats: {
        totalPruneTokens: state.stats.totalPruneTokens,
      },
      lastUpdated: new Date().toISOString(),
    };
    writeFileSync(tmpPath, JSON.stringify(data), "utf8");
    renameSync(tmpPath, filePath);
  } catch {
    // Defensive: persistence failure must never crash the caller.
  }
}

/**
 * Remove the persisted session state file for a session.
 *
 * Best-effort — errors are swallowed (called during session.deleted
 * cleanup, must never crash the host).
 *
 * @param sessionId - The session identifier.
 */
export function deleteSessionState(sessionId: string): void {
  try {
    const filePath = join(STORAGE_DIR, `${sessionId}.json`);
    if (existsSync(filePath)) {
      unlinkSync(filePath);
    }
    const tmpPath = join(STORAGE_DIR, `.${sessionId}.json.tmp`);
    if (existsSync(tmpPath)) {
      unlinkSync(tmpPath);
    }
  } catch {
    // Best-effort cleanup — never throw.
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Get or create the session state for the given session ID.
 *
 * Returns the existing state if one exists, otherwise creates a fresh
 * state with an empty prune map.  On first creation, loads any persisted
 * `prune.tools` and `stats.totalPruneTokens` from disk (restart recovery).
 *
 * @param sessionId - The session identifier.
 * @returns The session state instance.
 */
export function getOrCreateSessionState(sessionId: string): SessionState {
  let state = sessions.get(sessionId);
  if (!state) {
    const persisted = loadSessionState(sessionId);
    state = {
      sessionId,
      prune: {
        tools: persisted?.prune.tools ?? new Map(),
      },
      stats: {
        totalPruneTokens: persisted?.stats.totalPruneTokens ?? 0,
      },
      lastAccessedAt: Date.now(),
      dirty: false,
    };
    sessions.set(sessionId, state);
  }
  state.lastAccessedAt = Date.now();

  // Opportunistic TTL cleanup: remove stale sessions older than 30 min.
  for (const [sid, s] of sessions) {
    if (sid !== sessionId && Date.now() - s.lastAccessedAt > TTL_MS) {
      sessions.delete(sid);
    }
  }

  return state;
}

/**
 * Remove a session from the module-level state map.
 *
 * Deletes the session state so that a subsequent get-or-create starts
 * fresh.  Called on `session.deleted` events to prevent memory leaks.
 *
 * @param sessionId - The session identifier to remove.
 */
export function removeSession(sessionId: string): void {
  sessions.delete(sessionId);
}

// ---------------------------------------------------------------------------
// Testing seams
// ---------------------------------------------------------------------------

/**
 * Remove a session from the module-level map.
 *
 * Call in test teardown to prevent cross-test pollution.
 *
 * @param sessionId - The session identifier to remove.
 */
export function _removeSessionForTesting(sessionId: string): void {
  sessions.delete(sessionId);
}

/**
 * Clear all session state from the module-level map.
 *
 * Call in test teardown to prevent cross-test pollution.
 */
export function _clearAllSessionsForTesting(): void {
  sessions.clear();
}
