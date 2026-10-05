/**
 * Tests for the pi primary-switch host (`switch-host.ts`).
 *
 * Boundary: the factory's returned host surface and its drain hook,
 * observed through injected deps.  The switch command unit itself
 * (`src/commands/switch/switch.ts`) and the entry-point wiring are covered
 * elsewhere; here the host's own responsibilities are asserted — routing a
 * `zoo` write to the fleet widget, passing other widgets to the live ui,
 * deferring the post-replacement tool trim across the factory re-run, and
 * clearing stale queued operations.
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { PiSwitchNewSessionOps } from "../../core/slots.js";
import type { PiCommandCtx } from "./handoff-target.js";
import {
  _resetPendingSwitchOpsForTesting,
  createPiSwitchHost,
  createSwitchOpsStore,
  type PiSwitchHostDeps,
} from "./switch-host.js";

/** A deps stub recording every side effect the host can produce. */
function makeDeps(over: Partial<PiSwitchHostDeps> = {}): {
  deps: PiSwitchHostDeps;
  widgets: Array<[string, unknown]>;
  applied: string[][];
  contexts: unknown[];
  refreshes: () => number;
} {
  const widgets: Array<[string, unknown]> = [];
  const applied: string[][] = [];
  const contexts: unknown[] = [];
  let refreshes = 0;
  const deps: PiSwitchHostDeps = {
    getBaselineTools: () => ["edit", "bash"],
    setActiveTools: (names) => applied.push(names),
    refreshFleetWidget: () => {
      refreshes += 1;
    },
    getUi: () => ({
      setWidget: (key, content) => widgets.push([key, content]),
    }),
    getCommandCtx: () => undefined,
    setContext: (ctx) => contexts.push(ctx),
    ...over,
  };
  return {
    deps,
    widgets,
    applied,
    contexts,
    refreshes: () => refreshes,
  };
}

/** A command ctx whose newSession runs withSession against a fresh ui. */
function replacingCtx(
  freshWidgets: Array<[string, unknown]> = [],
): PiCommandCtx {
  return {
    newSession: async (options) => {
      await options?.withSession?.({
        sendUserMessage: async () => {},
        ui: {
          setWidget: (key, content) => freshWidgets.push([key, content]),
        },
        sessionManager: { getSessionId: () => "sess-new" },
      });
      return { cancelled: false };
    },
  };
}

afterEach(() => {
  _resetPendingSwitchOpsForTesting();
});

describe("createPiSwitchHost — widget routing", () => {
  it("routes a zoo write to the fleet widget and other keys to the live ui", () => {
    const h = makeDeps();
    const { host } = createPiSwitchHost(h.deps, createSwitchOpsStore());

    host.setWidget("zoo", ["dolphin"]);
    assert.equal(h.refreshes(), 1, "zoo is a primary-changed nudge");
    assert.deepEqual(h.widgets, [], "zoo never reaches ui.setWidget");

    host.setWidget("other", ["x"]);
    assert.deepEqual(h.widgets, [["other", ["x"]]]);
  });

  it("passes the baseline and active-tool calls through to deps", () => {
    const h = makeDeps();
    const { host } = createPiSwitchHost(h.deps, createSwitchOpsStore());
    assert.deepEqual(host.getBaselineTools(), ["edit", "bash"]);
    host.setActiveTools(["edit"]);
    assert.deepEqual(h.applied, [["edit"]]);
  });
});

describe("createPiSwitchHost — session replacement", () => {
  it("throws when the live command context exposes no newSession", async () => {
    const h = makeDeps();
    const { host } = createPiSwitchHost(h.deps, createSwitchOpsStore());
    await assert.rejects(() => host.newSession({}), /newSession/);
  });

  it("defers the tool trim to the replacement's fresh host", async () => {
    const store = createSwitchOpsStore();
    const oldHost = makeDeps({ getCommandCtx: () => replacingCtx() });
    const { host } = createPiSwitchHost(oldHost.deps, store);

    await host.newSession({
      parentSession: "sess-old",
      withSession: (ops: PiSwitchNewSessionOps) => {
        ops.setActiveTools(["edit"]);
        ops.setWidget("zoo", ["mola"]);
      },
    });

    // The old holder was refreshed with the fresh session's context.
    assert.equal(oldHost.contexts.length, 1);
    // The zoo write nudged the widget, never the fresh ui.
    assert.equal(oldHost.refreshes(), 1);
    // Nothing applied yet: the trim waits for the new session's host.
    assert.deepEqual(oldHost.applied, []);

    // The fresh session's host shares the store and drains the queued trim.
    const freshHost = makeDeps();
    createPiSwitchHost(freshHost.deps, store).drainPendingOps();
    assert.deepEqual(freshHost.applied, [["edit"]]);
    // Drained once: a second drain finds nothing.
    createPiSwitchHost(freshHost.deps, store).drainPendingOps();
    assert.deepEqual(freshHost.applied, [["edit"]]);
  });

  it("clears stale queued operations before a replacement", async () => {
    const store = createSwitchOpsStore();
    store.stash({ activeTools: ["stale"] });
    const h = makeDeps({ getCommandCtx: () => replacingCtx() });
    const { host } = createPiSwitchHost(h.deps, store);

    await host.newSession({});

    const freshHost = makeDeps();
    createPiSwitchHost(freshHost.deps, store).drainPendingOps();
    assert.deepEqual(freshHost.applied, [], "the stale trim must be dropped");
  });

  it("draining with nothing queued is a no-op", () => {
    const h = makeDeps();
    createPiSwitchHost(h.deps, createSwitchOpsStore()).drainPendingOps();
    assert.deepEqual(h.applied, []);
  });
});

describe("createPiSwitchHost — process handoff slot", () => {
  it("shares the pending trim across factory instances via the default slot", async () => {
    const oldHost = makeDeps({ getCommandCtx: () => replacingCtx() });
    const old = createPiSwitchHost(oldHost.deps);
    await old.host.newSession({
      withSession: (ops: PiSwitchNewSessionOps) => ops.setActiveTools(["lynx"]),
    });

    const freshHost = makeDeps();
    createPiSwitchHost(freshHost.deps).drainPendingOps();
    assert.deepEqual(freshHost.applied, [["lynx"]]);
  });

  it("the reset hook clears the process handoff slot", async () => {
    const oldHost = makeDeps({ getCommandCtx: () => replacingCtx() });
    const old = createPiSwitchHost(oldHost.deps);
    await old.host.newSession({
      withSession: (ops: PiSwitchNewSessionOps) => ops.setActiveTools(["lynx"]),
    });

    _resetPendingSwitchOpsForTesting();

    const freshHost = makeDeps();
    createPiSwitchHost(freshHost.deps).drainPendingOps();
    assert.deepEqual(freshHost.applied, []);
  });
});
