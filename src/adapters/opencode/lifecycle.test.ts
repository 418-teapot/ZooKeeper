/**
 * Tests for the OpenCode lifecycle mapping (`lifecycle.ts`).
 *
 * OpenCode announces session creation and deletion separately and disposes
 * the plugin as a whole, so a deletion stops one session while the
 * plugin's own dispose stops the extension.  Neither session event carries
 * a reason, so the host event name is what the kernel records.  The
 * expectations below are the kernel's observable effects — factory,
 * `start` and disposer calls — plus the returned outcome.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createLifecycleKernel,
  defineExtensionService,
  defineSessionService,
} from "../../core/lifecycle/index.js";
import { createOpenCodeLifecycleMapping } from "./lifecycle.js";

/**
 * Build a kernel that records every creation, start and disposal call.
 *
 * The mapping runs against the real kernel, so the assertions read the
 * resource effects an OpenCode event produces rather than the calls the
 * mapping makes.
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

/** An OpenCode session event as the `event` hook receives it. */
function sessionEvent(type: string, id?: string) {
  return { type, properties: { info: id === undefined ? {} : { id } } };
}

describe("OpenCode lifecycle mapping", () => {
  it("starts the created session with the host event as the reason", async () => {
    const log: string[] = [];
    const mapping = createOpenCodeLifecycleMapping(buildKernel(log));

    const outcome = await mapping.handleEvent(
      sessionEvent("session.created", "session-1"),
    );

    assert.deepEqual(log, [
      "create:ext",
      "create:worker:session-1",
      "start:worker:session-1:session.created",
    ]);
    assert.deepEqual(outcome, { action: "start", started: true });
  });

  it("stops only the deleted session", async () => {
    const log: string[] = [];
    const mapping = createOpenCodeLifecycleMapping(buildKernel(log));
    await mapping.handleEvent(sessionEvent("session.created", "session-1"));
    await mapping.handleEvent(sessionEvent("session.created", "session-2"));

    const outcome = await mapping.handleEvent(
      sessionEvent("session.deleted", "session-1"),
    );

    // Two starts: `create:ext`, then each session's create and start.
    assert.deepEqual(log.slice(5), [
      "dispose:worker:session-1:session.deleted",
    ]);
    assert.deepEqual(outcome, {
      action: "stop-session",
      sessionID: "session-1",
      report: { errors: [] },
    });

    // The surviving session keeps its resources until its own stop.
    await mapping.dispose();
    assert.deepEqual(log.slice(6), [
      "dispose:worker:session-2:dispose",
      "dispose:ext:dispose",
    ]);
  });

  it("creates nothing when the event carries no usable session id", async () => {
    for (const event of [
      { type: "session.created" },
      { type: "session.created", properties: {} },
      sessionEvent("session.created"),
      { type: "session.created", properties: { info: { id: "" } } },
    ]) {
      const log: string[] = [];
      const mapping = createOpenCodeLifecycleMapping(buildKernel(log));

      const outcome = await mapping.handleEvent(event);

      assert.deepEqual(outcome, { action: "start", started: false });
      assert.deepEqual(log, []);
    }
  });

  it("does nothing for events it does not map", async () => {
    const log: string[] = [];
    const mapping = createOpenCodeLifecycleMapping(buildKernel(log));

    const outcomes = [
      await mapping.handleEvent(sessionEvent("session.updated", "session-1")),
      await mapping.handleEvent({ type: "session.idle" }),
      await mapping.handleEvent(null),
      await mapping.handleEvent(undefined),
      await mapping.handleEvent("session.deleted"),
    ];

    for (const outcome of outcomes) {
      assert.deepEqual(outcome, { action: "none" });
    }
    assert.deepEqual(log, []);
  });

  it("reports dispose cleanup failures instead of swallowing them", async () => {
    const log: string[] = [];
    const mapping = createOpenCodeLifecycleMapping(buildKernel(log, true));
    await mapping.handleEvent(sessionEvent("session.created", "session-1"));

    const report = await mapping.dispose();

    assert.equal(report.errors.length, 1);
    assert.deepEqual(
      {
        scope: report.errors[0]?.scope,
        sessionID: report.errors[0]?.sessionID,
        service: report.errors[0]?.service,
      },
      { scope: "session", sessionID: "session-1", service: "worker" },
    );
    // The extension disposer still ran after the failing session cleanup.
    assert.deepEqual(log.slice(3), [
      "dispose:worker:session-1:dispose",
      "dispose:ext:dispose",
    ]);
  });
});
