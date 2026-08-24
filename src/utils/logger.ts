/**
 * JSON Lines file logger for the ZooKeeper plugin.
 *
 * Writes structured log entries to `~/.zoo/log/<host>-<sessionId>.log` in
 * JSON Lines format with buffered writes (auto-flush at 50 entries) and a
 * 500ms flush timer.  Supports file rotation, old-log cleanup, and
 * level-based filtering.
 *
 * Sessionless entries (e.g. load-time config warnings) are never given
 * their own `<host>.log` file.  They buffer and, once the process's first
 * sessioned entry establishes the primary session, flush into that
 * session's file; if no session ever materialises they stay buffered and
 * are dropped at process exit.  Because unattributable sessionless
 * entries are re-buffered on every flush, the buffer is not a hard bound
 * in a never-sessioned process — the 50-entry auto-flush applies to
 * attributable entries.
 *
 * @module
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface LoggerOptions {
  logDir: string;
  /** When undefined, file rotation is disabled. */
  maxFileSize?: number;
  /** When undefined, backup count trimming is disabled. */
  maxBackups?: number;
  /** When undefined, old-log cleanup is disabled. */
  retentionDays?: number;
}

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

const DEFAULT_LOG_DIR = join(homedir(), ".zoo", "log");

/** Host name fixed at process initialisation (e.g. `"opencode"`, `"pi"`). */
let _host = "";
let _logDir = DEFAULT_LOG_DIR;
/** Undefined = rotation disabled. */
let _maxFileSize: number | undefined;
/** Undefined = backup count trimming disabled. */
let _maxBackups: number | undefined;
/** Undefined = old-log cleanup disabled. */
let _retentionDays: number | undefined;
const _buffer: Array<Record<string, unknown>> = [];
let _flushTimer: ReturnType<typeof setInterval> | null = null;
let _testLogPathOverride: string | null = null;
/** Cached absolute path per shard (host, sessionId) — entries group by it. */
const _logFilePaths = new Map<string, string>();
/** The process's first sessioned entry's id — set once, never overwritten. */
let _primarySessionId: string | null = null;
/** Set once per process after the first `log()` call before `initLogger`. */
let _warnedUseBeforeInit = false;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Check whether `ZOO_DEBUG` is set to a truthy value.
 *
 * Accepted values: `"1"`, `"true"`, `"yes"`.
 *
 * @returns `true` if debug-level entries should be emitted.
 */
function isDebugEnabled(): boolean {
  const val = process.env.ZOO_DEBUG;
  if (!val) return false;
  return (
    val === "1" || val.toLowerCase() === "true" || val.toLowerCase() === "yes"
  );
}

const LEVEL_ORDER: Record<string, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

/**
 * Determine whether a log entry at the given level should be emitted.
 *
 * When `ZOO_DEBUG` is truthy the minimum level is `"debug"` (all entries
 * pass); otherwise the minimum level is `"info"` (debug entries are
 * filtered out).
 *
 * @param level - The level of the candidate entry.
 * @returns `true` if the entry should be written.
 */
function shouldLog(level: string): boolean {
  const minLevel = isDebugEnabled() ? "debug" : "info";
  return (LEVEL_ORDER[level] ?? 0) >= (LEVEL_ORDER[minLevel] ?? 0);
}

/**
 * Resolve the log file path for a log entry.
 *
 * Entries with a non-empty session id land in
 * `<logDir>/<host>-<sessionId>.log`; sessionless entries land in the
 * primary session's file (see `flushBuffer` — they are only attributed
 * once a session exists, so this helper is never called for a sessionless
 * entry before then).  When a test override is set, that path is returned
 * instead.  The resolved path is cached per shard so repeated flushes
 * reuse the same file.
 *
 * The session id is sanitised before use: only its basename component is
 * kept, so a crafted id such as `../evil` cannot escape `_logDir`.  This
 * mirrors the Rust read side (`zutil::resolve_session_path`), which strips
 * directory components via `Path::file_name`.  Session ids are
 * framework-generated rather than attacker-controlled, so this is
 * defence-in-depth.
 *
 * @param sessionId - The session id attributed to the entry being written
 *   (never the empty string).
 * @returns The absolute log file path for the entry's shard.
 */
function resolveShardPath(sessionId: string): string {
  if (_testLogPathOverride) return _testLogPathOverride;
  const cached = _logFilePaths.get(sessionId);
  if (cached) return cached;
  const filePath = join(_logDir, `${_host}-${basename(sessionId)}.log`);
  _logFilePaths.set(sessionId, filePath);
  return filePath;
}

/**
 * Ensure the given directory exists, creating it recursively if needed.
 *
 * All errors are silently swallowed.
 *
 * @param dir - Directory path to ensure exists.
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

/**
 * Rotate the current log file.
 *
 * Behaviour depends on `_maxBackups`:
 *   - `undefined` → simple rotation (rename current → `.1`, no limit).
 *   - `<= 0` → delete current file (rotation disabled).
 *   - `> 0` → cascade shift (`.n-1` → `.n` for `n = maxBackups`) and
 *     delete the oldest backup (`.maxBackups`).
 *
 * All errors are silently swallowed.
 *
 * @param filePath - The current log file path.
 */
function rotateLogFile(filePath: string): void {
  try {
    // _maxBackups undefined: simple rotation without cascade or limit.
    if (_maxBackups === undefined) {
      const backupPath = `${filePath}.1`;
      if (existsSync(backupPath)) {
        unlinkSync(backupPath);
      }
      if (existsSync(filePath)) {
        renameSync(filePath, backupPath);
      }
      return;
    }

    // When backups are disabled, simply delete the current file
    if (_maxBackups <= 0) {
      if (existsSync(filePath)) {
        unlinkSync(filePath);
      }
      return;
    }

    // Delete the oldest backup
    const oldest = `${filePath}.${_maxBackups}`;
    if (existsSync(oldest)) {
      unlinkSync(oldest);
    }

    // Shift each backup: .n-1 → .n for n = maxBackups down to 1
    for (let i = _maxBackups - 1; i >= 1; i--) {
      const src = `${filePath}.${i}`;
      const dst = `${filePath}.${i + 1}`;
      if (existsSync(src)) {
        renameSync(src, dst);
      }
    }

    // Rename current → .1
    if (existsSync(filePath)) {
      renameSync(filePath, `${filePath}.1`);
    }
  } catch {
    // Silently swallow
  }
}

/**
 * Flush the in-memory buffer to disk.
 *
 * Buffered entries are serialised as JSON Lines and appended to their
 * per-shard log files synchronously.  Partitioning: an entry with a
 * non-empty session id goes to its own `<host>-<sessionId>.log` shard; a
 * sessionless entry is attributed to the primary session's file when one
 * has been established, and otherwise REMAINS in the buffer (never written
 * to a host-level file, never dropped) until attribution becomes possible.
 * After the write, the file size is checked and rotation triggered if the
 * file exceeds `_maxFileSize` (only when `_maxFileSize` is configured).
 *
 * All I/O errors are silently swallowed so a logging failure never
 * interrupts the main flow.
 */
function flushBuffer(): void {
  if (_buffer.length === 0) return;

  const entries = _buffer.splice(0, _buffer.length);
  const linesByPath = new Map<string, string[]>();
  for (const entry of entries) {
    const sessionId = String(entry.sessionId ?? "");
    // Sessionless entries are attributed to the primary session when one
    // exists; otherwise they stay buffered until the process's session
    // identity materialises.  They are never written to a `<host>.log`
    // host-level file.
    const shardSessionId = sessionId === "" ? _primarySessionId : sessionId;
    if (shardSessionId === null) {
      _buffer.push(entry);
      continue;
    }
    const path = resolveShardPath(shardSessionId);
    const lines = linesByPath.get(path);
    if (lines) {
      lines.push(JSON.stringify(entry));
    } else {
      linesByPath.set(path, [JSON.stringify(entry)]);
    }
  }

  ensureDir(_logDir);

  for (const [filePath, lines] of linesByPath) {
    try {
      appendFileSync(filePath, `${lines.join("\n")}\n`, "utf-8");

      // Check if rotation is needed
      if (_maxFileSize !== undefined) {
        try {
          const size = statSync(filePath).size;
          if (size >= _maxFileSize) {
            rotateLogFile(filePath);
          }
        } catch {
          // stat may fail if the file was deleted between write and stat
        }
      }
    } catch {
      // Silently swallow all I/O errors
    }
  }
}

/**
 * Delete log files older than `_retentionDays`.
 *
 * Scans `_logDir` for files matching `<host>.log` / `<host>-<sessionId>.log`
 * (with `.N` backup suffixes) for any host (opencode or pi) and removes
 * those whose mtime exceeds the retention threshold.  The broad pattern
 * also covers legacy host-level files already on disk from earlier
 * versions — new host-level files are never created (see `flushBuffer`).
 * When `_retentionDays` is `undefined` the cleanup is skipped.
 *
 * All errors are silently swallowed.
 */
function cleanupOldLogs(): void {
  if (_retentionDays === undefined) return;

  try {
    const dir = _logDir;
    if (!existsSync(dir)) return;

    const now = Date.now();
    const maxAge = _retentionDays * 24 * 60 * 60 * 1000;
    const files = readdirSync(dir);

    const logPattern = /^(opencode|pi)(-.*)?\.log(\.\d+)?$/;
    for (const file of files) {
      if (!logPattern.test(file)) continue;

      const filePath = join(dir, file);
      try {
        const mtime = statSync(filePath).mtimeMs;
        if (now - mtime > maxAge) {
          unlinkSync(filePath);
        }
      } catch {
        // Skip files that cannot be stat'd or deleted
      }
    }
  } catch {
    // Silently swallow
  }
}

/**
 * Start the periodic flush timer if it is not already running.
 *
 * The timer fires every 500ms and is `unref`'d so it does not prevent the
 * process from exiting.
 */
function startFlushTimer(): void {
  if (_flushTimer) return;
  const timer = setInterval(flushBuffer, 500);
  // Do not keep the process alive just for the timer
  if (
    timer &&
    typeof timer === "object" &&
    "unref" in timer &&
    typeof timer.unref === "function"
  ) {
    timer.unref();
  }
  _flushTimer = timer;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Initialise the logger once per process with the host name and optional
 * configuration.
 *
 * One-shot process init: the host is a process-level constant — there is no
 * second initialisation step and no per-session state.  The log-file shard
 * is derived from each entry's session id; sessionless entries are
 * attributed to the process's first session (see `log`).  Sets up the log
 * directory, cleans old log files, and starts the flush timer.
 *
 * When a config field is omitted the corresponding behaviour is skipped
 * (no file rotation, no backup trimming, no old-log cleanup).
 *
 * @param host - The host name (e.g. `"opencode"`, `"pi"`).
 * @param opts - Optional overrides for log directory, file size, backups,
 *   and retention.
 */
export function initLogger(host: string, opts?: Partial<LoggerOptions>): void {
  _host = host;
  // Drop cached shard paths from a previous init so a re-init with a
  // different logDir/host cannot write to stale files.
  _logFilePaths.clear();
  // Reset the primary-session attribution from a previous init so a
  // re-init cannot retroactively attribute new sessionless entries to the
  // prior host's session.  Safe in production: init precedes the first
  // sessioned entry, so a fresh primary session is re-established on the
  // first sessioned log of the new host.
  _primarySessionId = null;

  if (opts?.logDir) {
    _logDir = resolve(opts.logDir.replace(/^~/, homedir()));
  }
  if (opts?.maxFileSize !== undefined) {
    _maxFileSize = opts.maxFileSize;
  }
  if (opts?.maxBackups !== undefined) {
    _maxBackups = opts.maxBackups;
  }
  if (opts?.retentionDays !== undefined) {
    _retentionDays = opts.retentionDays;
  }

  ensureDir(_logDir);
  cleanupOldLogs();
  startFlushTimer();
}

/**
 * Write a structured log entry.
 *
 * The entry is buffered in memory and flushed to disk when either the
 * buffer reaches 50 entries or after 500ms (whichever comes first).  Each
 * entry carries the host (fixed at `initLogger` time) and its own session
 * id, which picks the log-file shard it lands in.  The first entry with a
 * non-empty session id establishes the process's primary session: every
 * buffered and subsequent sessionless entry is attributed to that session's
 * file.  Before any session exists, sessionless entries remain buffered and
 * are dropped at process exit if no session ever materialises.
 *
 * @param hook - The hook module name (e.g. `"task-prompt-validate"`).
 * @param event - The event name (e.g. `"reminder_injected"`).
 * @param sessionId - The current session identifier.
 * @param callId - Optional call identifier tied to the current tool
 *   execution, written as a fixed JSON field when present.
 * @param level - Log level: `"debug"`, `"info"`, `"warn"`, or `"error"`.
 *   Defaults to `"debug"`.
 * @param extra - Optional additional fields merged into the JSON line.
 */
export function log(
  hook: string,
  event: string,
  sessionId: string,
  callId?: string,
  level?: string,
  extra?: Record<string, unknown>,
): void {
  const lvl = level ?? "debug";
  if (!shouldLog(lvl)) return;

  // The host is fixed at `initLogger` time.  When `log` runs before
  // `initLogger` the host is still the empty string, so the entry would
  // land in an oddly-named shard (`-<sessionId>.log`).  Emit a one-time
  // stderr warning so the mis-use is loud instead of silently corrupting
  // shard names, then keep logging — a missing init must never interrupt
  // the main flow.
  if (_host === "") {
    if (!_warnedUseBeforeInit) {
      _warnedUseBeforeInit = true;
      process.stderr.write(
        "[zookeeper] logger used before initLogger — entries will land in " +
          "oddly-named shard files (-<sessionId>.log)\n",
      );
    }
  }

  // The first sessioned entry establishes the process's primary session.
  // Zero wiring for either host: the OpenCode `config` hook and pi's
  // load-time events emit `plugin_init` with an empty session id, so the
  // primary session is instead established by the first sessioned
  // hook-unit log in a turn (e.g. a task-prompt validate or a
  // tool_result).  Load-time sessionless entries flush into that first
  // session's file.
  if (sessionId !== "" && _primarySessionId === null) {
    _primarySessionId = sessionId;
  }

  // Build the entry: fixed fields come first so the JSON key order
  // is deterministic.  Extra fields whose keys collide with fixed
  // fields are dropped — fixed fields always take precedence.
  const entry: Record<string, unknown> = {
    timestamp: new Date().toISOString(),
    level: lvl,
    host: _host,
    hook,
    sessionId,
    event,
  };
  if (callId !== undefined) {
    entry.callId = callId;
  }
  if (extra) {
    const reserved = new Set([
      "timestamp",
      "level",
      "host",
      "hook",
      "sessionId",
      "event",
      "callId",
    ]);
    for (const [k, v] of Object.entries(extra)) {
      if (!reserved.has(k)) entry[k] = v;
    }
  }

  _buffer.push(entry);

  // Flush synchronously when the buffer is full to bound memory usage.
  if (_buffer.length >= 50) {
    flushBuffer();
  }
}

// ---------------------------------------------------------------------------
// Testing seams
// ---------------------------------------------------------------------------

/**
 * Return a shallow copy of the current in-memory buffer for test assertions.
 *
 * @returns A snapshot of the buffered log entries.
 */
export function _getBufferForTesting(): Array<Record<string, unknown>> {
  return [..._buffer];
}

/**
 * Override the log file path for testing.
 *
 * When set, `flushBuffer()` writes to this path instead of the configured
 * log directory, regardless of the entry's shard.
 *
 * @param path - The full file path to write log entries to.
 */
export function _setLogPathForTesting(path: string): void {
  _testLogPathOverride = path;
}

/**
 * Force a synchronous flush of the buffer.
 *
 * Useful in tests to ensure all buffered entries are written before
 * asserting file contents.
 */
export function _flushForTesting(): void {
  flushBuffer();
}

/**
 * Reset all module-level state to defaults.
 *
 * Call in `beforeEach` / `afterEach` to prevent cross-test pollution.
 */
export function _resetForTesting(): void {
  _buffer.length = 0;
  _host = "";
  _logDir = DEFAULT_LOG_DIR;
  _maxFileSize = undefined;
  _maxBackups = undefined;
  _retentionDays = undefined;
  if (_flushTimer) {
    clearInterval(_flushTimer);
    _flushTimer = null;
  }
  _testLogPathOverride = null;
  _logFilePaths.clear();
  _primarySessionId = null;
  _warnedUseBeforeInit = false;
}
