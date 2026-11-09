/**
 * Tests for the subagent run registry (`registry.ts`).
 *
 * A registry instance is the single source of truth for subagent run state
 * across every session of one process.  It owns the run lifecycle
 * (`start` → `update` → `finish`), the terminal-immutability rule (a
 * finished run is never overwritten), the parent/child association via
 * session ids, the per-main-session queries (`topLevel` / `childrenOf` /
 * `summary`), and the stateless scrolling-window slice (`windowRuns`) that
 * feeds the expanded fleet widget.
 *
 * This suite locks those behaviours with independent literal expectations,
 * each test starting from its own registry instance.
 */
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import {
  createRunRegistry,
  type RunRegistry,
  type RunSnapshot,
  type RunStatus,
  windowRuns,
} from "./registry.js";
import { createRunLog } from "./run-log.js";

// Every test owns its registry instance, so no test depends on what an
// earlier one wrote.
let runs: RunRegistry = createRunRegistry();

beforeEach(() => {
  runs = createRunRegistry();
});

// ---------------------------------------------------------------------------
// start / update / finish basics
// ---------------------------------------------------------------------------

describe("registry — run lifecycle", () => {
  it("start creates a running entry scoped to its parent session", () => {
    runs.start({
      id: "r1",
      agent: "lynx",
      parentSession: "main",
      startedAt: 100,
    });
    const run = runs.get("r1");
    assert.ok(run, "expected the run to exist");
    assert.equal(run?.status, "running");
    assert.equal(run?.parentSession, "main");
    assert.equal(run?.agent, "lynx");
    assert.equal(run?.startedAt, 100);
    assert.equal(run?.endedAt, undefined);
  });

  it("update patches the progress fields of a running run", () => {
    runs.start({
      id: "r1",
      agent: "lynx",
      parentSession: "main",
      startedAt: 100,
    });
    runs.update("r1", {
      currentTool: "bash",
      tokens: 1200,
      model: "dummy-small",
    });
    const run = runs.get("r1");
    assert.equal(run?.currentTool, "bash");
    assert.equal(run?.tokens, 1200);
    assert.equal(run?.model, "dummy-small");
  });

  it("update clears the current tool on an explicit null patch", () => {
    runs.start({
      id: "r1",
      agent: "lynx",
      parentSession: "main",
      startedAt: 100,
    });
    runs.update("r1", { currentTool: "bash" });
    assert.equal(runs.get("r1")?.currentTool, "bash");
    // An absent field means "unchanged" — it must never clear the tool.
    runs.update("r1", { tokens: 10 });
    assert.equal(runs.get("r1")?.currentTool, "bash");
    // Null is the explicit clear, distinguishable from the absent field.
    runs.update("r1", { currentTool: null });
    assert.equal(runs.get("r1")?.currentTool, undefined);
    assert.equal(
      "currentTool" in (runs.get("r1") as object),
      false,
      "a cleared tool must leave no stale key on the run",
    );
    // The other fields of the same patch still apply.
    assert.equal(runs.get("r1")?.tokens, 10);
  });

  it("update rewrites the label of a running run (later title evidence wins)", () => {
    runs.start({
      id: "r1",
      agent: "lynx",
      parentSession: "main",
      startedAt: 100,
      label: "a1b2c3d4",
    });
    runs.update("r1", { label: "迁移 tracker" });
    assert.equal(runs.get("r1")?.label, "迁移 tracker");
  });

  it("update records the session path on a running run (enter-inspect while running)", () => {
    runs.start({
      id: "r1",
      agent: "lynx",
      parentSession: "main",
      startedAt: 100,
    });
    runs.update("r1", { sessionPath: "/tmp/child-ses-1.jsonl" });
    const run = runs.get("r1");
    assert.equal(run?.status, "running", "the run must stay non-terminal");
    assert.equal(
      run?.sessionPath,
      "/tmp/child-ses-1.jsonl",
      "sessionPath must be visible before the run finishes",
    );
  });

  it("finish marks the run done with endedAt and the session path", () => {
    runs.start({
      id: "r1",
      agent: "lynx",
      parentSession: "main",
      startedAt: 100,
    });
    runs.finish("r1", {
      status: "done",
      sessionPath: "/tmp/s.jsonl",
    });
    const run = runs.get("r1");
    assert.equal(run?.status, "done");
    assert.equal(run?.sessionPath, "/tmp/s.jsonl");
    assert.ok(
      run?.endedAt !== undefined && run.endedAt >= 100,
      "endedAt must be set and not precede startedAt",
    );
  });

  it("finish records the error message on an error outcome", () => {
    runs.start({
      id: "r1",
      agent: "spider",
      parentSession: "main",
      startedAt: 100,
    });
    runs.finish("r1", { status: "error", error: "exit 1" });
    const run = runs.get("r1");
    assert.equal(run?.status, "error");
    assert.equal(run?.error, "exit 1");
    assert.ok(run?.endedAt !== undefined);
  });

  it("start records childSession and sessionPath pointers", () => {
    runs.start({
      id: "r1",
      agent: "lynx",
      parentSession: "main",
      startedAt: 100,
      childSession: "child-ses-1",
      sessionPath: "/tmp/child-ses-1.jsonl",
    });
    const run = runs.get("r1");
    assert.equal(run?.childSession, "child-ses-1");
    assert.equal(run?.sessionPath, "/tmp/child-ses-1.jsonl");
  });

  it("finish records childSession and sessionPath pointers", () => {
    runs.start({
      id: "r1",
      agent: "lynx",
      parentSession: "main",
      startedAt: 100,
    });
    runs.finish("r1", {
      status: "done",
      childSession: "child-ses-1",
      sessionPath: "/tmp/child-ses-1.jsonl",
    });
    const run = runs.get("r1");
    assert.equal(run?.childSession, "child-ses-1");
    assert.equal(run?.sessionPath, "/tmp/child-ses-1.jsonl");
  });

  it("finish releases the run's fact log; the terminal run keeps metadata only", () => {
    const run = runs.start({
      id: "r1",
      agent: "lynx",
      parentSession: "main",
      startedAt: 100,
    });
    run.log.appendToolStart("bash", { command: "ls -la" }, 101);
    run.log.appendMessage(
      [{ type: "text", text: "final answer" }],
      undefined,
      102,
    );
    runs.update("r1", {
      tokens: 4200,
      model: "dummy-small",
      childSession: "child-ses-9",
      sessionPath: "/tmp/child-ses-9.jsonl",
    });
    const liveLog = run.log;
    assert.equal(liveLog.size, 2, "precondition: the live log holds the facts");
    runs.finish("r1", { status: "done", endedAt: 300 });
    const finished = runs.get("r1");
    assert.ok(finished);
    assert.equal(
      finished.log.size,
      0,
      "the terminal run must not retain the run's facts",
    );
    assert.ok(
      finished.log !== liveLog,
      "the terminal run must hold a fresh empty log, not the released one",
    );
    // The released log object stays a valid frozen stream for any holder
    // (an open transcript overlay keeps what it already projected).
    assert.equal(
      liveLog.size,
      2,
      "the released log must still serve a consumer holding it",
    );
    assert.equal(
      liveLog.facts()[1]?.type,
      "message_end",
      "the released log's facts stay readable",
    );
    // Metadata survives on the terminal run.
    assert.equal(finished.status, "done");
    assert.equal(finished.agent, "lynx");
    assert.equal(finished.startedAt, 100);
    assert.equal(finished.endedAt, 300);
    assert.equal(finished.tokens, 4200);
    assert.equal(finished.model, "dummy-small");
    assert.equal(finished.childSession, "child-ses-9");
    assert.equal(finished.sessionPath, "/tmp/child-ses-9.jsonl");
  });

  it("finish cannot change childSession/sessionPath of a finished run", () => {
    runs.start({
      id: "r1",
      agent: "lynx",
      parentSession: "main",
      startedAt: 100,
    });
    runs.finish("r1", {
      status: "done",
      childSession: "child-a",
      sessionPath: "/tmp/a.jsonl",
    });
    runs.finish("r1", {
      status: "done",
      childSession: "child-b",
      sessionPath: "/tmp/b.jsonl",
    });
    const run = runs.get("r1");
    assert.equal(run?.childSession, "child-a", "childSession must be frozen");
    assert.equal(
      run?.sessionPath,
      "/tmp/a.jsonl",
      "sessionPath must be frozen",
    );
  });

  it("start never clobbers an existing entry (ids are unique)", () => {
    runs.start({
      id: "r1",
      agent: "lynx",
      parentSession: "main",
      startedAt: 100,
    });
    runs.start({
      id: "r1",
      agent: "spider",
      parentSession: "other",
      startedAt: 900,
    });
    const run = runs.get("r1");
    assert.equal(run?.agent, "lynx", "the first start must win");
    assert.equal(run?.parentSession, "main");
  });
});

// ---------------------------------------------------------------------------
// Terminal immutability
// ---------------------------------------------------------------------------

describe("registry — terminal immutability", () => {
  it("update is ignored after the run finishes", () => {
    runs.start({
      id: "r1",
      agent: "lynx",
      parentSession: "main",
      startedAt: 100,
    });
    runs.finish("r1", { status: "done" });
    runs.update("r1", { currentTool: "bash", tokens: 999 });
    const run = runs.get("r1");
    assert.equal(run?.status, "done");
    assert.equal(
      run?.currentTool,
      undefined,
      "progress must not change post-done",
    );
    assert.equal(run?.tokens, undefined, "tokens must not change post-done");
  });

  it("finish cannot change the status, endedAt, or error of a finished run", () => {
    runs.start({
      id: "r1",
      agent: "lynx",
      parentSession: "main",
      startedAt: 100,
    });
    runs.finish("r1", { status: "done", sessionPath: "/tmp/a.jsonl" });
    const firstEnd = runs.get("r1")?.endedAt;
    runs.finish("r1", { status: "error", error: "overwritten?" });
    const run = runs.get("r1");
    assert.equal(run?.status, "done", "a second finish must be ignored");
    assert.equal(run?.error, undefined);
    assert.equal(run?.endedAt, firstEnd, "endedAt must be frozen");
    assert.equal(run?.sessionPath, "/tmp/a.jsonl");
  });

  it("a done run cannot be finished again as aborted", () => {
    runs.start({
      id: "r1",
      agent: "lynx",
      parentSession: "main",
      startedAt: 100,
    });
    runs.finish("r1", { status: "done" });
    runs.finish("r1", { status: "aborted" });
    assert.equal(runs.get("r1")?.status, "done");
  });

  it("an error run cannot be finished again as done", () => {
    runs.start({
      id: "r1",
      agent: "lynx",
      parentSession: "main",
      startedAt: 100,
    });
    runs.finish("r1", { status: "error", error: "boom" });
    runs.finish("r1", { status: "done" });
    const run = runs.get("r1");
    assert.equal(run?.status, "error");
    assert.equal(run?.error, "boom");
  });

  it("the label is frozen once the run finishes", () => {
    runs.start({
      id: "r1",
      agent: "lynx",
      parentSession: "main",
      startedAt: 100,
      label: "初始标题",
    });
    runs.finish("r1", { status: "done" });
    runs.update("r1", { label: "迟到的标题" });
    assert.equal(runs.get("r1")?.label, "初始标题");
  });

  it("update and finish on unknown ids are silent no-ops", () => {
    runs.update("ghost", { currentTool: "bash" });
    runs.finish("ghost", { status: "done" });
    assert.equal(runs.get("ghost"), undefined);
  });

  it("entries are never deleted — a finished run survives later operations", () => {
    runs.start({
      id: "r1",
      agent: "lynx",
      parentSession: "main",
      startedAt: 100,
    });
    runs.finish("r1", { status: "done" });
    runs.start({
      id: "r2",
      agent: "spider",
      parentSession: "main",
      startedAt: 200,
    });
    runs.finish("r2", { status: "done" });
    assert.equal(runs.topLevel("main").length, 2);
  });
});

describe("registry — restoreRun", () => {
  it("restores a terminal run in one step and publishes one event", () => {
    const seen: Array<{ runId: string; parentSession: string }> = [];
    const off = runs.subscribe((change) => {
      seen.push(change);
    });
    const created = runs.restore({
      id: "r1",
      agent: "lynx",
      parentSession: "main",
      status: "done",
      label: "历史任务",
      startedAt: 100,
      endedAt: 200,
      childSession: "child-ses-1",
      sessionPath: "/tmp/child-ses-1.jsonl",
    });
    off();

    assert.equal(created, true);
    assert.deepEqual(
      seen,
      [{ runId: "r1", parentSession: "main" }],
      "the restore publishes exactly one change",
    );
    const run = runs.get("r1");
    assert.ok(run);
    assert.equal(run.status, "done");
    assert.equal(run.agent, "lynx");
    assert.equal(run.startedAt, 100);
    assert.equal(run.endedAt, 200);
    assert.equal(run.label, "历史任务");
    assert.equal(run.childSession, "child-ses-1");
    assert.equal(run.sessionPath, "/tmp/child-ses-1.jsonl");
    assert.equal(run.log.size, 0, "a restored run carries no facts");
  });

  it("keeps an existing run untouched and publishes nothing", () => {
    runs.start({
      id: "r1",
      agent: "lynx",
      parentSession: "main",
      startedAt: 1,
    });
    runs.update("r1", { tokens: 5 });
    let changes = 0;
    const off = runs.subscribe(() => {
      changes += 1;
    });
    const created = runs.restore({
      id: "r1",
      agent: "spider",
      parentSession: "main",
      status: "aborted",
      startedAt: 1,
      endedAt: 2,
    });
    off();

    assert.equal(created, false, "a duplicate restore creates nothing");
    assert.equal(changes, 0, "a duplicate restore publishes nothing");
    assert.equal(runs.get("r1")?.status, "running");
    assert.equal(runs.get("r1")?.agent, "lynx");
    assert.equal(runs.get("r1")?.tokens, 5);
  });

  it("defaults the started and ended times to now", () => {
    const before = Date.now();
    runs.restore({
      id: "r2",
      agent: "lynx",
      parentSession: "main",
      status: "error",
      error: "boom",
    });
    const after = Date.now();
    const run = runs.get("r2");
    assert.ok(run);
    assert.ok(run.startedAt >= before && run.startedAt <= after);
    assert.ok(run.endedAt !== undefined);
    assert.ok(run.endedAt >= before && run.endedAt <= after);
    assert.equal(run.error, "boom");
    assert.equal(run.label, undefined, "an omitted label stays absent");
    assert.equal(run.childSession, undefined);
  });

  it("creates a terminal run — later writes and finishes are ignored", () => {
    runs.restore({
      id: "r1",
      agent: "lynx",
      parentSession: "main",
      status: "done",
      startedAt: 1,
      endedAt: 2,
    });
    runs.update("r1", { tokens: 9 });
    runs.finish("r1", { status: "aborted" });
    const run = runs.get("r1");
    assert.equal(run?.status, "done");
    assert.equal(run?.tokens, undefined);
    assert.equal(run?.endedAt, 2);
  });

  it("publishes no event when a fact is appended to a restored run's log", () => {
    runs.restore({
      id: "r1",
      agent: "lynx",
      parentSession: "main",
      status: "done",
      startedAt: 1,
      endedAt: 2,
    });
    let changes = 0;
    const off = runs.subscribe(() => {
      changes += 1;
    });
    runs.get("r1")?.log.appendMessage([{ type: "text", text: "late" }]);
    off();
    assert.equal(changes, 0, "the terminal log is inert");
  });
});

// ---------------------------------------------------------------------------
// Parent / child association via session ids
// ---------------------------------------------------------------------------

describe("registry — parent/child association", () => {
  it("childrenOf returns the runs whose parentSession is the parent's child session", () => {
    runs.start({
      id: "p1",
      agent: "beaver",
      parentSession: "main",
      startedAt: 100,
    });
    runs.update("p1", { childSession: "child-ses-1" });
    runs.start({
      id: "c1",
      agent: "lynx",
      parentSession: "child-ses-1",
      startedAt: 200,
    });
    runs.start({
      id: "c2",
      agent: "spider",
      parentSession: "child-ses-1",
      startedAt: 300,
    });
    // A sibling top-level run under the same main session is NOT a child.
    runs.start({
      id: "s1",
      agent: "spider",
      parentSession: "main",
      startedAt: 400,
    });

    const children = runs.childrenOf("p1");
    assert.deepEqual(
      children.map((c) => c.id),
      ["c1", "c2"],
      "children must be sorted by startedAt and only attach to the child session",
    );
    assert.deepEqual(runs.childrenOf("c1"), [], "a leaf run has no children");
  });

  it("childrenOf is empty when the parent never recorded a child session", () => {
    runs.start({
      id: "p1",
      agent: "beaver",
      parentSession: "main",
      startedAt: 100,
    });
    runs.start({
      id: "c1",
      agent: "lynx",
      parentSession: "not-the-child-session",
      startedAt: 200,
    });
    assert.deepEqual(runs.childrenOf("p1"), []);
  });

  it("topLevel returns only the runs whose parentSession is the main session", () => {
    runs.start({
      id: "p1",
      agent: "beaver",
      parentSession: "main",
      startedAt: 100,
    });
    runs.update("p1", { childSession: "child-ses-1" });
    runs.start({
      id: "c1",
      agent: "lynx",
      parentSession: "child-ses-1",
      startedAt: 200,
    });
    runs.start({
      id: "s1",
      agent: "spider",
      parentSession: "main",
      startedAt: 300,
    });

    const top = runs.topLevel("main");
    assert.deepEqual(
      top.map((r) => r.id),
      ["p1", "s1"],
      "nested child runs must be excluded from the top-level list",
    );
  });

  it("topLevel sorts by startedAt ascending with a deterministic tiebreak", () => {
    runs.start({
      id: "z",
      agent: "lynx",
      parentSession: "main",
      startedAt: 300,
    });
    runs.start({
      id: "a",
      agent: "spider",
      parentSession: "main",
      startedAt: 100,
    });
    runs.start({
      id: "m",
      agent: "lynx",
      parentSession: "main",
      startedAt: 200,
    });
    assert.deepEqual(
      runs.topLevel("main").map((r) => r.id),
      ["a", "m", "z"],
    );
  });

  it("topLevel is isolated per main session", () => {
    runs.start({
      id: "a1",
      agent: "lynx",
      parentSession: "main-a",
      startedAt: 100,
    });
    runs.start({
      id: "b1",
      agent: "spider",
      parentSession: "main-b",
      startedAt: 200,
    });
    assert.deepEqual(
      runs.topLevel("main-a").map((r) => r.id),
      ["a1"],
    );
    assert.deepEqual(
      runs.topLevel("main-b").map((r) => r.id),
      ["b1"],
    );
    assert.deepEqual(runs.topLevel("main-c"), []);
  });

  it("findByChildSession returns the run that delegated into a session", () => {
    runs.start({
      id: "p1",
      agent: "beaver",
      parentSession: "main",
      startedAt: 100,
    });
    runs.update("p1", { childSession: "child-ses-1" });
    const run = runs.findByChildSession("child-ses-1");
    assert.ok(run, "expected the delegation run to be found");
    assert.equal(run.id, "p1");
    assert.equal(run.agent, "beaver");
  });

  it("findByChildSession is undefined for a session no run delegated into", () => {
    runs.start({
      id: "p1",
      agent: "beaver",
      parentSession: "main",
      startedAt: 100,
    });
    runs.update("p1", { childSession: "child-ses-1" });
    // The parent session itself is never a child session of this run.
    assert.equal(runs.findByChildSession("main"), undefined);
    assert.equal(runs.findByChildSession("never-delegated"), undefined);
  });

  it("findByChildSession still matches a terminal run (history survives)", () => {
    runs.start({
      id: "p1",
      agent: "lynx",
      parentSession: "main",
      startedAt: 100,
      childSession: "child-ses-9",
    });
    runs.finish("p1", { status: "done", endedAt: 200 });
    assert.equal(runs.findByChildSession("child-ses-9")?.agent, "lynx");
  });
});

// ---------------------------------------------------------------------------
// childrenIndex
// ---------------------------------------------------------------------------

/** Every child id the index lists, across all parent entries. */
function indexedChildIds(
  index: ReadonlyMap<string, readonly RunSnapshot[]>,
): string[] {
  return [...index.values()].flatMap((children) =>
    children.map((child) => child.id),
  );
}

describe("registry — childrenIndex", () => {
  it("indexes the children of every generation under the given roots", () => {
    runs.start({
      id: "t1",
      agent: "beaver",
      parentSession: "main",
      startedAt: 100,
      childSession: "ses-t1",
    });
    runs.start({
      id: "t1a",
      agent: "lynx",
      parentSession: "ses-t1",
      startedAt: 200,
      childSession: "ses-t1a",
    });
    runs.start({
      id: "t1a1",
      agent: "spider",
      parentSession: "ses-t1a",
      startedAt: 300,
    });
    runs.start({
      id: "t2",
      agent: "mola",
      parentSession: "main",
      startedAt: 150,
    });

    const index = runs.childrenIndex(runs.topLevel("main"));

    assert.deepEqual(
      [...index.keys()].sort(),
      ["t1", "t1a"],
      "every run with children is indexed, at any depth",
    );
    assert.deepEqual(
      index.get("t1")?.map((r) => r.id),
      ["t1a"],
    );
    assert.deepEqual(
      index.get("t1a")?.map((r) => r.id),
      ["t1a1"],
    );
  });

  it("orders each sibling group by startedAt", () => {
    runs.start({
      id: "p1",
      agent: "beaver",
      parentSession: "main",
      startedAt: 10,
      childSession: "ses-p1",
    });
    runs.start({
      id: "late",
      agent: "lynx",
      parentSession: "ses-p1",
      startedAt: 900,
    });
    runs.start({
      id: "early",
      agent: "spider",
      parentSession: "ses-p1",
      startedAt: 100,
    });

    const index = runs.childrenIndex(runs.topLevel("main"));
    assert.deepEqual(
      index.get("p1")?.map((r) => r.id),
      ["early", "late"],
    );
  });

  it("omits leaf runs and returns an empty index for no roots", () => {
    runs.start({
      id: "leaf",
      agent: "lynx",
      parentSession: "main",
      startedAt: 10,
    });
    assert.equal(runs.childrenIndex(runs.topLevel("main")).size, 0);
    assert.equal(runs.childrenIndex([]).size, 0);
  });

  it("drops the self edge of a run whose child session is its own parent", () => {
    // A corrupted history writes the run's own parent session as its child
    // session, so `childrenOf` matches the run itself.
    runs.start({
      id: "top",
      agent: "beaver",
      parentSession: "main",
      startedAt: 10,
      childSession: "ses-top",
    });
    runs.start({
      id: "self",
      agent: "lynx",
      parentSession: "ses-top",
      startedAt: 20,
      childSession: "ses-top",
    });

    const index = runs.childrenIndex(runs.topLevel("main"));

    assert.deepEqual(
      [...index.keys()],
      ["top"],
      "the self reference is not an index entry",
    );
    assert.deepEqual(
      index.get("top")?.map((r) => r.id),
      ["self"],
    );
  });

  it("drops the back edge of a two-run cycle", () => {
    // `a` delegates into ses-a, `b` reports ses-a as its parent and points
    // its own child session back at the main session, so `runs.childrenOf(b)`
    // matches `a`.  Without cycle handling the walk never terminates.
    runs.start({
      id: "top",
      agent: "beaver",
      parentSession: "main",
      startedAt: 10,
      childSession: "ses-top",
    });
    runs.start({
      id: "a",
      agent: "mola",
      parentSession: "ses-top",
      startedAt: 20,
      childSession: "ses-a",
    });
    runs.start({
      id: "b",
      agent: "lynx",
      parentSession: "ses-a",
      startedAt: 30,
      childSession: "main",
    });

    const index = runs.childrenIndex(runs.topLevel("main"));

    assert.deepEqual(
      index.get("top")?.map((r) => r.id),
      ["a"],
    );
    assert.deepEqual(
      index.get("a")?.map((r) => r.id),
      ["b"],
      "the cycle is cut after the first visit",
    );
    assert.equal(index.get("b"), undefined, "the back edge is dropped");
    assert.deepEqual(indexedChildIds(index), ["a", "b"]);
  });

  it("returns a finite DAG for a scanned three-run cycle with a back edge", () => {
    // The history scanner can restore a loop from persisted parent/child
    // links (t → a → b → c → a) plus a second parent session that points at
    // an already indexed run.
    runs.start({
      id: "t",
      agent: "beaver",
      parentSession: "main",
      startedAt: 10,
      childSession: "ses-t",
    });
    runs.start({
      id: "a",
      agent: "mola",
      parentSession: "ses-t",
      startedAt: 20,
      childSession: "ses-a",
    });
    runs.start({
      id: "b",
      agent: "spider",
      parentSession: "ses-a",
      startedAt: 30,
      childSession: "ses-b",
    });
    runs.start({
      id: "c",
      agent: "lynx",
      parentSession: "ses-b",
      startedAt: 40,
      childSession: "ses-t",
    });
    runs.start({
      id: "t2",
      agent: "beaver",
      parentSession: "main",
      startedAt: 50,
      childSession: "ses-a",
    });

    const index = runs.childrenIndex(runs.topLevel("main"));

    assert.deepEqual(
      [...index.keys()],
      ["t", "a", "b"],
      "every loop edge is cut and no run is re-entered",
    );
    assert.deepEqual(
      index.get("t")?.map((r) => r.id),
      ["a"],
    );
    assert.deepEqual(
      index.get("a")?.map((r) => r.id),
      ["b"],
    );
    assert.deepEqual(
      index.get("b")?.map((r) => r.id),
      ["c"],
    );
    const childIds = indexedChildIds(index);
    assert.deepEqual(childIds, ["a", "b", "c"]);
    assert.equal(
      new Set(childIds).size,
      childIds.length,
      "a run appears at most once as a child",
    );
  });
});

// ---------------------------------------------------------------------------
// summary
// ---------------------------------------------------------------------------

describe("registry — summary counts", () => {
  it("counts running / done / failed / aborted, keeping aborted separate", () => {
    runs.start({
      id: "r1",
      agent: "lynx",
      parentSession: "main",
      startedAt: 100,
    });
    runs.finish("r1", { status: "done" });
    runs.start({
      id: "r2",
      agent: "spider",
      parentSession: "main",
      startedAt: 200,
    });
    runs.finish("r2", { status: "error", error: "boom" });
    runs.start({
      id: "r3",
      agent: "spider",
      parentSession: "main",
      startedAt: 300,
    });
    runs.finish("r3", { status: "aborted" });
    runs.start({
      id: "r4",
      agent: "lynx",
      parentSession: "main",
      startedAt: 400,
    });

    assert.deepEqual(runs.summary("main"), {
      running: 1,
      done: 1,
      failed: 1,
      aborted: 1,
    });
  });

  it("summaries with no activity are all zero", () => {
    assert.deepEqual(runs.summary("main"), {
      running: 0,
      done: 0,
      failed: 0,
      aborted: 0,
    });
  });

  it("summary counts are isolated per main session", () => {
    runs.start({
      id: "a1",
      agent: "lynx",
      parentSession: "main-a",
      startedAt: 100,
    });
    runs.finish("a1", { status: "error", error: "x" });
    runs.start({
      id: "b1",
      agent: "spider",
      parentSession: "main-b",
      startedAt: 200,
    });
    assert.deepEqual(runs.summary("main-a"), {
      running: 0,
      done: 0,
      failed: 1,
      aborted: 0,
    });
    assert.deepEqual(runs.summary("main-b"), {
      running: 1,
      done: 0,
      failed: 0,
      aborted: 0,
    });
  });

  it("counts nested runs across the whole session tree", () => {
    // main → p (done) → { n1 (error) → g (running), n2 (done) }.
    runs.start({
      id: "p",
      agent: "beaver",
      parentSession: "main",
      startedAt: 0,
    });
    runs.finish("p", { status: "done", childSession: "child-p" });
    runs.start({
      id: "n1",
      agent: "lynx",
      parentSession: "child-p",
      startedAt: 1,
    });
    runs.finish("n1", {
      status: "error",
      error: "boom",
      childSession: "child-n1",
    });
    runs.start({
      id: "n2",
      agent: "spider",
      parentSession: "child-p",
      startedAt: 2,
    });
    runs.finish("n2", { status: "done" });
    runs.start({
      id: "g",
      agent: "mola",
      parentSession: "child-n1",
      startedAt: 3,
    });
    // A run under another main session must stay out of the tally.
    runs.start({
      id: "other",
      agent: "lynx",
      parentSession: "main-other",
      startedAt: 4,
    });
    runs.finish("other", { status: "done" });

    assert.deepEqual(runs.summary("main"), {
      running: 1,
      done: 2,
      failed: 1,
      aborted: 0,
    });
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
): RunSnapshot {
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
function denseList(n: number): RunSnapshot[] {
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

  it("budgets rendered rows so a run's child rows are never split", () => {
    const entries = denseList(5);
    const rowsOf = (run: RunSnapshot): number => (run.id === "r0" ? 4 : 1);

    // Bottom-aligned: r0 renders 4 rows, so only r1..r4 fit the 5-row cap.
    const slice = windowRuns(entries, undefined, 5, rowsOf);
    assert.deepEqual(
      slice.rows.map((r) => r.id),
      ["r1", "r2", "r3", "r4"],
    );
    assert.equal(slice.hiddenAbove, 1);
    assert.equal(slice.hiddenBelow, 0);

    // Selecting the tall run keeps it whole (r0's 4 rows) and spends the
    // remaining row on r1, hiding the rest.
    const selected = windowRuns(entries, "r0", 5, rowsOf);
    assert.deepEqual(
      selected.rows.map((r) => r.id),
      ["r0", "r1"],
    );
    assert.equal(selected.selectedIndex, 0);
    assert.equal(selected.hiddenAbove, 0);
    assert.equal(selected.hiddenBelow, 3);
  });

  it("keeps a selected run whose rows alone exceed the budget", () => {
    const entries = denseList(5);
    const rowsOf = (run: RunSnapshot): number => (run.id === "r4" ? 9 : 1);

    const slice = windowRuns(entries, "r4", 3, rowsOf);
    assert.deepEqual(
      slice.rows.map((r) => r.id),
      ["r4"],
    );
    assert.equal(slice.hiddenAbove, 4);
    assert.equal(slice.hiddenBelow, 0);
    assert.equal(slice.selectedIndex, 0);
  });
});

describe("registry — run-change notification", () => {
  it("carries the run id and parent session on every change", () => {
    const seen: Array<{ runId: string; parentSession: string }> = [];
    const off = runs.subscribe((change) => {
      seen.push(change);
    });
    runs.start({
      id: "r1",
      agent: "lynx",
      parentSession: "main",
      startedAt: 1,
    });
    runs.update("r1", { tokens: 10 });
    runs.finish("r1", { status: "done", endedAt: 2 });
    off();
    assert.deepEqual(seen, [
      { runId: "r1", parentSession: "main" },
      { runId: "r1", parentSession: "main" },
      { runId: "r1", parentSession: "main" },
    ]);
  });

  it("never publishes a write that changes nothing", () => {
    let changes = 0;
    const off = runs.subscribe(() => {
      changes += 1;
    });
    runs.start({
      id: "r1",
      agent: "lynx",
      parentSession: "main",
      startedAt: 1,
    });
    assert.equal(changes, 1, "registration is a change");

    runs.start({
      id: "r1",
      agent: "lynx",
      parentSession: "main",
      startedAt: 1,
    });
    assert.equal(changes, 1, "a duplicate start reports nothing");

    runs.update("r1", {});
    runs.update("r1", { tokens: undefined });
    assert.equal(changes, 1, "an empty update reports nothing");

    runs.update("r1", { tokens: 7, model: "dummy-small" });
    assert.equal(changes, 2, "a real update reports once");
    runs.update("r1", { tokens: 7, model: "dummy-small" });
    assert.equal(changes, 2, "an unchanged update reports nothing");

    runs.update("r1", { currentTool: "bash" });
    assert.equal(changes, 3);
    runs.update("r1", { currentTool: "bash" });
    assert.equal(changes, 3, "re-setting the same tool reports nothing");
    runs.update("r1", { currentTool: null });
    assert.equal(changes, 4, "clearing the tool reports once");
    runs.update("r1", { currentTool: null });
    assert.equal(changes, 4, "clearing an already absent tool reports nothing");

    runs.finish("r1", { status: "done", endedAt: 2 });
    assert.equal(changes, 5);
    runs.finish("r1", { status: "done", endedAt: 2 });
    runs.update("r1", { tokens: 9 });
    assert.equal(changes, 5, "a terminal run never reports again");
    off();
  });

  it("finishes atomically: the last progress fields land with one event", () => {
    const seen: string[] = [];
    const off = runs.subscribe((change) => {
      seen.push(change.runId);
    });
    const started = runs.start({
      id: "r1",
      agent: "lynx",
      parentSession: "main",
      startedAt: 1,
    });
    const liveLog = started.log;
    runs.finish("r1", {
      status: "done",
      endedAt: 9,
      label: "final label",
      tokens: 1234,
      model: "dummy-large",
      currentTool: null,
      childSession: "child-ses-1",
      sessionPath: "/tmp/child-ses-1.jsonl",
    });
    off();

    assert.deepEqual(seen, ["r1", "r1"], "start + finish is two events");
    const run = runs.get("r1");
    assert.ok(run);
    assert.equal(run.status, "done");
    assert.equal(run.endedAt, 9);
    assert.equal(run.label, "final label");
    assert.equal(run.tokens, 1234);
    assert.equal(run.model, "dummy-large");
    assert.equal(run.currentTool, undefined);
    assert.equal(run.childSession, "child-ses-1");
    assert.equal(run.sessionPath, "/tmp/child-ses-1.jsonl");
    assert.equal(run.log.size, 0, "the terminal run keeps no facts");
    assert.ok(liveLog !== run.log, "the live log is released");
  });

  it("surfaces a fact append but never a streaming partial", () => {
    // The fleet widget refreshes on this one notification, so the streaming
    // path must not reach it: a token-by-token partial would repaint the
    // whole widget list per delta.
    let changes = 0;
    const off = runs.subscribe(() => {
      changes += 1;
    });
    const run = runs.start({ id: "r1", agent: "lynx", parentSession: "main" });
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

// ---------------------------------------------------------------------------
// Read-only snapshots and active handles
// ---------------------------------------------------------------------------

describe("registry — read-only run snapshots", () => {
  it("freezes the snapshot every query hands out", () => {
    runs.start({
      id: "r1",
      agent: "lynx",
      parentSession: "main",
      startedAt: 100,
    });
    const snap = runs.get("r1");
    assert.ok(snap);
    assert.equal(Object.isFrozen(snap), true, "a snapshot is frozen");
    assert.throws(
      () => {
        // @ts-expect-error — a snapshot must reject writes at runtime.
        snap.status = "done";
      },
      TypeError,
      "writing a snapshot throws",
    );
    assert.equal(runs.get("r1")?.status, "running", "the entry is unchanged");
  });

  it("isolates an old snapshot from later update and finish", () => {
    runs.start({
      id: "r1",
      agent: "lynx",
      parentSession: "main",
      startedAt: 100,
    });
    const before = runs.get("r1");
    assert.ok(before);
    runs.update("r1", { tokens: 10, currentTool: "bash" });
    runs.finish("r1", { status: "done", endedAt: 300, label: "settled" });
    assert.equal(before.status, "running", "the old snapshot keeps running");
    assert.equal(before.tokens, undefined, "no later token total leaks in");
    assert.equal(before.currentTool, undefined, "no later tool leaks in");
    assert.equal(before.endedAt, undefined, "no terminal time leaks in");
    assert.equal(before.label, undefined, "no terminal label leaks in");
    const after = runs.get("r1");
    assert.ok(after);
    assert.equal(after.status, "done");
    assert.equal(after.tokens, 10);
    assert.equal(after.endedAt, 300);
  });

  it("returns independent snapshots from the list queries", () => {
    runs.start({
      id: "p1",
      agent: "beaver",
      parentSession: "main",
      startedAt: 1,
      childSession: "child-ses-1",
    });
    runs.start({
      id: "c1",
      agent: "lynx",
      parentSession: "child-ses-1",
      startedAt: 2,
    });
    const tops = runs.topLevel("main");
    assert.equal(tops.length, 1, "precondition: one top-level run");
    const kids = runs.childrenOf("p1");
    assert.equal(kids.length, 1, "precondition: one child run");
    const found = runs.findByChildSession("child-ses-1");
    assert.ok(found);
    for (const snap of [tops[0], kids[0], found]) {
      assert.equal(Object.isFrozen(snap), true, "every snapshot is frozen");
    }
    const direct = runs.get("p1");
    assert.ok(direct);
    assert.ok(tops[0] !== direct, "each query builds its own snapshot");
    assert.ok(found !== direct, "each query builds its own snapshot");
    assert.ok(tops[0] !== kids[0], "siblings are separate snapshots");
    runs.update("p1", { tokens: 7 });
    assert.equal(tops[0].tokens, undefined, "the array snapshot is isolated");
    assert.equal(kids[0].parentSession, "child-ses-1");
    assert.equal(runs.get("p1")?.tokens, 7);
  });

  it("omits every unset optional field from the snapshot", () => {
    runs.start({
      id: "r1",
      agent: "lynx",
      parentSession: "main",
      startedAt: 100,
    });
    const snap = runs.get("r1");
    assert.ok(snap);
    assert.deepEqual(Object.keys(snap).sort(), [
      "agent",
      "id",
      "log",
      "parentSession",
      "startedAt",
      "status",
    ]);
  });
});

describe("registry — active run handle", () => {
  it("hands out the run id and its live log only", () => {
    const handle = runs.start({
      id: "r1",
      agent: "lynx",
      parentSession: "main",
      startedAt: 100,
      label: "delegated task",
    });
    assert.deepEqual(Object.keys(handle).sort(), ["id", "log"]);
    assert.equal(handle.id, "r1");
    const snap = runs.get("r1");
    assert.ok(snap);
    assert.equal(handle.log, snap.log, "the handle log is the run's log");
    handle.log.appendMessage([{ type: "text", text: "hi" }], undefined, 101);
    assert.equal(runs.get("r1")?.log.size, 1, "the handle log is live");
  });

  it("gives a duplicate start the first run's handle", () => {
    const first = runs.start({
      id: "r1",
      agent: "lynx",
      parentSession: "main",
      startedAt: 100,
    });
    const second = runs.start({
      id: "r1",
      agent: "spider",
      parentSession: "other",
      startedAt: 200,
    });
    assert.equal(second.id, "r1");
    assert.equal(second.log, first.log, "the duplicate shares the live log");
    assert.equal(runs.get("r1")?.agent, "lynx", "the first start still wins");
    assert.equal(runs.get("r1")?.startedAt, 100);
  });

  it("keeps the released log readable and reports a fresh terminal log", () => {
    const handle = runs.start({
      id: "r1",
      agent: "lynx",
      parentSession: "main",
      startedAt: 100,
    });
    const liveLog = handle.log;
    liveLog.appendMessage([{ type: "text", text: "final" }], undefined, 101);
    runs.finish("r1", { status: "done", endedAt: 300 });
    assert.equal(liveLog.size, 1, "the released log stays readable");
    assert.deepEqual(
      liveLog.facts().map((fact) => fact.type),
      ["message_end"],
      "the released log keeps its facts",
    );
    const terminal = runs.get("r1");
    assert.ok(terminal);
    assert.ok(terminal.log !== liveLog, "a later query reports a new log");
    assert.equal(terminal.log.size, 0, "the terminal log starts empty");
  });
});
