/**
 * Tests for the process-level subagent run registry (`registry.ts`).
 *
 * The registry is the single source of truth for subagent run state across
 * every session in the pi process.  It owns the run lifecycle
 * (`startRun` → `updateRun` → `finishRun`), the terminal-immutability rule
 * (a finished run is never overwritten), the parent/child association via
 * session ids, the per-main-session queries (`topLevelRuns` / `childrenOf`
 * / `summary`), and the stateless scrolling-window slice (`windowRuns`)
 * that feeds the expanded fleet widget.
 *
 * This suite locks those behaviours with independent literal expectations.
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  childrenOf,
  finishRun,
  getRun,
  type RunStatus,
  resetRegistry,
  type SubagentRun,
  startRun,
  subscribeRunChange,
  summary,
  topLevelRuns,
  updateRun,
  windowRuns,
} from "./registry.js";
import { createRunLog } from "./run-log.js";

// bun shares one isolate across every test file, so the module-level
// registry state is process-global — reset it between tests to keep every
// assertion deterministic.
afterEach(() => {
  resetRegistry();
});

// ---------------------------------------------------------------------------
// startRun / updateRun / finishRun basics
// ---------------------------------------------------------------------------

describe("registry — run lifecycle", () => {
  it("startRun creates a running entry scoped to its parent session", () => {
    startRun({
      id: "r1",
      agent: "lynx",
      parentSession: "main",
      startedAt: 100,
    });
    const run = getRun("r1");
    assert.ok(run, "expected the run to exist");
    assert.equal(run?.status, "running");
    assert.equal(run?.parentSession, "main");
    assert.equal(run?.agent, "lynx");
    assert.equal(run?.startedAt, 100);
    assert.equal(run?.endedAt, undefined);
  });

  it("updateRun patches the progress fields of a running run", () => {
    startRun({
      id: "r1",
      agent: "lynx",
      parentSession: "main",
      startedAt: 100,
    });
    updateRun("r1", {
      currentTool: "bash",
      tokens: 1200,
      model: "dummy-small",
    });
    const run = getRun("r1");
    assert.equal(run?.currentTool, "bash");
    assert.equal(run?.tokens, 1200);
    assert.equal(run?.model, "dummy-small");
  });

  it("updateRun clears the current tool on an explicit null patch", () => {
    startRun({
      id: "r1",
      agent: "lynx",
      parentSession: "main",
      startedAt: 100,
    });
    updateRun("r1", { currentTool: "bash" });
    assert.equal(getRun("r1")?.currentTool, "bash");
    // An absent field means "unchanged" — it must never clear the tool.
    updateRun("r1", { tokens: 10 });
    assert.equal(getRun("r1")?.currentTool, "bash");
    // Null is the explicit clear, distinguishable from the absent field.
    updateRun("r1", { currentTool: null });
    assert.equal(getRun("r1")?.currentTool, undefined);
    assert.equal(
      "currentTool" in (getRun("r1") as object),
      false,
      "a cleared tool must leave no stale key on the run",
    );
    // The other fields of the same patch still apply.
    assert.equal(getRun("r1")?.tokens, 10);
  });

  it("updateRun records the session path on a running run (enter-inspect while running)", () => {
    startRun({
      id: "r1",
      agent: "lynx",
      parentSession: "main",
      startedAt: 100,
    });
    updateRun("r1", { sessionPath: "/tmp/child-ses-1.jsonl" });
    const run = getRun("r1");
    assert.equal(run?.status, "running", "the run must stay non-terminal");
    assert.equal(
      run?.sessionPath,
      "/tmp/child-ses-1.jsonl",
      "sessionPath must be visible before the run finishes",
    );
  });

  it("finishRun marks the run done with endedAt and the session path", () => {
    startRun({
      id: "r1",
      agent: "lynx",
      parentSession: "main",
      startedAt: 100,
    });
    finishRun("r1", {
      status: "done",
      sessionPath: "/tmp/s.jsonl",
    });
    const run = getRun("r1");
    assert.equal(run?.status, "done");
    assert.equal(run?.sessionPath, "/tmp/s.jsonl");
    assert.ok(
      run?.endedAt !== undefined && run.endedAt >= 100,
      "endedAt must be set and not precede startedAt",
    );
  });

  it("finishRun records the error message on an error outcome", () => {
    startRun({
      id: "r1",
      agent: "spider",
      parentSession: "main",
      startedAt: 100,
    });
    finishRun("r1", { status: "error", error: "exit 1" });
    const run = getRun("r1");
    assert.equal(run?.status, "error");
    assert.equal(run?.error, "exit 1");
    assert.ok(run?.endedAt !== undefined);
  });

  it("startRun records childSession and sessionPath pointers", () => {
    startRun({
      id: "r1",
      agent: "lynx",
      parentSession: "main",
      startedAt: 100,
      childSession: "child-ses-1",
      sessionPath: "/tmp/child-ses-1.jsonl",
    });
    const run = getRun("r1");
    assert.equal(run?.childSession, "child-ses-1");
    assert.equal(run?.sessionPath, "/tmp/child-ses-1.jsonl");
  });

  it("finishRun records childSession and sessionPath pointers", () => {
    startRun({
      id: "r1",
      agent: "lynx",
      parentSession: "main",
      startedAt: 100,
    });
    finishRun("r1", {
      status: "done",
      childSession: "child-ses-1",
      sessionPath: "/tmp/child-ses-1.jsonl",
    });
    const run = getRun("r1");
    assert.equal(run?.childSession, "child-ses-1");
    assert.equal(run?.sessionPath, "/tmp/child-ses-1.jsonl");
  });

  it("finishRun cannot change childSession/sessionPath of a finished run", () => {
    startRun({
      id: "r1",
      agent: "lynx",
      parentSession: "main",
      startedAt: 100,
    });
    finishRun("r1", {
      status: "done",
      childSession: "child-a",
      sessionPath: "/tmp/a.jsonl",
    });
    finishRun("r1", {
      status: "done",
      childSession: "child-b",
      sessionPath: "/tmp/b.jsonl",
    });
    const run = getRun("r1");
    assert.equal(run?.childSession, "child-a", "childSession must be frozen");
    assert.equal(
      run?.sessionPath,
      "/tmp/a.jsonl",
      "sessionPath must be frozen",
    );
  });

  it("startRun never clobbers an existing entry (ids are unique)", () => {
    startRun({
      id: "r1",
      agent: "lynx",
      parentSession: "main",
      startedAt: 100,
    });
    startRun({
      id: "r1",
      agent: "spider",
      parentSession: "other",
      startedAt: 900,
    });
    const run = getRun("r1");
    assert.equal(run?.agent, "lynx", "the first startRun must win");
    assert.equal(run?.parentSession, "main");
  });
});

// ---------------------------------------------------------------------------
// Terminal immutability
// ---------------------------------------------------------------------------

describe("registry — terminal immutability", () => {
  it("updateRun is ignored after the run finishes", () => {
    startRun({
      id: "r1",
      agent: "lynx",
      parentSession: "main",
      startedAt: 100,
    });
    finishRun("r1", { status: "done" });
    updateRun("r1", { currentTool: "bash", tokens: 999 });
    const run = getRun("r1");
    assert.equal(run?.status, "done");
    assert.equal(
      run?.currentTool,
      undefined,
      "progress must not change post-done",
    );
    assert.equal(run?.tokens, undefined, "tokens must not change post-done");
  });

  it("finishRun cannot change the status, endedAt, or error of a finished run", () => {
    startRun({
      id: "r1",
      agent: "lynx",
      parentSession: "main",
      startedAt: 100,
    });
    finishRun("r1", { status: "done", sessionPath: "/tmp/a.jsonl" });
    const firstEnd = getRun("r1")?.endedAt;
    finishRun("r1", { status: "error", error: "overwritten?" });
    const run = getRun("r1");
    assert.equal(run?.status, "done", "a second finishRun must be ignored");
    assert.equal(run?.error, undefined);
    assert.equal(run?.endedAt, firstEnd, "endedAt must be frozen");
    assert.equal(run?.sessionPath, "/tmp/a.jsonl");
  });

  it("a done run cannot be finished again as aborted", () => {
    startRun({
      id: "r1",
      agent: "lynx",
      parentSession: "main",
      startedAt: 100,
    });
    finishRun("r1", { status: "done" });
    finishRun("r1", { status: "aborted" });
    assert.equal(getRun("r1")?.status, "done");
  });

  it("an error run cannot be finished again as done", () => {
    startRun({
      id: "r1",
      agent: "lynx",
      parentSession: "main",
      startedAt: 100,
    });
    finishRun("r1", { status: "error", error: "boom" });
    finishRun("r1", { status: "done" });
    const run = getRun("r1");
    assert.equal(run?.status, "error");
    assert.equal(run?.error, "boom");
  });

  it("updateRun and finishRun on unknown ids are silent no-ops", () => {
    updateRun("ghost", { currentTool: "bash" });
    finishRun("ghost", { status: "done" });
    assert.equal(getRun("ghost"), undefined);
  });

  it("entries are never deleted — a finished run survives later operations", () => {
    startRun({
      id: "r1",
      agent: "lynx",
      parentSession: "main",
      startedAt: 100,
    });
    finishRun("r1", { status: "done" });
    startRun({
      id: "r2",
      agent: "spider",
      parentSession: "main",
      startedAt: 200,
    });
    finishRun("r2", { status: "done" });
    assert.equal(topLevelRuns("main").length, 2);
  });
});

// ---------------------------------------------------------------------------
// Parent / child association via session ids
// ---------------------------------------------------------------------------

describe("registry — parent/child association", () => {
  it("childrenOf returns the runs whose parentSession is the parent's child session", () => {
    startRun({
      id: "p1",
      agent: "beaver",
      parentSession: "main",
      startedAt: 100,
    });
    updateRun("p1", { childSession: "child-ses-1" });
    startRun({
      id: "c1",
      agent: "lynx",
      parentSession: "child-ses-1",
      startedAt: 200,
    });
    startRun({
      id: "c2",
      agent: "spider",
      parentSession: "child-ses-1",
      startedAt: 300,
    });
    // A sibling top-level run under the same main session is NOT a child.
    startRun({
      id: "s1",
      agent: "spider",
      parentSession: "main",
      startedAt: 400,
    });

    const children = childrenOf("p1");
    assert.deepEqual(
      children.map((c) => c.id),
      ["c1", "c2"],
      "children must be sorted by startedAt and only attach to the child session",
    );
    assert.deepEqual(childrenOf("c1"), [], "a leaf run has no children");
  });

  it("childrenOf is empty when the parent never recorded a child session", () => {
    startRun({
      id: "p1",
      agent: "beaver",
      parentSession: "main",
      startedAt: 100,
    });
    startRun({
      id: "c1",
      agent: "lynx",
      parentSession: "not-the-child-session",
      startedAt: 200,
    });
    assert.deepEqual(childrenOf("p1"), []);
  });

  it("topLevelRuns returns only the runs whose parentSession is the main session", () => {
    startRun({
      id: "p1",
      agent: "beaver",
      parentSession: "main",
      startedAt: 100,
    });
    updateRun("p1", { childSession: "child-ses-1" });
    startRun({
      id: "c1",
      agent: "lynx",
      parentSession: "child-ses-1",
      startedAt: 200,
    });
    startRun({
      id: "s1",
      agent: "spider",
      parentSession: "main",
      startedAt: 300,
    });

    const top = topLevelRuns("main");
    assert.deepEqual(
      top.map((r) => r.id),
      ["p1", "s1"],
      "nested child runs must be excluded from the top-level list",
    );
  });

  it("topLevelRuns sorts by startedAt ascending with a deterministic tiebreak", () => {
    startRun({ id: "z", agent: "lynx", parentSession: "main", startedAt: 300 });
    startRun({
      id: "a",
      agent: "spider",
      parentSession: "main",
      startedAt: 100,
    });
    startRun({ id: "m", agent: "lynx", parentSession: "main", startedAt: 200 });
    assert.deepEqual(
      topLevelRuns("main").map((r) => r.id),
      ["a", "m", "z"],
    );
  });

  it("topLevelRuns is isolated per main session", () => {
    startRun({
      id: "a1",
      agent: "lynx",
      parentSession: "main-a",
      startedAt: 100,
    });
    startRun({
      id: "b1",
      agent: "spider",
      parentSession: "main-b",
      startedAt: 200,
    });
    assert.deepEqual(
      topLevelRuns("main-a").map((r) => r.id),
      ["a1"],
    );
    assert.deepEqual(
      topLevelRuns("main-b").map((r) => r.id),
      ["b1"],
    );
    assert.deepEqual(topLevelRuns("main-c"), []);
  });
});

// ---------------------------------------------------------------------------
// summary
// ---------------------------------------------------------------------------

describe("registry — summary counts", () => {
  it("counts running / done / failed where failed includes error and aborted", () => {
    startRun({
      id: "r1",
      agent: "lynx",
      parentSession: "main",
      startedAt: 100,
    });
    finishRun("r1", { status: "done" });
    startRun({
      id: "r2",
      agent: "spider",
      parentSession: "main",
      startedAt: 200,
    });
    finishRun("r2", { status: "error", error: "boom" });
    startRun({
      id: "r3",
      agent: "spider",
      parentSession: "main",
      startedAt: 300,
    });
    finishRun("r3", { status: "aborted" });
    startRun({
      id: "r4",
      agent: "lynx",
      parentSession: "main",
      startedAt: 400,
    });

    assert.deepEqual(summary("main"), { running: 1, done: 1, failed: 2 });
  });

  it("summaries with no activity are all zero", () => {
    assert.deepEqual(summary("main"), { running: 0, done: 0, failed: 0 });
  });

  it("summary counts are isolated per main session", () => {
    startRun({
      id: "a1",
      agent: "lynx",
      parentSession: "main-a",
      startedAt: 100,
    });
    finishRun("a1", { status: "error", error: "x" });
    startRun({
      id: "b1",
      agent: "spider",
      parentSession: "main-b",
      startedAt: 200,
    });
    assert.deepEqual(summary("main-a"), { running: 0, done: 0, failed: 1 });
    assert.deepEqual(summary("main-b"), { running: 1, done: 0, failed: 0 });
  });
});

// ---------------------------------------------------------------------------
// windowRuns
// ---------------------------------------------------------------------------

/** A minimal run fixture with a deterministic id / startedAt / status. */
function run(
  id: string,
  startedAt: number,
  status: RunStatus = "done",
): SubagentRun {
  // The fact log is part of a run's shape (each registry run owns one); the
  // fixture starts it empty since these tests only sort and window runs.
  return {
    id,
    agent: "lynx",
    parentSession: "main",
    status,
    startedAt,
    log: createRunLog(),
  };
}

/** A dense list of n runs with ids r0..r(n-1) and startedAt 0..n-1. */
function denseList(n: number): SubagentRun[] {
  return Array.from({ length: n }, (_v, i) => run(`r${i}`, i));
}

describe("registry — windowRuns", () => {
  it("aligns to the bottom when no run is selected", () => {
    const slice = windowRuns(denseList(10), undefined, 7);
    assert.deepEqual(
      slice.rows.map((r) => r.id),
      ["r3", "r4", "r5", "r6", "r7", "r8", "r9"],
    );
    assert.equal(slice.hiddenAbove, 3);
    assert.equal(slice.hiddenBelow, 0);
    assert.equal(slice.selectedIndex, -1);
  });

  it("keeps the selected run visible and anchored as the list grows", () => {
    const slice = windowRuns(denseList(10), "r2", 3);
    assert.deepEqual(
      slice.rows.map((r) => r.id),
      ["r2", "r3", "r4"],
    );
    assert.equal(slice.selectedIndex, 0);
    assert.equal(slice.hiddenAbove, 2);
    assert.equal(slice.hiddenBelow, 5);
  });

  it("clamps to the bottom when the selection sits in the bottom window", () => {
    const slice = windowRuns(denseList(10), "r9", 7);
    assert.deepEqual(
      slice.rows.map((r) => r.id),
      ["r3", "r4", "r5", "r6", "r7", "r8", "r9"],
    );
    assert.equal(slice.selectedIndex, 6);
    assert.equal(slice.hiddenAbove, 3);
    assert.equal(slice.hiddenBelow, 0);
  });

  it("shows every row when the selection fits with room below", () => {
    const slice = windowRuns(denseList(10), "r3", 7);
    assert.deepEqual(
      slice.rows.map((r) => r.id),
      ["r3", "r4", "r5", "r6", "r7", "r8", "r9"],
    );
    assert.equal(slice.selectedIndex, 0);
  });

  it("a stale selected id (not found) falls back to the bottom window", () => {
    const slice = windowRuns(denseList(10), "missing", 4);
    assert.deepEqual(
      slice.rows.map((r) => r.id),
      ["r6", "r7", "r8", "r9"],
    );
    assert.equal(slice.selectedIndex, -1);
    assert.equal(slice.hiddenAbove, 6);
  });

  it("shows all rows when the list fits within maxRows", () => {
    const slice = windowRuns(denseList(3), undefined, 7);
    assert.deepEqual(
      slice.rows.map((r) => r.id),
      ["r0", "r1", "r2"],
    );
    assert.equal(slice.hiddenAbove, 0);
    assert.equal(slice.hiddenBelow, 0);
    assert.equal(slice.selectedIndex, -1);
  });

  it("returns an empty window for an empty list", () => {
    const slice = windowRuns([], undefined, 7);
    assert.deepEqual(slice.rows, []);
    assert.equal(slice.hiddenAbove, 0);
    assert.equal(slice.hiddenBelow, 0);
    assert.equal(slice.selectedIndex, -1);
  });

  it("clamps a non-positive maxRows to a single row", () => {
    const slice = windowRuns(denseList(10), undefined, 0);
    assert.deepEqual(
      slice.rows.map((r) => r.id),
      ["r9"],
    );
    assert.equal(slice.hiddenAbove, 9);
    assert.equal(slice.hiddenBelow, 0);
  });

  it("does not mutate the input entries array", () => {
    const entries = denseList(10);
    const before = entries.map((r) => r.id);
    windowRuns(entries, "r5", 4);
    assert.deepEqual(
      entries.map((r) => r.id),
      before,
      "the input array must not be reordered",
    );
  });
});

describe("registry — run-change notification", () => {
  it("surfaces a fact append but never a streaming partial", () => {
    // The fleet widget refreshes on this one notification, so the streaming
    // path must not reach it: a token-by-token partial would repaint the
    // whole widget list per delta.
    let changes = 0;
    const off = subscribeRunChange(() => {
      changes += 1;
    });
    const run = startRun({ id: "r1", agent: "lynx", parentSession: "main" });
    const afterStart = changes;
    assert.ok(afterStart > 0, "registration itself is a change");
    run.log.setPartial([{ type: "text", text: "streaming text" }]);
    run.log.setPartial([{ type: "text", text: "streaming text and more" }]);
    run.log.setPartial([]);
    assert.equal(changes, afterStart, "partials must not churn the fleet");
    run.log.appendMessage([{ type: "text", text: "finalized" }]);
    assert.equal(changes, afterStart + 1, "appends still surface");
    // An append that retires a partial delivers two stream events; the
    // fact-only feed must still report exactly one change.
    run.log.setPartial([{ type: "text", text: "streaming again" }]);
    run.log.appendMessage([{ type: "text", text: "finalized again" }]);
    assert.equal(
      changes,
      afterStart + 2,
      "the mechanical retirement must not double-count as a change",
    );
    off();
  });
});
