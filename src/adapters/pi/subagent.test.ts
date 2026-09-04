/**
 * Tests for the pi subagent driver (`src/adapters/pi/subagent.ts`).
 *
 * Covers the driver's contract with injected mock factories (never loading
 * the real pi SDK): the tool allowlist is forwarded to the session factory,
 * the parent abort signal triggers `session.abort()`, `session.dispose()`
 * always runs in `finally` (on ok, abort, error, and SDK throw), outcome
 * classification from the final assistant stop reason, and the collapse of
 * every SDK exception into an `error` result (no throw escapes).
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type {
  SubagentProgress,
  SubagentResult,
} from "../../core/subagent/driver.js";
import type {
  LogEvent,
  MessagePart,
  RunFact,
  RunLog,
} from "../../core/subagent/run-log.js";
import { createRunLog } from "../../core/subagent/run-log.js";
import { deriveCounters } from "../../core/subagent/view.js";
import {
  _resetForTesting as _resetLoggerForTesting,
  initLogger,
} from "../../utils/logger.js";
import {
  createPiSubagentDriver,
  type PiAgentSession,
  type PiCreateSessionOptions,
  type PiModelRuntimeLike,
  type PiResolvedModel,
  type PiSessionEvent,
  type PiSessionManager,
} from "./subagent.js";

afterEach(() => {
  _resetLoggerForTesting();
});

/** A mock pi message with the minimal fields the driver reads. */
function rawMessage(overrides: {
  role: string;
  text?: string;
  stopReason?: string;
  errorMessage?: string;
  isError?: boolean;
}): unknown {
  return {
    role: overrides.role,
    content: [{ type: "text", text: overrides.text ?? "" }],
    stopReason: overrides.stopReason,
    errorMessage: overrides.errorMessage,
    isError: overrides.isError,
  };
}

/**
 * A controllable mock pi session.
 *
 * `prompt` resolves immediately (pi's `prompt()` resolves on abort, never
 * rejects).  The `emitOnPrompt` events are delivered to the listener just
 * before `prompt` resolves, so tests drive the event stream from inside
 * the run.  `abort()` releases a hanging `prompt` and marks the run
 * aborted, modelling pi's abort → resolved prompt behaviour.
 */
function mockSession(): {
  session: PiAgentSession;
  aborts: number;
  prompts: string[];
  disposed: number;
  setPromptBehavior: (behavior: {
    kind: "resolves" | "hang" | "throw";
    message?: string;
    emitOnPrompt?: PiSessionEvent[];
  }) => void;
} {
  let listener: ((event: PiSessionEvent) => void) | undefined;
  let aborts = 0;
  const prompts: string[] = [];
  let disposed = 0;
  let promptBehavior: {
    kind: "resolves" | "hang" | "throw";
    message?: string;
    emitOnPrompt?: PiSessionEvent[];
  } = { kind: "resolves" };
  let releaseHang: (() => void) | undefined;

  const emit = (events: PiSessionEvent[] | undefined): void => {
    if (!events) return;
    for (const event of events) listener?.(event);
  };

  const session: PiAgentSession = {
    subscribe(l) {
      listener = l;
      return () => {
        listener = undefined;
      };
    },
    async prompt(text) {
      prompts.push(text);
      if (promptBehavior.kind === "hang") {
        await new Promise<void>((resolve) => {
          releaseHang = resolve;
        });
        emit(promptBehavior.emitOnPrompt);
        return;
      }
      if (promptBehavior.kind === "throw") {
        throw new Error(promptBehavior.message ?? "prompt threw");
      }
      emit(promptBehavior.emitOnPrompt);
    },
    abort() {
      aborts += 1;
      // pi's `prompt()` resolves (not rejects) once the run is aborted, so
      // release any hanging prompt.
      releaseHang?.();
    },
    dispose() {
      disposed += 1;
    },
  };

  return {
    session,
    get aborts() {
      return aborts;
    },
    get prompts() {
      return prompts;
    },
    get disposed() {
      return disposed;
    },
    setPromptBehavior(b) {
      promptBehavior = b;
    },
  };
}

/** A mock session manager with a fixed session id. */
function mockSessionManager(id = "child-session"): PiSessionManager {
  return { getSessionId: () => id };
}

/** Events completing a run with a normal assistant stop. */
function okEvents(text = "ok"): PiSessionEvent[] {
  return [
    {
      type: "message_end",
      message: rawMessage({ role: "user", text: "task" }),
    },
    {
      type: "message_end",
      message: rawMessage({ role: "assistant", text, stopReason: "stop" }),
    },
    { type: "agent_end" },
  ];
}

/**
 * Build a driver wired to a controllable mock session.
 *
 * Returns the driver plus the harness to drive events and inspect the
 * factory arguments.
 */
function harness(options: { parentSession?: string; model?: string } = {}) {
  const s = mockSession();
  const factoryCalls: Array<PiCreateSessionOptions> = [];
  const managerCalls: Array<{ cwd: string; parent: string | undefined }> = [];

  const driver = createPiSubagentDriver({
    createSession: async (opts) => {
      factoryCalls.push(opts);
      return { session: s.session };
    },
    createSessionManager: async (cwd, parent) => {
      managerCalls.push({ cwd, parent });
      return mockSessionManager();
    },
    resolveModel: async (model) => {
      const modelRuntime: PiModelRuntimeLike = {
        getModel(provider, id) {
          return provider === "p" && id === "m" ? { provider, id } : undefined;
        },
      };
      if (model === "p/m") {
        const resolved: PiResolvedModel = {
          model: { provider: "p", id: "m" },
          modelRuntime,
        };
        return resolved;
      }
      return undefined;
    },
  });
  return { driver, s, factoryCalls, managerCalls };
}

// ---------------------------------------------------------------------------
// Factory wiring
// ---------------------------------------------------------------------------

describe("pi subagent driver — factory wiring", () => {
  it("forwards the tool allowlist to the session factory", async () => {
    const h = harness();
    h.s.setPromptBehavior({ kind: "resolves", emitOnPrompt: okEvents() });
    const result = await h.driver.run(
      {
        agent: "beaver",
        prompt: "do it",
        tools: ["bash", "edit"],
        model: "p/m",
      },
      { signal: new AbortController().signal },
    );
    assert.equal(result.kind, "ok");
    assert.equal(h.factoryCalls.length, 1);
    assert.deepEqual(h.factoryCalls[0].tools, ["bash", "edit"]);
  });

  it("creates the session manager with cwd and the parent-session pointer", async () => {
    const h = harness({ parentSession: "parent-1" });
    h.s.setPromptBehavior({ kind: "resolves", emitOnPrompt: okEvents() });
    await h.driver.run(
      {
        agent: "beaver",
        prompt: "do it",
        tools: [],
        model: "p/m",
        parentSession: "parent-1",
      },
      { signal: new AbortController().signal },
    );
    assert.equal(h.managerCalls.length, 1);
    assert.equal(h.managerCalls[0].cwd, process.cwd());
    assert.equal(h.managerCalls[0].parent, "parent-1");
  });

  it("passes the resolved model and runtime when the request carries one", async () => {
    const h = harness({ model: "p/m" });
    h.s.setPromptBehavior({ kind: "resolves", emitOnPrompt: okEvents() });
    await h.driver.run(
      { agent: "beaver", prompt: "t", tools: [], model: "p/m" },
      { signal: new AbortController().signal },
    );
    assert.deepEqual(h.factoryCalls[0].model, { provider: "p", id: "m" });
    assert.equal(typeof h.factoryCalls[0].modelRuntime?.getModel, "function");
  });

  it("splits a registry-prefixed concatenated model on the first slash", async () => {
    const s = mockSession();
    const factoryCalls: Array<PiCreateSessionOptions> = [];
    const driver = createPiSubagentDriver({
      createSession: async (opts) => {
        factoryCalls.push(opts);
        return { session: s.session };
      },
      createSessionManager: async () => mockSessionManager(),
      resolveModel: async (model) => {
        // The concatenated `"Dummy/dummy/prefixed-id"` must split on the
        // FIRST `/`: provider `Dummy`, id `dummy/prefixed-id` (the full pi
        // registry id, itself provider-prefixed).
        const slash = model.indexOf("/");
        const provider = model.slice(0, slash);
        const id = model.slice(slash + 1);
        const modelRuntime: PiModelRuntimeLike = {
          getModel(prov, modelId) {
            return prov === provider && modelId === id
              ? { provider: prov, id: modelId }
              : undefined;
          },
        };
        return model === "Dummy/dummy/prefixed-id"
          ? { model: { provider, id }, modelRuntime }
          : undefined;
      },
    });
    s.setPromptBehavior({ kind: "resolves", emitOnPrompt: okEvents() });
    await driver.run(
      {
        agent: "beaver",
        prompt: "t",
        tools: [],
        model: "Dummy/dummy/prefixed-id",
      },
      { signal: new AbortController().signal },
    );
    assert.equal(factoryCalls.length, 1);
    assert.deepEqual(factoryCalls[0].model, {
      provider: "Dummy",
      id: "dummy/prefixed-id",
    });
  });

  it("fails the run when the request model cannot be resolved (strict)", async () => {
    const h = harness({ model: "Dummy/dummy-small" });
    h.s.setPromptBehavior({ kind: "resolves", emitOnPrompt: okEvents() });
    const result = await h.driver.run(
      {
        agent: "beaver",
        prompt: "t",
        tools: [],
        model: "Dummy/dummy-small",
      },
      { signal: new AbortController().signal },
    );
    // Strict mode: an unresolvable configured model is an error — no
    // fallback to the sub-session default model.
    assert.equal(result.kind, "error");
    if (result.kind === "error") {
      assert.ok(
        result.errorMessage.includes("Dummy/dummy-small"),
        `error must name the configured model: ${result.errorMessage}`,
      );
      assert.ok(
        result.errorMessage.includes("解析失败"),
        `error must explain the resolution failure: ${result.errorMessage}`,
      );
    }
    assert.equal(
      h.factoryCalls.length,
      0,
      "no session factory call expected after a failed resolution",
    );
  });
});

// ---------------------------------------------------------------------------
// Prompt and outcome classification
// ---------------------------------------------------------------------------

describe("pi subagent driver — prompt and outcome classification", () => {
  it("calls prompt with the request prompt", async () => {
    const h = harness();
    h.s.setPromptBehavior({ kind: "resolves", emitOnPrompt: okEvents() });
    await h.driver.run(
      { agent: "beaver", prompt: "the task", tools: [], model: "p/m" },
      { signal: new AbortController().signal },
    );
    assert.equal(h.s.prompts.length, 1);
    assert.equal(h.s.prompts[0], "the task");
  });

  it("classifies a normal stop as ok with the reduced assistant text", async () => {
    const h = harness();
    h.s.setPromptBehavior({
      kind: "resolves",
      emitOnPrompt: okEvents("the answer"),
    });
    const result = await h.driver.run(
      { agent: "beaver", prompt: "t", tools: [], model: "p/m" },
      { signal: new AbortController().signal },
    );
    assert.deepEqual(result, { kind: "ok", text: "the answer" });
  });

  it("classifies an aborted stop reason as aborted", async () => {
    const h = harness();
    h.s.setPromptBehavior({
      kind: "resolves",
      emitOnPrompt: [
        {
          type: "message_end",
          message: rawMessage({
            role: "assistant",
            text: "partial",
            stopReason: "aborted",
          }),
        },
      ],
    });
    const result = await h.driver.run(
      { agent: "beaver", prompt: "t", tools: [], model: "p/m" },
      { signal: new AbortController().signal },
    );
    assert.deepEqual(result, { kind: "aborted", text: "partial" });
  });

  it("classifies an error stop reason as error with prior partial text", async () => {
    const h = harness();
    h.s.setPromptBehavior({
      kind: "resolves",
      emitOnPrompt: [
        {
          type: "message_end",
          message: rawMessage({
            role: "assistant",
            text: "partial",
            stopReason: "toolUse",
          }),
        },
        {
          type: "message_end",
          message: rawMessage({
            role: "assistant",
            text: "",
            stopReason: "error",
            errorMessage: "boom",
          }),
        },
      ],
    });
    const result = await h.driver.run(
      { agent: "beaver", prompt: "t", tools: [], model: "p/m" },
      { signal: new AbortController().signal },
    );
    assert.equal(result.kind, "error");
    if (result.kind === "error") {
      assert.equal(result.text, "partial");
      assert.equal(result.errorMessage, "subagent stopped with error");
    }
  });
});

// ---------------------------------------------------------------------------
// Abort wiring
// ---------------------------------------------------------------------------

describe("pi subagent driver — abort wiring", () => {
  it("parent abort triggers session.abort() and yields an aborted result", async () => {
    const h = harness();
    h.s.setPromptBehavior({ kind: "hang", emitOnPrompt: [] });
    const controller = new AbortController();
    const runPromise = h.driver.run(
      { agent: "beaver", prompt: "t", tools: [], model: "p/m" },
      { signal: controller.signal },
    );
    // Let the run reach the hanging prompt, then abort the parent signal.
    await new Promise((resolve) => setTimeout(resolve, 20));
    controller.abort();
    const result: SubagentResult = await runPromise;

    assert.equal(h.s.aborts, 1, "session.abort must be called once");
    assert.equal(result.kind, "aborted");
  });

  it("a pre-aborted signal skips the prompt and returns aborted", async () => {
    const h = harness();
    const controller = new AbortController();
    controller.abort();
    const result = await h.driver.run(
      { agent: "beaver", prompt: "t", tools: [], model: "p/m" },
      { signal: controller.signal },
    );
    assert.equal(h.s.prompts.length, 0, "prompt must be skipped");
    assert.equal(result.kind, "aborted");
  });

  it("removes the abort listener after the run completes", async () => {
    const h = harness();
    h.s.setPromptBehavior({ kind: "resolves", emitOnPrompt: okEvents() });
    const controller = new AbortController();
    await h.driver.run(
      { agent: "beaver", prompt: "t", tools: [], model: "p/m" },
      { signal: controller.signal },
    );
    // Aborting after completion must not re-abort the disposed session.
    controller.abort();
    assert.equal(h.s.aborts, 0);
  });
});

// ---------------------------------------------------------------------------
// dispose in finally
// ---------------------------------------------------------------------------

describe("pi subagent driver — dispose in finally", () => {
  it("disposes the session after an ok run", async () => {
    const h = harness();
    h.s.setPromptBehavior({ kind: "resolves", emitOnPrompt: okEvents() });
    await h.driver.run(
      { agent: "beaver", prompt: "t", tools: [], model: "p/m" },
      { signal: new AbortController().signal },
    );
    assert.equal(h.s.disposed, 1);
  });

  it("disposes the session after an aborted run", async () => {
    const h = harness();
    h.s.setPromptBehavior({ kind: "hang", emitOnPrompt: [] });
    const controller = new AbortController();
    const runPromise = h.driver.run(
      { agent: "beaver", prompt: "t", tools: [], model: "p/m" },
      { signal: controller.signal },
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    controller.abort();
    await runPromise;
    assert.equal(h.s.disposed, 1);
  });

  it("disposes the session after an SDK throw", async () => {
    const h = harness();
    h.s.setPromptBehavior({ kind: "throw", message: "prompt exploded" });
    const result = await h.driver.run(
      { agent: "beaver", prompt: "t", tools: [], model: "p/m" },
      { signal: new AbortController().signal },
    );
    assert.equal(result.kind, "error");
    assert.equal(h.s.disposed, 1);
  });
});

// ---------------------------------------------------------------------------
// SDK exception collapse
// ---------------------------------------------------------------------------

describe("pi subagent driver — SDK exception collapse", () => {
  it("collapses a session-factory throw into an error result", async () => {
    const driver = createPiSubagentDriver({
      createSession: async () => {
        throw new Error("create failed");
      },
      createSessionManager: async () => mockSessionManager(),
      resolveModel: async () => ({
        model: { provider: "p", id: "m" },
        modelRuntime: { getModel: () => ({ provider: "p", id: "m" }) },
      }),
    });
    const result = await driver.run(
      { agent: "beaver", prompt: "t", tools: [], model: "p/m" },
      { signal: new AbortController().signal },
    );
    assert.equal(result.kind, "error");
    if (result.kind === "error") {
      assert.ok(result.errorMessage.includes("create failed"));
    }
  });

  it("collapses a session-manager throw into an error result", async () => {
    const driver = createPiSubagentDriver({
      createSession: async () => {
        throw new Error("unexpected");
      },
      createSessionManager: async () => {
        throw new Error("manager failed");
      },
      resolveModel: async () => ({
        model: { provider: "p", id: "m" },
        modelRuntime: { getModel: () => ({ provider: "p", id: "m" }) },
      }),
    });
    const result = await driver.run(
      { agent: "beaver", prompt: "t", tools: [], model: "p/m" },
      { signal: new AbortController().signal },
    );
    assert.equal(result.kind, "error");
    if (result.kind === "error") {
      assert.ok(result.errorMessage.includes("manager failed"));
    }
  });

  it("collapses a prompt reject into an error result", async () => {
    const h = harness();
    h.s.setPromptBehavior({ kind: "throw", message: "prompt rejected" });
    const result = await h.driver.run(
      { agent: "beaver", prompt: "t", tools: [], model: "p/m" },
      { signal: new AbortController().signal },
    );
    assert.equal(result.kind, "error");
  });
});

// ---------------------------------------------------------------------------
// Progress reports
// ---------------------------------------------------------------------------

/**
 * Run a scripted event stream through the driver.
 *
 * Returns the progress reports the driver emitted, the run's fact log, and
 * the facts recorded in it — the two channels a caller observes.
 */
async function drive(
  h: ReturnType<typeof harness>,
  events: PiSessionEvent[],
  options: { log?: boolean } = {},
): Promise<{
  reports: SubagentProgress[];
  facts: ReturnType<RunLog["facts"]>;
  log: RunLog;
}> {
  const log = createRunLog();
  const reports: SubagentProgress[] = [];
  h.s.setPromptBehavior({ kind: "resolves", emitOnPrompt: events });
  await h.driver.run(
    { agent: "beaver", prompt: "t", tools: [], model: "p/m" },
    {
      signal: new AbortController().signal,
      onProgress: (progress) => reports.push(progress),
      ...(options.log === false ? {} : { log }),
    },
  );
  return { reports, facts: log.facts(), log };
}

describe("pi subagent driver — progress reports", () => {
  it("streams tool and done reports through onProgress", async () => {
    const h = harness();
    const { reports } = await drive(h, [
      { type: "tool_execution_start", toolName: "bash" },
      {
        type: "message_end",
        message: rawMessage({
          role: "assistant",
          text: "running",
          stopReason: "toolUse",
        }),
      },
      { type: "agent_end" },
    ]);
    assert.ok(
      reports.length >= 3,
      `expected ≥3 reports, got ${reports.length}`,
    );
    assert.equal(reports[0].currentTool, "bash");
    assert.equal(reports[reports.length - 1].done, true);
  });

  it("clears the current tool on tool_execution_end instead of leaving it set", async () => {
    const h = harness();
    const { reports } = await drive(h, [
      { type: "tool_execution_start", toolName: "bash" },
      { type: "tool_execution_end", toolName: "bash" },
      { type: "tool_execution_start", toolName: "edit" },
    ]);
    const start = reports[0];
    assert.equal(start.currentTool, "bash");
    // The end report carries the explicit clear (`null`), not silence: an
    // absent field would mean "leave unchanged" and the finished tool's name
    // would linger in the card title between calls.
    const end = reports[1];
    assert.equal(end.currentTool, null);
    // The next tool's start sets its own name again.
    assert.equal(reports[2].currentTool, "edit");
  });

  it("carries the accumulated token total on every report", async () => {
    const h = harness();
    const usage = (input: number, output: number, totalTokens: number) => ({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "chunk" }],
        stopReason: "toolUse",
        usage: { input, output, totalTokens },
      },
    });
    const { reports } = await drive(h, [
      usage(1000, 500, 1500),
      { type: "tool_execution_start", toolName: "bash" },
      usage(200, 300, 500),
    ]);
    // Each message_end folds its usage into the running total, and every
    // later report (the tool bookends too) carries the sum so far.
    assert.equal(reports[0].tokens, 1500);
    assert.equal(reports[1].tokens, 1500);
    assert.equal(reports[2].tokens, 2000);
    // The terminal report carries the full total as well.
    assert.equal(reports[reports.length - 1].tokens, 2000);
  });

  it("omits the token total until a message reports usage, and needs no log", async () => {
    const h = harness();
    // No fact log is handed over: the total a report carries can only come
    // from the driver's own accumulator, never from scanning the log.
    const { reports } = await drive(
      h,
      [
        {
          type: "message_end",
          message: rawMessage({
            role: "assistant",
            text: "no usage yet",
            stopReason: "toolUse",
          }),
        },
        {
          type: "message_end",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "with usage" }],
            stopReason: "toolUse",
            usage: { input: 7, output: 3, totalTokens: 10 },
          },
        },
      ],
      { log: false },
    );
    assert.equal(reports[0].tokens, undefined);
    assert.equal(reports[1].tokens, 10);
  });

  it("carries the model id on every report when one was resolved", async () => {
    const h = harness();
    const { reports } = await drive(h, okEvents());
    assert.ok(reports.length > 0);
    for (const report of reports) {
      assert.equal(
        report.model,
        "m",
        `model missing on report: ${JSON.stringify(report)}`,
      );
    }
  });

  it("captures the session file path on the terminal report", async () => {
    const h = harness();
    const manager: PiSessionManager & { getSessionFile(): string | undefined } =
      {
        getSessionId: () => "child-session",
        getSessionFile: () => "/home/u/.pi/agent/sessions/x/s.jsonl",
      };
    const driver = createPiSubagentDriver({
      createSession: async () => ({ session: h.s.session }),
      createSessionManager: async () => manager,
      // Strict mode: the configured model must resolve so the run proceeds
      // to the session stage (where the session file path is captured).
      resolveModel: async () => ({
        model: { provider: "p", id: "m" },
        modelRuntime: { getModel: () => ({ provider: "p", id: "m" }) },
      }),
    });
    const reports: SubagentProgress[] = [];
    h.s.setPromptBehavior({ kind: "resolves", emitOnPrompt: okEvents() });
    await driver.run(
      { agent: "beaver", prompt: "t", tools: [], model: "p/m" },
      {
        signal: new AbortController().signal,
        onProgress: (p) => reports.push(p),
      },
    );
    const done = reports[reports.length - 1];
    assert.equal(done.done, true);
    assert.equal(done.sessionPath, "/home/u/.pi/agent/sessions/x/s.jsonl");
  });

  it("carries the session file path on every report, not just the terminal one", async () => {
    const h = harness();
    const manager: PiSessionManager & { getSessionFile(): string | undefined } =
      {
        getSessionId: () => "child-session",
        getSessionFile: () => "/home/u/.pi/agent/sessions/x/s.jsonl",
      };
    const driver = createPiSubagentDriver({
      createSession: async () => ({ session: h.s.session }),
      createSessionManager: async () => manager,
      resolveModel: async () => ({
        model: { provider: "p", id: "m" },
        modelRuntime: { getModel: () => ({ provider: "p", id: "m" }) },
      }),
    });
    const reports: SubagentProgress[] = [];
    h.s.setPromptBehavior({ kind: "resolves", emitOnPrompt: okEvents() });
    await driver.run(
      { agent: "beaver", prompt: "t", tools: [], model: "p/m" },
      {
        signal: new AbortController().signal,
        onProgress: (p) => reports.push(p),
      },
    );
    // The sub-session file exists from the moment the session manager is
    // created, so every report — including the running (done: false) ones —
    // carries the session path, letting enter-inspect open the growing JSONL
    // while the subagent is still running.
    assert.ok(reports.length > 0, "expected at least one report");
    assert.ok(
      reports.some((p) => p.done === false),
      "the event stream must include a running report",
    );
    for (const report of reports) {
      assert.equal(
        report.sessionPath,
        "/home/u/.pi/agent/sessions/x/s.jsonl",
        `sessionPath missing on report: ${JSON.stringify(report)}`,
      );
    }
  });

  it("leaves sessionPath absent when the session manager has no file", async () => {
    const h = harness();
    const { reports } = await drive(h, okEvents());
    for (const report of reports) {
      assert.equal(report.sessionPath, undefined);
    }
  });

  it("reports the resolved child session id on every report once the session manager exists", async () => {
    const h = harness();
    const { reports } = await drive(h, okEvents());
    assert.ok(reports.length > 0, "expected at least one report");
    for (const report of reports) {
      assert.equal(
        report.childSession,
        "child-session",
        `childSession missing on report: ${JSON.stringify(report)}`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Run fact log
// ---------------------------------------------------------------------------

describe("pi subagent driver — run fact log", () => {
  it("records the delegation prompt as a leading user_message fact", async () => {
    // The transcript overlay shows the prompt through this fact, and the
    // driver appends it at the send point (not from a host event), so it is
    // the FIRST fact of every run that sends a prompt, stored verbatim.
    const h = harness();
    const prompt = "SUMMARY: implement X\n\nCONTEXT: nothing\n";
    const log = createRunLog();
    h.s.setPromptBehavior({
      kind: "resolves",
      emitOnPrompt: okEvents("done"),
    });
    await h.driver.run(
      { agent: "beaver", prompt, tools: [], model: "p/m" },
      { signal: new AbortController().signal, log },
    );
    const fact = log.facts()[0];
    assert.ok(fact, "the prompt must be recorded");
    assert.equal(fact.type, "user_message");
    if (fact.type !== "user_message") return;
    assert.equal(fact.text, prompt, "the prompt must be stored untruncated");
    assert.ok(
      log.facts().every((later, index) => index === 0 || later.at >= fact.at),
      "the prompt fact precedes every event fact",
    );
    // The instruction is neither a turn nor a token report: only the
    // assistant message of the scripted stream counts.
    assert.deepEqual(deriveCounters(log.facts()), {
      turnCount: 1,
      toolCallCount: 0,
    });
  });

  it("records a tool call with its FULL args, result text, and ids", async () => {
    const h = harness();
    const args = { command: "npm run build -- --verbose", keepAlive: true };
    const { facts } = await drive(h, [
      {
        type: "tool_execution_start",
        toolCallId: "tc-1",
        toolName: "bash",
        args,
      },
      {
        type: "tool_execution_end",
        toolCallId: "tc-1",
        toolName: "bash",
        result: {
          content: [
            { type: "text", text: "build ok" },
            { type: "image", data: "zzz" },
          ],
        },
        isError: false,
      },
    ]);
    // facts[0] is the prompt's user_message fact; the tool facts follow.
    assert.equal(facts.length, 3);
    const start = facts[1] as Extract<RunFact, { type: "tool_start" }>;
    assert.equal(start.type, "tool_start");
    assert.equal(start.toolName, "bash");
    assert.equal(start.toolCallId, "tc-1");
    // The args are stored by reference and untruncated.
    assert.deepEqual(start.args, args);
    const end = facts[2] as Extract<RunFact, { type: "tool_end" }>;
    assert.equal(end.type, "tool_end");
    assert.equal(end.toolName, "bash");
    assert.equal(end.isError, false);
    assert.equal(end.toolCallId, "tc-1");
    // Only text parts are recorded (images have no renderer yet); a long
    // result is stored whole, never truncated.
    assert.deepEqual(end.content, [{ type: "text", text: "build ok" }]);
  });

  it("flags an errored tool call", async () => {
    const h = harness();
    const { facts } = await drive(h, [
      { type: "tool_execution_start", toolName: "bash", args: {} },
      {
        type: "tool_execution_end",
        toolName: "bash",
        result: { content: "boom" },
        isError: true,
      },
    ]);
    const end = facts[2] as Extract<RunFact, { type: "tool_end" }>;
    assert.equal(end.isError, true);
    // A string content payload is normalized into one text part.
    assert.deepEqual(end.content, [{ type: "text", text: "boom" }]);
  });

  it("records a tool end whose result carries no text as an empty content list", async () => {
    const h = harness();
    const { facts } = await drive(h, [
      { type: "tool_execution_start", toolName: "bash", args: {} },
      { type: "tool_execution_end", toolName: "bash", result: {} },
    ]);
    const end = facts[2] as Extract<RunFact, { type: "tool_end" }>;
    assert.deepEqual(end.content, []);
  });

  it("records assistant messages with their content parts and usage", async () => {
    const h = harness();
    const { facts } = await drive(h, [
      {
        type: "message_end",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "planning" },
            { type: "text", text: "first" },
          ],
          stopReason: "toolUse",
          usage: { input: 1000, output: 500, totalTokens: 1500 },
        },
      },
    ]);
    const message = facts[1] as Extract<RunFact, { type: "message_end" }>;
    assert.deepEqual(message.content, [
      { type: "thinking", thinking: "planning" },
      { type: "text", text: "first" },
    ]);
    assert.deepEqual(message.usage, {
      input: 1000,
      output: 500,
      totalTokens: 1500,
    });
  });

  it("records no usage when the provider reports none", async () => {
    const h = harness();
    const { facts } = await drive(h, [
      {
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "first" }],
          stopReason: "stop",
        },
      },
    ]);
    const message = facts[1] as Extract<RunFact, { type: "message_end" }>;
    assert.equal(message.usage, undefined);
    assert.equal(deriveCounters(facts).tokens, undefined);
  });

  it("records no usage for a non-numeric or empty usage envelope", async () => {
    const h = harness();
    const { facts } = await drive(h, [
      {
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "first" }],
          stopReason: "stop",
          usage: {},
        },
      },
      {
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "second" }],
          stopReason: "stop",
          usage: { input: "1000", output: null },
        },
      },
    ]);
    // Nothing reportable is stored — the fact carries no usage rather than
    // a zeroed envelope, so derived counters stay absent.  (The leading
    // user_message fact is not a message: it has no usage field either.)
    for (const fact of facts) {
      if (fact.type === "user_message") continue;
      const message = fact as Extract<RunFact, { type: "message_end" }>;
      assert.equal(message.usage, undefined);
    }
  });

  it("accumulates token counters through the log's view projection", async () => {
    const h = harness();
    const { facts } = await drive(h, [
      {
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "first" }],
          stopReason: "toolUse",
          usage: { input: 1000, output: 500, totalTokens: 1500 },
        },
      },
      {
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "second" }],
          stopReason: "stop",
          usage: { input: 200, output: 300, totalTokens: 500 },
        },
      },
    ]);
    // The driver stores per-message usage verbatim, so the counters the
    // views project from the log survive a restart (the progress channel
    // carries the same running sum, but the log stays the durable record).
    assert.deepEqual(deriveCounters(facts), {
      turnCount: 2,
      toolCallCount: 0,
      tokens: 2000,
    });
  });

  it("appends no second fact for a user-role message event or a lifecycle marker", async () => {
    // The prompt's user_message fact comes from the send point, so a host
    // that echoes the user message back as a `message_end` event must NOT
    // produce a duplicate; lifecycle markers still append nothing.
    const h = harness();
    const { facts } = await drive(h, [
      {
        type: "message_end",
        message: rawMessage({ role: "user", text: "hi" }),
      },
      { type: "agent_end" },
    ]);
    assert.deepEqual(
      facts.map((fact) => fact.type),
      ["user_message"],
    );
    const only = facts[0];
    assert.ok(only && only.type === "user_message");
    assert.equal(only.text, "t", "the only user fact is the sent prompt");
  });

  it("fires the log listeners as facts arrive", async () => {
    const h = harness();
    const log = createRunLog();
    const seen: string[] = [];
    log.onFact((fact) => seen.push(fact.type));
    h.s.setPromptBehavior({
      kind: "resolves",
      emitOnPrompt: okEvents("text"),
    });
    await h.driver.run(
      { agent: "beaver", prompt: "t", tools: [], model: "p/m" },
      { signal: new AbortController().signal, log },
    );
    assert.deepEqual(seen, ["user_message", "message_end"]);
  });

  it("survives a throwing log listener on every event it appends", async () => {
    // Regression guard for the transcript-overlay throw path: the driver
    // appends facts synchronously from inside the host's event delivery, so
    // a listener that throws (a UI projection building components from the
    // fact) must never unwind into that delivery, lose a later fact, or
    // change the run's outcome.
    initLogger("pi");
    const h = harness();
    const log = createRunLog();
    let notified = 0;
    log.onFact(() => {
      notified += 1;
      throw new Error("overlay projection boom");
    });
    h.s.setPromptBehavior({
      kind: "resolves",
      emitOnPrompt: [
        { type: "tool_execution_start", toolName: "bash", args: {} },
        {
          type: "tool_execution_end",
          toolName: "bash",
          result: { content: "build ok" },
          isError: false,
        },
        {
          type: "message_end",
          message: rawMessage({
            role: "assistant",
            text: "done",
            stopReason: "stop",
          }),
        },
        { type: "agent_end" },
      ],
    });
    const result = await h.driver.run(
      { agent: "beaver", prompt: "t", tools: [], model: "p/m" },
      { signal: new AbortController().signal, log },
    );
    assert.equal(result.kind, "ok", "the run must finish normally");
    // user_message (the prompt) + tool_start + tool_end + message_end reach
    // the listener (agent_end appends nothing); every append still stored
    // its fact.
    assert.equal(notified, 4);
    assert.deepEqual(
      log.facts().map((fact) => fact.type),
      ["user_message", "tool_start", "tool_end", "message_end"],
    );
  });

  it("runs without a fact log when the caller has no registry run", async () => {
    const h = harness();
    const { reports } = await drive(
      h,
      [
        { type: "tool_execution_start", toolName: "bash", args: {} },
        {
          type: "message_end",
          message: rawMessage({
            role: "assistant",
            text: "answer",
            stopReason: "stop",
          }),
        },
      ],
      { log: false },
    );
    // Progress reports still flow — only the fact recording is skipped.
    assert.ok(
      reports.some((r) => r.done === false),
      "expected a running report",
    );
  });
});

// ---------------------------------------------------------------------------
// Streaming partials
// ---------------------------------------------------------------------------

/** An assistant `message_update` carrying the accumulated partial message. */
function partialEvent(text: string): PiSessionEvent {
  return {
    type: "message_update",
    message: rawMessage({ role: "assistant", text }),
    assistantMessageEvent: { type: "text_delta", delta: text.slice(-1) },
  };
}

/**
 * An assistant `message_update` whose accumulated partial message carries raw
 * pi content parts (the shape pi's stream hands over: text and thinking
 * blocks interleaved), with the delta envelope naming the last delta.
 */
function partialPartsEvent(
  content: unknown[],
  deltaType: string,
): PiSessionEvent {
  return {
    type: "message_update",
    message: { role: "assistant", content },
    assistantMessageEvent: { type: deltaType, delta: "" },
  };
}

/** A pi-shaped thinking content block. */
function piThinking(thinking: string): unknown {
  return { type: "thinking", thinking };
}

/** A pi-shaped text content block. */
function piText(text: string): unknown {
  return { type: "text", text };
}

/**
 * Run the driver over a scripted stream while collecting everything the run
 * delivers on its data stream, so a test can see the streaming state as the
 * run advances (it is transient by contract and gone once the run settles)
 * AND the order the deliveries arrived in.
 */
async function driveStreaming(
  h: ReturnType<typeof harness>,
  events: PiSessionEvent[],
): Promise<{
  log: RunLog;
  delivered: LogEvent[];
  partials: Array<readonly MessagePart[]>;
}> {
  const log = createRunLog();
  const delivered: LogEvent[] = [];
  log.subscribe((event) => delivered.push(event));
  h.s.setPromptBehavior({ kind: "resolves", emitOnPrompt: events });
  await h.driver.run(
    { agent: "beaver", prompt: "t", tools: [], model: "p/m" },
    { signal: new AbortController().signal, log },
  );
  return {
    log,
    delivered,
    partials: delivered.flatMap((event) =>
      event.kind === "partial" ? [event.parts] : [],
    ),
  };
}

/**
 * A human-readable trace of one delivery, for order assertions.
 *
 * `partial:<body>` for a forming-head delivery (`partial:none` once retired),
 * `fact:<kind>` for an appended fact.
 */
function streamShape(event: LogEvent): string {
  if (event.kind === "fact") return `fact:${event.fact.type}`;
  if (event.parts.length === 0) return "partial:none";
  const first = event.parts[0];
  const body =
    first === undefined ? "" : first.type === "text" ? first.text : "…thinks";
  return `partial:${body}`;
}

describe("pi subagent driver — streaming partials", () => {
  it("pushes each assistant message_update onto the log's forming head", async () => {
    const h = harness();
    const { log, delivered, partials } = await driveStreaming(h, [
      partialEvent("Hel"),
      partialEvent("Hello"),
      partialEvent("Hello there"),
      {
        type: "message_end",
        message: rawMessage({
          role: "assistant",
          text: "Hello there",
          stopReason: "stop",
        }),
      },
    ]);
    assert.deepEqual(partials, [
      [{ type: "text", text: "Hel" }],
      [{ type: "text", text: "Hello" }],
      [{ type: "text", text: "Hello there" }],
      [],
    ]);
    // The whole run is one ordered stream: the prompt fact, the deltas, then
    // the retirement the append delivered for it, then the fact itself.
    assert.deepEqual(
      delivered.map(streamShape),
      [
        "fact:user_message",
        "partial:Hel",
        "partial:Hello",
        "partial:Hello there",
        "partial:none",
        "fact:message_end",
      ],
      "the retirement sits immediately before the fact that finalizes it",
    );
    // The streamed text reaches the record exactly once — as the finalized
    // fact, never as a partial masquerading as one.
    assert.deepEqual(
      log.facts().map((f) => f.type),
      ["user_message", "message_end"],
    );
    assert.deepEqual(log.partial(), [], "the finalize retired the partial");
  });

  it("retires the partial through the stream, not through a driver call", async () => {
    // The stream's contract: the driver never clears on `message_end` —
    // `RunLog.append` emits the empty-partial delivery before its fact
    // delivery, so a streaming surface drops exactly when the fact exists.
    const h = harness();
    const log = createRunLog();
    const partialAtFact: Array<readonly MessagePart[]> = [];
    log.onFact((_fact, source) => partialAtFact.push(source.partial()));
    h.s.setPromptBehavior({
      kind: "resolves",
      emitOnPrompt: [
        partialEvent("half a mess"),
        partialEvent("half a message"),
        {
          type: "message_end",
          message: rawMessage({
            role: "assistant",
            text: "half a message",
            stopReason: "stop",
          }),
        },
      ],
    });
    await h.driver.run(
      { agent: "beaver", prompt: "t", tools: [], model: "p/m" },
      { signal: new AbortController().signal, log },
    );
    assert.deepEqual(
      partialAtFact,
      [[], []],
      "the fact deliveries see no outstanding partial: the prompt's had none " +
        "yet, the message's was retired in the same dispatch",
    );
  });

  it("drops a dangling partial when the stream never finalizes the message", async () => {
    // An abort or a provider cut mid-message leaves no `message_end`: the
    // run's finally must clear the transient text so an open overlay never
    // keeps a frozen half-message.
    const h = harness();
    const { log, partials } = await driveStreaming(h, [
      partialEvent("streamed but never finished"),
    ]);
    assert.deepEqual(
      partials,
      [[{ type: "text", text: "streamed but never finished" }], []],
      "the run's teardown clears the dangling partial",
    );
    assert.deepEqual(log.partial(), []);
    assert.deepEqual(
      log.facts().map((f) => f.type),
      ["user_message"],
      "a partial never becomes a fact",
    );
  });

  it("agent_end closes the stream without leaving a partial", async () => {
    const h = harness();
    const { log } = await driveStreaming(h, [
      partialEvent("streaming"),
      { type: "agent_end" },
    ]);
    assert.deepEqual(log.partial(), []);
  });

  it("ignores update events of non-assistant messages", async () => {
    const h = harness();
    const { log, partials } = await driveStreaming(h, [
      {
        type: "message_update",
        message: rawMessage({ role: "user", text: "x" }),
      },
      {
        type: "message_update",
        message: { role: "toolResult", content: "y" },
      },
    ]);
    assert.deepEqual(partials, []);
    assert.deepEqual(log.partial(), []);
  });

  it("streams thinking deltas onto the partial as thinking parts", async () => {
    // The reason the partial contract carries content parts: reasoning
    // arrives as its own delta kind, and an open transcript has to show it
    // while it streams — not only once the message finalizes.
    const h = harness();
    const { log, partials } = await driveStreaming(h, [
      partialPartsEvent([piThinking("Let me")], "thinking_delta"),
      partialPartsEvent([piThinking("Let me think")], "thinking_delta"),
      {
        type: "message_end",
        message: {
          role: "assistant",
          content: [piThinking("Let me think")],
          stopReason: "stop",
        },
      },
    ]);
    assert.deepEqual(partials, [
      [{ type: "thinking", thinking: "Let me" }],
      [{ type: "thinking", thinking: "Let me think" }],
      // The last entry is the retirement `append` delivered for the fact
      // below — the driver never clears it itself.
      [],
    ]);
    // The finalized fact keeps the same shape, so the streaming surface and
    // the record never disagree on what the part was.
    assert.deepEqual((log.facts()[1] as { content: MessagePart[] }).content, [
      { type: "thinking", thinking: "Let me think" },
    ]);
  });

  it("preserves text/thinking interleaving from the partial message", async () => {
    // pi accumulates the partial message itself, so the driver maps its
    // content rather than re-summing deltas; the order the model produced
    // must survive to the projection untouched.
    const h = harness();
    const { partials } = await driveStreaming(h, [
      partialPartsEvent([piThinking("think-1")], "thinking_delta"),
      partialPartsEvent([piThinking("think-1"), piText("say-1")], "text_delta"),
      partialPartsEvent(
        [piThinking("think-1"), piText("say-1"), piThinking("think-2")],
        "thinking_delta",
      ),
    ]);
    // The last notification is the run's teardown clear (no `message_end`
    // was scripted), so the final streamed shape is the one before it.
    assert.deepEqual(partials[partials.length - 2], [
      { type: "thinking", thinking: "think-1" },
      { type: "text", text: "say-1" },
      { type: "thinking", thinking: "think-2" },
    ]);
  });

  it("drops tool-call parts from a streamed partial", async () => {
    // A partial message also carries tool-call blocks; no projection renders
    // them, so the partial holds only what a surface can show.
    const h = harness();
    const { partials } = await driveStreaming(h, [
      partialPartsEvent(
        [piText("calling"), { type: "toolCall", id: "t1", name: "bash" }],
        "toolcall_delta",
      ),
    ]);
    assert.deepEqual(partials[0], [{ type: "text", text: "calling" }]);
  });
});
