/**
 * Pi subagent-history scanner — rebuilds the process-level run registry from
 * the pi session message history.
 *
 * The run registry (`src/core/subagent/registry.ts`) is process-level state:
 * when pi exits, every live `running` / finished entry is lost, so a session
 * restore / resume renders an empty fleet widget.  This module rescans the
 * current session's persisted message history (via
 * `sessionManager.buildContextEntries()`) and rewrites the registry from it.
 *
 * The scanner understands the pi message shape (see `src/adapters/pi/types.ts`
 * and `history.ts`): an assistant `toolCall` block is the call half of a tool
 * invocation, paired with a separate `toolResult` message by call id.
 *
 * Resolution rules:
 * - `name === "subagent"` tool calls are tracked; everything else is ignored.
 * - A call with a linked `toolResult` message resolves by the result's
 *   `isError` flag: `true` → `error` (with the result text as the failure
 *   reason), `false` → `done`.
 * - A call WITHOUT a linked result was still in flight when pi exited — the
 *   exit interrupted it — so it is rebuilt as `aborted`, with `endedAt`
 *   falling back to the call's own timestamp.
 * - `args.agent` / `args.description` map to the run's `agent` / `label`.
 * - Timestamps come from the pi message `timestamp` (epoch millis); absent
 *   on both halves, they fall back to `Date.now()`.
 * - The terminal `toolResult`'s `details` payload (persisted by the
 *   subagent tool, see `src/tools/subagent.ts`) carries the delegation's
 *   `runId`, the sub-session `childSession`, and the on-disk `sessionPath`.
 *   When present, `runId` is preferred over the tool-call id as the run id,
 *   and the two session pointers are carried onto the scanned run.
 *
 * Nested delegation rebuild: each finished run's `details.sessionPath`
 * points at its sub-session jsonl file.  The scanner reads that file and
 * rescans it for `subagent` calls, whose nested runs are scoped to the
 * parent run's `childSession` (the registry's tree invariant:
 * `childrenOf(parent)` matches `run.parentSession === parent.childSession`).
 * This recursion descends through arbitrarily deep delegation chains
 * (beaver → lynx → ...) with no depth cap.  A global visited set of
 * session ids guards against cycles: each session file is scanned at most
 * once, so a corrupted back-reference (A → B → A) stops that branch with a
 * warn instead of recursing forever.  A missing / unreadable sub-session
 * file skips only that branch (warn) — the parent run is still rebuilt.
 *
 * Idempotence: run ids are the pi run ids (globally unique), and the
 * registry's terminal-immutability rule means a re-scan of the same history
 * never duplicates an entry or overwrites a terminal one.  A run still live
 * in this process (its `running` entry already exists) is likewise left
 * untouched — the registry silently ignores the aborted finish.
 *
 * @module
 */

import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { finishRun, getRun, startRun } from "../../core/subagent/registry.js";
import { log } from "../../utils/logger.js";

/** The pi history entry shape returned by `buildContextEntries()`. */
export interface PiHistoryEntry {
  type: string;
  message?: unknown;
}

/** A pi `toolCall` content block (see `src/adapters/pi/types.ts`). */
interface PiToolCallBlock {
  type?: string;
  id?: unknown;
  name?: unknown;
  arguments?: unknown;
}

/** A pi `toolResult` message (see `src/adapters/pi/types.ts`). */
interface PiToolResultMessage {
  role?: string;
  toolCallId?: unknown;
  toolName?: unknown;
  content?: unknown;
  isError?: boolean;
  timestamp?: unknown;
  /** The structured progress payload persisted on the subagent result. */
  details?: unknown;
}

/** A pi assistant message (see `src/adapters/pi/types.ts`). */
interface PiAssistantMessage {
  role?: string;
  content?: unknown;
  timestamp?: unknown;
}

/** The parsed facts of one subagent tool call in the history. */
export interface ScannedRun {
  /** The run id (the pi run id / tool-call id). */
  id: string;
  /** The delegated subagent name. */
  agent: string;
  /** The calling session id the run is scoped to. */
  parentSession: string;
  /** The delegation's task description, when present. */
  label?: string;
  /** The terminal outcome: `done` / `error` / `aborted` (interrupted). */
  status: "done" | "error" | "aborted";
  /** Epoch-millis start time. */
  startedAt: number;
  /** Epoch-millis end time. */
  endedAt: number;
  /** The failure reason, when the outcome is `error`. */
  error?: string;
  /** The sub-session id this run created, from the result's `details`. */
  childSession?: string;
  /** The on-disk sub-session file path, from the result's `details`. */
  sessionPath?: string;
}

/**
 * Coerce a raw history value to a finite epoch-millis timestamp.
 *
 * Only finite numbers are accepted; everything else yields `undefined` so
 * the caller can apply its fallback.
 *
 * @param value - The raw timestamp.
 * @returns The finite millis, or `undefined`.
 */
function asMillis(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

/**
 * Extract the joined text of the text content parts of a pi tool result.
 *
 * Only `text` parts count — image / other parts are ignored — mirroring the
 * projection used across the pi adapter.
 *
 * @param content - The pi content parts (array or raw string).
 * @returns The joined text (empty when there is none).
 */
function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const part of content) {
    if (
      part !== null &&
      typeof part === "object" &&
      (part as { type?: unknown }).type === "text"
    ) {
      const text = (part as { text?: unknown }).text;
      if (typeof text === "string") parts.push(text);
    }
  }
  return parts.join("");
}

/**
 * Read a subagent tool call's agent / description arguments.
 *
 * @param raw - The raw tool-call arguments value.
 * @returns The extracted agent and optional label.
 */
function callFacts(raw: unknown): { agent: string; label?: string } {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { agent: "task" };
  }
  const args = raw as Record<string, unknown>;
  const agent = args.agent;
  const agentName = typeof agent === "string" && agent.length > 0 ? agent : "";
  const description = args.description;
  return {
    agent: agentName.length > 0 ? agentName : "task",
    ...(typeof description === "string" && description.length > 0
      ? { label: description }
      : {}),
  };
}

/**
 * Extract the delegation pointers from a subagent tool result's `details`.
 *
 * The terminal `details` payload (persisted by the subagent tool, see
 * `src/tools/subagent.ts`) carries the run's `runId`, the created
 * sub-session's `childSession`, and the on-disk `sessionPath`.  All three
 * are optional strings; a missing or ill-shaped `details` yields an empty
 * result (the top-level rebuild never depends on them).
 *
 * @param raw - The raw `details` value from the toolResult message.
 * @returns The extracted run id / child session / session path.
 */
function detailsFacts(raw: unknown): {
  runId?: string;
  childSession?: string;
  sessionPath?: string;
} {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return {};
  }
  const obj = raw as Record<string, unknown>;
  const runId = obj.runId;
  const childSession = obj.childSession;
  const sessionPath = obj.sessionPath;
  return {
    ...(typeof runId === "string" && runId.length > 0 ? { runId } : {}),
    ...(typeof childSession === "string" && childSession.length > 0
      ? { childSession }
      : {}),
    ...(typeof sessionPath === "string" && sessionPath.length > 0
      ? { sessionPath }
      : {}),
  };
}

/**
 * Scan pi history entries for `subagent` tool calls.
 *
 * Assistant `toolCall` blocks named `"subagent"` are paired with their
 * linked `toolResult` message (by call id).  A linked result resolves the
 * outcome from its `isError` flag; an unlinked (in-flight) call is treated
 * as interrupted by the pi exit and resolved to `aborted`.
 *
 * The run id is the result's `details.runId` when present (the subagent
 * tool's own run id), falling back to the tool-call id — they are equal on
 * pi (see `src/pi.ts`), so this only matters for robustness.  The result's
 * `details.childSession` / `details.sessionPath` are carried onto the
 * scanned run when present.
 *
 * @param entries - The pi context entries from `buildContextEntries()`.
 * @param parentSession - The calling (main) session id the runs are scoped
 *   to in the registry.
 * @returns The scanned runs, oldest call first.
 */
export function extractSubagentRuns(
  entries: PiHistoryEntry[],
  parentSession: string,
): ScannedRun[] {
  // Index the toolResult messages by call id (result half first, so a
  // toolCall block can resolve its linked result).
  const results = new Map<string, PiToolResultMessage>();
  for (const entry of entries) {
    const message = entry?.message;
    if (message === null || typeof message !== "object") continue;
    const msg = message as PiToolResultMessage;
    if (msg.role !== "toolResult") continue;
    if (typeof msg.toolCallId === "string" && msg.toolCallId.length > 0) {
      results.set(msg.toolCallId, msg);
    }
  }

  const runs: ScannedRun[] = [];
  for (const entry of entries) {
    const message = entry?.message;
    if (message === null || typeof message !== "object") continue;
    const msg = message as PiAssistantMessage;
    if (msg.role !== "assistant") continue;
    const content = msg.content;
    if (!Array.isArray(content)) continue;

    for (const blockRaw of content) {
      if (blockRaw === null || typeof blockRaw !== "object") continue;
      const block = blockRaw as PiToolCallBlock;
      if (block.type !== "toolCall") continue;
      if (block.name !== "subagent") continue;
      const callId = block.id;
      if (typeof callId !== "string" || callId.length === 0) continue;

      const fallback = asMillis(msg.timestamp) ?? Date.now();
      const { agent, label } = callFacts(block.arguments);
      const result = results.get(callId);
      if (result === undefined) {
        // Still in flight when pi exited — the exit interrupted the run.
        runs.push({
          id: callId,
          agent,
          parentSession,
          status: "aborted",
          startedAt: fallback,
          endedAt: fallback,
          ...(label !== undefined ? { label } : {}),
        });
        continue;
      }

      const isError = result.isError === true;
      const text = resultText(result.content);
      const { runId, childSession, sessionPath } = detailsFacts(result.details);
      runs.push({
        id: runId ?? callId,
        agent,
        parentSession,
        status: isError ? "error" : "done",
        startedAt: fallback,
        endedAt: asMillis(result.timestamp) ?? fallback,
        ...(label !== undefined ? { label } : {}),
        ...(childSession !== undefined ? { childSession } : {}),
        ...(sessionPath !== undefined ? { sessionPath } : {}),
        ...(isError ? { error: text } : {}),
      });
    }
  }
  return runs;
}

/**
 * Rebuild the registry from scanned pi history.
 *
 * Each scanned run is written through the standard lifecycle: an absent run
 * is `startRun`'d then `finishRun`'d with its scanned terminal outcome; a
 * run already present is left untouched — the registry's terminal-immutability
 * rule silently ignores a finish on a terminal or still-running entry, so a
 * re-scan of the same history (or a scan of a run still live in this
 * process) never overwrites or duplicates it.  The interrupted (aborted)
 * runs carry their `endedAt` from the scan, not the current time.
 *
 * Nested delegation rebuild: a finished run's `details.sessionPath` points
 * at its sub-session jsonl file.  That file is read and rescanned with the
 * same logic, producing nested `ScannedRun`s scoped to the parent run's
 * `childSession` (the registry tree invariant), and the recursion descends
 * through arbitrarily deep chains.  When a run carries only a
 * `childSession` (no `sessionPath`) the file is located by scanning the
 * sessions root for a header whose id matches.  A missing / unreadable
 * sub-session file skips only that branch (warn); the parent run is still
 * rebuilt.  A global visited set of session ids prevents infinite
 * recursion on cyclic (corrupted) session graphs: a session file already
 * scanned on the current path is skipped with a warn.
 *
 * @param entries - The pi context entries from `buildContextEntries()`.
 * @param parentSession - The calling session id the runs are scoped to in
 *   the registry (the main session at the top level, a parent run's
 *   `childSession` for nested levels).
 * @param options - Optional `sessionsRoot` override (tests point it at a
 *   fixture directory).
 * @returns The number of runs (re)written into the registry.
 */
export interface RebuildOptions {
  /** The pi sessions root (`<data>/sessions`); defaults to
   * `~/.pi/agent/sessions` honoring `ZOO_PI_DATA_DIR`. */
  sessionsRoot?: string;
  /** Injectable fs surface for the session-path index (tests use it to
   * assert the one-scan guarantee).  Production callers omit it. */
  indexIO?: SessionIndexIO;
}

/**
 * Rebuild the registry from scanned pi history, recursing into nested
 * sub-session files.
 *
 * @param entries - The pi context entries from `buildContextEntries()`.
 * @param parentSession - The calling session id the runs are scoped to.
 * @param options - Optional sessions-root override.
 * @returns The number of runs (re)written into the registry.
 */
export function rebuildSubagentRuns(
  entries: PiHistoryEntry[],
  parentSession: string,
  options?: RebuildOptions,
): number {
  const sessionsRoot = options?.sessionsRoot;
  // One shared visited set for the whole rebuild: a session file is
  // scanned at most once, even when a corrupted graph reaches it through
  // two different branches.  Seeding the main session id catches a
  // top-level run whose nested pointer loops straight back to it.
  const visited = new Set<string>([parentSession]);
  // One shared session-id → path index for the whole rebuild, built lazily
  // on the first pointer-less run so the sessions root is swept at most
  // once regardless of how many runs need a path lookup.
  const pathIndex = new SessionPathIndex(sessionsRoot, options?.indexIO);
  return rebuildLevel(entries, parentSession, visited, pathIndex);
}

/**
 * The file-reading surface the session index uses (injectable for tests so
 * the one-scan guarantee can be asserted).
 */
export interface SessionIndexIO {
  readdirSync(dir: string): string[];
  readFileSync(path: string, encoding: "utf-8"): string;
}

/**
 * A lazily-built session-id → file-path index over the sessions root.
 *
 * The legacy `locateSessionFile` rescan of the sessions root (a readdirSync
 * over every cwd dir and every `*.jsonl` header) ran for EACH run missing a
 * `sessionPath` — O(runs × files).  The index builds that scan ONCE, on the
 * first lookup that needs it, then serves every later lookup from the
 * in-memory map, so a rebuild with many pointer-less runs does a single
 * directory sweep.  Malformed / unreadable files are skipped; a missing or
 * unreadable root yields an empty index (the caller skips those branches).
 */
export class SessionPathIndex {
  private readonly root: string | undefined;
  private readonly io: SessionIndexIO;
  private map: Map<string, string> | undefined;

  /**
   * @param root - The pi sessions root, or `undefined` for the default.
   * @param io - Injectable fs surface (defaults to the real `node:fs`).
   */
  constructor(root: string | undefined, io?: SessionIndexIO) {
    this.root = root;
    this.io = io ?? { readdirSync, readFileSync };
  }

  /**
   * Look up a session id's file path, building the index on first use.
   *
   * @param childSession - The session id to find.
   * @returns The file path, or `undefined` when not found.
   */
  lookup(childSession: string): string | undefined {
    if (this.map === undefined) {
      this.map = this.build();
    }
    return this.map.get(childSession);
  }

  /**
   * Scan the sessions root once and index every session header id.
   *
   * @returns The session-id → file-path index.
   */
  private build(): Map<string, string> {
    const root = this.root ?? defaultSessionsRoot();
    const index = new Map<string, string>();
    let cwdDirs: string[];
    try {
      cwdDirs = this.io.readdirSync(root);
    } catch {
      return index;
    }
    for (const cwdDir of cwdDirs) {
      const dir = join(root, cwdDir);
      let files: string[];
      try {
        files = this.io.readdirSync(dir);
      } catch {
        continue;
      }
      for (const file of files) {
        if (!file.endsWith(".jsonl")) continue;
        const path = join(dir, file);
        try {
          const header = JSON.parse(
            this.io.readFileSync(path, "utf-8").split("\n", 1)[0] ?? "",
          ) as { id?: unknown };
          if (typeof header.id === "string" && header.id.length > 0) {
            // First occurrence wins, matching the old linear scan.
            if (!index.has(header.id)) index.set(header.id, path);
          }
        } catch {
          // Skip malformed / unreadable session files.
        }
      }
    }
    return index;
  }
}

/**
 * The recursive core of `rebuildSubagentRuns`.
 *
 * Scans one history level, writes each run, then descends into each run's
 * sub-session file (when one can be located).  The nested level's runs are
 * scoped to the parent run's `childSession`, keeping the registry's
 * parent/child tree invariant.  A global `visited` set of session ids
 * guards against cycles: every sub-session file is scanned at most once,
 * so a corrupted back-reference (A → B → A) skips the repeated session
 * with a warn instead of recursing forever.  Tree-shaped data descends
 * with no depth limit.
 *
 * @param entries - The pi history entries for this level.
 * @param parentSession - The session id this level's runs are scoped to.
 * @param visited - The shared set of session ids already scanned on this
 *   rebuild (global across branches — each session file is scanned once).
 * @param pathIndex - The shared session-id → path index (built lazily on
 *   first use so the sessions root is swept at most once per rebuild).
 * @returns The number of runs written at this and all deeper levels.
 */
function rebuildLevel(
  entries: PiHistoryEntry[],
  parentSession: string,
  visited: Set<string>,
  pathIndex: SessionPathIndex,
): number {
  const runs = extractSubagentRuns(entries, parentSession);
  let written = 0;
  for (const scanned of runs) {
    // Idempotence: an absent run is started and finished; an existing one
    // is left untouched (terminal immutability silently ignores the
    // finish).  Recursion still descends so a partially-scanned history is
    // completed on a later scan without duplicating anything.
    if (getRun(scanned.id) === undefined) {
      startRun({
        id: scanned.id,
        agent: scanned.agent,
        parentSession,
        label: scanned.label,
        startedAt: scanned.startedAt,
        ...(scanned.childSession !== undefined
          ? { childSession: scanned.childSession }
          : {}),
        ...(scanned.sessionPath !== undefined
          ? { sessionPath: scanned.sessionPath }
          : {}),
      });
      finishRun(scanned.id, {
        status: scanned.status,
        endedAt: scanned.endedAt,
        ...(scanned.error !== undefined ? { error: scanned.error } : {}),
        ...(scanned.childSession !== undefined
          ? { childSession: scanned.childSession }
          : {}),
        ...(scanned.sessionPath !== undefined
          ? { sessionPath: scanned.sessionPath }
          : {}),
      });
      written += 1;
    }

    const nestedPath = resolveNestedPath(scanned, pathIndex);
    if (nestedPath === undefined) continue;
    const nestedEntries = readSessionEntries(nestedPath);
    if (nestedEntries === undefined) {
      log(
        "subagent-scan",
        "nested_session_unreadable",
        parentSession,
        scanned.id,
        "warn",
        {
          runId: scanned.id,
          sessionPath: scanned.sessionPath ?? nestedPath,
        },
      );
      continue;
    }
    // The nested runs execute inside the parent run's sub-session, so their
    // `parentSession` is the parent run's `childSession` (falling back to
    // the run id when the child session is absent — the tree invariant
    // simply won't attach them).
    const nestedParent =
      scanned.childSession !== undefined ? scanned.childSession : scanned.id;
    // Cycle guard: a session id already scanned on this rebuild means the
    // session graph is corrupted (e.g. A → B → A back-reference).  Skip
    // the repeat with a warn instead of recursing forever.  The set is
    // global across branches, so a session file reached through two
    // different parents is only ever scanned once.
    if (visited.has(nestedParent)) {
      log(
        "subagent-scan",
        "nested_session_cycle",
        parentSession,
        scanned.id,
        "warn",
        {
          runId: scanned.id,
          childSession: nestedParent,
          sessionPath: scanned.sessionPath ?? nestedPath,
        },
      );
      continue;
    }
    visited.add(nestedParent);
    written += rebuildLevel(nestedEntries, nestedParent, visited, pathIndex);
  }
  return written;
}

/**
 * Resolve the sub-session file path for a scanned run.
 *
 * The run's `details.sessionPath` wins when present; otherwise a run that
 * carries a `childSession` is located through the shared session-path index
 * (a lazily-built single sweep of the sessions root).  Returns `undefined`
 * when neither is available or the file cannot be found — the caller skips
 * that branch.
 *
 * @param scanned - The scanned run.
 * @param pathIndex - The shared session-id → path index for this rebuild.
 * @returns The sub-session file path, or `undefined`.
 */
function resolveNestedPath(
  scanned: ScannedRun,
  pathIndex: SessionPathIndex,
): string | undefined {
  if (scanned.sessionPath !== undefined && scanned.sessionPath.length > 0) {
    return scanned.sessionPath;
  }
  if (scanned.childSession === undefined) return undefined;
  return pathIndex.lookup(scanned.childSession);
}

/**
 * The default pi sessions root: `ZOO_PI_DATA_DIR` when set, otherwise
 * `~/.pi/agent`, plus `/sessions` — mirroring the Rust tooling's
 * resolution (see `tools/zutil/src/session/pi.rs`).
 *
 * @returns The sessions root directory.
 */
function defaultSessionsRoot(): string {
  const envDir = process.env.ZOO_PI_DATA_DIR;
  const dataDir =
    envDir !== undefined && envDir.length > 0
      ? envDir
      : join(homedir(), ".pi", "agent");
  return join(dataDir, "sessions");
}

/**
 * Read a pi session jsonl file into history entries.
 *
 * Only `message` entries are kept (the session header and other record
 * types are ignored).  Malformed lines are skipped.  Returns `undefined`
 * when the file is missing or unreadable — the caller skips the branch.
 *
 * @param path - The session file path.
 * @returns The message entries, or `undefined` on read failure.
 */
function readSessionEntries(path: string): PiHistoryEntry[] | undefined {
  let text: string;
  try {
    text = readFileSync(path, "utf-8");
  } catch {
    return undefined;
  }
  const entries: PiHistoryEntry[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      const raw = JSON.parse(trimmed) as {
        type?: unknown;
        message?: unknown;
      };
      if (raw?.type === "message") {
        entries.push({ type: "message", message: raw.message });
      }
    } catch {
      // Skip malformed lines.
    }
  }
  return entries;
}

/**
 * Read the working directory recorded in a pi session file's header.
 *
 * The first line of a pi session jsonl is the `session` header carrying the
 * `cwd` the session ran in.  The transcript overlay's native tool renderers
 * use it as their render context (e.g. read's compact call classification),
 * so the header is parsed separately from `readSessionEntries` (which drops
 * non-message records).  Returns `undefined` when the file is missing,
 * unreadable, or its header is malformed.
 *
 * @param path - The session file path.
 * @returns The session's working directory, or `undefined`.
 */
export function readSessionCwd(path: string): string | undefined {
  let text: string;
  try {
    text = readFileSync(path, "utf-8");
  } catch {
    return undefined;
  }
  const firstLine = text.split("\n", 1)[0] ?? "";
  try {
    const header = JSON.parse(firstLine) as { cwd?: unknown };
    if (typeof header.cwd === "string" && header.cwd.length > 0) {
      return header.cwd;
    }
  } catch {
    // Malformed header line.
  }
  return undefined;
}
