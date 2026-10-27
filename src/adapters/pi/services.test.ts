/**
 * Tests for the pi host services (`services.ts`).
 *
 * These are the state owners the entry point used to keep as unnamed
 * locals: the live context, the tool baselines, the published profile
 * catalog, the todo catalog, the fleet surface and the switch surface.  The
 * tests drive them through the real lifecycle kernel, so they read what an
 * event or a consumer observes — what a baseline capture costs, what a
 * lazy reader sees after the profile is published, what survives an
 * extension stop — rather than which fields the services keep.
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  createLifecycleKernel,
  defineExtensionService,
} from "../../core/lifecycle/index.js";
import {
  _resetForTesting as resetIdentityForTesting,
  setPrimary,
} from "../../core/subagent/identity.js";
import type { SubagentRun } from "../../core/subagent/registry.js";
import type { TodoPhase } from "../../core/todo/types.js";
import { renderZooWidget } from "../../testkits/pi-wiring.js";
import { _getBufferForTesting, _resetForTesting } from "../../utils/logger.js";
import { createPiLifecycleWiring } from "./lifecycle-wiring.js";
import {
  createPiHostServices,
  createPiProfileCatalog,
  createPiToolBaselines,
  type PiServiceHost,
} from "./services.js";
import type { ExtensionAPI } from "./types.js";

afterEach(() => {
  resetIdentityForTesting();
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

/** The pure host helpers the services take from the entry point. */
const HOST_HELPERS = {
  colorizeAgent: (name: string) => name,
  titleForRun: (run: SubagentRun) => run.agent,
  borderColorizeForRun: () => undefined,
};

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

    // The subagent baseline is its own capture: merging the two would make
    // one consumer's trim visible to the other.
    assert.deepEqual(baselines.subagent(), ["edit", "bash"]);
    assert.equal(state.reads, 2);
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
    assert.equal(state.reads, 2, "a stopped scope never reads the host again");
  });

  it("serves no baseline without a pi API instance", () => {
    const baselines = createPiToolBaselines(undefined);

    assert.equal(baselines.primary(), undefined);
    assert.equal(baselines.subagent(), undefined);
  });
});

describe("pi profile catalog", () => {
  it("publishes the composed skills to every lazy reader", () => {
    const catalog = createPiProfileCatalog();
    // The two consumers: the subagent driver's per-run thunk and the
    // resources_discover handler's read.
    const driverRead = () => catalog.get();
    assert.deepEqual(catalog.get(), [], "nothing is published before compose");

    catalog.publish(["beaver-tdd", "wiki-query"]);

    assert.deepEqual(driverRead(), ["beaver-tdd", "wiki-query"]);
    assert.deepEqual(catalog.get(), ["beaver-tdd", "wiki-query"]);
  });

  it("hands out copies so a reader cannot corrupt the publication", () => {
    const catalog = createPiProfileCatalog();
    catalog.publish(["grill"]);

    const names = catalog.get();
    names.push("injected");

    assert.deepEqual(catalog.get(), ["grill"]);
  });

  it("publishes nothing after release", () => {
    const catalog = createPiProfileCatalog();
    catalog.publish(["grill"]);

    catalog.release();

    assert.deepEqual(catalog.get(), []);
  });

  it("refuses a publication after release", () => {
    const catalog = createPiProfileCatalog();

    catalog.release();
    // The stop is terminal: a late composition (a reload that re-runs the
    // factory on the same scope) must not revive the catalog.
    catalog.publish(["grill"]);

    assert.deepEqual(catalog.get(), []);
  });
});

describe("pi host services — declarations", () => {
  /** Build the declarations over a pi API stand-in. */
  function buildHost(piApi?: ExtensionAPI): PiServiceHost {
    return { piApi, appendEntry: undefined, ...HOST_HELPERS };
  }

  it("creates the extension services before any session exists", async () => {
    const { api } = fakeApi(["edit"]);
    const declarations = createPiHostServices(buildHost(api));
    const wiring = createPiLifecycleWiring({
      extensionServices: declarations.extension,
      sessionServices: declarations.session,
      getSessionID: (ctx) => (ctx as { id?: string } | undefined)?.id,
    });

    const extension = await wiring.activateExtension();

    // The pre-compose surfaces exist now; no session was created to get
    // here, so the composition can be built without inventing a session.
    assert.equal(extension.services.liveContext.current(), undefined);
    assert.equal(typeof extension.services.adapter.history, "function");
    assert.equal(
      typeof extension.services.toolHost.resolveSessionId,
      "function",
    );
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
      getSessionID: (ctx) => (ctx as { id?: string } | undefined)?.id,
    });
    const { services } = await wiring.activateExtension();
    let reads = 0;
    services.liveContext.publish({
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
      getSessionID: (ctx) => (ctx as { id?: string } | undefined)?.id,
    });
    const { services } = await wiring.activateExtension();
    // Every scan records the session whose transcript it read, so a read of
    // one session can be proven not to touch another's history.
    const scans: string[] = [];
    const publish = (sessionID: string, task: string): void => {
      services.liveContext.publish({
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

  it("fails closed for a session that published no context", async () => {
    const { api } = fakeApi(["edit"]);
    const declarations = createPiHostServices(buildHost(api));
    const wiring = createPiLifecycleWiring({
      extensionServices: declarations.extension,
      sessionServices: declarations.session,
      getSessionID: (ctx) => (ctx as { id?: string } | undefined)?.id,
    });
    const { services } = await wiring.activateExtension();
    const scans: string[] = [];
    services.liveContext.publish({
      sessionManager: {
        getSessionId: () => "s1",
        getBranch: () => {
          scans.push("s1");
          return transcript(["plan-a"]);
        },
      },
    });

    // A session this host never observed has no transcript to read: it must
    // not borrow the live session's.
    assert.deepEqual(await services.todo.get("s-unknown"), []);
    assert.deepEqual(await services.todo.get("s-unknown"), []);
    assert.deepEqual(scans, [], "no other session's transcript is scanned");
  });

  it("serves tool-host toasts through the live context", async () => {
    const { api } = fakeApi(["edit"]);
    const declarations = createPiHostServices(buildHost(api));
    const wiring = createPiLifecycleWiring({
      extensionServices: declarations.extension,
      sessionServices: declarations.session,
    });
    const { services } = await wiring.activateExtension();
    const toasts: string[] = [];
    services.liveContext.publish({
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
    });

    const { services } = await wiring.activateExtension();

    assert.equal(services.switchHost.host, undefined);
    // Draining without the surface is a no-op, never a throw: the command
    // handler calls it unconditionally.
    services.switchHost.drainPendingOps();
  });

  it("releases the extension-owned state when the extension stops", async () => {
    const { state, api } = fakeApi(["edit"]);
    const declarations = createPiHostServices(buildHost(api));
    const wiring = createPiLifecycleWiring({
      extensionServices: declarations.extension,
      sessionServices: declarations.session,
      getSessionID: (ctx) => (ctx as { id?: string } | undefined)?.id,
    });
    const { services } = await wiring.activateExtension();
    services.liveContext.publish({
      sessionManager: { getSessionId: () => "s1" },
    });
    await wiring.ensureSession({ id: "s1" });
    services.todo.set("s1", phase(["a"]));
    services.profileCatalog.publish(["grill"]);
    services.toolBaselines.primary();

    await wiring.stopExtension({ type: "session_shutdown", reason: "quit" });

    assert.equal(services.liveContext.current(), undefined);
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
      getSessionID: (ctx) => (ctx as { id?: string } | undefined)?.id,
    });
    const { services } = await wiring.activateExtension();

    // The widget renders nothing without a primary; with one, the session
    // registration reaches the host ui it was bound to.
    setPrimary("dolphin");
    const calls: unknown[] = [];
    services.liveContext.publish({
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
    setPrimary("dolphin");
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
    services.liveContext.publish(contextA);
    await kernel.ensureSession("s1");
    services.liveContext.publish(contextB);
    await kernel.ensureSession("s2");

    services.fleet.register("s1");
    services.fleet.register("s2");
    assert.deepEqual([a.state.widgets, b.state.widgets], [1, 1]);

    // Stopping s1 releases its listener and drops only its live-context
    // view; s2's fleet and context stay live.
    await kernel.stopSession("s1", "test");
    assert.deepEqual(a.state, { widgets: 1, unsubscribes: 1 });
    assert.deepEqual(b.state, { widgets: 1, unsubscribes: 0 });
    assert.equal(services.liveContext.forSession("s1"), undefined);
    assert.equal(services.liveContext.forSession("s2"), contextB);

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
    assert.deepEqual(extensionNames.slice(0, 3), [
      "liveContext",
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
      ["sessionContext", "todoStore", "fleetSession"],
    );
  });

  it("keeps the live context and adapter creation order", async () => {
    const order: string[] = [];
    const live = defineExtensionService({
      name: "liveContextProbe",
      deps: [],
      create: () => {
        order.push("liveContext");
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
    });

    await wiring.activateExtension();

    assert.deepEqual(order, ["liveContext", "adapter"]);
  });
});
