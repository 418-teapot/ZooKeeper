/**
 * Tests for the pi lifecycle wiring (`lifecycle-wiring.ts`).
 *
 * The wiring is where pi's entry point meets the kernel: a session is
 * ensured on first observation without fabricating a start, a real
 * `session_start` notifies with pi's own reason, `session_shutdown` stops
 * the extension (nested sessions first) and reports cleanup failures, and a
 * stopped scope cannot be recreated by a late ensure.  The declarations are
 * injected here, so every assertion reads the kernel's observable effects.
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  type AnyExtensionServiceDefinition,
  type CleanupReport,
  defineExtensionService,
  defineSessionService,
} from "../../core/lifecycle/index.js";
import { _resetForTesting } from "../../utils/logger.js";
import {
  createPiLifecycleWiring,
  PI_SHUTDOWN_REASON,
  type PiLifecycleWiring,
} from "./lifecycle-wiring.js";
import {
  hasPiSdkSession,
  resetPiSdkLifecycleBridge,
  SDK_STOP_REASON,
  stopPiSdkSession,
} from "./sdk-lifecycle.js";

afterEach(() => {
  resetPiSdkLifecycleBridge();
  _resetForTesting();
});

/**
 * Build wiring over a recording session service.
 *
 * The service logs its creation, start and disposal, so the assertions read
 * the resource effects a pi event produces rather than the calls the wiring
 * makes.
 */
function buildWiring(
  log: string[],
  options: {
    failDispose?: boolean;
    extensionServices?: readonly AnyExtensionServiceDefinition[];
  } = {},
): PiLifecycleWiring {
  const worker = defineSessionService({
    name: "worker",
    deps: [],
    create: ({ sessionID }) => {
      log.push(`create:${sessionID}`);
      return { sessionID };
    },
    start: (service, { reason }) => {
      log.push(`start:${service.sessionID}:${reason}`);
    },
    dispose: (service, { reason }) => {
      log.push(`dispose:${service.sessionID}:${reason}`);
      if (options.failDispose === true) throw new Error("boom");
    },
  });
  return createPiLifecycleWiring({
    extensionServices: options.extensionServices ?? [],
    sessionServices: [worker],
    getSessionID: (ctx) => (ctx as { id?: string } | undefined)?.id,
  });
}

describe("pi lifecycle wiring", () => {
  it("activates the declared extension services before any session", async () => {
    const log: string[] = [];
    const live = defineExtensionService({
      name: "live",
      deps: [],
      create: () => {
        log.push("create:live");
        return { sessionID: (): string => "none" };
      },
    });
    const worker = defineSessionService({
      name: "worker",
      deps: [live],
      create: ({ sessionID }) => {
        log.push(`create:${sessionID}`);
        return { sessionID };
      },
    });
    const wiring = createPiLifecycleWiring({
      extensionServices: [live],
      sessionServices: [worker],
      getSessionID: (ctx) => (ctx as { id?: string } | undefined)?.id,
    });

    const extension = await wiring.activateExtension();

    // The kernel built the extension scope on demand, and no session exists
    // until an event names one.
    assert.deepEqual(log, ["create:live"]);
    assert.equal(extension.services.live.sessionID(), "none");

    await wiring.ensureSession({ id: "s1" });
    assert.deepEqual(log, ["create:live", "create:s1"]);
  });

  it("refuses activation once the extension stopped", async () => {
    const log: string[] = [];
    const wiring = buildWiring(log);
    await wiring.stopExtension(undefined);

    // The extension scope is terminal: a late activation cannot resurrect
    // it, so the wiring reports the refusal instead of handing out an empty
    // scope.
    await assert.rejects(wiring.activateExtension(), /stopped/);
  });

  it("ensures a session without a start notice", async () => {
    const log: string[] = [];
    const wiring = buildWiring(log);

    assert.equal(await wiring.ensureSession({ id: "s1" }), true);
    assert.equal(await wiring.ensureSession({ id: "s1" }), true);

    // One creation, no start hook: a first-use ensure never fakes a start.
    assert.deepEqual(log, ["create:s1"]);
  });

  it("creates nothing when the event carries no session id", async () => {
    const log: string[] = [];
    const wiring = buildWiring(log);

    const ensured = await Promise.all([
      wiring.ensureSession(undefined),
      wiring.ensureSession({}),
      wiring.ensureSession({ id: "" }),
      wiring.ensureSession({ id: "   " }),
    ]);

    assert.deepEqual(ensured, [false, false, false, false]);
    assert.deepEqual(log, []);
  });

  it("notifies a real start with pi's reason", async () => {
    const log: string[] = [];
    const wiring = buildWiring(log);

    const outcome = await wiring.startSession(
      { type: "session_start", reason: "resume" },
      { id: "s1" },
    );

    assert.deepEqual(outcome, { action: "start", started: true });
    assert.deepEqual(log, ["create:s1", "start:s1:resume"]);
  });

  it("reuses the scope on a repeated start but re-runs the hook", async () => {
    const log: string[] = [];
    const wiring = buildWiring(log);

    await wiring.startSession(
      { type: "session_start", reason: "startup" },
      { id: "s1" },
    );
    await wiring.startSession(
      { type: "session_start", reason: "reload" },
      { id: "s1" },
    );

    // pi re-seeds on every bind: the scope is reused, the notice re-runs.
    assert.deepEqual(log, ["create:s1", "start:s1:startup", "start:s1:reload"]);
  });

  it("only ensures when the payload carries no start reason", async () => {
    const log: string[] = [];
    const wiring = buildWiring(log);

    const outcome = await wiring.startSession(
      { type: "session_start" },
      {
        id: "s1",
      },
    );

    assert.deepEqual(outcome, { action: "none" });
    assert.deepEqual(log, ["create:s1"]);
  });

  it("stops the extension on shutdown and reports cleanup failures", async () => {
    const log: string[] = [];
    const wiring = buildWiring(log, { failDispose: true });
    await wiring.startSession(
      { type: "session_start", reason: "startup" },
      { id: "s1" },
    );

    const report = await wiring.stopExtension({
      type: "session_shutdown",
      reason: "quit",
    });

    assert.deepEqual(log.slice(2), ["dispose:s1:quit"]);
    assert.equal(report.errors.length, 1);
    assert.deepEqual(
      {
        scope: report.errors[0]?.scope,
        sessionID: report.errors[0]?.sessionID,
        service: report.errors[0]?.service,
      },
      { scope: "session", sessionID: "s1", service: "worker" },
    );

    // A repeated stop stays report-based (the kernel replays its final
    // report) and disposes nothing twice.
    const repeated = await wiring.stopExtension({
      type: "session_shutdown",
      reason: "quit",
    });
    assert.deepEqual(repeated.errors, report.errors);
    assert.equal(log.filter((entry) => entry.startsWith("dispose:")).length, 1);
  });

  it("stops with the host reason when the payload is malformed", async () => {
    const log: string[] = [];
    const wiring = buildWiring(log);
    await wiring.ensureSession({ id: "s1" });

    const report = await wiring.stopExtension(undefined);

    assert.deepEqual(log, ["create:s1", `dispose:s1:${PI_SHUTDOWN_REASON}`]);
    assert.deepEqual(report, { errors: [] });
  });

  it("never recreates a scope after it stopped", async () => {
    const log: string[] = [];
    const wiring = buildWiring(log);
    await wiring.startSession(
      { type: "session_start", reason: "startup" },
      { id: "s1" },
    );
    await wiring.stopExtension({ type: "session_shutdown", reason: "quit" });
    const afterStop = [...log];

    // A late event first observing the same id must not resurrect it.
    assert.equal(await wiring.ensureSession({ id: "s1" }), false);
    const outcome = await wiring.startSession(
      { type: "session_start", reason: "resume" },
      { id: "s1" },
    );

    assert.deepEqual(outcome, { action: "start", started: false });
    assert.deepEqual(log, afterStop);
  });

  it("associates ensured sessions with the SDK bridge", async () => {
    const log: string[] = [];
    const wiring = buildWiring(log);
    await wiring.ensureSession({ id: "s1" });
    assert.equal(hasPiSdkSession("s1"), true);

    // The driver's explicit teardown reaches the scope this extension owns.
    const report = await stopPiSdkSession("s1");
    assert.deepEqual(report, { errors: [] });
    assert.deepEqual(log, ["create:s1", `dispose:s1:${SDK_STOP_REASON}`]);
    assert.equal(hasPiSdkSession("s1"), false);
  });

  it("associates the scope a real start created with the SDK bridge", async () => {
    const log: string[] = [];
    const extension = defineExtensionService({
      name: "ext",
      deps: [],
      create: () => {
        log.push("create:ext");
        return {};
      },
      dispose: (_service, { reason }) => {
        log.push(`dispose:ext:${reason}`);
      },
    });
    const wiring = buildWiring(log, { extensionServices: [extension] });

    // The only event this extension ever sees is the real start: nothing
    // ensures the session afterwards, so the start itself must leave the
    // association behind.
    const outcome = await wiring.startSession(
      { type: "session_start", reason: "startup" },
      { id: "s1" },
    );
    assert.deepEqual(outcome, { action: "start", started: true });

    const report = await stopPiSdkSession("s1");

    assert.deepEqual(report, { errors: [] });
    assert.deepEqual(log, [
      "create:ext",
      "create:s1",
      "start:s1:startup",
      `dispose:s1:${SDK_STOP_REASON}`,
      `dispose:ext:${SDK_STOP_REASON}`,
    ]);
    assert.equal(hasPiSdkSession("s1"), false);
  });

  it("stops the owning extension and its nested sessions on an SDK dispose", async () => {
    const log: string[] = [];
    const extension = defineExtensionService({
      name: "ext",
      deps: [],
      create: () => {
        log.push("create:ext");
        return {};
      },
      dispose: (_service, { reason }) => {
        log.push(`dispose:ext:${reason}`);
      },
    });
    const wiring = buildWiring(log, { extensionServices: [extension] });
    await wiring.ensureSession({ id: "s1" });
    await wiring.ensureSession({ id: "s2" });

    // The SDK driver disposes one session; the scope it belongs to is the
    // extension that ensured it, so every nested session and the extension
    // services stop with it — and pi's own shutdown reason is never faked.
    const report = await stopPiSdkSession("s1");

    assert.deepEqual(report, { errors: [] });
    assert.deepEqual(log, [
      "create:ext",
      "create:s1",
      "create:s2",
      `dispose:s1:${SDK_STOP_REASON}`,
      `dispose:s2:${SDK_STOP_REASON}`,
      `dispose:ext:${SDK_STOP_REASON}`,
    ]);
  });

  it("stops only the extension of the association that is current", async () => {
    const firstLog: string[] = [];
    const secondLog: string[] = [];
    const first = buildWiring(firstLog);
    const second = buildWiring(secondLog);

    // A replacement extension instance takes the same session id over.
    await first.ensureSession({ id: "s1" });
    await second.ensureSession({ id: "s1" });

    await stopPiSdkSession("s1");

    assert.deepEqual(firstLog, ["create:s1"], "the stale owner stays live");
    assert.deepEqual(secondLog, ["create:s1", `dispose:s1:${SDK_STOP_REASON}`]);
  });

  it("drops the owner's other associations once its extension stopped", async () => {
    const log: string[] = [];
    const wiring = buildWiring(log);
    await wiring.ensureSession({ id: "s1" });
    await wiring.ensureSession({ id: "s2" });

    await stopPiSdkSession("s1");

    // The extension is terminal, so its remaining associations are gone: a
    // later SDK dispose cannot reach a stopped scope.
    assert.equal(hasPiSdkSession("s2"), false);
    const report = await stopPiSdkSession("s2");
    assert.deepEqual(report, { errors: [] });
    assert.equal(log.filter((entry) => entry.startsWith("dispose:")).length, 2);
  });

  it("releases its associations when the extension stops", async () => {
    const log: string[] = [];
    const wiring = buildWiring(log);
    await wiring.ensureSession({ id: "s1" });

    await wiring.stopExtension({ type: "session_shutdown", reason: "quit" });

    assert.equal(hasPiSdkSession("s1"), false);
    // Nothing is left to stop through the SDK bridge.
    const report: CleanupReport = await stopPiSdkSession("s1");
    assert.deepEqual(report, { errors: [] });
    assert.deepEqual(log, ["create:s1", "dispose:s1:quit"]);
  });
});
