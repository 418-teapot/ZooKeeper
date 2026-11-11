/**
 * Tests for the session lifecycle coordinator (`lifecycle.ts`).
 *
 * The coordinator is the surface a host drives: it ensures, starts,
 * admits work for, deletes and releases the runtimes of sessions, and it
 * never exposes a stop mode or a scope handle to do so.  The expectations
 * below are the kernel's observable effects — creation, start and disposer
 * calls with their mode, the record steps of a deletion — plus the values
 * the coordinator returns, never a replay of its own forwarding.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createLifecycleKernel,
  defineExtensionService,
  defineSessionService,
} from "../lifecycle/index.js";
import { createSessionLifecycle } from "./lifecycle.js";
import {
  createSessionResourceCatalog,
  defineSessionResourcesService,
  type SessionResource,
} from "./resources.js";

/** A promise plus its resolvers, used to hold work mid-call. */
function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/**
 * Build a coordinator over a kernel and a catalog that record every step.
 *
 * A session named `boom` fails its disposer and its retained record, so
 * the failure reporting of a deletion is observable; `records` logs every
 * step the catalog applies.
 *
 * @param log - Receives one entry per creation, start, disposal and record
 *   step.
 * @returns The coordinator under test.
 */
function buildWithRecords(log: string[]) {
  const extension = defineExtensionService({
    name: "ext",
    deps: [],
    create: () => ({}),
    dispose: (_service, { reason }) => {
      log.push(`dispose:ext:${reason}`);
    },
  });
  const session = defineSessionService({
    name: "worker",
    deps: [],
    create: ({ sessionID }) => {
      log.push(`create:worker:${sessionID}`);
      return { sessionID };
    },
    dispose: (service, { reason, mode }) => {
      log.push(`dispose:worker:${service.sessionID}:${reason}:${mode}`);
      if (service.sessionID === "boom") throw new Error("boom");
    },
  });
  const records: SessionResource[] = [
    {
      name: "records",
      runtime: "release",
      release: (sessionID) => {
        log.push(`release:records:${sessionID}`);
      },
      delete: (sessionID) => {
        log.push(`delete:records:${sessionID}`);
      },
    },
    {
      name: "broken",
      runtime: "retain",
      delete: (sessionID) => {
        if (sessionID === "boom") throw new Error("records boom");
      },
    },
  ];
  const catalog = createSessionResourceCatalog(records);
  const kernel = createLifecycleKernel({
    extension: [extension],
    session: [session, defineSessionResourcesService(catalog)],
  });
  return createSessionLifecycle(kernel, catalog);
}

function build(log: string[]) {
  const extension = defineExtensionService({
    name: "ext",
    deps: [],
    create: () => ({}),
    dispose: (_service, { reason }) => {
      log.push(`dispose:ext:${reason}`);
    },
  });
  const session = defineSessionService({
    name: "worker",
    deps: [],
    create: ({ sessionID }) => {
      log.push(`create:worker:${sessionID}`);
      return { sessionID };
    },
    start: (service, { reason }) => {
      log.push(`start:worker:${service.sessionID}:${reason}`);
    },
    dispose: (service, { reason, mode }) => {
      log.push(`dispose:worker:${service.sessionID}:${reason}:${mode}`);
      if (service.sessionID === "boom") throw new Error("boom");
    },
  });
  return createSessionLifecycle(
    createLifecycleKernel({ extension: [extension], session: [session] }),
    createSessionResourceCatalog([]),
  );
}

describe("session lifecycle coordinator", () => {
  it("ensures one session scope and creates nothing for a blank id", async () => {
    const log: string[] = [];
    const lifecycle = build(log);

    const scope = await lifecycle.ensureSession("s1");
    const again = await lifecycle.ensureSession("s1");

    assert.equal(scope?.services.worker.sessionID, "s1");
    assert.equal(again, scope);
    assert.equal(await lifecycle.ensureSession("  "), null);
    assert.deepEqual(log, ["create:worker:s1"]);
  });

  it("starts a session with the host reason and never fakes a blank id", async () => {
    const log: string[] = [];
    const lifecycle = build(log);

    assert.equal(await lifecycle.startSession("s1", "host.start"), true);
    assert.equal(await lifecycle.startSession("", "host.start"), false);

    assert.deepEqual(log, ["create:worker:s1", "start:worker:s1:host.start"]);
  });

  it("returns the value of the work it admits under a live permit", async () => {
    const log: string[] = [];
    const lifecycle = build(log);
    const seen: string[] = [];

    const value = await lifecycle.runSession("s1", (permit) => {
      seen.push(`${permit.sessionID}:${permit.isActive()}`);
      return "done";
    });

    assert.equal(value, "done");
    assert.deepEqual(seen, ["s1:true"]);
    // A refused call runs no work and creates no scope.
    assert.equal(await lifecycle.runSession("", () => "never"), undefined);
    assert.deepEqual(log, ["create:worker:s1"]);
  });

  it("hands the admitted work the services of its own session", async () => {
    const log: string[] = [];
    const lifecycle = build(log);
    const seen: string[] = [];

    await lifecycle.runSession("s1", (_permit, services) => {
      seen.push(services.worker.sessionID);
    });
    await lifecycle.runSession("s2", (_permit, services) => {
      seen.push(services.worker.sessionID);
    });

    // Each call reads the services built for the session it named, so a
    // sibling session's state is never reachable from the work.
    assert.deepEqual(seen, ["s1", "s2"]);
  });

  it("admits no work once the runtimes were released", async () => {
    const log: string[] = [];
    const lifecycle = build(log);
    let ran = false;

    await lifecycle.ensureSession("s1");
    await lifecycle.releaseRuntime("quit");
    const value = await lifecycle.runSession("s1", () => {
      ran = true;
      return "late";
    });

    assert.equal(value, undefined);
    assert.equal(ran, false);
    assert.deepEqual(log, [
      "create:worker:s1",
      "dispose:worker:s1:quit:release-runtime",
      "dispose:ext:quit",
    ]);
  });

  it("releases every runtime and reports each failed disposer", async () => {
    const log: string[] = [];
    const lifecycle = build(log);
    await lifecycle.ensureSession("ok");
    await lifecycle.ensureSession("boom");

    const report = await lifecycle.releaseRuntime("quit");

    assert.deepEqual(
      report.errors.map((failure) => [
        failure.scope,
        failure.sessionID,
        failure.service,
      ]),
      [["session", "boom", "worker"]],
    );
    assert.ok(
      log.includes("dispose:ext:quit"),
      "the extension disposer runs after a failing session",
    );
    assert.deepEqual(
      log.filter((entry) => entry.startsWith("dispose:worker")).sort(),
      [
        "dispose:worker:boom:quit:release-runtime",
        "dispose:worker:ok:quit:release-runtime",
      ],
    );
  });

  it("deletes a session by stopping its scope and then its records", async () => {
    const log: string[] = [];
    const lifecycle = buildWithRecords(log);
    await lifecycle.ensureSession("s1");

    const report = await lifecycle.deleteSession("s1", "session.deleted");
    // A blank id names no session and deletes nothing.
    const blank = await lifecycle.deleteSession("  ", "session.deleted");

    assert.deepEqual(report.errors, []);
    assert.deepEqual(blank.errors, []);
    assert.deepEqual(log, [
      "create:worker:s1",
      "dispose:worker:s1:session.deleted:delete-session",
      "delete:records:s1",
    ]);
  });

  it("deletes the records of a session no scope owns and builds none", async () => {
    const log: string[] = [];
    const lifecycle = buildWithRecords(log);

    const report = await lifecycle.deleteSession("ghost", "session.deleted");

    assert.deepEqual(report.errors, []);
    assert.deepEqual(log, ["delete:records:ghost"]);
  });

  it("applies the records of a repeated deletion once per call", async () => {
    const log: string[] = [];
    const lifecycle = buildWithRecords(log);
    await lifecycle.ensureSession("s1");
    await lifecycle.deleteSession("s1", "session.deleted");

    const report = await lifecycle.deleteSession("s1", "session.deleted");

    assert.deepEqual(report.errors, []);
    assert.deepEqual(log, [
      "create:worker:s1",
      "dispose:worker:s1:session.deleted:delete-session",
      "delete:records:s1",
      "delete:records:s1",
    ]);
  });

  it("deletes the records even when a release reached the scope first", async () => {
    const log: string[] = [];
    const lifecycle = buildWithRecords(log);
    await lifecycle.ensureSession("s1");

    const releasing = lifecycle.releaseRuntime("dispose");
    const report = await lifecycle.deleteSession("s1", "session.deleted");
    await releasing;

    assert.deepEqual(report.errors, []);
    assert.deepEqual(
      log.filter((entry) => entry.includes(":records:")),
      ["release:records:s1", "delete:records:s1"],
      "the deletion applies the records after the release kept them",
    );
  });

  it("reports a failed stop and a failed record step of one deletion", async () => {
    const log: string[] = [];
    const lifecycle = buildWithRecords(log);
    await lifecycle.ensureSession("boom");

    const report = await lifecycle.deleteSession("boom", "session.deleted");

    assert.deepEqual(
      report.errors.map((failure) => [
        failure.scope,
        failure.sessionID,
        failure.service,
      ]),
      [
        ["session", "boom", "worker"],
        ["session", "boom", "broken"],
      ],
    );
  });

  it("does not make a release wait for a control call", async () => {
    const log: string[] = [];
    const lifecycle = build(log);
    const entered = deferred<void>();
    const gate = deferred<void>();

    const control = lifecycle.runControl("s1", async (permit) => {
      entered.resolve();
      await gate.promise;
      return permit.isActive();
    });
    await entered.promise;

    const report = await lifecycle.releaseRuntime("quit");

    assert.deepEqual(report.errors, []);
    gate.resolve();
    assert.equal(
      await control,
      false,
      "the release revokes the control call's permit",
    );
  });
});
