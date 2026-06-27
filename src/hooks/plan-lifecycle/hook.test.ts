/**
 * Tests for src/hooks/plan-lifecycle/hook.ts — /go command adapter.
 *
 * Uses in-memory mocks for the OpenCode client to avoid real
 * session creation. Tests focus on orchestration flow, error handling,
 * and client API edge cases.
 */

import { describe, expect, it } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { plansDir } from "../../core/plan.js";
import { handleGoCommand, type PlanClient } from "./hook.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

let _tmpCounter = 0;

function tmpDir(): string {
  const dir = join(tmpdir(), `zoo-hook-test-${Date.now()}-${_tmpCounter++}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function createPlanFile(
  sessionID: string,
  status: string,
): { planPath: string; baseDir: string } {
  const baseDir = tmpDir();
  const dir = plansDir(sessionID, baseDir);
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
    const dir = planPath.replace(/\/test-plan\.md$/, "");
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

function createMockClient(overrides?: Partial<PlanClient>): PlanClient {
  return {
    session: {
      create: () =>
        Promise.resolve({ data: { id: "new-session-456" }, error: undefined }),
      promptAsync: () => Promise.resolve(undefined),
      prompt: () => Promise.resolve(undefined),
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
}

// ---------------------------------------------------------------------------
// Success path
// ---------------------------------------------------------------------------

describe("handleGoCommand — success path", () => {
  it("completes full handoff with all client APIs available", async () => {
    const sessionID = `test-success-${Date.now()}`;
    const { planPath, baseDir } = createPlanFile(sessionID, "planning-done");

    const client = createMockClient();
    await handleGoCommand(client, sessionID, "/workspace", baseDir);

    // If no error thrown, the flow completed successfully
    cleanupPlan(planPath);
  });

  it("creates session with correct title and agent", async () => {
    const sessionID = `test-create-${Date.now()}`;
    const { planPath, baseDir } = createPlanFile(sessionID, "planning-done");

    let createCall: any = null;
    const client = createMockClient({
      session: {
        create: (input: any) => {
          createCall = input;
          return Promise.resolve({
            data: { id: "new-session-789" },
            error: undefined,
          });
        },
        promptAsync: () => Promise.resolve(undefined),
      },
    });

    await handleGoCommand(client, sessionID, "/workspace", baseDir);

    expect(createCall).not.toBeNull();
    expect(createCall.body.title).toBe("Execute: test-plan");
    expect(createCall.body.agent).toBe("dolphin");
    expect(createCall.query.directory).toBe("/workspace");

    cleanupPlan(planPath);
  });

  it("navigates to home before switching session", async () => {
    const sessionID = `test-nav-${Date.now()}`;
    const { planPath, baseDir } = createPlanFile(sessionID, "planning-done");

    const navigations: string[] = [];
    const publishes: any[] = [];

    const client = createMockClient({
      route: {
        navigate: (name: string) => navigations.push(name),
      },
      tui: {
        publish: (input: any) => {
          publishes.push(input);
          return Promise.resolve(undefined);
        },
      },
    });

    await handleGoCommand(client, sessionID, "/workspace", baseDir);

    expect(navigations).toEqual(["home"]);
    expect(publishes.length).toBe(1);
    expect(publishes[0].body.type).toBe("tui.session.select");

    cleanupPlan(planPath);
  });

  it("injects plan reference with correct path", async () => {
    const sessionID = `test-prompt-${Date.now()}`;
    const { planPath, baseDir } = createPlanFile(sessionID, "planning-done");

    let promptCall: any = null;
    const client = createMockClient({
      session: {
        create: () =>
          Promise.resolve({ data: { id: "sess-789" }, error: undefined }),
        promptAsync: (input: any) => {
          promptCall = input;
          return Promise.resolve(undefined);
        },
      },
    });

    await handleGoCommand(client, sessionID, "/workspace", baseDir);

    expect(promptCall).not.toBeNull();
    expect(promptCall.path.id).toBe("sess-789");
    expect(promptCall.body.agent).toBe("dolphin");
    expect(promptCall.body.parts[0].text).toInclude(planPath);

    cleanupPlan(planPath);
  });

  it("injects silent confirmation with noReply and ignored", async () => {
    const sessionID = `test-confirm-${Date.now()}`;
    const { planPath, baseDir } = createPlanFile(sessionID, "planning-done");

    let promptCall: any = null;
    const client = createMockClient({
      session: {
        create: () =>
          Promise.resolve({ data: { id: "sess-abc" }, error: undefined }),
        promptAsync: () => Promise.resolve(undefined),
        prompt: (input: any) => {
          promptCall = input;
          return Promise.resolve(undefined);
        },
      },
    });

    await handleGoCommand(client, sessionID, "/workspace", baseDir);

    expect(promptCall).not.toBeNull();
    expect(promptCall.path.id).toBe("sess-abc");
    expect(promptCall.body.noReply).toBe(true);
    expect(promptCall.body.parts[0].ignored).toBe(true);
    expect(promptCall.body.parts[0].text).toBe("Plan handed off to dolphin.");

    cleanupPlan(planPath);
  });

  it("updates plan status to executing", async () => {
    const sessionID = `test-status-${Date.now()}`;
    const { planPath, baseDir } = createPlanFile(sessionID, "planning-done");

    const client = createMockClient();
    await handleGoCommand(client, sessionID, "/workspace", baseDir);

    const content = readFileSync(planPath, "utf-8");
    expect(content).toInclude("status: executing");

    cleanupPlan(planPath);
  });
});

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------

describe("handleGoCommand — error handling", () => {
  it("throws when no planning-done plan exists", async () => {
    const sessionID = `test-no-plan-${Date.now()}`;
    // No plan file created

    const client = createMockClient();
    await expect(
      handleGoCommand(client, sessionID, "/workspace"),
    ).rejects.toThrow(/No plan with status "planning-done"/);
  });

  it("throws when client has no session.create API", async () => {
    const sessionID = `test-no-api-${Date.now()}`;
    const { planPath, baseDir } = createPlanFile(sessionID, "planning-done");

    const client = createMockClient({ session: {} });
    await expect(
      handleGoCommand(client, sessionID, "/workspace", baseDir),
    ).rejects.toThrow(/Session creation API is not available/);

    cleanupPlan(planPath);
  });

  it("throws when session creation returns error", async () => {
    const sessionID = `test-create-err-${Date.now()}`;
    const { planPath, baseDir } = createPlanFile(sessionID, "planning-done");

    const client = createMockClient({
      session: {
        create: () =>
          Promise.resolve({ data: undefined, error: "rate limited" }),
      },
    });

    await expect(
      handleGoCommand(client, sessionID, "/workspace", baseDir),
    ).rejects.toThrow(/Failed to create dolphin session: rate limited/);

    cleanupPlan(planPath);
  });

  it("throws when session creation returns no ID", async () => {
    const sessionID = `test-no-id-${Date.now()}`;
    const { planPath, baseDir } = createPlanFile(sessionID, "planning-done");

    const client = createMockClient({
      session: {
        create: () => Promise.resolve({ data: {}, error: undefined }),
      },
    });

    await expect(
      handleGoCommand(client, sessionID, "/workspace", baseDir),
    ).rejects.toThrow(
      /Failed to create dolphin session: no session ID returned/,
    );

    cleanupPlan(planPath);
  });

  it("throws when promptAsync is unavailable", async () => {
    const sessionID = `test-no-prompt-${Date.now()}`;
    const { planPath, baseDir } = createPlanFile(sessionID, "planning-done");

    const client = createMockClient({
      session: {
        create: () =>
          Promise.resolve({ data: { id: "sess-123" }, error: undefined }),
        promptAsync: undefined,
      },
    });

    await expect(
      handleGoCommand(client, sessionID, "/workspace", baseDir),
    ).rejects.toThrow(/promptAsync is not available/);

    cleanupPlan(planPath);
  });
});

// ---------------------------------------------------------------------------
// Client API edge cases
// ---------------------------------------------------------------------------

describe("handleGoCommand — client API edge cases", () => {
  it("works when route.navigate is missing", async () => {
    const sessionID = `test-no-route-${Date.now()}`;
    const { planPath, baseDir } = createPlanFile(sessionID, "planning-done");

    const client = createMockClient({ route: undefined });
    await handleGoCommand(client, sessionID, "/workspace", baseDir);

    cleanupPlan(planPath);
  });

  it("works when tui.publish is missing", async () => {
    const sessionID = `test-no-tui-${Date.now()}`;
    const { planPath, baseDir } = createPlanFile(sessionID, "planning-done");

    const client = createMockClient({ tui: undefined });
    await handleGoCommand(client, sessionID, "/workspace", baseDir);

    cleanupPlan(planPath);
  });

  it("works when session.prompt is missing (no confirmation)", async () => {
    const sessionID = `test-no-confirm-${Date.now()}`;
    const { planPath, baseDir } = createPlanFile(sessionID, "planning-done");

    const client = createMockClient({
      session: {
        create: () =>
          Promise.resolve({ data: { id: "sess-123" }, error: undefined }),
        promptAsync: () => Promise.resolve(undefined),
        prompt: undefined,
      },
    });
    await handleGoCommand(client, sessionID, "/workspace", baseDir);

    cleanupPlan(planPath);
  });

  it("continues when prompt throws (best-effort)", async () => {
    const sessionID = `test-prompt-err-${Date.now()}`;
    const { planPath, baseDir } = createPlanFile(sessionID, "planning-done");

    const client = createMockClient({
      session: {
        create: () =>
          Promise.resolve({ data: { id: "sess-123" }, error: undefined }),
        promptAsync: () => Promise.resolve(undefined),
        prompt: () => Promise.reject(new Error("network error")),
      },
    });

    // Should not throw — prompt error is caught and logged
    await handleGoCommand(client, sessionID, "/workspace", baseDir);

    cleanupPlan(planPath);
  });

  it("handles null client gracefully (throws with clear message)", async () => {
    const sessionID = `test-null-client-${Date.now()}`;
    const { planPath, baseDir } = createPlanFile(sessionID, "planning-done");

    await expect(
      handleGoCommand(null, sessionID, "/workspace", baseDir),
    ).rejects.toThrow(/Session creation API is not available/);

    cleanupPlan(planPath);
  });
});

// ---------------------------------------------------------------------------
// Plan status edge cases
// ---------------------------------------------------------------------------

describe("handleGoCommand — plan status edge cases", () => {
  it("throws when plan is already executing", async () => {
    const sessionID = `test-executing-${Date.now()}`;
    const { planPath, baseDir } = createPlanFile(sessionID, "executing");

    const client = createMockClient();
    await expect(
      handleGoCommand(client, sessionID, "/workspace", baseDir),
    ).rejects.toThrow(/No plan with status "planning-done"/);

    cleanupPlan(planPath);
  });

  it("throws when plan is already done", async () => {
    const sessionID = `test-done-${Date.now()}`;
    const { planPath, baseDir } = createPlanFile(sessionID, "done");

    const client = createMockClient();
    await expect(
      handleGoCommand(client, sessionID, "/workspace", baseDir),
    ).rejects.toThrow(/No plan with status "planning-done"/);

    cleanupPlan(planPath);
  });
});
