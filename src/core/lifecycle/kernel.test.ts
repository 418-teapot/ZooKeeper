/**
 * Tests for the host-agnostic lifecycle kernel (`kernel.ts`).
 *
 * The kernel owns resource lifetime only: extension services start once,
 * every session nests inside that extension, session creation is lazy and
 * idempotent, and stopping disposes in reverse dependency order while
 * reporting every cleanup failure.  Real session starts are a separate
 * notification path so a first-use `ensureSession` can never fabricate a
 * start reason.
 *
 * The expectations below are literal event sequences and factory counts,
 * never a replay of the kernel's own ordering logic.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  type AnyExtensionServiceDefinition,
  createLifecycleKernel,
  defineExtensionService,
  defineSessionService,
  LifecycleDefinitionError,
} from "./index.js";

/** A promise plus its resolvers, used to hold a factory mid-creation. */
function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("lifecycle kernel", () => {
  it("creates extension services once in dependency order with narrow deps", async () => {
    const calls: string[] = [];

    const config = defineExtensionService({
      name: "config",
      deps: [],
      create: ({ signal }) => {
        calls.push("config");
        assert.equal(signal.aborted, false);
        return { value: "cfg" };
      },
    });
    const db = defineExtensionService({
      name: "db",
      deps: [config],
      create: ({ deps }) => {
        calls.push("db");
        return { dsn: deps.config.value };
      },
    });

    const kernel = createLifecycleKernel({
      extension: [db, config],
      session: [],
    });

    const first = await kernel.ensureExtension();
    const second = await kernel.ensureExtension();

    assert.deepEqual(calls, ["config", "db"]);
    assert.equal(first, second);
    assert.equal(first?.services.db.dsn, "cfg");
  });

  it("concurrent ensureExtension creates the extension once", async () => {
    const started = deferred<void>();
    const gate = deferred<void>();
    let createCount = 0;

    const ext = defineExtensionService({
      name: "ext",
      deps: [],
      create: async () => {
        createCount += 1;
        started.resolve();
        await gate.promise;
        return { n: createCount };
      },
    });
    const kernel = createLifecycleKernel({ extension: [ext], session: [] });

    const first = kernel.ensureExtension();
    const second = kernel.ensureExtension();
    await started.promise;
    assert.equal(createCount, 1);

    gate.resolve();
    const [a, b] = await Promise.all([first, second]);

    assert.equal(a, b);
    assert.equal(createCount, 1);
    assert.equal(a?.services.ext.n, 1);
  });

  it("builds session services from extension and session dependencies", async () => {
    const config = defineExtensionService({
      name: "config",
      deps: [],
      create: () => ({ value: "cfg" }),
    });
    const store = defineSessionService({
      name: "store",
      deps: [config],
      create: ({ deps, sessionID }) => ({
        key: `${sessionID}:${deps.config.value}`,
      }),
    });
    const state = defineSessionService({
      name: "state",
      deps: [store],
      create: ({ deps, sessionID }) => ({
        key: `${deps.store.key}:${sessionID}`,
      }),
    });

    const kernel = createLifecycleKernel({
      extension: [config],
      session: [state, store],
    });

    const scope = await kernel.ensureSession("s1");

    assert.equal(scope?.services.store.key, "s1:cfg");
    assert.equal(scope?.services.state.key, "s1:cfg:s1");
  });

  it("concurrent ensure creates one session and returns one scope", async () => {
    const started = deferred<void>();
    const gate = deferred<void>();
    let createCount = 0;

    const slow = defineSessionService({
      name: "slow",
      deps: [],
      create: async () => {
        createCount += 1;
        started.resolve();
        await gate.promise;
        return { n: createCount };
      },
    });
    const kernel = createLifecycleKernel({ extension: [], session: [slow] });

    const first = kernel.ensureSession("s1");
    const second = kernel.ensureSession("s1");
    await started.promise;
    assert.equal(createCount, 1);

    gate.resolve();
    const [a, b] = await Promise.all([first, second]);

    assert.equal(a, b);
    assert.equal(createCount, 1);
    assert.equal(a?.services.slow.n, 1);
  });

  it("runs session start hooks in creation order on a real start only", async () => {
    const events: string[] = [];
    let createCount = 0;

    const base = defineSessionService({
      name: "base",
      deps: [],
      create: () => {
        createCount += 1;
        return { n: createCount };
      },
      start: (service, { sessionID, reason }) => {
        events.push(`base:${sessionID}:${reason}:${service.n}`);
      },
    });
    const top = defineSessionService({
      name: "top",
      deps: [base],
      create: ({ deps }) => ({ n: deps.base.n }),
      start: async (service, { sessionID, reason }) => {
        events.push(`top:${sessionID}:${reason}:${service.n}`);
      },
    });
    const kernel = createLifecycleKernel({
      extension: [],
      session: [top, base],
    });

    const first = await kernel.ensureSession("s1");
    const second = await kernel.ensureSession("s1");

    assert.equal(first, second);
    assert.equal(createCount, 1);
    assert.deepEqual(events, []);

    assert.equal(await kernel.notifySessionStart("s1", "session.start"), true);
    assert.deepEqual(events, [
      "base:s1:session.start:1",
      "top:s1:session.start:1",
    ]);

    // A repeated real start notifies again without rebuilding the session.
    assert.equal(await kernel.notifySessionStart("s1", "session.resume"), true);
    assert.equal(createCount, 1);
    assert.deepEqual(events, [
      "base:s1:session.start:1",
      "top:s1:session.start:1",
      "base:s1:session.resume:1",
      "top:s1:session.resume:1",
    ]);
  });

  it("refuses a start notification once the session stopped", async () => {
    const events: string[] = [];

    const service = defineSessionService({
      name: "service",
      deps: [],
      create: () => ({}),
      start: (_service, { reason }) => {
        events.push(`start:${reason}`);
      },
    });
    const kernel = createLifecycleKernel({ extension: [], session: [service] });

    assert.equal(await kernel.notifySessionStart("s1", "session.start"), true);
    await kernel.stopSession("s1", "session.idle");

    assert.equal(
      await kernel.notifySessionStart("s1", "session.resume"),
      false,
    );
    assert.deepEqual(events, ["start:session.start"]);
  });

  it("waits for an in-flight start notice before disposing", async () => {
    const events: string[] = [];
    const entered = deferred<void>();
    const gate = deferred<void>();

    const service = defineSessionService({
      name: "service",
      deps: [],
      create: () => ({}),
      start: async (_service, { reason }) => {
        events.push(`start:${reason}`);
        entered.resolve();
        await gate.promise;
        events.push("start-done");
      },
      dispose: (_service, { reason }) => {
        events.push(`dispose:${reason}`);
      },
    });
    const kernel = createLifecycleKernel({ extension: [], session: [service] });

    await kernel.ensureSession("s1");
    const notifying = kernel.notifySessionStart("s1", "session.start");
    await entered.promise;

    const stopping = kernel.stopSession("s1", "session.idle");
    const queued = kernel.notifySessionStart("s1", "session.resume");
    await Promise.resolve();

    assert.deepEqual(events, ["start:session.start"]);

    gate.resolve();
    assert.equal(await notifying, true);
    assert.equal(await queued, false);
    const report = await stopping;

    assert.deepEqual(report.errors, []);
    assert.deepEqual(events, [
      "start:session.start",
      "start-done",
      "dispose:session.idle",
    ]);
    assert.equal(await kernel.notifySessionStart("s1", "session.start"), false);
  });

  it("surfaces a failing start hook without breaking later notices", async () => {
    const events: string[] = [];

    const service = defineSessionService({
      name: "service",
      deps: [],
      create: () => ({}),
      start: (_service, { reason }) => {
        events.push(`start:${reason}`);
        throw new Error("hook-boom");
      },
      dispose: (_service, { reason }) => {
        events.push(`dispose:${reason}`);
      },
    });
    const kernel = createLifecycleKernel({ extension: [], session: [service] });

    await assert.rejects(
      kernel.notifySessionStart("s1", "session.start"),
      /hook-boom/,
    );
    await assert.rejects(
      kernel.notifySessionStart("s1", "session.resume"),
      /hook-boom/,
    );

    const report = await kernel.stopSession("s1", "session.idle");

    assert.deepEqual(report.errors, []);
    assert.deepEqual(events, [
      "start:session.start",
      "start:session.resume",
      "dispose:session.idle",
    ]);
  });

  it("lets extension stop wait for an in-flight notice and keep its reason", async () => {
    const events: string[] = [];
    const entered = deferred<void>();
    const gate = deferred<void>();

    const session = defineSessionService({
      name: "session",
      deps: [],
      create: () => ({}),
      start: async () => {
        entered.resolve();
        await gate.promise;
        events.push("start-done");
      },
      dispose: (_service, { reason }) => {
        events.push(`session:${reason}`);
      },
    });
    const ext = defineExtensionService({
      name: "ext",
      deps: [],
      create: () => ({}),
      dispose: (_service, { reason }) => {
        events.push(`ext:${reason}`);
      },
    });
    const kernel = createLifecycleKernel({
      extension: [ext],
      session: [session],
    });

    await kernel.ensureSession("s1");
    const notifying = kernel.notifySessionStart("s1", "session.start");
    await entered.promise;

    const stopping = kernel.stopExtension("host.shutdown");
    await Promise.resolve();
    assert.deepEqual(events, []);

    gate.resolve();
    assert.equal(await notifying, true);
    const report = await stopping;

    assert.deepEqual(report.errors, []);
    assert.deepEqual(events, [
      "start-done",
      "session:host.shutdown",
      "ext:host.shutdown",
    ]);
  });

  it("ignores an absent or blank session ID without running factories", async () => {
    let createCount = 0;
    const service = defineSessionService({
      name: "service",
      deps: [],
      create: () => {
        createCount += 1;
        return {};
      },
    });
    const kernel = createLifecycleKernel({ extension: [], session: [service] });

    assert.equal(await kernel.ensureSession(undefined), null);
    assert.equal(await kernel.ensureSession(null), null);
    assert.equal(await kernel.ensureSession("   "), null);
    assert.equal(await kernel.notifySessionStart(undefined, "start"), false);
    assert.deepEqual(
      (await kernel.stopSession(undefined, "session.stop")).errors,
      [],
    );
    assert.equal(createCount, 0);
  });

  it("stops a session that is still being created without handing it out", async () => {
    const started = deferred<void>();
    const gate = deferred<void>();
    const disposed: string[] = [];
    let createCount = 0;

    const slow = defineSessionService({
      name: "slow",
      deps: [],
      create: async () => {
        createCount += 1;
        started.resolve();
        await gate.promise;
        return { n: 1 };
      },
      dispose: () => {
        disposed.push("slow");
      },
    });
    const kernel = createLifecycleKernel({ extension: [], session: [slow] });

    const ensuring = kernel.ensureSession("s1");
    await started.promise;
    const stopping = kernel.stopSession("s1", "session.stop");
    gate.resolve();

    const [scope, report] = await Promise.all([ensuring, stopping]);

    assert.equal(scope, null);
    assert.deepEqual(disposed, ["slow"]);
    assert.deepEqual(report.errors, []);
    assert.equal(createCount, 1);

    // A late activation cannot resurrect the stopped session.
    assert.equal(await kernel.ensureSession("s1"), null);
    assert.equal(await kernel.notifySessionStart("s1", "late"), false);
    assert.equal(createCount, 1);
  });

  it("stopping an untouched kernel is a safe no-op", async () => {
    const kernel = createLifecycleKernel({ extension: [], session: [] });

    const first = await kernel.stopExtension("extension.stop");
    const second = await kernel.stopExtension("extension.stop");

    assert.deepEqual(first.errors, []);
    assert.deepEqual(second.errors, []);
    assert.equal(await kernel.ensureExtension(), null);
  });

  it("repeated stop is safe and disposes each resource once", async () => {
    let sessionDispose = 0;
    let extensionDispose = 0;

    const ext = defineExtensionService({
      name: "ext",
      deps: [],
      create: () => ({}),
      dispose: () => {
        extensionDispose += 1;
      },
    });
    const session = defineSessionService({
      name: "session",
      deps: [],
      create: () => ({}),
      dispose: () => {
        sessionDispose += 1;
      },
    });
    const kernel = createLifecycleKernel({
      extension: [ext],
      session: [session],
    });

    await kernel.ensureSession("s1");

    const first = await kernel.stopSession("s1", "session.stop");
    const second = await kernel.stopSession("s1", "session.stop");
    assert.deepEqual(first.errors, []);
    assert.deepEqual(second.errors, []);
    assert.equal(sessionDispose, 1);

    const extFirst = await kernel.stopExtension("extension.stop");
    const extSecond = await kernel.stopExtension("extension.stop");
    assert.deepEqual(extFirst.errors, []);
    assert.deepEqual(extSecond.errors, []);
    assert.equal(extensionDispose, 1);
    assert.equal(await kernel.ensureExtension(), null);
  });

  it("disposes services in reverse dependency order", async () => {
    const disposed: string[] = [];

    const base = defineExtensionService({
      name: "base",
      deps: [],
      create: () => ({}),
      dispose: () => {
        disposed.push("base");
      },
    });
    const middle = defineExtensionService({
      name: "middle",
      deps: [base],
      create: () => ({}),
      dispose: () => {
        disposed.push("middle");
      },
    });
    const top = defineExtensionService({
      name: "top",
      deps: [middle],
      create: () => ({}),
      dispose: () => {
        disposed.push("top");
      },
    });
    const sessionFirst = defineSessionService({
      name: "sessionFirst",
      deps: [],
      create: () => ({}),
      dispose: () => {
        disposed.push("sessionFirst");
      },
    });
    const sessionSecond = defineSessionService({
      name: "sessionSecond",
      deps: [sessionFirst],
      create: () => ({}),
      dispose: () => {
        disposed.push("sessionSecond");
      },
    });
    const kernel = createLifecycleKernel({
      extension: [top, middle, base],
      session: [sessionSecond, sessionFirst],
    });

    await kernel.ensureSession("s1");
    await kernel.stopSession("s1", "session.stop");
    assert.deepEqual(disposed, ["sessionSecond", "sessionFirst"]);

    disposed.length = 0;
    await kernel.stopExtension("extension.stop");
    assert.deepEqual(disposed, ["top", "middle", "base"]);
  });

  it("passes the stop reason through to every disposer", async () => {
    const events: string[] = [];

    const ext = defineExtensionService({
      name: "ext",
      deps: [],
      create: () => ({}),
      dispose: (_service, { reason }) => {
        events.push(`ext:${reason}`);
      },
    });
    const session = defineSessionService({
      name: "session",
      deps: [],
      create: () => ({}),
      dispose: (_service, { reason }) => {
        events.push(`session:${reason}`);
      },
    });
    const kernel = createLifecycleKernel({
      extension: [ext],
      session: [session],
    });

    await kernel.ensureSession("s1");
    await kernel.stopSession("s1", "session.idle");

    await kernel.ensureSession("s2");
    const report = await kernel.stopExtension("host.shutdown");

    assert.deepEqual(report.errors, []);
    assert.deepEqual(events, [
      "session:session.idle",
      "session:host.shutdown",
      "ext:host.shutdown",
    ]);
  });

  it("attempts every cleanup and reports each failure", async () => {
    const disposed: string[] = [];

    const ok = defineExtensionService({
      name: "ok",
      deps: [],
      create: () => ({}),
      dispose: () => {
        disposed.push("ok");
      },
    });
    const bad = defineExtensionService({
      name: "bad",
      deps: [],
      create: () => ({}),
      dispose: () => {
        throw new Error("ext-dispose-failed");
      },
    });
    const sessionBad = defineSessionService({
      name: "sessionBad",
      deps: [],
      create: () => ({}),
      dispose: () => {
        throw new Error("session-dispose-failed");
      },
    });
    const kernel = createLifecycleKernel({
      extension: [ok, bad],
      session: [sessionBad],
    });

    await kernel.ensureSession("s1");
    const sessionReport = await kernel.stopSession("s1", "session.stop");
    assert.equal(sessionReport.errors.length, 1);
    assert.equal(sessionReport.errors[0]?.scope, "session");
    assert.equal(sessionReport.errors[0]?.sessionID, "s1");
    assert.equal(sessionReport.errors[0]?.service, "sessionBad");

    const report = await kernel.stopExtension("extension.stop");
    assert.deepEqual(disposed, ["ok"]);
    assert.equal(report.errors.length, 1);
    assert.equal(report.errors[0]?.scope, "extension");
    assert.equal(report.errors[0]?.service, "bad");
    assert.match(String(report.errors[0]?.error), /ext-dispose-failed/);
  });

  it("aborts an extension signal before disposing its services", async () => {
    let signal: AbortSignal | undefined;
    let disposed = false;

    const ext = defineExtensionService({
      name: "ext",
      deps: [],
      create: ({ signal: scopeSignal }) => {
        signal = scopeSignal;
        return {};
      },
      dispose: () => {
        disposed = true;
        assert.equal(signal?.aborted, true);
      },
    });
    const kernel = createLifecycleKernel({ extension: [ext], session: [] });

    await kernel.ensureExtension();
    assert.equal(signal?.aborted, false);

    await kernel.stopExtension("extension.stop");
    assert.equal(signal?.aborted, true);
    assert.equal(disposed, true);
  });

  it("aborts a session signal so service-owned work is cancelled", async () => {
    let signal: AbortSignal | undefined;
    let cancelled: Promise<void> | undefined;

    const service = defineSessionService({
      name: "service",
      deps: [],
      create: ({ signal: scopeSignal }) => {
        signal = scopeSignal;
        cancelled = new Promise((resolve) => {
          scopeSignal.addEventListener("abort", () => resolve(), {
            once: true,
          });
        });
        return {};
      },
    });
    const kernel = createLifecycleKernel({ extension: [], session: [service] });

    await kernel.ensureSession("s1");
    assert.equal(signal?.aborted, false);

    await kernel.stopSession("s1", "session.stop");
    assert.equal(signal?.aborted, true);
    await cancelled;
  });

  it("stops nested sessions before extension services on extension stop", async () => {
    const events: string[] = [];

    const ext = defineExtensionService({
      name: "ext",
      deps: [],
      create: () => ({}),
      dispose: () => {
        events.push("ext");
      },
    });
    const session = defineSessionService({
      name: "session",
      deps: [ext],
      create: ({ sessionID }) => ({ sessionID }),
      dispose: () => {
        events.push("session");
      },
    });
    const kernel = createLifecycleKernel({
      extension: [ext],
      session: [session],
    });

    const first = await kernel.ensureSession("s1");
    const second = await kernel.ensureSession("s2");
    assert.equal(first?.sessionID, "s1");
    assert.equal(second?.sessionID, "s2");

    const report = await kernel.stopExtension("extension.stop");
    assert.deepEqual(report.errors, []);
    assert.deepEqual(events, ["session", "session", "ext"]);

    assert.equal(await kernel.ensureSession("s3"), null);
    assert.equal(await kernel.notifySessionStart("s3", "late"), false);
  });

  it("propagates unexpected create errors and still cleans up created services", async () => {
    const disposed: string[] = [];

    const created = defineExtensionService({
      name: "created",
      deps: [],
      create: () => ({}),
      dispose: () => {
        disposed.push("created");
      },
    });
    const failing = defineExtensionService({
      name: "failing",
      deps: [created],
      create: () => {
        throw new Error("create-boom");
      },
    });
    const kernel = createLifecycleKernel({
      extension: [created, failing],
      session: [],
    });

    await assert.rejects(kernel.ensureExtension(), /create-boom/);
    assert.deepEqual(disposed, ["created"]);
  });

  it("propagates session create errors and cleans up partial work", async () => {
    const disposed: string[] = [];

    const created = defineSessionService({
      name: "created",
      deps: [],
      create: () => ({}),
      dispose: () => {
        disposed.push("created");
      },
    });
    const failing = defineSessionService({
      name: "failing",
      deps: [created],
      create: () => {
        throw new Error("session-create-boom");
      },
    });
    const kernel = createLifecycleKernel({
      extension: [],
      session: [created, failing],
    });

    const results = await Promise.allSettled([
      kernel.ensureSession("s1"),
      kernel.ensureSession("s1"),
    ]);

    for (const result of results) {
      assert.equal(result.status, "rejected");
      if (result.status === "rejected") {
        assert.match(String(result.reason), /session-create-boom/);
      }
    }
    assert.deepEqual(disposed, ["created"]);
  });

  it("reports cleanup failures alongside an extension create failure", async () => {
    const created = defineExtensionService({
      name: "created",
      deps: [],
      create: () => ({}),
      dispose: () => {
        throw new Error("cleanup-boom");
      },
    });
    const failing = defineExtensionService({
      name: "failing",
      deps: [created],
      create: () => {
        throw new Error("create-boom");
      },
    });
    const kernel = createLifecycleKernel({
      extension: [created, failing],
      session: [],
    });

    await assert.rejects(
      kernel.ensureExtension(),
      (error) =>
        error instanceof AggregateError &&
        error.errors.some(
          (inner) => inner instanceof Error && inner.message === "create-boom",
        ) &&
        error.errors.some(
          (inner) => inner instanceof Error && inner.message === "cleanup-boom",
        ),
    );
  });

  it("rejects ambiguous, missing, and cyclic definitions", () => {
    const a = defineExtensionService({
      name: "a",
      deps: [],
      create: () => ({}),
    });
    const duplicate = defineExtensionService({
      name: "a",
      deps: [],
      create: () => ({}),
    });
    const absent = defineExtensionService({
      name: "absent",
      deps: [],
      create: () => ({}),
    });
    const missing = defineExtensionService({
      name: "missing",
      deps: [absent],
      create: () => ({}),
    });
    const cycleA = defineExtensionService({
      name: "cycleA",
      deps: [] as AnyExtensionServiceDefinition[],
      create: () => ({}),
    });
    const cycleB = defineExtensionService({
      name: "cycleB",
      deps: [cycleA],
      create: () => ({}),
    });
    // Build the back edge after both declarations exist.
    (cycleA.deps as unknown[]).push(cycleB);

    assert.throws(
      () => createLifecycleKernel({ extension: [a, duplicate], session: [] }),
      LifecycleDefinitionError,
    );
    assert.throws(
      () => createLifecycleKernel({ extension: [missing], session: [] }),
      LifecycleDefinitionError,
    );
    const sessionDuplicate = defineSessionService({
      name: "sessionDuplicate",
      deps: [],
      create: () => ({}),
    });
    assert.throws(
      () =>
        createLifecycleKernel({
          extension: [],
          session: [sessionDuplicate, sessionDuplicate],
        }),
      LifecycleDefinitionError,
    );
    assert.throws(
      () => createLifecycleKernel({ extension: [cycleA, cycleB], session: [] }),
      LifecycleDefinitionError,
    );
    assert.throws(
      () =>
        createLifecycleKernel({
          extension: [a],
          session: [
            defineSessionService({
              name: "a",
              deps: [],
              create: () => ({}),
            }),
          ],
        }),
      LifecycleDefinitionError,
    );
  });
});
