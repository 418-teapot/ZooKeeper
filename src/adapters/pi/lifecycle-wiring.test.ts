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
  defineExtensionService,
  defineSessionService,
} from "../../core/lifecycle/index.js";
import { _resetForTesting } from "../../utils/logger.js";
import {
  createPiLifecycleWiring,
  PI_SHUTDOWN_REASON,
  type PiLifecycleWiring,
} from "./lifecycle-wiring.js";

afterEach(() => {
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

  it("runs admitted work under the permit of the session the event names", async () => {
    const log: string[] = [];
    const wiring = buildWiring(log);
    const seen: string[] = [];

    const value = await wiring.runSession({ id: "s1" }, (permit) => {
      seen.push(`${permit.sessionID}:${permit.isActive()}`);
      return "done";
    });

    assert.equal(value, "done");
    assert.deepEqual(seen, ["s1:true"]);
    assert.deepEqual(log, ["create:s1"]);
  });

  it("runs nothing when the event carries no session id", async () => {
    const log: string[] = [];
    const wiring = buildWiring(log);
    let ran = 0;

    for (const ctx of [undefined, {}, { id: "" }, { id: "   " }]) {
      const value = await wiring.runSession(ctx, () => {
        ran += 1;
        return 1;
      });
      assert.equal(value, undefined);
    }

    assert.equal(ran, 0);
    assert.deepEqual(log, []);
  });

  it("runs nothing when the caller already cancelled", async () => {
    const log: string[] = [];
    const wiring = buildWiring(log);
    const caller = new AbortController();
    caller.abort();
    let ran = 0;

    const value = await wiring.runSession(
      { id: "s1" },
      () => {
        ran += 1;
        return 1;
      },
      caller.signal,
    );

    assert.equal(value, undefined);
    assert.equal(ran, 0);
    assert.deepEqual(log, []);
  });

  it("revokes a running permit at shutdown and waits for the work", async () => {
    const log: string[] = [];
    const wiring = buildWiring(log);
    let release: (() => void) | undefined;
    let aborted = false;
    const running = wiring.runSession({ id: "s1" }, async (permit) => {
      await new Promise<void>((resolve) => {
        release = resolve;
        permit.signal.addEventListener("abort", () => {
          aborted = true;
        });
      });
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const stopping = wiring.stopExtension({
      type: "session_shutdown",
      reason: "quit",
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    // The permit is revoked at once, and the scope is not disposed while
    // the admitted work still runs.
    assert.equal(aborted, true);
    assert.deepEqual(log, ["create:s1"]);

    release?.();
    await stopping;
    await running;
    assert.deepEqual(log, ["create:s1", "dispose:s1:quit"]);
  });

  it("admits nothing once the extension stopped", async () => {
    const log: string[] = [];
    const wiring = buildWiring(log);
    await wiring.runSession({ id: "s1" }, () => 1);
    await wiring.stopExtension({ type: "session_shutdown", reason: "quit" });
    let ran = 0;

    const value = await wiring.runSession({ id: "s1" }, () => {
      ran += 1;
      return 1;
    });

    assert.equal(value, undefined);
    assert.equal(ran, 0);
    assert.deepEqual(log, ["create:s1", "dispose:s1:quit"]);
  });
});
