/**
 * Tests for the host-agnostic handoff protocol (`src/core/handoff.ts`).
 *
 * Covers the exact six-step call order on success and the
 * deliver-failure atomicity guarantee: a throwing handoff target
 * `deliver` must NOT mark the plan `executing` (the plan file stays
 * untouched), and the handoff must be re-runnable afterwards.
 */
import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { afterEach, beforeEach, describe, it } from "node:test";
import { cleanupPlan, createPlanFile } from "../testkits/plans.js";
import { makeTmpDir } from "../testkits/tmp.js";
import { _resetForTesting, initLogger } from "../utils/logger.js";
import { executeHandoff, type HandoffTarget } from "./handoff.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function tmpDir(): string {
  return makeTmpDir("zoo-handoff-test");
}

let _loggerDir: string;

beforeEach(() => {
  _resetForTesting();
  _loggerDir = tmpDir();
  initLogger("opencode", { logDir: _loggerDir });
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

/** A fake handoff target recording the exact order of its method calls. */
function fakeHandoffTarget(overrides?: {
  deliverError?: Error;
  onDeliver?: (planReference: string) => void;
}): {
  handoffTarget: HandoffTarget;
  calls: string[];
  createArgs: Array<{ parentage: string; title: string; agent: string }>;
  installArgs: Array<{ id: string; agent: string }>;
  deliverArgs: Array<{ id: string; agent: string; planReference: string }>;
  focusArgs: Array<{ id: string }>;
} {
  const calls: string[] = [];
  const createArgs: Array<{
    parentage: string;
    title: string;
    agent: string;
  }> = [];
  const installArgs: Array<{ id: string; agent: string }> = [];
  const deliverArgs: Array<{
    id: string;
    agent: string;
    planReference: string;
  }> = [];
  const focusArgs: Array<{ id: string }> = [];
  const failDeliver = false;
  const handoffTarget: HandoffTarget = {
    create: async (ctx) => {
      calls.push("create");
      createArgs.push(ctx);
      // Echo the context's executor, as a host target must.
      return { id: "new-session-1", agent: ctx.agent };
    },
    installAgent: async (session) => {
      calls.push("install");
      installArgs.push({ id: session.id, agent: session.agent });
    },
    deliver: async (session, planReference) => {
      calls.push("deliver");
      deliverArgs.push({
        id: session.id,
        agent: session.agent,
        planReference,
      });
      overrides?.onDeliver?.(planReference);
      if (overrides?.deliverError || failDeliver) {
        throw overrides?.deliverError ?? new Error("deliver failed");
      }
    },
    focus: async (session) => {
      calls.push("focus");
      focusArgs.push({ id: session.id });
    },
  };
  return {
    handoffTarget,
    calls,
    createArgs,
    installArgs,
    deliverArgs,
    focusArgs,
  };
}

// ---------------------------------------------------------------------------
// Success path — exact step order
// ---------------------------------------------------------------------------

describe("executeHandoff — success path step order", () => {
  it("runs resolve → create → install → deliver → markExecuting → focus in order", async () => {
    const sessionID = `test-order-${Date.now()}`;
    const { planPath, baseDir } = createPlanFile("planning-done");
    const fake = fakeHandoffTarget();

    await executeHandoff({
      handoffTarget: fake.handoffTarget,
      agent: EXECUTOR,
      sessionID,
      directory: baseDir,
    });

    assert.deepEqual(fake.calls, ["create", "install", "deliver", "focus"]);
    // The plan file is marked executing AFTER deliver (the mark is not a
    // handoff target call, but it must happen before focus — verified by
    // the plan file content being "executing" when the handoff completes).
    assert.deepEqual(fake.createArgs, [
      { parentage: sessionID, title: "Execute: test-plan", agent: EXECUTOR },
    ]);
    assert.equal(fake.deliverArgs.length, 1);
    assert.equal(fake.deliverArgs[0].id, "new-session-1");
    assert.ok(
      fake.deliverArgs[0].planReference.includes(planPath),
      "plan reference must carry the plan path",
    );
    assert.deepEqual(fake.focusArgs, [{ id: "new-session-1" }]);

    const content = readFileSync(planPath, "utf-8");
    assert.ok(content.includes("status: executing"));

    cleanupPlan(planPath);
  });

  it("hands the same executor to create, install, and deliver", async () => {
    const sessionID = `test-executor-${Date.now()}`;
    const { planPath, baseDir } = createPlanFile("planning-done");
    const fake = fakeHandoffTarget();

    await executeHandoff({
      handoffTarget: fake.handoffTarget,
      agent: EXECUTOR,
      sessionID,
      directory: baseDir,
    });

    assert.equal(fake.createArgs[0].agent, EXECUTOR);
    assert.deepEqual(fake.installArgs, [
      { id: "new-session-1", agent: EXECUTOR },
    ]);
    assert.equal(fake.deliverArgs[0].agent, EXECUTOR);

    cleanupPlan(planPath);
  });
});

// ---------------------------------------------------------------------------
// Deliver-failure atomicity
// ---------------------------------------------------------------------------

describe("executeHandoff — deliver-failure atomicity", () => {
  it("deliver throws → markExecuting is NOT reached, plan file untouched", async () => {
    const sessionID = `test-deliver-fail-${Date.now()}`;
    const { planPath, baseDir } = createPlanFile("planning-done");
    const before = readFileSync(planPath, "utf-8");
    const fake = fakeHandoffTarget({
      deliverError: new Error("network down"),
    });

    await assert.rejects(
      () =>
        executeHandoff({
          handoffTarget: fake.handoffTarget,
          agent: EXECUTOR,
          sessionID,
          directory: baseDir,
        }),
      /network down/,
    );

    // The plan file is byte-identical: still "planning-done".
    assert.equal(readFileSync(planPath, "utf-8"), before);
    assert.ok(!before.includes("status: executing"));
    // focus must never run after a deliver failure.
    assert.deepEqual(fake.calls, ["create", "install", "deliver"]);

    cleanupPlan(planPath);
  });

  it("deliver failure → the handoff is re-runnable on the same plan", async () => {
    const sessionID = `test-rerun-${Date.now()}`;
    const { planPath, baseDir } = createPlanFile("planning-done");

    // First run: deliver fails.
    const failFake = fakeHandoffTarget({ deliverError: new Error("boom") });
    await assert.rejects(
      () =>
        executeHandoff({
          handoffTarget: failFake.handoffTarget,
          agent: EXECUTOR,
          sessionID,
          directory: baseDir,
        }),
      /boom/,
    );
    assert.ok(
      readFileSync(planPath, "utf-8").includes("status: planning-done"),
    );

    // Second run (same plan still planning-done): succeeds and marks it.
    const okFake = fakeHandoffTarget();
    await executeHandoff({
      handoffTarget: okFake.handoffTarget,
      agent: EXECUTOR,
      sessionID,
      directory: baseDir,
    });
    assert.ok(readFileSync(planPath, "utf-8").includes("status: executing"));
    assert.deepEqual(okFake.calls, ["create", "install", "deliver", "focus"]);

    cleanupPlan(planPath);
  });
});

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

describe("executeHandoff — plan resolution", () => {
  it("throws the user-facing message when no planning-done plan exists", async () => {
    const sessionID = `test-no-plan-${Date.now()}`;
    const emptyDir = tmpDir();
    const fake = fakeHandoffTarget();

    await assert.rejects(
      () =>
        executeHandoff({
          handoffTarget: fake.handoffTarget,
          agent: EXECUTOR,
          sessionID,
          directory: emptyDir,
        }),
      /No plan with status "planning-done"/,
    );

    // No handoff target step runs without a resolved plan.
    assert.deepEqual(fake.calls, []);
    try {
      rmSync(emptyDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });
});
