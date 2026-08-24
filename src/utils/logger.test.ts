/**
 * Tests for the JSON Lines file logger.
 *
 * Covers: buffering & flush mechanics, level filtering, JSON output format,
 * initLogger, per-entry host/session sharding, file rotation, old-log
 * cleanup, silent failure, and all testing seams.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import {
  _flushForTesting,
  _getBufferForTesting,
  _resetForTesting,
  _setLogPathForTesting,
  initLogger,
  log,
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
        assert.equal(typeof parsed.host, "string");
        assert.equal(typeof parsed.hook, "string");
        assert.equal(typeof parsed.sessionId, "string");
        assert.equal(typeof parsed.event, "string");
      }
    });

    it("has fixed field order: timestamp -> level -> host -> hook -> sessionId -> event", () => {
      const logPath = path.join(testDir, "test.log");
      _setLogPathForTesting(logPath);

      log("my-hook", "my-event", "sid-123", undefined, "info");
      _flushForTesting();

      const parsed = JSON.parse(fs.readFileSync(logPath, "utf-8").trim());
      const keys = Object.keys(parsed);
      assert.deepEqual(keys, [
        "timestamp",
        "level",
        "host",
        "hook",
        "sessionId",
        "event",
      ]);
    });

    it("includes callId as the 7th field when provided", () => {
      const logPath = path.join(testDir, "test.log");
      _setLogPathForTesting(logPath);

      log("h", "e", "s", "call-456", "info");
      _flushForTesting();

      const parsed = JSON.parse(fs.readFileSync(logPath, "utf-8").trim());
      const keys = Object.keys(parsed);
      assert.deepEqual(keys, [
        "timestamp",
        "level",
        "host",
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

    it("ignores all reserved extra fields (timestamp, level, host, hook, sessionId, callId)", () => {
      const logPath = path.join(testDir, "test.log");
      _setLogPathForTesting(logPath);

      log("real-hook", "real-event", "real-sid", "real-call", "info", {
        timestamp: "fake",
        level: "error",
        host: "fake-host",
        hook: "fake-hook",
        sessionId: "fake-sid",
        callId: "fake-call",
      });
      _flushForTesting();

      const parsed = JSON.parse(fs.readFileSync(logPath, "utf-8").trim());
      assert.equal(parsed.timestamp.startsWith("20"), true);
      assert.equal(parsed.level, "info");
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
  });

  // -----------------------------------------------------------------------
  // log() before initLogger
  // -----------------------------------------------------------------------

  describe("log() before initLogger", () => {
    it("emits a one-time stderr warning and still writes entries", () => {
      const logPath = path.join(testDir, "before-init.log");
      _setLogPathForTesting(logPath);

      const origWrite = process.stderr.write.bind(process.stderr);
      let warningCount = 0;
      process.stderr.write = ((chunk, ..._args) => {
        if (String(chunk).includes("logger used before initLogger")) {
          warningCount += 1;
        }
        return true;
      }) as typeof process.stderr.write;

      try {
        // Called before initLogger: `_host` is still "".
        log("h", "e", "s", undefined, "info");
        log("h", "e", "s", undefined, "info");
        _flushForTesting();

        assert.equal(
          warningCount,
          1,
          "the warning should fire exactly once per process",
        );
        assert.ok(
          fs.existsSync(logPath),
          "entries must still be written after the warning",
        );
        assert.equal(countLines(logPath), 2);
      } finally {
        process.stderr.write = origWrite;
      }
    });
  });

  // -----------------------------------------------------------------------
  // initLogger
  // -----------------------------------------------------------------------

  describe("initLogger", () => {
    it("creates the log directory", () => {
      const newDir = path.join(testDir, "sub", "logs");

      initLogger("opencode", { logDir: newDir });

      assert.ok(fs.existsSync(newDir));
    });

    it("does not error when the log directory already exists", () => {
      const existingDir = path.join(testDir, "existing");
      fs.mkdirSync(existingDir, { recursive: true });

      initLogger("pi", { logDir: existingDir });

      assert.ok(fs.existsSync(existingDir));
    });

    it("expands ~ in logDir to the home directory", () => {
      const expanded = path.join(os.homedir(), ".zoo-test-tilde-expansion");
      try {
        initLogger("opencode", { logDir: "~/.zoo-test-tilde-expansion" });
        assert.ok(fs.existsSync(expanded));
      } finally {
        try {
          fs.rmSync(expanded, { recursive: true, force: true });
        } catch {
          // ignore
        }
      }
    });

    it("accepts any host name without error", () => {
      initLogger("custom-host", { logDir: testDir });
      assert.ok(fs.existsSync(testDir));
    });

    it("re-init with a different logDir writes to the new directory and resets the primary session", () => {
      const dirA = path.join(testDir, "dirA");
      const dirB = path.join(testDir, "dirB");

      initLogger("opencode", { logDir: dirA });
      log("h", "e", "sess-1", undefined, "warn");
      _flushForTesting();
      assert.ok(
        fs.existsSync(path.join(dirA, "opencode-sess-1.log")),
        "first init must write to dirA",
      );

      // Re-init with a different log dir and host: the cached shard path
      // from the first init must be dropped AND the primary-session
      // attribution reset, otherwise the next sessionless entry would be
      // attributed to the stale "sess-1" primary instead of the new host.
      initLogger("pi", { logDir: dirB });
      // Post-re-init sessionless entry: with a stale primary session it
      // would land in dirB/pi-sess-1.log; after the reset it stays
      // buffered until the re-established primary session.
      log("config", "load_warn", "", undefined, "warn");
      log("h", "e", "sess-2", undefined, "warn");
      _flushForTesting();

      assert.ok(
        fs.existsSync(path.join(dirB, "pi-sess-2.log")),
        "re-init must write the new entry to dirB",
      );
      assert.equal(
        countLines(path.join(dirB, "pi-sess-2.log")),
        2,
        "the post-re-init sessionless entry must land in the re-established primary session's file",
      );
      assert.equal(
        fs.existsSync(path.join(dirB, "pi-sess-1.log")),
        false,
        "no stale attribution to the old primary session after re-init",
      );
      assert.equal(
        countLines(path.join(dirA, "opencode-sess-1.log")),
        1,
        "the stale dirA file must not receive the new entry",
      );
    });

    it("works when opts are omitted (no defaults, no rotation/cleanup)", () => {
      initLogger("opencode");

      const logPath = path.join(testDir, "defaults.log");
      _setLogPathForTesting(logPath);
      log("h", "e", "s", undefined, "info");
      _flushForTesting();
      assert.ok(fs.existsSync(logPath));
    });

    it("does not rotate when maxFileSize is undefined", () => {
      const logPath = path.join(testDir, "test.log");
      _setLogPathForTesting(logPath);
      initLogger("opencode", { logDir: testDir, maxBackups: 2 });

      // Write enough data that would trigger rotation if maxFileSize were set
      for (let i = 0; i < 10; i++) {
        log("h", "e", "s", undefined, "info");
      }
      _flushForTesting();

      assert.ok(fs.existsSync(logPath));
      assert.equal(
        fs.existsSync(`${logPath}.1`),
        false,
        "no rotation when maxFileSize is undefined",
      );
    });

    // No tests for zero/negative maxFileSize here: initLogger assigns the
    // value directly (no defensive clamp — the config-parse layer already
    // rejects non-positive values with a warn), so the low-level logger
    // only ever receives positive values.

    it("rotates with simple rename when maxBackups is undefined", () => {
      const logPath = path.join(testDir, "test.log");
      _setLogPathForTesting(logPath);
      // maxBackups omitted → simple rotation (current → .1)
      initLogger("opencode", { logDir: testDir, maxFileSize: 200 });

      for (let i = 0; i < 3; i++) {
        log("h", "e", "s", undefined, "info");
      }
      _flushForTesting();

      assert.ok(
        fs.existsSync(`${logPath}.1`),
        "backup .1 should exist after rotation",
      );
      assert.equal(
        fs.existsSync(`${logPath}.2`),
        false,
        ".2 should not exist without maxBackups cascade",
      );
    });

    it("does not cleanup old files when retentionDays is undefined", () => {
      const oldFile = path.join(testDir, "opencode-old.log");
      fs.writeFileSync(oldFile, '{"ts":"old"}\n');
      const past = new Date("2020-01-01").getTime() / 1000;
      fs.utimesSync(oldFile, past, past);

      // retentionDays omitted → no cleanup
      initLogger("opencode", { logDir: testDir });

      assert.ok(
        fs.existsSync(oldFile),
        "old file should not be deleted without retentionDays",
      );
    });
  });

  // -----------------------------------------------------------------------
  // Per-entry sharding
  // -----------------------------------------------------------------------

  describe("per-entry sharding", () => {
    it("writes entries with a session id to <host>-<sessionId>.log", () => {
      initLogger("opencode", { logDir: testDir });

      log("h", "e", "sess-1", undefined, "info");
      _flushForTesting();

      const expectedFile = path.join(testDir, "opencode-sess-1.log");
      assert.ok(fs.existsSync(expectedFile), "session shard file must exist");
      const lines = fs
        .readFileSync(expectedFile, "utf-8")
        .trimEnd()
        .split("\n");
      assert.equal(lines.length, 1);
      const entry = JSON.parse(lines[0]);
      assert.equal(entry.sessionId, "sess-1");
      assert.equal(entry.host, "opencode");
    });

    it("sessionless entries create NO file while no session exists", () => {
      initLogger("opencode", { logDir: testDir });

      log("config", "load_warn", "", undefined, "warn");
      _flushForTesting();

      // No session has materialised: the entry must stay buffered — never
      // written, never dropped — and no <host>.log may ever be created.
      assert.equal(
        fs.existsSync(path.join(testDir, "opencode.log")),
        false,
        "no host-level file may be created",
      );
      assert.equal(
        _getBufferForTesting().length,
        1,
        "the sessionless entry must remain buffered",
      );
    });

    it("pi-host entries land in pi-<sessionId>.log", () => {
      initLogger("pi", { logDir: testDir });

      log("plugin", "handler_crashed", "pi-sess", undefined, "error");
      _flushForTesting();

      const expectedFile = path.join(testDir, "pi-pi-sess.log");
      assert.ok(
        fs.existsSync(expectedFile),
        "pi session shard file must exist",
      );
      const lines = fs
        .readFileSync(expectedFile, "utf-8")
        .trimEnd()
        .split("\n");
      assert.equal(lines.length, 1);
      const entry = JSON.parse(lines[0]);
      assert.equal(entry.sessionId, "pi-sess");
      assert.equal(entry.host, "pi");
    });

    it("sessionless entries land in the primary session's file once it emerges", () => {
      initLogger("pi", { logDir: testDir });

      // Load-time sessionless entries (e.g. pi's plugin_init) buffered
      // before any session exists.
      log("config", "load_warn", "", undefined, "warn");
      log("config", "load_warn2", "", undefined, "warn");
      // The first sessioned entry establishes the primary session.
      log("plugin", "handler", "pi-sess", undefined, "info");
      _flushForTesting();

      const primaryFile = path.join(testDir, "pi-pi-sess.log");
      assert.ok(
        fs.existsSync(primaryFile),
        "primary session shard file must exist",
      );
      const lines = fs.readFileSync(primaryFile, "utf-8").trimEnd().split("\n");
      assert.equal(
        lines.length,
        3,
        "both sessionless backlog entries + the sessioned entry",
      );
      const entry = JSON.parse(lines[0]);
      assert.equal(entry.sessionId, "");
      assert.equal(entry.host, "pi");
      assert.equal(
        fs.existsSync(path.join(testDir, "pi.log")),
        false,
        "no host-level file may be created",
      );
    });

    it("a second session does NOT receive the sessionless backlog", () => {
      initLogger("opencode", { logDir: testDir });

      log("config", "load_warn", "", undefined, "warn");
      log("h", "e", "sess-a", undefined, "info"); // establishes primary
      log("h", "e", "sess-b", undefined, "info"); // second session
      _flushForTesting();

      const primaryFile = path.join(testDir, "opencode-sess-a.log");
      const secondFile = path.join(testDir, "opencode-sess-b.log");
      assert.ok(fs.existsSync(primaryFile), "primary shard must exist");
      assert.ok(fs.existsSync(secondFile), "second session shard must exist");
      assert.equal(
        countLines(primaryFile),
        2,
        "sessionless backlog + the sess-a entry",
      );
      assert.equal(
        countLines(secondFile),
        1,
        "only the sess-b entry, never the backlog",
      );
      assert.equal(
        fs.existsSync(path.join(testDir, "opencode.log")),
        false,
        "no host-level file may be created",
      );
    });

    it("groups entries of the same session in one file across flushes", () => {
      initLogger("opencode", { logDir: testDir });

      log("h", "e", "sess-1", undefined, "info");
      _flushForTesting();
      log("h", "e", "sess-1", undefined, "info");
      _flushForTesting();

      const expectedFile = path.join(testDir, "opencode-sess-1.log");
      assert.equal(countLines(expectedFile), 2);
    });

    it("splits entries across different session shards", () => {
      initLogger("opencode", { logDir: testDir });

      log("h", "e", "sess-a", undefined, "info");
      log("h", "e", "sess-b", undefined, "info");
      _flushForTesting();

      assert.equal(
        fs.existsSync(path.join(testDir, "opencode-sess-a.log")),
        true,
      );
      assert.equal(
        fs.existsSync(path.join(testDir, "opencode-sess-b.log")),
        true,
      );
      assert.equal(
        fs.existsSync(path.join(testDir, "opencode.log")),
        false,
        "no host-level file may be created",
      );
    });

    it("sessionless entries stay buffered (not dropped) until attribution is possible", () => {
      initLogger("opencode", { logDir: testDir });

      log("config", "early_warn", "", undefined, "warn");
      log("config", "early_warn2", "", undefined, "warn");
      assert.equal(_getBufferForTesting().length, 2);

      _flushForTesting();

      // No session ever materialises: the backlog remains in the buffer —
      // never written to a host-level file, never silently discarded while
      // the process lives (process-exit drop is the accepted semantic).
      assert.equal(_getBufferForTesting().length, 2);
      assert.equal(
        fs.existsSync(path.join(testDir, "opencode.log")),
        false,
        "no host-level file may be created",
      );
    });

    it("never creates a <host>.log file under any session mix", () => {
      initLogger("opencode", { logDir: testDir });

      log("config", "a", "", undefined, "warn");
      log("h", "e", "sess-x", undefined, "info");
      log("config", "b", "", undefined, "warn");
      log("h", "e", "sess-y", undefined, "info");
      _flushForTesting();

      const files = fs.readdirSync(testDir).filter((f) => f.endsWith(".log"));
      assert.ok(
        !files.some((f) => f === "opencode.log" || f === "pi.log"),
        `no host-level file may exist, got: ${files.join(", ")}`,
      );
    });

    it("sanitises a hostile session id so the shard stays inside the log dir", () => {
      initLogger("opencode", { logDir: testDir });

      // A crafted session id with directory components must not escape
      // _logDir: only the basename is used, mirroring the Rust read side
      // (zutil::resolve_session_path).
      log("h", "e", "../evil", undefined, "warn");
      _flushForTesting();

      const expectedFile = path.join(testDir, "opencode-evil.log");
      assert.ok(
        fs.existsSync(expectedFile),
        "the shard file must be the basename-suffixed file inside the log dir",
      );
      assert.equal(
        fs.existsSync(path.join(testDir, "..", "evil.log")),
        false,
        "no file may be written outside the log dir",
      );
      assert.equal(
        fs.existsSync(path.join(testDir, "opencode-..-evil.log")),
        false,
        "the literal id must not be used as the file name",
      );
      const files = fs.readdirSync(testDir).filter((f) => f.endsWith(".log"));
      assert.deepEqual(files, ["opencode-evil.log"]);
    });
  });

  // -----------------------------------------------------------------------
  // File rotation
  // -----------------------------------------------------------------------

  describe("File rotation", () => {
    it("rotates log file when size exceeds maxFileSize", () => {
      const logPath = path.join(testDir, "test.log");

      _setLogPathForTesting(logPath);
      initLogger("opencode", {
        logDir: testDir,
        maxFileSize: 200,
        maxBackups: 2,
      });

      for (let i = 0; i < 3; i++) {
        log("h", "e", "s", undefined, "info");
      }
      _flushForTesting();

      assert.ok(
        fs.existsSync(`${logPath}.1`),
        "backup .1 should exist after rotation",
      );
    });

    it("preserves previous backup when rotating again (cascade: .1 -> .2)", () => {
      const logPath = path.join(testDir, "test.log");

      _setLogPathForTesting(logPath);
      initLogger("opencode", {
        logDir: testDir,
        maxFileSize: 200,
        maxBackups: 2,
      });

      for (let i = 0; i < 3; i++) {
        log("h", "e", "s", undefined, "info");
      }
      _flushForTesting();
      assert.ok(fs.existsSync(`${logPath}.1`));

      for (let i = 0; i < 3; i++) {
        log("h", "e", "s", undefined, "info");
      }
      _flushForTesting();

      assert.ok(fs.existsSync(`${logPath}.1`));
      assert.ok(fs.existsSync(`${logPath}.2`));
    });

    it("respects maxBackups limit (does not create .3 when maxBackups=2)", () => {
      const logPath = path.join(testDir, "test.log");

      _setLogPathForTesting(logPath);
      initLogger("opencode", {
        logDir: testDir,
        maxFileSize: 200,
        maxBackups: 2,
      });

      for (let batch = 0; batch < 3; batch++) {
        for (let i = 0; i < 3; i++) {
          log("h", "e", "s", undefined, "info");
        }
        _flushForTesting();
      }

      assert.ok(fs.existsSync(`${logPath}.1`));
      assert.ok(fs.existsSync(`${logPath}.2`));
      assert.equal(
        fs.existsSync(`${logPath}.3`),
        false,
        ".3 should not exist with maxBackups=2",
      );
    });

    it("does not rotate when file size is under maxFileSize", () => {
      const logPath = path.join(testDir, "test.log");

      _setLogPathForTesting(logPath);
      initLogger("opencode", {
        logDir: testDir,
        maxFileSize: 10240,
        maxBackups: 2,
      });

      log("h", "e", "s", undefined, "info");
      _flushForTesting();

      assert.ok(fs.existsSync(logPath));
      assert.equal(
        fs.existsSync(`${logPath}.1`),
        false,
        "no rotation should happen for small file",
      );
    });

    it("deletes current file on rotation when maxBackups=0", () => {
      const logPath = path.join(testDir, "test.log");

      _setLogPathForTesting(logPath);
      initLogger("opencode", {
        logDir: testDir,
        maxFileSize: 200,
        maxBackups: 0,
      });

      for (let i = 0; i < 3; i++) {
        log("h", "e", "s", undefined, "info");
      }
      _flushForTesting();

      // The current file should be deleted (rotation with maxBackups=0)
      assert.equal(
        fs.existsSync(logPath),
        false,
        "current file should be deleted when maxBackups=0",
      );
      assert.equal(
        fs.existsSync(`${logPath}.1`),
        false,
        ".1 backup should not exist when maxBackups=0",
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
      const piLogFile = path.join(testDir, "pi-session-1.log");
      const piHostFile = path.join(testDir, "pi.log");
      const nonLogFile = path.join(testDir, "other.txt");

      fs.writeFileSync(logFile1, '{"ts":"old"}\n');
      fs.writeFileSync(logFile2, '{"ts":"old"}\n');
      fs.writeFileSync(piLogFile, '{"ts":"old"}\n');
      fs.writeFileSync(piHostFile, '{"ts":"old"}\n');
      fs.writeFileSync(nonLogFile, "not a log file\n");

      const past = new Date("2020-01-01").getTime() / 1000;
      fs.utimesSync(logFile1, past, past);
      fs.utimesSync(logFile2, past, past);
      fs.utimesSync(piLogFile, past, past);
      fs.utimesSync(piHostFile, past, past);
      fs.utimesSync(nonLogFile, past, past);

      initLogger("opencode", { logDir: testDir, retentionDays: 0 });

      assert.equal(
        fs.existsSync(logFile1),
        false,
        "old log file should be deleted",
      );
      assert.equal(
        fs.existsSync(logFile2),
        false,
        "old log backup should be deleted",
      );
      assert.equal(
        fs.existsSync(piLogFile),
        false,
        "old pi session log file should be deleted",
      );
      assert.equal(
        fs.existsSync(piHostFile),
        false,
        "old pi host-level log file should be deleted",
      );
      assert.equal(
        fs.existsSync(nonLogFile),
        true,
        "non-log file should not be deleted",
      );
    });

    it("retains recent log files within retention period", () => {
      const recentFile = path.join(testDir, "opencode-recent.log");
      fs.writeFileSync(recentFile, '{"ts":"recent"}\n');

      initLogger("opencode", { logDir: testDir, retentionDays: 30 });

      assert.ok(
        fs.existsSync(recentFile),
        "recent log file should be retained",
      );
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
