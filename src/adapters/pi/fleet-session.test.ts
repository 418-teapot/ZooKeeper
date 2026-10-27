/**
 * Tests for the pi session-scoped fleet (`fleet-session.ts`).
 *
 * The resources are the only owner of the host writes a session's fleet
 * widget needs — the `setWidget` binding and the terminal-input listener —
 * so the tests drive the host `ui` surface and read those writes: fail
 * closed without a ui or a primary, idempotent re-registration, and a
 * disposed scope that writes nothing.
 *
 * The fleet itself is per session: its widget, its todo column cache and its
 * listener belong to one session scope, so the tests also drive two sessions
 * at once and read that neither one's render, todo read, nor dispose reaches
 * the other.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { TodoStateStore } from "../../core/todo/store.js";
import type { TodoPhase } from "../../core/todo/types.js";
import { renderZooWidget } from "../../testkits/pi-wiring.js";
import {
  createPiFleetSession,
  createPiFleetSessionRegistry,
  createPiFleetSessionResources,
  type PiFleetSession,
  type PiFleetUi,
} from "./fleet-session.js";
import type { FleetWidget } from "./tui/widget.js";

/** A fleet widget stand-in recording the calls the resources make. */
function mockWidget() {
  const calls: string[] = [];
  const keys: string[] = [];
  const widget: FleetWidget = {
    attach() {
      calls.push("attach");
    },
    handleKey(data) {
      keys.push(data);
      return { consume: true };
    },
    collapse() {},
    refresh() {
      calls.push("refresh");
    },
    render() {
      return [];
    },
    dispose() {
      calls.push("dispose");
    },
  };
  return {
    widget,
    calls,
    get keys() {
      return keys;
    },
  };
}

/** A ui surface recording widget registrations and listener binds. */
function mockUi(
  options: { setWidget?: boolean; onTerminalInput?: boolean } = {},
) {
  const state = {
    widgets: [] as Array<{
      key: string;
      options: unknown;
      content: unknown;
    }>,
    binds: 0,
    unsubscribes: 0,
    handlers: [] as Array<(data: string) => unknown>,
  };
  const ui: PiFleetUi = {
    ...(options.setWidget === false
      ? {}
      : {
          setWidget: (key: string, content: unknown, opts?: unknown) => {
            state.widgets.push({ key, options: opts, content });
          },
        }),
    ...(options.onTerminalInput === false
      ? {}
      : {
          onTerminalInput: (handler: (data: string) => unknown) => {
            state.binds += 1;
            state.handlers.push(handler);
            return () => {
              state.unsubscribes += 1;
            };
          },
        }),
  };
  return { ui, state };
}

describe("pi fleet session resources", () => {
  it("registers the widget and the listener on the current ui", () => {
    const recorder = mockWidget();
    const { widget, calls } = recorder;
    const { ui, state } = mockUi();
    const resources = createPiFleetSessionResources({
      widget,
      getPrimary: () => "dolphin",
      getUi: () => ui,
    });

    resources.register();

    assert.equal(state.widgets.length, 1);
    assert.equal(state.widgets[0]?.key, "zoo");
    assert.deepEqual(state.widgets[0]?.options, { placement: "aboveEditor" });
    assert.equal(state.binds, 1);
    assert.deepEqual(calls, ["refresh"]);

    // The bound listener forwards raw input to the widget's key handler.
    state.handlers[0]?.("j");
    assert.deepEqual(recorder.keys, ["j"]);
  });

  it("binds the registered component factory to the widget", () => {
    const { widget, calls } = mockWidget();
    const { ui, state } = mockUi();
    const resources = createPiFleetSessionResources({
      widget,
      getPrimary: () => "dolphin",
      getUi: () => ui,
    });
    resources.register();

    const factory = state.widgets[0]?.content as (
      tui: unknown,
      theme: unknown,
    ) => {
      render(width: number): string[];
      invalidate(): void;
      dispose(): void;
    };
    const component = factory(
      {},
      { fg: (_color: string, text: string) => text },
    );

    assert.deepEqual(component.render(80), []);
    component.invalidate();
    assert.ok(calls.includes("attach"), "the factory attaches the widget");
    assert.ok(calls.includes("refresh"), "invalidate nudges a re-render");

    // The component's own dispose releases the listener and the widget.
    component.dispose();
    assert.equal(state.unsubscribes, 1);
    assert.ok(calls.includes("dispose"));
  });

  it("fails closed without a ui surface or an active primary", () => {
    const { widget } = mockWidget();
    const { ui, state } = mockUi();
    let available: PiFleetUi | undefined;

    const resources = createPiFleetSessionResources({
      widget,
      getPrimary: () => "dolphin",
      getUi: () => available,
    });
    resources.register();
    assert.deepEqual([state.widgets.length, state.binds], [0, 0]);

    available = ui;
    const primaryless = createPiFleetSessionResources({
      widget,
      getPrimary: () => undefined,
      getUi: () => ui,
    });
    primaryless.register();
    assert.deepEqual([state.widgets.length, state.binds], [0, 0]);
  });

  it("releases the previous listener before re-binding", () => {
    const { widget } = mockWidget();
    const { ui, state } = mockUi();
    const resources = createPiFleetSessionResources({
      widget,
      getPrimary: () => "dolphin",
      getUi: () => ui,
    });

    resources.register();
    resources.register();

    assert.equal(state.binds, 2);
    assert.equal(state.unsubscribes, 1, "one listener stays live");
    assert.equal(state.widgets.length, 2, "the widget is re-seeded");
  });

  it("writes nothing once disposed", () => {
    const { widget, calls } = mockWidget();
    const { ui, state } = mockUi();
    const resources = createPiFleetSessionResources({
      widget,
      getPrimary: () => "dolphin",
      getUi: () => ui,
    });
    resources.register();

    resources.dispose();
    assert.equal(state.unsubscribes, 1);
    assert.ok(calls.includes("dispose"), "the widget is released");

    const widgets = state.widgets.length;
    const binds = state.binds;
    resources.register();
    resources.dispose();
    assert.deepEqual([state.widgets.length, state.binds], [widgets, binds]);
    assert.equal(state.unsubscribes, 1, "dispose stays idempotent");
  });

  it("tolerates a ui without the optional surfaces", () => {
    const { widget, calls } = mockWidget();
    const { ui, state } = mockUi({
      setWidget: false,
      onTerminalInput: false,
    });
    const resources = createPiFleetSessionResources({
      widget,
      getPrimary: () => "dolphin",
      getUi: () => ui,
    });

    resources.register();

    assert.deepEqual([state.widgets.length, state.binds], [0, 0]);
    assert.deepEqual(calls, ["refresh"]);
  });
});

/** One session's fleet, recording every call routed to it. */
function mockSession(sessionID: string, calls: string[]): PiFleetSession {
  return {
    sessionID,
    register() {
      calls.push(`register:${sessionID}`);
    },
    refresh() {
      calls.push(`refresh:${sessionID}`);
    },
    refreshTodoView() {
      calls.push(`todo:${sessionID}`);
    },
    seedTodoView() {
      calls.push(`seed:${sessionID}`);
    },
    dispose() {
      calls.push(`dispose:${sessionID}`);
    },
  };
}

describe("pi fleet session registry", () => {
  it("routes every call to the session that owns the fleet", () => {
    const calls: string[] = [];
    const registry = createPiFleetSessionRegistry();
    registry.bind(mockSession("s1", calls));
    registry.bind(mockSession("s2", calls));

    registry.register("s1");
    registry.refresh("s2");
    registry.refreshTodoView("s1");
    registry.seedTodoView("s2");
    // An unknown, absent or blank id does nothing: routing fails closed
    // rather than falling back to some other session's fleet.
    for (const unknown of ["s3", undefined, "", "   "]) {
      registry.register(unknown);
      registry.refresh(unknown);
      registry.refreshTodoView(unknown);
      registry.seedTodoView(unknown);
    }

    assert.deepEqual(calls, [
      "register:s1",
      "refresh:s2",
      "todo:s1",
      "seed:s2",
    ]);
  });

  it("keeps a live session's fleet when another scope is released", () => {
    const calls: string[] = [];
    const registry = createPiFleetSessionRegistry();
    const first = mockSession("s1", calls);
    const second = mockSession("s2", calls);
    // Interleaved ensure: s1's scope is created first, s2's second.
    registry.bind(first);
    registry.bind(second);
    registry.register("s1");

    // s2 stops while s1 is still live: its release must not clear s1.
    registry.release(second);
    registry.register("s1");
    registry.register("s2");

    assert.deepEqual(calls, ["register:s1", "dispose:s2", "register:s1"]);
  });

  it("leaves a replacement scope for the same id routeable", () => {
    const calls: string[] = [];
    const registry = createPiFleetSessionRegistry();
    const previous: PiFleetSession = {
      ...mockSession("s1", calls),
      dispose() {
        calls.push("dispose:previous");
      },
    };
    const current: PiFleetSession = {
      ...mockSession("s1", calls),
      dispose() {
        calls.push("dispose:current");
      },
    };
    registry.bind(previous);
    // The scope was recreated for the same id (reload / resume).
    registry.bind(current);

    // The stopped scope's release must not unroute its replacement.
    registry.release(previous);
    registry.register("s1");

    assert.deepEqual(calls, ["dispose:previous", "register:s1"]);
  });
});

/** A phase list holding one task. */
function phases(content: string): TodoPhase[] {
  return [{ name: "Todos", tasks: [{ content, status: "pending" }] }];
}

/**
 * One session's fleet harness: a widget-recording ui, a todo store that
 * records the session ids it is asked for, and the fleet bound to both.
 */
function fleetHarness(sessionID: string, task: string) {
  const calls: Array<[string, unknown]> = [];
  const reads: string[] = [];
  const state = { widgets: 0, binds: 0, unsubscribes: 0 };
  const ui: PiFleetUi = {
    setWidget: (key: string, content: unknown) => {
      state.widgets += 1;
      calls.push([key, content]);
    },
    onTerminalInput: () => {
      state.binds += 1;
      return () => {
        state.unsubscribes += 1;
      };
    },
    getEditorText: () => "",
  };
  const store: TodoStateStore = {
    async get(): Promise<TodoPhase[]> {
      reads.push(sessionID);
      return phases(task);
    },
    set() {},
    invalidate() {},
    serialize<T>(fn: () => Promise<T>): Promise<T> {
      return fn();
    },
  };
  const session = createPiFleetSession({
    sessionID,
    getPrimary: () => "dolphin",
    colorizeAgent: (name: string) => name,
    getUi: () => ui,
    getEditorText: () => "",
    titleForRun: (run) => run.agent,
    borderColorizeForRun: () => undefined,
    getOpenOverlay: () => undefined,
    todoStore: store,
  });
  return { session, calls, reads, state };
}

/** Let a fire-and-forget todo refresh settle. */
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("pi fleet session", () => {
  it("renders, reads and releases only its own session's fleet", async () => {
    const a = fleetHarness("sess-a", "Plan A");
    const b = fleetHarness("sess-b", "Plan B");
    a.session.register();
    b.session.register();
    a.session.refreshTodoView();
    b.session.refreshTodoView();
    await flush();

    // Each widget renders the todo column of its own session's store.
    assert.deepEqual(a.reads, ["sess-a"]);
    assert.deepEqual(b.reads, ["sess-b"]);
    const renderedA = renderZooWidget(a.calls);
    const renderedB = renderZooWidget(b.calls);
    try {
      const linesA = renderedA.lines.join("\n");
      const linesB = renderedB.lines.join("\n");
      assert.ok(linesA.includes("Plan A"), linesA);
      assert.ok(!linesA.includes("Plan B"), "A never renders B's plan");
      assert.ok(linesB.includes("Plan B"), linesB);
      assert.ok(!linesB.includes("Plan A"), "B never renders A's plan");
    } finally {
      renderedA.dispose();
      renderedB.dispose();
    }
  });

  it("stops one session's fleet without touching its sibling", async () => {
    const a = fleetHarness("sess-a", "Plan A");
    const b = fleetHarness("sess-b", "Plan B");
    a.session.register();
    b.session.register();

    a.session.dispose();

    // A's listener is released; B's stays live and re-registers cleanly.
    assert.deepEqual(a.state, { widgets: 1, binds: 1, unsubscribes: 1 });
    assert.deepEqual(b.state, { widgets: 1, binds: 1, unsubscribes: 0 });
    b.session.register();
    assert.deepEqual(b.state, { widgets: 2, binds: 2, unsubscribes: 1 });
    b.session.refreshTodoView();
    await flush();
    const rendered = renderZooWidget(b.calls);
    try {
      assert.ok(rendered.lines.join("\n").includes("Plan B"));
    } finally {
      rendered.dispose();
    }
  });
});
