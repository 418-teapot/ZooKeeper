/**
 * Tests for the JSON Lines file logger.
 *
 * Covers: buffering & flush mechanics, level filtering, JSON output format,
 * initLogger, setSessionId, file rotation, old-log cleanup, silent failure,
 * and all testing seams.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach } from "node:test";

import {
  initLogger,
  setSessionId,
  log,
  _getBufferForTesting,
  _setLogPathForTesting,
  _flushForTesting,
  _resetForTesting,
} from "./logger.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "zoo-logger-test-"));
}

function countLines(filePath: string): number {
  const content = fs.readFileSync(filePath, "utf-8");
  if (content.length === 0) return 0;
  return content.trimEnd().split("\n").length;
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe("logger", () => {
  let testDir: string;
  let origZooDebug: string | undefined;

  beforeEach(() => {
    _resetForTesting();
    testDir = tmpDir();
    origZooDebug = process.env.ZOO_DEBUG;
    delete process.env.ZOO_DEBUG;
  });

  afterEach(() => {
    if (origZooDebug !== undefined) {
      process.env.ZOO_DEBUG = origZooDebug;
    } else {
      delete process.env.ZOO_DEBUG;
    }
    _resetForTesting();
    try {
      fs.rmSync(testDir, { recursive: true, force: true });
    } catch {
      // Silently swallow cleanup errors
    }
  });

  // -----------------------------------------------------------------------
  // Testing seams
  // -----------------------------------------------------------------------

  describe("testing seams", () => {
    it("_resetForTesting resets all module state", () => {
      _setLogPathForTesting("/some/path");
      log("h", "e", "s", undefined, "info");
      assert.equal(_getBufferForTesting().length, 1);

      _resetForTesting();

      assert.equal(_getBufferForTesting().length, 0);
    });

    it("_setLogPathForTesting overrides the log file path", () => {
      const logPath = path.join(testDir, "custom.log");
      _setLogPathForTesting(logPath);
      log("h", "e", "s", undefined, "info");
      _flushForTesting();

      assert.ok(fs.existsSync(logPath));
    });

    it("_getBufferForTesting returns a snapshot of the buffer", () => {
      const logPath = path.join(testDir, "test.log");
      _setLogPathForTesting(logPath);

      log("h", "e", "s", undefined, "info");
      log("h", "e", "s", undefined, "info");

      const snapshot = _getBufferForTesting();
      assert.equal(snapshot.length, 2);

      _flushForTesting();
      assert.equal(_getBufferForTesting().length, 0);
      // Snapshot is a copy and not affected by flush
      assert.equal(snapshot.length, 2);
    });
  });

  // -----------------------------------------------------------------------
  // Buffer & Flush
  // -----------------------------------------------------------------------

  describe("Buffer & Flush", () => {
    it("does not write to file when buffer is under 50 entries", () => {
      const logPath = path.join(testDir, "test.log");
      _setLogPathForTesting(logPath);

      for (let i = 0; i < 49; i++) {
        log("h", "e", "s", undefined, "info");
      }

      assert.equal(fs.existsSync(logPath), false);
      assert.equal(_getBufferForTesting().length, 49);
    });

    it("auto-flushes when buffer reaches 50 entries", () => {
      const logPath = path.join(testDir, "test.log");
      _setLogPathForTesting(logPath);

      for (let i = 0; i < 50; i++) {
        log("h", "e", "s", undefined, "info");
      }

      assert.ok(fs.existsSync(logPath), "file should exist after auto-flush");
      assert.equal(_getBufferForTesting().length, 0);
      assert.equal(countLines(logPath), 50);
    });

    it("_flushForTesting forces flush of partial buffer", () => {
      const logPath = path.join(testDir, "test.log");
      _setLogPathForTesting(logPath);

      log("h", "e", "s", undefined, "info");
      log("h", "e", "s", undefined, "info");
      assert.equal(_getBufferForTesting().length, 2);
      assert.equal(fs.existsSync(logPath), false);

      _flushForTesting();

      assert.ok(fs.existsSync(logPath));
      assert.equal(_getBufferForTesting().length, 0);
      assert.equal(countLines(logPath), 2);
    });

    it("buffer accumulates entries between flushes", () => {
      const logPath = path.join(testDir, "test.log");
      _setLogPathForTesting(logPath);

      for (let i = 0; i < 25; i++) {
        log("h", "e", "s", undefined, "info");
      }
      assert.equal(_getBufferForTesting().length, 25);

      _flushForTesting();
      assert.equal(countLines(logPath), 25);

      for (let i = 0; i < 10; i++) {
        log("h", "e", "s", undefined, "info");
      }
      _flushForTesting();
      assert.equal(countLines(logPath), 35);
    });

    it("flushBuffer is a no-op when buffer is empty", () => {
      _flushForTesting();
      assert.equal(_getBufferForTesting().length, 0);
    });
  });

  // -----------------------------------------------------------------------
  // Level filtering
  // -----------------------------------------------------------------------

  describe("Level filtering", () => {
    it("filters out 'debug' by default (min level is 'info')", () => {
      const logPath = path.join(testDir, "test.log");
      _setLogPathForTesting(logPath);

      log("h", "e", "s", undefined, "debug");
      _flushForTesting();

      assert.equal(fs.existsSync(logPath), false);
      assert.equal(_getBufferForTesting().length, 0);
    });

    it("writes 'info' entries", () => {
      const logPath = path.join(testDir, "test.log");
      _setLogPathForTesting(logPath);

      log("h", "e", "s", undefined, "info");
      _flushForTesting();

      assert.ok(fs.existsSync(logPath));
    });

    it("writes 'warn' entries", () => {
      const logPath = path.join(testDir, "test.log");
      _setLogPathForTesting(logPath);

      log("h", "e", "s", undefined, "warn");
      _flushForTesting();

      assert.ok(fs.existsSync(logPath));
    });

    it("writes 'error' entries", () => {
      const logPath = path.join(testDir, "test.log");
      _setLogPathForTesting(logPath);

      log("h", "e", "s", undefined, "error");
      _flushForTesting();

      assert.ok(fs.existsSync(logPath));
    });

    it("default level is 'debug' (filtered out by default)", () => {
      const logPath = path.join(testDir, "test.log");
      _setLogPathForTesting(logPath);

      log("h", "e", "s");
      _flushForTesting();

      assert.equal(fs.existsSync(logPath), false);
    });

    it("allows 'debug' when ZOO_DEBUG=1", () => {
      const logPath = path.join(testDir, "test.log");
      _setLogPathForTesting(logPath);

      process.env.ZOO_DEBUG = "1";
      log("h", "e", "s", undefined, "debug");
      _flushForTesting();

      assert.ok(fs.existsSync(logPath));
    });

    it("allows 'debug' when ZOO_DEBUG=true", () => {
      const logPath = path.join(testDir, "test.log");
      _setLogPathForTesting(logPath);

      process.env.ZOO_DEBUG = "true";
      log("h", "e", "s", undefined, "debug");
      _flushForTesting();

      assert.ok(fs.existsSync(logPath));
    });

    it("allows 'debug' when ZOO_DEBUG=yes", () => {
      const logPath = path.join(testDir, "test.log");
      _setLogPathForTesting(logPath);

      process.env.ZOO_DEBUG = "yes";
      log("h", "e", "s", undefined, "debug");
      _flushForTesting();

      assert.ok(fs.existsSync(logPath));
    });

    it("writes only info/warn/error when mixing levels without ZOO_DEBUG", () => {
      const logPath = path.join(testDir, "test.log");
      _setLogPathForTesting(logPath);

      log("h", "e", "s", undefined, "debug");
      log("h", "e", "s", undefined, "info");
      log("h", "e", "s", undefined, "warn");
      log("h", "e", "s", undefined, "error");
      _flushForTesting();

      const lines = fs.readFileSync(logPath, "utf-8").trimEnd().split("\n");
      assert.equal(lines.length, 3);
      for (const line of lines) {
        const entry = JSON.parse(line);
        assert.notEqual(entry.level, "debug");
      }
    });
  });

  // -----------------------------------------------------------------------
  // JSON format
  // -----------------------------------------------------------------------

  describe("JSON format", () => {
    it("produces valid JSON for every line", () => {
      const logPath = path.join(testDir, "test.log");
      _setLogPathForTesting(logPath);

      for (let i = 0; i < 5; i++) {
        log("h", "e", "s", undefined, "info");
      }
      _flushForTesting();

      const lines = fs.readFileSync(logPath, "utf-8").trimEnd().split("\n");
      assert.equal(lines.length, 5);
      for (const line of lines) {
        const parsed = JSON.parse(line);
        assert.ok(parsed);
        assert.equal(typeof parsed.timestamp, "string");
        assert.equal(typeof parsed.level, "string");
        assert.equal(typeof parsed.hook, "string");
        assert.equal(typeof parsed.sessionId, "string");
        assert.equal(typeof parsed.event, "string");
      }
    });

    it("has fixed field order: timestamp -> level -> hook -> sessionId -> event", () => {
      const logPath = path.join(testDir, "test.log");
      _setLogPathForTesting(logPath);

      log("my-hook", "my-event", "sid-123", undefined, "info");
      _flushForTesting();

      const parsed = JSON.parse(fs.readFileSync(logPath, "utf-8").trim());
      const keys = Object.keys(parsed);
      assert.deepEqual(keys, [
        "timestamp",
        "level",
        "hook",
        "sessionId",
        "event",
      ]);
    });

    it("includes callId as the 6th field when provided", () => {
      const logPath = path.join(testDir, "test.log");
      _setLogPathForTesting(logPath);

      log("h", "e", "s", "call-456", "info");
      _flushForTesting();

      const parsed = JSON.parse(fs.readFileSync(logPath, "utf-8").trim());
      const keys = Object.keys(parsed);
      assert.deepEqual(keys, [
        "timestamp",
        "level",
        "hook",
        "sessionId",
        "event",
        "callId",
      ]);
      assert.equal(parsed.callId, "call-456");
    });

    it("omits callId when not provided", () => {
      const logPath = path.join(testDir, "test.log");
      _setLogPathForTesting(logPath);

      log("h", "e", "s", undefined, "info");
      _flushForTesting();

      const parsed = JSON.parse(fs.readFileSync(logPath, "utf-8").trim());
      assert.equal(parsed.callId, undefined);
    });

    it("appends extra fields at the end", () => {
      const logPath = path.join(testDir, "test.log");
      _setLogPathForTesting(logPath);

      log("h", "e", "s", undefined, "info", {
        myField: "myValue",
        num: 42,
      });
      _flushForTesting();

      const parsed = JSON.parse(fs.readFileSync(logPath, "utf-8").trim());
      const keys = Object.keys(parsed);
      assert.equal(keys[keys.length - 2], "myField");
      assert.equal(keys[keys.length - 1], "num");
      assert.equal(parsed.myField, "myValue");
      assert.equal(parsed.num, 42);
    });

    it("ignores extra fields that conflict with reserved fields", () => {
      const logPath = path.join(testDir, "test.log");
      _setLogPathForTesting(logPath);

      log("h", "e", "s", undefined, "warn", {
        level: "error",
        event: "override-event",
        custom: "ok",
      });
      _flushForTesting();

      const parsed = JSON.parse(fs.readFileSync(logPath, "utf-8").trim());
      // Reserved values take precedence
      assert.equal(parsed.level, "warn");
      assert.equal(parsed.event, "e");
      // Non-reserved extra is still present
      assert.equal(parsed.custom, "ok");
    });

    it("ignores all reserved extra fields (timestamp, hook, sessionId, callId)", () => {
      const logPath = path.join(testDir, "test.log");
      _setLogPathForTesting(logPath);

      log("real-hook", "real-event", "real-sid", "real-call", "info", {
        timestamp: "fake",
        hook: "fake-hook",
        sessionId: "fake-sid",
        callId: "fake-call",
      });
      _flushForTesting();

      const parsed = JSON.parse(fs.readFileSync(logPath, "utf-8").trim());
      assert.equal(parsed.timestamp.startsWith("20"), true);
      assert.equal(parsed.hook, "real-hook");
      assert.equal(parsed.sessionId, "real-sid");
      assert.equal(parsed.callId, "real-call");
    });

    it("timestamp is ISO 8601 UTC format (ends with Z)", () => {
      const logPath = path.join(testDir, "test.log");
      _setLogPathForTesting(logPath);

      log("h", "e", "s", undefined, "info");
      _flushForTesting();

      const parsed = JSON.parse(fs.readFileSync(logPath, "utf-8").trim());
      assert.match(
        parsed.timestamp,
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
      );
    });

    it("includes the correct level value in output", () => {
      const logPath = path.join(testDir, "test.log");
      _setLogPathForTesting(logPath);

      log("h", "e", "s", undefined, "warn");
      _flushForTesting();

      const parsed = JSON.parse(fs.readFileSync(logPath, "utf-8").trim());
      assert.equal(parsed.level, "warn");
    });

    it("includes the correct hook, event and sessionId values", () => {
      const logPath = path.join(testDir, "test.log");
      _setLogPathForTesting(logPath);

      log("focus-reminder", "reminder_injected", "session-abc", undefined, "info");
      _flushForTesting();

      const parsed = JSON.parse(fs.readFileSync(logPath, "utf-8").trim());
      assert.equal(parsed.hook, "focus-reminder");
      assert.equal(parsed.event, "reminder_injected");
      assert.equal(parsed.sessionId, "session-abc");
    });
  });

  // -----------------------------------------------------------------------
  // initLogger
  // -----------------------------------------------------------------------

  describe("initLogger", () => {
    it("creates the log directory", () => {
      const newDir = path.join(testDir, "sub", "logs");

      initLogger("test", { logDir: newDir });

      assert.ok(fs.existsSync(newDir));
    });

    it("does not error when the log directory already exists", () => {
      const existingDir = path.join(testDir, "existing");
      fs.mkdirSync(existingDir, { recursive: true });

      initLogger("test", { logDir: existingDir });

      assert.ok(fs.existsSync(existingDir));
    });

    it("expands ~ in logDir to the home directory", () => {
      const expanded = path.join(os.homedir(), ".zoo-test-tilde-expansion");
      try {
        initLogger("test", { logDir: "~/.zoo-test-tilde-expansion" });
        assert.ok(fs.existsSync(expanded));
      } finally {
        try {
          fs.rmSync(expanded, { recursive: true, force: true });
        } catch {
          // ignore
        }
      }
    });

    it("accepts empty sessionId without error", () => {
      initLogger("", { logDir: testDir });
      assert.ok(fs.existsSync(testDir));
    });

    it("sets defaults when opts are omitted", () => {
      initLogger("some-session");

      const logPath = path.join(testDir, "defaults.log");
      _setLogPathForTesting(logPath);
      log("h", "e", "s", undefined, "info");
      _flushForTesting();
      assert.ok(fs.existsSync(logPath));
    });
  });

  // -----------------------------------------------------------------------
  // setSessionId
  // -----------------------------------------------------------------------

  describe("setSessionId", () => {
    it("flushes backlogged entries when called without path override", () => {
      initLogger("", { logDir: testDir });

      log("h", "e", "pre-set", undefined, "info");
      log("h", "e", "pre-set", undefined, "info");
      log("h", "e", "pre-set", undefined, "info");

      setSessionId("real-session");

      const expectedFile = path.join(testDir, "opencode-real-session.log");
      assert.ok(
        fs.existsSync(expectedFile),
        "file should exist after setSessionId flushes buffer",
      );

      const lines = fs.readFileSync(expectedFile, "utf-8").trimEnd().split("\n");
      assert.equal(lines.length, 3);
      for (const line of lines) {
        const entry = JSON.parse(line);
        assert.equal(entry.sessionId, "pre-set");
      }
    });

    it("buffer is empty after setSessionId flushes", () => {
      initLogger("", { logDir: testDir });

      log("h", "e", "s", undefined, "info");
      setSessionId("sid");

      assert.equal(_getBufferForTesting().length, 0);
    });

    it("new log entries after setSessionId are written to the session file", () => {
      initLogger("", { logDir: testDir });
      setSessionId("real-session");

      log("h", "e", "post-set", undefined, "info");
      _flushForTesting();

      const expectedFile = path.join(testDir, "opencode-real-session.log");
      const lines = fs.readFileSync(expectedFile, "utf-8").trimEnd().split("\n");
      assert.equal(lines.length, 1);
      const entry = JSON.parse(lines[0]);
      assert.equal(entry.sessionId, "post-set");
    });
  });

  // -----------------------------------------------------------------------
  // File rotation
  // -----------------------------------------------------------------------

  describe("File rotation", () => {
    it("rotates log file when size exceeds maxFileSize", () => {
      const logPath = path.join(testDir, "test.log");

      _setLogPathForTesting(logPath);
      initLogger("test", { logDir: testDir, maxFileSize: 200, maxBackups: 2 });

      for (let i = 0; i < 3; i++) {
        log("h", "e", "s", undefined, "info");
      }
      _flushForTesting();

      assert.ok(
        fs.existsSync(logPath + ".1"),
        "backup .1 should exist after rotation",
      );
    });

    it("preserves previous backup when rotating again (cascade: .1 -> .2)", () => {
      const logPath = path.join(testDir, "test.log");

      _setLogPathForTesting(logPath);
      initLogger("test", { logDir: testDir, maxFileSize: 200, maxBackups: 2 });

      for (let i = 0; i < 3; i++) {
        log("h", "e", "s", undefined, "info");
      }
      _flushForTesting();
      assert.ok(fs.existsSync(logPath + ".1"));

      for (let i = 0; i < 3; i++) {
        log("h", "e", "s", undefined, "info");
      }
      _flushForTesting();

      assert.ok(fs.existsSync(logPath + ".1"));
      assert.ok(fs.existsSync(logPath + ".2"));
    });

    it("respects maxBackups limit (does not create .3 when maxBackups=2)", () => {
      const logPath = path.join(testDir, "test.log");

      _setLogPathForTesting(logPath);
      initLogger("test", { logDir: testDir, maxFileSize: 200, maxBackups: 2 });

      for (let batch = 0; batch < 3; batch++) {
        for (let i = 0; i < 3; i++) {
          log("h", "e", "s", undefined, "info");
        }
        _flushForTesting();
      }

      assert.ok(fs.existsSync(logPath + ".1"));
      assert.ok(fs.existsSync(logPath + ".2"));
      assert.equal(
        fs.existsSync(logPath + ".3"),
        false,
        ".3 should not exist with maxBackups=2",
      );
    });

    it("does not rotate when file size is under maxFileSize", () => {
      const logPath = path.join(testDir, "test.log");

      _setLogPathForTesting(logPath);
      initLogger("test", { logDir: testDir, maxFileSize: 10240, maxBackups: 2 });

      log("h", "e", "s", undefined, "info");
      _flushForTesting();

      assert.ok(fs.existsSync(logPath));
      assert.equal(
        fs.existsSync(logPath + ".1"),
        false,
        "no rotation should happen for small file",
      );
    });
  });

  // -----------------------------------------------------------------------
  // Cleanup
  // -----------------------------------------------------------------------

  describe("Cleanup", () => {
    it("removes old log files when retentionDays=0", () => {
      const logFile1 = path.join(testDir, "opencode-session-1.log");
      const logFile2 = path.join(testDir, "opencode-session-1.log.1");
      const nonLogFile = path.join(testDir, "other.txt");

      fs.writeFileSync(logFile1, '{"ts":"old"}\n');
      fs.writeFileSync(logFile2, '{"ts":"old"}\n');
      fs.writeFileSync(nonLogFile, "not a log file\n");

      const past = new Date("2020-01-01").getTime() / 1000;
      fs.utimesSync(logFile1, past, past);
      fs.utimesSync(logFile2, past, past);
      fs.utimesSync(nonLogFile, past, past);

      initLogger("test", { logDir: testDir, retentionDays: 0 });

      assert.equal(fs.existsSync(logFile1), false, "old log file should be deleted");
      assert.equal(fs.existsSync(logFile2), false, "old log backup should be deleted");
      assert.equal(fs.existsSync(nonLogFile), true, "non-log file should not be deleted");
    });

    it("retains recent log files within retention period", () => {
      const recentFile = path.join(testDir, "opencode-recent.log");
      fs.writeFileSync(recentFile, '{"ts":"recent"}\n');

      initLogger("test", { logDir: testDir, retentionDays: 30 });

      assert.ok(fs.existsSync(recentFile), "recent log file should be retained");
    });
  });

  // -----------------------------------------------------------------------
  // Silent failure
  // -----------------------------------------------------------------------

  describe("Silent failure", () => {
    it("log() does not throw when writing to a non-existent directory", () => {
      const badPath = path.join(testDir, "nonexistent-dir", "test.log");
      _setLogPathForTesting(badPath);

      log("h", "e", "s", undefined, "info");
      // Should not throw
      _flushForTesting();
      // No assertion needed beyond not throwing — the error is silently swallowed
      assert.equal(fs.existsSync(badPath), false);
    });

    it("log() does not throw when writing to a read-only file", () => {
      const logPath = path.join(testDir, "test.log");
      fs.writeFileSync(logPath, "");

      // Make the file read-only
      fs.chmodSync(logPath, 0o444);
      _setLogPathForTesting(logPath);
      log("h", "e", "s", undefined, "info");
      // Should not throw
      _flushForTesting();

      // Restore permissions so afterEach can clean up
      fs.chmodSync(logPath, 0o644);
    });

    it("_flushForTesting does not throw on I/O error", () => {
      const badPath = path.join("/", "nonexistent-dir", "test.log");
      _setLogPathForTesting(badPath);

      log("h", "e", "s", undefined, "info");
      _flushForTesting();
      // If we reach here, no exception was thrown
      assert.ok(true);
    });
  });
});
