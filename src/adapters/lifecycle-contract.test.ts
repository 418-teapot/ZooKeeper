/**
 * Cross-host lifecycle contract test.
 *
 * pi and OpenCode name their events differently and stop different scopes,
 * but the same service declarations must produce the same resource
 * semantics through either mapping: one real start creates the extension
 * and session services once, a stop disposes them in reverse creation
 * order, a session without a usable id creates nothing, an unrelated event
 * does nothing, and a failing disposer is reported rather than swallowed.
 * The reasons, stop scopes and stop modes stay host-specific and are
 * asserted as literals, so flattening them would fail here: OpenCode
 * deletes a session, while pi only ever releases runtimes.
 *
 * The same holds for the process-level session records both hosts declare:
 * the catalog's declarations reach the stop path through each host's own
 * session scope, so a pi shutdown releases their runtime state while an
 * OpenCode deletion removes every record.  The last block asserts that from
 * the host entry points, including a deletion of a session no scope owned.
 */
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { afterEach, describe, it } from "node:test";
import { project } from "../core/context/lens.js";
import * as modelLimits from "../core/context/model-limits.js";
import { getRoundView, publishRoundView } from "../core/context/round-view.js";
import {
  _hasContextStateManagerForTesting,
  _resetContextStateManagerForTesting,
  consumePendingViewChange,
  getContextStateManager,
  setPendingViewChange,
} from "../core/context/runtime.js";
import { createStateStore, type StateStore } from "../core/context/store.js";
import {
  type CleanupReport,
  createLifecycleKernel,
  defineExtensionService,
  defineSessionService,
} from "../core/lifecycle/index.js";
import { sessionAgentRegistry } from "../core/session/agent.js";
import { makeTmpDir } from "../testkits/tmp.js";
import { createOpenCodeLifecycleMapping } from "./opencode/lifecycle.js";
import { createOpenCodeLifecycleWiring } from "./opencode/lifecycle-wiring.js";
import { createOpenCodeHostServices } from "./opencode/services.js";
import { createPiLifecycleMapping } from "./pi/lifecycle.js";
import { createPiLifecycleWiring } from "./pi/lifecycle-wiring.js";
import { createPiHostServices, type PiServiceHost } from "./pi/services.js";
import { buildPiContributions } from "./pi/wire.js";

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
    dispose: (service, { reason, mode }) => {
      log.push(`dispose:worker:${service.sessionID}:${reason}:${mode}`);
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
      "dispose:worker:session-1:reload:release-runtime",
      "dispose:ext:reload",
    ]);
    assert.deepEqual(openCodeLog, [
      "create:ext",
      "create:worker:session-1",
      "start:worker:session-1:session.created",
      "dispose:worker:session-1:session.deleted:delete-session",
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
    // A pi stop never deletes a session: both disposals release the runtime.
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
      "dispose:worker:outer:fork:release-runtime",
      "dispose:worker:nested:fork:release-runtime",
      "dispose:ext:fork",
    ]);

    // OpenCode sessions are independent: deleting one leaves the other, and
    // a deletion is the only stop that carries the `delete-session` mode.
    const openCodeLog: string[] = [];
    const openCode = createOpenCodeLifecycleMapping(buildKernel(openCodeLog));
    await openCode.handleEvent(openCodeCreated("outer"));
    await openCode.handleEvent(openCodeCreated("nested"));
    const deleted = await openCode.handleEvent(openCodeDeleted("outer"));

    assert.deepEqual(openCodeLog.slice(5), [
      "dispose:worker:outer:session.deleted:delete-session",
    ]);
    assert.deepEqual(deleted, {
      action: "stop-session",
      sessionID: "outer",
      report: { errors: [] },
    });

    await openCode.dispose();
    assert.deepEqual(openCodeLog.slice(6), [
      "dispose:worker:nested:dispose:release-runtime",
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

// ---------------------------------------------------------------------------
// Process-level session records
// ---------------------------------------------------------------------------

/** The agent the two hosts bind a session to in these tests. */
const AGENT = "dolphin";

/** Scratch store directories the current test created. */
const recordDirs: string[] = [];

afterEach(() => {
  _resetContextStateManagerForTesting();
  sessionAgentRegistry.clear();
  modelLimits._resetForTesting();
  for (const dir of recordDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * Bind the context runtime to a scratch store.
 *
 * @returns The sandbox store.
 */
function sandboxStore(): StateStore {
  const dir = makeTmpDir("zoo-lifecycle-contract");
  recordDirs.push(dir);
  const store = createStateStore(dir);
  _resetContextStateManagerForTesting(store);
  return store;
}

/**
 * Give one session every record the catalog declares.
 *
 * @param sessionID - The session to stage.
 */
function stageRecords(sessionID: string): void {
  const manager = getContextStateManager();
  manager.get(sessionID).blocks.set(1, {
    start: 0,
    end: 3,
    summary: "kept",
    spanHash: "ffff0000",
    status: "active",
    compressedTokens: 100,
    summaryTokens: 20,
    createdAt: 1000,
  });
  manager.save(sessionID);
  sessionAgentRegistry.bind(sessionID, AGENT);
  modelLimits.setModelLimit(sessionID, 1000, "model");
  setPendingViewChange(sessionID);
  publishRoundView(sessionID, { projection: project([], []), numbered: [] });
}

/**
 * Assert the runtime records are gone and the persisted ones survive.
 *
 * @param store - The sandbox store of the test.
 * @param sessionID - The session to inspect.
 */
function assertReleased(store: StateStore, sessionID: string): void {
  assert.equal(
    store.load(sessionID).blocks.get(1)?.summary,
    "kept",
    "a runtime release keeps the persisted context",
  );
  assert.equal(
    sessionAgentRegistry.resolve(sessionID),
    AGENT,
    "a runtime release keeps the agent binding",
  );
  assert.equal(modelLimits.getModelLimit(sessionID), undefined);
  assert.equal(getRoundView(sessionID), undefined);
  assert.equal(consumePendingViewChange(sessionID), false);
}

/**
 * Assert the session holds no record at all.
 *
 * @param store - The sandbox store of the test.
 * @param sessionID - The session to inspect.
 */
function assertDeleted(store: StateStore, sessionID: string): void {
  assert.equal(store.load(sessionID).blocks.size, 0);
  assert.equal(sessionAgentRegistry.resolve(sessionID), undefined);
  assert.equal(modelLimits.getModelLimit(sessionID), undefined);
  assert.equal(getRoundView(sessionID), undefined);
  assert.equal(consumePendingViewChange(sessionID), false);
}

/** The host inputs pi's declarations need; no pi API means inert surfaces. */
const PI_HOST: PiServiceHost = {
  piApi: undefined,
  appendEntry: undefined,
  colorizeAgent: (name) => name,
  titleForRun: (run) => run.agent,
  borderColorizeForRun: () => undefined,
  // A null profile composes no settle strategy, so this wiring declares an
  // engine-less loop session.
  composeProfile: () => buildPiContributions({}),
};

/** Wiring over pi's real declarations. */
function buildPiWiring() {
  const declarations = createPiHostServices(PI_HOST);
  return createPiLifecycleWiring({
    extensionServices: declarations.extension,
    sessionServices: declarations.session,
    getSessionID: (ctx) => (ctx as { id?: string } | undefined)?.id,
  });
}

/** Wiring over OpenCode's real declarations. */
function buildOpenCodeWiring() {
  const declarations = createOpenCodeHostServices({ onSettled: [] });
  return createOpenCodeLifecycleWiring({
    extensionServices: declarations.extension,
    sessionServices: declarations.session,
  });
}

describe("host session record contract", () => {
  it("releases the runtime records of a pi shutdown", async () => {
    const store = sandboxStore();
    const wiring = buildPiWiring();
    await wiring.activateExtension();
    await wiring.ensureSession({ id: "s1" });
    stageRecords("s1");

    const report = await wiring.stopExtension({
      type: "session_shutdown",
      reason: "quit",
    });

    assert.deepEqual(report.errors, []);
    assertReleased(store, "s1");
  });

  it("deletes every record of a session OpenCode deleted", async () => {
    const store = sandboxStore();
    const wiring = buildOpenCodeWiring();
    await wiring.ensureSession("s1");
    stageRecords("s1");

    await wiring.handleEvent(openCodeDeleted("s1"));

    assertDeleted(store, "s1");
  });

  it("releases the runtime records of an OpenCode dispose", async () => {
    const store = sandboxStore();
    const wiring = buildOpenCodeWiring();
    await wiring.ensureSession("s1");
    stageRecords("s1");

    const report = await wiring.dispose();

    assert.deepEqual(report.errors, []);
    assertReleased(store, "s1");
  });

  it("deletes the records of a session no scope owned", async () => {
    const store = sandboxStore();
    stageRecords("ghost");
    // A later plugin instance: the records outlive the manager.
    _resetContextStateManagerForTesting(store);
    const wiring = buildOpenCodeWiring();

    await wiring.handleEvent(openCodeDeleted("ghost"));

    assertDeleted(store, "ghost");
    assert.equal(
      _hasContextStateManagerForTesting(),
      false,
      "the deletion must not build a scope or a manager",
    );
  });
});
