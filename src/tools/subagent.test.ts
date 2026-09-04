/**
 * Tests for the subagent delegation tool unit (`src/tools/subagent.ts`).
 *
 * Covers the full delegation flow of the contributed tool's `execute`:
 * resolving the CALLER identity, allowlist judgment (a blocked delegation
 * returns a reason text and never throws), capability-set computation for
 * the TARGET agent (baseline minus the target's config.toml tool-level
 * denies, fail-closed on a missing baseline), the `runSubagent` request
 * shape (agent / task / tools / parentSession), the `SubagentResult`
 * → tool-text mapping (ok → text verbatim; failure variants → text plus a
 * short reason line), and the run-registry write lifecycle (start /
 * update / finish with the forwarded tool-call id and the nested
 * parent-session pointer).  Also covers the fail-closed registration gate:
 * with no `subagentDriver` in deps the unit contributes zero tools.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { ToolHost } from "../core/client/tool-host.js";
import type { Deps } from "../core/slots.js";
import type {
  SubagentDriver,
  SubagentProgress,
  SubagentRequest,
  SubagentResult,
} from "../core/subagent/driver.js";
import {
  _resetForTesting as _resetIdentityForTesting,
  setPrimary,
} from "../core/subagent/identity.js";
import {
  getRun,
  resetRegistry,
  topLevelRuns,
} from "../core/subagent/registry.js";
import {
  _getBufferForTesting,
  _resetForTesting as _resetLoggerForTesting,
} from "../utils/logger.js";
import { unit } from "./subagent.js";

// The identity and registry cores are process-global (bun shares one isolate
// across every test file), so reset them between tests to keep the
// caller-resolution and registry-write assertions deterministic.
beforeEach(() => {
  _resetIdentityForTesting();
  resetRegistry();
});

afterEach(() => {
  _resetIdentityForTesting();
  resetRegistry();
  _resetLoggerForTesting();
});

/** A tool context carrying a session id and an abort signal. */
const TOOL_CTX = {
  sessionID: "sess-subagent",
  abort: new AbortController().signal,
};

/** A minimal ToolHost that reads the session id from the tool context. */
const TOOL_HOST: ToolHost = {
  resolveSessionId(toolCtx: unknown): string | undefined {
    const ctx = toolCtx as { sessionID?: unknown; sessionId?: unknown };
    const id = ctx.sessionID ?? ctx.sessionId;
    return typeof id === "string" && id.length > 0 ? id : undefined;
  },
  async fetchHistory(): Promise<never[]> {
    return [];
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

/** Build a `create`-compatible Deps with the given overrides. */
function makeDeps(overrides: Partial<Deps> = {}): Deps {
  return {
    limits: {},
    contextConfig: {},
    // The target-role guard reads the parsed agent modes; the default
    // fixture declares beaver as a delegatable subagent so the existing
    // happy-path cases keep running the driver.
    agentModes: { beaver: "subagent", dolphin: "primary" },
    // Strict model mode: agents.json is the sole model source, so the
    // default fixture configures beaver (the usual delegation target) to
    // keep the happy-path cases running the driver.
    subagentModels: { beaver: "Dummy/dummy-small" },
    client: {},
    directory: "/tmp/zoo",
    resolveAgent: () => undefined,
    toolHost: TOOL_HOST,
    ...overrides,
  };
}

/** The contributed subagent tool for a set of deps. */
function tool(deps: Deps) {
  const contributions = unit.create(deps, {
    agents: new Set(),
    skills: new Set(),
    hooks: new Set(),
    tools: new Set(),
    commands: new Set(),
  });
  assert.equal(contributions.kind, "tool");
  assert.equal(contributions.tools.length, 1, "exactly one tool contributed");
  return contributions.tools[0];
}

// ---------------------------------------------------------------------------
// Fail-closed registration
// ---------------------------------------------------------------------------

describe("subagent tool unit — fail-closed registration", () => {
  it("contributes zero tools when no subagentDriver is in deps (OpenCode)", () => {
    const contributions = unit.create(makeDeps(), {
      agents: new Set(),
      skills: new Set(),
      hooks: new Set(),
      tools: new Set(),
      commands: new Set(),
    });
    assert.equal(contributions.kind, "tool");
    assert.deepEqual(contributions.tools, []);
  });
});

// ---------------------------------------------------------------------------
// Argument validation
// ---------------------------------------------------------------------------

describe("subagent tool execute — argument validation", () => {
  it("rejects missing description and never runs the driver", async () => {
    const { driver, calls } = fakeDriver({ kind: "ok", text: "done" });
    setPrimary("dolphin");
    const t = tool(makeDeps({ subagentDriver: driver }));

    await assert.rejects(
      async () =>
        t.execute({ agent: "beaver", prompt: "t" } as never, TOOL_CTX),
      /description/,
    );
    assert.equal(calls.length, 0, "driver must not run for invalid args");
  });

  it("rejects an empty description and never runs the driver", async () => {
    const { driver, calls } = fakeDriver({ kind: "ok", text: "done" });
    setPrimary("dolphin");
    const t = tool(makeDeps({ subagentDriver: driver }));

    await assert.rejects(
      async () =>
        t.execute(
          { agent: "beaver", description: "", prompt: "t" } as never,
          TOOL_CTX,
        ),
      /description/,
    );
    assert.equal(calls.length, 0, "driver must not run for invalid args");
  });

  it("rejects missing prompt and never runs the driver", async () => {
    const { driver, calls } = fakeDriver({ kind: "ok", text: "done" });
    setPrimary("dolphin");
    const t = tool(makeDeps({ subagentDriver: driver }));

    await assert.rejects(
      async () =>
        t.execute(
          { agent: "beaver", description: "实现任务" } as never,
          TOOL_CTX,
        ),
      /prompt/,
    );
    assert.equal(calls.length, 0, "driver must not run for invalid args");
  });

  it("rejects an empty prompt and never runs the driver", async () => {
    const { driver, calls } = fakeDriver({ kind: "ok", text: "done" });
    setPrimary("dolphin");
    const t = tool(makeDeps({ subagentDriver: driver }));

    await assert.rejects(
      async () =>
        t.execute(
          { agent: "beaver", description: "实现任务", prompt: "" } as never,
          TOOL_CTX,
        ),
      /prompt/,
    );
    assert.equal(calls.length, 0, "driver must not run for invalid args");
  });

  it("rejects non-object arguments and never runs the driver", async () => {
    const { driver, calls } = fakeDriver({ kind: "ok", text: "done" });
    setPrimary("dolphin");
    const t = tool(makeDeps({ subagentDriver: driver }));

    await assert.rejects(
      async () => t.execute(null as never, TOOL_CTX),
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
    setPrimary("dolphin");

    const t = tool(
      makeDeps({
        subagentDriver: driver,
        subagentBaseline: ["bash", "edit", "webfetch", "websearch"],
        agentPermissions: { beaver: ["webfetch", "websearch"] },
      }),
    );

    const result = await t.execute(
      {
        agent: "beaver",
        description: "实现功能",
        prompt: "Implement the feature",
      },
      TOOL_CTX,
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
    setPrimary("dolphin");

    const t = tool(
      makeDeps({
        subagentDriver: driver,
        subagentBaseline: ["edit", "webfetch", "bash", "subagent"],
        agentPermissions: { beaver: ["webfetch", "websearch"] },
      }),
    );

    await t.execute(
      { agent: "beaver", description: "实现任务", prompt: "task" },
      TOOL_CTX,
    );

    assert.deepEqual(calls[0].request.tools, ["bash", "edit", "subagent"]);
  });

  it("proceeds with an empty capability set when the baseline is missing (fail-closed)", async () => {
    const { driver, calls } = fakeDriver({ kind: "ok", text: "done" });
    setPrimary("dolphin");

    const t = tool(
      makeDeps({
        subagentDriver: driver,
        agentPermissions: { beaver: ["webfetch"] },
      }),
    );

    await t.execute(
      { agent: "beaver", description: "实现任务", prompt: "task" },
      TOOL_CTX,
    );

    // No baseline → computeCapabilitySet yields [] — the run still happens,
    // but the driver receives no invented permissions.
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].request.tools, []);
  });

  it("drops the parentSession when the tool context has no session id", async () => {
    const { driver, calls } = fakeDriver({ kind: "ok", text: "done" });
    setPrimary("dolphin");

    const t = tool(makeDeps({ subagentDriver: driver }));
    await t.execute(
      { agent: "beaver", description: "实现任务", prompt: "task" },
      { abort: TOOL_CTX.abort },
    );

    assert.equal(calls[0].request.parentSession, undefined);
  });

  it("forwards the host signal from the third hostCtx argument", async () => {
    setPrimary("dolphin");

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
      TOOL_CTX,
      {
        signal: hostController.signal,
      },
    );
    // Let the run reach the hanging driver, then abort the host signal.
    await new Promise((resolve) => setTimeout(resolve, 20));
    hostController.abort();
    release?.();
    await runPromise;

    assert.ok(observedSignal, "driver must observe a signal");
    assert.equal(observedSignal?.aborted, true);
  });

  it("uses the agents.json configured model (the sole source in strict mode)", async () => {
    const { driver, calls } = fakeDriver({ kind: "ok", text: "done" });
    setPrimary("dolphin");

    const t = tool(
      makeDeps({
        subagentDriver: driver,
        subagentModels: { beaver: "Dummy/dummy-large" },
      }),
    );
    await t.execute(
      { agent: "beaver", description: "实现任务", prompt: "task" },
      TOOL_CTX,
      // Strict mode ignores the parent model entirely — a host-forwarded
      // model must NOT leak into the request.  The hostCtx type no longer
      // exposes `model`, so the cast models a stale host that still sends
      // it.
      { model: "Dummy/dummy-small" } as never,
    );

    assert.equal(calls[0].request.model, "Dummy/dummy-large");
  });

  it('passes a concatenated "provider/model" value through to the request (registry-prefixed id)', async () => {
    const { driver, calls } = fakeDriver({ kind: "ok", text: "done" });
    setPrimary("dolphin");

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
      TOOL_CTX,
    );

    assert.equal(calls[0].request.model, "Dummy/dummy/prefixed-id");
  });

  it("reports an actionable error when agents.json has no entry for the target", async () => {
    const { driver, calls } = fakeDriver({ kind: "ok", text: "done" });
    setPrimary("dolphin");

    // The map exists but lacks the target agent.
    const t = tool(
      makeDeps({
        subagentDriver: driver,
        subagentModels: { lynx: "Dummy/dummy-large" },
      }),
    );
    const result = await t.execute(
      { agent: "beaver", description: "实现任务", prompt: "task" },
      TOOL_CTX,
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
    setPrimary("dolphin");

    // No subagentModels → the loader failed closed to an empty map.
    const t = tool(
      makeDeps({ subagentDriver: driver, subagentModels: undefined }),
    );
    const result = await t.execute(
      { agent: "beaver", description: "实现任务", prompt: "task" },
      TOOL_CTX,
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
    setPrimary("dolphin");

    const t = tool(
      makeDeps({
        subagentDriver: driver,
        subagentModels: { beaver: "Dummy/dummy-large" },
      }),
    );
    await t.execute(
      { agent: "beaver", description: "实现任务", prompt: "task" },
      TOOL_CTX,
    );

    assert.equal(calls[0].request.model, "Dummy/dummy-large");
  });

  it("ignores a hostCtx model when agents.json has no entry for the target (no inheritance)", async () => {
    const { driver, calls } = fakeDriver({ kind: "ok", text: "done" });
    setPrimary("dolphin");

    // No entry for beaver + a parent model in hostCtx: strict mode must
    // NOT fall back to the parent — it errors instead.
    const t = tool(
      makeDeps({
        subagentDriver: driver,
        subagentModels: { lynx: "Dummy/dummy-large" },
      }),
    );
    const result = await t.execute(
      { agent: "beaver", description: "实现任务", prompt: "task" },
      TOOL_CTX,
      // A stale host forwarding a parent model — strict mode must ignore it
      // (the type no longer exposes `model`, so the cast models it).
      { model: "Dummy/dummy-small" } as never,
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
// Allowlist rejection
// ---------------------------------------------------------------------------

describe("subagent tool execute — allowlist rejection", () => {
  it("beaver → eagle is rejected with a reason text and the driver never runs", async () => {
    const { driver, calls } = fakeDriver({ kind: "ok", text: "done" });
    setPrimary("beaver");

    const t = tool(makeDeps({ subagentDriver: driver }));

    const result = await t.execute(
      { agent: "eagle", description: "查找缺陷", prompt: "Find the bug" },
      TOOL_CTX,
    );

    // A blocked delegation must return a tool-level text explaining WHY,
    // never throw and never invoke the driver.
    assert.equal(
      calls.length,
      0,
      "driver must not run for a blocked delegation",
    );
    assert.ok(
      result.includes("can only delegate to"),
      `reason missing: ${result}`,
    );
    assert.ok(result.includes("not allowed"), `reason missing: ${result}`);
    assert.ok(
      result.includes("eagle"),
      `reason must name the target: ${result}`,
    );
  });
});

// ---------------------------------------------------------------------------
// Target-role guard (fail-closed on non-subagent targets)
// ---------------------------------------------------------------------------

describe("subagent tool execute — target-role guard", () => {
  it('rejects a target declared mode = "primary" with a reason text and never runs the driver', async () => {
    const { driver, calls } = fakeDriver({ kind: "ok", text: "done" });
    setPrimary("dolphin");

    const t = tool(
      makeDeps({
        subagentDriver: driver,
        agentModes: { dolphin: "primary", beaver: "subagent", mola: "primary" },
      }),
    );

    const result = await t.execute(
      { agent: "mola", description: "实现任务", prompt: "task" },
      TOOL_CTX,
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
    setPrimary("dolphin");

    const t = tool(
      makeDeps({
        subagentDriver: driver,
        agentModes: { dolphin: "primary", beaver: "subagent" },
      }),
    );

    const result = await t.execute(
      { agent: "nonexistent", description: "实现任务", prompt: "task" },
      TOOL_CTX,
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
    setPrimary("dolphin");

    // No agentModes in deps → no target can be verified as a subagent.
    const t = tool(makeDeps({ subagentDriver: driver, agentModes: undefined }));

    const result = await t.execute(
      { agent: "beaver", description: "实现任务", prompt: "task" },
      TOOL_CTX,
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

  it("logs a delegation_blocked warn entry for a rejected target", async () => {
    const { driver } = fakeDriver({ kind: "ok", text: "done" });
    setPrimary("dolphin");

    const t = tool(
      makeDeps({
        subagentDriver: driver,
        agentModes: { dolphin: "primary", beaver: "subagent", mola: "primary" },
      }),
    );

    await t.execute(
      { agent: "mola", description: "实现任务", prompt: "task" },
      TOOL_CTX,
    );

    const blocked = _getBufferForTesting().filter(
      (e) => e.event === "delegation_blocked",
    );
    assert.equal(blocked.length, 1, "one delegation_blocked entry expected");
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
    // No setPrimary → resolveIdentity() is undefined (fail-closed).

    const t = tool(makeDeps({ subagentDriver: driver }));

    const result = await t.execute(
      { agent: "beaver", description: "实现任务", prompt: "task" },
      TOOL_CTX,
    );

    assert.equal(calls.length, 0, "driver must not run without a caller");
    assert.ok(result.length > 0, "must return an explanatory text");
  });
});

// ---------------------------------------------------------------------------
// Result mapping
// ---------------------------------------------------------------------------

describe("subagent tool execute — result mapping", () => {
  it("maps an ok result to the subagent text verbatim", async () => {
    const { driver } = fakeDriver({ kind: "ok", text: "result text" });
    setPrimary("dolphin");
    const t = tool(makeDeps({ subagentDriver: driver }));
    assert.equal(
      await t.execute(
        { agent: "beaver", description: "实现任务", prompt: "t" },
        TOOL_CTX,
      ),
      "result text",
    );
  });

  it("maps an error result to the partial text plus a reason line", async () => {
    const { driver } = fakeDriver({
      kind: "error",
      text: "partial output",
      errorMessage: "session failed",
    });
    setPrimary("dolphin");
    const t = tool(makeDeps({ subagentDriver: driver }));
    const result = await t.execute(
      { agent: "beaver", description: "实现任务", prompt: "t" },
      TOOL_CTX,
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
    setPrimary("dolphin");
    const t = tool(makeDeps({ subagentDriver: driver }));
    const result = await t.execute(
      { agent: "beaver", description: "实现任务", prompt: "t" },
      TOOL_CTX,
    );

    assert.ok(
      result.includes("partial output"),
      `missing partial text: ${result}`,
    );
    assert.ok(result.includes("中止"), `missing abort reason: ${result}`);
  });
});

// ---------------------------------------------------------------------------
// Progress → onUpdate bridge
// ---------------------------------------------------------------------------

describe("subagent tool execute — progress bridge to onUpdate", () => {
  it("streams the compact progress line into a pi onUpdate partial result", async () => {
    setPrimary("dolphin");
    // A driver that reports progress through its onProgress callback.
    const snapshots: SubagentProgress[] = [
      { currentTool: "bash", output: "", done: false },
      { currentTool: "bash", output: "running", done: false },
      { output: "finished", done: true },
    ];
    const driver: SubagentDriver = {
      async run(_req, ctx) {
        for (const snapshot of snapshots) ctx.onProgress?.(snapshot);
        return { kind: "ok", text: "done" };
      },
    };

    const partials: unknown[] = [];
    const t = tool(makeDeps({ subagentDriver: driver }));

    const result = await t.execute(
      { agent: "beaver", description: "实现任务", prompt: "t" },
      TOOL_CTX,
      {
        onUpdate: (partial: unknown) => {
          partials.push(partial);
        },
      },
    );

    assert.equal(result, "done");
    // Each report reaches onUpdate as a pi-style partial carrying ONLY the
    // compact one-line text (prefixed by the description label).  No
    // structured details ride along: pi never persists a partial's details,
    // and the facts views need live in the run's log.
    assert.equal(partials.length, 3);
    assert.deepEqual(partials[0], {
      content: [{ type: "text", text: "[实现任务] [bash] " }],
    });
    assert.deepEqual(partials[1], {
      content: [{ type: "text", text: "[实现任务] [bash] running" }],
    });
    assert.deepEqual(partials[2], {
      content: [{ type: "text", text: "[实现任务] finished" }],
    });
    assert.equal(
      Object.keys(partials[0] as Record<string, unknown>).join(","),
      "content",
      "the partial must carry no details payload",
    );
  });

  it("hands the run's fact log to the driver and patches progress from its report", async () => {
    setPrimary("dolphin");
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
          output: "all green",
          done: false,
          tokens: 150,
        });
        assert.equal(getRun("call-log")?.tokens, 150);
        ctx.log?.appendMessage(
          [{ type: "text", text: "done" }],
          { totalTokens: 84 },
          4,
        );
        ctx.onProgress?.({ output: "done", done: false, tokens: 234 });
        return { kind: "ok", text: "done" };
      },
    };
    const t = tool(makeDeps({ subagentDriver: driver }));
    await t.execute(
      { agent: "beaver", description: "实现任务", prompt: "t" },
      TOOL_CTX,
      { callId: "call-log" },
    );

    const run = getRun("call-log");
    assert.ok(run);
    // The facts the driver appended are the run's durable record.
    assert.equal(run?.log.size, 4);
    assert.equal(run?.log.facts()[0]?.type, "tool_start");
    // The token total the driver reported as it appended both messages.
    assert.equal(run?.tokens, 234);
    assert.equal(run?.currentTool, "bash");
  });

  it("takes the token total from the progress payload, not from the log", async () => {
    setPrimary("dolphin");
    // Discriminating check for the rescan fix: the driver reports a token
    // total without appending any usage fact to the log.  A tool that still
    // derived counters from `run.log.facts()` would leave the run's tokens
    // undefined here.
    const driver: SubagentDriver = {
      async run(_req, ctx) {
        ctx.onProgress?.({ output: "working", done: false, tokens: 4242 });
        assert.equal(getRun("call-tokens")?.tokens, 4242);
        return { kind: "ok", text: "done" };
      },
    };
    const t = tool(makeDeps({ subagentDriver: driver }));
    await t.execute(
      { agent: "beaver", description: "实现任务", prompt: "t" },
      TOOL_CTX,
      { callId: "call-tokens" },
    );
    assert.equal(getRun("call-tokens")?.tokens, 4242);
    // The log stayed empty, so no scan of it could have produced the number.
    assert.equal(getRun("call-tokens")?.log.size, 0);
  });

  it("leaves the run's token total absent when no report carried usage", async () => {
    setPrimary("dolphin");
    // Parity with the old derivation: a run that never reported usage keeps
    // the token segment absent rather than zeroed.
    const driver: SubagentDriver = {
      async run(_req, ctx) {
        ctx.onProgress?.({ output: "working", done: false });
        ctx.onProgress?.({ output: "done", done: true });
        return { kind: "ok", text: "done" };
      },
    };
    const t = tool(makeDeps({ subagentDriver: driver }));
    await t.execute(
      { agent: "beaver", description: "实现任务", prompt: "t" },
      TOOL_CTX,
      { callId: "call-notokens" },
    );
    assert.equal(getRun("call-notokens")?.tokens, undefined);
  });

  it("clears the run's currentTool when the driver reports no current tool", async () => {
    setPrimary("dolphin");
    // `currentTool: null` is the driver's "this tool finished" signal; an
    // absent field means "unchanged".  The tool must forward the clear and
    // never mistake it for silence, so the card title cannot keep showing a
    // finished tool between calls.
    let toolAfterStart: string | null | undefined;
    let toolAfterUnrelated: string | null | undefined;
    let toolAfterClear: string | null | undefined;
    const driver: SubagentDriver = {
      async run(_req, ctx) {
        ctx.onProgress?.({ currentTool: "bash", output: "", done: false });
        toolAfterStart = getRun("call-clear")?.currentTool;
        // A report with no currentTool field leaves the running tool alone.
        ctx.onProgress?.({ output: "still running", done: false });
        toolAfterUnrelated = getRun("call-clear")?.currentTool;
        ctx.onProgress?.({ currentTool: null, output: "", done: false });
        toolAfterClear = getRun("call-clear")?.currentTool;
        return { kind: "ok", text: "done" };
      },
    };
    const t = tool(makeDeps({ subagentDriver: driver }));
    await t.execute(
      { agent: "beaver", description: "实现任务", prompt: "t" },
      TOOL_CTX,
      { callId: "call-clear" },
    );
    assert.equal(toolAfterStart, "bash");
    assert.equal(toolAfterUnrelated, "bash");
    assert.equal(toolAfterClear, undefined);
    assert.equal(getRun("call-clear")?.currentTool, undefined);
  });

  it("runs without a log when the caller has no parent session", async () => {
    setPrimary("dolphin");
    let sawLog: unknown = "unset";
    const driver: SubagentDriver = {
      async run(_req, ctx) {
        sawLog = ctx.log;
        return { kind: "ok", text: "done" };
      },
    };
    const t = tool(makeDeps({ subagentDriver: driver }));
    // No session id in the tool context: no registry run, so no log to hand
    // over — the driver must still run.
    await t.execute(
      { agent: "beaver", description: "实现任务", prompt: "t" },
      { abort: new AbortController().signal },
      { callId: "call-nolog" },
    );
    assert.equal(sawLog, undefined);
    assert.equal(getRun("call-nolog"), undefined);
  });

  it("proceeds without streaming when no onUpdate is present (OpenCode path)", async () => {
    setPrimary("dolphin");
    const { driver, calls } = fakeDriver({ kind: "ok", text: "done" });
    const t = tool(makeDeps({ subagentDriver: driver }));

    const result = await t.execute(
      { agent: "beaver", description: "实现任务", prompt: "t" },
      TOOL_CTX,
    );

    assert.equal(result, "done");
    assert.equal(calls.length, 1, "driver must run even without onUpdate");
  });

  it("does not fail the run when onUpdate throws", async () => {
    setPrimary("dolphin");
    const driver: SubagentDriver = {
      async run(_req, ctx) {
        ctx.onProgress?.({
          currentTool: "bash",
          output: "working",
          done: false,
        });
        ctx.onProgress?.({ output: "done", done: true });
        return { kind: "ok", text: "done" };
      },
    };

    const t = tool(makeDeps({ subagentDriver: driver }));
    let threw = 0;
    const result = await t.execute(
      { agent: "beaver", description: "实现任务", prompt: "t" },
      TOOL_CTX,
      {
        onUpdate: () => {
          threw += 1;
          throw new Error("ui exploded");
        },
      },
    );

    assert.equal(threw, 2, "onUpdate must be invoked for each snapshot");
    assert.equal(result, "done", "a throwing onUpdate must not break the run");
  });

  it("attaches renderCall / renderResult when a renderer is present (pi)", () => {
    setPrimary("dolphin");
    const renderCall = () => ({ kind: "call" });
    const renderResult = () => ({ kind: "result" });
    const t = tool(
      makeDeps({
        subagentDriver: {
          async run() {
            return { kind: "ok", text: "done" };
          },
        },
        subagentRenderer: { renderCall, renderResult },
      }),
    );
    assert.equal(t.renderCall, renderCall);
    assert.equal(t.renderResult, renderResult);
  });

  it("keeps the tool text-only when no renderer is present (OpenCode)", () => {
    setPrimary("dolphin");
    const t = tool(
      makeDeps({
        subagentDriver: {
          async run() {
            return { kind: "ok", text: "done" };
          },
        },
      }),
    );
    assert.equal(t.renderCall, undefined);
    assert.equal(t.renderResult, undefined);
  });
});

// ---------------------------------------------------------------------------
// Run-registry write lifecycle
// ---------------------------------------------------------------------------

describe("subagent tool execute — run-registry writes", () => {
  it("writes start/update/finish keyed by the forwarded tool-call id", async () => {
    setPrimary("dolphin");
    const snapshots: SubagentProgress[] = [
      { currentTool: "bash", output: "", done: false },
      { output: "finished", done: true, sessionPath: "/tmp/s.jsonl" },
    ];
    const driver: SubagentDriver = {
      async run(_req, ctx) {
        for (const snapshot of snapshots) ctx.onProgress?.(snapshot);
        return { kind: "ok", text: "done" };
      },
    };
    const t = tool(makeDeps({ subagentDriver: driver }));
    const result = await t.execute(
      { agent: "beaver", description: "实现任务", prompt: "t" },
      TOOL_CTX,
      // The pi bridge forwards the real tool-call id via hostCtx.callId.
      { callId: "call-42" },
    );
    assert.equal(result, "done");

    const run = getRun("call-42");
    assert.ok(run, "the run must be registered under the call id");
    assert.equal(run?.agent, "beaver");
    assert.equal(run?.parentSession, "sess-subagent");
    assert.equal(run?.label, "实现任务");
    // The running snapshot's currentTool was patched via updateRun.
    assert.equal(run?.currentTool, "bash");
    // Terminal state: done with the session path captured from the last
    // snapshot.
    assert.equal(run?.status, "done");
    assert.equal(run?.sessionPath, "/tmp/s.jsonl");
    assert.ok(run?.endedAt !== undefined, "endedAt must be set");
  });

  it("patches sessionPath on the running run before it finishes", async () => {
    setPrimary("dolphin");
    // The driver reads the registry synchronously right after its running
    // (done: false) snapshot is delivered — at that point the tool's
    // onProgress handler has already run but finishRun has not, so the run
    // must be non-terminal AND already carry sessionPath for enter-inspect.
    // Primitive fields are captured at probe time because the registry
    // mutates the live run object in place on finishRun.
    let statusDuring: string | undefined;
    let sessionPathDuring: string | undefined;
    const driver: SubagentDriver = {
      async run(_req, ctx) {
        ctx.onProgress?.({
          currentTool: "bash",
          output: "working",
          done: false,
          sessionPath: "/tmp/running-session.jsonl",
        });
        statusDuring = getRun("call-running")?.status;
        sessionPathDuring = getRun("call-running")?.sessionPath;
        return { kind: "ok", text: "done" };
      },
    };
    const t = tool(makeDeps({ subagentDriver: driver }));
    await t.execute(
      { agent: "beaver", description: "实现任务", prompt: "t" },
      TOOL_CTX,
      { callId: "call-running" },
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
    setPrimary("dolphin");
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
      TOOL_CTX,
      { callId: "call-e" },
    );
    assert.equal(getRun("call-e")?.status, "error");
    assert.equal(getRun("call-e")?.error, "boom");

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
      TOOL_CTX,
      { callId: "call-a" },
    );
    assert.equal(getRun("call-a")?.status, "aborted");
  });

  it("records the child session so nested runs associate through it", async () => {
    setPrimary("dolphin");
    const driver: SubagentDriver = {
      async run(_req, ctx) {
        ctx.onProgress?.({
          childSession: "child-ses-1",
          output: "",
          done: false,
        });
        return { kind: "ok", text: "done" };
      },
    };
    const t = tool(makeDeps({ subagentDriver: driver }));
    await t.execute(
      { agent: "beaver", description: "实现任务", prompt: "t" },
      TOOL_CTX,
      { callId: "call-p" },
    );
    assert.equal(getRun("call-p")?.childSession, "child-ses-1");

    // A nested delegation inside the beaver sub-session carries that child
    // session as its own parentSession (topLevelRuns under the main session
    // therefore excludes it).  lynx must be declared a valid subagent target.
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
    );
    await nestedT.execute(
      { agent: "lynx", description: "调研", prompt: "t" },
      { sessionID: "child-ses-1", abort: TOOL_CTX.abort },
      { callId: "call-c" },
    );
    assert.equal(getRun("call-c")?.parentSession, "child-ses-1");
    assert.deepEqual(
      topLevelRuns("sess-subagent").map((r) => r.id),
      ["call-p"],
      "the nested run must not appear under the main session",
    );
  });

  it("assigns a unique ASCII synthetic run id per delegation when no call id is forwarded", async () => {
    setPrimary("dolphin");
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
      TOOL_CTX,
    );
    await t.execute(
      { agent: "beaver", description: "任务二", prompt: "t" },
      TOOL_CTX,
    );
    const runs = topLevelRuns("sess-subagent");
    assert.equal(runs.length, 2, "both synthetic runs must be registered");
    assert.notEqual(
      runs[0]?.id,
      runs[1]?.id,
      "consecutive synthetic run ids must never collide",
    );
    for (const run of runs) {
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

  it("notifies onSubagentRunChange on start, update, and finish", async () => {
    setPrimary("dolphin");
    let notifications = 0;
    const driver: SubagentDriver = {
      async run(_req, ctx) {
        ctx.onProgress?.({
          currentTool: "bash",
          output: "",
          done: false,
        });
        return { kind: "ok", text: "done" };
      },
    };
    const t = tool(
      makeDeps({
        subagentDriver: driver,
        onSubagentRunChange: () => {
          notifications += 1;
        },
      }),
    );
    await t.execute(
      { agent: "beaver", description: "实现任务", prompt: "t" },
      TOOL_CTX,
      { callId: "call-n" },
    );
    // start + update (currentTool) + finish.
    assert.ok(
      notifications >= 3,
      `expected ≥3 notifications, got ${notifications}`,
    );
  });

  it("stays silent when no parent session id is available", async () => {
    setPrimary("dolphin");
    const t = tool(
      makeDeps({
        subagentDriver: {
          async run() {
            return { kind: "ok", text: "done" };
          },
        },
      }),
    );
    await t.execute(
      { agent: "beaver", description: "实现任务", prompt: "t" },
      { abort: TOOL_CTX.abort },
    );
    assert.equal(topLevelRuns("").length, 0, "no run without a parent session");
  });
});
