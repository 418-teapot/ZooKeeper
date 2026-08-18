/**
 * Session-state persistence — versioned, atomic, injectable.
 *
 * State files live at `<storageDir>/<sessionId>.json`, one per session,
 * under the default directory `~/.zoo/storage/` (schema version 2).
 * The directory is injectable through `createStateStore` so tests and
 * alternate deployments can point at a sandbox directory.  Writes are
 * atomic (temp file + rename), errors are swallowed (persistence must
 * never crash the caller), and loading is defensive: missing, corrupt,
 * or old-schema files yield an empty state instead of throwing.
 *
 * The schema carries a version field; an incompatible version (the old
 * layout or any future one) loads as empty and is discarded —
 * compression state is volatile by design and the transcript itself
 * survives, so restarting from scratch is always safe.  There is no refs
 * snapshot field; refs are derived per-view and never persisted.
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
import {
  type Block,
  type Mark,
  markKey,
  type Nudges,
  type SessionState,
} from "./state.js";

/** Current persisted schema version. */
export const SCHEMA_VERSION = 2;

/** Default state directory. */
const DEFAULT_STORAGE_DIR = join(homedir(), ".zoo", "storage");

/** Session ids must be filesystem-safe (alphanumeric, underscore, hyphen). */
const SAFE_SESSION_ID_RE = /^[a-zA-Z0-9_-]+$/;

/**
 * Persisted block shape — mirrors `Block`, keyed by block id string.
 */
interface PersistedBlock {
  start: number;
  end: number;
  title?: string;
  summary: string;
  spanHash: string;
  active: boolean;
  compressedTokens: number;
  summaryTokens: number;
  createdAt: number;
}

/**
 * Persisted mark shape — mirrors `Mark`.
 */
interface PersistedMark {
  anchorOrdinal: number;
  regionIndex?: number;
  content: string;
  contentTokens?: number;
  effective: boolean;
  markedAt: number;
  effectiveAt?: number;
  releasedAt?: number;
}

/**
 * Persisted state shape.
 */
interface PersistedState {
  schema: number;
  blocks: Record<string, PersistedBlock>;
  marks: Record<string, PersistedMark>;
  nudges?: Nudges;
  lastUpdated: string;
}

/**
 * Injectable session-state persistence.
 */
export interface StateStore {
  /** The resolved storage directory. */
  readonly dir: string;
  /**
   * Load a session's state; an empty state when the file is absent,
   * corrupt, or carries an incompatible schema.  Never throws.
   */
  load(sessionId: string): SessionState;
  /** Persist a session's state atomically; never throws. */
  save(sessionId: string, state: SessionState): void;
  /** Remove a session's persisted files; never throws. */
  delete(sessionId: string): void;
}

/** Guard: value is a plain record, not null and not an array. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Guard: value is a non-negative integer (ordinals, tokens, stamps). */
function isNonNegInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/**
 * Parse one persisted block entry, or return null when malformed.
 *
 * Unknown fields are ignored (forward compatibility); any known field
 * with a wrong type or an empty/inverted span invalidates the entry.
 *
 * @param value - The raw block entry.
 * @returns The validated block, or null.
 */
function parsePersistedBlock(value: unknown): PersistedBlock | null {
  if (!isRecord(value)) return null;
  const start = value.start;
  const end = value.end;
  const title = value.title;
  const summary = value.summary;
  const spanHash = value.spanHash;
  const active = value.active;
  const compressedTokens = value.compressedTokens;
  const summaryTokens = value.summaryTokens;
  const createdAt = value.createdAt;
  if (!isNonNegInt(start) || !isNonNegInt(end) || start >= end) return null;
  if (typeof summary !== "string") return null;
  if (typeof spanHash !== "string") return null;
  if (typeof active !== "boolean") return null;
  if (!isNonNegInt(compressedTokens) || !isNonNegInt(summaryTokens)) {
    return null;
  }
  if (!isNonNegInt(createdAt)) return null;
  const block: PersistedBlock = {
    start,
    end,
    summary,
    spanHash,
    active,
    compressedTokens,
    summaryTokens,
    createdAt,
  };
  if (typeof title === "string") block.title = title;
  return block;
}

/**
 * Parse one persisted mark entry, or return null when malformed.
 *
 * Unknown fields are ignored; any known field with a wrong type
 * invalidates the entry.
 *
 * @param value - The raw mark entry.
 * @returns The validated mark, or null.
 */
function parsePersistedMark(value: unknown): PersistedMark | null {
  if (!isRecord(value)) return null;
  const anchorOrdinal = value.anchorOrdinal;
  const regionIndex = value.regionIndex;
  const content = value.content;
  const contentTokens = value.contentTokens;
  const effective = value.effective;
  const markedAt = value.markedAt;
  const effectiveAt = value.effectiveAt;
  const releasedAt = value.releasedAt;
  if (!isNonNegInt(anchorOrdinal)) return null;
  if (regionIndex !== undefined && !isNonNegInt(regionIndex)) return null;
  if (typeof content !== "string") return null;
  if (contentTokens !== undefined && !isNonNegInt(contentTokens)) return null;
  if (typeof effective !== "boolean") return null;
  if (!isNonNegInt(markedAt)) return null;
  if (effectiveAt !== undefined && !isNonNegInt(effectiveAt)) return null;
  if (releasedAt !== undefined && !isNonNegInt(releasedAt)) return null;
  const mark: PersistedMark = {
    anchorOrdinal,
    content,
    effective,
    markedAt,
  };
  if (regionIndex !== undefined) mark.regionIndex = regionIndex;
  if (contentTokens !== undefined) mark.contentTokens = contentTokens;
  if (effectiveAt !== undefined) mark.effectiveAt = effectiveAt;
  if (releasedAt !== undefined) mark.releasedAt = releasedAt;
  return mark;
}

/**
 * Validate the optional nudge watermark snapshot.
 *
 * Returns the validated snapshot, or undefined when absent or malformed
 * — a bad watermark never invalidates the rest of the file (it is
 * auxiliary and re-baselines on the next evaluation).  `0` is a valid
 * watermark; negative or fractional values are not.
 *
 * @param value - The raw `nudges` field.
 * @returns The validated snapshot, or undefined.
 */
function parseNudges(value: unknown): Nudges | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) return undefined;
  const last = value.lastNudgeTokens;
  if (last === undefined) return {};
  if (!isNonNegInt(last)) return undefined;
  return { lastNudgeTokens: last };
}

/**
 * Create an injectable state store.
 *
 * All I/O is defensive: `load` never throws (missing/corrupt/old-schema
 * files yield an empty state), `save` and `delete` swallow errors so
 * persistence can never crash the caller.
 *
 * @param storageDir - Directory for state files; defaults to
 *   `~/.zoo/storage/`.
 * @returns The store bound to the resolved directory.
 */
export function createStateStore(storageDir?: string): StateStore {
  const dir = storageDir ?? DEFAULT_STORAGE_DIR;

  const empty = (): SessionState => ({ blocks: new Map(), marks: new Map() });

  const load = (sessionId: string): SessionState => {
    try {
      if (!SAFE_SESSION_ID_RE.test(sessionId)) return empty();
      const filePath = join(dir, `${sessionId}.json`);
      if (!existsSync(filePath)) return empty();
      const raw = readFileSync(filePath, "utf8");
      const parsed = JSON.parse(raw) as unknown;
      if (!isRecord(parsed)) return empty();
      // Old-schema or foreign files load as empty and are discarded.
      if (parsed.schema !== SCHEMA_VERSION) return empty();
      // Both collections are mandatory in the v2 shape.
      if (!isRecord(parsed.blocks) || !isRecord(parsed.marks)) return empty();

      const blocks = new Map<number, Block>();
      for (const [key, value] of Object.entries(parsed.blocks)) {
        const id = Number(key);
        if (!Number.isInteger(id) || id < 1) return empty();
        const block = parsePersistedBlock(value);
        if (block === null) return empty();
        blocks.set(id, block);
      }

      const marks = new Map<string, Mark>();
      for (const [, value] of Object.entries(parsed.marks)) {
        const mark = parsePersistedMark(value);
        if (mark === null) return empty();
        // Keys are derived from the entries rather than trusted from the
        // file, so a hand-edited key cannot corrupt the key space.
        marks.set(markKey(mark.anchorOrdinal, mark.regionIndex), mark);
      }

      const state: SessionState = { blocks, marks };
      const nudges = parseNudges(parsed.nudges);
      if (nudges !== undefined) state.nudges = nudges;
      return state;
    } catch {
      // Defensive: corrupt file → empty state, never throw.
      return empty();
    }
  };

  const save = (sessionId: string, state: SessionState): void => {
    try {
      if (!SAFE_SESSION_ID_RE.test(sessionId)) return;
      mkdirSync(dir, { recursive: true });

      const blocksRecord: Record<string, PersistedBlock> = {};
      for (const [id, block] of state.blocks) {
        const entry: PersistedBlock = {
          start: block.start,
          end: block.end,
          summary: block.summary,
          spanHash: block.spanHash,
          active: block.active,
          compressedTokens: block.compressedTokens,
          summaryTokens: block.summaryTokens,
          createdAt: block.createdAt,
        };
        if (block.title !== undefined) entry.title = block.title;
        blocksRecord[String(id)] = entry;
      }

      const marksRecord: Record<string, PersistedMark> = {};
      for (const [key, mark] of state.marks) {
        const entry: PersistedMark = {
          anchorOrdinal: mark.anchorOrdinal,
          content: mark.content,
          effective: mark.effective,
          markedAt: mark.markedAt,
        };
        if (mark.regionIndex !== undefined) {
          entry.regionIndex = mark.regionIndex;
        }
        if (mark.contentTokens !== undefined) {
          entry.contentTokens = mark.contentTokens;
        }
        if (mark.effectiveAt !== undefined)
          entry.effectiveAt = mark.effectiveAt;
        if (mark.releasedAt !== undefined) entry.releasedAt = mark.releasedAt;
        marksRecord[key] = entry;
      }

      const data: PersistedState = {
        schema: SCHEMA_VERSION,
        blocks: blocksRecord,
        marks: marksRecord,
        lastUpdated: new Date().toISOString(),
      };
      if (state.nudges !== undefined) data.nudges = state.nudges;

      const filePath = join(dir, `${sessionId}.json`);
      const tmpPath = join(dir, `.${sessionId}.json.tmp`);
      writeFileSync(tmpPath, JSON.stringify(data, null, 2), "utf8");
      renameSync(tmpPath, filePath);
    } catch {
      // Defensive: persistence failure must never crash the caller.
    }
  };

  const remove = (sessionId: string): void => {
    try {
      if (!SAFE_SESSION_ID_RE.test(sessionId)) return;
      const filePath = join(dir, `${sessionId}.json`);
      const tmpPath = join(dir, `.${sessionId}.json.tmp`);
      if (existsSync(filePath)) unlinkSync(filePath);
      if (existsSync(tmpPath)) unlinkSync(tmpPath);
    } catch {
      // Best-effort cleanup — never throw.
    }
  };

  return { dir, load, save, delete: remove };
}
