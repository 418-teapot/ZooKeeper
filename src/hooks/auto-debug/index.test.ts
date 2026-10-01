/**
 * Tests for the auto-debug hook unit.
 *
 * Locks the descriptor shape, the fail-closed config gate (a missing
 * `[zoo.autodebug]` contributes no settle handler at all), and the
 * `onSettled` handler's judgment-as-read contract through the injected
 * ports: it discovers the workspace Case, re-runs the verification
 * experiment, and returns the strategy's verdict.  Ports and filesystem
 * are fakes — no real binary or disk is touched.
 */
import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, it } from "node:test";
import type {
  AutoDebugDirEntry,
  AutoDebugFs,
  Deps,
  ZdebugExec,
  ZdebugExecResult,
} from "../../core/slots.js";
import { unit } from "./index.js";

const WORKSPACE = "/ws";
const DEBUG_ROOT = join(WORKSPACE, ".zoo", "debug");
const CASE_DIR = join(DEBUG_ROOT, "CASE-1");

/** A successful `{"ok":true,"result":...}` report as a process result. */
function ok(result: unknown): ZdebugExecResult {
  return {
    stdout: JSON.stringify({ ok: true, result }),
    stderr: "",
    exitCode: 0,
  };
}

/** The OPEN Case status payload. */
function openStatus(): unknown {
  return {
    case_id: "CASE-1",
    lifecycle: "OPEN",
    objective: "支付并发测试间歇失败",
    verify: {
      experiment: "EX-001",
      command: "pytest tests/test_payment.py",
      timeout_ms: 12_000,
    },
    claims: {},
    deliverables: {},
    experiments: {
      "EX-001": {
        id: "EX-001",
        attempts: [
          {
            attempt_id: "AT-001",
            status: "completed",
            exit_code: 1,
            finished_at: "2026-09-25T00:00:00Z",
          },
        ],
      },
    },
  };
}

/** A filesystem holding exactly the `CASE-1` Case. */
function caseFs(): AutoDebugFs {
  const dirs: Record<string, AutoDebugDirEntry[]> = {
    [DEBUG_ROOT]: [{ name: "CASE-1", isDirectory: true }],
    [CASE_DIR]: [
      { name: "case.jsonl", isDirectory: false },
      { name: "summary.md", isDirectory: false },
    ],
  };
  return {
    listDir: async (path) => dirs[path] ?? [],
  };
}

/** A recording `zdebug` fake whose run result is configurable. */
function execFake(exitCode: number): ZdebugExec {
  return async (args) => {
    if (args[0] === "case" && args[1] === "status") return ok(openStatus());
    if (args[0] === "experiment" && args[1] === "run") {
      return ok({ exit_code: exitCode });
    }
    throw new Error(`unexpected zdebug args: ${args.join(" ")}`);
  };
}

/** Assemble a partial deps object for unit-level tests. */
function makeDeps(partial: Record<string, unknown>): Deps {
  return {
    limits: {},
    contextConfig: {},
    autoDebugConfig: { maxWakes: 3 },
    client: {},
    directory: WORKSPACE,
    resolveAgent: () => undefined,
    ...partial,
  } as unknown as Deps;
}

/** Compose the unit and run its `onSettled` handler. */
async function settle(deps: Deps) {
  const composed = unit.create(deps, {
    agents: new Set(),
    skills: new Set(),
    hooks: new Set(["auto-debug"]),
    tools: new Set(),
    commands: new Set(),
  });
  assert.equal(composed.onSettled.length, 1);
  return composed.onSettled[0].handle({ sessionID: "s1", hadActivity: true });
}

describe("auto-debug unit — descriptor", () => {
  it("registers under the auto-debug hook name", () => {
    assert.equal(unit.name, "auto-debug");
    assert.equal(unit.kind, "hook");
  });

  it("contributes only the onSettled slot", () => {
    const composed = unit.create(makeDeps({}), {
      agents: new Set(),
      skills: new Set(),
      hooks: new Set(["auto-debug"]),
      tools: new Set(),
      commands: new Set(),
    });
    assert.deepEqual(composed.beforeExec, []);
    assert.deepEqual(composed.afterExec, []);
    assert.deepEqual(composed.transform, []);
    assert.deepEqual(composed.textComplete, []);
    assert.deepEqual(composed.toolDefinition, []);
    assert.deepEqual(composed.delegation, []);
    assert.equal(composed.onSettled.length, 1);
    assert.equal(composed.onSettled[0].name, "autoDebug");
    assert.equal(composed.onSettled[0].maxWakes, 3);
  });

  it("declares the parsed max_wakes as its wake allowance", () => {
    const composed = unit.create(
      makeDeps({
        autoDebugConfig: { maxWakes: 7 },
      }),
      {
        agents: new Set(),
        skills: new Set(),
        hooks: new Set(["auto-debug"]),
        tools: new Set(),
        commands: new Set(),
      },
    );
    assert.equal(composed.onSettled[0].maxWakes, 7);
  });

  it("contributes no settle handler without a valid config", () => {
    const composed = unit.create(makeDeps({ autoDebugConfig: undefined }), {
      agents: new Set(),
      skills: new Set(),
      hooks: new Set(["auto-debug"]),
      tools: new Set(),
      commands: new Set(),
    });
    assert.deepEqual(composed.onSettled, []);
  });
});

describe("auto-debug unit — onSettled judgment", () => {
  it("wakes when the verification experiment is still failing", async () => {
    const decision = await settle(
      makeDeps({ autoDebugFs: caseFs(), zdebugExec: execFake(1) }),
    );
    assert.equal(decision.kind, "wake");
    if (decision.kind !== "wake") return;
    assert.ok(decision.text.includes("判据重跑结果"));
    assert.ok(decision.text.includes(".zoo/debug/CASE-1/summary.md"));
  });

  it("converges when the verification experiment passes", async () => {
    const decision = await settle(
      makeDeps({ autoDebugFs: caseFs(), zdebugExec: execFake(0) }),
    );
    assert.deepEqual(decision, { kind: "silence", reason: "converged" });
  });

  it("silences no-case when no Case exists in the workspace", async () => {
    const emptyFs: AutoDebugFs = {
      listDir: async () => [],
    };
    const decision = await settle(
      makeDeps({ autoDebugFs: emptyFs, zdebugExec: execFake(1) }),
    );
    assert.deepEqual(decision, { kind: "silence", reason: "no-case" });
  });

  it("silences discovery-error when the workspace scan fails", async () => {
    const throwingFs: AutoDebugFs = {
      listDir: async () => {
        throw new Error("EACCES: permission denied");
      },
    };
    const decision = await settle(
      makeDeps({ autoDebugFs: throwingFs, zdebugExec: execFake(1) }),
    );
    assert.deepEqual(decision, { kind: "silence", reason: "discovery-error" });
  });
});
