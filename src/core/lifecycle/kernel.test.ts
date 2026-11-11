/**
 * Tests for the host-agnostic lifecycle kernel (`kernel.ts`).
 *
 * The kernel owns resource lifetime only: extension services start once,
 * every session nests inside that extension, session creation is lazy and
 * idempotent, and stopping disposes in reverse dependency order while
 * reporting every cleanup failure.  Real session starts are a separate
 * notification path so a first-use `ensureSession` can never fabricate a
 * start reason.  A session stop carries its reason (diagnostics) and its
 * mode (what the stop does); an extension stop releases the runtime of the
 * sessions nested in it.
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
  type WorkPermit,
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
    await kernel.stopSession("s1", "session.idle", "release-runtime");

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

    const stopping = kernel.stopSession(
      "s1",
      "session.idle",
      "release-runtime",
    );
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

    const report = await kernel.stopSession(
      "s1",
      "session.idle",
      "release-runtime",
    );

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
      (await kernel.stopSession(undefined, "session.stop", "release-runtime"))
        .errors,
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
    const stopping = kernel.stopSession(
      "s1",
      "session.stop",
      "release-runtime",
    );
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

    const first = await kernel.stopSession(
      "s1",
      "session.stop",
      "release-runtime",
    );
    const second = await kernel.stopSession(
      "s1",
      "session.stop",
      "release-runtime",
    );
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
    await kernel.stopSession("s1", "session.stop", "release-runtime");
    assert.deepEqual(disposed, ["sessionSecond", "sessionFirst"]);

    disposed.length = 0;
    await kernel.stopExtension("extension.stop");
    assert.deepEqual(disposed, ["top", "middle", "base"]);
  });

  it("passes the stop reason and mode through to the disposers", async () => {
    const events: string[] = [];

    const ext = defineExtensionService({
      name: "ext",
      deps: [],
      create: () => ({}),
      dispose: (_service, context) => {
        events.push(`ext:${context.reason}`);
        assert.equal("mode" in context, false, "an extension stop has no mode");
      },
    });
    const session = defineSessionService({
      name: "session",
      deps: [],
      create: () => ({}),
      dispose: (_service, { reason, mode }) => {
        events.push(`session:${reason}:${mode}`);
      },
    });
    const kernel = createLifecycleKernel({
      extension: [ext],
      session: [session],
    });

    await kernel.ensureSession("s1");
    await kernel.stopSession("s1", "session.idle", "delete-session");

    await kernel.ensureSession("s2");
    const report = await kernel.stopExtension("host.shutdown");

    assert.deepEqual(report.errors, []);
    assert.deepEqual(events, [
      "session:session.idle:delete-session",
      // An extension stop releases the runtime; it never ends a session.
      "session:host.shutdown:release-runtime",
      "ext:host.shutdown",
    ]);
  });

  it("keeps the mode of an in-flight deletion when the extension stops", async () => {
    const events: string[] = [];
    const entered = deferred<void>();
    const gate = deferred<void>();

    const session = defineSessionService({
      name: "session",
      deps: [],
      create: () => ({}),
      dispose: async (_service, { reason, mode }) => {
        events.push(`dispose:${reason}:${mode}`);
        entered.resolve();
        await gate.promise;
      },
    });
    const kernel = createLifecycleKernel({ extension: [], session: [session] });

    await kernel.ensureSession("s1");
    const deleting = kernel.stopSession(
      "s1",
      "session.deleted",
      "delete-session",
    );
    await entered.promise;

    // The plugin dispose joins the deletion it must not downgrade.
    const disposing = kernel.stopExtension("dispose");
    gate.resolve();

    const [deleted, disposed] = await Promise.all([deleting, disposing]);

    assert.deepEqual(events, ["dispose:session.deleted:delete-session"]);
    assert.deepEqual([deleted.errors, disposed.errors], [[], []]);
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
    const sessionReport = await kernel.stopSession(
      "s1",
      "session.stop",
      "release-runtime",
    );
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

    await kernel.stopSession("s1", "session.stop", "release-runtime");
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

  it("aborts the failed extension signal, and a stop keeps it terminal", async () => {
    let creates = 0;
    const signals: AbortSignal[] = [];

    const created = defineExtensionService({
      name: "created",
      deps: [],
      create: ({ signal }) => {
        signals.push(signal);
        return {};
      },
    });
    const failing = defineExtensionService({
      name: "failing",
      deps: [created],
      create: ({ signal }) => {
        signals.push(signal);
        creates += 1;
        throw new Error("create-boom");
      },
    });
    const kernel = createLifecycleKernel({
      extension: [created, failing],
      session: [],
    });

    await assert.rejects(kernel.ensureExtension(), /create-boom/);
    assert.deepEqual(
      signals.map((signal) => signal.aborted),
      [true, true],
      "the failed scope's signal is aborted for every service it built",
    );

    // The start that failed closes the runtime: a later ensure must not
    // rebuild the scope it already gave up on.
    assert.deepEqual(await kernel.stopExtension("start.failed"), {
      errors: [],
    });
    assert.equal(await kernel.ensureExtension(), null);
    assert.equal(creates, 1, "nothing is rebuilt after the failure");
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

describe("lifecycle work permits", () => {
  it("runs the first session work after lazily creating the scope", async () => {
    const created: string[] = [];
    const service = defineSessionService({
      name: "service",
      deps: [],
      create: ({ sessionID }) => {
        created.push(sessionID);
        return { value: 1 };
      },
    });
    const kernel = createLifecycleKernel({ extension: [], session: [service] });

    const value = await kernel.runSession("s1", (scope, permit) => {
      assert.equal(scope.sessionID, "s1");
      assert.equal(scope.services.service.value, 1);
      assert.deepEqual(
        { sessionID: permit.sessionID, active: permit.isActive() },
        { sessionID: "s1", active: true },
      );
      assert.equal(permit.signal.aborted, false);
      return "done";
    });

    assert.equal(value, "done");
    assert.deepEqual(created, ["s1"]);
  });

  it("refuses work for invalid, stopped, and cancelled calls", async () => {
    let calls = 0;
    const run = () => {
      calls += 1;
      return "ran";
    };
    const kernel = createLifecycleKernel({ extension: [], session: [] });

    assert.equal(await kernel.runSession(undefined, run), undefined);
    assert.equal(await kernel.runSession(null, run), undefined);
    assert.equal(await kernel.runSession("   ", run), undefined);

    await kernel.ensureSession("s1");
    await kernel.stopSession("s1", "session.stop", "release-runtime");
    assert.equal(await kernel.runSession("s1", run), undefined);

    const cancelled = new AbortController();
    cancelled.abort();
    assert.equal(
      await kernel.runSession("s2", run, cancelled.signal),
      undefined,
    );
    assert.equal(calls, 0);
  });

  it("invalidates an admitted permit on stop and disposes after the work", async () => {
    const events: string[] = [];
    const entered = deferred<void>();
    const gate = deferred<void>();
    let permit: WorkPermit | undefined;

    const service = defineSessionService({
      name: "service",
      deps: [],
      create: () => ({}),
      dispose: () => {
        events.push("dispose");
      },
    });
    const kernel = createLifecycleKernel({ extension: [], session: [service] });

    const working = kernel.runSession("s1", async (_scope, issued) => {
      permit = issued;
      events.push("work");
      entered.resolve();
      await gate.promise;
      events.push(`after:${issued.isActive()}`);
      return "done";
    });

    await entered.promise;
    const stopping = kernel.stopSession(
      "s1",
      "session.stop",
      "release-runtime",
    );

    // The stop invalidates the permit before the work can return.
    assert.deepEqual(
      { active: permit?.isActive(), aborted: permit?.signal.aborted },
      { active: false, aborted: true },
    );
    await Promise.resolve();
    assert.deepEqual(events, ["work"]);

    gate.resolve();
    assert.equal(await working, "done");
    const report = await stopping;

    assert.deepEqual(report.errors, []);
    assert.deepEqual(events, ["work", "after:false", "dispose"]);
  });

  it("does not wait for a control operation to finish at stop", async () => {
    // The operation that STOPS a session cannot be waited on by that same
    // stop: waiting would deadlock the caller.  A control operation is
    // therefore admitted like session work, but no stop waits for it.
    const events: string[] = [];
    const entered = deferred<void>();
    const gate = deferred<void>();
    let permit: WorkPermit | undefined;

    const service = defineSessionService({
      name: "service",
      deps: [],
      create: () => ({}),
      dispose: () => {
        events.push("dispose");
      },
    });
    const kernel = createLifecycleKernel({ extension: [], session: [service] });

    const working = kernel.runControl("s1", async (_scope, issued) => {
      permit = issued;
      events.push("work");
      entered.resolve();
      await gate.promise;
      events.push(`after:${issued.isActive()}`);
      return "done";
    });

    await entered.promise;
    // The stop returns while the control operation is still running.
    const report = await kernel.stopSession(
      "s1",
      "session.stop",
      "release-runtime",
    );

    assert.deepEqual(report.errors, []);
    assert.deepEqual(events, ["work", "dispose"]);
    // The permit was revoked at once, like every other permit.
    assert.deepEqual(
      { active: permit?.isActive(), aborted: permit?.signal.aborted },
      { active: false, aborted: true },
    );

    gate.resolve();
    assert.equal(await working, "done");
  });

  it("never runs work that a stop overtakes during creation", async () => {
    const started = deferred<void>();
    const gate = deferred<void>();
    let calls = 0;

    const slow = defineSessionService({
      name: "slow",
      deps: [],
      create: async () => {
        started.resolve();
        await gate.promise;
        return {};
      },
    });
    const kernel = createLifecycleKernel({ extension: [], session: [slow] });

    const working = kernel.runSession("s1", () => {
      calls += 1;
      return "ran";
    });
    await started.promise;

    const stopping = kernel.stopSession(
      "s1",
      "session.stop",
      "release-runtime",
    );
    gate.resolve();

    assert.equal(await working, undefined);
    assert.equal(calls, 0);
    assert.deepEqual((await stopping).errors, []);
    assert.equal(await kernel.runSession("s1", () => "ran"), undefined);
    assert.equal(calls, 0);
  });

  it("refuses work when the stop starts in the same tick as admission", async () => {
    let calls = 0;
    const kernel = createLifecycleKernel({ extension: [], session: [] });
    await kernel.ensureSession("s1");

    const working = kernel.runSession("s1", () => {
      calls += 1;
      return "ran";
    });
    const stopping = kernel.stopSession(
      "s1",
      "session.stop",
      "release-runtime",
    );

    assert.equal(await working, undefined);
    assert.deepEqual((await stopping).errors, []);
    assert.equal(calls, 0);
  });

  it("cancels only the work whose caller signal aborts", async () => {
    const caller = new AbortController();
    const firstEntered = deferred<void>();
    const secondEntered = deferred<void>();
    const gate = deferred<void>();
    const events: string[] = [];

    const kernel = createLifecycleKernel({ extension: [], session: [] });

    const first = kernel.runSession(
      "s1",
      async (_scope, permit) => {
        firstEntered.resolve();
        await gate.promise;
        events.push(`first:${permit.isActive()}`);
      },
      caller.signal,
    );
    await firstEntered.promise;

    const second = kernel.runSession("s1", async (_scope, permit) => {
      secondEntered.resolve();
      await gate.promise;
      events.push(`second:${permit.isActive()}`);
    });
    await secondEntered.promise;

    caller.abort();
    assert.equal(
      await kernel.runSession("s1", () => "late", caller.signal),
      undefined,
    );

    gate.resolve();
    await Promise.all([first, second]);
    assert.deepEqual(events, ["first:false", "second:true"]);
  });

  it("keeps another session's permit active when one session stops", async () => {
    const otherEntered = deferred<void>();
    const gate = deferred<void>();
    const events: string[] = [];
    let otherPermit: WorkPermit | undefined;

    const kernel = createLifecycleKernel({ extension: [], session: [] });

    const first = kernel.runSession("s1", async (_scope, permit) => {
      await gate.promise;
      events.push(`s1:${permit.isActive()}`);
    });
    const second = kernel.runSession("s2", async (_scope, permit) => {
      otherPermit = permit;
      otherEntered.resolve();
      await gate.promise;
      events.push(`s2:${permit.isActive()}`);
    });
    await otherEntered.promise;

    const stopping = kernel.stopSession(
      "s1",
      "session.stop",
      "release-runtime",
    );
    assert.equal(otherPermit?.isActive(), true);
    assert.equal(otherPermit?.signal.aborted, false);

    gate.resolve();
    await Promise.all([first, second]);
    assert.deepEqual((await stopping).errors, []);
    assert.deepEqual(events, ["s1:false", "s2:true"]);
  });

  it("releases the permit when the work throws", async () => {
    const failure = new Error("work-boom");
    const kernel = createLifecycleKernel({ extension: [], session: [] });

    await assert.rejects(
      kernel.runSession("s1", () => {
        throw failure;
      }),
      (error) => error === failure,
    );

    const report = await kernel.stopSession(
      "s1",
      "session.stop",
      "release-runtime",
    );
    assert.deepEqual(report.errors, []);
  });

  it("invalidates every session permit when the extension stops", async () => {
    const firstEntered = deferred<void>();
    const secondEntered = deferred<void>();
    const gate = deferred<void>();
    const events: string[] = [];
    const disposed: string[] = [];
    let firstPermit: WorkPermit | undefined;
    let secondPermit: WorkPermit | undefined;

    const service = defineSessionService({
      name: "service",
      deps: [],
      create: ({ sessionID }) => ({ sessionID }),
      dispose: (service) => {
        disposed.push(service.sessionID);
      },
    });
    const kernel = createLifecycleKernel({ extension: [], session: [service] });

    const first = kernel.runSession("s1", async (_scope, permit) => {
      firstPermit = permit;
      firstEntered.resolve();
      await gate.promise;
      events.push(`work:${permit.isActive()}`);
    });
    const second = kernel.runSession("s2", async (_scope, permit) => {
      secondPermit = permit;
      secondEntered.resolve();
      await gate.promise;
      events.push(`work:${permit.isActive()}`);
    });
    await Promise.all([firstEntered.promise, secondEntered.promise]);

    const stopping = kernel.stopExtension("host.shutdown");
    assert.deepEqual(
      [firstPermit?.isActive(), secondPermit?.isActive()],
      [false, false],
    );
    assert.deepEqual(
      [firstPermit?.signal.aborted, secondPermit?.signal.aborted],
      [true, true],
    );

    await Promise.resolve();
    assert.deepEqual(events, []);

    gate.resolve();
    await Promise.all([first, second]);
    const report = await stopping;

    assert.deepEqual(report.errors, []);
    assert.deepEqual(events, ["work:false", "work:false"]);
    assert.deepEqual(disposed.sort(), ["s1", "s2"]);
    assert.equal(await kernel.runSession("s1", () => "ran"), undefined);
  });
});
