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
import type { SubagentResult } from "../../core/subagent/driver.js";
import { _resetForTesting as _resetLoggerForTesting } from "../../utils/logger.js";
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
      { agent: "beaver", prompt: "do it", tools: ["bash", "edit"] },
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
        parentSession: "parent-1",
      },
      { signal: new AbortController().signal },
    );
    assert.equal(h.managerCalls.length, 1);
    assert.equal(h.managerCalls[0].cwd, process.cwd());
    assert.equal(h.managerCalls[0].parent, "parent-1");
  });

  it("passes no model when the request carries none", async () => {
    const h = harness();
    h.s.setPromptBehavior({ kind: "resolves", emitOnPrompt: okEvents() });
    await h.driver.run(
      { agent: "beaver", prompt: "t", tools: [] },
      { signal: new AbortController().signal },
    );
    assert.equal("model" in h.factoryCalls[0], false);
    assert.equal("modelRuntime" in h.factoryCalls[0], false);
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
});

// ---------------------------------------------------------------------------
// Prompt and outcome classification
// ---------------------------------------------------------------------------

describe("pi subagent driver — prompt and outcome classification", () => {
  it("calls prompt with the request prompt", async () => {
    const h = harness();
    h.s.setPromptBehavior({ kind: "resolves", emitOnPrompt: okEvents() });
    await h.driver.run(
      { agent: "beaver", prompt: "the task", tools: [] },
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
      { agent: "beaver", prompt: "t", tools: [] },
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
      { agent: "beaver", prompt: "t", tools: [] },
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
      { agent: "beaver", prompt: "t", tools: [] },
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
      { agent: "beaver", prompt: "t", tools: [] },
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
      { agent: "beaver", prompt: "t", tools: [] },
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
      { agent: "beaver", prompt: "t", tools: [] },
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
      { agent: "beaver", prompt: "t", tools: [] },
      { signal: new AbortController().signal },
    );
    assert.equal(h.s.disposed, 1);
  });

  it("disposes the session after an aborted run", async () => {
    const h = harness();
    h.s.setPromptBehavior({ kind: "hang", emitOnPrompt: [] });
    const controller = new AbortController();
    const runPromise = h.driver.run(
      { agent: "beaver", prompt: "t", tools: [] },
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
      { agent: "beaver", prompt: "t", tools: [] },
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
    });
    const result = await driver.run(
      { agent: "beaver", prompt: "t", tools: [] },
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
    });
    const result = await driver.run(
      { agent: "beaver", prompt: "t", tools: [] },
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
      { agent: "beaver", prompt: "t", tools: [] },
      { signal: new AbortController().signal },
    );
    assert.equal(result.kind, "error");
  });
});

// ---------------------------------------------------------------------------
// Progress snapshots
// ---------------------------------------------------------------------------

describe("pi subagent driver — progress snapshots", () => {
  it("streams tool / output / done snapshots through onProgress", async () => {
    const h = harness();
    h.s.setPromptBehavior({
      kind: "resolves",
      emitOnPrompt: [
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
      ],
    });
    const snapshots: Array<{
      currentTool?: string;
      output: string;
      done: boolean;
    }> = [];
    await h.driver.run(
      { agent: "beaver", prompt: "t", tools: [] },
      {
        signal: new AbortController().signal,
        onProgress: (p) => snapshots.push(p),
      },
    );
    assert.ok(
      snapshots.length >= 3,
      `expected ≥3 snapshots, got ${snapshots.length}`,
    );
    assert.equal(snapshots[0].currentTool, "bash");
    assert.equal(snapshots[1].output, "running");
    assert.equal(snapshots[snapshots.length - 1].done, true);
  });

  it("emits the compact last-line form, never the full assistant transcript", async () => {
    const h = harness();
    const hugeText = `line one\nline two\n${"x".repeat(5000)}`;
    h.s.setPromptBehavior({
      kind: "resolves",
      emitOnPrompt: [
        {
          type: "message_end",
          message: rawMessage({
            role: "assistant",
            text: hugeText,
            stopReason: "toolUse",
          }),
        },
        { type: "agent_end" },
      ],
    });
    const snapshots: Array<{
      currentTool?: string;
      output: string;
      done: boolean;
    }> = [];
    await h.driver.run(
      { agent: "beaver", prompt: "t", tools: [] },
      {
        signal: new AbortController().signal,
        onProgress: (p) => snapshots.push(p),
      },
    );

    // The assistant message_end snapshot must be the last non-empty line,
    // capped at the 200-char snapshot cap — never the full multi-KB text.
    const outputSnapshots = snapshots.filter((s) => !s.done && s.output !== "");
    assert.ok(outputSnapshots.length >= 1, "expected an output snapshot");
    for (const snapshot of outputSnapshots) {
      assert.ok(
        snapshot.output.length <= 200,
        `snapshot exceeded cap: ${snapshot.output.length}`,
      );
      assert.ok(!snapshot.output.includes("line one"));
      assert.ok(snapshot.output.endsWith("…"), "expected ellipsis marker");
    }
    const done = snapshots[snapshots.length - 1];
    assert.equal(done.done, true);
    assert.ok(done.output.length <= 200, "done snapshot exceeded cap");
  });
});
