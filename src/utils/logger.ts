/**
 * JSON Lines file logger for ZooKeeper OpenCode plugin.
 *
 * Writes structured log entries to `~/.zoo/log/opencode-<sessionID>.log` in
 * JSON Lines format with buffered writes (50-entry cap) and a 500ms flush
 * timer.  Supports file rotation, old-log cleanup, and level-based filtering.
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
import { join, resolve } from "node:path";

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

let _sessionId = "";
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
let _logFilePath: string | null = null;

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
 * Resolve the current log file path.
 *
 * When a test override is set, that path is returned instead of the
 * configured directory + session-ID-based filename.
 *
 * @returns The absolute log file path.
 */
function getLogFilePath(): string {
  if (_testLogPathOverride) return _testLogPathOverride;
  if (_logFilePath) return _logFilePath;
  const sid =
    _sessionId || new Date().toISOString().replace(/[:.]/g, "").slice(0, 15);
  _logFilePath = join(_logDir, `opencode-${sid}.log`);
  return _logFilePath;
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
 * All buffered entries are serialised as JSON Lines and appended to the log
 * file synchronously.  After the write, the file size is checked and
 * rotation triggered if the file exceeds `_maxFileSize` (only when
 * `_maxFileSize` is configured).
 *
 * All I/O errors are silently swallowed so a logging failure never
 * interrupts the main flow.
 */
function flushBuffer(): void {
  if (_buffer.length === 0) return;
  // Only flush after sessionId is known.
  if (!_sessionId && !_testLogPathOverride) return;

  const entries = _buffer.splice(0, _buffer.length);
  const filePath = getLogFilePath();

  ensureDir(_logDir);

  try {
    const lines = `${entries.map((e) => JSON.stringify(e)).join("\n")}\n`;
    appendFileSync(filePath, lines, "utf-8");

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

/**
 * Delete log files older than `_retentionDays`.
 *
 * Scans `_logDir` for files matching `opencode-*.log*` or
 * `opencode-*.log.*` and removes those whose mtime exceeds the retention
 * threshold.  When `_retentionDays` is `undefined` the cleanup is skipped.
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

    const logPattern = /^opencode-.+\.log(\.\d+)?$/;
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
 * Initialise the logger with a session ID and optional configuration.
 *
 * Must be called once before `log()`.  Sets up the log
 * directory, cleans old log files, and starts the flush timer.
 *
 * When a config field is omitted the corresponding behaviour is skipped
 * (no file rotation, no backup trimming, no old-log cleanup).  A
 * `maxFileSize` value of 0 or negative is treated as if it were
 * `undefined` (rotation disabled).
 *
 * @param sessionId - The session identifier for the current run.
 * @param opts - Optional overrides for log directory, file size, backups,
 *   and retention.
 */
export function initLogger(
  sessionId: string,
  opts?: Partial<LoggerOptions>,
): void {
  _sessionId = sessionId;

  if (opts?.logDir) {
    _logDir = resolve(opts.logDir.replace(/^~/, homedir()));
  }
  if (opts?.maxFileSize !== undefined) {
    _maxFileSize = opts.maxFileSize <= 0 ? undefined : opts.maxFileSize;
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
 * Update the session ID after initialisation.
 *
 * Phase 2 calls this from the config hook once the real session ID is
 * available, so subsequent log entries carry the correct session token.
 *
 * @param sid - The new session identifier.
 */
export function setSessionId(sid: string): void {
  _sessionId = sid;
  // Flush any pre-sessionId entries that were buffered while waiting.
  flushBuffer();
}

/**
 * Write a structured log entry.
 *
 * The entry is buffered in memory and flushed to disk when either the
 * buffer reaches 50 entries or after 500ms (whichever comes first).
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

  // Build the entry: fixed fields come first so the JSON key order
  // is deterministic.  Extra fields whose keys collide with fixed
  // fields are dropped — fixed fields always take precedence.
  const entry: Record<string, unknown> = {
    timestamp: new Date().toISOString(),
    level: lvl,
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
 * log directory.
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
  _sessionId = "";
  _logDir = DEFAULT_LOG_DIR;
  _maxFileSize = undefined;
  _maxBackups = undefined;
  _retentionDays = undefined;
  if (_flushTimer) {
    clearInterval(_flushTimer);
    _flushTimer = null;
  }
  _testLogPathOverride = null;
  _logFilePath = null;
}
