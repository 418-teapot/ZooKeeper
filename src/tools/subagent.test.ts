/**
 * Tests for the subagent delegation tool unit (`src/tools/subagent.ts`).
 *
 * Covers the full delegation flow of the contributed tool's `execute`:
 * resolving the CALLER identity, capability-set computation for the
 * TARGET agent (baseline minus the target's config.toml tool-level
 * denies, fail-closed on a missing baseline), the `runSubagent` request
 * shape (agent / task / tools / parentSession), the `SubagentResult`
 * → tool-text mapping (ok → text verbatim; failure variants → text plus a
 * short reason line), and the run-registry write lifecycle (start /
 * update / finish with the forwarded tool-call id and the nested
 * parent-session pointer).  Also covers the fail-closed registration gate:
 * with no `subagentDriver` in deps the unit contributes zero tools.
 *
 * The tool contains no delegation policy and no prompt-formatting policy —
 * the composed delegation gate and the subagent-prompt format hint are both
 * enforced at the host registration boundary (see `src/compose-pi.test.ts`
 * and the compose-opencode `tool.definition` tests), so no gate or hint
 * cases appear here.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { ModeProfile } from "../core/config-types.js";
import type { Projection } from "../core/context/lens.js";
import { project } from "../core/context/lens.js";
import type { Capabilities } from "../core/ports/index.js";
import type { ToolHost } from "../core/ports/tool-host.js";
import type {
  SubagentDriver,
  SubagentProgress,
  SubagentRequest,
  SubagentResult,
} from "../core/subagent/driver.js";
import {
  createRunRegistry,
  type RunRegistry,
} from "../core/subagent/registry.js";
import type { ToolCallContext } from "../core/unit.js";
import { composeForTest, facts } from "../testkits/compose.js";
import { callFor } from "../testkits/context-runtime.js";
import {
  _getBufferForTesting,
  _resetForTesting as _resetLoggerForTesting,
} from "../utils/logger.js";
import { unit } from "./subagent.js";

// Each test owns its run registry, so the registry-write assertions never
// depend on what an earlier test wrote.
let runs: RunRegistry = createRunRegistry();

beforeEach(() => {
  runs = createRunRegistry();
});

afterEach(() => {
  _resetLoggerForTesting();
});

/** The call context a delegation receives, unless a case overrides it. */
function TOOL_CALL(overrides: Partial<ToolCallContext> = {}): ToolCallContext {
  return callFor("sess-subagent", overrides);
}

/** A minimal ToolHost over this suite's history read and notify. */
const TOOL_HOST: ToolHost = {
  async fetchHistory(): Promise<Projection> {
    return project([], []);
  },
  async notify(): Promise<void> {},
};

/** A fake driver that records its request and returns a fixed result. */
function fakeDriver(result: SubagentResult): {
  driver: SubagentDriver;
  calls: Array<{ request: SubagentRequest; signal: AbortSignal }>;
} {
  const calls: Array<{ request: SubagentRequest; signal: AbortSignal }> = [];
  const driver: SubagentDriver = {
    async run(request, ctx) {
      calls.push({ request, signal: ctx.signal });
      return result;
    },
  };
  return { driver, calls };
}

/** Build a `create`-compatible Capabilities with the given overrides. */
function makeDeps(
  overrides: Partial<Partial<Capabilities>> = {},
): Partial<Capabilities> {
  return {
    limits: {},
    contextConfig: {},
    runs,
    // The target-role guard reads the parsed agent modes; the default
    // fixture declares beaver as a delegatable subagent so the existing
    // happy-path cases keep running the driver.
    agentModes: { beaver: "subagent", dolphin: "primary" },
    // Strict model mode: agents.json is the sole model source, so the
    // default fixture configures beaver (the usual delegation target) to
    // keep the happy-path cases running the driver.
    subagentModels: { beaver: "Dummy/dummy-small" },
    directory: "/tmp/zoo",
    // The caller resolution the tool reads: the session the call names is
    // the poly profile's orchestrator unless a case overrides it.
    resolveCallerAgent: async () => "dolphin",
    toolHost: TOOL_HOST,
    ...overrides,
  };
}

/** Configured roles used by the selection-aware target cases. */
const SELECTION_MODES = {
  dolphin: "primary",
  beaver: "subagent",
  lynx: "subagent",
} as const;

/** The contributed subagent tool for a set of deps and a fact projection. */
function tool(
  deps: Partial<Capabilities>,
  uses = facts({ agents: ["beaver"] }),
) {
  const contributions = unit.create(deps, uses);
  assert.equal(contributions.kind, "tool");
  assert.equal(contributions.tools.length, 1, "exactly one tool contributed");
  return contributions.tools[0];
}

// ---------------------------------------------------------------------------
// Fail-closed registration
// ---------------------------------------------------------------------------

/** A minimal mode profile enabling exactly the subagent tool unit. */
const SUBAGENT_TOOL_PROFILE: ModeProfile = {
  name: "test",
  agents: [],
  skills: [],
  hooks: [],
  tools: ["subagent"],
  commands: [],
};

describe("subagent tool unit — fail-closed registration", () => {
  it("skips the unit and reports subagentDriver when no driver is in deps (OpenCode)", () => {
    const result = composeForTest(SUBAGENT_TOOL_PROFILE, [unit], makeDeps());
    assert.deepEqual(result.tools, {});
    assert.deepEqual(result.report.skipped, [
      { name: "subagent", missing: ["subagentDriver"] },
    ]);
  });

  it("refuses a configured subagent the composed profile does not select", async () => {
    // The profile selects dolphin only, so lynx keeps its role prompt out
    // of the run: the composed tool must refuse it.
    const composed = composeForTest(
      { ...SUBAGENT_TOOL_PROFILE, agents: ["dolphin"] },
      [unit],
      makeDeps({
        subagentDriver: fakeDriver({ kind: "ok", text: "done" }).driver,
        agentModes: SELECTION_MODES,
        subagentModels: { lynx: "Dummy/dummy-small" },
      }),
    );
    const composedTool = composed.tools.subagent;
    assert.ok(composedTool, "the selected tool must be composed");

    const { text } = await composedTool.execute(
      { agent: "lynx", description: "扫描代码", prompt: "task" },
      TOOL_CALL(),
    );

    assert.ok(
      text.includes("未在当前 profile 的 agents 中启用"),
      `reason missing: ${text}`,
    );
  });
});

// ---------------------------------------------------------------------------
// Argument validation
// ---------------------------------------------------------------------------

describe("subagent tool execute — argument validation", () => {
  it("rejects missing description and never runs the driver", async () => {
    const { driver, calls } = fakeDriver({ kind: "ok", text: "done" });
    const t = tool(makeDeps({ subagentDriver: driver }));

    await assert.rejects(
      async () =>
        t.execute({ agent: "beaver", prompt: "t" } as never, TOOL_CALL()),
      /description/,
    );
    assert.equal(calls.length, 0, "driver must not run for invalid args");
  });

  it("rejects an empty description and never runs the driver", async () => {
    const { driver, calls } = fakeDriver({ kind: "ok", text: "done" });
    const t = tool(makeDeps({ subagentDriver: driver }));

    await assert.rejects(
      async () =>
        t.execute(
          { agent: "beaver", description: "", prompt: "t" } as never,
          TOOL_CALL(),
        ),
      /description/,
    );
    assert.equal(calls.length, 0, "driver must not run for invalid args");
  });

  it("rejects missing prompt and never runs the driver", async () => {
    const { driver, calls } = fakeDriver({ kind: "ok", text: "done" });
    const t = tool(makeDeps({ subagentDriver: driver }));

    await assert.rejects(
      async () =>
        t.execute(
          { agent: "beaver", description: "实现任务" } as never,
          TOOL_CALL(),
        ),
      /prompt/,
    );
    assert.equal(calls.length, 0, "driver must not run for invalid args");
  });

  it("rejects an empty prompt and never runs the driver", async () => {
    const { driver, calls } = fakeDriver({ kind: "ok", text: "done" });
    const t = tool(makeDeps({ subagentDriver: driver }));

    await assert.rejects(
      async () =>
        t.execute(
          { agent: "beaver", description: "实现任务", prompt: "" } as never,
          TOOL_CALL(),
        ),
      /prompt/,
    );
    assert.equal(calls.length, 0, "driver must not run for invalid args");
  });

  it("rejects non-object arguments and never runs the driver", async () => {
    const { driver, calls } = fakeDriver({ kind: "ok", text: "done" });
    const t = tool(makeDeps({ subagentDriver: driver }));

    await assert.rejects(
      async () => t.execute(null as never, TOOL_CALL()),
      /参数格式错误/,
    );
    assert.equal(calls.length, 0, "driver must not run for invalid args");
  });
});

// ---------------------------------------------------------------------------
// Successful delegation (dolphin → beaver)
// ---------------------------------------------------------------------------

describe("subagent tool execute — successful delegation", () => {
  it("dolphin → beaver runs the driver and returns the subagent text", async () => {
    const { driver, calls } = fakeDriver({
      kind: "ok",
      text: "beaver finished the implementation",
    });

    const t = tool(
      makeDeps({
        subagentDriver: driver,
        subagentBaseline: () => ["bash", "edit", "webfetch", "websearch"],
        agentPermissions: { beaver: ["webfetch", "websearch"] },
      }),
    );

    const { text: result } = await t.execute(
      {
        agent: "beaver",
        description: "实现功能",
        prompt: "Implement the feature",
      },
      TOOL_CALL(),
    );

    assert.equal(result, "beaver finished the implementation");
    assert.equal(calls.length, 1, "driver must run exactly once");
    assert.deepEqual(calls[0].request, {
      agent: "beaver",
      prompt: "Implement the feature",
      tools: ["bash", "edit"],
      parentSession: "sess-subagent",
      // Strict mode: the agents.json configured model is the sole source.
      model: "Dummy/dummy-small",
    });
  });

  it("computes the target capability set as baseline minus the target's denied tools", async () => {
    const { driver, calls } = fakeDriver({ kind: "ok", text: "done" });

    const t = tool(
      makeDeps({
        subagentDriver: driver,
        subagentBaseline: () => ["edit", "webfetch", "bash", "subagent"],
        agentPermissions: { beaver: ["webfetch", "websearch"] },
      }),
    );

    await t.execute(
      { agent: "beaver", description: "实现任务", prompt: "task" },
      TOOL_CALL(),
    );

    assert.deepEqual(calls[0].request.tools, ["bash", "edit", "subagent"]);
  });

  it("proceeds with an empty capability set when the baseline is missing (fail-closed)", async () => {
    const { driver, calls } = fakeDriver({ kind: "ok", text: "done" });

    const t = tool(
      makeDeps({
        subagentDriver: driver,
        agentPermissions: { beaver: ["webfetch"] },
      }),
    );

    await t.execute(
      { agent: "beaver", description: "实现任务", prompt: "task" },
      TOOL_CALL(),
    );

    // No baseline → computeCapabilitySet yields [] — the run still happens,
    // but the driver receives no invented permissions.
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].request.tools, []);
  });

  it("runs under the call's cancellation signal", async () => {
    // A hanging driver that records the signal it observes and only resolves
    // once the run is aborted.
    let release: (() => void) | undefined;
    let observedSignal: AbortSignal | undefined;
    const driver: SubagentDriver = {
      async run(_request, ctx) {
        observedSignal = ctx.signal;
        await new Promise<void>((resolve) => {
          release = () => {
            resolve();
          };
        });
        return { kind: "aborted", text: "" };
      },
    };

    const t = tool(makeDeps({ subagentDriver: driver }));
    const hostController = new AbortController();
    const runPromise = t.execute(
      { agent: "beaver", description: "实现任务", prompt: "task" },
      TOOL_CALL({ signal: hostController.signal }),
    );
    // Let the run reach the hanging driver, then abort the call's signal.
    await new Promise((resolve) => setTimeout(resolve, 20));
    hostController.abort();
    release?.();
    await runPromise;

    assert.ok(observedSignal, "driver must observe a signal");
    assert.equal(observedSignal?.aborted, true);
  });

  it("uses the agents.json configured model (the sole source in strict mode)", async () => {
    const { driver, calls } = fakeDriver({ kind: "ok", text: "done" });

    const t = tool(
      makeDeps({
        subagentDriver: driver,
        subagentModels: { beaver: "Dummy/dummy-large" },
      }),
    );
    await t.execute(
      { agent: "beaver", description: "实现任务", prompt: "task" },
      TOOL_CALL(),
    );

    assert.equal(calls[0].request.model, "Dummy/dummy-large");
  });

  it('passes a concatenated "provider/model" value through to the request (registry-prefixed id)', async () => {
    const { driver, calls } = fakeDriver({ kind: "ok", text: "done" });

    // The loader maps `{provider: "Dummy", model: "dummy/prefixed-id"}`
    // to the concatenated `"Dummy/dummy/prefixed-id"`; the tool must
    // forward that string verbatim (resolveModel splits it on the first `/`
    // back into provider + full registry id).
    const t = tool(
      makeDeps({
        subagentDriver: driver,
        subagentModels: { beaver: "Dummy/dummy/prefixed-id" },
      }),
    );
    await t.execute(
      { agent: "beaver", description: "实现任务", prompt: "task" },
      TOOL_CALL(),
    );

    assert.equal(calls[0].request.model, "Dummy/dummy/prefixed-id");
  });

  it("reports an actionable error when agents.json has no entry for the target", async () => {
    const { driver, calls } = fakeDriver({ kind: "ok", text: "done" });

    // The map exists but lacks the target agent.
    const t = tool(
      makeDeps({
        subagentDriver: driver,
        subagentModels: { lynx: "Dummy/dummy-large" },
      }),
    );
    const { text: result } = await t.execute(
      { agent: "beaver", description: "实现任务", prompt: "task" },
      TOOL_CALL(),
    );

    assert.equal(
      calls.length,
      0,
      "driver must not run when the target has no configured model",
    );
    assert.ok(result.includes("未配置"), `missing error text: ${result}`);
    assert.ok(
      result.includes("beaver"),
      `error must name the target: ${result}`,
    );
    assert.ok(
      result.includes("install.py"),
      `error must hint at re-running install.py: ${result}`,
    );
  });

  it("reports an actionable error when agents.json is missing or invalid (empty map)", async () => {
    const { driver, calls } = fakeDriver({ kind: "ok", text: "done" });

    // No subagentModels → the loader failed closed to an empty map.
    const t = tool(
      makeDeps({ subagentDriver: driver, subagentModels: undefined }),
    );
    const { text: result } = await t.execute(
      { agent: "beaver", description: "实现任务", prompt: "task" },
      TOOL_CALL(),
    );

    assert.equal(
      calls.length,
      0,
      "driver must not run when agents.json is unavailable",
    );
    assert.ok(
      result.includes("agents.json"),
      `error must name agents.json: ${result}`,
    );
    assert.ok(
      result.includes("install.py"),
      `error must hint at re-running install.py: ${result}`,
    );
  });

  it("uses the configured model even without an inherited model", async () => {
    const { driver, calls } = fakeDriver({ kind: "ok", text: "done" });

    const t = tool(
      makeDeps({
        subagentDriver: driver,
        subagentModels: { beaver: "Dummy/dummy-large" },
      }),
    );
    await t.execute(
      { agent: "beaver", description: "实现任务", prompt: "task" },
      TOOL_CALL(),
    );

    assert.equal(calls[0].request.model, "Dummy/dummy-large");
  });

  it("never inherits the parent model when agents.json has no entry for the target", async () => {
    const { driver, calls } = fakeDriver({ kind: "ok", text: "done" });

    // No entry for beaver: strict mode must not fall back to the parent —
    // it errors instead.
    const t = tool(
      makeDeps({
        subagentDriver: driver,
        subagentModels: { lynx: "Dummy/dummy-large" },
      }),
    );
    const { text: result } = await t.execute(
      { agent: "beaver", description: "实现任务", prompt: "task" },
      TOOL_CALL(),
    );

    assert.equal(
      calls.length,
      0,
      "driver must not run — a missing entry is an error, never an inheritance",
    );
    assert.ok(result.includes("未配置"), `missing error text: ${result}`);
  });
});

// ---------------------------------------------------------------------------
// Target-role guard (fail-closed on non-subagent targets)
// ---------------------------------------------------------------------------

describe("subagent tool execute — target-role guard", () => {
  it('rejects a target declared mode = "primary" with a reason text and never runs the driver', async () => {
    const { driver, calls } = fakeDriver({ kind: "ok", text: "done" });

    const t = tool(
      makeDeps({
        subagentDriver: driver,
        agentModes: { dolphin: "primary", beaver: "subagent", mola: "primary" },
      }),
    );

    const { text: result } = await t.execute(
      { agent: "mola", description: "实现任务", prompt: "task" },
      TOOL_CALL(),
    );

    assert.equal(calls.length, 0, "driver must not run for a primary target");
    assert.ok(
      result.includes("不是可委派的子 agent"),
      `reason missing: ${result}`,
    );
    assert.ok(
      result.includes("mola"),
      `reason must name the target: ${result}`,
    );
  });

  it("rejects an unknown target name with a reason text and never runs the driver", async () => {
    const { driver, calls } = fakeDriver({ kind: "ok", text: "done" });

    const t = tool(
      makeDeps({
        subagentDriver: driver,
        agentModes: { dolphin: "primary", beaver: "subagent" },
      }),
    );

    const { text: result } = await t.execute(
      { agent: "nonexistent", description: "实现任务", prompt: "task" },
      TOOL_CALL(),
    );

    assert.equal(calls.length, 0, "driver must not run for an unknown target");
    assert.ok(
      result.includes("不是可委派的子 agent"),
      `reason missing: ${result}`,
    );
    assert.ok(
      result.includes("nonexistent"),
      `reason must name the target: ${result}`,
    );
  });

  it("rejects every target when the modes map is absent (fail-closed)", async () => {
    const { driver, calls } = fakeDriver({ kind: "ok", text: "done" });

    // No agentModes in deps → no target can be verified as a subagent.
    const t = tool(makeDeps({ subagentDriver: driver, agentModes: undefined }));

    const { text: result } = await t.execute(
      { agent: "beaver", description: "实现任务", prompt: "task" },
      TOOL_CALL(),
    );

    assert.equal(
      calls.length,
      0,
      "driver must not run when the modes map is missing",
    );
    assert.ok(
      result.includes("不是可委派的子 agent"),
      `reason missing: ${result}`,
    );
  });

  it("rejects a configured subagent the profile does not select", async () => {
    const { driver, calls } = fakeDriver({ kind: "ok", text: "done" });

    // lynx is a configured subagent, but the profile enables only dolphin
    // and beaver, so lynx runs without its role prompt.
    const t = tool(
      makeDeps({
        subagentDriver: driver,
        agentModes: SELECTION_MODES,
        subagentModels: { lynx: "Dummy/dummy-small" },
      }),
      facts({ agents: ["dolphin", "beaver"] }),
    );

    const { text: result } = await t.execute(
      { agent: "lynx", description: "扫描代码", prompt: "task" },
      TOOL_CALL(),
    );

    assert.equal(
      calls.length,
      0,
      "driver must not run for a subagent the profile does not select",
    );
    assert.ok(
      result.includes("lynx"),
      `reason must name the target: ${result}`,
    );
    assert.ok(
      result.includes("未在当前 profile 的 agents 中启用"),
      `reason missing: ${result}`,
    );
  });

  it("runs a configured subagent the profile selects", async () => {
    const { driver, calls } = fakeDriver({ kind: "ok", text: "done" });

    const t = tool(
      makeDeps({ subagentDriver: driver, agentModes: SELECTION_MODES }),
      facts({ agents: ["dolphin", "beaver"] }),
    );

    const { text: result } = await t.execute(
      { agent: "beaver", description: "实现任务", prompt: "task" },
      TOOL_CALL(),
    );

    assert.equal(calls.length, 1, "a selected subagent runs the driver");
    assert.equal(result, "done");
  });

  it("logs a target_role_blocked warn entry for a rejected target", async () => {
    const { driver } = fakeDriver({ kind: "ok", text: "done" });

    const t = tool(
      makeDeps({
        subagentDriver: driver,
        agentModes: { dolphin: "primary", beaver: "subagent", mola: "primary" },
      }),
    );

    await t.execute(
      { agent: "mola", description: "实现任务", prompt: "task" },
      TOOL_CALL(),
    );

    const blocked = _getBufferForTesting().filter(
      (e) => e.event === "target_role_blocked",
    );
    assert.equal(blocked.length, 1, "one target_role_blocked entry expected");
    assert.equal(blocked[0].target, "mola");
    assert.equal(blocked[0].reason, "not-a-subagent");
    assert.equal(blocked[0].level, "warn");
  });
});

// ---------------------------------------------------------------------------
// Caller resolution failures
// ---------------------------------------------------------------------------

describe("subagent tool execute — unresolved caller", () => {
  it("fails closed with a text result when no caller identity resolves", async () => {
    const { driver, calls } = fakeDriver({ kind: "ok", text: "done" });

    const t = tool(
      makeDeps({
        subagentDriver: driver,
        resolveCallerAgent: async () => undefined,
      }),
    );

    const { text: result } = await t.execute(
      { agent: "beaver", description: "实现任务", prompt: "task" },
      TOOL_CALL(),
    );

    assert.equal(calls.length, 0, "driver must not run without a caller");
    assert.ok(result.length > 0, "must return an explanatory text");
  });

  it("resolves the caller from the session the tool context names", async () => {
    const { driver } = fakeDriver({ kind: "ok", text: "done" });
    const asked: string[] = [];

    const t = tool(
      makeDeps({
        subagentDriver: driver,
        resolveCallerAgent: async (sessionID) => {
          asked.push(sessionID);
          return "beaver";
        },
      }),
    );

    await t.execute(
      { agent: "beaver", description: "实现任务", prompt: "task" },
      TOOL_CALL(),
    );

    assert.deepEqual(asked, ["sess-subagent"]);
  });
});

// ---------------------------------------------------------------------------
// Result mapping
// ---------------------------------------------------------------------------

describe("subagent tool execute — result mapping", () => {
  it("maps an ok result to the subagent text verbatim", async () => {
    const { driver } = fakeDriver({ kind: "ok", text: "result text" });
    const t = tool(makeDeps({ subagentDriver: driver }));
    assert.deepEqual(
      await t.execute(
        { agent: "beaver", description: "实现任务", prompt: "t" },
        TOOL_CALL(),
      ),
      { text: "result text" },
    );
  });

  it("maps an error result to the partial text plus a reason line", async () => {
    const { driver } = fakeDriver({
      kind: "error",
      text: "partial output",
      errorMessage: "session failed",
    });
    const t = tool(makeDeps({ subagentDriver: driver }));
    const { text: result } = await t.execute(
      { agent: "beaver", description: "实现任务", prompt: "t" },
      TOOL_CALL(),
    );

    assert.ok(
      result.includes("partial output"),
      `missing partial text: ${result}`,
    );
    assert.ok(
      result.includes("session failed"),
      `missing error message: ${result}`,
    );
  });

  it("maps an aborted result to the partial text plus a reason line", async () => {
    const { driver } = fakeDriver({ kind: "aborted", text: "partial output" });
    const t = tool(makeDeps({ subagentDriver: driver }));
    const { text: result } = await t.execute(
      { agent: "beaver", description: "实现任务", prompt: "t" },
      TOOL_CALL(),
    );

    assert.ok(
      result.includes("partial output"),
      `missing partial text: ${result}`,
    );
    assert.ok(result.includes("中止"), `missing abort reason: ${result}`);
  });
});

// ---------------------------------------------------------------------------
// Progress → registry updates
// ---------------------------------------------------------------------------

describe("subagent tool execute — progress to registry updates", () => {
  it("hands the run's fact log to the driver and patches progress from its report", async () => {
    // The driver appends the full facts to the log the tool hands over (the
    // registry run's own log) and reports the running token total it already
    // computed while appending them — the registry counter follows the
    // report, never a rescan of the log.
    const driver: SubagentDriver = {
      async run(_req, ctx) {
        assert.ok(
          ctx.log,
          "the tool must hand the run's fact log to the driver",
        );
        ctx.log?.appendToolStart("bash", { command: "npm test" }, 1, "tc-1");
        ctx.log?.appendToolEnd(
          "bash",
          [{ type: "text", text: "1 passed" }],
          false,
          2,
          "tc-1",
        );
        ctx.log?.appendMessage(
          [{ type: "text", text: "all green" }],
          { input: 100, output: 50, totalTokens: 150 },
          3,
        );
        ctx.onProgress?.({
          currentTool: "bash",
          done: false,
          tokens: 150,
        });
        assert.equal(runs.get("call-log")?.tokens, 150);
        ctx.log?.appendMessage(
          [{ type: "text", text: "done" }],
          { totalTokens: 84 },
          4,
        );
        ctx.onProgress?.({ done: false, tokens: 234 });
        // While the run is live its registry log holds the driver's facts.
        assert.equal(
          runs.get("call-log")?.log.size,
          4,
          "the live run's log must hold the appended facts",
        );
        return { kind: "ok", text: "done" };
      },
    };
    const t = tool(makeDeps({ subagentDriver: driver }));
    await t.execute(
      { agent: "beaver", description: "实现任务", prompt: "t" },
      TOOL_CALL({ callID: "call-log" }),
    );

    const run = runs.get("call-log");
    assert.ok(run);
    // Finishing the run releases its fact log (resident memory tracks active
    // work only; the durable copy lives in the persisted sub-session file).
    assert.equal(
      run?.log.size,
      0,
      "the terminal run must not hold the driver's facts",
    );
    // The token total the driver reported as it appended both messages.
    assert.equal(run?.tokens, 234);
    assert.equal(run?.currentTool, "bash");
  });

  it("takes the token total from the progress payload, not from the log", async () => {
    // Discriminating check for the rescan fix: the driver reports a token
    // total without appending any usage fact to the log.  A tool that still
    // derived counters from `run.log.facts()` would leave the run's tokens
    // undefined here.
    const driver: SubagentDriver = {
      async run(_req, ctx) {
        ctx.onProgress?.({ done: false, tokens: 4242 });
        assert.equal(runs.get("call-tokens")?.tokens, 4242);
        return { kind: "ok", text: "done" };
      },
    };
    const t = tool(makeDeps({ subagentDriver: driver }));
    await t.execute(
      { agent: "beaver", description: "实现任务", prompt: "t" },
      TOOL_CALL({ callID: "call-tokens" }),
    );
    assert.equal(runs.get("call-tokens")?.tokens, 4242);
    // The log stayed empty, so no scan of it could have produced the number.
    assert.equal(runs.get("call-tokens")?.log.size, 0);
  });

  it("leaves the run's token total absent when no report carried usage", async () => {
    // Parity check: a run that never reported usage keeps
    // the token segment absent rather than zeroed.
    const driver: SubagentDriver = {
      async run(_req, ctx) {
        ctx.onProgress?.({ done: false });
        ctx.onProgress?.({ done: true });
        return { kind: "ok", text: "done" };
      },
    };
    const t = tool(makeDeps({ subagentDriver: driver }));
    await t.execute(
      { agent: "beaver", description: "实现任务", prompt: "t" },
      TOOL_CALL({ callID: "call-notokens" }),
    );
    assert.equal(runs.get("call-notokens")?.tokens, undefined);
  });

  it("clears the run's currentTool when the driver reports no current tool", async () => {
    // `currentTool: null` is the driver's "this tool finished" signal; an
    // absent field means "unchanged".  The tool must forward the clear and
    // never mistake it for silence, so the card title cannot keep showing a
    // finished tool between calls.
    let toolAfterStart: string | null | undefined;
    let toolAfterUnrelated: string | null | undefined;
    let toolAfterClear: string | null | undefined;
    const driver: SubagentDriver = {
      async run(_req, ctx) {
        ctx.onProgress?.({ currentTool: "bash", done: false });
        toolAfterStart = runs.get("call-clear")?.currentTool;
        // A report with no currentTool field leaves the running tool alone.
        ctx.onProgress?.({ done: false });
        toolAfterUnrelated = runs.get("call-clear")?.currentTool;
        ctx.onProgress?.({ currentTool: null, done: false });
        toolAfterClear = runs.get("call-clear")?.currentTool;
        return { kind: "ok", text: "done" };
      },
    };
    const t = tool(makeDeps({ subagentDriver: driver }));
    await t.execute(
      { agent: "beaver", description: "实现任务", prompt: "t" },
      TOOL_CALL({ callID: "call-clear" }),
    );
    assert.equal(toolAfterStart, "bash");
    assert.equal(toolAfterUnrelated, "bash");
    assert.equal(toolAfterClear, undefined);
    assert.equal(runs.get("call-clear")?.currentTool, undefined);
  });

  it("asks for a card repaint on every progress report", async () => {
    const snapshots: SubagentProgress[] = [
      { currentTool: "bash", done: false },
      { done: false, tokens: 150 },
      { done: true },
    ];
    const driver: SubagentDriver = {
      async run(_req, ctx) {
        for (const snapshot of snapshots) ctx.onProgress?.(snapshot);
        return { kind: "ok", text: "done" };
      },
    };

    let repaints = 0;
    const t = tool(makeDeps({ subagentDriver: driver }));

    const { text: result } = await t.execute(
      { agent: "beaver", description: "实现任务", prompt: "t" },
      TOOL_CALL({
        notifyChanged: () => {
          repaints += 1;
        },
      }),
    );

    assert.equal(result, "done");
    // The card body projects the run's log, so a repaint carries no
    // payload at all.
    assert.equal(repaints, 3);
  });

  it("runs the driver without a live card (OpenCode path)", async () => {
    const { driver, calls } = fakeDriver({ kind: "ok", text: "done" });
    const t = tool(makeDeps({ subagentDriver: driver }));

    const { text: result } = await t.execute(
      { agent: "beaver", description: "实现任务", prompt: "t" },
      TOOL_CALL(),
    );

    assert.equal(result, "done");
    assert.equal(calls.length, 1, "driver must run without a live card");
  });
});

// ---------------------------------------------------------------------------
// Run-registry write lifecycle
// ---------------------------------------------------------------------------

describe("subagent tool execute — run-registry writes", () => {
  it("writes start/update/finish keyed by the forwarded tool-call id", async () => {
    const snapshots: SubagentProgress[] = [
      { currentTool: "bash", done: false },
      { done: true, sessionPath: "/tmp/s.jsonl" },
    ];
    const driver: SubagentDriver = {
      async run(_req, ctx) {
        for (const snapshot of snapshots) ctx.onProgress?.(snapshot);
        return { kind: "ok", text: "done" };
      },
    };
    const t = tool(makeDeps({ subagentDriver: driver }));
    const { text: result } = await t.execute(
      { agent: "beaver", description: "实现任务", prompt: "t" },
      // The host forwards its tool-call id on the call context.
      TOOL_CALL({ callID: "call-42" }),
    );
    assert.equal(result, "done");

    const run = runs.get("call-42");
    assert.ok(run, "the run must be registered under the call id");
    assert.equal(run?.agent, "beaver");
    assert.equal(run?.parentSession, "sess-subagent");
    assert.equal(run?.label, "实现任务");
    // The running snapshot's currentTool was patched via `runs.update`.
    assert.equal(run?.currentTool, "bash");
    // Terminal state: done with the session path captured from the last
    // snapshot.
    assert.equal(run?.status, "done");
    assert.equal(run?.sessionPath, "/tmp/s.jsonl");
    assert.ok(run?.endedAt !== undefined, "endedAt must be set");
  });

  it("patches sessionPath on the running run before it finishes", async () => {
    // The driver reads the registry synchronously right after its running
    // (done: false) snapshot is delivered — at that point the tool's
    // onProgress handler has already run but `runs.finish` has not, so the run
    // must be non-terminal AND already carry sessionPath for enter-inspect.
    // Primitive fields are captured at probe time because the registry
    // mutates the live run object in place on `runs.finish`.
    let statusDuring: string | undefined;
    let sessionPathDuring: string | undefined;
    const driver: SubagentDriver = {
      async run(_req, ctx) {
        ctx.onProgress?.({
          currentTool: "bash",
          done: false,
          sessionPath: "/tmp/running-session.jsonl",
        });
        statusDuring = runs.get("call-running")?.status;
        sessionPathDuring = runs.get("call-running")?.sessionPath;
        return { kind: "ok", text: "done" };
      },
    };
    const t = tool(makeDeps({ subagentDriver: driver }));
    await t.execute(
      { agent: "beaver", description: "实现任务", prompt: "t" },
      TOOL_CALL({ callID: "call-running" }),
    );
    assert.equal(
      statusDuring,
      "running",
      "the probe must observe the run while it is still running",
    );
    assert.equal(
      sessionPathDuring,
      "/tmp/running-session.jsonl",
      "the running run must already carry sessionPath for enter-inspect",
    );
  });

  it("maps error and aborted outcomes onto the terminal status", async () => {
    const okT = tool(
      makeDeps({
        subagentDriver: {
          async run() {
            return { kind: "error", text: "partial", errorMessage: "boom" };
          },
        },
      }),
    );
    await okT.execute(
      { agent: "beaver", description: "实现任务", prompt: "t" },
      TOOL_CALL({ callID: "call-e" }),
    );
    assert.equal(runs.get("call-e")?.status, "error");
    assert.equal(runs.get("call-e")?.error, "boom");

    const abortT = tool(
      makeDeps({
        subagentDriver: {
          async run() {
            return { kind: "aborted", text: "partial" };
          },
        },
      }),
    );
    await abortT.execute(
      { agent: "beaver", description: "实现任务", prompt: "t" },
      TOOL_CALL({ callID: "call-a" }),
    );
    assert.equal(runs.get("call-a")?.status, "aborted");
  });

  it("records the child session so nested runs associate through it", async () => {
    const driver: SubagentDriver = {
      async run(_req, ctx) {
        ctx.onProgress?.({
          childSession: "child-ses-1",
          done: false,
        });
        return { kind: "ok", text: "done" };
      },
    };
    const t = tool(makeDeps({ subagentDriver: driver }));
    await t.execute(
      { agent: "beaver", description: "实现任务", prompt: "t" },
      TOOL_CALL({ callID: "call-p" }),
    );
    assert.equal(runs.get("call-p")?.childSession, "child-ses-1");

    // A nested delegation inside the beaver sub-session carries that child
    // session as its own parentSession (topLevel under the main session
    // therefore excludes it).  lynx must be declared a subagent the profile
    // selects.
    const nestedT = tool(
      makeDeps({
        subagentDriver: driver,
        agentModes: {
          beaver: "subagent",
          lynx: "subagent",
          dolphin: "primary",
        },
        subagentModels: {
          beaver: "Dummy/dummy-small",
          lynx: "Dummy/dummy-small",
        },
      }),
      facts({ agents: ["dolphin", "beaver", "lynx"] }),
    );
    await nestedT.execute(
      { agent: "lynx", description: "调研", prompt: "t" },
      TOOL_CALL({ sessionID: "child-ses-1", callID: "call-c" }),
    );
    assert.equal(runs.get("call-c")?.parentSession, "child-ses-1");
    assert.deepEqual(
      runs.topLevel("sess-subagent").map((r) => r.id),
      ["call-p"],
      "the nested run must not appear under the main session",
    );
  });

  it("assigns a unique ASCII synthetic run id per delegation when no call id is forwarded", async () => {
    const t = tool(
      makeDeps({
        subagentDriver: {
          async run() {
            return { kind: "ok", text: "done" };
          },
        },
      }),
    );
    // Two delegations without a forwarded tool-call id (the OpenCode / test
    // path) must get DISTINCT synthetic ids — the previous scheme stamped
    // `Date.now()` (colliding within the same millisecond) with a non-ASCII
    // `→` arrow.
    await t.execute(
      { agent: "beaver", description: "任务一", prompt: "t" },
      TOOL_CALL(),
    );
    await t.execute(
      { agent: "beaver", description: "任务二", prompt: "t" },
      TOOL_CALL(),
    );
    const registered = runs.topLevel("sess-subagent");
    assert.equal(
      registered.length,
      2,
      "both synthetic runs must be registered",
    );
    assert.notEqual(
      registered[0]?.id,
      registered[1]?.id,
      "consecutive synthetic run ids must never collide",
    );
    for (const run of registered) {
      assert.ok(
        /^[ -~]+$/.test(run.id),
        `synthetic id must stay ASCII: ${run.id}`,
      );
      assert.ok(
        run.id.includes("beaver"),
        `id must carry the agent: ${run.id}`,
      );
    }
  });

  it("commits the final progress batch with the finish event", async () => {
    // The terminal report carries the run's last facts (tokens, model, the
    // sub-session pointers).  They belong to the finish write: a subscriber
    // must never see them on a still-running run, because no consumer needs
    // that intermediate state.
    const driver: SubagentDriver = {
      async run(_req, ctx) {
        ctx.onProgress?.({ currentTool: "bash", done: false });
        ctx.onProgress?.({
          done: true,
          tokens: 4321,
          model: "dummy-large",
          childSession: "child-ses-9",
          sessionPath: "/tmp/child-ses-9.jsonl",
        });
        return { kind: "ok", text: "done" };
      },
    };
    const events: Array<{ runId: string; parentSession: string }> = [];
    const snapshots: Array<Record<string, unknown>> = [];
    const off = runs.subscribe((change) => {
      events.push(change);
      const run = runs.get(change.runId);
      snapshots.push({
        status: run?.status,
        tokens: run?.tokens,
        model: run?.model,
        childSession: run?.childSession,
        sessionPath: run?.sessionPath,
      });
    });
    const t = tool(makeDeps({ subagentDriver: driver }));
    await t.execute(
      { agent: "beaver", description: "实现任务", prompt: "t" },
      TOOL_CALL({ callID: "call-atomic" }),
    );
    off();

    assert.equal(
      events.length,
      3,
      "start + one ordinary progress update + one finish",
    );
    assert.deepEqual(events.at(-1), {
      runId: "call-atomic",
      parentSession: "sess-subagent",
    });
    for (const snapshot of snapshots.slice(0, -1)) {
      assert.equal(snapshot.tokens, undefined, "no pre-finish token event");
      assert.equal(snapshot.model, undefined, "no pre-finish model event");
      assert.equal(
        snapshot.sessionPath,
        undefined,
        "no pre-finish session-path event",
      );
    }
    assert.deepEqual(snapshots.at(-1), {
      status: "done",
      tokens: 4321,
      model: "dummy-large",
      childSession: "child-ses-9",
      sessionPath: "/tmp/child-ses-9.jsonl",
    });
  });
});
