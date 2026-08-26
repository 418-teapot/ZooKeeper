/**
 * Tests for the pi venue (`src/commands/go/venue-pi.ts`).
 *
 * The venue is exercised through the full handoff protocol
 * (`executeHandoff`) with a fake pi command context: the parent session
 * id is passed into `newSession`, the plan reference is delivered via
 * the `withSession` callback's `sendUserMessage`, `setPrimary` is called
 * with the fixture default primary, and a cancelled replacement throws.
 */
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { executeHandoff } from "../../core/handoff.js";
import { buildPlanReference } from "../../core/plan.js";
import {
  getPrimary,
  _resetForTesting as resetIdentityForTesting,
  setPrimary,
} from "../../core/subagent/identity.js";
import {
  _getBufferForTesting,
  _resetForTesting,
  initLogger,
} from "../../utils/logger.js";
import { createPiVenue } from "./venue-pi.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

let _tmpCounter = 0;

function tmpDir(): string {
  const dir = join(tmpdir(), `zoo-venue-pi-${Date.now()}-${_tmpCounter++}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

let _loggerDir: string;

beforeEach(() => {
  _resetForTesting();
  resetIdentityForTesting();
  _loggerDir = tmpDir();
  initLogger("pi", { logDir: _loggerDir });
});

afterEach(() => {
  _resetForTesting();
  resetIdentityForTesting();
  try {
    rmSync(_loggerDir, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

/** Fixture default primary — a made-up name, never a real agent. */
const DEFAULT_PRIMARY = "alpha";

function createPlanFile(status: string): { planPath: string; baseDir: string } {
  const baseDir = tmpDir();
  const dir = join(baseDir, ".zoo", "plans");
  mkdirSync(dir, { recursive: true });
  const planPath = join(dir, "test-plan.md");
  writeFileSync(
    planPath,
    `---\nstatus: ${status}\nslug: test-plan\n---\n# Test Plan\n`,
  );
  return { planPath, baseDir };
}

function cleanupPlan(planPath: string): void {
  try {
    rmSync(planPath, { recursive: true, force: true });
  } catch {
    // ignore
  }
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

describe("pi venue — create and install", () => {
  it("createVenue validates newSession and stashes the parentage", async () => {
    const sessionID = `test-create-${Date.now()}`;
    const { planPath, baseDir } = createPlanFile("planning-done");
    const { ctx, newSessionOptions, sentUserMessages } = fakeCommandCtx();
    const cmdCtx = ctx;

    const venue = createPiVenue({
      getCommandCtx: () => cmdCtx,
      defaultPrimary: DEFAULT_PRIMARY,
    });
    await executeHandoff({ venue, sessionID, directory: baseDir });

    // The parent session id flows into newSession.
    assert.equal(newSessionOptions.length, 1);
    assert.equal(newSessionOptions[0].parentSession, sessionID);
    assert.equal(sentUserMessages.length, 1);
    assert.ok(sentUserMessages[0].includes(planPath));

    cleanupPlan(planPath);
  });

  it("throws fail-closed when the command ctx lacks newSession", async () => {
    const sessionID = `test-no-api-${Date.now()}`;
    const { planPath, baseDir } = createPlanFile("planning-done");

    const venue = createPiVenue({
      getCommandCtx: () => ({}),
      defaultPrimary: DEFAULT_PRIMARY,
    });
    await assert.rejects(
      () => executeHandoff({ venue, sessionID, directory: baseDir }),
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

describe("pi venue — setPrimary", () => {
  it("calls setPrimary with the fixture default primary", async () => {
    const sessionID = `test-primary-${Date.now()}`;
    const { planPath, baseDir } = createPlanFile("planning-done");
    const { ctx } = fakeCommandCtx();

    const venue = createPiVenue({
      getCommandCtx: () => ctx,
      defaultPrimary: DEFAULT_PRIMARY,
    });
    await executeHandoff({ venue, sessionID, directory: baseDir });

    assert.equal(getPrimary(), DEFAULT_PRIMARY);

    cleanupPlan(planPath);
  });
});

// ---------------------------------------------------------------------------
// Deliver — withSession and cancellation
// ---------------------------------------------------------------------------

describe("pi venue — deliver semantics", () => {
  it("delivers the plan reference through the withSession callback", async () => {
    const sessionID = `test-deliver-${Date.now()}`;
    const { planPath, baseDir } = createPlanFile("planning-done");
    const { ctx, sentUserMessages } = fakeCommandCtx();

    const venue = createPiVenue({
      getCommandCtx: () => ctx,
      defaultPrimary: DEFAULT_PRIMARY,
    });
    await executeHandoff({ venue, sessionID, directory: baseDir });

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
    const venue = createPiVenue({
      getCommandCtx: () => ctx,
      defaultPrimary: DEFAULT_PRIMARY,
    });

    const handoff = executeHandoff({ venue, sessionID, directory: baseDir });
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
    const venue = createPiVenue({
      getCommandCtx: () => ctx,
      defaultPrimary: DEFAULT_PRIMARY,
    });

    await executeHandoff({ venue, sessionID, directory: baseDir });
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

    const venue = createPiVenue({
      getCommandCtx: () => ctx,
      defaultPrimary: DEFAULT_PRIMARY,
    });
    await assert.rejects(
      () => executeHandoff({ venue, sessionID, directory: baseDir }),
      /cancelled/,
    );
    assert.ok(
      readFileSync(planPath, "utf-8").includes("status: planning-done"),
    );

    cleanupPlan(planPath);
  });

  // -------------------------------------------------------------------------
  // Primary rollback on failed replacement
  // -------------------------------------------------------------------------
  //
  // `installAgent` (handoff step 3) switches the primary to the default
  // executor BEFORE `deliver` (step 4) replaces the session.  When the
  // replacement is cancelled or throws, pi never created the session, yet
  // the primary is left pointing at the executor while the user is still
  // in their planning session — asymmetric with `applySwitch`'s
  // cancelled-rollback.  The venue must restore the previous primary so
  // identity state matches the session that actually survives.

  it("cancelled replacement restores the previous primary", async () => {
    const sessionID = `test-cancel-rollback-${Date.now()}`;
    const { planPath, baseDir } = createPlanFile("planning-done");
    // The user is planning as a DIFFERENT primary (not the default
    // executor): the handoff is about to strand them on the executor.
    setPrimary("mola");
    const { ctx } = fakeCommandCtx({ cancelled: true });

    const venue = createPiVenue({
      getCommandCtx: () => ctx,
      defaultPrimary: DEFAULT_PRIMARY,
    });
    await assert.rejects(
      () => executeHandoff({ venue, sessionID, directory: baseDir }),
      /cancelled/,
    );
    // No session was created, so the surviving planning session's primary
    // must be restored.
    assert.equal(getPrimary(), "mola");

    cleanupPlan(planPath);
  });

  it("throwing newSession restores the previous primary and rethrows", async () => {
    const sessionID = `test-throw-rollback-${Date.now()}`;
    const { planPath, baseDir } = createPlanFile("planning-done");
    setPrimary("mola");
    const boom = new Error("session runtime exploded");
    const { ctx } = fakeCommandCtx({ newSessionError: boom });

    const venue = createPiVenue({
      getCommandCtx: () => ctx,
      defaultPrimary: DEFAULT_PRIMARY,
    });
    await assert.rejects(
      () => executeHandoff({ venue, sessionID, directory: baseDir }),
      /session runtime exploded/,
    );
    // The session was never created — the primary must be rolled back.
    assert.equal(getPrimary(), "mola");

    cleanupPlan(planPath);
  });

  it("successful handoff keeps the executor primary (no rollback)", async () => {
    const sessionID = `test-success-primary-${Date.now()}`;
    const { planPath, baseDir } = createPlanFile("planning-done");
    setPrimary("mola");
    const { ctx } = fakeCommandCtx();

    const venue = createPiVenue({
      getCommandCtx: () => ctx,
      defaultPrimary: DEFAULT_PRIMARY,
    });
    await executeHandoff({ venue, sessionID, directory: baseDir });
    // The replacement succeeded — the handoff owns the new primary and
    // must NOT roll back to the planning session's identity.
    assert.equal(getPrimary(), DEFAULT_PRIMARY);

    cleanupPlan(planPath);
  });
});
