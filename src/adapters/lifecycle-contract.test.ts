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
 * The same holds for the per-instance session records both hosts declare:
 * the catalog's declarations reach the stop path through each host's own
 * session scope, so a pi shutdown releases their runtime state while an
 * OpenCode deletion removes every record.  The last block asserts that from
 * the host entry points, including a deletion of a session no scope owned.
 */
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { afterEach, beforeEach, describe, it } from "node:test";
import { createConfigScope } from "../core/config-snapshot.js";
import { project } from "../core/context/lens.js";
import {
  type ContextRuntime,
  createContextRuntime,
} from "../core/context/runtime.js";
import { createStateStore, type StateStore } from "../core/context/store.js";
import {
  type CleanupReport,
  createLifecycleKernel,
  defineExtensionService,
  defineSessionService,
} from "../core/lifecycle/index.js";
import { createSessionAgentResource } from "../core/session/agent.js";
import {
  contextSessionResources,
  createSessionResourceCatalog,
  type SessionResourceCatalog,
} from "../core/session/resources.js";
import { permitFor } from "../testkits/context-runtime.js";
import { piScope } from "../testkits/pi-wiring.js";
import { makeTmpDir } from "../testkits/tmp.js";
import { createOpenCodeLifecycleMapping } from "./opencode/lifecycle.js";
import { createOpenCodeLifecycleWiring } from "./opencode/lifecycle-wiring.js";
import { createOpenCodeHostServices } from "./opencode/services.js";
import { createPiLifecycleMapping } from "./pi/lifecycle.js";
import { createPiLifecycleWiring } from "./pi/lifecycle-wiring.js";
import { createPiProcessState, type PiProcessState } from "./pi/process.js";
import { createPiHostServices, type PiServiceHost } from "./pi/services.js";
import { buildPiCapabilities } from "./pi/wire.js";

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

/** The process state every instance under test runs over (one per test). */
let piProcess: PiProcessState;

/** The plugin instance under test. */
let runtime: ContextRuntime;
let sessionCatalog: SessionResourceCatalog;

beforeEach(() => {
  piProcess = createPiProcessState();
});

afterEach(() => {
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
  runtime = createContextRuntime(store);
  sessionCatalog = createSessionResourceCatalog([
    ...contextSessionResources(runtime),
    createSessionAgentResource(piProcess.sessionAgents),
  ]);
  return store;
}

/**
 * Give one session every record the catalog declares.
 *
 * @param sessionID - The session to stage.
 * @returns Resolves once the state commit landed.
 */
async function stageRecords(sessionID: string): Promise<void> {
  const permit = permitFor(sessionID);
  await runtime.commit(permit, (state) => {
    state.blocks.set(1, {
      start: 0,
      end: 3,
      summary: "kept",
      spanHash: "ffff0000",
      status: "active",
      compressedTokens: 100,
      summaryTokens: 20,
      createdAt: 1000,
    });
    state.pendingViewChange = true;
  });
  piProcess.sessionAgents.bind(sessionID, AGENT);
  runtime.setModelLimit(permit, 1000, "model");
  runtime.publishRoundView(sessionID, {
    projection: project([], []),
    numbered: [],
  });
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
    piProcess.sessionAgents.resolve(sessionID),
    AGENT,
    "a runtime release keeps the agent binding",
  );
  assert.equal(runtime.modelLimit(sessionID), undefined);
  assert.equal(runtime.roundView(sessionID), undefined);
  assert.equal(
    runtime.read(permitFor(sessionID), (state) => state.pendingViewChange),
    undefined,
    "the pending view change rides on the state cache",
  );
}

/**
 * Assert the session holds no record at all.
 *
 * @param store - The sandbox store of the test.
 * @param sessionID - The session to inspect.
 */
function assertDeleted(store: StateStore, sessionID: string): void {
  assert.equal(store.load(sessionID).blocks.size, 0);
  assert.equal(piProcess.sessionAgents.resolve(sessionID), undefined);
  assert.equal(runtime.modelLimit(sessionID), undefined);
  assert.equal(runtime.roundView(sessionID), undefined);
  assert.equal(
    runtime.read(permitFor(sessionID), (state) => state.pendingViewChange),
    undefined,
    "the pending view change rides on the state cache",
  );
}

/** The host inputs pi's declarations need; no pi API means inert surfaces. */
function piHost(): PiServiceHost {
  const scope = piScope({});
  return {
    scope,
    process: piProcess,
    piApi: undefined,
    appendEntry: undefined,
    colorizeAgent: (name) => name,
    titleForRun: (run) => run.agent,
    borderColorizeForRun: () => undefined,
    contextRuntime: runtime,
    sessionCatalog,
    // A null profile composes no settle strategy, so this wiring declares
    // an engine-less loop session.
    capabilities: () => buildPiCapabilities(scope, piProcess),
  };
}

/** Wiring over pi's real declarations. */
function buildPiWiring() {
  const declarations = createPiHostServices(piHost());
  return createPiLifecycleWiring({
    extensionServices: declarations.extension,
    sessionServices: declarations.session,
    getSessionID: (ctx) => (ctx as { id?: string } | undefined)?.id,
  });
}

/** Wiring over OpenCode's real declarations. */
function buildOpenCodeWiring() {
  const declarations = createOpenCodeHostServices({
    scope: createConfigScope({}, {}),
    client: {},
    directory: "",
    process: piProcess,
    contextRuntime: runtime,
    sessionCatalog,
  });
  return createOpenCodeLifecycleWiring({
    extensionServices: declarations.extension,
    sessionServices: declarations.session,
    sessionCatalog,
  });
}

describe("host session record contract", () => {
  it("releases the runtime records of a pi shutdown", async () => {
    const store = sandboxStore();
    const wiring = buildPiWiring();
    await wiring.activateExtension();
    await wiring.ensureSession({ id: "s1" });
    await stageRecords("s1");

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
    await stageRecords("s1");

    await wiring.handleEvent(openCodeDeleted("s1"));

    assertDeleted(store, "s1");
  });

  it("releases the runtime records of an OpenCode dispose", async () => {
    const store = sandboxStore();
    const wiring = buildOpenCodeWiring();
    await wiring.ensureSession("s1");
    await stageRecords("s1");

    const report = await wiring.dispose();

    assert.deepEqual(report.errors, []);
    assertReleased(store, "s1");
  });

  it("deletes the persisted records of a session no scope owned", async () => {
    const store = sandboxStore();
    await stageRecords("ghost");
    // A later plugin instance: the persisted state and the agent binding
    // outlive the instance that wrote them, so its unknown-session
    // deletion still has to remove both.
    runtime = createContextRuntime(store);
    sessionCatalog = createSessionResourceCatalog([
      ...contextSessionResources(runtime),
      createSessionAgentResource(piProcess.sessionAgents),
    ]);
    const wiring = buildOpenCodeWiring();

    await wiring.handleEvent(openCodeDeleted("ghost"));

    assert.equal(store.load("ghost").blocks.size, 0);
    assert.equal(piProcess.sessionAgents.resolve("ghost"), undefined);
    assert.equal(
      store.load("ghost").blocks.size,
      0,
      "the deletion must not build a scope that writes the state back",
    );
  });
});

// ---------------------------------------------------------------------------
// Run ownership across a runtime stop
// ---------------------------------------------------------------------------

/**
 * Describe a run the way a producer writes it: one delegation of a session.
 *
 * @param id - The run id.
 * @param startedAt - The literal start time of the run.
 * @returns The `start` input.
 */
function runStart(id: string, startedAt: number) {
  return { id, agent: "lynx", parentSession: "s1", label: id, startedAt };
}

describe("host run scope contract", () => {
  it("ends only the pi runtime's own running runs on a shutdown", async () => {
    const wiring = buildPiWiring();
    const { services } = await wiring.activateExtension();
    services.runScope.start(runStart("call-live", 100));
    services.runScope.start(runStart("call-done", 200));
    services.runScope.finish("call-done", { status: "done", endedAt: 250 });
    services.runScope.restore({
      id: "call-history",
      agent: "beaver",
      parentSession: "s1",
      status: "error",
      startedAt: 50,
      endedAt: 60,
      error: "boom",
    });

    const report = await wiring.stopExtension({
      type: "session_shutdown",
      reason: "quit",
    });

    assert.deepEqual(report.errors, []);
    const live = piProcess.runs.get("call-live");
    assert.equal(live?.status, "aborted");
    assert.equal(typeof live?.endedAt, "number");
    assert.equal(live?.label, "call-live", "the abort keeps the metadata");
    assert.equal(piProcess.runs.get("call-done")?.status, "done");
    assert.equal(piProcess.runs.get("call-done")?.endedAt, 250);
    assert.equal(piProcess.runs.get("call-history")?.status, "error");
    assert.equal(piProcess.runs.get("call-history")?.error, "boom");
    assert.equal(
      piProcess.runs.topLevel("s1").length,
      3,
      "the process table keeps every record",
    );
  });

  it("keeps another pi runtime's runs running", async () => {
    const stopping = buildPiWiring();
    const staying = buildPiWiring();
    const stoppingScope = (await stopping.activateExtension()).services
      .runScope;
    const stayingScope = (await staying.activateExtension()).services.runScope;
    stoppingScope.start(runStart("call-a", 100));
    stayingScope.start(runStart("call-b", 200));

    await stopping.stopExtension({
      type: "session_shutdown",
      reason: "quit",
    });

    assert.equal(piProcess.runs.get("call-a")?.status, "aborted");
    assert.equal(piProcess.runs.get("call-b")?.status, "running");
  });

  it("shows a stopped runtime's runs as history after a reload", async () => {
    const first = buildPiWiring();
    (await first.activateExtension()).services.runScope.start(
      runStart("call-live", 100),
    );
    await first.stopExtension({ type: "session_shutdown", reason: "reload" });

    const reloaded = buildPiWiring();
    const scope = (await reloaded.activateExtension()).services.runScope;

    assert.deepEqual(
      scope.topLevel("s1").map((run) => run.id),
      ["call-live"],
      "the reloaded runtime reads the previous generation's run",
    );
    assert.equal(scope.get("call-live")?.status, "aborted");
    assert.deepEqual(
      scope.summary("s1"),
      { running: 0, done: 0, failed: 0, aborted: 1 },
      "the reloaded runtime shows no phantom running run",
    );
  });

  it("ends the OpenCode runtime's own running runs on a dispose", async () => {
    const wiring = buildOpenCodeWiring();
    const { services } = await wiring.activateExtension();
    services.runScope.start(runStart("call-live", 100));
    services.runScope.start(runStart("call-done", 200));
    services.runScope.finish("call-done", { status: "done", endedAt: 250 });

    const report = await wiring.dispose();

    assert.deepEqual(report.errors, []);
    assert.equal(piProcess.runs.get("call-live")?.status, "aborted");
    assert.equal(piProcess.runs.get("call-done")?.status, "done");
    assert.equal(piProcess.runs.topLevel("s1").length, 2);
  });

  it("reports a failing run-change subscriber and still ends every run", async () => {
    const wiring = buildPiWiring();
    const { services } = await wiring.activateExtension();
    services.runScope.start(runStart("call-1", 100));
    services.runScope.start(runStart("call-2", 200));
    const off = piProcess.runs.subscribe((change) => {
      if (change.runId === "call-1") throw new Error("repaint failed");
    });

    const report = await wiring.stopExtension({
      type: "session_shutdown",
      reason: "quit",
    });
    off();

    assert.equal(report.errors.length, 1);
    assert.equal(report.errors[0]?.service, "runScope");
    assert.match(String(report.errors[0]?.error), /repaint failed/);
    assert.equal(piProcess.runs.get("call-1")?.status, "aborted");
    assert.equal(piProcess.runs.get("call-2")?.status, "aborted");
  });
});
