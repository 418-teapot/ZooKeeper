/**
 * Cross-host lifecycle contract test.
 *
 * pi and OpenCode name their events differently and stop different scopes,
 * but the same service declarations must produce the same resource
 * semantics through either mapping: one real start creates the extension
 * and session services once, a stop disposes them in reverse creation
 * order, a session without a usable id creates nothing, an unrelated event
 * does nothing, and a failing disposer is reported rather than swallowed.
 * The reasons and stop scopes stay host-specific and are asserted as
 * literals, so flattening them would fail here.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  type CleanupReport,
  createLifecycleKernel,
  defineExtensionService,
  defineSessionService,
} from "../core/lifecycle/index.js";
import { createOpenCodeLifecycleMapping } from "./opencode/lifecycle.js";
import { createPiLifecycleMapping } from "./pi/lifecycle.js";

/**
 * Build a kernel that records every creation, start and disposal call.
 *
 * Both mappings run against this same declaration set, so the logs
 * compare the resource effects the two hosts produce.
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

/**
 * Creation and disposal steps of a log, without the host-specific reasons.
 *
 * `start` entries are excluded because the reason vocabulary differs by
 * host by design.
 */
function traversal(log: readonly string[]): string[] {
  return log.flatMap((entry) => {
    const [step, service] = entry.split(":");
    return step === "create" || step === "dispose"
      ? [`${step}:${service}`]
      : [];
  });
}

/** pi keeps the session id on the event context, never on the event. */
function piContext(sessionID: string) {
  return { sessionManager: { getSessionId: () => sessionID } };
}

/** An OpenCode `session.created` payload. */
function openCodeCreated(sessionID: string) {
  return { type: "session.created", properties: { info: { id: sessionID } } };
}

/** An OpenCode `session.deleted` payload. */
function openCodeDeleted(sessionID: string) {
  return { type: "session.deleted", properties: { info: { id: sessionID } } };
}

describe("host lifecycle mapping contract", () => {
  it("maps one start and one stop to the same resource traversal", async () => {
    const piLog: string[] = [];
    const pi = createPiLifecycleMapping(buildKernel(piLog));
    await pi.handleEvent(
      { type: "session_start", reason: "startup" },
      piContext("session-1"),
    );
    await pi.handleEvent({ type: "session_shutdown", reason: "reload" });

    const openCodeLog: string[] = [];
    const openCode = createOpenCodeLifecycleMapping(buildKernel(openCodeLog));
    await openCode.handleEvent(openCodeCreated("session-1"));
    await openCode.handleEvent(openCodeDeleted("session-1"));
    await openCode.dispose();

    const expected = [
      "create:ext",
      "create:worker",
      "dispose:worker",
      "dispose:ext",
    ];
    assert.deepEqual(traversal(piLog), expected);
    assert.deepEqual(traversal(openCodeLog), expected);

    // Reasons and stop scopes stay host-specific instead of being smoothed.
    assert.deepEqual(piLog, [
      "create:ext",
      "create:worker:session-1",
      "start:worker:session-1:startup",
      "dispose:worker:session-1:reload",
      "dispose:ext:reload",
    ]);
    assert.deepEqual(openCodeLog, [
      "create:ext",
      "create:worker:session-1",
      "start:worker:session-1:session.created",
      "dispose:worker:session-1:session.deleted",
      "dispose:ext:dispose",
    ]);
  });

  it("creates nothing for a start without a usable session id", async () => {
    const piLog: string[] = [];
    const pi = createPiLifecycleMapping(buildKernel(piLog));
    const piOutcome = await pi.handleEvent(
      { type: "session_start", reason: "startup" },
      {},
    );

    const openCodeLog: string[] = [];
    const openCode = createOpenCodeLifecycleMapping(buildKernel(openCodeLog));
    const openCodeOutcome = await openCode.handleEvent({
      type: "session.created",
      properties: {},
    });

    assert.deepEqual(
      [piOutcome, openCodeOutcome],
      [
        { action: "start", started: false },
        { action: "start", started: false },
      ],
    );
    assert.deepEqual([...piLog, ...openCodeLog], []);
  });

  it("treats unrelated events as no-ops", async () => {
    const piLog: string[] = [];
    const pi = createPiLifecycleMapping(buildKernel(piLog));
    const piOutcomes = [
      await pi.handleEvent({ type: "agent_end" }),
      await pi.handleEvent(null),
    ];

    const openCodeLog: string[] = [];
    const openCode = createOpenCodeLifecycleMapping(buildKernel(openCodeLog));
    const openCodeOutcomes = [
      await openCode.handleEvent({ type: "session.idle" }),
      await openCode.handleEvent(null),
    ];

    for (const outcome of [...piOutcomes, ...openCodeOutcomes]) {
      assert.deepEqual(outcome, { action: "none" });
    }
    assert.deepEqual([...piLog, ...openCodeLog], []);
  });

  it("stops one session on OpenCode while pi stops nested sessions", async () => {
    // pi replaces its extension runtime, so the nested session stops too.
    const piLog: string[] = [];
    const pi = createPiLifecycleMapping(buildKernel(piLog));
    await pi.handleEvent(
      { type: "session_start", reason: "startup" },
      piContext("outer"),
    );
    await pi.handleEvent(
      { type: "session_start", reason: "startup" },
      piContext("nested"),
    );
    await pi.handleEvent({ type: "session_shutdown", reason: "fork" });

    assert.deepEqual(piLog.slice(5), [
      "dispose:worker:outer:fork",
      "dispose:worker:nested:fork",
      "dispose:ext:fork",
    ]);

    // OpenCode sessions are independent: deleting one leaves the other.
    const openCodeLog: string[] = [];
    const openCode = createOpenCodeLifecycleMapping(buildKernel(openCodeLog));
    await openCode.handleEvent(openCodeCreated("outer"));
    await openCode.handleEvent(openCodeCreated("nested"));
    const deleted = await openCode.handleEvent(openCodeDeleted("outer"));

    assert.deepEqual(openCodeLog.slice(5), [
      "dispose:worker:outer:session.deleted",
    ]);
    assert.deepEqual(deleted, {
      action: "stop-session",
      sessionID: "outer",
      report: { errors: [] },
    });

    await openCode.dispose();
    assert.deepEqual(openCodeLog.slice(6), [
      "dispose:worker:nested:dispose",
      "dispose:ext:dispose",
    ]);
  });

  it("reports cleanup failures on both hosts instead of throwing", async () => {
    const piLog: string[] = [];
    const pi = createPiLifecycleMapping(buildKernel(piLog, true));
    await pi.handleEvent(
      { type: "session_start", reason: "startup" },
      piContext("session-1"),
    );
    const piOutcome = await pi.handleEvent({
      type: "session_shutdown",
      reason: "quit",
    });

    const openCodeLog: string[] = [];
    const openCode = createOpenCodeLifecycleMapping(
      buildKernel(openCodeLog, true),
    );
    await openCode.handleEvent(openCodeCreated("session-1"));
    const openCodeReport = await openCode.dispose();

    assert.equal(piOutcome.action, "stop-extension");
    if (piOutcome.action !== "stop-extension") return;

    const failure = {
      scope: "session",
      sessionID: "session-1",
      service: "worker",
    };
    const firstError = (report: CleanupReport) => {
      const [error] = report.errors;
      return {
        scope: error?.scope,
        sessionID: error?.sessionID,
        service: error?.service,
      };
    };
    assert.deepEqual(
      [firstError(piOutcome.report), firstError(openCodeReport)],
      [failure, failure],
    );
    // Neither host skips the extension disposer after a failing session one.
    assert.ok(piLog.includes("dispose:ext:quit"));
    assert.ok(openCodeLog.includes("dispose:ext:dispose"));
  });
});
