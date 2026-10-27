/**
 * Tests for the pi lifecycle mapping (`lifecycle.ts`).
 *
 * The mapping is the only place pi's event vocabulary meets the kernel:
 * `session_start` becomes a real start notice for the session pi keeps on
 * the event context, `session_shutdown` becomes an extension stop because
 * pi tears its whole extension runtime down, and any other event is an
 * explicit no-op.  The expectations below are the kernel's observable
 * effects — factory, `start` and disposer calls — plus the returned
 * outcome, never a replay of the mapping's own branching.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createLifecycleKernel,
  defineExtensionService,
  defineSessionService,
} from "../../core/lifecycle/index.js";
import { createPiLifecycleMapping } from "./lifecycle.js";

/**
 * Build a kernel that records every creation, start and disposal call.
 *
 * The mapping runs against the real kernel, so the assertions read the
 * resource effects a pi event produces rather than the calls the mapping
 * makes.
 */
function buildKernel(log: string[], failSessionDispose = false) {
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
    dispose: (service, { reason }) => {
      log.push(`dispose:worker:${service.sessionID}:${reason}`);
      if (failSessionDispose) throw new Error("boom");
    },
  });
  return createLifecycleKernel({ extension: [extension], session: [session] });
}

/** pi keeps the session id on the event context, never on the event. */
function context(sessionID: string | undefined) {
  return { sessionManager: { getSessionId: () => sessionID } };
}

describe("pi lifecycle mapping", () => {
  it("starts the context's session with the host reason", async () => {
    const log: string[] = [];
    const mapping = createPiLifecycleMapping(buildKernel(log));

    const outcome = await mapping.handleEvent(
      { type: "session_start", reason: "resume" },
      context("session-1"),
    );

    assert.deepEqual(log, [
      "create:ext",
      "create:worker:session-1",
      "start:worker:session-1:resume",
    ]);
    assert.deepEqual(outcome, { action: "start", started: true });
  });

  it("forwards every pi start reason unchanged", async () => {
    for (const reason of ["startup", "reload", "new", "resume", "fork"]) {
      const log: string[] = [];
      const mapping = createPiLifecycleMapping(buildKernel(log));

      await mapping.handleEvent(
        { type: "session_start", reason },
        context("session-1"),
      );

      assert.deepEqual(log.slice(2), [`start:worker:session-1:${reason}`]);
    }
  });

  it("stops the extension with the shutdown reason", async () => {
    const log: string[] = [];
    const mapping = createPiLifecycleMapping(buildKernel(log));
    await mapping.handleEvent(
      { type: "session_start", reason: "startup" },
      context("session-1"),
    );

    const outcome = await mapping.handleEvent({
      type: "session_shutdown",
      reason: "quit",
    });

    assert.deepEqual(log.slice(3), [
      "dispose:worker:session-1:quit",
      "dispose:ext:quit",
    ]);
    assert.deepEqual(outcome, {
      action: "stop-extension",
      report: { errors: [] },
    });
  });

  it("creates nothing when no usable session id is available", async () => {
    for (const ctx of [undefined, {}, context(undefined), context("")]) {
      const log: string[] = [];
      const mapping = createPiLifecycleMapping(buildKernel(log));

      const outcome = await mapping.handleEvent(
        { type: "session_start", reason: "startup" },
        ctx,
      );

      assert.deepEqual(outcome, { action: "start", started: false });
      assert.deepEqual(log, []);
    }
  });

  it("does nothing for events it does not map", async () => {
    const log: string[] = [];
    const mapping = createPiLifecycleMapping(buildKernel(log));

    const outcomes = [
      await mapping.handleEvent({ type: "session_tree" }),
      await mapping.handleEvent({ type: "session_start" }),
      await mapping.handleEvent(null),
      await mapping.handleEvent(undefined),
      await mapping.handleEvent("session_shutdown"),
    ];

    for (const outcome of outcomes) {
      assert.deepEqual(outcome, { action: "none" });
    }
    assert.deepEqual(log, []);
  });

  it("reports cleanup failures instead of swallowing them", async () => {
    const log: string[] = [];
    const mapping = createPiLifecycleMapping(buildKernel(log, true));
    await mapping.handleEvent(
      { type: "session_start", reason: "startup" },
      context("session-1"),
    );

    const outcome = await mapping.handleEvent({
      type: "session_shutdown",
      reason: "quit",
    });

    assert.equal(outcome.action, "stop-extension");
    if (outcome.action !== "stop-extension") return;
    assert.equal(outcome.report.errors.length, 1);
    assert.deepEqual(
      {
        scope: outcome.report.errors[0]?.scope,
        sessionID: outcome.report.errors[0]?.sessionID,
        service: outcome.report.errors[0]?.service,
      },
      { scope: "session", sessionID: "session-1", service: "worker" },
    );
    // The extension disposer still ran after the failing session cleanup.
    assert.ok(log.includes("dispose:ext:quit"));
  });
});
