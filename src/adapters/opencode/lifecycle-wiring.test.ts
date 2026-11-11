/**
 * Tests for the OpenCode lifecycle wiring (`lifecycle-wiring.ts`).
 *
 * The wiring owns one kernel per plugin instance: it creates a session
 * scope on first use (an event other than `session.created` may be the
 * first thing the host says about a session), maps the host's own session
 * events onto that kernel, and tears everything down on plugin dispose.
 * The expectations below are the resources created and disposed, plus the
 * process-level records a deletion drops — never the wiring's internal
 * bookkeeping.
 *
 * Two boundaries get their own assertions: a deletion drops a session
 * exactly once whether or not a scope existed, and a dispose keeps the
 * persisted context of the sessions it stops because those sessions still
 * exist on the host side.  The two stops also differ by mode: the deletion
 * stops with `delete-session`, the dispose with `release-runtime`.  A
 * deletion that overlaps a running dispose still deletes the session, a
 * repeated deletion stays idempotent, and one failing record leaves the
 * other records applied and the failure reported.
 *
 * `withSessionWork` gets the same kind of assertions: every hook, tool and
 * per-session event enters through its session's permit, a call without a
 * live session runs nothing, and a stop cancels and awaits the work it
 * admits.  A session lifetime event bypasses that admission, because the
 * deletion of a stopped session still has to run.
 */
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { afterEach, beforeEach, describe, it } from "node:test";
import { createConfigScope } from "../../core/config-snapshot.js";
import {
  type ContextRuntime,
  createContextRuntime,
} from "../../core/context/runtime.js";
import { createStateStore, type StateStore } from "../../core/context/store.js";
import {
  defineExtensionService,
  defineSessionService,
  type WorkPermit,
} from "../../core/lifecycle/index.js";
import type { ProcessState } from "../../core/process-state.js";
import { createProcessState } from "../../core/process-state.js";
import { createSessionAgentResource } from "../../core/session/agent.js";
import {
  contextSessionResources,
  createSessionResourceCatalog,
  type SessionResourceCatalog,
} from "../../core/session/resources.js";
import type { ToolCallContext, ToolResult } from "../../core/unit.js";
import { permitFor } from "../../testkits/context-runtime.js";
import { makeTmpDir } from "../../testkits/tmp.js";
import {
  _getBufferForTesting,
  _resetForTesting,
  initLogger,
} from "../../utils/logger.js";
import {
  createOpenCodeLifecycleWiring,
  withSessionWork,
} from "./lifecycle-wiring.js";
import { createOpenCodeHostServices } from "./services.js";

let _loggerDir: string;

/** Scratch store directories the current test created. */
const _storeDirs: string[] = [];

/** The plugin instance under test. */
let process: ProcessState;
let store: StateStore;
let runtime: ContextRuntime;
let sessionCatalog: SessionResourceCatalog;

/** Create a fresh instance runtime over a new scratch store. */
function installSandbox(): StateStore {
  const dir = makeTmpDir("zoo-opencode-wiring-store");
  _storeDirs.push(dir);
  store = createStateStore(dir);
  runtime = createContextRuntime(store);
  process = createProcessState();
  sessionCatalog = createSessionResourceCatalog([
    ...contextSessionResources(runtime),
    createSessionAgentResource(process.sessionAgents),
  ]);
  return store;
}

beforeEach(() => {
  _resetForTesting();
  _loggerDir = makeTmpDir("zoo-opencode-wiring");
  initLogger("opencode", { logDir: _loggerDir });
  installSandbox();
});

afterEach(() => {
  _resetForTesting();
  for (const dir of _storeDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
  try {
    rmSync(_loggerDir, { recursive: true, force: true });
  } catch {
    // shard cleanup is best effort
  }
});

/**
 * Create an instance runtime over a scratch store and record deletions.
 *
 * @returns The store, its directory, and the session ids it deleted.
 */
function sandboxStore() {
  const sandbox = installSandbox();
  const deletes: string[] = [];
  const originalDelete = sandbox.delete;
  sandbox.delete = (sessionID: string) => {
    deletes.push(sessionID);
    originalDelete(sessionID);
  };
  return { store: sandbox, dir: "", deletes };
}

/** Stage one cached compression for a session, as the transform would. */
async function stageBlock(sessionID: string): Promise<void> {
  await runtime.commit(permitFor(sessionID), (state) => {
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
  });
}

/** An OpenCode session event as the `event` hook receives it. */
function sessionEvent(type: string, id?: string) {
  return { type, properties: { info: id === undefined ? {} : { id } } };
}

/** Wiring over the real OpenCode declarations. */
function buildWiring() {
  const declarations = createOpenCodeHostServices({
    // No profile: the composition declares no settle strategy, so this
    // wiring carries an engine-less session runtime.
    scope: createConfigScope({}, {}),
    client: {},
    directory: "",
    process,
    contextRuntime: runtime,
    sessionCatalog,
  });
  return createOpenCodeLifecycleWiring({
    extensionServices: declarations.extension,
    sessionServices: declarations.session,
    sessionCatalog,
  });
}

/** Wiring over declarations whose disposers record (and optionally fail). */
function buildRecordingWiring(options: { failSession?: boolean } = {}) {
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
  const session = defineSessionService({
    name: "worker",
    deps: [],
    create: ({ sessionID }) => {
      log.push(`create:worker:${sessionID}`);
      return { sessionID };
    },
    dispose: (service, { reason, mode }) => {
      log.push(`dispose:worker:${service.sessionID}:${reason}:${mode}`);
      if (options.failSession === true) throw new Error("boom");
    },
  });
  const wiring = createOpenCodeLifecycleWiring({
    extensionServices: [extension] as const,
    sessionServices: [session] as const,
    sessionCatalog,
  });
  return { wiring, log };
}

describe("OpenCode lifecycle wiring — first use", () => {
  it("creates the session scope without waiting for session.created", async () => {
    const wiring = buildWiring();
    process.sessionAgents.bind("s1", "dolphin");

    const first = await wiring.ensureSession("s1");
    const second = await wiring.ensureSession("s1");

    assert.equal(first?.sessionID, "s1");
    assert.equal(first, second, "the scope is created once and reused");
  });

  it("creates nothing when the id is absent or blank", async () => {
    const { wiring } = buildRecordingWiring();

    for (const id of [undefined, null, "", "   "]) {
      assert.equal(await wiring.ensureSession(id), null);
    }
    assert.deepEqual(
      _getBufferForTesting().filter((entry) => entry.level === "error"),
      [],
    );
  });

  it("does not recreate a session the host already deleted", async () => {
    const wiring = buildWiring();
    assert.ok(await wiring.ensureSession("s1"));

    await wiring.handleEvent(sessionEvent("session.deleted", "s1"));

    assert.equal(await wiring.ensureSession("s1"), null);
    const created = await wiring.handleEvent(
      sessionEvent("session.created", "s1"),
    );
    assert.deepEqual(created, { action: "start", started: false });
  });

  it("does not recreate a session the disposed plugin stopped", async () => {
    const wiring = buildWiring();
    assert.ok(await wiring.ensureSession("s1"));

    await wiring.dispose();

    assert.equal(await wiring.ensureSession("s1"), null);
  });
});

describe("OpenCode lifecycle wiring — host session events", () => {
  it("starts the created session with the host event as the reason", async () => {
    const { wiring, log } = buildRecordingWiring();

    const outcome = await wiring.handleEvent(
      sessionEvent("session.created", "s1"),
    );

    assert.deepEqual(outcome, { action: "start", started: true });
    assert.deepEqual(log, ["create:ext", "create:worker:s1"]);
  });

  it("stops only the deleted session", async () => {
    const { wiring, log } = buildRecordingWiring();
    await wiring.handleEvent(sessionEvent("session.created", "s1"));
    await wiring.handleEvent(sessionEvent("session.created", "s2"));

    const outcome = await wiring.handleEvent(
      sessionEvent("session.deleted", "s1"),
    );

    assert.deepEqual(outcome, {
      action: "stop-session",
      sessionID: "s1",
      report: { errors: [] },
    });
    assert.deepEqual(log.slice(3), [
      "dispose:worker:s1:session.deleted:delete-session",
    ]);

    await wiring.dispose();
    assert.deepEqual(log.slice(4), [
      "dispose:worker:s2:dispose:release-runtime",
      "dispose:ext:dispose",
    ]);
  });

  it("creates nothing when the deleted session was never created", async () => {
    const { wiring, log } = buildRecordingWiring();

    const outcome = await wiring.handleEvent(
      sessionEvent("session.deleted", "ghost"),
    );

    assert.deepEqual(outcome, {
      action: "stop-session",
      sessionID: "ghost",
      report: { errors: [] },
    });
    assert.deepEqual(log, [], "a deletion never builds a scope");
  });

  it("deletes the process-level records of a deleted session", async () => {
    const wiring = buildWiring();
    await wiring.ensureSession("s1");
    process.sessionAgents.bind("s1", "dolphin");
    runtime.setModelLimit(permitFor("s1"), 1000, "model");

    await wiring.handleEvent(sessionEvent("session.deleted", "s1"));

    assert.equal(process.sessionAgents.resolve("s1"), undefined);
    assert.equal(runtime.modelLimit("s1"), undefined);
  });

  it("deletes the records of a session this instance never ensured", async () => {
    const wiring = buildWiring();
    // The host wrote process-level records for a session whose events
    // predate this plugin instance: no scope exists, the records do.
    process.sessionAgents.bind("ghost", "dolphin");
    runtime.setModelLimit(permitFor("ghost"), 1000, "model");

    await wiring.handleEvent(sessionEvent("session.deleted", "ghost"));

    assert.equal(process.sessionAgents.resolve("ghost"), undefined);
    assert.equal(runtime.modelLimit("ghost"), undefined);
  });

  it("leaves an unrelated session's records alone on deletion", async () => {
    const wiring = buildWiring();
    await wiring.ensureSession("s1");
    await wiring.ensureSession("s2");
    process.sessionAgents.bind("s1", "dolphin");
    process.sessionAgents.bind("s2", "dolphin");

    await wiring.handleEvent(sessionEvent("session.deleted", "s1"));

    assert.equal(process.sessionAgents.resolve("s2"), "dolphin");
  });
});

describe("OpenCode lifecycle wiring — deletion boundary", () => {
  it("deletes a created-then-deleted session's records exactly once", async () => {
    const { deletes } = sandboxStore();
    const wiring = buildWiring();

    await wiring.handleEvent(sessionEvent("session.created", "s1"));
    process.sessionAgents.bind("s1", "dolphin");
    await wiring.handleEvent(sessionEvent("session.deleted", "s1"));

    assert.deepEqual(deletes, ["s1"], "the stop and the record step run once");
    assert.equal(
      process.sessionAgents.resolve("s1"),
      undefined,
      "the scope disposer still deleted the session's records",
    );
  });

  it("deletes a first-use session's records exactly once", async () => {
    const { deletes } = sandboxStore();
    const wiring = buildWiring();
    await wiring.ensureSession("s1");
    process.sessionAgents.bind("s1", "dolphin");

    await wiring.handleEvent(sessionEvent("session.deleted", "s1"));

    assert.deepEqual(deletes, ["s1"]);
    assert.equal(process.sessionAgents.resolve("s1"), undefined);
  });

  it("deletes the records of a deleted ghost", async () => {
    const { deletes } = sandboxStore();
    const wiring = buildWiring();
    process.sessionAgents.bind("ghost", "dolphin");

    await wiring.handleEvent(sessionEvent("session.deleted", "ghost"));

    assert.deepEqual(deletes, ["ghost"]);
    assert.equal(process.sessionAgents.resolve("ghost"), undefined);
  });

  it("returns the record failures to the caller and logs them once", async () => {
    const { store } = sandboxStore();
    const wiring = buildWiring();
    process.sessionAgents.bind("ghost", "dolphin");
    store.delete = () => {
      throw new Error("boom");
    };

    const outcome = await wiring.handleEvent(
      sessionEvent("session.deleted", "ghost"),
    );

    assert.equal(outcome.action, "stop-session");
    const report = outcome.action === "stop-session" ? outcome.report : null;
    assert.deepEqual(
      report?.errors.map((failure) => [
        failure.scope,
        failure.sessionID,
        failure.service,
      ]),
      [["session", "ghost", "sessionStateFile"]],
    );
    assert.match(String(report?.errors[0]?.error), /boom/);
    const logged = _getBufferForTesting().filter(
      (entry) => entry.event === "cleanup_failed",
    );
    assert.deepEqual(
      logged.map((entry) => [entry.sessionId, entry.service]),
      [["ghost", "sessionStateFile"]],
      "the merged report is logged once",
    );
  });

  it("keeps the persisted context of the sessions a dispose stops", async () => {
    const { store, deletes } = sandboxStore();
    const wiring = buildWiring();
    await wiring.ensureSession("s1");
    await stageBlock("s1");
    process.sessionAgents.bind("s1", "dolphin");

    await wiring.dispose();

    assert.deepEqual(deletes, [], "a dispose must not delete persisted state");
    assert.equal(store.load("s1").blocks.get(1)?.summary, "kept");
    assert.equal(process.sessionAgents.resolve("s1"), "dolphin");
  });

  it("deletes the context when the host reports the deletion after a dispose", async () => {
    const { store, deletes } = sandboxStore();
    const wiring = buildWiring();
    await wiring.ensureSession("s1");
    await stageBlock("s1");

    await wiring.dispose();
    await wiring.handleEvent(sessionEvent("session.deleted", "s1"));

    assert.deepEqual(deletes, ["s1"]);
    assert.equal(store.load("s1").blocks.size, 0);
  });

  it("deletes the session a running dispose is releasing", async () => {
    const { store, deletes } = sandboxStore();
    const wiring = buildWiring();
    await wiring.ensureSession("s1");
    await stageBlock("s1");
    process.sessionAgents.bind("s1", "dolphin");

    // Hold one admitted hook so the dispose cannot finish its release.
    const blocker = gate();
    let holding = false;
    const hooks = withSessionWork(
      {
        "command.execute.before": async (_input: { sessionID: string }) => {
          holding = true;
          await blocker.waited;
        },
      },
      wiring,
    );
    const running = hooks["command.execute.before"]({ sessionID: "s1" });
    await waitFor(() => holding);

    const disposing = wiring.dispose();
    assert.equal(
      await wiring.ensureSession("s1"),
      null,
      "the dispose has begun",
    );
    const deleting = wiring.handleEvent(sessionEvent("session.deleted", "s1"));

    blocker.open();
    await running;
    const [disposedReport, outcome] = await Promise.all([disposing, deleting]);

    assert.deepEqual(disposedReport.errors, []);
    assert.equal(outcome.action, "stop-session");
    // The host deleted the session, so nothing may stay behind even
    // though the release ran first.
    assert.equal(store.load("s1").blocks.size, 0);
    assert.equal(process.sessionAgents.resolve("s1"), undefined);
    assert.deepEqual([...new Set(deletes)], ["s1"]);
  });

  it("deletes the session a dispose joins while the deletion runs", async () => {
    const { store, deletes } = sandboxStore();
    const wiring = buildWiring();
    await wiring.ensureSession("s1");
    await stageBlock("s1");
    process.sessionAgents.bind("s1", "dolphin");

    const blocker = gate();
    let holding = false;
    const hooks = withSessionWork(
      {
        "command.execute.before": async (_input: { sessionID: string }) => {
          holding = true;
          await blocker.waited;
        },
      },
      wiring,
    );
    const running = hooks["command.execute.before"]({ sessionID: "s1" });
    await waitFor(() => holding);

    const deleting = wiring.handleEvent(sessionEvent("session.deleted", "s1"));
    const disposing = wiring.dispose();

    blocker.open();
    await running;
    const [outcome, disposedReport] = await Promise.all([deleting, disposing]);

    assert.deepEqual(disposedReport.errors, []);
    assert.equal(outcome.action, "stop-session");
    assert.deepEqual([...new Set(deletes)], ["s1"]);
    assert.equal(store.load("s1").blocks.size, 0);
    assert.equal(process.sessionAgents.resolve("s1"), undefined);
  });

  it("keeps a repeated deletion idempotent", async () => {
    const { store, deletes } = sandboxStore();
    const wiring = buildWiring();
    await wiring.ensureSession("s1");
    await stageBlock("s1");
    process.sessionAgents.bind("s1", "dolphin");

    const first = await wiring.handleEvent(
      sessionEvent("session.deleted", "s1"),
    );
    const second = await wiring.handleEvent(
      sessionEvent("session.deleted", "s1"),
    );

    const reports = [first, second].map((outcome) =>
      outcome.action === "stop-session" ? outcome.report : null,
    );
    assert.deepEqual(reports, [{ errors: [] }, { errors: [] }]);
    assert.deepEqual([...new Set(deletes)], ["s1"]);
    assert.equal(store.load("s1").blocks.size, 0);
    assert.equal(process.sessionAgents.resolve("s1"), undefined);
  });

  it("deletes the other records when one deletion step fails", async () => {
    const { store } = sandboxStore();
    const wiring = buildWiring();
    await wiring.ensureSession("s1");
    await stageBlock("s1");
    process.sessionAgents.bind("s1", "dolphin");
    store.delete = () => {
      throw new Error("boom");
    };

    const outcome = await wiring.handleEvent(
      sessionEvent("session.deleted", "s1"),
    );

    assert.equal(outcome.action, "stop-session");
    const report = outcome.action === "stop-session" ? outcome.report : null;
    assert.equal(report?.errors.length, 1);
    assert.equal(report?.errors[0]?.service, "sessionStateFile");
    assert.match(String(report?.errors[0]?.error), /boom/);
    assert.equal(
      process.sessionAgents.resolve("s1"),
      undefined,
      "the failing record did not stop the others",
    );
  });
});

describe("OpenCode lifecycle wiring — dispose", () => {
  it("stops every live session before the extension", async () => {
    const { wiring, log } = buildRecordingWiring();
    await wiring.handleEvent(sessionEvent("session.created", "s1"));
    await wiring.handleEvent(sessionEvent("session.created", "s2"));

    const report = await wiring.dispose();

    assert.deepEqual(report, { errors: [] });
    assert.deepEqual(log.slice(3), [
      "dispose:worker:s1:dispose:release-runtime",
      "dispose:worker:s2:dispose:release-runtime",
      "dispose:ext:dispose",
    ]);
  });

  it("is a legal cleanup for a plugin that never created anything", async () => {
    const wiring = buildWiring();

    assert.deepEqual(await wiring.dispose(), { errors: [] });
    assert.deepEqual(await wiring.dispose(), { errors: [] });
  });

  it("logs every cleanup failure instead of swallowing it", async () => {
    const { wiring } = buildRecordingWiring({ failSession: true });
    await wiring.handleEvent(sessionEvent("session.created", "s1"));
    await wiring.handleEvent(sessionEvent("session.created", "s2"));

    const report = await wiring.dispose();

    assert.equal(report.errors.length, 2);
    const logged = _getBufferForTesting().filter(
      (entry) => entry.event === "cleanup_failed",
    );
    assert.deepEqual(
      logged.map((entry) => [entry.level, entry.sessionId, entry.service]),
      [
        ["warn", "s1", "worker"],
        ["warn", "s2", "worker"],
      ],
    );
  });

  it("logs the cleanup failures of a deleted session too", async () => {
    const { wiring } = buildRecordingWiring({ failSession: true });
    await wiring.handleEvent(sessionEvent("session.created", "s1"));

    await wiring.handleEvent(sessionEvent("session.deleted", "s1"));

    const logged = _getBufferForTesting().filter(
      (entry) => entry.event === "cleanup_failed",
    );
    assert.deepEqual(
      logged.map((entry) => [entry.sessionId, entry.service, entry.scope]),
      [["s1", "worker", "session"]],
    );
  });
});

/** Wait until `predicate` holds, or fail the test. */
async function waitFor(predicate: () => boolean): Promise<void> {
  for (let tick = 0; tick < 200 && !predicate(); tick += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  assert.equal(predicate(), true, "the expected state was never reached");
}

/** A promise the test releases by hand. */
function gate() {
  let open = () => {};
  const waited = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { waited, open };
}

/** The `event` hook input as the host sends it. */
type EventInput = {
  event: { type: string; properties?: Record<string, unknown> };
};

/** A tool entry as the composition hands it to the host. */
function toolEntry(
  execute: (args: unknown, toolCtx: unknown) => Promise<ToolResult>,
) {
  return {
    name: "compress",
    description: "Compress a range.",
    args: { ranges: {} },
    required: ["ranges"],
    execute,
  };
}

describe("session work around ordinary hooks", () => {
  it("admits a hook under the permit of the session it names", async () => {
    const { wiring, log } = buildRecordingWiring();
    const hooks = withSessionWork(
      {
        "tool.execute.before": async (input: { sessionID: string }) => {
          // The session's scope exists by the time the body runs.
          log.push(`body:${input.sessionID}`);
        },
      },
      wiring,
    );

    await hooks["tool.execute.before"]({ sessionID: "s1" });

    assert.deepEqual(log, ["create:ext", "create:worker:s1", "body:s1"]);
  });

  it("derives the transform's session from the first message", async () => {
    const { wiring, log } = buildRecordingWiring();
    const hooks = withSessionWork(
      {
        "experimental.chat.messages.transform": async (
          _input: Record<string, never>,
          _output: unknown,
        ) => {},
      },
      wiring,
    );

    await hooks["experimental.chat.messages.transform"](
      {},
      {
        messages: [{ info: { sessionID: "s2" }, parts: [] }],
      },
    );

    assert.deepEqual(log, ["create:ext", "create:worker:s2"]);
  });

  it("runs the system transform without a session and issues no permit", async () => {
    const { wiring, log } = buildRecordingWiring();
    const permits: Array<WorkPermit | undefined> = [];
    const hooks = withSessionWork(
      {
        "experimental.chat.system.transform": async (
          _input: { sessionID?: string; model?: unknown },
          _output: unknown,
          permit?: WorkPermit,
        ) => {
          permits.push(permit);
        },
      },
      wiring,
    );

    await hooks["experimental.chat.system.transform"](
      { model: { id: "gpt-5.5", limit: { context: 1000, output: 100 } } },
      { system: ["prompt"] },
    );

    assert.equal(permits.length, 1, "the handler still runs");
    assert.equal(permits[0], undefined, "no permit is issued");
    assert.deepEqual(log, [], "no session record is created");
  });

  it("admits the system transform for the session it names", async () => {
    const { wiring, log } = buildRecordingWiring();
    const permits: Array<WorkPermit | undefined> = [];
    const hooks = withSessionWork(
      {
        "experimental.chat.system.transform": async (
          _input: { sessionID?: string; model?: unknown },
          _output: unknown,
          permit?: WorkPermit,
        ) => {
          permits.push(permit);
        },
      },
      wiring,
    );

    await hooks["experimental.chat.system.transform"](
      { sessionID: "s1", model: { id: "m", limit: { context: 1, output: 1 } } },
      { system: [] },
    );

    assert.equal(permits[0]?.sessionID, "s1");
    assert.deepEqual(log, ["create:ext", "create:worker:s1"]);
  });

  it("runs no hook for a call that names no session", async () => {
    const { wiring, log } = buildRecordingWiring();
    let ran = 0;
    const hooks = withSessionWork(
      {
        "tool.execute.before": async () => {
          ran += 1;
        },
        "experimental.chat.messages.transform": async (
          _input: Record<string, never>,
          _output: unknown,
        ) => {
          ran += 1;
        },
      },
      wiring,
    );

    await hooks["tool.execute.before"]();
    await hooks["experimental.chat.messages.transform"]({}, {});

    assert.equal(ran, 0, "a call without a session id is refused");
    assert.deepEqual(log, [], "nothing is created for a nameless call");
  });

  it("runs no hook after the host deleted the session", async () => {
    const { wiring, log } = buildRecordingWiring();
    await wiring.ensureSession("s1");
    await wiring.handleEvent(sessionEvent("session.deleted", "s1"));
    let ran = 0;
    const hooks = withSessionWork(
      {
        "tool.execute.before": async (_input: { sessionID?: string }) => {
          ran += 1;
        },
      },
      wiring,
    );

    await hooks["tool.execute.before"]({ sessionID: "s1" });

    assert.equal(ran, 0, "a late hook must not run on a deleted session");
    assert.deepEqual(log, [
      "create:ext",
      "create:worker:s1",
      "dispose:worker:s1:session.deleted:delete-session",
    ]);
  });

  it("runs no hook after the plugin disposed", async () => {
    const { wiring } = buildRecordingWiring();
    await wiring.ensureSession("s1");
    await wiring.dispose();
    let ran = 0;
    const hooks = withSessionWork(
      {
        "tool.execute.before": async (_input: { sessionID?: string }) => {
          ran += 1;
        },
      },
      wiring,
    );

    await hooks["tool.execute.before"]({ sessionID: "s1" });

    assert.equal(ran, 0);
  });

  it("leaves the hooks that address no session alone", async () => {
    const { wiring, log } = buildRecordingWiring();
    const config = async () => {};
    const definition = async () => {};
    const hooks = withSessionWork(
      { config, "tool.definition": definition },
      wiring,
    );

    assert.equal(hooks.config, config);
    assert.equal(
      hooks["tool.definition"],
      definition,
      "definitions keep enhancing",
    );
    await hooks.config();
    assert.deepEqual(log, [], "the configuration stage enters no session");
  });

  it("propagates a hook's error unchanged", async () => {
    const { wiring } = buildRecordingWiring();
    const hooks = withSessionWork(
      {
        "command.execute.before": async (_input: { sessionID?: string }) => {
          throw new Error("command handled");
        },
      },
      wiring,
    );

    await assert.rejects(
      () => hooks["command.execute.before"]({ sessionID: "s1" }),
      /command handled/,
    );
  });
});

describe("session work around registered tools", () => {
  it("runs a tool under its session's permit and keeps its metadata", async () => {
    const { wiring, log } = buildRecordingWiring();
    const seen: Array<{ args: unknown; call: ToolCallContext }> = [];
    const entry = toolEntry(async (args, raw) => {
      seen.push({ args, call: raw as ToolCallContext });
      return { text: "compressed" };
    });
    const hooks = withSessionWork({ tool: { compress: entry } }, wiring);
    const caller = new AbortController();

    const result = await hooks.tool.compress.execute(
      { ranges: [1] },
      { sessionID: "s1", messageID: "m1", abort: caller.signal },
    );

    assert.equal(result, "compressed", "the business result propagates");
    assert.deepEqual(log, ["create:ext", "create:worker:s1"]);
    assert.deepEqual(seen[0]?.args, { ranges: [1] });
    assert.equal(seen[0]?.call.sessionID, "s1");
    assert.equal(hooks.tool.compress.description, entry.description);
    assert.deepEqual(hooks.tool.compress.args, entry.args);
    assert.deepEqual(hooks.tool.compress.required, ["ranges"]);
  });

  it("reports structured data as the host's metadata", async () => {
    const { wiring } = buildRecordingWiring();
    const hooks = withSessionWork(
      {
        tool: {
          compress: toolEntry(async () => ({
            text: "applied",
            data: { blocks: [1] },
          })),
        },
      },
      wiring,
    );

    const result = await hooks.tool.compress.execute({}, { sessionID: "s1" });

    assert.deepEqual(result, {
      output: "applied",
      metadata: { blocks: [1] },
    });
  });

  it("hands the tool the permit's signal over its own abort", async () => {
    const { wiring } = buildRecordingWiring();
    const seen: ToolCallContext[] = [];
    const hooks = withSessionWork(
      {
        tool: {
          compress: toolEntry(async (_args, raw) => {
            seen.push(raw as ToolCallContext);
            return { text: "ok" };
          }),
        },
      },
      wiring,
    );
    const caller = new AbortController();

    await hooks.tool.compress.execute(
      {},
      { sessionID: "s1", abort: caller.signal },
    );

    const permit = seen[0]?.permit as {
      sessionID: string;
      signal: AbortSignal;
      isActive(): boolean;
    };
    assert.equal(permit.sessionID, "s1");
    assert.notEqual(seen[0]?.signal, caller.signal);
    assert.equal(seen[0]?.signal, permit.signal, "signal is the permit's");
    assert.equal(permit.isActive(), false, "the permit ends with the call");

    caller.abort();
    assert.equal(
      seen[0]?.signal.aborted,
      true,
      "the tool's signal follows the caller",
    );
  });

  it("aborts a running tool when the host deletes its session", async () => {
    const { wiring } = buildRecordingWiring();
    let toolAbort: AbortSignal | undefined;
    const hooks = withSessionWork(
      {
        tool: {
          compress: toolEntry(async (_args, raw) => {
            toolAbort = (raw as ToolCallContext).signal;
            return { text: "ok" };
          }),
        },
      },
      wiring,
    );
    await hooks.tool.compress.execute({}, { sessionID: "s1" });

    await wiring.handleEvent(sessionEvent("session.deleted", "s1"));

    assert.equal(toolAbort?.aborted, true);
  });

  it("refuses a tool call that names no session", async () => {
    const { wiring, log } = buildRecordingWiring();
    let ran = 0;
    const hooks = withSessionWork(
      {
        tool: {
          compress: toolEntry(async () => {
            ran += 1;
            return { text: "ok" };
          }),
        },
      },
      wiring,
    );

    assert.equal(
      await hooks.tool.compress.execute({}, {}),
      "",
      "a refused call returns an empty string",
    );
    assert.equal(ran, 0);
    assert.deepEqual(log, []);
  });

  it("refuses a tool call for a session the host deleted", async () => {
    const { wiring } = buildRecordingWiring();
    await wiring.ensureSession("s1");
    await wiring.handleEvent(sessionEvent("session.deleted", "s1"));
    let ran = 0;
    const hooks = withSessionWork(
      {
        tool: {
          compress: toolEntry(async () => {
            ran += 1;
            return { text: "ok" };
          }),
        },
      },
      wiring,
    );

    assert.equal(
      await hooks.tool.compress.execute({}, { sessionID: "s1" }),
      "",
    );
    assert.equal(ran, 0);
  });

  it("accepts the host's snake-case session id", async () => {
    const { wiring, log } = buildRecordingWiring();
    const hooks = withSessionWork(
      {
        tool: { compress: toolEntry(async () => ({ text: "ok" })) },
      },
      wiring,
    );

    await hooks.tool.compress.execute({}, { sessionId: "s2" });

    assert.deepEqual(log, ["create:ext", "create:worker:s2"]);
  });

  it("propagates a tool's error unchanged", async () => {
    const { wiring } = buildRecordingWiring();
    const hooks = withSessionWork(
      {
        tool: {
          compress: toolEntry(async () => {
            throw new Error("tool failed");
          }),
        },
      },
      wiring,
    );

    await assert.rejects(
      () => hooks.tool.compress.execute({}, { sessionID: "s1" }),
      /tool failed/,
    );
  });
});

describe("session work around host events", () => {
  it("admits a message update under the event's session permit", async () => {
    const { wiring, log } = buildRecordingWiring();
    const seen: string[] = [];
    const hooks = withSessionWork(
      {
        event: async (input: EventInput) => {
          seen.push(input.event.type);
        },
      },
      wiring,
    );

    await hooks.event({
      event: {
        type: "message.updated",
        properties: { info: { sessionID: "s1" } },
      },
    });

    assert.deepEqual(seen, ["message.updated"]);
    assert.deepEqual(log, ["create:ext", "create:worker:s1"]);
  });

  it("admits an idle and an error under the event's session permit", async () => {
    const { wiring, log } = buildRecordingWiring();
    const seen: string[] = [];
    const hooks = withSessionWork(
      {
        event: async (input: EventInput) => {
          seen.push(input.event.type);
        },
      },
      wiring,
    );

    await hooks.event({
      event: { type: "session.idle", properties: { sessionID: "s1" } },
    });
    await hooks.event({
      event: { type: "session.error", properties: { sessionID: "s2" } },
    });

    assert.deepEqual(seen, ["session.idle", "session.error"]);
    assert.deepEqual(log, [
      "create:ext",
      "create:worker:s1",
      "create:worker:s2",
    ]);
  });

  it("runs no work event that names no session", async () => {
    const { wiring, log } = buildRecordingWiring();
    let ran = 0;
    const hooks = withSessionWork(
      {
        event: async (_input: EventInput) => {
          ran += 1;
        },
      },
      wiring,
    );

    for (const type of ["message.updated", "session.error", "session.idle"]) {
      await hooks.event({ event: { type, properties: {} } });
    }

    assert.equal(ran, 0);
    assert.deepEqual(log, []);
  });

  it("routes a creation and a deletion without business admission", async () => {
    const { wiring, log } = buildRecordingWiring();
    const hooks = withSessionWork(
      { event: (input: EventInput) => wiring.handleEvent(input.event) },
      wiring,
    );

    await hooks.event({ event: sessionEvent("session.created", "s1") });
    await hooks.event({ event: sessionEvent("session.deleted", "s1") });
    // The id is tombstoned by then: a permit would be refused, so this
    // proves the deletion took the lifecycle path instead.
    const late = await hooks.event({
      event: sessionEvent("session.deleted", "s1"),
    });

    assert.deepEqual(late, {
      action: "stop-session",
      sessionID: "s1",
      report: { errors: [] },
    });
    assert.deepEqual(log, [
      "create:ext",
      "create:worker:s1",
      "dispose:worker:s1:session.deleted:delete-session",
    ]);
  });

  it("leaves an unmapped event to the hook and admits nothing", async () => {
    const { wiring, log } = buildRecordingWiring();
    const seen: string[] = [];
    const hooks = withSessionWork(
      {
        event: async (input: EventInput) => {
          seen.push(input.event.type);
        },
      },
      wiring,
    );

    await hooks.event({
      event: { type: "session.updated", properties: { info: { id: "s1" } } },
    });

    assert.deepEqual(seen, ["session.updated"]);
    assert.deepEqual(log, []);
  });
});

describe("stops against running session work", () => {
  it("waits for a running hook before disposing its session", async () => {
    const { wiring, log } = buildRecordingWiring();
    const blocker = gate();
    const hooks = withSessionWork(
      {
        "command.execute.before": async (_input: { sessionID?: string }) => {
          log.push("body:start");
          await blocker.waited;
          log.push("body:end");
        },
      },
      wiring,
    );

    const running = hooks["command.execute.before"]({ sessionID: "s1" });
    await waitFor(() => log.includes("body:start"));
    const disposing = wiring.dispose();
    let disposed = false;
    void disposing.then(() => {
      disposed = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(disposed, false, "the dispose must wait for the hook");

    blocker.open();
    await running;
    assert.deepEqual(await disposing, { errors: [] });
    assert.deepEqual(log, [
      "create:ext",
      "create:worker:s1",
      "body:start",
      "body:end",
      "dispose:worker:s1:dispose:release-runtime",
      "dispose:ext:dispose",
    ]);
  });

  it("cancels a running tool on dispose and waits for it", async () => {
    const { wiring, log } = buildRecordingWiring();
    const blocker = gate();
    let toolAbort: AbortSignal | undefined;
    const hooks = withSessionWork(
      {
        tool: {
          compress: toolEntry(async (_args, raw) => {
            toolAbort = (raw as ToolCallContext).signal;
            log.push("tool:start");
            await blocker.waited;
            log.push(`tool:end:${toolAbort?.aborted}`);
            return { text: "ok" };
          }),
        },
      },
      wiring,
    );

    const running = hooks.tool.compress.execute({}, { sessionID: "s1" });
    await waitFor(() => log.includes("tool:start"));
    const disposing = wiring.dispose();
    await waitFor(() => toolAbort?.aborted === true);
    assert.equal(
      log.includes("dispose:ext:dispose"),
      false,
      "the tool's session is not disposed yet",
    );

    blocker.open();
    assert.equal(await running, "ok");
    assert.deepEqual(await disposing, { errors: [] });
    assert.deepEqual(log.slice(-3), [
      "tool:end:true",
      "dispose:worker:s1:dispose:release-runtime",
      "dispose:ext:dispose",
    ]);
  });

  it("waits for a running hook before deleting its session", async () => {
    const { wiring, log } = buildRecordingWiring();
    const blocker = gate();
    const hooks = withSessionWork(
      {
        "command.execute.before": async (_input: { sessionID?: string }) => {
          log.push("body:start");
          await blocker.waited;
          log.push("body:end");
        },
      },
      wiring,
    );

    const running = hooks["command.execute.before"]({ sessionID: "s1" });
    await waitFor(() => log.includes("body:start"));
    const stopping = wiring.handleEvent(sessionEvent("session.deleted", "s1"));
    let stopped = false;
    void stopping.then(() => {
      stopped = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(stopped, false, "the deletion must wait for the hook");

    blocker.open();
    await running;
    await stopping;
    assert.deepEqual(log.slice(2), [
      "body:start",
      "body:end",
      "dispose:worker:s1:session.deleted:delete-session",
    ]);
  });

  it("stops one session without cancelling another's work", async () => {
    const { wiring } = buildRecordingWiring();
    const blocker = gate();
    const signals = new Map<string, AbortSignal>();
    const hooks = withSessionWork(
      {
        tool: {
          compress: toolEntry(async (_args, raw) => {
            const call = raw as ToolCallContext;
            signals.set(call.sessionID, call.signal);
            await blocker.waited;
            return { text: call.sessionID };
          }),
        },
      },
      wiring,
    );

    const first = hooks.tool.compress.execute({}, { sessionID: "s1" });
    const second = hooks.tool.compress.execute({}, { sessionID: "s2" });
    await waitFor(() => signals.size === 2);
    const stopping = wiring.handleEvent(sessionEvent("session.deleted", "s1"));
    await waitFor(() => signals.get("s1")?.aborted === true);
    assert.equal(signals.get("s2")?.aborted, false, "a sibling keeps running");

    blocker.open();
    await stopping;
    assert.deepEqual(await Promise.all([first, second]), ["s1", "s2"]);
  });
});
