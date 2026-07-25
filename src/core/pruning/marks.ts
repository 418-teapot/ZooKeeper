/**
 * Session state management using a single marks collection.
 *
 * **Semantic contract:** marks never delete — even when the referenced
 * message has been compacted away.  Derived stats depend on monotonicity
 * (pendingCount, pendingTokens, reclaimedTokens, markedCount, markedTokens).
 *
 * Each mark is a `{ tokens, effective }` pair.  Producers (dedup/sweep)
 * write marks via `addMark`.  `releaseBatch` flips all ineffective marks
 * to effective.  `pruneToolOutputs` reads effective marks only.
 *
 * Persisted shape: `{ marks: Record<callID, { t, e }>, lastUpdated }`.
 * Old shape (prune.tools / stats) is loaded as empty — no migration layer.
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
 * A single pruning mark.
 *
 * - `tokens` — estimated token count that would be reclaimed when this
 *   mark becomes effective.
 * - `effective` — `true` when this mark has been released (either
 *   immediately by sweep, or via batch release for dedup marks).
 */
export interface Mark {
  tokens: number;
  effective: boolean;
}

/**
 * Per-session state for the unified mark-sweep pruning mechanism.
 *
 * - `sessionId` — the current session identifier.
 * - `marks` — single collection of all marks (replaces old dual-map
 *   `prune.tools` + `prune.pending`).
 * - `lastAccessedAt` — timestamp of the last state access.
 * - `dirty` — runtime-only flag; `true` when state was mutated since
 *   the last persist.  NOT serialised to disk.
 */
export interface SessionState {
  sessionId: string;
  marks: Map<string, Mark>;
  lastAccessedAt: number;
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
 * Persisted mark shape.
 */
interface PersistedMark {
  t: number;
  e: boolean;
}

/**
 * Persisted state shape (v2 — unified marks collection).
 *
 * Old shape (`{ prune: { tools, pending }, stats, lastUpdated }`) is
 * detected and loaded as empty state — the user confirmed no migration.
 */
interface PersistedState {
  marks: Record<string, PersistedMark>;
  lastUpdated: string;
}

/**
 * Read the persisted session state for a session from disk.
 *
 * Reads `~/.zoo/storage/{sessionId}.json`.  Returns `null` when
 * the file is missing or corrupt (defensive — never throws).
 * Old-format files (with `prune.tools` / `stats`) are loaded as
 * empty state — no migration layer.
 *
 * @param sessionId - The session identifier.
 * @returns Parsed marks map, or `null` on any failure.
 */
export function loadSessionState(sessionId: string): {
  marks: Map<string, Mark>;
} | null {
  try {
    if (!isSafeSessionId(sessionId)) return null;
    const filePath = join(STORAGE_DIR, `${sessionId}.json`);
    if (!existsSync(filePath)) return null;
    const raw = readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;

    // New shape: { marks: {...}, lastUpdated }
    if (
      parsed.marks &&
      typeof parsed.marks === "object" &&
      !Array.isArray(parsed.marks)
    ) {
      const marks = new Map<string, Mark>();
      for (const [id, val] of Object.entries(
        parsed.marks as Record<string, unknown>,
      )) {
        const v = val as { t?: number; e?: boolean };
        marks.set(id, {
          tokens: typeof v.t === "number" ? v.t : 0,
          effective: typeof v.e === "boolean" ? v.e : false,
        });
      }
      return { marks };
    }

    // Old shape (prune.tools / stats) — return empty.
    return { marks: new Map() };
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
 * are swallowed — persistence failure must never crash the caller.
 *
 * JSON shape:
 * `{ marks: Record<callID, { t: tokens, e: effective }>, lastUpdated }`
 *
 * @param sessionId - The session identifier.
 * @param state - The session state to persist.
 */
export function saveSessionState(sessionId: string, state: SessionState): void {
  try {
    if (!isSafeSessionId(sessionId)) return;
    mkdirSync(STORAGE_DIR, { recursive: true });
    const filePath = join(STORAGE_DIR, `${sessionId}.json`);
    const tmpPath = join(STORAGE_DIR, `.${sessionId}.json.tmp`);
    const marksRecord: Record<string, PersistedMark> = {};
    for (const [id, mark] of state.marks) {
      marksRecord[id] = { t: mark.tokens, e: mark.effective };
    }
    const data: PersistedState = {
      marks: marksRecord,
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
// Public API — state management
// ---------------------------------------------------------------------------

/**
 * Get or create the session state for the given session ID.
 *
 * Returns the existing state if one exists, otherwise creates a fresh
 * state with an empty marks map.  On first creation, loads any persisted
 * marks from disk (restart recovery).
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
      marks: persisted?.marks ?? new Map(),
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
// Core operations
// ---------------------------------------------------------------------------

/**
 * Add a mark to the session state.
 *
 * Idempotent: if a mark for `callID` already exists, does nothing and
 * returns `false`.  When a new mark is added, sets `state.dirty = true`.
 *
 * @param state - The session state.
 * @param callID - The tool call identifier.
 * @param tokens - Estimated token count reclaimed when this mark is
 *   applied.
 * @param effective - `true` for immediate-release marks (sweep),
 *   `false` for batch-release marks (dedup).
 * @returns `true` if a new mark was added, `false` if the callID was
 *   already marked.
 */
export function addMark(
  state: SessionState,
  callID: string,
  tokens: number,
  effective: boolean,
): boolean {
  if (state.marks.has(callID)) return false;
  state.marks.set(callID, { tokens, effective });
  state.dirty = true;
  return true;
}

/**
 * Release all pending (non-effective) marks.
 *
 * Flips every mark with `effective === false` to `true`.  Returns the
 * count and total tokens of marks that were actually flipped (fixes
 * the old dual-map stats-inflation bug: only real flips are counted).
 *
 * Idempotent: calling when no pending marks exist returns `{0, 0}`
 * and does NOT set `dirty`.
 *
 * @param state - The session state.
 * @returns `{ count, tokens }` — the number of marks flipped and their
 *   total estimated token count.  Both zero when nothing was pending.
 */
export function releaseBatch(state: SessionState): {
  count: number;
  tokens: number;
} {
  let count = 0;
  let tokens = 0;
  for (const [, mark] of state.marks) {
    if (!mark.effective) {
      mark.effective = true;
      count++;
      tokens += mark.tokens;
    }
  }
  if (count > 0) {
    state.dirty = true;
  }
  return { count, tokens };
}

// ---------------------------------------------------------------------------
// Derived stats (pure functions — read-only over state.marks)
// ---------------------------------------------------------------------------

/**
 * Count of marks that are NOT yet effective (pending batch release).
 *
 * @param state - The session state.
 * @returns Number of pending (non-effective) marks.
 */
export function pendingCount(state: SessionState): number {
  let count = 0;
  for (const [, mark] of state.marks) {
    if (!mark.effective) count++;
  }
  return count;
}

/**
 * Total token estimate of all pending (non-effective) marks.
 *
 * @param state - The session state.
 * @returns Sum of tokens across non-effective marks.
 */
export function pendingTokens(state: SessionState): number {
  let sum = 0;
  for (const [, mark] of state.marks) {
    if (!mark.effective) sum += mark.tokens;
  }
  return sum;
}

/**
 * Total token estimate of all reclaimed (effective) marks.
 *
 * @param state - The session state.
 * @returns Sum of tokens across effective marks.
 */
export function reclaimedTokens(state: SessionState): number {
  let sum = 0;
  for (const [, mark] of state.marks) {
    if (mark.effective) sum += mark.tokens;
  }
  return sum;
}

/**
 * Total number of marks (both effective and pending).
 *
 * @param state - The session state.
 * @returns Size of the marks collection.
 */
export function markedCount(state: SessionState): number {
  return state.marks.size;
}

/**
 * Total token estimate across ALL marks (effective + pending).
 *
 * @param state - The session state.
 * @returns Sum of tokens across all marks.
 */
export function markedTokens(state: SessionState): number {
  let sum = 0;
  for (const [, mark] of state.marks) {
    sum += mark.tokens;
  }
  return sum;
}

// ---------------------------------------------------------------------------
// Testing seams
// ---------------------------------------------------------------------------

/**
 * Clear all session state from the module-level map.
 *
 * Call in test teardown to prevent cross-test pollution.
 */
export function _clearAllSessionsForTesting(): void {
  sessions.clear();
}
