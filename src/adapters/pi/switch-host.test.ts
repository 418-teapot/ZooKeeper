/**
 * Tests for the pi primary-switch host (`switch-host.ts`).
 *
 * Boundary: the factory's returned host surface and its drain hook,
 * observed through injected deps.  The switch command unit itself
 * (`src/commands/switch/switch.ts`) and the entry-point wiring are covered
 * elsewhere; here the host's own responsibilities are asserted — resolving
 * the command context of the session being replaced, binding the fresh
 * context under the new session id, routing a `zoo` write to that session's
 * fleet widget, passing other widgets to the fresh ui, deferring the
 * post-replacement tool trim across the factory re-run, and clearing stale
 * queued operations.
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { SwitchNewSessionOps } from "../../core/ports/switch.js";
import { sessionAgentRegistry } from "../../core/session/agent.js";
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
  refreshes: string[];
  applied: string[][];
  bound: Array<[string, unknown]>;
} {
  const refreshes: string[] = [];
  const applied: string[][] = [];
  const bound: Array<[string, unknown]> = [];
  const deps: PiSwitchHostDeps = {
    getBaselineTools: () => ["edit", "bash"],
    setActiveTools: (names) => applied.push(names),
    refreshFleetWidget: (sessionID) => refreshes.push(sessionID),
    getCommandCtx: () => undefined,
    setContext: (sessionID, ctx) => bound.push([sessionID, ctx]),
    ...over,
  };
  return { deps, refreshes, applied, bound };
}

/** A command ctx whose newSession runs withSession against a fresh ui. */
function replacingCtx(
  freshWidgets: Array<[string, unknown]> = [],
  cancelled = false,
): {
  cmdCtx: PiCommandCtx;
  fresh: () => unknown;
} {
  let fresh: unknown;
  return {
    cmdCtx: {
      newSession: async (options) => {
        fresh = {
          sendUserMessage: async () => {},
          ui: {
            setWidget: (key: string, content: unknown) =>
              freshWidgets.push([key, content]),
          },
          sessionManager: { getSessionId: () => "sess-new" },
        };
        await options?.withSession?.(fresh as never);
        return { cancelled };
      },
    },
    fresh: () => fresh,
  };
}

afterEach(() => {
  _resetPendingSwitchOpsForTesting();
  sessionAgentRegistry.clear();
});

describe("createPiSwitchHost — session addressing", () => {
  it("resolves the command context of the session being replaced", async () => {
    const asked: string[] = [];
    const replacement = replacingCtx();
    const h = makeDeps({
      getCommandCtx: (sessionID) => {
        asked.push(sessionID);
        return replacement.cmdCtx;
      },
    });
    const { host } = createPiSwitchHost(h.deps, createSwitchOpsStore());

    await host.newSession({ parentSession: "sess-old" });

    assert.deepEqual(asked, ["sess-old"]);
  });

  it("fails closed when the replaced session has no command context", async () => {
    const h = makeDeps();
    const { host } = createPiSwitchHost(h.deps, createSwitchOpsStore());

    await assert.rejects(
      () => host.newSession({ parentSession: "sess-old" }),
      /newSession/,
    );
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
  it("binds the fresh context under the new session id", async () => {
    const replacement = replacingCtx();
    const h = makeDeps({ getCommandCtx: () => replacement.cmdCtx });
    const { host } = createPiSwitchHost(h.deps, createSwitchOpsStore());

    await host.newSession({ parentSession: "sess-old" });

    assert.deepEqual(h.bound, [["sess-new", replacement.fresh()]]);
  });

  it("routes the replacement's zoo write to the new session's fleet", async () => {
    const freshWidgets: Array<[string, unknown]> = [];
    const replacement = replacingCtx(freshWidgets);
    const h = makeDeps({ getCommandCtx: () => replacement.cmdCtx });
    const { host } = createPiSwitchHost(h.deps, createSwitchOpsStore());

    await host.newSession({
      parentSession: "sess-old",
      withSession: (ops: SwitchNewSessionOps) => {
        ops.setWidget("zoo", ["dolphin"]);
        ops.setWidget("other", ["x"]);
      },
    });

    assert.deepEqual(h.refreshes, ["sess-new"], "zoo is a primary nudge");
    assert.deepEqual(
      freshWidgets,
      [["other", ["x"]]],
      "zoo never reaches ui.setWidget",
    );
  });

  it("defers the tool trim to the replacement's fresh host", async () => {
    const store = createSwitchOpsStore();
    const replacement = replacingCtx();
    const oldHost = makeDeps({ getCommandCtx: () => replacement.cmdCtx });
    const { host } = createPiSwitchHost(oldHost.deps, store);

    await host.newSession({
      parentSession: "sess-old",
      withSession: (ops: SwitchNewSessionOps) => {
        ops.setActiveTools(["edit"]);
        ops.setWidget("zoo", ["mola"]);
      },
    });

    // The old host was told the fresh session's context.
    assert.equal(oldHost.bound.length, 1);
    // The zoo write nudged the fresh session's widget, never the fresh ui.
    assert.deepEqual(oldHost.refreshes, ["sess-new"]);
    // Nothing applied yet: the trim waits for the new session's host.
    assert.deepEqual(oldHost.applied, []);

    // The fresh session's host shares the store and takes the queued trim.
    const fresh = createPiSwitchHost(makeDeps().deps, store);
    assert.deepEqual(fresh.drainPendingOps(), ["edit"]);
    // Drained once: a second drain finds nothing.
    assert.deepEqual(fresh.drainPendingOps(), undefined);
  });

  it("clears stale queued operations before a replacement", async () => {
    const store = createSwitchOpsStore();
    store.stash({ activeTools: ["stale"] });
    const replacement = replacingCtx();
    const h = makeDeps({ getCommandCtx: () => replacement.cmdCtx });
    const { host } = createPiSwitchHost(h.deps, store);

    await host.newSession({ parentSession: "sess-old" });

    const fresh = createPiSwitchHost(makeDeps().deps, store);
    assert.equal(
      fresh.drainPendingOps(),
      undefined,
      "the stale trim is dropped",
    );
  });

  it("draining with nothing queued is a no-op", () => {
    const h = makeDeps();
    assert.equal(
      createPiSwitchHost(h.deps, createSwitchOpsStore()).drainPendingOps(),
      undefined,
    );
  });

  it("a cancelled replacement revokes only its pending primary", async () => {
    sessionAgentRegistry.bind("sess-old", "dolphin");
    const store = createSwitchOpsStore();
    const replacement = replacingCtx([], true);
    const h = makeDeps({ getCommandCtx: () => replacement.cmdCtx });
    const { host } = createPiSwitchHost(h.deps, store);

    await host.newSession({
      parentSession: "sess-old",
      withSession: (ops: SwitchNewSessionOps) => ops.setActiveTools(["lynx"]),
    });

    // No session was created, so its target must not survive the next
    // switch.
    assert.equal(store.pendingPrimary(), undefined);
    // The queued trim is not the target: the session that drains it still
    // takes it.
    assert.deepEqual(
      createPiSwitchHost(makeDeps().deps, store).drainPendingOps(),
      ["lynx"],
    );
  });
});

describe("createPiSwitchHost — process handoff slot", () => {
  it("shares the pending trim across factory instances via the default slot", async () => {
    const replacement = replacingCtx();
    const oldHost = makeDeps({ getCommandCtx: () => replacement.cmdCtx });
    const old = createPiSwitchHost(oldHost.deps);
    await old.host.newSession({
      parentSession: "sess-old",
      withSession: (ops: SwitchNewSessionOps) => ops.setActiveTools(["lynx"]),
    });

    const freshHost = makeDeps();
    assert.deepEqual(createPiSwitchHost(freshHost.deps).drainPendingOps(), [
      "lynx",
    ]);
  });

  it("the reset hook clears the process handoff slot", async () => {
    const replacement = replacingCtx();
    const oldHost = makeDeps({ getCommandCtx: () => replacement.cmdCtx });
    const old = createPiSwitchHost(oldHost.deps);
    await old.host.newSession({
      parentSession: "sess-old",
      withSession: (ops: SwitchNewSessionOps) => ops.setActiveTools(["lynx"]),
    });

    _resetPendingSwitchOpsForTesting();

    const freshHost = makeDeps();
    assert.equal(
      createPiSwitchHost(freshHost.deps).drainPendingOps(),
      undefined,
    );
  });
});
