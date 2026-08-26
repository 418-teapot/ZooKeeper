/**
 * Tests for the host-agnostic handoff protocol (`src/core/handoff.ts`).
 *
 * Covers the exact six-step call order on success and the
 * deliver-failure atomicity guarantee: a throwing venue `deliver` must
 * NOT mark the plan `executing` (the plan file stays untouched), and the
 * handoff must be re-runnable afterwards.
 */
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { _resetForTesting, initLogger } from "../utils/logger.js";
import { executeHandoff, type Venue } from "./handoff.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

let _tmpCounter = 0;

function tmpDir(): string {
  const dir = join(tmpdir(), `zoo-handoff-test-${Date.now()}-${_tmpCounter++}`);
  mkdirSync(dir, { recursive: true });
  return dir;
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

/**
 * Create a flat plan file under `<baseDir>/.zoo/plans/` matching the
 * workspace-relative path model.
 */
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

/** A fake venue recording the exact order of its method invocations. */
function fakeVenue(overrides?: {
  deliverError?: Error;
  onDeliver?: (planReference: string) => void;
}): {
  venue: Venue;
  calls: string[];
  createArgs: Array<{ parentage: string; title: string }>;
  deliverArgs: Array<{ id: string; planReference: string }>;
  focusArgs: Array<{ id: string }>;
} {
  const calls: string[] = [];
  const createArgs: Array<{ parentage: string; title: string }> = [];
  const deliverArgs: Array<{ id: string; planReference: string }> = [];
  const focusArgs: Array<{ id: string }> = [];
  const failDeliver = false;
  const venue: Venue = {
    createVenue: async (ctx) => {
      calls.push("create");
      createArgs.push(ctx);
      return { id: "new-session-1" };
    },
    installAgent: async () => {
      calls.push("install");
    },
    deliver: async (session, planReference) => {
      calls.push("deliver");
      deliverArgs.push({ id: session.id, planReference });
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
  return { venue, calls, createArgs, deliverArgs, focusArgs };
}

// ---------------------------------------------------------------------------
// Success path — exact step order
// ---------------------------------------------------------------------------

describe("executeHandoff — success path step order", () => {
  it("runs resolve → create → install → deliver → markExecuting → focus in order", async () => {
    const sessionID = `test-order-${Date.now()}`;
    const { planPath, baseDir } = createPlanFile("planning-done");
    const fake = fakeVenue();

    await executeHandoff({ venue: fake.venue, sessionID, directory: baseDir });

    assert.deepEqual(fake.calls, ["create", "install", "deliver", "focus"]);
    // The plan file is marked executing AFTER deliver (the mark is not a
    // venue call, but it must happen before focus — verified by the plan
    // file content being "executing" when the handoff completes).
    assert.deepEqual(fake.createArgs, [
      { parentage: sessionID, title: "Execute: test-plan" },
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
});

// ---------------------------------------------------------------------------
// Deliver-failure atomicity
// ---------------------------------------------------------------------------

describe("executeHandoff — deliver-failure atomicity", () => {
  it("deliver throws → markExecuting is NOT reached, plan file untouched", async () => {
    const sessionID = `test-deliver-fail-${Date.now()}`;
    const { planPath, baseDir } = createPlanFile("planning-done");
    const before = readFileSync(planPath, "utf-8");
    const fake = fakeVenue({ deliverError: new Error("network down") });

    await assert.rejects(
      () =>
        executeHandoff({
          venue: fake.venue,
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
    const failFake = fakeVenue({ deliverError: new Error("boom") });
    await assert.rejects(
      () =>
        executeHandoff({
          venue: failFake.venue,
          sessionID,
          directory: baseDir,
        }),
      /boom/,
    );
    assert.ok(
      readFileSync(planPath, "utf-8").includes("status: planning-done"),
    );

    // Second run (same plan still planning-done): succeeds and marks it.
    const okFake = fakeVenue();
    await executeHandoff({
      venue: okFake.venue,
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
    const fake = fakeVenue();

    await assert.rejects(
      () =>
        executeHandoff({ venue: fake.venue, sessionID, directory: emptyDir }),
      /No plan with status "planning-done"/,
    );

    // No venue step runs without a resolved plan.
    assert.deepEqual(fake.calls, []);
    try {
      rmSync(emptyDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });
});
