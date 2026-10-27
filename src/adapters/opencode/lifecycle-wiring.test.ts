/**
 * Tests for the OpenCode lifecycle wiring (`lifecycle-wiring.ts`).
 *
 * The wiring owns one kernel per plugin instance: it creates a session
 * scope on first use (an event other than `session.created` may be the
 * first thing the host says about a session), maps the host's own session
 * events onto that kernel, and tears everything down on plugin dispose.
 * The expectations below are the resources created and disposed, plus the
 * process-level records a deletion releases — never the wiring's internal
 * bookkeeping.
 *
 * Two boundaries get their own assertions: a deletion releases a session
 * exactly once whichever path created the scope (so the disposer and the
 * unknown-session fallback never both run), and a dispose keeps the
 * persisted context of the sessions it stops because those sessions still
 * exist on the host side.
 */
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  clearModelLimit,
  getModelLimit,
  setModelLimit,
} from "../../core/context/model-limits.js";
import {
  _resetContextStateManagerForTesting,
  getContextStateManager,
} from "../../core/context/runtime.js";
import { createStateStore } from "../../core/context/store.js";
import {
  defineExtensionService,
  defineSessionService,
} from "../../core/lifecycle/index.js";
import { sessionAgentRegistry } from "../../core/session-agent.js";
import { makeTmpDir } from "../../testkits/tmp.js";
import {
  _getBufferForTesting,
  _resetForTesting,
  initLogger,
} from "../../utils/logger.js";
import {
  createOpenCodeLifecycleWiring,
  withEnsuredSessions,
} from "./lifecycle-wiring.js";
import { createOpenCodeHostServices } from "./services.js";

let _loggerDir: string;

/** Scratch store directories the current test created. */
const _storeDirs: string[] = [];

beforeEach(() => {
  _resetForTesting();
  _loggerDir = makeTmpDir("zoo-opencode-wiring");
  initLogger("opencode", { logDir: _loggerDir });
});

afterEach(() => {
  _resetForTesting();
  _resetContextStateManagerForTesting();
  for (const sessionID of ["s1", "s2", "ghost"]) {
    sessionAgentRegistry.delete(sessionID);
    clearModelLimit(sessionID);
  }
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
 * Bind the shared manager to a scratch store and record its deletions.
 *
 * @returns The store, its directory, and the session ids it deleted.
 */
function sandboxStore() {
  const dir = makeTmpDir("zoo-opencode-wiring-store");
  _storeDirs.push(dir);
  const store = createStateStore(dir);
  _resetContextStateManagerForTesting(store);
  const deletes: string[] = [];
  const originalDelete = store.delete;
  store.delete = (sessionID: string) => {
    deletes.push(sessionID);
    originalDelete(sessionID);
  };
  return { store, dir, deletes };
}

/** Stage one cached compression for a session, as the transform would. */
function stageBlock(sessionID: string): void {
  getContextStateManager().get(sessionID).blocks.set(1, {
    start: 0,
    end: 3,
    summary: "kept",
    spanHash: "ffff0000",
    status: "active",
    compressedTokens: 100,
    summaryTokens: 20,
    createdAt: 1000,
  });
}

/** An OpenCode session event as the `event` hook receives it. */
function sessionEvent(type: string, id?: string) {
  return { type, properties: { info: id === undefined ? {} : { id } } };
}

/** Wiring over the real OpenCode declarations. */
function buildWiring() {
  const declarations = createOpenCodeHostServices({ onSettled: [] });
  return createOpenCodeLifecycleWiring({
    extensionServices: declarations.extension,
    sessionServices: declarations.session,
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
    dispose: (service, { reason }) => {
      log.push(`dispose:worker:${service.sessionID}:${reason}`);
      if (options.failSession === true) throw new Error("boom");
    },
  });
  const wiring = createOpenCodeLifecycleWiring({
    extensionServices: [extension] as const,
    sessionServices: [session] as const,
  });
  return { wiring, log };
}

describe("OpenCode lifecycle wiring — first use", () => {
  it("creates the session scope without waiting for session.created", async () => {
    const wiring = buildWiring();
    sessionAgentRegistry.bind("s1", "dolphin");

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
    assert.deepEqual(log.slice(3), ["dispose:worker:s1:session.deleted"]);

    await wiring.dispose();
    assert.deepEqual(log.slice(4), [
      "dispose:worker:s2:dispose",
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

  it("releases the process-level records of an owned deleted session", async () => {
    const wiring = buildWiring();
    await wiring.ensureSession("s1");
    sessionAgentRegistry.bind("s1", "dolphin");
    setModelLimit("s1", 1000, "model");

    await wiring.handleEvent(sessionEvent("session.deleted", "s1"));

    assert.equal(sessionAgentRegistry.resolve("s1"), undefined);
    assert.equal(getModelLimit("s1"), undefined);
  });

  it("keeps the fallback cleanup for a deleted session it never owned", async () => {
    const wiring = buildWiring();
    // The host wrote process-level records for a session whose events
    // predate this plugin instance: no scope exists, the records do.
    sessionAgentRegistry.bind("ghost", "dolphin");
    setModelLimit("ghost", 1000, "model");

    await wiring.handleEvent(sessionEvent("session.deleted", "ghost"));

    assert.equal(sessionAgentRegistry.resolve("ghost"), undefined);
    assert.equal(getModelLimit("ghost"), undefined);
  });

  it("leaves an unrelated session's records alone on deletion", async () => {
    const wiring = buildWiring();
    await wiring.ensureSession("s1");
    await wiring.ensureSession("s2");
    sessionAgentRegistry.bind("s1", "dolphin");
    sessionAgentRegistry.bind("s2", "dolphin");

    await wiring.handleEvent(sessionEvent("session.deleted", "s1"));

    assert.equal(sessionAgentRegistry.resolve("s2"), "dolphin");
  });
});

describe("OpenCode lifecycle wiring — deletion boundary", () => {
  it("releases a created-then-deleted session exactly once", async () => {
    const { deletes } = sandboxStore();
    const wiring = buildWiring();

    await wiring.handleEvent(sessionEvent("session.created", "s1"));
    sessionAgentRegistry.bind("s1", "dolphin");
    await wiring.handleEvent(sessionEvent("session.deleted", "s1"));

    assert.deepEqual(
      deletes,
      ["s1"],
      "the scope disposer must not be followed by the unknown fallback",
    );
    assert.equal(
      sessionAgentRegistry.resolve("s1"),
      undefined,
      "the scope disposer still released the session's records",
    );
  });

  it("releases a first-use session exactly once", async () => {
    const { deletes } = sandboxStore();
    const wiring = buildWiring();
    await wiring.ensureSession("s1");
    sessionAgentRegistry.bind("s1", "dolphin");

    await wiring.handleEvent(sessionEvent("session.deleted", "s1"));

    assert.deepEqual(deletes, ["s1"]);
    assert.equal(sessionAgentRegistry.resolve("s1"), undefined);
  });

  it("keeps the unknown-session fallback for a deleted ghost", async () => {
    const { deletes } = sandboxStore();
    const wiring = buildWiring();
    sessionAgentRegistry.bind("ghost", "dolphin");

    await wiring.handleEvent(sessionEvent("session.deleted", "ghost"));

    assert.deepEqual(deletes, ["ghost"]);
    assert.equal(sessionAgentRegistry.resolve("ghost"), undefined);
  });

  it("keeps the persisted context of the sessions a dispose stops", async () => {
    const { store, deletes } = sandboxStore();
    const wiring = buildWiring();
    await wiring.ensureSession("s1");
    stageBlock("s1");
    sessionAgentRegistry.bind("s1", "dolphin");

    await wiring.dispose();

    assert.deepEqual(deletes, [], "a dispose must not delete persisted state");
    assert.equal(store.load("s1").blocks.get(1)?.summary, "kept");
    assert.equal(sessionAgentRegistry.resolve("s1"), "dolphin");
  });

  it("deletes the context when the host reports the deletion after a dispose", async () => {
    const { store, deletes } = sandboxStore();
    const wiring = buildWiring();
    await wiring.ensureSession("s1");
    stageBlock("s1");

    await wiring.dispose();
    await wiring.handleEvent(sessionEvent("session.deleted", "s1"));

    assert.deepEqual(deletes, ["s1"]);
    assert.equal(store.load("s1").blocks.size, 0);
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
      "dispose:worker:s1:dispose",
      "dispose:worker:s2:dispose",
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

describe("session scopes around the assembled hooks", () => {
  /** The session ids the wrapper asked the lifecycle to ensure. */
  function recorder() {
    const asked: Array<string | null | undefined> = [];
    return {
      asked,
      ensure: async (sessionID: string | null | undefined) => {
        asked.push(sessionID);
        return null;
      },
    };
  }

  it("ensures the session a hook names before its body runs", async () => {
    const { asked, ensure } = recorder();
    const seen: string[] = [];
    const hooks = withEnsuredSessions(
      {
        "tool.execute.before": async (input: { sessionID: string }) => {
          // The scope exists by the time the handler reads session state.
          seen.push(`body:${input.sessionID}:${asked.length}`);
        },
      },
      ensure,
    );

    await (hooks["tool.execute.before"] as (input: unknown) => Promise<void>)({
      sessionID: "s1",
    });

    assert.deepEqual(asked, ["s1"]);
    assert.deepEqual(seen, ["body:s1:1"]);
  });

  it("derives the transform's session from the transcript it received", async () => {
    const { asked, ensure } = recorder();
    const hooks = withEnsuredSessions(
      {
        "experimental.chat.messages.transform": async (
          _input: unknown,
          _output: unknown,
        ) => {},
      },
      ensure,
    );

    await (
      hooks["experimental.chat.messages.transform"] as (
        input: unknown,
        output: unknown,
      ) => Promise<void>
    )({}, { messages: [{ info: { sessionID: "s2" }, parts: [] }] });

    assert.deepEqual(asked, ["s2"]);
  });

  it("leaves the config hook alone: it addresses no session", async () => {
    const { asked, ensure } = recorder();
    const config = async () => {};
    const hooks = withEnsuredSessions({ config }, ensure);

    assert.equal(
      hooks.config,
      config,
      "the config hook runs before any session exists",
    );
    await (hooks.config as () => Promise<void>)();

    assert.deepEqual(asked, [], "config must not enter the session lifecycle");
  });

  it("runs a hook naming no session and creates nothing", async () => {
    const { asked, ensure } = recorder();
    let ran = 0;
    const hooks = withEnsuredSessions(
      {
        "tool.execute.before": async () => {
          ran += 1;
        },
      },
      ensure,
    );

    // A malformed call carries no session id; the wrapper asks for nothing
    // and the handler still runs.
    await (hooks["tool.execute.before"] as () => Promise<void>)();

    assert.equal(ran, 1);
    assert.deepEqual(asked, [null]);
  });

  it("leaves the event hook and non-function hooks alone", async () => {
    const { ensure } = recorder();
    const event = async () => {};
    const tool = { compress: { execute: async () => "ok" } };
    const hooks = withEnsuredSessions({ event, tool }, ensure);

    assert.equal(hooks.event, event, "the event hook ensures its own paths");
    assert.equal(hooks.tool, tool);
  });

  it("propagates a handler's error unchanged", async () => {
    const { ensure } = recorder();
    const hooks = withEnsuredSessions(
      {
        "command.execute.before": async () => {
          throw new Error("command handled");
        },
      },
      ensure,
    );

    await assert.rejects(
      () => (hooks["command.execute.before"] as () => Promise<void>)(),
      /command handled/,
    );
  });
});
