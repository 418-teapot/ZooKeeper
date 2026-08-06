/**
 * Session state management using a single marks collection.
 *
 * **Semantic contract:** marks never delete — even when the referenced
 * message has been compacted away.  Derived stats depend on monotonicity
 * (pendingCount, pendingTokens, reclaimedTokens, markedCount, markedTokens).
 *
 * Each mark is a `{ tokens, effective, action }` triple.  Producers
 * (dedup/sweep) write marks via `addMark`.  `releaseBatch` flips all
 * ineffective marks to effective.  `pruneToolOutputs` reads effective
 * marks only.
 *
 * Persisted shape:
 * `{ marks: Record<callID, { tokens, effective, action }>, lastUpdated }`,
 * plus optional `blocks`, `refs` (the message-ref registry snapshot —
 * see `PersistedRefs`) and `nudges` (the nudge watermark snapshot —
 * see `PersistedNudges`).
 * Any malformed or unrecognized entry causes the file to load as empty
 * (strict per-field validation).  The optional `refs` and `nudges`
 * snapshots are exceptions: when malformed they are ignored with a
 * warning instead of invalidating marks/blocks.
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
import { log } from "../../utils/logger.js";
import type { CompressionBlock } from "./blocks.js";
import type { SessionState } from "./types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Prune action discriminator.
 *
 * - `"tool-output"` — replace the tool part's output with a placeholder.
 * - `"tool-error-input"` — replace the error-status tool part's input
 *   string with a placeholder (future use).
 */
export type PruneAction = "tool-output" | "tool-error-input";

/**
 * A single pruning mark.
 *
 * - `tokens` — estimated token count that would be reclaimed when this
 *   mark becomes effective.
 * - `effective` — `true` when this mark has been released (either
 *   immediately by sweep, or via batch release for dedup marks).
 * - `action` — the type of pruning action this mark represents.
 */
export interface Mark {
  tokens: number;
  effective: boolean;
  action: PruneAction;
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
 * Persisted mark shape (full-word keys, with action discriminator).
 *
 * Fields: tokens, effective, action.  Any entry missing a field or
 * with a wrong-type value fails strict validation and the whole
 * file is loaded as empty.
 */
interface PersistedMark {
  tokens: number;
  effective: boolean;
  action: "tool-output" | "tool-error-input";
}

/**
 * Persisted compression block shape.
 *
 * Mirrors `CompressionBlock` fields.  `deactivatedBy` and `deactivatedAt`
 * are optional; `title` is optional ON READ (dev-era state files predate
 * the field) but required at creation time.  All other fields are
 * required.
 */
interface PersistedBlock {
  blockId: number;
  active: boolean;
  anchorMessageId: string;
  messageIds: string[];
  summary: string;
  title?: string;
  compressedTokens: number;
  summaryTokens: number;
  deactivatedBy?: string;
  deactivatedAt?: number;
  createdAt: number;
}

/**
 * Persisted message-ref registry snapshot.
 *
 * Written by the message-refs module (via `state.refs`) at
 * `saveSessionState` call sites so refs survive a process restart
 * without renumbering.  `byRef` maps ref string → message ID; the
 * inverse map (message ID → ref) is derived on restore and NOT
 * persisted.  Optional — legacy state files without `refs` load
 * cleanly (no schema version bump).
 */
export interface PersistedRefs {
  /** Next ref index (1-based); the next assignment will be `mNNNN`. */
  nextRef: number;
  /** Ref string → OpenCode message ID. */
  byRef: Record<string, string>;
}

/**
 * Persisted nudge watermark snapshot.
 *
 * Written by the context-nudge subsystem at `saveSessionState` call
 * sites.  `lastNudgeTokens` is the single-anchor watermark — the token
 * count at the last trigger / baseline.  Optional — legacy state files
 * without `nudges` load cleanly (no schema version bump), and a
 * malformed field is ignored with a warning (refs precedent).
 */
export interface PersistedNudges {
  /** Single-anchor watermark token count. */
  lastNudgeTokens?: number;
}

/**
 * Persisted state shape (unified marks collection with action, plus
 * compression blocks).
 *
 * Any malformed or unrecognized entry causes the file to load as empty.
 *
 * The `blocks` key is optional.  When absent, blocks are loaded as an
 * empty map.
 */
interface PersistedState {
  marks: Record<string, PersistedMark>;
  blocks?: Record<string, PersistedBlock>;
  refs?: PersistedRefs;
  nudges?: PersistedNudges;
  lastUpdated: string;
}

/**
 * The set of valid prune action values for persisted validation.
 */
const VALID_ACTIONS = new Set<string>(["tool-output", "tool-error-input"]);

/**
 * Regex for valid persisted ref keys — refs are zero-padded four-digit
 * `mNNNN` (`m0001` … `m9999`), matching the generator in message-refs.ts.
 */
const PERSISTED_REF_KEY_RE = /^m\d{4}$/;

/**
 * Validate and extract the optional persisted refs snapshot.
 *
 * Returns `null` when the `refs` key is absent or malformed (defensive —
 * never throws).  Malformed refs do NOT invalidate marks/blocks: the
 * snapshot is auxiliary and its loss is benign (refs re-derive).
 *
 * `nextRef` must be a positive integer (`Number.isInteger(nextRef) &&
 * nextRef >= 1`) and every `byRef` key must match `/^m\d{4}$/` — anything
 * else means the whole snapshot is treated as absent.
 *
 * @param parsed - The parsed state file object.
 * @returns The validated refs snapshot, or `null`.
 */
function parsePersistedRefs(
  parsed: Record<string, unknown>,
): PersistedRefs | null {
  const refs = parsed.refs;
  if (!refs || typeof refs !== "object" || Array.isArray(refs)) return null;
  const r = refs as Record<string, unknown>;
  const nextRef = r.nextRef;
  const byRef = r.byRef;
  if (
    typeof nextRef !== "number" ||
    !Number.isInteger(nextRef) ||
    nextRef < 1 ||
    !byRef ||
    typeof byRef !== "object" ||
    Array.isArray(byRef) ||
    !Object.entries(byRef as Record<string, unknown>).every(
      ([key, value]) =>
        PERSISTED_REF_KEY_RE.test(key) && typeof value === "string",
    )
  ) {
    return null;
  }
  return { nextRef, byRef: byRef as Record<string, string> };
}

/**
 * Validate and extract the optional persisted nudge watermark.
 *
 * Returns `null` when the `nudges` key is absent or malformed (defensive
 * — never throws).  Malformed nudges do NOT invalidate marks/blocks:
 * the watermark is auxiliary and its loss is benign (the nudge subsystem
 * re-baselines on the next evaluation).
 *
 * `lastNudgeTokens` must be a non-negative integer when present
 * (`Number.isInteger(last) && last >= 0`); anything else means the whole
 * snapshot is treated as absent.  An empty object (`nudges: {}`) is
 * valid — the field is optional.
 *
 * @param parsed - The parsed state file object.
 * @returns The validated nudges snapshot, or `null`.
 */
function parsePersistedNudges(
  parsed: Record<string, unknown>,
): PersistedNudges | null {
  const nudges = parsed.nudges;
  if (!nudges || typeof nudges !== "object" || Array.isArray(nudges)) {
    return null;
  }
  const n = nudges as Record<string, unknown>;
  const last = n.lastNudgeTokens;
  if (last === undefined) return {};
  if (typeof last !== "number" || !Number.isInteger(last) || last < 0) {
    return null;
  }
  return { lastNudgeTokens: last };
}

/**
 * Read the persisted session state for a session from disk.
 *
 * Reads `~/.zoo/storage/{sessionId}.json`.  Returns `null` when
 * the file is missing or corrupt (defensive — never throws).
 *
 * **Strict validation:** every mark entry must have
 * `{ tokens: number, effective: boolean,
 * action: "tool-output"|"tool-error-input" }`.  If ANY entry
 * is missing a field, has a wrong type, or has an invalid action
 * value, the entire file is treated as empty and a warning is logged.
 *
 * The same strict validation applies to block entries.  Every block
 * must have all required fields (`blockId`, `active`, `anchorMessageId`,
 * `messageIds`, `summary`, `compressedTokens`, `summaryTokens`,
 * `createdAt`) with correct types.  `title` is optional on read
 * (dev-era state files may lack it) — when absent or non-string the
 * block still loads with an undefined title.  If ANY block entry is
 * malformed, the entire file is treated as empty and a warning is
 * logged.
 *
 * The `blocks` key is optional.  When absent, blocks are loaded as an
 * empty map.
 *
 * The `refs` and `nudges` keys are optional.  When malformed they are
 * ignored with a warning and do NOT invalidate marks/blocks.
 *
 * Any malformed or unrecognized entry causes the file to load as
 * empty (strict per-field validation).
 *
 * @param sessionId - The session identifier.
 * @returns Parsed marks map and blocks map, or `null` on any failure.
 */
export function loadSessionState(sessionId: string): {
  marks: Map<string, Mark>;
  blocks: Map<string, CompressionBlock>;
  refs?: PersistedRefs;
  nudges?: PersistedNudges;
} | null {
  try {
    if (!isSafeSessionId(sessionId)) return null;
    const filePath = join(STORAGE_DIR, `${sessionId}.json`);
    if (!existsSync(filePath)) return null;
    const raw = readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;

    // Current shape: { marks: {...}, blocks?: {...}, lastUpdated }
    if (
      parsed.marks &&
      typeof parsed.marks === "object" &&
      !Array.isArray(parsed.marks)
    ) {
      const marks = new Map<string, Mark>();
      const markEntries = Object.entries(
        parsed.marks as Record<string, unknown>,
      );

      for (const [id, val] of markEntries) {
        const v = val as Record<string, unknown>;
        // Strict validation: must have tokens (number),
        // effective (boolean), action (valid action value).
        const tokens = v.tokens;
        const effective = v.effective;
        const action = v.action;
        if (
          typeof tokens !== "number" ||
          typeof effective !== "boolean" ||
          typeof action !== "string" ||
          !VALID_ACTIONS.has(action)
        ) {
          log("pruning", "load_invalid_entry", sessionId, undefined, "warn", {
            entryId: id,
            reason:
              typeof tokens !== "number"
                ? "tokens not a number"
                : typeof effective !== "boolean"
                  ? "effective not a boolean"
                  : typeof action !== "string"
                    ? "action not a string"
                    : "action not a valid action",
            filePath,
          });
          // Entire file treated as empty.
          return { marks: new Map(), blocks: new Map() };
        }
        marks.set(id, {
          tokens,
          effective,
          action: action as PruneAction,
        });
      }

      // Parse blocks (optional key — absent defaults to empty).
      const blocks = new Map<string, CompressionBlock>();
      if (
        parsed.blocks &&
        typeof parsed.blocks === "object" &&
        !Array.isArray(parsed.blocks)
      ) {
        const blockEntries = Object.entries(
          parsed.blocks as Record<string, unknown>,
        );

        for (const [key, val] of blockEntries) {
          const b = val as Record<string, unknown>;
          // Strict validation: all required fields with correct types.
          const blockId = b.blockId;
          const active = b.active;
          const anchorMessageId = b.anchorMessageId;
          const messageIds = b.messageIds;
          const summary = b.summary;
          const title = b.title;
          const compressedTokens = b.compressedTokens;
          const summaryTokens = b.summaryTokens;
          const createdAt = b.createdAt;

          if (
            typeof blockId !== "number" ||
            typeof active !== "boolean" ||
            typeof anchorMessageId !== "string" ||
            !Array.isArray(messageIds) ||
            !messageIds.every((m: unknown) => typeof m === "string") ||
            typeof summary !== "string" ||
            typeof compressedTokens !== "number" ||
            typeof summaryTokens !== "number" ||
            typeof createdAt !== "number"
          ) {
            log(
              "pruning",
              "load_invalid_block_entry",
              sessionId,
              undefined,
              "warn",
              {
                entryKey: key,
                reason: "malformed block entry",
                filePath,
              },
            );
            // Entire file treated as empty.
            return { marks: new Map(), blocks: new Map() };
          }

          const block: CompressionBlock = {
            blockId,
            active,
            anchorMessageId,
            messageIds,
            summary,
            compressedTokens,
            summaryTokens,
            // Title passes through only when it is a string; a dev-era
            // block without the field loads with an undefined title.
            title: typeof title === "string" ? title : undefined,
            createdAt,
          };
          // deactivatedBy / deactivatedAt are optional — only set when present.
          if (b.deactivatedBy !== undefined) {
            block.deactivatedBy = b.deactivatedBy as string;
          }
          if (b.deactivatedAt !== undefined) {
            block.deactivatedAt = b.deactivatedAt as number;
          }
          blocks.set(key, block);
        }
      }

      // Optional refs snapshot — absent/malformed means no persisted refs.
      const refs = parsePersistedRefs(parsed);
      // Optional nudge watermark — malformed is warned and ignored and
      // does NOT cascade-invalidate marks/blocks (refs precedent).
      let nudges: PersistedNudges | undefined;
      if (parsed.nudges !== undefined) {
        const parsedNudges = parsePersistedNudges(parsed);
        if (parsedNudges === null) {
          log("pruning", "load_invalid_nudges", sessionId, undefined, "warn", {
            filePath,
          });
        } else {
          nudges = parsedNudges;
        }
      }
      return {
        marks,
        blocks,
        ...(refs ? { refs } : {}),
        ...(nudges ? { nudges } : {}),
      };
    }

    // Obsolete shapes (compact keys / v1 prune.tools/stats) — empty.
    return { marks: new Map(), blocks: new Map() };
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
 * `{ marks: Record<callID, { tokens, effective, action }>, lastUpdated }`
 * plus optional `blocks`, `refs`, and `nudges` (written only when
 * present on the state).
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
      marksRecord[id] = {
        tokens: mark.tokens,
        effective: mark.effective,
        action: mark.action,
      };
    }
    const blocksRecord: Record<string, PersistedBlock> = {};
    for (const [key, block] of state.blocks) {
      const entry: PersistedBlock = {
        blockId: block.blockId,
        active: block.active,
        anchorMessageId: block.anchorMessageId,
        messageIds: [...block.messageIds],
        summary: block.summary,
        title: block.title,
        compressedTokens: block.compressedTokens,
        summaryTokens: block.summaryTokens,
        createdAt: block.createdAt,
      };
      if (block.deactivatedBy !== undefined) {
        entry.deactivatedBy = block.deactivatedBy;
      }
      if (block.deactivatedAt !== undefined) {
        entry.deactivatedAt = block.deactivatedAt;
      }
      blocksRecord[key] = entry;
    }
    const data: PersistedState = {
      marks: marksRecord,
      blocks: blocksRecord,
      lastUpdated: new Date().toISOString(),
    };
    if (state.refs !== undefined) {
      data.refs = state.refs;
    }
    if (state.nudges !== undefined) {
      data.nudges = state.nudges;
    }
    writeFileSync(tmpPath, JSON.stringify(data, null, 2), "utf8");
    renameSync(tmpPath, filePath);
  } catch {
    // Defensive: persistence failure must never crash the caller.
  }
}

/**
 * Narrow read of the persisted refs snapshot for a session.
 *
 * Reads `~/.zoo/storage/{sessionId}.json` and extracts only the `refs`
 * field.  Returns `null` when the file is missing, corrupt, the `refs`
 * key is absent, or the snapshot is malformed (defensive — never
 * throws).
 *
 * Used by the message-refs module to hydrate the runtime registry on
 * process restart.  Kept separate from `loadSessionState` so the ref
 * registry can restore without paying for marks/blocks parsing.
 *
 * @param sessionId - The session identifier.
 * @returns The persisted refs snapshot, or `null`.
 */
export function readPersistedRefs(sessionId: string): PersistedRefs | null {
  try {
    if (!isSafeSessionId(sessionId)) return null;
    const filePath = join(STORAGE_DIR, `${sessionId}.json`);
    if (!existsSync(filePath)) return null;
    const raw = readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return parsePersistedRefs(parsed);
  } catch {
    // Defensive: missing / corrupt file → null, never throw.
    return null;
  }
}

/**
 * Remove only the persisted `refs` snapshot from the session state file.
 *
 * Loads `~/.zoo/storage/{sessionId}.json`, deletes the `refs` field, and
 * rewrites the file atomically.  No-op when the file is missing or has no
 * `refs` field.  Marks and blocks are left intact.  Also clears the
 * in-memory `state.refs` so a later `saveSessionState` cannot re-persist
 * the stale snapshot.  Defensive — never throws.
 *
 * Used by the message-refs module on compaction-boundary reset so the
 * stale snapshot cannot re-hydrate old refs on the next `ensureRegistry`
 * (which would defeat the renumber-from-`m0001` reset semantics).
 *
 * @param sessionId - The session identifier.
 */
export function clearPersistedRefs(sessionId: string): void {
  try {
    if (!isSafeSessionId(sessionId)) return;
    const filePath = join(STORAGE_DIR, `${sessionId}.json`);
    if (!existsSync(filePath)) return;
    const raw = readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (typeof parsed.refs === "undefined") return;
    delete parsed.refs;
    const tmpPath = join(STORAGE_DIR, `.${sessionId}.json.tmp`);
    writeFileSync(tmpPath, JSON.stringify(parsed, null, 2), "utf8");
    renameSync(tmpPath, filePath);
    // Drop the in-memory snapshot too, so a save before the next ref
    // pipeline run cannot write the stale refs back to disk.
    const state = sessions.get(sessionId);
    if (state) state.refs = undefined;
  } catch {
    // Defensive: never throw.
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
      blocks: persisted?.blocks ?? new Map(),
      lastAccessedAt: Date.now(),
      dirty: false,
      pendingViewChange: false,
      refs: persisted?.refs,
      nudges: persisted?.nudges,
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
 * @param action - The pruning action this mark represents.
 * @returns `true` if a new mark was added, `false` if the callID was
 *   already marked.
 */
export function addMark(
  state: SessionState,
  callID: string,
  tokens: number,
  effective: boolean,
  action: PruneAction,
): boolean {
  if (state.marks.has(callID)) return false;
  state.marks.set(callID, { tokens, effective, action });
  state.dirty = true;
  return true;
}

/**
 * Release all pending (non-effective) marks.
 *
 * Flips every mark with `effective === false` to `true`.  Returns the
 * count and total tokens of marks that were actually flipped (fixes
 * the old dual-map stats-inflation bug: only real flips are counted),
 * plus a per-action breakdown.
 *
 * Idempotent: calling when no pending marks exist returns `{0, 0, ...}`
 * and does NOT set `dirty`.
 *
 * @param state - The session state.
 * @returns `{ count, tokens, byAction }` — the number of marks flipped
 *   and their total estimated token count, with per-action sub-totals.
 *   All zero when nothing was pending.
 */
export function releaseBatch(state: SessionState): {
  count: number;
  tokens: number;
  byAction: Record<PruneAction, { count: number; tokens: number }>;
} {
  let count = 0;
  let tokens = 0;
  const byAction: Record<PruneAction, { count: number; tokens: number }> = {
    "tool-output": { count: 0, tokens: 0 },
    "tool-error-input": { count: 0, tokens: 0 },
  };
  for (const [, mark] of state.marks) {
    if (!mark.effective) {
      mark.effective = true;
      count++;
      tokens += mark.tokens;
      byAction[mark.action].count++;
      byAction[mark.action].tokens += mark.tokens;
    }
  }
  if (count > 0) {
    state.dirty = true;
  }
  return { count, tokens, byAction };
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
