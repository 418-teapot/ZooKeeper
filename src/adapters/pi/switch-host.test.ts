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
import { beforeEach, describe, it } from "node:test";
import type { SwitchNewSessionOps } from "../../core/ports/switch.js";
import { SessionAgentRegistry } from "../../core/session/agent.js";
import type { PiCommandCtx } from "./handoff-target.js";
import {
  createPiSwitchHost,
  createSwitchOpsStore,
  type PiSwitchHostDeps,
  type PiSwitchState,
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

/** The fresh replaced-session context pi passes to `withSession`. */
function freshSessionCtx(): never {
  return {
    sendUserMessage: async () => {},
    ui: { setWidget: () => {} },
    sessionManager: { getSessionId: () => "sess-new" },
  } as never;
}

/**
 * The process-wide state the hosts of one pi process share: the pending trim
 * survives the factory re-run a session replacement performs, and the
 * session bindings stay readable across it.
 */
let state: PiSwitchState;

function makeState(): PiSwitchState {
  return {
    sessionAgents: new SessionAgentRegistry(),
    switchOps: createSwitchOpsStore(),
  };
}

beforeEach(() => {
  state = makeState();
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
    const { host } = createPiSwitchHost(h.deps, state);

    await host.newSession({ parentSession: "sess-old" });

    assert.deepEqual(asked, ["sess-old"]);
  });

  it("fails closed when the replaced session has no command context", async () => {
    const h = makeDeps();
    const { host } = createPiSwitchHost(h.deps, state);

    await assert.rejects(
      () => host.newSession({ parentSession: "sess-old" }),
      /newSession/,
    );
  });

  it("passes the baseline and active-tool calls through to deps", () => {
    const h = makeDeps();
    const { host } = createPiSwitchHost(h.deps, state);

    assert.deepEqual(host.getBaselineTools(), ["edit", "bash"]);
    host.setActiveTools(["edit"]);
    assert.deepEqual(h.applied, [["edit"]]);
  });
});

describe("createPiSwitchHost — session replacement", () => {
  it("binds the fresh context under the new session id", async () => {
    const replacement = replacingCtx();
    const h = makeDeps({ getCommandCtx: () => replacement.cmdCtx });
    const { host } = createPiSwitchHost(h.deps, state);

    await host.newSession({ parentSession: "sess-old" });

    assert.deepEqual(h.bound, [["sess-new", replacement.fresh()]]);
  });

  it("routes the replacement's zoo write to the new session's fleet", async () => {
    const freshWidgets: Array<[string, unknown]> = [];
    const replacement = replacingCtx(freshWidgets);
    const h = makeDeps({ getCommandCtx: () => replacement.cmdCtx });
    const { host } = createPiSwitchHost(h.deps, state);

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

  it("defers the tool trim to the replacement's own session", async () => {
    const replacement = replacingCtx();
    const oldHost = makeDeps({ getCommandCtx: () => replacement.cmdCtx });
    const { host } = createPiSwitchHost(oldHost.deps, state);

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
    // Nothing applied yet: the trim waits for the new session's own start
    // and first turn.
    assert.deepEqual(oldHost.applied, []);

    // The fresh session's host shares the store; the replacement's own
    // start claims the trim for that session only.
    const fresh = createPiSwitchHost(makeDeps().deps, state);
    fresh.claimPending("sess-new", {
      reason: "new",
      parentSession: "sess-old",
    });
    assert.deepEqual(fresh.drainPendingOps("sess-new"), ["edit"]);
    // Drained once: a second drain finds nothing.
    assert.deepEqual(fresh.drainPendingOps("sess-new"), undefined);
  });

  it("carries the target and the trim from the old runtime to the new one", async () => {
    state.sessionAgents.bind("sess-old", "mola");
    const replacement = replacingCtx();
    const oldHost = makeDeps({ getCommandCtx: () => replacement.cmdCtx });
    const old = createPiSwitchHost(oldHost.deps, state);
    await old.host.newSession({
      parentSession: "sess-old",
      withSession: (ops: SwitchNewSessionOps) => ops.setActiveTools(["lynx"]),
    });

    // The replacement runs in a second factory execution: only the process
    // store carries the handoff across.
    const fresh = createPiSwitchHost(makeDeps().deps, state);
    assert.equal(state.sessionAgents.resolve("sess-new"), undefined);
    fresh.claimPending("sess-new", {
      reason: "new",
      parentSession: "sess-old",
    });
    assert.equal(state.sessionAgents.resolve("sess-new"), "mola");
    assert.deepEqual(fresh.drainPendingOps("sess-new"), ["lynx"]);
  });

  it("an unrelated session start neither claims nor drains the replacement", async () => {
    state.sessionAgents.bind("sess-old", "mola");
    const replacement = replacingCtx();
    const h = makeDeps({ getCommandCtx: () => replacement.cmdCtx });
    const { host } = createPiSwitchHost(h.deps, state);
    await host.newSession({
      parentSession: "sess-old",
      withSession: (ops: SwitchNewSessionOps) => ops.setActiveTools(["lynx"]),
    });

    const fresh = createPiSwitchHost(makeDeps().deps, state);
    // A reload, a resume, a startup and a plain `/new` all belong to
    // sessions this replacement did not create.
    const starts: Array<[string, string | undefined]> = [
      ["reload", "sess-old"],
      ["resume", "sess-old"],
      ["startup", undefined],
      ["new", undefined],
      ["new", "sess-other"],
    ];
    for (const [reason, parentSession] of starts) {
      fresh.claimPending("sess-elsewhere", { reason, parentSession });
      assert.equal(
        state.sessionAgents.resolve("sess-elsewhere"),
        undefined,
        `${reason}/${parentSession} must not bind the target`,
      );
      assert.equal(
        fresh.drainPendingOps("sess-elsewhere"),
        undefined,
        `${reason}/${parentSession} must not take the trim`,
      );
    }

    // The replacement still waits for its own start.
    fresh.claimPending("sess-new", {
      reason: "new",
      parentSession: "sess-old",
    });
    assert.equal(state.sessionAgents.resolve("sess-new"), "mola");
    assert.deepEqual(fresh.drainPendingOps("sess-new"), ["lynx"]);
  });

  it("claims once: a second start of the same replacement binds nothing", async () => {
    state.sessionAgents.bind("sess-old", "mola");
    const replacement = replacingCtx();
    const h = makeDeps({ getCommandCtx: () => replacement.cmdCtx });
    const { host } = createPiSwitchHost(h.deps, state);
    await host.newSession({ parentSession: "sess-old" });

    const fresh = createPiSwitchHost(makeDeps().deps, state);
    fresh.claimPending("sess-new", {
      reason: "new",
      parentSession: "sess-old",
    });
    fresh.claimPending("sess-again", {
      reason: "new",
      parentSession: "sess-old",
    });

    assert.equal(state.sessionAgents.resolve("sess-new"), "mola");
    assert.equal(
      state.sessionAgents.resolve("sess-again"),
      undefined,
      "the claimed replacement belongs to one session",
    );
  });

  it("claims a target without a queued trim", async () => {
    state.sessionAgents.bind("sess-old", "mola");
    const replacement = replacingCtx();
    const h = makeDeps({ getCommandCtx: () => replacement.cmdCtx });
    const { host } = createPiSwitchHost(h.deps, state);
    // A switch without a computable trim publishes the target only.
    await host.newSession({ parentSession: "sess-old" });

    const fresh = createPiSwitchHost(makeDeps().deps, state);
    fresh.claimPending("sess-new", {
      reason: "new",
      parentSession: "sess-old",
    });

    assert.equal(state.sessionAgents.resolve("sess-new"), "mola");
    assert.equal(fresh.drainPendingOps("sess-new"), undefined);
  });

  it("drops the stale operations of a previous replacement", async () => {
    // A replacement that was begun and never claimed leaves its trim behind.
    state.switchOps.begin("sess-ancient");
    state.switchOps.stash({ activeTools: ["stale"] });
    const replacement = replacingCtx();
    const h = makeDeps({ getCommandCtx: () => replacement.cmdCtx });
    const { host } = createPiSwitchHost(h.deps, state);

    await host.newSession({ parentSession: "sess-old" });

    const fresh = createPiSwitchHost(makeDeps().deps, state);
    fresh.claimPending("sess-new", {
      reason: "new",
      parentSession: "sess-old",
    });
    assert.equal(
      fresh.drainPendingOps("sess-new"),
      undefined,
      "the stale trim is dropped",
    );
  });

  it("draining with nothing queued is a no-op", () => {
    const h = makeDeps();
    assert.equal(
      createPiSwitchHost(h.deps, state).drainPendingOps("sess-new"),
      undefined,
    );
  });

  it("a cancelled replacement drops its target and its trim", async () => {
    state.sessionAgents.bind("sess-old", "dolphin");
    const replacement = replacingCtx([], true);
    const h = makeDeps({ getCommandCtx: () => replacement.cmdCtx });
    const { host } = createPiSwitchHost(h.deps, state);

    await host.newSession({
      parentSession: "sess-old",
      withSession: (ops: SwitchNewSessionOps) => ops.setActiveTools(["lynx"]),
    });

    // No session was created, so neither the target nor the trim may
    // survive for the next session.
    const fresh = createPiSwitchHost(makeDeps().deps, state);
    fresh.claimPending("sess-new", {
      reason: "new",
      parentSession: "sess-old",
    });
    assert.equal(state.sessionAgents.resolve("sess-new"), undefined);
    assert.equal(fresh.drainPendingOps("sess-new"), undefined);
  });

  it("a rejected replacement drops its target and its trim, then rethrows", async () => {
    state.sessionAgents.bind("sess-old", "dolphin");
    const h = makeDeps({
      getCommandCtx: () => ({
        async newSession(options) {
          // pi ran the post-replacement callback against the fresh session
          // and then failed.
          await options?.withSession?.(freshSessionCtx());
          throw new Error("replacement failed");
        },
      }),
    });
    const { host } = createPiSwitchHost(h.deps, state);

    await assert.rejects(
      () =>
        host.newSession({
          parentSession: "sess-old",
          withSession: (ops: SwitchNewSessionOps) =>
            ops.setActiveTools(["lynx"]),
        }),
      /replacement failed/,
    );

    // The error propagates and nothing published before it survives: the
    // next session neither binds the target nor applies its trim.
    const fresh = createPiSwitchHost(makeDeps().deps, state);
    fresh.claimPending("sess-later", {
      reason: "new",
      parentSession: "sess-old",
    });
    assert.equal(state.sessionAgents.resolve("sess-later"), undefined);
    assert.equal(fresh.drainPendingOps("sess-later"), undefined);
  });

  it("keeps a claimed trim when the replacement still threw", async () => {
    state.sessionAgents.bind("sess-old", "dolphin");
    const fresh = createPiSwitchHost(makeDeps().deps, state);
    const h = makeDeps({
      getCommandCtx: () => ({
        async newSession(options) {
          // pi created the session (its start claimed the slot) and the
          // post-replacement callback failed afterwards.
          fresh.claimPending("sess-new", {
            reason: "new",
            parentSession: "sess-old",
          });
          await options?.withSession?.(freshSessionCtx());
          throw new Error("post-replacement failed");
        },
      }),
    });
    const { host } = createPiSwitchHost(h.deps, state);

    await assert.rejects(
      () =>
        host.newSession({
          parentSession: "sess-old",
          withSession: (ops: SwitchNewSessionOps) =>
            ops.setActiveTools(["lynx"]),
        }),
      /post-replacement failed/,
    );

    // The session exists, so its trim belongs to it.
    assert.equal(state.sessionAgents.resolve("sess-new"), "dolphin");
    assert.deepEqual(fresh.drainPendingOps("sess-new"), ["lynx"]);
  });
});

describe("createSwitchOpsStore — pending slot", () => {
  it("refuses a stash that no replacement opened", () => {
    const store = createSwitchOpsStore();

    assert.throws(
      () => store.stash({ activeTools: ["edit"] }),
      /尚未开始一次会话替换/,
    );
  });

  it("stashes the target and the trim of the replacement it opened", () => {
    const store = createSwitchOpsStore();
    store.begin("sess-old");
    store.stash({ primary: "mola" });
    store.stash({ activeTools: ["edit"] });

    assert.equal(
      store.claim("sess-new", { reason: "new", parentSession: "sess-old" }),
      "mola",
    );
    assert.deepEqual(store.drain("sess-new"), ["edit"]);
  });
});

describe("createPiSwitchHost — process handoff slot", () => {
  it("shares the pending trim across factory instances of one process", async () => {
    const replacement = replacingCtx();
    const oldHost = makeDeps({ getCommandCtx: () => replacement.cmdCtx });
    const old = createPiSwitchHost(oldHost.deps, state);
    await old.host.newSession({
      parentSession: "sess-old",
      withSession: (ops: SwitchNewSessionOps) => ops.setActiveTools(["lynx"]),
    });

    const freshHost = makeDeps();
    const fresh = createPiSwitchHost(freshHost.deps, state);
    fresh.claimPending("sess-new", {
      reason: "new",
      parentSession: "sess-old",
    });
    assert.deepEqual(fresh.drainPendingOps("sess-new"), ["lynx"]);
  });

  it("a second process state never sees another process's trim", async () => {
    const replacement = replacingCtx();
    const oldHost = makeDeps({ getCommandCtx: () => replacement.cmdCtx });
    const old = createPiSwitchHost(oldHost.deps, state);
    await old.host.newSession({
      parentSession: "sess-old",
      withSession: (ops: SwitchNewSessionOps) => ops.setActiveTools(["lynx"]),
    });

    const freshHost = makeDeps();
    const fresh = createPiSwitchHost(freshHost.deps, makeState());
    fresh.claimPending("sess-new", {
      reason: "new",
      parentSession: "sess-old",
    });
    assert.equal(
      fresh.drainPendingOps("sess-new"),
      undefined,
      "another process state must not take this queue",
    );
  });
});
