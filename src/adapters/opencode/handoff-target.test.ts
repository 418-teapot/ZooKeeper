/**
 * Tests for the OpenCode handoff target
 * (`src/adapters/opencode/handoff-target.ts`).
 *
 * The handoff target is exercised through the full handoff protocol
 * (`executeHandoff`) with a fake PlanClient: session creation carries
 * the fixture default primary agent, the plan reference is delivered
 * via `promptAsync` BEFORE the plan file is marked `executing`, and a
 * delivery failure leaves the plan file untouched.
 */
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { executeHandoff } from "../../core/handoff.js";
import { buildConfirmText } from "../../core/plan.js";
import { _resetForTesting, initLogger } from "../../utils/logger.js";
import {
  createOpenCodeHandoffTarget,
  type PlanClient,
} from "./handoff-target.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

let _tmpCounter = 0;

function tmpDir(): string {
  const dir = join(
    tmpdir(),
    `zoo-handoff-target-oc-${Date.now()}-${_tmpCounter++}`,
  );
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

/** A fake OpenCode PlanClient with recorded calls. */
function makeClient(overrides?: Partial<PlanClient>): {
  client: PlanClient;
  createCalls: any[];
  promptAsyncCalls: any[];
  promptCalls: any[];
} {
  const createCalls: any[] = [];
  const promptAsyncCalls: any[] = [];
  const promptCalls: any[] = [];
  const client: PlanClient = {
    session: {
      create: (input: any) => {
        createCalls.push(input);
        return Promise.resolve({
          data: { id: "new-session-456" },
          error: undefined,
        });
      },
      promptAsync: (input: any) => {
        promptAsyncCalls.push(input);
        return Promise.resolve(undefined);
      },
      prompt: (input: any) => {
        promptCalls.push(input);
        return Promise.resolve(undefined);
      },
      ...overrides?.session,
    },
    tui: {
      publish: () => Promise.resolve(undefined),
      ...overrides?.tui,
    },
    route: {
      navigate: () => {},
      ...overrides?.route,
    },
    ...overrides,
  };
  return { client, createCalls, promptAsyncCalls, promptCalls };
}

// ---------------------------------------------------------------------------
// Session creation
// ---------------------------------------------------------------------------

describe("OpenCode handoff target — session creation", () => {
  it("creates the session with the fixture default primary agent and the plan-slug title", async () => {
    const sessionID = `test-create-${Date.now()}`;
    const { planPath, baseDir } = createPlanFile("planning-done");
    const { client, createCalls } = makeClient();

    const handoffTarget = createOpenCodeHandoffTarget(
      client,
      DEFAULT_PRIMARY,
      baseDir,
    );
    await executeHandoff({
      handoffTarget,
      sessionID,
      directory: baseDir,
    });

    assert.equal(createCalls.length, 1);
    assert.equal(createCalls[0].body.agent, DEFAULT_PRIMARY);
    assert.equal(createCalls[0].body.title, "Execute: test-plan");
    assert.equal(createCalls[0].query.directory, baseDir);

    cleanupPlan(planPath);
  });

  it("throws fail-closed when the default primary is undefined", async () => {
    const sessionID = `test-no-primary-${Date.now()}`;
    const { planPath, baseDir } = createPlanFile("planning-done");
    const { client } = makeClient();

    const handoffTarget = createOpenCodeHandoffTarget(
      client,
      undefined,
      baseDir,
    );
    await assert.rejects(
      () => executeHandoff({ handoffTarget, sessionID, directory: baseDir }),
      /No default primary agent is configured/,
    );
    // The plan stays planning-done — nothing was delivered or marked.
    assert.ok(
      readFileSync(planPath, "utf-8").includes("status: planning-done"),
    );

    cleanupPlan(planPath);
  });

  it("throws fail-closed when the client lacks session.create", async () => {
    const sessionID = `test-no-create-${Date.now()}`;
    const { planPath, baseDir } = createPlanFile("planning-done");
    const client: PlanClient = {};

    const handoffTarget = createOpenCodeHandoffTarget(
      client,
      DEFAULT_PRIMARY,
      baseDir,
    );
    await assert.rejects(
      () => executeHandoff({ handoffTarget, sessionID, directory: baseDir }),
      /Session creation API is not available/,
    );
    assert.ok(
      readFileSync(planPath, "utf-8").includes("status: planning-done"),
    );

    cleanupPlan(planPath);
  });
});

// ---------------------------------------------------------------------------
// Delivery ordering + atomicity
// ---------------------------------------------------------------------------

describe("OpenCode handoff target — delivery ordering and atomicity", () => {
  it("promptAsync runs BEFORE the plan is marked executing", async () => {
    const sessionID = `test-order-${Date.now()}`;
    const { planPath, baseDir } = createPlanFile("planning-done");

    // Record the plan file content at the moment promptAsync fires.
    let statusAtPrompt: string | undefined;
    const { client } = makeClient({
      session: {
        create: () =>
          Promise.resolve({ data: { id: "sess-789" }, error: undefined }),
        promptAsync: () => {
          const content = readFileSync(planPath, "utf-8");
          statusAtPrompt = /status:\s*(\S+)/.exec(content)?.[1];
          return Promise.resolve(undefined);
        },
      },
    });

    const handoffTarget = createOpenCodeHandoffTarget(
      client,
      DEFAULT_PRIMARY,
      baseDir,
    );
    await executeHandoff({ handoffTarget, sessionID, directory: baseDir });

    // The plan must still be planning-done while the reference is being
    // delivered — the executing mark happens only after.
    assert.equal(statusAtPrompt, "planning-done");
    assert.ok(readFileSync(planPath, "utf-8").includes("status: executing"));

    cleanupPlan(planPath);
  });

  it("promptAsync delivers the plan reference with the fixture primary", async () => {
    const sessionID = `test-deliver-${Date.now()}`;
    const { planPath, baseDir } = createPlanFile("planning-done");
    const { client, promptAsyncCalls } = makeClient();

    const handoffTarget = createOpenCodeHandoffTarget(
      client,
      DEFAULT_PRIMARY,
      baseDir,
    );
    await executeHandoff({ handoffTarget, sessionID, directory: baseDir });

    assert.equal(promptAsyncCalls.length, 1);
    assert.equal(promptAsyncCalls[0].path.id, "new-session-456");
    assert.equal(promptAsyncCalls[0].body.agent, DEFAULT_PRIMARY);
    assert.ok(promptAsyncCalls[0].body.parts[0].text.includes(planPath));

    cleanupPlan(planPath);
  });

  it("delivery failure → plan file untouched and handoff re-runnable", async () => {
    const sessionID = `test-fail-${Date.now()}`;
    const { planPath, baseDir } = createPlanFile("planning-done");
    const before = readFileSync(planPath, "utf-8");

    const failing = makeClient({
      session: {
        create: () =>
          Promise.resolve({ data: { id: "sess-123" }, error: undefined }),
        promptAsync: () => Promise.reject(new Error("delivery network error")),
      },
    });
    const failingHandoffTarget = createOpenCodeHandoffTarget(
      failing.client,
      DEFAULT_PRIMARY,
      baseDir,
    );
    await assert.rejects(
      () =>
        executeHandoff({
          handoffTarget: failingHandoffTarget,
          sessionID,
          directory: baseDir,
        }),
      /delivery network error/,
    );
    // Byte-identical plan file — still planning-done.
    assert.equal(readFileSync(planPath, "utf-8"), before);

    // Re-run succeeds and marks the plan.
    const ok = makeClient();
    const okHandoffTarget = createOpenCodeHandoffTarget(
      ok.client,
      DEFAULT_PRIMARY,
      baseDir,
    );
    await executeHandoff({
      handoffTarget: okHandoffTarget,
      sessionID,
      directory: baseDir,
    });
    assert.ok(readFileSync(planPath, "utf-8").includes("status: executing"));

    cleanupPlan(planPath);
  });

  it("posts the silent confirmation after the reference", async () => {
    const sessionID = `test-confirm-${Date.now()}`;
    const { planPath, baseDir } = createPlanFile("planning-done");
    const { client, promptCalls } = makeClient();

    const handoffTarget = createOpenCodeHandoffTarget(
      client,
      DEFAULT_PRIMARY,
      baseDir,
    );
    await executeHandoff({ handoffTarget, sessionID, directory: baseDir });

    assert.equal(promptCalls.length, 1);
    assert.equal(promptCalls[0].path.id, "new-session-456");
    assert.equal(promptCalls[0].body.noReply, true);
    assert.equal(promptCalls[0].body.parts[0].ignored, true);
    assert.equal(promptCalls[0].body.parts[0].text, buildConfirmText());

    cleanupPlan(planPath);
  });
});

// ---------------------------------------------------------------------------
// TUI focus
// ---------------------------------------------------------------------------

describe("OpenCode handoff target — TUI focus", () => {
  it("navigates home then publishes tui.session.select for the new session", async () => {
    const sessionID = `test-focus-${Date.now()}`;
    const { planPath, baseDir } = createPlanFile("planning-done");

    const navigations: string[] = [];
    const publishes: any[] = [];
    const { client } = makeClient({
      route: { navigate: (name: string) => navigations.push(name) },
      tui: {
        publish: (input: any) => {
          publishes.push(input);
          return Promise.resolve(undefined);
        },
      },
    });

    const handoffTarget = createOpenCodeHandoffTarget(
      client,
      DEFAULT_PRIMARY,
      baseDir,
    );
    await executeHandoff({ handoffTarget, sessionID, directory: baseDir });

    assert.deepEqual(navigations, ["home"]);
    assert.equal(publishes.length, 1);
    assert.equal(publishes[0].body.type, "tui.session.select");
    assert.equal(publishes[0].body.properties.sessionID, "new-session-456");

    cleanupPlan(planPath);
  });
});
