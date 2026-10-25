/**
 * Tests for the `/go` command unit (`src/commands/go/index.ts`).
 *
 * The unit is exercised through its descriptor: a selection that resolved
 * no orchestrator role contributes zero commands, while one that did
 * contributes `/go` and hands that executor to `executeHandoff` — the
 * fake handoff target records the agent each step receives.
 */
import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { HandoffTarget } from "../../core/handoff.js";
import type { CommandUnitDescriptor } from "../../core/unit.js";
import { facts } from "../../testkits/compose.js";
import { cleanupPlan, createPlanFile } from "../../testkits/plans.js";
import { makeTmpDir } from "../../testkits/tmp.js";
import { _resetForTesting, initLogger } from "../../utils/logger.js";
import { unit } from "./index.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Fixture executor — a made-up name, never a real agent. */
const EXECUTOR = "alpha";

/** The executor this test asserts the handoff ran with. */
const SESSION_ID = "sess-go";

let _loggerDir: string;

beforeEach(() => {
  _resetForTesting();
  _loggerDir = makeTmpDir("zoo-go-unit");
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

/** A handoff target that records the executor every step was given. */
function recordingTarget(): {
  target: HandoffTarget;
  createAgents: string[];
  installAgents: string[];
  deliverAgents: string[];
} {
  const createAgents: string[] = [];
  const installAgents: string[] = [];
  const deliverAgents: string[] = [];
  const target: HandoffTarget = {
    create: async (ctx) => {
      createAgents.push(ctx.agent);
      return { id: "ses-exec", agent: ctx.agent };
    },
    installAgent: (session) => {
      installAgents.push(session.agent);
    },
    deliver: async (session) => {
      deliverAgents.push(session.agent);
    },
    focus: () => {},
  };
  return { target, createAgents, installAgents, deliverAgents };
}

/** Capability slice the unit declares as required. */
function caps(
  target: HandoffTarget,
  directory: string,
): Parameters<CommandUnitDescriptor["create"]>[0] {
  return { handoffTarget: target, directory };
}

// ---------------------------------------------------------------------------
// Zero-command selection
// ---------------------------------------------------------------------------

describe("/go unit — role-less selection", () => {
  it("contributes no command when the selection resolved no orchestrator", () => {
    const { target } = recordingTarget();
    const contributions = unit.create(caps(target, "/workspace"), facts());

    assert.equal(contributions.kind, "command");
    assert.deepEqual(contributions.commands, []);
  });
});

// ---------------------------------------------------------------------------
// Executor passthrough
// ---------------------------------------------------------------------------

describe("/go unit — executor passthrough", () => {
  it("contributes /go and hands the resolved orchestrator to the handoff", async () => {
    const { target, createAgents, installAgents, deliverAgents } =
      recordingTarget();
    const { planPath, baseDir } = createPlanFile("planning-done");
    const contributions = unit.create(
      caps(target, baseDir),
      facts({ orchestrator: EXECUTOR }),
    );

    assert.equal(contributions.commands.length, 1);
    assert.equal(contributions.commands[0].name, "go");
    await contributions.commands[0].handle({
      command: "go",
      sessionID: SESSION_ID,
      arguments: "",
    });

    assert.deepEqual(createAgents, [EXECUTOR]);
    assert.deepEqual(installAgents, [EXECUTOR]);
    assert.deepEqual(deliverAgents, [EXECUTOR]);
    assert.ok(readFileSync(planPath, "utf-8").includes("status: executing"));

    cleanupPlan(planPath);
  });

  it("surfaces a handoff failure through the tool host instead of throwing", async () => {
    const notifications: string[] = [];
    // A target whose create fails fail-closed: no session is created, so
    // the plan stays planning-done and the handler reports the failure.
    const target: HandoffTarget = {
      create: async () => {
        throw new Error("session creation exploded");
      },
      installAgent: () => {},
      deliver: async () => {},
      focus: () => {},
    };
    const { planPath, baseDir } = createPlanFile("planning-done");
    const contributions = unit.create(
      {
        ...caps(target, baseDir),
        toolHost: {
          resolveSessionId: () => SESSION_ID,
          notify: async (_sessionId: string, text: string) => {
            notifications.push(text);
          },
        },
      },
      facts({ orchestrator: EXECUTOR }),
    );

    await contributions.commands[0].handle({
      command: "go",
      sessionID: SESSION_ID,
      arguments: "",
    });

    assert.equal(notifications.length, 1);
    assert.ok(notifications[0].includes("session creation exploded"));
    assert.ok(
      readFileSync(planPath, "utf-8").includes("status: planning-done"),
    );

    cleanupPlan(planPath);
  });
});
