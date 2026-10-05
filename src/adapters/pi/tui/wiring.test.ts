/**
 * Tests for the pi fleet-widget wiring (`wiring.ts`).
 *
 * Boundary: the factory's returned wiring, observed through injected deps
 * and the widget's rendered output.  The widget's own rendering and key
 * handling live in `widget.test.ts`, and the entry-point integration in
 * `src/pi.test.ts`; here the wiring's own responsibilities are asserted —
 * loading the session's todo phases into the widget column, the one-shot
 * seed, keeping the last good cache on a read failure, and opening the
 * transcript overlay for a selected run.
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { resetRegistry, startRun } from "../../../core/subagent/registry.js";
import type { TodoStateStore } from "../../../core/todo/store.js";
import type { TodoPhase } from "../../../core/todo/types.js";
import type { FleetTuiLike } from "./widget.js";
import { createFleetWiring, type FleetWiringDeps } from "./wiring.js";

/** Let a fire-and-forget cache refresh settle before asserting. */
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/** A deps stub for the wiring, overridable per test. */
function deps(over: Partial<FleetWiringDeps> = {}): FleetWiringDeps {
  return {
    getPrimary: () => "dolphin",
    colorizeAgent: (name) => name,
    getSessionId: () => "sess-wire",
    getEditorText: () => "",
    titleForRun: () => "beaver",
    borderColorizeForRun: () => undefined,
    getOpenOverlay: () => undefined,
    ...over,
  };
}

/** A todo store serving a fixed (or computed) phase list. */
function fakeStore(
  phases: readonly TodoPhase[] | (() => Promise<readonly TodoPhase[]>),
): { store: TodoStateStore; gets: string[] } {
  const gets: string[] = [];
  const store: TodoStateStore = {
    get: async (sessionId) => {
      gets.push(sessionId);
      const value = typeof phases === "function" ? await phases() : phases;
      return [...value];
    },
    set: () => {},
    invalidate: () => {},
    serialize: (fn) => fn(),
  };
  return { store, gets };
}

/** A TUI stub with a focused empty editor so the widget's keys activate. */
const THEME = { fg: (_color: string, text: string) => text };
function focusedTui(): FleetTuiLike {
  return {
    requestRender: () => {},
    focusedComponent: {
      render: () => [],
      invalidate: () => {},
      handleInput: () => {},
      getText: () => "",
      setText: () => {},
    },
  };
}

afterEach(() => {
  resetRegistry();
});

describe("createFleetWiring — todo column", () => {
  it("refreshTodoView loads the session's phases and shows them on the widget", async () => {
    const { store, gets } = fakeStore([
      { name: "P", tasks: [{ content: "Wire widget", status: "pending" }] },
    ]);
    const wiring = createFleetWiring(deps({ todoStore: store }));

    wiring.refreshTodoView();
    await flush();

    assert.deepEqual(gets, ["sess-wire"]);
    assert.ok(
      wiring.fleetWidget.render(80).join("\n").includes("Wire widget"),
      "the loaded phase must reach the widget column",
    );
    wiring.fleetWidget.dispose();
  });

  it("refreshTodoView with no store clears the column", () => {
    const wiring = createFleetWiring(deps());
    wiring.refreshTodoView();
    assert.ok(
      !wiring.fleetWidget.render(80).join("\n").includes("done"),
      "no store means no todo summary",
    );
    wiring.fleetWidget.dispose();
  });

  it("keeps the last good cache when a read rejects", async () => {
    let fail = false;
    const { store } = fakeStore(async () => {
      if (fail) throw new Error("boom");
      return [
        { name: "P", tasks: [{ content: "Wire widget", status: "pending" }] },
      ];
    });
    const wiring = createFleetWiring(deps({ todoStore: store }));

    wiring.refreshTodoView();
    await flush();
    assert.ok(wiring.fleetWidget.render(80).join("\n").includes("Wire widget"));

    fail = true;
    wiring.refreshTodoView();
    await flush();
    assert.ok(
      wiring.fleetWidget.render(80).join("\n").includes("Wire widget"),
      "a rejected read must not wipe the last good view",
    );
    wiring.fleetWidget.dispose();
  });

  it("seedTodoView reads once, then reuses the loaded column", async () => {
    const { store, gets } = fakeStore([]);
    const wiring = createFleetWiring(deps({ todoStore: store }));

    wiring.seedTodoView();
    await flush();
    assert.equal(gets.length, 1);

    wiring.seedTodoView();
    await flush();
    assert.equal(gets.length, 1, "the one-shot seed must not re-read");
    wiring.fleetWidget.dispose();
  });
});

describe("createFleetWiring — enter inspect", () => {
  it("opens the overlay for a selected run when an opener is wired", () => {
    let opened = 0;
    const wiring = createFleetWiring(
      deps({
        getOpenOverlay: () => (factory) => {
          opened += 1;
          return factory;
        },
      }),
    );
    wiring.fleetWidget.attach(focusedTui(), THEME);
    startRun({
      id: "run-wire",
      agent: "beaver",
      parentSession: "sess-wire",
      startedAt: 1000,
    });

    assert.deepEqual(wiring.fleetWidget.handleKey("\u001b[B"), {
      consume: true,
    });
    assert.deepEqual(wiring.fleetWidget.handleKey("\r"), { consume: true });
    assert.equal(opened, 1, "ui.custom must open one overlay");
    wiring.fleetWidget.dispose();
  });

  it("leaves enter unconsumed when no overlay opener is cached", () => {
    const wiring = createFleetWiring(deps());
    wiring.fleetWidget.attach(focusedTui(), THEME);
    startRun({
      id: "run-wire-plain",
      agent: "beaver",
      parentSession: "sess-wire",
      startedAt: 1000,
    });

    wiring.fleetWidget.handleKey("\u001b[B");
    assert.equal(
      wiring.fleetWidget.handleKey("\r"),
      undefined,
      "the key must fall through to the editor",
    );
    wiring.fleetWidget.dispose();
  });
});
