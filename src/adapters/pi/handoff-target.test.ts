/**
 * Tests for the pi handoff target (`src/adapters/pi/handoff-target.ts`).
 *
 * The handoff target is exercised through the full handoff protocol
 * (`executeHandoff`) with a fake pi command context: the parent session
 * id is passed into `newSession`, the plan reference is delivered via
 * the `withSession` callback's `sendUserMessage`, the parentage session is
 * bound to the executor the handoff call carried (and the executor is
 * published for the replacement session), and a cancelled or throwing
 * replacement restores the binding that preceded the handoff.
 */
import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { afterEach, beforeEach, describe, it } from "node:test";
import { executeHandoff } from "../../core/handoff.js";
import { buildPlanReference } from "../../core/plan.js";
import { SessionAgentRegistry } from "../../core/session/agent.js";
import { cleanupPlan, createPlanFile } from "../../testkits/plans.js";
import { makeTmpDir } from "../../testkits/tmp.js";
import {
  _getBufferForTesting,
  _resetForTesting,
  initLogger,
} from "../../utils/logger.js";
import { createPiHandoffTarget } from "./handoff-target.js";
import {
  createPiHandoffIdentity,
  createSwitchOpsStore,
  type PiSwitchState,
} from "./switch-host.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function tmpDir(): string {
  return makeTmpDir("zoo-handoff-target-pi");
}

let _loggerDir: string;

beforeEach(() => {
  _resetForTesting();
  _loggerDir = tmpDir();
  initLogger("pi", { logDir: _loggerDir });
});

afterEach(() => {
  _resetForTesting();
  try {
    rmSync(_loggerDir, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

/** Fixture executor — a made-up name, never a real agent. */
const EXECUTOR = "alpha";

/**
 * A handoff identity surface over an isolated process state.
 *
 * The state carries both the pending replacement the replacement session
 * claims its executor from and the session bindings, so a test reads it to
 * prove the handoff published (or dropped) the target.
 */
function handoffIdentity(): {
  identity: ReturnType<typeof createPiHandoffIdentity>;
  state: PiSwitchState;
} {
  const state: PiSwitchState = {
    sessionAgents: new SessionAgentRegistry(),
    switchOps: createSwitchOpsStore(),
  };
  return { identity: createPiHandoffIdentity(state), state };
}

/** A fake pi command context with a recording newSession. */
function fakeCommandCtx(overrides?: {
  cancelled?: boolean;
  sendError?: Error;
  /** When set, `newSession` rejects with this error (no session created). */
  newSessionError?: Error;
  /** When set, `sendUserMessage` returns this promise (the "first turn"). */
  sendTurn?: Promise<unknown>;
}): {
  ctx: any;
  newSessionOptions: any[];
  sentUserMessages: string[];
} {
  const newSessionOptions: any[] = [];
  const sentUserMessages: string[] = [];
  const ctx = {
    newSession: (options: any) => {
      newSessionOptions.push(options);
      if (overrides?.newSessionError) {
        return Promise.reject(overrides.newSessionError);
      }
      if (options?.withSession) {
        return Promise.resolve({
          cancelled: false,
        }).then(async () => {
          // Simulate pi running the withSession callback against the
          // fresh replaced-session context.
          const newCtx = {
            sendUserMessage: (content: string) => {
              sentUserMessages.push(content);
              if (overrides?.sendError) {
                return Promise.reject(overrides.sendError);
              }
              // A supplied turn promise models pi's blocking first turn;
              // otherwise the user message resolves immediately (idle
              // replacement with no live agent turn).
              if (overrides?.sendTurn) {
                return overrides.sendTurn;
              }
              return Promise.resolve(undefined);
            },
          };
          await options.withSession(newCtx);
          return { cancelled: overrides?.cancelled === true };
        });
      }
      return Promise.resolve({ cancelled: overrides?.cancelled === true });
    },
  };
  return { ctx, newSessionOptions, sentUserMessages };
}

// ---------------------------------------------------------------------------
// Create + install
// ---------------------------------------------------------------------------

describe("pi handoff target — create and install", () => {
  it("create validates newSession and carries the parentage", async () => {
    const sessionID = `test-create-${Date.now()}`;
    const { planPath, baseDir } = createPlanFile("planning-done");
    const { ctx, newSessionOptions, sentUserMessages } = fakeCommandCtx();
    const cmdCtx = ctx;

    const { identity } = handoffIdentity();
    const handoffTarget = createPiHandoffTarget({
      getCommandCtx: () => cmdCtx,
      identity,
    });
    await executeHandoff({
      handoffTarget,
      agent: EXECUTOR,
      sessionID,
      directory: baseDir,
    });

    // The parent session id flows into newSession through the session the
    // create step returned.
    assert.equal(newSessionOptions.length, 1);
    assert.equal(newSessionOptions[0].parentSession, sessionID);
    assert.equal(sentUserMessages.length, 1);
    assert.ok(sentUserMessages[0].includes(planPath));

    cleanupPlan(planPath);
  });

  it("resolves the command context of the parentage session", async () => {
    const sessionID = `test-scope-${Date.now()}`;
    const { planPath, baseDir } = createPlanFile("planning-done");
    const { ctx } = fakeCommandCtx();
    const asked: string[] = [];

    const { identity } = handoffIdentity();
    const handoffTarget = createPiHandoffTarget({
      getCommandCtx: (id) => {
        asked.push(id);
        return ctx;
      },
      identity,
    });
    await executeHandoff({
      handoffTarget,
      agent: EXECUTOR,
      sessionID,
      directory: baseDir,
    });

    // Both steps address the session the handoff replaces: no step reads
    // the command context of whichever session ran a command last.
    assert.deepEqual(asked, [sessionID, sessionID]);

    cleanupPlan(planPath);
  });

  it("throws fail-closed when the command ctx lacks newSession", async () => {
    const sessionID = `test-no-api-${Date.now()}`;
    const { planPath, baseDir } = createPlanFile("planning-done");

    const { identity } = handoffIdentity();
    const handoffTarget = createPiHandoffTarget({
      getCommandCtx: () => ({}),
      identity,
    });
    await assert.rejects(
      () =>
        executeHandoff({
          handoffTarget,
          agent: EXECUTOR,
          sessionID,
          directory: baseDir,
        }),
      /newSession/,
    );
    // Plan untouched — nothing delivered or marked.
    assert.ok(
      readFileSync(planPath, "utf-8").includes("status: planning-done"),
    );

    cleanupPlan(planPath);
  });
});

// ---------------------------------------------------------------------------
// setPrimary
// ---------------------------------------------------------------------------

describe("pi handoff target — setPrimary", () => {
  it("calls setPrimary with the executor the handoff carried", async () => {
    const sessionID = `test-primary-${Date.now()}`;
    const { planPath, baseDir } = createPlanFile("planning-done");
    const { ctx } = fakeCommandCtx();

    const { identity, state } = handoffIdentity();
    const handoffTarget = createPiHandoffTarget({
      getCommandCtx: () => ctx,
      identity,
    });
    await executeHandoff({
      handoffTarget,
      agent: EXECUTOR,
      sessionID,
      directory: baseDir,
    });

    assert.equal(state.sessionAgents.resolve(sessionID), EXECUTOR);

    cleanupPlan(planPath);
  });

  it("switches to whichever executor the individual handoff carried", async () => {
    const sessionID = `test-primary-dynamic-${Date.now()}`;
    const { planPath, baseDir } = createPlanFile("planning-done");
    const { ctx } = fakeCommandCtx();

    const { identity, state } = handoffIdentity();
    const handoffTarget = createPiHandoffTarget({
      getCommandCtx: () => ctx,
      identity,
    });
    await executeHandoff({
      handoffTarget,
      agent: "beta",
      sessionID,
      directory: baseDir,
    });

    assert.equal(state.sessionAgents.resolve(sessionID), "beta");

    cleanupPlan(planPath);
  });
});

// ---------------------------------------------------------------------------
// Deliver — withSession and cancellation
// ---------------------------------------------------------------------------

describe("pi handoff target — deliver semantics", () => {
  it("delivers the plan reference through the withSession callback", async () => {
    const sessionID = `test-deliver-${Date.now()}`;
    const { planPath, baseDir } = createPlanFile("planning-done");
    const { ctx, sentUserMessages } = fakeCommandCtx();

    const { identity } = handoffIdentity();
    const handoffTarget = createPiHandoffTarget({
      getCommandCtx: () => ctx,
      identity,
    });
    await executeHandoff({
      handoffTarget,
      agent: EXECUTOR,
      sessionID,
      directory: baseDir,
    });

    // The reference must be sent into the fresh session context.
    assert.equal(sentUserMessages.length, 1);
    assert.ok(sentUserMessages[0].includes("Plan file:"));

    cleanupPlan(planPath);
  });

  it("deliver resolves without waiting for the first turn (fire-and-forget)", async () => {
    const sessionID = `test-deliver-faf-${Date.now()}`;
    const { planPath, baseDir } = createPlanFile("planning-done");

    // A controllable promise models pi's first LLM turn: it only settles
    // when the test releases the latch, so if deliver (and thus the
    // handoff) awaited it, the handoff would hang here.
    let releaseTurn!: () => void;
    const turn = new Promise<void>((resolve) => {
      releaseTurn = resolve;
    });
    let turnHeld = true;
    void turn.then(() => {
      turnHeld = false;
    });

    const { ctx, sentUserMessages } = fakeCommandCtx({ sendTurn: turn });
    const { identity } = handoffIdentity();
    const handoffTarget = createPiHandoffTarget({
      getCommandCtx: () => ctx,
      identity,
    });

    const handoff = executeHandoff({
      handoffTarget,
      agent: EXECUTOR,
      sessionID,
      directory: baseDir,
    });
    const settled = Promise.race([
      handoff.then(
        () => "resolved",
        () => "rejected",
      ),
      new Promise<string>((resolve) =>
        setTimeout(() => resolve("pending"), 20),
      ),
    ]);

    // While the first-turn latch is STILL held, the handoff must already
    // have resolved — the plan reference is only queued, not awaited.
    assert.equal(await settled, "resolved");
    assert.equal(turnHeld, true, "the first turn must still be in flight");

    // The plan reference was accepted as the new session's first user
    // message, and the plan was marked executing before the turn ends.
    assert.equal(sentUserMessages.length, 1);
    assert.equal(sentUserMessages[0], buildPlanReference(planPath));
    assert.ok(
      readFileSync(planPath, "utf-8").includes("status: executing"),
      "markExecuting must run before the first turn can edit the plan file",
    );

    // Release the latch and let the fire-and-forget turn settle so no
    // dangling promise leaks into later tests.
    releaseTurn();
    await turn;

    cleanupPlan(planPath);
  });

  it("async sendUserMessage rejection → warn only, plan still marked executing", async () => {
    const sessionID = `test-send-fail-${Date.now()}`;
    const { planPath, baseDir } = createPlanFile("planning-done");

    // A turn that rejects AFTER the deliver has already returned: the
    // handoff must already have moved on, so the failure is fire-and-forget
    // — observed as a warn, never a deliver throw.
    let rejectTurn!: (err: Error) => void;
    const turn = new Promise<void>((_resolve, reject) => {
      rejectTurn = reject;
    });

    const { ctx, sentUserMessages } = fakeCommandCtx({ sendTurn: turn });
    const { identity } = handoffIdentity();
    const handoffTarget = createPiHandoffTarget({
      getCommandCtx: () => ctx,
      identity,
    });

    await executeHandoff({
      handoffTarget,
      agent: EXECUTOR,
      sessionID,
      directory: baseDir,
    });
    assert.equal(sentUserMessages.length, 1);

    // Reject the turn after the handoff already succeeded.  `deliver` must
    // not throw now — the rejection belongs to the detached promise, whose
    // warn handler consumes it.  `.catch(() => {})` lets the test await the
    // turn's settling without re-throwing it here.
    rejectTurn(new Error("first turn crashed"));
    await turn.catch(() => {});
    // The warn lands in the in-memory buffer (logged by the detached
    // promise's catch handler) — read it before any flush empties it.
    const warns = _getBufferForTesting().filter(
      (entry) =>
        entry.event === "deliver_async_failed" && entry.level === "warn",
    );
    assert.equal(warns.length, 1);
    assert.ok(String(warns[0].error).includes("first turn crashed"));

    // markExecuting already ran before the turn crashed (fire-and-forget).
    assert.ok(
      readFileSync(planPath, "utf-8").includes("status: executing"),
      "the async failure must not roll back markExecuting",
    );

    cleanupPlan(planPath);
  });

  it("cancelled replacement → throws and leaves the plan untouched", async () => {
    const sessionID = `test-cancel-${Date.now()}`;
    const { planPath, baseDir } = createPlanFile("planning-done");
    const { ctx } = fakeCommandCtx({ cancelled: true });

    const { identity } = handoffIdentity();
    const handoffTarget = createPiHandoffTarget({
      getCommandCtx: () => ctx,
      identity,
    });
    await assert.rejects(
      () =>
        executeHandoff({
          handoffTarget,
          agent: EXECUTOR,
          sessionID,
          directory: baseDir,
        }),
      /cancelled/,
    );
    assert.ok(
      readFileSync(planPath, "utf-8").includes("status: planning-done"),
    );

    cleanupPlan(planPath);
  });

  // -------------------------------------------------------------------------
  // The pending executor and its rollback
  // -------------------------------------------------------------------------
  //
  // `installAgent` (handoff step 3) binds the parentage session to the
  // handoff's executor and `deliver` (step 4) publishes that executor for
  // the replacement session.  When the replacement is cancelled or throws,
  // pi never created the session: the surviving planning session must keep
  // its own binding and the published target must be dropped.

  it("publishes the executor for the replacement session's bind-time events", async () => {
    const sessionID = `test-pending-${Date.now()}`;
    const { planPath, baseDir } = createPlanFile("planning-done");
    const { ctx } = fakeCommandCtx();
    const { identity, state } = handoffIdentity();

    const handoffTarget = createPiHandoffTarget({
      getCommandCtx: () => ctx,
      identity,
    });
    await executeHandoff({
      handoffTarget,
      agent: EXECUTOR,
      sessionID,
      directory: baseDir,
    });

    // The replacement session is not named yet, so its own start claims the
    // published executor.
    assert.equal(
      state.switchOps.claim("sess-replacement", {
        reason: "new",
        parentSession: sessionID,
      }),
      EXECUTOR,
    );

    cleanupPlan(planPath);
  });

  it("drops the published executor when the replacement is cancelled", async () => {
    const sessionID = `test-pending-cancel-${Date.now()}`;
    const { planPath, baseDir } = createPlanFile("planning-done");
    const { ctx } = fakeCommandCtx({ cancelled: true });
    const { identity, state } = handoffIdentity();

    const handoffTarget = createPiHandoffTarget({
      getCommandCtx: () => ctx,
      identity,
    });
    await assert.rejects(
      () =>
        executeHandoff({
          handoffTarget,
          agent: EXECUTOR,
          sessionID,
          directory: baseDir,
        }),
      /cancelled/,
    );
    assert.equal(
      state.switchOps.claim(sessionID, {
        reason: "new",
        parentSession: sessionID,
      }),
      undefined,
      "a cancelled replacement publishes no target to claim",
    );

    cleanupPlan(planPath);
  });

  it("a cancelled handoff drops the operations it opened", async () => {
    const sessionID = `test-cancel-trim-${Date.now()}`;
    const { planPath, baseDir } = createPlanFile("planning-done");
    const { ctx } = fakeCommandCtx({ cancelled: true });
    const { identity, state } = handoffIdentity();
    // An earlier replacement queued its tool trim and never claimed it.
    state.switchOps.begin("sess-stale");
    state.switchOps.stash({ activeTools: ["lynx"] });

    const handoffTarget = createPiHandoffTarget({
      getCommandCtx: () => ctx,
      identity,
    });
    await assert.rejects(
      () =>
        executeHandoff({
          handoffTarget,
          agent: EXECUTOR,
          sessionID,
          directory: baseDir,
        }),
      /cancelled/,
    );

    // The handoff opened its own replacement, so the stale trim is dropped
    // with it: no session exists that could claim either.
    assert.equal(
      state.switchOps.claim(sessionID, { reason: "new", parentSession: "x" }),
      undefined,
    );
    assert.equal(state.switchOps.drain(sessionID), undefined);

    cleanupPlan(planPath);
  });

  it("a throwing replacement drops the operations it opened", async () => {
    const sessionID = `test-throw-trim-${Date.now()}`;
    const { planPath, baseDir } = createPlanFile("planning-done");
    const { ctx } = fakeCommandCtx({ newSessionError: new Error("boom") });
    const { identity, state } = handoffIdentity();
    state.switchOps.begin("sess-stale");
    state.switchOps.stash({ activeTools: ["lynx"] });

    const handoffTarget = createPiHandoffTarget({
      getCommandCtx: () => ctx,
      identity,
    });
    await assert.rejects(
      () =>
        executeHandoff({
          handoffTarget,
          agent: EXECUTOR,
          sessionID,
          directory: baseDir,
        }),
      /boom/,
    );

    assert.equal(
      state.switchOps.claim(sessionID, { reason: "new", parentSession: "x" }),
      undefined,
    );
    assert.equal(state.switchOps.drain(sessionID), undefined);

    cleanupPlan(planPath);
  });

  it("cancelled replacement restores the previous primary", async () => {
    const sessionID = `test-cancel-rollback-${Date.now()}`;
    const { planPath, baseDir } = createPlanFile("planning-done");
    const { ctx } = fakeCommandCtx({ cancelled: true });

    const { identity, state } = handoffIdentity();
    // The user is planning as a DIFFERENT primary (not the handoff
    // executor): the handoff is about to strand them on the executor.
    state.sessionAgents.bind(sessionID, "mola");

    const handoffTarget = createPiHandoffTarget({
      getCommandCtx: () => ctx,
      identity,
    });
    await assert.rejects(
      () =>
        executeHandoff({
          handoffTarget,
          agent: EXECUTOR,
          sessionID,
          directory: baseDir,
        }),
      /cancelled/,
    );
    // No session was created, so the surviving planning session's primary
    // must be restored.
    assert.equal(state.sessionAgents.resolve(sessionID), "mola");

    cleanupPlan(planPath);
  });

  it("throwing newSession restores the previous primary and rethrows", async () => {
    const sessionID = `test-throw-rollback-${Date.now()}`;
    const { planPath, baseDir } = createPlanFile("planning-done");
    const boom = new Error("session runtime exploded");
    const { ctx } = fakeCommandCtx({ newSessionError: boom });

    const { identity, state } = handoffIdentity();
    state.sessionAgents.bind(sessionID, "mola");
    const handoffTarget = createPiHandoffTarget({
      getCommandCtx: () => ctx,
      identity,
    });
    await assert.rejects(
      () =>
        executeHandoff({
          handoffTarget,
          agent: EXECUTOR,
          sessionID,
          directory: baseDir,
        }),
      /session runtime exploded/,
    );
    // The session was never created — the primary must be rolled back.
    assert.equal(state.sessionAgents.resolve(sessionID), "mola");

    cleanupPlan(planPath);
  });

  it("successful handoff keeps the executor primary (no rollback)", async () => {
    const sessionID = `test-success-primary-${Date.now()}`;
    const { planPath, baseDir } = createPlanFile("planning-done");
    const { ctx } = fakeCommandCtx();

    const { identity, state } = handoffIdentity();
    state.sessionAgents.bind(sessionID, "mola");

    const handoffTarget = createPiHandoffTarget({
      getCommandCtx: () => ctx,
      identity,
    });
    await executeHandoff({
      handoffTarget,
      agent: EXECUTOR,
      sessionID,
      directory: baseDir,
    });
    // The replacement succeeded — the handoff owns the new primary and
    // must NOT roll back to the planning session's identity.
    assert.equal(state.sessionAgents.resolve(sessionID), EXECUTOR);

    cleanupPlan(planPath);
  });
});

// ---------------------------------------------------------------------------
// Concurrent handoffs
// ---------------------------------------------------------------------------

describe("pi handoff target — concurrent handoffs", () => {
  it("keeps two interleaved handoffs' parentage and identity apart", async () => {
    const sessionA = `test-concurrent-a-${Date.now()}`;
    const sessionB = `test-concurrent-b-${Date.now()}`;
    const planA = createPlanFile("planning-done");
    const planB = createPlanFile("planning-done");
    const fakeA = fakeCommandCtx();
    const fakeB = fakeCommandCtx();
    const bySession = new Map<string, unknown>([
      [sessionA, fakeA.ctx],
      [sessionB, fakeB.ctx],
    ]);

    const { identity, state } = handoffIdentity();
    // Both sessions are planning as a different primary before the handoff.
    state.sessionAgents.bind(sessionA, "mola");
    state.sessionAgents.bind(sessionB, "mola");
    const handoffTarget = createPiHandoffTarget({
      getCommandCtx: (id) =>
        bySession.get(id) as ReturnType<typeof fakeCommandCtx>["ctx"],
      identity,
    });

    // Both handoffs start together, so their steps interleave.
    await Promise.all([
      executeHandoff({
        handoffTarget,
        agent: "alpha",
        sessionID: sessionA,
        directory: planA.baseDir,
      }),
      executeHandoff({
        handoffTarget,
        agent: "beta",
        sessionID: sessionB,
        directory: planB.baseDir,
      }),
    ]);

    // Each replacement names its own parent session.
    assert.deepEqual(
      fakeA.newSessionOptions.map((options) => options.parentSession),
      [sessionA],
    );
    assert.deepEqual(
      fakeB.newSessionOptions.map((options) => options.parentSession),
      [sessionB],
    );
    // Each session receives its own plan reference, never the other's.
    assert.equal(fakeA.sentUserMessages.length, 1);
    assert.ok(fakeA.sentUserMessages[0].includes(planA.planPath));
    assert.equal(fakeB.sentUserMessages.length, 1);
    assert.ok(fakeB.sentUserMessages[0].includes(planB.planPath));
    // Each session keeps the executor its own handoff carried.
    assert.equal(state.sessionAgents.resolve(sessionA), "alpha");
    assert.equal(state.sessionAgents.resolve(sessionB), "beta");
    assert.ok(
      readFileSync(planA.planPath, "utf-8").includes("status: executing"),
    );
    assert.ok(
      readFileSync(planB.planPath, "utf-8").includes("status: executing"),
    );

    cleanupPlan(planA.planPath);
    cleanupPlan(planB.planPath);
  });

  it("a cancelled handoff rolls back only its own session's identity", async () => {
    const cancelledSession = `test-concurrent-cancel-${Date.now()}`;
    const okSession = `test-concurrent-ok-${Date.now()}`;
    const cancelledPlan = createPlanFile("planning-done");
    const okPlan = createPlanFile("planning-done");
    const cancelledFake = fakeCommandCtx({ cancelled: true });
    const okFake = fakeCommandCtx();
    const bySession = new Map<string, unknown>([
      [cancelledSession, cancelledFake.ctx],
      [okSession, okFake.ctx],
    ]);

    const { identity, state } = handoffIdentity();
    // Both sessions are planning as a different primary before the handoff.
    state.sessionAgents.bind(cancelledSession, "mola");
    state.sessionAgents.bind(okSession, "mola");
    const handoffTarget = createPiHandoffTarget({
      getCommandCtx: (id) =>
        bySession.get(id) as ReturnType<typeof fakeCommandCtx>["ctx"],
      identity,
    });

    const [cancelled, ok] = await Promise.allSettled([
      executeHandoff({
        handoffTarget,
        agent: "alpha",
        sessionID: cancelledSession,
        directory: cancelledPlan.baseDir,
      }),
      executeHandoff({
        handoffTarget,
        agent: "beta",
        sessionID: okSession,
        directory: okPlan.baseDir,
      }),
    ]);

    assert.equal(cancelled.status, "rejected");
    assert.equal(ok.status, "fulfilled");
    // The cancelled handoff restores ITS session's planning identity; the
    // successful one keeps its executor.
    assert.equal(state.sessionAgents.resolve(cancelledSession), "mola");
    assert.equal(state.sessionAgents.resolve(okSession), "beta");
    // The failed handoff leaves its plan untouched, the other one runs.
    assert.ok(
      readFileSync(cancelledPlan.planPath, "utf-8").includes(
        "status: planning-done",
      ),
    );
    assert.ok(
      readFileSync(okPlan.planPath, "utf-8").includes("status: executing"),
    );
    cleanupPlan(cancelledPlan.planPath);
    cleanupPlan(okPlan.planPath);
  });
});
