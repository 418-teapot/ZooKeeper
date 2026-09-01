/**
 * Tests for the pi subagent-history scanner (`src/adapters/pi/subagent-scan.ts`).
 *
 * The scanner rebuilds the process-level run registry from the pi session
 * message history on session restore / resume (pi exits wipe the in-memory
 * registry, so the fleet widget would otherwise render empty).  It maps the
 * pi message shape returned by `sessionManager.buildContextEntries()` —
 * `toolCall` blocks in assistant messages paired with `toolResult` messages
 * by call id — onto `SubagentRun` entries scoped to the calling session.
 *
 * Covered here:
 * - completed / errored / interrupted (in-flight at pi exit) resolution
 * - agent / label / error-text extraction from tool args and results
 * - timestamp resolution with fallback when the history carries none
 * - idempotent re-scanning (the registry's terminal immutability is the
 *   guarantee — a duplicate call id never produces a second entry)
 * - `details` extraction: run-id preference and child/session pointer
 *   carriage, with ill-shaped `details` leaving them absent
 * - recursive nested rebuild: single-level and multi-level delegation
 *   chains reconstructed through sub-session files, with missing-file
 *   tolerance, cycle detection (a global visited set), and idempotence
 *   across re-scans
 */
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  childrenOf,
  finishRun,
  getRun,
  resetRegistry,
  startRun,
  topLevelRuns,
} from "../../core/subagent/registry.js";
import {
  _getBufferForTesting,
  _resetForTesting,
  initLogger,
} from "../../utils/logger.js";
import {
  extractSubagentRuns,
  type PiHistoryEntry,
  rebuildSubagentRuns,
} from "./subagent-scan.js";

let _tmpCounter = 0;
const _tmpDirs: string[] = [];

/** Create a fresh temp fixture directory tracked for cleanup. */
function makeFixtureDir(): string {
  const dir = join(
    tmpdir(),
    `zoo-subagent-scan-${Date.now()}-${_tmpCounter++}`,
  );
  mkdirSync(dir, { recursive: true });
  _tmpDirs.push(dir);
  return dir;
}

let _loggerDir: string;

beforeEach(() => {
  _resetForTesting();
  resetRegistry();
  _loggerDir = makeFixtureDir();
  initLogger("pi", { logDir: _loggerDir });
});

afterEach(() => {
  _resetForTesting();
  resetRegistry();
  for (const dir of _tmpDirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
});

/** Serialise a pi history entry list into a session jsonl file's lines. */
function sessionFileText(sessionId: string, entries: PiHistoryEntry[]): string {
  const header = {
    type: "session",
    version: 3,
    id: sessionId,
    timestamp: "2026-08-31T00:00:00.000Z",
    cwd: "/tmp",
  };
  const lines = [JSON.stringify(header)];
  for (const entry of entries) {
    lines.push(
      JSON.stringify({
        type: "message",
        id: "msg",
        parentId: null,
        timestamp: "2026-08-31T00:00:00.000Z",
        message: entry.message,
      }),
    );
  }
  return lines.join("\n");
}

/** Write a pi session jsonl file and return its absolute path. */
function writeSessionFile(
  dir: string,
  name: string,
  sessionId: string,
  entries: PiHistoryEntry[],
): string {
  const path = join(dir, name);
  writeFileSync(path, sessionFileText(sessionId, entries), "utf-8");
  return path;
}

/** A `details` payload as pi persists it on a subagent toolResult. */
function detailsPayload(
  runId: string,
  overrides: { childSession?: string; sessionPath?: string } = {},
): Record<string, unknown> {
  return {
    agent: "beaver",
    output: "ok",
    done: true,
    result: { kind: "ok", text: "ok" },
    runId,
    ...(overrides.childSession !== undefined
      ? { childSession: overrides.childSession }
      : {}),
    ...(overrides.sessionPath !== undefined
      ? { sessionPath: overrides.sessionPath }
      : {}),
  };
}

/** The warn entries emitted by the scanner in the logger buffer. */
function scanWarns(): Array<Record<string, unknown>> {
  return _getBufferForTesting().filter((e) => e.hook === "subagent-scan");
}

/** A pi assistant toolCall block. */
function toolCall(id: string, name: string, args: Record<string, unknown>) {
  return { type: "toolCall", id, name, arguments: args };
}

/** A pi assistant message entry carrying toolCall blocks. */
function assistantEntry(blocks: unknown[], timestamp?: number) {
  return {
    type: "message",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "delegating…" }, ...blocks],
      ...(timestamp !== undefined ? { timestamp } : {}),
    },
  } as PiHistoryEntry;
}

/** A pi toolResult message entry. */
function toolResultEntry(
  toolCallId: string,
  toolName: string,
  content: unknown[],
  overrides: { isError?: boolean; timestamp?: number; details?: unknown } = {},
) {
  return {
    type: "message",
    message: {
      role: "toolResult",
      toolCallId,
      toolName,
      content,
      isError: overrides.isError ?? false,
      ...(overrides.timestamp !== undefined
        ? { timestamp: overrides.timestamp }
        : {}),
      ...(overrides.details !== undefined
        ? { details: overrides.details }
        : {}),
    },
  } as PiHistoryEntry;
}

describe("extractSubagentRuns — scan pi history for subagent calls", () => {
  it("maps a completed subagent call to a done run with agent/label/times", () => {
    const runs = extractSubagentRuns(
      [
        assistantEntry(
          [
            toolCall("call-1", "subagent", {
              agent: "beaver",
              description: "实现任务",
              prompt: "do it",
            }),
          ],
          1000,
        ),
        toolResultEntry("call-1", "subagent", [{ type: "text", text: "done" }]),
      ],
      "sess-1",
    );

    assert.equal(runs.length, 1);
    const run = runs[0];
    assert.deepEqual(run, {
      id: "call-1",
      agent: "beaver",
      parentSession: "sess-1",
      status: "done",
      startedAt: 1000,
      endedAt: 1000,
      label: "实现任务",
    });
    assert.equal(run.error, undefined, "a done run carries no error");
  });

  it("maps an errored subagent call to an error run with the error text", () => {
    const runs = extractSubagentRuns(
      [
        assistantEntry(
          [toolCall("call-2", "subagent", { agent: "spider" })],
          200,
        ),
        toolResultEntry(
          "call-2",
          "subagent",
          [{ type: "text", text: "exploded: network down" }],
          { isError: true },
        ),
      ],
      "sess-1",
    );

    assert.equal(runs.length, 1);
    assert.equal(runs[0]?.status, "error");
    assert.equal(runs[0]?.error, "exploded: network down");
    assert.equal(runs[0]?.endedAt, 200);
  });

  it("maps an in-flight subagent call (no toolResult) to an aborted run", () => {
    const runs = extractSubagentRuns(
      [
        assistantEntry(
          [toolCall("call-3", "subagent", { agent: "lynx" })],
          300,
        ),
      ],
      "sess-1",
    );

    assert.equal(runs.length, 1);
    assert.equal(runs[0]?.status, "aborted");
    assert.equal(runs[0]?.startedAt, 300);
    assert.equal(
      runs[0]?.endedAt,
      300,
      "an interrupted run's endedAt falls back to its startedAt",
    );
    assert.equal(runs[0]?.error, undefined);
  });

  it("falls back to Date.now() for timestamps when the history carries none", () => {
    const before = Date.now();
    const runs = extractSubagentRuns(
      [
        assistantEntry([toolCall("call-4", "subagent", { agent: "mola" })]),
        toolResultEntry("call-4", "subagent", [{ type: "text", text: "ok" }]),
      ],
      "sess-1",
    );
    const after = Date.now();

    assert.equal(runs.length, 1);
    assert.ok(
      runs[0]?.startedAt !== undefined &&
        runs[0].startedAt >= before &&
        runs[0].startedAt <= after,
      "startedAt must fall back to the current time",
    );
    assert.equal(runs[0]?.endedAt, runs[0]?.startedAt);
  });

  it("ignores non-subagent tool calls and toolCall blocks without an id", () => {
    const runs = extractSubagentRuns(
      [
        assistantEntry([
          toolCall("call-5", "bash", { command: "ls" }),
          toolCall("call-6", "subagent", { agent: "eagle" }),
          { type: "toolCall", name: "subagent", arguments: { agent: "kiwi" } },
        ]),
        toolResultEntry("call-5", "bash", [{ type: "text", text: "ok" }]),
      ],
      "sess-1",
    );

    assert.equal(runs.length, 1);
    assert.equal(runs[0]?.id, "call-6");
    assert.equal(runs[0]?.agent, "eagle");
  });

  it("scopes all runs to the given parent session", () => {
    const runs = extractSubagentRuns(
      [
        assistantEntry([toolCall("call-7", "subagent", { agent: "beaver" })]),
        toolResultEntry("call-7", "subagent", [{ type: "text", text: "ok" }]),
      ],
      "sess-other",
    );
    assert.equal(runs[0]?.parentSession, "sess-other");
  });

  it("carries childSession/sessionPath from the result details", () => {
    const runs = extractSubagentRuns(
      [
        assistantEntry(
          [toolCall("call-8", "subagent", { agent: "beaver" })],
          100,
        ),
        toolResultEntry("call-8", "subagent", [{ type: "text", text: "ok" }], {
          details: detailsPayload("run-8", {
            childSession: "child-ses-8",
            sessionPath: "/tmp/child-ses-8.jsonl",
          }),
        }),
      ],
      "sess-1",
    );

    assert.equal(runs.length, 1);
    assert.equal(runs[0]?.childSession, "child-ses-8");
    assert.equal(runs[0]?.sessionPath, "/tmp/child-ses-8.jsonl");
    assert.equal(runs[0]?.status, "done");
  });

  it("prefers details.runId over the tool-call id", () => {
    const runs = extractSubagentRuns(
      [
        assistantEntry(
          [toolCall("call-9", "subagent", { agent: "lynx" })],
          200,
        ),
        toolResultEntry("call-9", "subagent", [{ type: "text", text: "ok" }], {
          details: detailsPayload("run-9"),
        }),
      ],
      "sess-1",
    );

    assert.equal(runs.length, 1);
    assert.equal(
      runs[0]?.id,
      "run-9",
      "the details run id must win over the call id",
    );
  });

  it("leaves the run id and session pointers absent when details is ill-shaped", () => {
    // `details` missing or non-object: the top-level run is still rebuilt
    // with the call id, and no session pointers are attached.
    for (const details of [undefined, "oops", 42, []]) {
      const runs = extractSubagentRuns(
        [
          assistantEntry([toolCall("call-10", "subagent", { agent: "mola" })]),
          toolResultEntry(
            "call-10",
            "subagent",
            [{ type: "text", text: "ok" }],
            { details },
          ),
        ],
        "sess-1",
      );
      assert.equal(runs.length, 1, `details=${String(details)}`);
      assert.equal(runs[0]?.id, "call-10");
      assert.equal(runs[0]?.childSession, undefined);
      assert.equal(runs[0]?.sessionPath, undefined);
    }
  });
});

describe("rebuildSubagentRuns — write scanned runs into the registry", () => {
  it("writes done and error runs into the registry for the session", () => {
    rebuildSubagentRuns(
      [
        assistantEntry([toolCall("r1", "subagent", { agent: "beaver" })], 10),
        toolResultEntry("r1", "subagent", [{ type: "text", text: "ok" }]),
        assistantEntry([toolCall("r2", "subagent", { agent: "spider" })], 20),
        toolResultEntry("r2", "subagent", [{ type: "text", text: "boom" }], {
          isError: true,
        }),
      ],
      "sess-1",
    );

    const runs = topLevelRuns("sess-1");
    assert.deepEqual(
      runs.map((r) => r.id),
      ["r1", "r2"],
    );
    assert.equal(runs[0]?.status, "done");
    assert.equal(runs[1]?.status, "error");
    assert.equal(runs[1]?.error, "boom");
  });

  it("writes interrupted runs as aborted with endedAt set", () => {
    rebuildSubagentRuns(
      [assistantEntry([toolCall("r1", "subagent", { agent: "lynx" })], 100)],
      "sess-1",
    );
    const run = getRun("r1");
    assert.equal(run?.status, "aborted");
    assert.equal(run?.endedAt, 100);
  });

  it("does not clobber an existing terminal entry on re-scan (idempotent)", () => {
    // A live run that finished in this process holds a terminal entry; a
    // later re-scan of the same history must leave it untouched.
    startRun({
      id: "r1",
      agent: "beaver",
      parentSession: "sess-1",
      startedAt: 10,
    });
    finishRun("r1", {
      status: "done",
      sessionPath: "/home/u/.pi/agent/sessions/x/s.jsonl",
    });
    const frozen = getRun("r1");

    rebuildSubagentRuns(
      [
        assistantEntry([toolCall("r1", "subagent", { agent: "beaver" })], 10),
        toolResultEntry("r1", "subagent", [{ type: "text", text: "ok" }]),
        // A second scan of the same history must not duplicate entries.
      ],
      "sess-1",
    );
    rebuildSubagentRuns(
      [
        assistantEntry([toolCall("r1", "subagent", { agent: "beaver" })], 10),
        toolResultEntry("r1", "subagent", [{ type: "text", text: "ok" }]),
      ],
      "sess-1",
    );

    const run = getRun("r1");
    assert.equal(run?.status, "done");
    assert.equal(run?.sessionPath, "/home/u/.pi/agent/sessions/x/s.jsonl");
    assert.equal(topLevelRuns("sess-1").length, 1, "no duplicate entries");
    assert.equal(run?.endedAt, frozen?.endedAt, "terminal fields stay frozen");
  });

  it("preserves an existing running entry when a scan reports it aborted", () => {
    // A run still live in this process must not be flipped to aborted by a
    // scan of stale history (the registry's terminal-immutability rule
    // silently ignores the finish).
    startRun({
      id: "r1",
      agent: "lynx",
      parentSession: "sess-1",
      startedAt: 10,
    });
    rebuildSubagentRuns(
      [assistantEntry([toolCall("r1", "subagent", { agent: "lynx" })], 10)],
      "sess-1",
    );
    assert.equal(getRun("r1")?.status, "running", "live run stays running");
  });
});

describe("rebuildSubagentRuns — recursive nested delegation rebuild", () => {
  it("rebuilds a single-level nested run (beaver → lynx)", () => {
    const root = makeFixtureDir();
    const sessionsRoot = join(root, "sessions", "cwd");
    mkdirSync(sessionsRoot, { recursive: true });

    // The nested sub-session file: beaver delegated to lynx inside it.
    const lynxPath = writeSessionFile(
      sessionsRoot,
      "child-ses-1.jsonl",
      "child-ses-1",
      [
        assistantEntry([toolCall("n1", "subagent", { agent: "lynx" })], 500),
        toolResultEntry("n1", "subagent", [{ type: "text", text: "ok" }], {
          details: detailsPayload("n1"),
        }),
      ],
    );

    // The main session: beaver run with details pointing at the child file.
    rebuildSubagentRuns(
      [
        assistantEntry([toolCall("p1", "subagent", { agent: "beaver" })], 100),
        toolResultEntry("p1", "subagent", [{ type: "text", text: "ok" }], {
          details: detailsPayload("run-p1", {
            childSession: "child-ses-1",
            sessionPath: lynxPath,
          }),
        }),
      ],
      "main",
      { sessionsRoot: join(root, "sessions") },
    );

    const parent = getRun("run-p1");
    assert.equal(parent?.status, "done");
    assert.equal(parent?.childSession, "child-ses-1");
    assert.equal(parent?.sessionPath, lynxPath);

    // The nested lynx run must be attached under the parent's child session.
    const child = getRun("n1");
    assert.equal(child?.status, "done");
    assert.equal(child?.agent, "lynx");
    assert.equal(child?.parentSession, "child-ses-1");
    assert.deepEqual(
      childrenOf("run-p1").map((c) => c.id),
      ["n1"],
    );
    // The nested run must NOT show up as a top-level run of the main session.
    assert.deepEqual(
      topLevelRuns("main").map((r) => r.id),
      ["run-p1"],
    );
  });

  it("locates the nested session file by childSession id when sessionPath is absent", () => {
    const root = makeFixtureDir();
    const sessionsRoot = join(root, "sessions");
    const cwdDir = join(sessionsRoot, "cwd");
    mkdirSync(cwdDir, { recursive: true });

    // The nested file carries a header id matching the parent's childSession.
    writeSessionFile(cwdDir, "child-ses-1.jsonl", "child-ses-1", [
      assistantEntry([toolCall("n1", "subagent", { agent: "lynx" })], 500),
      toolResultEntry("n1", "subagent", [{ type: "text", text: "ok" }], {
        details: detailsPayload("n1"),
      }),
    ]);

    // The parent run's details carry ONLY childSession (no sessionPath) —
    // the scanner must locate the file by scanning for the header id.
    rebuildSubagentRuns(
      [
        assistantEntry([toolCall("p1", "subagent", { agent: "beaver" })], 100),
        toolResultEntry("p1", "subagent", [{ type: "text", text: "ok" }], {
          details: detailsPayload("run-p1", {
            childSession: "child-ses-1",
          }),
        }),
      ],
      "main",
      { sessionsRoot },
    );

    const parent = getRun("run-p1");
    assert.equal(parent?.childSession, "child-ses-1");
    assert.equal(parent?.sessionPath, undefined);
    const child = getRun("n1");
    assert.equal(child?.status, "done");
    assert.equal(child?.parentSession, "child-ses-1");
    assert.deepEqual(
      childrenOf("run-p1").map((c) => c.id),
      ["n1"],
    );
  });

  it("sweeps the sessions root at most once across many pointer-less runs", () => {
    const root = makeFixtureDir();
    const sessionsRoot = join(root, "sessions");
    const cwdDir = join(sessionsRoot, "cwd");
    mkdirSync(cwdDir, { recursive: true });

    // Three distinct nested session files, each located by header id (their
    // parent runs carry no sessionPath).  A per-run linear scan would sweep
    // the root three times; the shared index must sweep it once.
    const childIds = ["child-a", "child-b", "child-c"];
    for (const id of childIds) {
      writeSessionFile(cwdDir, `${id}.jsonl`, id, [
        assistantEntry(
          [toolCall(`r-${id}`, "subagent", { agent: "lynx" })],
          500,
        ),
        toolResultEntry(`r-${id}`, "subagent", [{ type: "text", text: "ok" }], {
          details: detailsPayload(`run-${id}`),
        }),
      ]);
    }

    // A counting fs surface: every readdirSync over the sessions root tree is
    // recorded (one for the root, one per cwd dir).  The listing itself is
    // served from the real fixture, so the index resolves real paths; the
    // nested files are then read from disk by the scanner's own reader.
    let rootScans = 0;
    let dirScans = 0;
    const indexIO = {
      readdirSync: (dir: string): string[] => {
        if (dir === sessionsRoot) {
          rootScans += 1;
          return ["cwd"];
        }
        dirScans += 1;
        return childIds.map((id) => `${id}.jsonl`);
      },
      readFileSync: (path: string, _encoding: "utf-8"): string => {
        // The index only reads each file's header line to build the id map.
        const header =
          childIds.find((id) => path.endsWith(`/${id}.jsonl`)) ?? "";
        return JSON.stringify({
          type: "session",
          version: 3,
          id: header,
          timestamp: "2026-08-31T00:00:00.000Z",
          cwd: "/tmp",
        });
      },
    };

    // Three parent runs, each carrying only a childSession (no sessionPath),
    // so every nested branch resolves through the shared index.
    const history = childIds.flatMap((id, i) => [
      assistantEntry(
        [toolCall(`p${i}`, "subagent", { agent: "beaver" })],
        i * 100,
      ),
      toolResultEntry(`p${i}`, "subagent", [{ type: "text", text: "ok" }], {
        details: detailsPayload(`run-p${i}`, { childSession: id }),
      }),
    ]);
    rebuildSubagentRuns(history, "main", { sessionsRoot, indexIO });

    // All three nested branches rebuilt (behavior unchanged).
    for (const id of childIds) {
      assert.equal(getRun(`run-${id}`)?.status, "done", `${id} rebuilt`);
    }
    assert.equal(
      rootScans,
      1,
      `the sessions root must be swept exactly once (got ${rootScans})`,
    );
    assert.equal(
      dirScans,
      1,
      `the cwd dir must be read exactly once (got ${dirScans})`,
    );
  });

  it("rebuilds a two-level nested chain (beaver → lynx → spider)", () => {
    const root = makeFixtureDir();
    const sessionsRoot = join(root, "sessions");
    const cwdDir = join(sessionsRoot, "cwd");
    mkdirSync(cwdDir, { recursive: true });

    // Deepest sub-session: lynx delegated to spider.
    const spiderPath = writeSessionFile(
      cwdDir,
      "child-ses-2.jsonl",
      "child-ses-2",
      [
        assistantEntry([toolCall("g2", "subagent", { agent: "spider" })], 900),
        toolResultEntry("g2", "subagent", [{ type: "text", text: "ok" }], {
          details: detailsPayload("g2"),
        }),
      ],
    );

    // Middle sub-session: beaver delegated to lynx, which then delegated to
    // spider (lynx's file carries the deepest delegation).
    writeSessionFile(cwdDir, "child-ses-1.jsonl", "child-ses-1", [
      assistantEntry([toolCall("n1", "subagent", { agent: "lynx" })], 500),
      toolResultEntry("n1", "subagent", [{ type: "text", text: "ok" }], {
        details: detailsPayload("run-n1", {
          childSession: "child-ses-2",
          sessionPath: spiderPath,
        }),
      }),
    ]);

    // Main session: beaver delegated to lynx (details → middle file).
    rebuildSubagentRuns(
      [
        assistantEntry([toolCall("p1", "subagent", { agent: "beaver" })], 100),
        toolResultEntry("p1", "subagent", [{ type: "text", text: "ok" }], {
          details: detailsPayload("run-p1", {
            childSession: "child-ses-1",
            sessionPath: join(cwdDir, "child-ses-1.jsonl"),
          }),
        }),
      ],
      "main",
      { sessionsRoot },
    );

    const parent = getRun("run-p1");
    assert.equal(parent?.childSession, "child-ses-1");
    const middle = getRun("run-n1");
    assert.equal(middle?.status, "done");
    assert.equal(middle?.agent, "lynx");
    assert.equal(middle?.childSession, "child-ses-2");
    assert.equal(middle?.parentSession, "child-ses-1");
    const leaf = getRun("g2");
    assert.equal(leaf?.status, "done");
    assert.equal(leaf?.agent, "spider");
    assert.equal(leaf?.parentSession, "child-ses-2");

    assert.deepEqual(
      childrenOf("run-p1").map((c) => c.id),
      ["run-n1"],
    );
    assert.deepEqual(
      childrenOf("run-n1").map((c) => c.id),
      ["g2"],
    );
  });

  it("rebuilds the top-level run but skips the nested branch when details is missing", () => {
    // A completed subagent call without a details payload: the top-level
    // run is still rebuilt, but with no session pointer the nested scan
    // cannot descend (and must not crash).
    rebuildSubagentRuns(
      [
        assistantEntry([toolCall("p1", "subagent", { agent: "beaver" })], 100),
        toolResultEntry("p1", "subagent", [{ type: "text", text: "ok" }], {
          details: detailsPayload("run-p1"),
        }),
      ],
      "main",
      { sessionsRoot: join(makeFixtureDir(), "sessions") },
    );

    const run = getRun("run-p1");
    assert.equal(run?.status, "done");
    assert.equal(run?.childSession, undefined);
    assert.equal(run?.sessionPath, undefined);
    assert.equal(childrenOf("run-p1").length, 0);
  });

  it("tolerates a missing / unreadable sub-session file (warn, skip branch)", () => {
    const root = makeFixtureDir();
    const sessionsRoot = join(root, "sessions");
    mkdirSync(sessionsRoot, { recursive: true });

    rebuildSubagentRuns(
      [
        assistantEntry([toolCall("p1", "subagent", { agent: "beaver" })], 100),
        toolResultEntry("p1", "subagent", [{ type: "text", text: "ok" }], {
          details: detailsPayload("run-p1", {
            childSession: "child-ses-missing",
            sessionPath: join(sessionsRoot, "nonexistent.jsonl"),
          }),
        }),
      ],
      "main",
      { sessionsRoot },
    );

    // The parent run is still rebuilt; no nested runs were found.
    assert.equal(getRun("run-p1")?.status, "done");
    assert.equal(childrenOf("run-p1").length, 0);

    // A warn entry must be logged for the skipped branch.
    const warns = scanWarns().filter(
      (e) => e.event === "nested_session_unreadable",
    );
    assert.ok(warns.length >= 1, "expected a nested_session_unreadable warn");
    assert.equal(warns[0]?.runId, "run-p1");
  });

  it("detects a session cycle (A → B → A back-reference) and stops the branch", () => {
    const root = makeFixtureDir();
    const sessionsRoot = join(root, "sessions");
    mkdirSync(sessionsRoot, { recursive: true });

    // session-B's file points back at session-A — a corrupted
    // back-reference forming the cycle A → B → A.  Without cycle detection
    // this would recurse forever; the visited set must stop the second
    // visit with a warn.
    const aPath = join(sessionsRoot, "sess-a.jsonl");
    const bPath = writeSessionFile(sessionsRoot, "sess-b.jsonl", "sess-b", [
      assistantEntry([toolCall("rb", "subagent", { agent: "spider" })], 900),
      toolResultEntry("rb", "subagent", [{ type: "text", text: "ok" }], {
        details: detailsPayload("run-b", {
          childSession: "sess-a",
          sessionPath: aPath,
        }),
      }),
    ]);
    writeSessionFile(sessionsRoot, "sess-a.jsonl", "sess-a", [
      assistantEntry([toolCall("ra", "subagent", { agent: "lynx" })], 500),
      toolResultEntry("ra", "subagent", [{ type: "text", text: "ok" }], {
        details: detailsPayload("run-a", {
          childSession: "sess-b",
          sessionPath: bPath,
        }),
      }),
    ]);

    // Main session delegates into sess-a, which points back at sess-b.
    rebuildSubagentRuns(
      [
        assistantEntry([toolCall("p1", "subagent", { agent: "beaver" })], 100),
        toolResultEntry("p1", "subagent", [{ type: "text", text: "ok" }], {
          details: detailsPayload("run-p1", {
            childSession: "sess-a",
            sessionPath: aPath,
          }),
        }),
      ],
      "main",
      { sessionsRoot },
    );

    // The first visit to each file still rebuilt its runs.
    assert.equal(getRun("run-p1")?.status, "done");
    assert.equal(getRun("run-a")?.status, "done");
    assert.equal(getRun("run-b")?.status, "done", "level-2 run rebuilt");

    // A warn must mark the repeated session (the back-reference back to
    // sess-a inside sess-b), and the scan must have terminated (not hung).
    const cycleWarns = scanWarns().filter(
      (e) => e.event === "nested_session_cycle",
    );
    assert.ok(cycleWarns.length >= 1, "expected a nested_session_cycle warn");
    assert.equal(cycleWarns[0]?.childSession, "sess-a");
  });

  it("detects a direct self-loop from the main session (main → main)", () => {
    const root = makeFixtureDir();
    const sessionsRoot = join(root, "sessions");
    mkdirSync(sessionsRoot, { recursive: true });

    // The main session's own id is seeded into the visited set, so a run
    // whose nested pointer loops straight back to the main session id is
    // caught without recursing.
    const mainPath = join(sessionsRoot, "sess-main.jsonl");
    writeSessionFile(sessionsRoot, "sess-main.jsonl", "main", [
      assistantEntry([toolCall("rm", "subagent", { agent: "beaver" })], 900),
      toolResultEntry("rm", "subagent", [{ type: "text", text: "ok" }], {
        details: detailsPayload("run-m", {
          childSession: "main",
          sessionPath: mainPath,
        }),
      }),
    ]);

    rebuildSubagentRuns(
      [
        assistantEntry([toolCall("p1", "subagent", { agent: "beaver" })], 100),
        toolResultEntry("p1", "subagent", [{ type: "text", text: "ok" }], {
          details: detailsPayload("run-p1", {
            childSession: "main",
            sessionPath: mainPath,
          }),
        }),
      ],
      "main",
      { sessionsRoot },
    );

    assert.equal(getRun("run-p1")?.status, "done");
    // The repeated main-session branch is skipped — only the top-level
    // run exists.
    assert.equal(getRun("run-m"), undefined);
    const cycleWarns = scanWarns().filter(
      (e) => e.event === "nested_session_cycle",
    );
    assert.equal(cycleWarns.length, 1);
    assert.equal(cycleWarns[0]?.childSession, "main");
  });

  it("scans a deep acyclic chain with no depth limit (12 levels)", () => {
    const root = makeFixtureDir();
    const sessionsRoot = join(root, "sessions");
    mkdirSync(sessionsRoot, { recursive: true });

    // Build a chain of 12 sub-session files: level0 → level1 → … → level11.
    // Each level i's run points at level i+1's file; the deepest level's
    // run has no session pointer.  A former depth cap of 8 would have
    // stopped at level 7 — the cycle-guard rebuild must reach the leaf.
    const CHAIN_DEPTH = 12;
    const pathOf = (i: number) => join(sessionsRoot, `lvl${i}.jsonl`);
    const chainSession = (i: number) => `lvl${i}`;
    for (let i = 0; i < CHAIN_DEPTH; i++) {
      const sessionId = chainSession(i);
      const runId = `run-${sessionId}`;
      const pointer =
        i === CHAIN_DEPTH - 1
          ? detailsPayload(runId)
          : detailsPayload(runId, {
              childSession: chainSession(i + 1),
              sessionPath: pathOf(i + 1),
            });
      writeSessionFile(sessionsRoot, `${sessionId}.jsonl`, sessionId, [
        assistantEntry(
          [toolCall(`r${i}`, "subagent", { agent: "beaver" })],
          1000 + i,
        ),
        toolResultEntry(`r${i}`, "subagent", [{ type: "text", text: "ok" }], {
          details: pointer,
        }),
      ]);
    }

    // Main session delegates into level 0.
    rebuildSubagentRuns(
      [
        assistantEntry([toolCall("p1", "subagent", { agent: "beaver" })], 100),
        toolResultEntry("p1", "subagent", [{ type: "text", text: "ok" }], {
          details: detailsPayload("run-p1", {
            childSession: chainSession(0),
            sessionPath: pathOf(0),
          }),
        }),
      ],
      "main",
      { sessionsRoot },
    );

    assert.equal(getRun("run-p1")?.status, "done");
    // Every level of the chain must be rebuilt — no depth limit.
    for (let i = 0; i < CHAIN_DEPTH; i++) {
      const runId = `run-lvl${i}`;
      assert.equal(
        getRun(runId)?.status,
        "done",
        `chain level ${i} run rebuilt (no depth cap)`,
      );
    }
    // No cycle warns — the chain is acyclic.
    const cycleWarns = scanWarns().filter(
      (e) => e.event === "nested_session_cycle",
    );
    assert.equal(cycleWarns.length, 0);
  });

  it("re-scanning the same history is idempotent for nested runs", () => {
    const root = makeFixtureDir();
    const sessionsRoot = join(root, "sessions");
    mkdirSync(sessionsRoot, { recursive: true });

    const lynxPath = writeSessionFile(
      sessionsRoot,
      "child-ses-1.jsonl",
      "child-ses-1",
      [
        assistantEntry([toolCall("n1", "subagent", { agent: "lynx" })], 500),
        toolResultEntry("n1", "subagent", [{ type: "text", text: "ok" }], {
          details: detailsPayload("n1"),
        }),
      ],
    );
    const history = [
      assistantEntry([toolCall("p1", "subagent", { agent: "beaver" })], 100),
      toolResultEntry("p1", "subagent", [{ type: "text", text: "ok" }], {
        details: detailsPayload("run-p1", {
          childSession: "child-ses-1",
          sessionPath: lynxPath,
        }),
      }),
    ];

    rebuildSubagentRuns(history, "main", { sessionsRoot });
    const frozenParent = getRun("run-p1");
    const frozenChild = getRun("n1");
    rebuildSubagentRuns(history, "main", { sessionsRoot });
    rebuildSubagentRuns(history, "main", { sessionsRoot });

    assert.equal(topLevelRuns("main").length, 1, "no duplicate top runs");
    assert.equal(childrenOf("run-p1").length, 1, "no duplicate nested runs");
    assert.equal(getRun("run-p1")?.endedAt, frozenParent?.endedAt);
    assert.equal(getRun("n1")?.endedAt, frozenChild?.endedAt);
  });
});

/** A sample shape guard so the typed export stays honest. */
void ((): PiHistoryEntry => assistantEntry([]))();
