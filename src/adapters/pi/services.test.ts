/**
 * Tests for the pi host services (`services.ts`).
 *
 * These are the state owners the entry point used to keep as unnamed
 * locals: the session contexts, the tool baselines, the published profile
 * catalog, the todo catalog, the fleet surface and the switch surface.  The
 * tests drive them through the real lifecycle kernel, so they read what an
 * event or a consumer observes — what a baseline capture costs, what a
 * lazy reader sees after the profile is published, what survives an
 * extension stop — rather than which fields the services keep.
 */
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { createContextRuntime } from "../../core/context/runtime.js";
import {
  createLifecycleKernel,
  defineExtensionService,
} from "../../core/lifecycle/index.js";
import { createSessionAgentResource } from "../../core/session/agent.js";
import {
  contextSessionResources,
  createSessionResourceCatalog,
} from "../../core/session/resources.js";
import type { SkillEntry } from "../../core/skills.js";
import type { RunSnapshot } from "../../core/subagent/registry.js";
import type { TodoPhase } from "../../core/todo/types.js";
import { piScope, renderZooWidget } from "../../testkits/pi-wiring.js";
import { _getBufferForTesting, _resetForTesting } from "../../utils/logger.js";
import { createPiLifecycleWiring } from "./lifecycle-wiring.js";
import { createPiProcessState, type PiProcessState } from "./process.js";
import {
  createPiHostServices,
  createPiProfileCatalog,
  createPiSettleState,
  createPiToolBaselines,
  type PiServiceHost,
} from "./services.js";
import type { ExtensionAPI } from "./types.js";
import { buildPiCapabilities } from "./wire.js";

/** The pi process this test file drives: one owner per test. */
let piProcess: PiProcessState = createPiProcessState();

beforeEach(() => {
  piProcess = createPiProcessState();
  _resetForTesting();
});

/**
 * A pi API stand-in that counts the baseline reads.
 *
 * `getActiveTools` is the action method pi forbids during extension loading,
 * so the count is how these tests prove the capture stays lazy.
 */
function fakeApi(tools: string[]) {
  const state = { reads: 0 };
  const api = {
    getActiveTools() {
      state.reads += 1;
      return tools;
    },
    setActiveTools() {},
  } as unknown as ExtensionAPI;
  return { state, api };
}

/** The context records of the instance under test. */
const CONTEXT = createContextRuntime();

/** The session records of the instance under test. */
const SESSION_CATALOG = createSessionResourceCatalog([
  ...contextSessionResources(CONTEXT),
  createSessionAgentResource(createPiProcessState().sessionAgents),
]);

/** The pure host helpers the services take from the entry point. */
const HOST_HELPERS = {
  colorizeAgent: (name: string) => name,
  titleForRun: (run: RunSnapshot) => run.agent,
  borderColorizeForRun: () => undefined,
};

/** A profile enabling only the todo-continuation settle strategy. */
const SETTLE_ZOO = {
  mode: {
    poly: {
      agents: ["dolphin"],
      skills: [],
      hooks: ["todo-continuation"],
      tools: [],
      commands: [],
    },
  },
  continuation: { max_wakes: 3 },
};

/** The agent table marking that profile's agent primary. */
const SETTLE_RAW = { agent: { dolphin: { mode: "primary" } } };

/** A one-phase todo state. */
function phase(contents: string[]): TodoPhase[] {
  return [
    {
      name: "Todos",
      tasks: contents.map((content) => ({ content, status: "pending" })),
    },
  ];
}

/**
 * A session transcript holding one todo snapshot.
 *
 * The todo tool persists its state as the `details` of a tool-result
 * message, so a transcript is the `sessionManager.getBranch()` entry list
 * the pi scanner reads.
 */
function transcript(contents: string[]): unknown[] {
  return [
    {
      type: "message",
      message: {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "todo",
        content: [],
        isError: false,
        details: { op: "init", phases: phase(contents) },
      },
    },
  ];
}

describe("pi tool baselines", () => {
  it("captures the active tools on first use and never at construction", () => {
    const { state, api } = fakeApi(["edit", "bash"]);
    const baselines = createPiToolBaselines(api);
    assert.equal(state.reads, 0, "construction must not read the host");

    assert.deepEqual(baselines.primary(), ["edit", "bash"]);
    assert.equal(state.reads, 1);
    assert.deepEqual(baselines.primary(), ["edit", "bash"]);
    assert.equal(state.reads, 1, "the first capture is reused");

    // Both faces read the capture made on first use, so neither can observe
    // a tool face the other one trimmed.
    assert.deepEqual(baselines.subagent(), ["edit", "bash"]);
    assert.equal(state.reads, 1, "the subagent face shares the capture");
  });

  it("freezes both baselines against a live host array", () => {
    // pi hands back its own tool list; a later `setActiveTools` mutates that
    // same array, so a baseline that kept the reference would drift.
    const tools = ["edit", "bash"];
    const { api } = fakeApi(tools);
    const baselines = createPiToolBaselines(api);

    assert.deepEqual(baselines.primary(), ["edit", "bash"]);
    assert.deepEqual(baselines.subagent(), ["edit", "bash"]);

    tools.push("write");
    tools.splice(0, 1);

    assert.deepEqual(baselines.primary(), ["edit", "bash"]);
    assert.deepEqual(
      baselines.subagent(),
      ["edit", "bash"],
      "the subagent baseline must not track the host's live array",
    );
  });

  it("computes the subagent baseline from the untrimmed capture", () => {
    const tools = ["fetch", "edit", "bash"];
    const { state, api } = fakeApi(tools);
    const baselines = createPiToolBaselines(api);

    // The main session captures the shared baseline, then its trim removes
    // the primary's denied tool from the live face.
    assert.deepEqual(baselines.primary(), ["fetch", "edit", "bash"]);
    tools.splice(0, 1);

    // A sub-session's face is the untrimmed set: only the target's own
    // denies apply there, so the caller's deny never reaches it.
    assert.deepEqual(baselines.subagent(), ["fetch", "edit", "bash"]);
    assert.equal(state.reads, 1, "both faces share one host read");
  });

  it("never hands ask to a sub-session", () => {
    // The host configuration activated ask before the capture; a sub-session
    // starts on the SDK, whose event contexts yield no question channel.
    const { api } = fakeApi(["fetch", "edit", "ask"]);
    const baselines = createPiToolBaselines(api);

    assert.deepEqual(baselines.primary(), ["fetch", "edit", "ask"]);
    assert.deepEqual(
      baselines.subagent(),
      ["fetch", "edit"],
      "the subagent baseline must not carry ask",
    );
  });

  it("shares the first capture whichever face reads first", () => {
    const tools = ["fetch", "edit"];
    const { state, api } = fakeApi(tools);
    const baselines = createPiToolBaselines(api);

    assert.deepEqual(baselines.subagent(), ["fetch", "edit"]);
    tools.splice(0, 1);

    assert.deepEqual(baselines.primary(), ["fetch", "edit"]);
    assert.equal(state.reads, 1, "the shared capture is reused");
  });

  it("caches an empty report instead of re-reading the host", () => {
    const { state, api } = fakeApi([]);
    const baselines = createPiToolBaselines(api);

    assert.deepEqual(baselines.primary(), []);
    assert.deepEqual(baselines.primary(), []);
    assert.equal(state.reads, 1);
  });

  it("serves no baseline after release (no stale cache)", () => {
    const { state, api } = fakeApi(["edit", "bash"]);
    const baselines = createPiToolBaselines(api);
    baselines.primary();
    baselines.subagent();

    baselines.release();

    assert.equal(baselines.primary(), undefined);
    assert.equal(baselines.subagent(), undefined);
    assert.equal(state.reads, 1, "a stopped scope never reads the host again");
  });

  it("serves no baseline without a pi API instance", () => {
    const baselines = createPiToolBaselines(undefined);

    assert.equal(baselines.primary(), undefined);
    assert.equal(baselines.subagent(), undefined);
  });
});

describe("pi profile catalog", () => {
  /** Two selected entries, with their paths. */
  const ENTRIES: SkillEntry[] = [
    { name: "beaver-tdd", path: "/zoo/skills/beaver-tdd" },
    { name: "wiki-query", path: "/zoo/skills/wiki-query" },
  ];

  it("publishes the selected skills to every lazy reader", () => {
    const catalog = createPiProfileCatalog();
    // The two consumers: the subagent driver's per-run thunk and the
    // resources_discover handler's read.
    const driverRead = () => catalog.get();
    assert.deepEqual(catalog.get(), [], "nothing is published before compose");

    catalog.publish(ENTRIES);

    assert.deepEqual(driverRead(), ENTRIES);
    assert.deepEqual(catalog.get(), ENTRIES);
  });

  it("hands out copies so a reader cannot corrupt the publication", () => {
    const catalog = createPiProfileCatalog();
    catalog.publish(ENTRIES);

    catalog.get().push({ name: "injected", path: "/zoo/skills/injected" });

    assert.deepEqual(catalog.get(), ENTRIES);
  });

  it("publishes nothing after release", () => {
    const catalog = createPiProfileCatalog();
    catalog.publish(ENTRIES);

    catalog.release();

    assert.deepEqual(catalog.get(), []);
  });

  it("refuses a publication after release", () => {
    const catalog = createPiProfileCatalog();

    catalog.release();
    // The stop is terminal: a late composition (a reload that re-runs the
    // factory on the same scope) must not revive the catalog.
    catalog.publish(ENTRIES);

    assert.deepEqual(catalog.get(), []);
  });
});

describe("pi settle state", () => {
  it("counts the open blocking prompts and never goes below zero", () => {
    const state = createPiSettleState();
    assert.equal(state.awaitingInput(), false, "no prompt is open yet");

    state.enterPrompt();
    assert.equal(state.awaitingInput(), true);
    state.enterPrompt();
    state.leavePrompt();
    assert.equal(state.awaitingInput(), true, "one prompt is still open");
    state.leavePrompt();
    state.leavePrompt();
    assert.equal(state.awaitingInput(), false, "the count stops at zero");
  });

  it("replaces the recorded run and drops a stale prompt count", () => {
    const state = createPiSettleState();

    state.recordRun([{ role: "user" }]);
    state.recordRun([{ role: "assistant" }]);
    assert.deepEqual(state.lastRun(), [{ role: "assistant" }]);

    state.enterPrompt();
    state.resetPrompt();
    assert.equal(state.awaitingInput(), false);
    // A start notice is not a stop: the recorded run stays.
    assert.deepEqual(state.lastRun(), [{ role: "assistant" }]);
  });

  it("serves nothing once it is released", () => {
    const state = createPiSettleState();
    state.recordRun([{ role: "assistant" }]);
    state.enterPrompt();

    state.release();
    state.recordRun([{ role: "user" }]);
    state.enterPrompt();

    assert.deepEqual(state.lastRun(), []);
    assert.equal(state.awaitingInput(), false);
  });
});

describe("pi host services — declarations", () => {
  /**
   * Build the declarations over a pi API stand-in and a profile.
   *
   * @param piApi - The pi API stand-in.
   * @param zoo - The `zoo` section; empty for a null profile.
   * @param raw - The whole config root (the agent tables).
   * @returns The host inputs the declarations close over.
   */
  function buildHost(
    piApi?: ExtensionAPI,
    zoo: any = {},
    raw: any = {},
  ): PiServiceHost {
    const scope = piScope(zoo, raw);
    return {
      scope,
      process: piProcess,
      piApi,
      appendEntry: undefined,
      capabilities: () => buildPiCapabilities(scope, piProcess),
      contextRuntime: CONTEXT,
      sessionCatalog: SESSION_CATALOG,
      ...HOST_HELPERS,
    };
  }

  it("creates the extension services before any session exists", async () => {
    const { api } = fakeApi(["edit"]);
    const declarations = createPiHostServices(buildHost(api));
    const wiring = createPiLifecycleWiring({
      extensionServices: declarations.extension,
      sessionServices: declarations.session,
      sessionCatalog: SESSION_CATALOG,
      getSessionID: (ctx) => (ctx as { id?: string } | undefined)?.id,
    });

    const extension = await wiring.activateExtension();

    // The pre-compose surfaces exist now; no session was created to get
    // here, so the composition can be built without inventing a session.
    assert.equal(
      extension.services.sessionContexts.forSession("s1"),
      undefined,
    );
    assert.equal(typeof extension.services.adapter.history, "function");
    assert.equal(typeof extension.services.toolHost.notify, "function");
    assert.equal(
      extension.services.switchHost.host?.newSession !== undefined,
      true,
    );
  });

  it("binds a session's todo store when the session is first used", async () => {
    const { api } = fakeApi(["edit"]);
    const declarations = createPiHostServices(buildHost(api));
    const wiring = createPiLifecycleWiring({
      extensionServices: declarations.extension,
      sessionServices: declarations.session,
      sessionCatalog: SESSION_CATALOG,
      getSessionID: (ctx) => (ctx as { id?: string } | undefined)?.id,
    });
    const { services } = await wiring.activateExtension();

    assert.deepEqual(await services.todo.get("s1"), []);

    await wiring.ensureSession({ id: "s1" });
    services.todo.set("s1", phase(["a"]));
    assert.deepEqual(await services.todo.get("s1"), phase(["a"]));

    // A second session gets its own store: the first one's state is not
    // reachable through it.
    await wiring.ensureSession({ id: "s2" });
    assert.deepEqual(await services.todo.get("s2"), []);
    assert.deepEqual(await services.todo.get("s1"), phase(["a"]));
  });

  it("logs a throwing transcript read and never caches the failure", async () => {
    const { api } = fakeApi(["edit"]);
    const declarations = createPiHostServices(buildHost(api));
    const wiring = createPiLifecycleWiring({
      extensionServices: declarations.extension,
      sessionServices: declarations.session,
      sessionCatalog: SESSION_CATALOG,
      getSessionID: (ctx) => (ctx as { id?: string } | undefined)?.id,
    });
    const { services } = await wiring.activateExtension();
    let reads = 0;
    services.sessionContexts.bind("s1", {
      sessionManager: {
        getSessionId: () => "s1",
        getBranch: () => {
          reads += 1;
          throw new Error("branch unreadable");
        },
      },
    });
    await wiring.ensureSession({ id: "s1" });

    // The failing read is reported, and the store's no-cache-on-failure
    // policy is preserved: the next access retries instead of pinning an
    // empty plan.
    assert.deepEqual(await services.todo.get("s1"), []);
    assert.deepEqual(await services.todo.get("s1"), []);
    assert.equal(reads, 2, "a failed read is not cached as empty");
    assert.equal(
      _getBufferForTesting().filter(
        (entry) => entry.event === "todo_history_failed",
      ).length,
      2,
    );
  });

  it("restores each session's plan from that session's own transcript", async () => {
    const { api } = fakeApi(["edit"]);
    const declarations = createPiHostServices(buildHost(api));
    const wiring = createPiLifecycleWiring({
      extensionServices: declarations.extension,
      sessionServices: declarations.session,
      sessionCatalog: SESSION_CATALOG,
      getSessionID: (ctx) => (ctx as { id?: string } | undefined)?.id,
    });
    const { services } = await wiring.activateExtension();
    // Every scan records the session whose transcript it read, so a read of
    // one session can be proven not to touch another's history.
    const scans: string[] = [];
    const publish = (sessionID: string, task: string): void => {
      services.sessionContexts.bind(sessionID, {
        sessionManager: {
          getSessionId: () => sessionID,
          getBranch: () => {
            scans.push(sessionID);
            return transcript([task]);
          },
        },
      });
    };
    publish("s1", "plan-a");
    publish("s2", "plan-b");
    await wiring.ensureSession({ id: "s1" });
    await wiring.ensureSession({ id: "s2" });

    // The two sessions are interleaved: the latest handled one is s2, yet a
    // read for s1 must restore s1's plan, not s2's.
    // A restore runs the one-in-progress normalisation, so the first task
    // of the restored plan is `in_progress`.
    assert.deepEqual(await services.todo.get("s1"), [
      {
        name: "Todos",
        tasks: [{ content: "plan-a", status: "in_progress" }],
      },
    ]);
    assert.deepEqual(await services.todo.get("s2"), [
      {
        name: "Todos",
        tasks: [{ content: "plan-b", status: "in_progress" }],
      },
    ]);
    assert.deepEqual(scans, ["s1", "s2"], "each read scans its own transcript");
  });

  it("fails closed for a session that bound no context", async () => {
    const { api } = fakeApi(["edit"]);
    const declarations = createPiHostServices(buildHost(api));
    const wiring = createPiLifecycleWiring({
      extensionServices: declarations.extension,
      sessionServices: declarations.session,
      sessionCatalog: SESSION_CATALOG,
      getSessionID: (ctx) => (ctx as { id?: string } | undefined)?.id,
    });
    const { services } = await wiring.activateExtension();
    const scans: string[] = [];
    services.sessionContexts.bind("s1", {
      sessionManager: {
        getSessionId: () => "s1",
        getBranch: () => {
          scans.push("s1");
          return transcript(["plan-a"]);
        },
      },
    });

    // A session this host never observed has no transcript to read: it must
    // not borrow another session's.
    assert.deepEqual(await services.todo.get("s-unknown"), []);
    assert.deepEqual(await services.todo.get("s-unknown"), []);
    assert.deepEqual(scans, [], "no other session's transcript is scanned");
  });

  it("serves tool-host toasts through the session contexts", async () => {
    const { api } = fakeApi(["edit"]);
    const declarations = createPiHostServices(buildHost(api));
    const wiring = createPiLifecycleWiring({
      extensionServices: declarations.extension,
      sessionServices: declarations.session,
      sessionCatalog: SESSION_CATALOG,
    });
    const { services } = await wiring.activateExtension();
    const toasts: string[] = [];
    services.sessionContexts.bind("s1", {
      ui: { notify: (message: string) => toasts.push(message) },
    });

    services.toolHost.toast?.("s1", {
      source: "context-pruning",
      level: "info",
      text: "已折叠 3 条消息",
    });

    assert.deepEqual(toasts, ["[zoo][context-pruning] 已折叠 3 条消息"]);
  });

  it("keeps the switch surface closed without a pi API instance", async () => {
    const declarations = createPiHostServices(buildHost(undefined));
    const wiring = createPiLifecycleWiring({
      extensionServices: declarations.extension,
      sessionServices: declarations.session,
      sessionCatalog: SESSION_CATALOG,
    });

    const { services } = await wiring.activateExtension();

    assert.equal(services.switchHost.host, undefined);
    // Claiming and draining without the surface are no-ops, never throws:
    // the `session_start` and `before_agent_start` handlers call them
    // unconditionally.
    services.switchHost.claimPending("s1", {
      reason: "new",
      parentSession: "s0",
    });
    assert.equal(services.switchHost.drainPendingOps("s1"), undefined);
  });

  it("releases the extension-owned state when the extension stops", async () => {
    const { state, api } = fakeApi(["edit"]);
    const declarations = createPiHostServices(buildHost(api));
    const wiring = createPiLifecycleWiring({
      extensionServices: declarations.extension,
      sessionServices: declarations.session,
      sessionCatalog: SESSION_CATALOG,
      getSessionID: (ctx) => (ctx as { id?: string } | undefined)?.id,
    });
    const { services } = await wiring.activateExtension();
    services.sessionContexts.bind("s1", {
      sessionManager: { getSessionId: () => "s1" },
    });
    await wiring.ensureSession({ id: "s1" });
    services.todo.set("s1", phase(["a"]));
    services.profileCatalog.publish([
      { name: "grill", path: "/zoo/skills/grill" },
    ]);
    services.toolBaselines.primary();

    await wiring.stopExtension({ type: "session_shutdown", reason: "quit" });

    assert.equal(services.sessionContexts.forSession("s1"), undefined);
    assert.deepEqual(services.profileCatalog.get(), []);
    assert.equal(services.toolBaselines.primary(), undefined);
    assert.deepEqual(await services.todo.get("s1"), []);
    assert.equal(state.reads, 1, "the stop never re-reads the host");
  });

  it("keeps the fleet widget bound to the live primary", async () => {
    const { api } = fakeApi(["edit"]);
    const declarations = createPiHostServices(buildHost(api));
    const wiring = createPiLifecycleWiring({
      extensionServices: declarations.extension,
      sessionServices: declarations.session,
      sessionCatalog: SESSION_CATALOG,
      getSessionID: (ctx) => (ctx as { id?: string } | undefined)?.id,
    });
    const { services } = await wiring.activateExtension();

    // The widget renders nothing without a primary; with one, the session
    // registration reaches the host ui it was bound to.  The binding is
    // per session, so it names the session under test.
    piProcess.sessionAgents.bind("s1", "dolphin");
    const calls: unknown[] = [];
    services.sessionContexts.bind("s1", {
      sessionManager: { getSessionId: () => "s1" },
      ui: {
        setWidget: (...args: unknown[]) => calls.push(args),
        onTerminalInput: () => () => {},
      },
    });
    await wiring.ensureSession({ id: "s1" });

    services.fleet.register("s1");

    assert.ok(calls.length > 0, "the session's widget is registered");
  });

  it("keeps a stopped session's fleet off its sibling", async () => {
    const { api } = fakeApi(["edit"]);
    const declarations = createPiHostServices(buildHost(api));
    const kernel = createLifecycleKernel({
      extension: declarations.extension,
      session: declarations.session,
    });
    const extensionScope = await kernel.ensureExtension();
    assert.ok(extensionScope !== null);
    const { services } = extensionScope;
    piProcess.sessionAgents.bind("s1", "dolphin");
    piProcess.sessionAgents.bind("s2", "dolphin");
    /** A ui recording the widget registrations of exactly one session. */
    const widgetUi = () => {
      const calls: Array<[string, unknown]> = [];
      const state = { widgets: 0, unsubscribes: 0 };
      const ui = {
        notify: () => {},
        setWidget: (key: string, content: unknown) => {
          state.widgets += 1;
          calls.push([key, content]);
        },
        onTerminalInput: () => () => {
          state.unsubscribes += 1;
        },
      };
      return { ui, calls, state };
    };
    const a = widgetUi();
    const b = widgetUi();
    const contextA = {
      sessionManager: { getSessionId: () => "s1" },
      ui: a.ui,
    };
    const contextB = {
      sessionManager: { getSessionId: () => "s2" },
      ui: b.ui,
    };
    services.sessionContexts.bind("s1", contextA);
    await kernel.ensureSession("s1");
    services.sessionContexts.bind("s2", contextB);
    await kernel.ensureSession("s2");

    services.fleet.register("s1");
    services.fleet.register("s2");
    assert.deepEqual([a.state.widgets, b.state.widgets], [1, 1]);

    // Stopping s1 releases its listener and drops only its own context;
    // s2's fleet and context stay live.
    await kernel.stopSession("s1", "test", "release-runtime");
    assert.deepEqual(a.state, { widgets: 1, unsubscribes: 1 });
    assert.deepEqual(b.state, { widgets: 1, unsubscribes: 0 });
    assert.equal(services.sessionContexts.forSession("s1"), undefined);
    assert.equal(services.sessionContexts.forSession("s2"), contextB);

    // A late call for the stopped session writes nothing; the sibling
    // re-registers through its own (still live) widget.
    services.fleet.register("s1");
    assert.equal(a.state.widgets, 1, "the stopped session registers nothing");
    services.fleet.register("s2");
    assert.equal(b.state.widgets, 2, "the sibling re-seeds its own widget");
    const rendered = renderZooWidget(b.calls);
    try {
      assert.ok(
        rendered.lines.join("\n").includes("dolphin"),
        "the sibling's widget is still alive after its sibling stopped",
      );
    } finally {
      rendered.dispose();
    }
  });

  it("refreshes only the fleet of the session a run change names", async () => {
    const { api } = fakeApi(["edit"]);
    const declarations = createPiHostServices(buildHost(api));
    const kernel = createLifecycleKernel({
      extension: declarations.extension,
      session: declarations.session,
    });
    const extensionScope = await kernel.ensureExtension();
    assert.ok(extensionScope);
    const { services } = extensionScope;
    piProcess.sessionAgents.bind("s1", "dolphin");
    piProcess.sessionAgents.bind("s2", "dolphin");

    /** One session's ui plus a tui counting the widget's render requests. */
    const sessionUi = () => {
      const calls: Array<[string, unknown]> = [];
      const state = { renders: 0 };
      const tui = {
        requestRender: () => {
          state.renders += 1;
        },
      };
      return {
        calls,
        state,
        tui,
        ui: {
          notify: () => {},
          setWidget: (key: string, content: unknown) => {
            calls.push([key, content]);
          },
          onTerminalInput: () => () => {},
        },
      };
    };
    const a = sessionUi();
    const b = sessionUi();
    services.sessionContexts.bind("s1", {
      sessionManager: { getSessionId: () => "s1" },
      ui: a.ui,
    });
    await kernel.ensureSession("s1");
    services.sessionContexts.bind("s2", {
      sessionManager: { getSessionId: () => "s2" },
      ui: b.ui,
    });
    await kernel.ensureSession("s2");
    services.fleet.register("s1");
    services.fleet.register("s2");

    const widgetA = renderZooWidget(a.calls, 80, a.tui);
    const widgetB = renderZooWidget(b.calls, 80, b.tui);
    try {
      const beforeA = a.state.renders;
      const beforeB = b.state.renders;

      piProcess.runs.start({
        id: "run-1",
        agent: "lynx",
        parentSession: "s1",
        startedAt: 1,
      });
      piProcess.runs.update("run-1", { tokens: 5 });
      piProcess.runs.finish("run-1", { status: "done", endedAt: 2 });

      assert.equal(
        a.state.renders - beforeA,
        3,
        "the owning session's fleet repaints on every run change",
      );
      assert.equal(
        b.state.renders,
        beforeB,
        "the sibling session's widget must never repaint",
      );
    } finally {
      widgetA.dispose();
      widgetB.dispose();
    }
  });

  it("stops routing run changes once the extension stops", async () => {
    const { api } = fakeApi(["edit"]);
    const declarations = createPiHostServices(buildHost(api));
    const kernel = createLifecycleKernel({
      extension: declarations.extension,
      session: declarations.session,
    });
    const extensionScope = await kernel.ensureExtension();
    assert.ok(extensionScope);
    const { services } = extensionScope;
    piProcess.sessionAgents.bind("s1", "dolphin");
    const calls: Array<[string, unknown]> = [];
    const state = { renders: 0 };
    const tui = {
      requestRender: () => {
        state.renders += 1;
      },
    };
    services.sessionContexts.bind("s1", {
      sessionManager: { getSessionId: () => "s1" },
      ui: {
        notify: () => {},
        setWidget: (key: string, content: unknown) => {
          calls.push([key, content]);
        },
        onTerminalInput: () => () => {},
      },
    });
    await kernel.ensureSession("s1");
    services.fleet.register("s1");
    const widget = renderZooWidget(calls, 80, tui);
    try {
      piProcess.runs.start({
        id: "run-1",
        agent: "lynx",
        parentSession: "s1",
        startedAt: 1,
      });
      assert.equal(state.renders, 1, "a live extension routes the change");

      await kernel.stopExtension("extension.stop");
      piProcess.runs.start({
        id: "run-2",
        agent: "lynx",
        parentSession: "s1",
        startedAt: 2,
      });
      assert.equal(
        state.renders,
        1,
        "a stopped extension must not repaint anything",
      );
    } finally {
      widget.dispose();
    }
  });

  it("keeps each session's settle state in its own scope", async () => {
    const { api } = fakeApi(["edit"]);
    const declarations = createPiHostServices(buildHost(api));
    const wiring = createPiLifecycleWiring({
      extensionServices: declarations.extension,
      sessionServices: declarations.session,
      sessionCatalog: SESSION_CATALOG,
      getSessionID: (ctx) => (ctx as { id?: string } | undefined)?.id,
    });
    const stateOf = (id: string) =>
      wiring.runSession({ id }, (_permit, services) => services.settleState);

    const first = await stateOf("s1");
    const second = await stateOf("s2");
    assert.ok(first !== undefined && second !== undefined);
    assert.notEqual(first, second, "each session owns its own state");

    first.recordRun([{ role: "assistant" }]);
    first.enterPrompt();
    assert.deepEqual(second.lastRun(), []);
    assert.equal(second.awaitingInput(), false);

    // A later call for the same session reads the state it already wrote.
    const again = await stateOf("s1");
    assert.equal(again, first);
    assert.deepEqual(first.lastRun(), [{ role: "assistant" }]);
    assert.equal(first.awaitingInput(), true);
  });

  it("releases a session's settle state with its scope", async () => {
    const { api } = fakeApi(["edit"]);
    const declarations = createPiHostServices(buildHost(api));
    const kernel = createLifecycleKernel({
      extension: declarations.extension,
      session: declarations.session,
    });
    const scope = await kernel.ensureSession("s1");
    assert.ok(scope !== null);
    const state = scope.services.settleState;
    state.recordRun([{ role: "assistant" }]);
    state.enterPrompt();

    await kernel.stopSession("s1", "quit", "release-runtime");

    // The state went away with the scope: a retained reference serves
    // nothing, so no later read sees the stopped session's run.
    assert.deepEqual(state.lastRun(), []);
    assert.equal(state.awaitingInput(), false);
  });

  it("gives each session scope its own loop handle", async () => {
    const { api } = fakeApi(["edit"]);
    const declarations = createPiHostServices(
      buildHost(api, SETTLE_ZOO, SETTLE_RAW),
    );
    const wiring = createPiLifecycleWiring({
      extensionServices: declarations.extension,
      sessionServices: declarations.session,
      sessionCatalog: SESSION_CATALOG,
      getSessionID: (ctx) => (ctx as { id?: string } | undefined)?.id,
    });
    const loopOf = (id: string) =>
      wiring.runSession({ id }, (_permit, services) => services.loopSession);

    const first = await loopOf("s1");
    const second = await loopOf("s2");
    assert.ok(first !== undefined && second !== undefined);
    assert.notEqual(first, second, "each session owns its own loop handle");

    first.record("strategy");
    assert.equal(first.used("strategy"), 1);
    assert.equal(second.used("strategy"), 0, "a sibling is untouched");

    // A later call for the same session reads the handle it already wrote.
    assert.equal(await loopOf("s1"), first);
  });

  it("serves no loop handle when the profile composes no strategy", async () => {
    const declarations = createPiHostServices(buildHost(undefined));
    const wiring = createPiLifecycleWiring({
      extensionServices: declarations.extension,
      sessionServices: declarations.session,
      sessionCatalog: SESSION_CATALOG,
      getSessionID: (ctx) => (ctx as { id?: string } | undefined)?.id,
    });

    const loop = await wiring.runSession(
      { id: "s1" },
      (_permit, services) => services.loopSession,
    );

    assert.equal(loop, undefined);
  });

  it("drops a session's loop state with its scope", async () => {
    const { api } = fakeApi(["edit"]);
    const declarations = createPiHostServices(
      buildHost(api, SETTLE_ZOO, SETTLE_RAW),
    );
    const kernel = createLifecycleKernel({
      extension: declarations.extension,
      session: declarations.session,
    });
    const first = (await kernel.ensureSession("s1"))?.services.loopSession;
    const second = (await kernel.ensureSession("s2"))?.services.loopSession;
    assert.ok(first !== undefined && second !== undefined);
    first.record("strategy");
    second.record("strategy");

    await kernel.stopSession("s1", "quit", "release-runtime");

    // The scope owned the handle, so the stopped session's budget is
    // unreachable and no sibling is affected.
    assert.equal(await kernel.ensureSession("s1"), null);
    assert.equal(second.used("strategy"), 1);
  });

  it("declares no session-scoped service as an extension service", () => {
    const declarations = createPiHostServices(buildHost(undefined));
    const extensionNames: string[] = declarations.extension.map(
      (def) => def.name,
    );
    const sessionNames: string[] = declarations.session.map((def) => def.name);

    // The kernel rejects a name declared in both scopes; keeping the sets
    // disjoint here states the dependency direction explicitly.
    assert.deepEqual(
      extensionNames.filter((name) => sessionNames.includes(name)),
      [],
    );
    assert.deepEqual(extensionNames.slice(0, 4), [
      "runScope",
      "sessionContexts",
      "adapter",
      "toolHost",
    ]);
  });

  it("declares the session context owner before the services reading it", () => {
    const declarations = createPiHostServices(buildHost(undefined));

    // A session's services are disposed in reverse creation order, so the
    // context view that session's todo store and fleet read must be created
    // before both of them: it is then released last.
    assert.deepEqual(
      declarations.session.map((definition) => definition.name),
      [
        "sessionContext",
        "todoStore",
        "fleetSession",
        "loopSession",
        "settleState",
        "sessionResources",
      ],
    );
  });

  it("keeps the session contexts and adapter creation order", async () => {
    const order: string[] = [];
    const live = defineExtensionService({
      name: "sessionContextsProbe",
      deps: [],
      create: () => {
        order.push("sessionContexts");
        return {};
      },
    });
    const adapter = defineExtensionService({
      name: "adapterProbe",
      deps: [live],
      create: () => {
        order.push("adapter");
        return {};
      },
    });
    const wiring = createPiLifecycleWiring({
      extensionServices: [live, adapter],
      sessionServices: [],
      sessionCatalog: SESSION_CATALOG,
    });

    await wiring.activateExtension();

    assert.deepEqual(order, ["sessionContexts", "adapter"]);
  });
});
