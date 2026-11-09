/**
 * Tests for the runtime run scope (`registry.ts` `RunScope`).
 *
 * One OS process keeps one run table, and every runtime of that process
 * (a configuration generation, a pi sub-session) creates its own scope over
 * it.  A scope is the runtime's write path: the runs it starts enter the
 * process table (so a reloaded generation still renders them) and the scope
 * remembers that they are ITS active runs.  Stopping the runtime disposes the
 * scope, which aborts exactly those still-running runs and leaves the
 * process history, the terminal records and every other runtime untouched.
 *
 * The scope is tested through its public API only: `createScope` on the
 * process table, the shared read/write methods, and `dispose`.  Every
 * expectation is a literal, so the suite would fail if the scope started
 * writing somewhere else.
 */
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import {
  createRunRegistry,
  type RunRegistry,
  type RunScope,
} from "./registry.js";

/** The process table every test starts from. */
let runs: RunRegistry = createRunRegistry();

beforeEach(() => {
  runs = createRunRegistry();
});

describe("run scope — process history", () => {
  it("writes a run the scope started into the process table", () => {
    const runtime: RunScope = runs.createScope();
    const handle = runtime.start({
      id: "call-1",
      agent: "lynx",
      parentSession: "main",
      label: "扫描代码",
      startedAt: 100,
    });

    assert.equal(handle.id, "call-1");
    // The process table is the history every generation reads, so the run
    // is visible there with the facts the scope wrote.
    assert.deepEqual(
      runs.topLevel("main").map((run) => run.id),
      ["call-1"],
    );
    assert.equal(runs.get("call-1")?.status, "running");
    assert.equal(runs.get("call-1")?.agent, "lynx");
    assert.equal(runs.get("call-1")?.label, "扫描代码");
    assert.equal(runs.get("call-1")?.startedAt, 100);
  });

  it("reads the runs another runtime wrote", () => {
    const first = runs.createScope();
    const second = runs.createScope();
    first.start({
      id: "call-1",
      agent: "lynx",
      parentSession: "main",
      startedAt: 100,
    });
    second.start({
      id: "call-2",
      agent: "spider",
      parentSession: "main",
      startedAt: 200,
    });

    // A scope is a write path, not a private table: the reloaded generation
    // must see the previous generation's runs.
    assert.deepEqual(
      second.topLevel("main").map((run) => run.id),
      ["call-1", "call-2"],
    );
    assert.equal(first.get("call-2")?.agent, "spider");
    assert.deepEqual(first.summary("main"), {
      running: 2,
      done: 0,
      failed: 0,
      aborted: 0,
    });
  });
});

describe("run scope — stop cleanup", () => {
  it("aborts the running runs of the disposing scope only", () => {
    const stopping = runs.createScope();
    const staying = runs.createScope();
    stopping.start({
      id: "owned-live",
      agent: "lynx",
      parentSession: "main",
      label: "owned",
      startedAt: 100,
    });
    stopping.start({
      id: "owned-done",
      agent: "lynx",
      parentSession: "main",
      startedAt: 200,
    });
    stopping.finish("owned-done", { status: "done", endedAt: 250, tokens: 7 });
    staying.start({
      id: "other-live",
      agent: "spider",
      parentSession: "main",
      startedAt: 300,
    });
    runs.restore({
      id: "history",
      agent: "beaver",
      parentSession: "main",
      status: "error",
      startedAt: 400,
      endedAt: 450,
      error: "boom",
    });

    stopping.dispose();

    // The owned live run is closed as an abort, keeping its metadata.
    const aborted = runs.get("owned-live");
    assert.equal(aborted?.status, "aborted");
    assert.equal(typeof aborted?.endedAt, "number");
    assert.equal(aborted?.label, "owned");
    assert.equal(aborted?.startedAt, 100);
    // A terminal run of the same scope keeps exactly what it had.
    assert.equal(runs.get("owned-done")?.status, "done");
    assert.equal(runs.get("owned-done")?.endedAt, 250);
    assert.equal(runs.get("owned-done")?.tokens, 7);
    // Another live runtime and the process history are untouched.
    assert.equal(runs.get("other-live")?.status, "running");
    assert.equal(runs.get("history")?.status, "error");
    assert.equal(runs.get("history")?.error, "boom");
    // Terminal records are never deleted.
    assert.equal(runs.topLevel("main").length, 4);
  });

  it("publishes the abort of every owned run", () => {
    const runtime = runs.createScope();
    runtime.start({
      id: "call-1",
      agent: "lynx",
      parentSession: "main",
      startedAt: 100,
    });
    const changes: Array<{ runId: string; parentSession: string }> = [];
    const off = runs.subscribe((change) => {
      changes.push(change);
    });

    runtime.dispose();
    off();

    assert.deepEqual(changes, [{ runId: "call-1", parentSession: "main" }]);
  });

  it("is idempotent and rejects a start after the stop", () => {
    const runtime = runs.createScope();
    runtime.start({
      id: "call-1",
      agent: "lynx",
      parentSession: "main",
      startedAt: 100,
    });
    const changes: Array<{ runId: string; parentSession: string }> = [];
    const off = runs.subscribe((change) => {
      changes.push(change);
    });

    runtime.dispose();
    runtime.dispose();
    off();

    assert.equal(runs.get("call-1")?.status, "aborted");
    changes.length = 0;
    const late = runs.subscribe((change) => {
      changes.push(change);
    });

    // A stopped runtime fails closed: a late start writes nothing, so no
    // unowned running record can outlive the runtime.
    assert.throws(
      () =>
        runtime.start({
          id: "call-2",
          agent: "lynx",
          parentSession: "main",
          startedAt: 200,
        }),
      /运行作用域已停止/,
      "a late start must report the stopped scope",
    );
    late();
    runtime.dispose();

    assert.equal(runs.get("call-2"), undefined);
    assert.deepEqual(
      runs.topLevel("main").map((run) => run.id),
      ["call-1"],
    );
    assert.deepEqual(changes, [], "a rejected start publishes nothing");
  });

  it("never takes a run another runtime started", () => {
    const owner = runs.createScope();
    const late = runs.createScope();
    const first = owner.start({
      id: "call-1",
      agent: "lynx",
      parentSession: "main",
      label: "first",
      startedAt: 100,
    });
    const duplicate = late.start({
      id: "call-1",
      agent: "spider",
      parentSession: "other",
      label: "second",
      startedAt: 200,
    });

    assert.equal(duplicate.id, first.id);
    assert.equal(runs.get("call-1")?.agent, "lynx");
    assert.equal(runs.get("call-1")?.parentSession, "main");
    // The duplicate start did not move the ownership: only the owner's stop
    // ends the run.
    late.dispose();
    assert.equal(runs.get("call-1")?.status, "running");
    owner.dispose();
    assert.equal(runs.get("call-1")?.status, "aborted");
  });

  it("owns a run whose first notification throws", () => {
    const runtime = runs.createScope();
    const seen: string[] = [];
    const failing = runs.subscribe(() => {
      throw new Error("listener failed");
    });
    const recording = runs.subscribe((change) => {
      seen.push(change.runId);
    });

    assert.throws(
      () =>
        runtime.start({
          id: "call-1",
          agent: "lynx",
          parentSession: "main",
          startedAt: 100,
        }),
      /listener failed/,
      "the listener failure must reach the caller",
    );
    failing();

    // The run reached the process table before the notification, so the
    // scope must own it: without an owner no stop would ever end it.
    assert.equal(runs.get("call-1")?.status, "running");
    runtime.dispose();
    recording();

    assert.equal(runs.get("call-1")?.status, "aborted");
    assert.deepEqual(seen, ["call-1"], "the other subscriber still hears");
  });

  it("does not own a run restored from history", () => {
    const runtime = runs.createScope();
    runtime.restore({
      id: "history",
      agent: "lynx",
      parentSession: "main",
      status: "done",
      startedAt: 100,
      endedAt: 200,
    });
    runtime.restore({
      id: "history-aborted",
      agent: "spider",
      parentSession: "main",
      status: "aborted",
      startedAt: 300,
      endedAt: 400,
    });

    runtime.dispose();

    assert.equal(runs.get("history")?.status, "done");
    assert.equal(runs.get("history")?.endedAt, 200);
    assert.equal(runs.get("history-aborted")?.status, "aborted");
  });

  it("surfaces a failing subscriber to the caller", () => {
    const runtime = runs.createScope();
    runtime.start({
      id: "call-1",
      agent: "lynx",
      parentSession: "main",
      startedAt: 100,
    });
    const off = runs.subscribe(() => {
      throw new Error("listener failed");
    });

    assert.throws(
      () => runtime.dispose(),
      /listener failed/,
      "the listener failure must reach the caller",
    );
    off();

    assert.equal(runs.get("call-1")?.status, "aborted");
  });

  it("closes every owned run even when a listener fails", () => {
    const runtime = runs.createScope();
    runtime.start({
      id: "call-1",
      agent: "lynx",
      parentSession: "main",
      startedAt: 100,
    });
    runtime.start({
      id: "call-2",
      agent: "spider",
      parentSession: "main",
      startedAt: 200,
    });
    const notified: string[] = [];
    const off = runs.subscribe((change) => {
      notified.push(change.runId);
      throw new Error(`listener failed on ${change.runId}`);
    });

    assert.throws(
      () => runtime.dispose(),
      (error: unknown) =>
        error instanceof AggregateError &&
        error.message.includes("运行作用域释放失败") &&
        error.errors.length === 2 &&
        String(error.errors[0]).includes("listener failed on call-1"),
      "every listener failure must reach the caller",
    );
    off();

    assert.deepEqual(notified, ["call-1", "call-2"]);
    assert.equal(runs.get("call-1")?.status, "aborted");
    assert.equal(runs.get("call-2")?.status, "aborted", "the rest still ends");
  });
});
