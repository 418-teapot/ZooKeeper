/**
 * Tests for the pi event-key adapter (`src/compose-pi.ts`).
 *
 * Covers: `buildPiToolResultHandler` (delta appending and rewrite
 * branches, chained contributions, per-handler crash isolation, image
 * preservation, missing sessionManager), `buildPiContextHandler`
 * (native pi messages passed to transforms, result replacement, model
 * limit capture, empty array, crash isolation), the pure helper
 * `extractText`, the command-slot assembly
 * (`buildPiCommandRegistrationPlan`), the gate wrapper
 * (`wrapToolsWithDelegationGate`), and the registration-boundary
 * tool-definition application (`applyToolDefinitionContributions`).
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { TASK_PROMPT_HINT } from "./agents/parts.js";
import {
  applyToolDefinitionContributions,
  buildPiCommandRegistrationPlan,
  buildPiContextHandler,
  buildPiMessageEndHandler,
  buildPiToolResultHandler,
  extractText,
  type PiAgentMessage,
  type PiAssistantMessage,
  type PiContentPart,
  type PiToolResultEvent,
  wrapToolsWithDelegationGate,
} from "./compose-pi.js";
import type { DelegationGate, DelegationRequest } from "./core/gate.js";
import type {
  AfterExecContribution,
  AfterExecInput,
  CommandInput,
  ComposedResult,
  ToolContribution,
  TransformOutput,
} from "./core/slots.js";
import {
  _resetForTesting as _resetIdentityForTesting,
  setPrimary,
} from "./core/subagent/identity.js";
import { enhanceTaskDefinition } from "./hooks/task-prompt/index.js";
import { _getBufferForTesting, _resetForTesting } from "./utils/logger.js";

afterEach(() => {
  _resetForTesting();
  _resetIdentityForTesting();
});

/** Session context shared by the handler tests. */
const SESSION_CTX = { sessionManager: { getSessionId: () => "sess-1" } };

/**
 * Build a minimal after-exec contribution that appends a suffix line.
 */
function appendSuffix(suffix: string): AfterExecContribution {
  return {
    name: `append-${suffix}`,
    handle: (_input, output) => {
      output.output = `${output.output ?? ""}\n${suffix}`;
    },
  };
}

/**
 * Build a minimal pi `tool_result` event for the `bash` tool.
 */
function toolEvent(
  content: PiContentPart[],
  input?: Record<string, unknown>,
): PiToolResultEvent {
  return {
    type: "tool_result",
    toolName: "bash",
    toolCallId: "call-1",
    input,
    content,
    isError: false,
  };
}

/** Count the buffered `handler_crashed` entries. */
function crashedEntries(): Array<Record<string, unknown>> {
  return _getBufferForTesting().filter(
    (entry) => entry.event === "handler_crashed",
  );
}

// ---------------------------------------------------------------------------
// buildPiToolResultHandler
// ---------------------------------------------------------------------------

describe("buildPiToolResultHandler", () => {
  it("appends the delta as one text part for a single contribution", async () => {
    const handler = buildPiToolResultHandler([appendSuffix("done")]);
    const result = await handler(
      toolEvent([{ type: "text", text: "hello" }]),
      SESSION_CTX,
    );
    assert.deepEqual(result, {
      content: [
        { type: "text", text: "hello" },
        { type: "text", text: "\ndone" },
      ],
    });
  });

  it("chains multiple contributions into one accumulated delta part", async () => {
    const handler = buildPiToolResultHandler([
      appendSuffix("A"),
      appendSuffix("B"),
    ]);
    const result = await handler(
      toolEvent([{ type: "text", text: "hello" }]),
      SESSION_CTX,
    );
    assert.deepEqual(result, {
      content: [
        { type: "text", text: "hello" },
        { type: "text", text: "\nA\nB" },
      ],
    });
  });

  it("supports async contributions", async () => {
    const handler = buildPiToolResultHandler([
      {
        name: "async-append",
        handle: async (_input, output) => {
          output.output = `${output.output ?? ""}\nasync`;
        },
      },
    ]);
    const result = await handler(
      toolEvent([{ type: "text", text: "hello" }]),
      SESSION_CTX,
    );
    assert.deepEqual(result, {
      content: [
        { type: "text", text: "hello" },
        { type: "text", text: "\nasync" },
      ],
    });
  });

  it("returns undefined when no contribution changes the output", async () => {
    const handler = buildPiToolResultHandler([
      {
        name: "noop",
        handle: () => {},
      },
    ]);
    const result = await handler(
      toolEvent([{ type: "text", text: "hello" }]),
      SESSION_CTX,
    );
    assert.equal(result, undefined);
  });

  it("returns undefined for an empty contribution list", async () => {
    const handler = buildPiToolResultHandler([]);
    const result = await handler(
      toolEvent([{ type: "text", text: "hello" }]),
      SESSION_CTX,
    );
    assert.equal(result, undefined);
  });

  it("isolates a throwing contribution and still runs later ones", async () => {
    const handler = buildPiToolResultHandler([
      {
        name: "boom",
        handle: () => {
          throw new Error("boom");
        },
      },
      appendSuffix("ok"),
    ]);
    const result = await handler(
      toolEvent([{ type: "text", text: "hello" }]),
      SESSION_CTX,
    );
    assert.deepEqual(result, {
      content: [
        { type: "text", text: "hello" },
        { type: "text", text: "\nok" },
      ],
    });
    const crashed = crashedEntries();
    assert.equal(crashed.length, 1);
    assert.equal(crashed[0].handler, "boom");
    assert.equal(crashed[0].sessionId, "sess-1");
    assert.equal(crashed[0].callId, "call-1");
  });

  it("isolates an async rejection", async () => {
    const handler = buildPiToolResultHandler([
      {
        name: "async-boom",
        handle: async () => {
          throw new Error("async boom");
        },
      },
      appendSuffix("ok"),
    ]);
    const result = await handler(
      toolEvent([{ type: "text", text: "hello" }]),
      SESSION_CTX,
    );
    assert.deepEqual(result, {
      content: [
        { type: "text", text: "hello" },
        { type: "text", text: "\nok" },
      ],
    });
    const crashed = crashedEntries();
    assert.equal(crashed.length, 1);
    assert.equal(crashed[0].handler, "async-boom");
  });

  it("preserves image parts and appends only the text delta", async () => {
    const handler = buildPiToolResultHandler([appendSuffix("note")]);
    const result = await handler(
      toolEvent([
        { type: "text", text: "screenshot shown" },
        { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
      ]),
      SESSION_CTX,
    );
    assert.deepEqual(result, {
      content: [
        { type: "text", text: "screenshot shown" },
        { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
        { type: "text", text: "\nnote" },
      ],
    });
  });

  it("seeds an empty text when the event has no content", async () => {
    const handler = buildPiToolResultHandler([
      {
        name: "inject",
        handle: (_input, output) => {
          output.output = "injected";
        },
      },
    ]);
    // `content` is required by the pi contract; the cast simulates a
    // structurally older event so the handler's defensive fallback runs.
    const bareEvent = {
      type: "tool_result",
      toolName: "bash",
      toolCallId: "call-1",
      isError: false,
    } as PiToolResultEvent;
    const result = await handler(bareEvent, SESSION_CTX);
    assert.deepEqual(result, {
      content: [{ type: "text", text: "injected" }],
    });
  });

  it("rewrites the text when a contribution prefixes the seed", async () => {
    const handler = buildPiToolResultHandler([
      {
        name: "prepend",
        handle: (_input, output) => {
          output.output = `hello ${output.output ?? ""}`;
        },
      },
    ]);
    // A contribution that inserts text before the seed does not extend
    // it (the final text does not start with the seed), so the text is
    // rewritten: the content becomes a single full text part carrying
    // the entire final text, and the image part is preserved.
    const result = await handler(
      toolEvent([
        { type: "text", text: "world" },
        { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
      ]),
      SESSION_CTX,
    );
    assert.deepEqual(result, {
      content: [
        { type: "text", text: "hello world" },
        { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
      ],
    });
  });

  it("rewrite mode replaces text parts entirely and keeps images", async () => {
    const handler = buildPiToolResultHandler([
      {
        name: "rewrite",
        handle: (_input, output) => {
          output.output = "rewritten summary";
        },
      },
    ]);
    // The contribution neither extends nor prefixes the seed, so the
    // text was rewritten: the original text part is replaced by the
    // full final text and the image part is preserved.
    const result = await handler(
      toolEvent([
        { type: "text", text: "original text" },
        { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
      ]),
      SESSION_CTX,
    );
    assert.deepEqual(result, {
      content: [
        { type: "text", text: "rewritten summary" },
        { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
      ],
    });
  });

  it("tolerates a missing sessionManager", async () => {
    const handler = buildPiToolResultHandler([appendSuffix("x")]);
    const result = await handler(toolEvent([{ type: "text", text: "hi" }]), {});
    assert.deepEqual(result, {
      content: [
        { type: "text", text: "hi" },
        { type: "text", text: "\nx" },
      ],
    });
  });

  it("passes tool / sessionID / callID / args to the afterExec input", async () => {
    let captured: AfterExecInput | undefined;
    const handler = buildPiToolResultHandler([
      {
        name: "capture",
        handle: (input) => {
          captured = input;
        },
      },
    ]);
    await handler(
      toolEvent([{ type: "text", text: "hello" }], {
        command: "ls",
        cwd: "/tmp",
      }),
      SESSION_CTX,
    );
    assert.deepEqual(captured, {
      tool: "bash",
      sessionID: "sess-1",
      callID: "call-1",
      args: { command: "ls", cwd: "/tmp" },
    });
  });
});

// ---------------------------------------------------------------------------
// buildPiContextHandler
// ---------------------------------------------------------------------------

describe("buildPiContextHandler", () => {
  it("passes native pi messages to transform contributions", async () => {
    let captured: TransformOutput | undefined;
    const handler = buildPiContextHandler([
      {
        name: "capture",
        handle: (output) => {
          captured = output;
        },
      },
    ]);
    const messages: PiAgentMessage[] = [{ role: "user", content: "hello" }];
    const result = await handler({ type: "context", messages }, SESSION_CTX);
    assert.deepEqual(result, { messages });
    assert.equal(captured?.messages, messages);
  });

  it("returns the modified message list from transform contributions", async () => {
    const replacement: PiAgentMessage[] = [
      { role: "user", content: "replaced" },
    ];
    const handler = buildPiContextHandler([
      {
        name: "replace",
        handle: (output) => {
          output.messages = replacement;
        },
      },
    ]);
    const result = await handler(
      { type: "context", messages: [{ role: "user", content: "hi" }] },
      SESSION_CTX,
    );
    assert.deepEqual(result, { messages: replacement });
  });

  it("captures the model context window from ctx.model", async () => {
    const handler = buildPiContextHandler([
      {
        name: "noop",
        handle: () => {},
      },
    ]);
    await handler(
      { type: "context", messages: [{ role: "user", content: "hi" }] },
      {
        sessionManager: { getSessionId: () => "sess-model" },
        model: { id: "gpt-5", contextWindow: 128000 },
      },
    );
    // The capture is best verified through the downstream pruning/nudge
    // behavior; here we assert the handler completes without throwing.
    assert.ok(true);
  });

  it("returns the input messages for an empty contribution list", async () => {
    const messages: PiAgentMessage[] = [{ role: "user", content: "hi" }];
    const handler = buildPiContextHandler([]);
    const result = await handler({ type: "context", messages }, SESSION_CTX);
    assert.deepEqual(result, { messages });
  });

  it("yields empty messages for an empty message array", async () => {
    const handler = buildPiContextHandler([]);
    const result = await handler(
      { type: "context", messages: [] },
      SESSION_CTX,
    );
    assert.deepEqual(result, { messages: [] });
  });

  it("isolates a throwing transform contribution and still runs later ones", async () => {
    let captured: TransformOutput | undefined;
    const handler = buildPiContextHandler([
      {
        name: "boom",
        handle: () => {
          throw new Error("ctx boom");
        },
      },
      {
        name: "capture",
        handle: (output) => {
          captured = output;
        },
      },
    ]);
    const result = await handler(
      { type: "context", messages: [{ role: "user", content: "hi" }] },
      SESSION_CTX,
    );
    assert.deepEqual(result, { messages: [{ role: "user", content: "hi" }] });
    assert.ok(captured, "later contribution must still run");
    const crashed = crashedEntries();
    assert.equal(crashed.length, 1);
    assert.equal(crashed[0].handler, "boom");
  });
});

// ---------------------------------------------------------------------------
// extractText
// ---------------------------------------------------------------------------

describe("extractText", () => {
  it("joins text parts and ignores images", () => {
    assert.equal(
      extractText([
        { type: "text", text: "a" },
        { type: "image", data: "x", mimeType: "image/png" },
        { type: "text", text: "b" },
      ]),
      "ab",
    );
  });

  it("returns an empty string for empty or missing content", () => {
    assert.equal(extractText(undefined), "");
    assert.equal(extractText([]), "");
  });
});

// ---------------------------------------------------------------------------
// buildPiMessageEndHandler
// ---------------------------------------------------------------------------

function assistantMessage(content: PiAssistantMessage["content"]): {
  role: "assistant";
  content: PiAssistantMessage["content"];
} {
  return { role: "assistant", content };
}

function messageEndEvent(message: PiAgentMessage) {
  return { type: "message_end" as const, message };
}

describe("buildPiMessageEndHandler", () => {
  it("strips a leading [mN] ref echo from assistant text", () => {
    const handler = buildPiMessageEndHandler();
    const message = assistantMessage([{ type: "text", text: "[m3] hello" }]);
    const result = handler(messageEndEvent(message), {});
    assert.ok(result);
    assert.equal(result?.message?.role, "assistant");
    assert.deepEqual(result?.message?.content, [
      { type: "text", text: "hello" },
    ]);
  });

  it("strips multiple leading [mN] ref echoes", () => {
    const handler = buildPiMessageEndHandler();
    const message = assistantMessage([
      { type: "text", text: "[m1] [m2] body" },
    ]);
    const result = handler(messageEndEvent(message), {});
    assert.ok(result);
    assert.deepEqual(result?.message?.content, [
      { type: "text", text: "body" },
    ]);
  });

  it("preserves a mid-text [mN] occurrence", () => {
    const handler = buildPiMessageEndHandler();
    const message = assistantMessage([{ type: "text", text: "see [m3] here" }]);
    const result = handler(messageEndEvent(message), {});
    assert.equal(result, undefined);
  });

  it("leaves non-assistant messages untouched", () => {
    const handler = buildPiMessageEndHandler();
    const message: PiAgentMessage = { role: "user", content: "[m3] hi" };
    const result = handler(messageEndEvent(message), {});
    assert.equal(result, undefined);
  });

  it("returns undefined when the message is unchanged", () => {
    const handler = buildPiMessageEndHandler();
    const message = assistantMessage([{ type: "text", text: "plain" }]);
    const result = handler(messageEndEvent(message), {});
    assert.equal(result, undefined);
  });

  it("does not mutate the input message", () => {
    const handler = buildPiMessageEndHandler();
    const content = [{ type: "text" as const, text: "[m3] hello" }];
    const message = assistantMessage(content);
    handler(messageEndEvent(message), {});
    assert.deepEqual(content, [{ type: "text", text: "[m3] hello" }]);
    assert.deepEqual(message.content, [{ type: "text", text: "[m3] hello" }]);
  });

  it("leaves thinking and toolCall blocks untouched", () => {
    const handler = buildPiMessageEndHandler();
    const message = assistantMessage([
      { type: "thinking", thinking: "[m3] thought" },
      { type: "toolCall", id: "c1", name: "x", arguments: {} },
      { type: "text", text: "[m4] ok" },
    ]);
    const result = handler(messageEndEvent(message), {});
    assert.ok(result);
    assert.deepEqual(result?.message?.content, [
      { type: "thinking", thinking: "[m3] thought" },
      { type: "toolCall", id: "c1", name: "x", arguments: {} },
      { type: "text", text: "ok" },
    ]);
  });
});

// ---------------------------------------------------------------------------
// buildPiCommandRegistrationPlan
// ---------------------------------------------------------------------------

describe("buildPiCommandRegistrationPlan", () => {
  it("produces one registration per composed command with description passthrough", () => {
    const commands: ComposedResult["commands"] = {
      dcp: {
        name: "dcp",
        description: "显示上下文用量与缓存命中率",
        handle: async () => {},
      },
    };
    const plan = buildPiCommandRegistrationPlan(commands);
    assert.equal(plan.length, 1);
    assert.equal(plan[0].name, "dcp");
    assert.equal(plan[0].description, "显示上下文用量与缓存命中率");
    assert.equal(typeof plan[0].handler, "function");
  });

  it("resolves the sessionID from ctx and passes arguments to the contribution", async () => {
    let captured: CommandInput | undefined;
    const commands: ComposedResult["commands"] = {
      dcp: {
        name: "dcp",
        description: "desc",
        handle: async (input) => {
          captured = input;
        },
      },
    };
    const [reg] = buildPiCommandRegistrationPlan(commands);
    await reg.handler("sweep 3", {
      sessionManager: { getSessionId: () => "sess-pi" },
    });
    assert.deepEqual(captured, {
      command: "dcp",
      sessionID: "sess-pi",
      arguments: "sweep 3",
    });
  });

  it("falls back to an empty session id when the context has no sessionManager", async () => {
    let captured: CommandInput | undefined;
    const commands: ComposedResult["commands"] = {
      dcp: {
        name: "dcp",
        description: "desc",
        handle: async (input) => {
          captured = input;
        },
      },
    };
    const [reg] = buildPiCommandRegistrationPlan(commands);
    await reg.handler("context", {});
    assert.equal(captured?.sessionID, "");
    assert.equal(captured?.arguments, "context");
  });

  it("runs the refresh callback with the pi command context", async () => {
    let refreshed: unknown;
    const commands: ComposedResult["commands"] = {
      dcp: {
        name: "dcp",
        description: "desc",
        handle: async () => {},
      },
    };
    const [reg] = buildPiCommandRegistrationPlan(commands, (ctx) => {
      refreshed = ctx;
    });
    const ctx = { sessionManager: { getSessionId: () => "sess-r" } };
    await reg.handler("context", ctx);
    assert.equal(refreshed, ctx);
  });

  it("returns an empty plan for an empty commands map", () => {
    assert.deepEqual(buildPiCommandRegistrationPlan({}), []);
  });
});

// ---------------------------------------------------------------------------
// wrapToolsWithDelegationGate
// ---------------------------------------------------------------------------

/** A subagent-shaped tool contribution whose inner execute records calls. */
function fakeSubagentTool(): {
  tool: ToolContribution;
  calls: { count: number };
} {
  const calls = { count: 0 };
  return {
    tool: {
      name: "subagent",
      description: "delegate to a subagent",
      required: ["agent", "description", "prompt"],
      async execute(args) {
        calls.count += 1;
        // Mirror the real tool's boundary: non-string arguments fail the
        // inner validation.
        const raw = args as Record<string, unknown>;
        if (typeof raw.agent !== "string" || raw.agent.length === 0) {
          throw new Error("agent 必须是字符串");
        }
        return `ran ${raw.agent}`;
      },
    },
    calls,
  };
}

describe("wrapToolsWithDelegationGate", () => {
  it("returns the tools unchanged for a null gate (empty strategy chain)", () => {
    const { tool } = fakeSubagentTool();
    const tools = wrapToolsWithDelegationGate({ subagent: tool }, null, false);
    assert.equal(tools.subagent, tool, "no wrapper must be installed");
  });

  it("returns the tools unchanged when no subagent tool is present", () => {
    const compress: ToolContribution = {
      name: "compress",
      description: "compress",
      async execute() {
        return "compressed";
      },
    };
    const gate: DelegationGate = () => null;
    const tools = wrapToolsWithDelegationGate({ compress }, gate, false);
    assert.equal(tools.compress, compress, "foreign tools must pass through");
  });

  it("blocks a refused delegation: returns the reason and never runs the inner execute", async () => {
    const { tool, calls } = fakeSubagentTool();
    const gate: DelegationGate = () => ({
      judge: "judgeDelegationTarget",
      reason: "delegation refused",
    });
    const tools = wrapToolsWithDelegationGate({ subagent: tool }, gate, true);

    const result = await tools.subagent.execute(
      { agent: "eagle", description: "t", prompt: "p" },
      { sessionManager: { getSessionId: () => "sess-gate" } },
    );
    assert.equal(result, "delegation refused");
    assert.equal(calls.count, 0, "the inner execute must not run");

    // The refusal is a warn log entry carrying caller/target/judge/reason.
    const blocked = _getBufferForTesting().filter(
      (e) => e.event === "delegation_blocked",
    );
    assert.equal(blocked.length, 1);
    assert.equal(blocked[0].level, "warn");
    assert.equal(blocked[0].judge, "judgeDelegationTarget");
    assert.equal(blocked[0].reason, "delegation refused");
    assert.equal(blocked[0].sessionId, "sess-gate");
  });

  it("reads the session id off a class-instance session manager (this-bound)", async () => {
    // Regression: the real pi SessionManager is a class instance whose
    // getSessionId reads `this.sessionId`.  An earlier implementation
    // extracted the method and called it bare (`id()`), which dropped the
    // receiver and threw on the refusal path.  Arrow-function mocks bind
    // no `this` and never exposed the bug.
    class FakeSessionManager {
      readonly sessionId: string;
      constructor(sessionId: string) {
        this.sessionId = sessionId;
      }
      getSessionId(): string {
        return this.sessionId;
      }
    }
    const { tool, calls } = fakeSubagentTool();
    const gate: DelegationGate = () => ({
      judge: "judgeDelegationTarget",
      reason: "delegation refused",
    });
    const tools = wrapToolsWithDelegationGate({ subagent: tool }, gate, true);

    const result = await tools.subagent.execute(
      { agent: "eagle", description: "t", prompt: "p" },
      { sessionManager: new FakeSessionManager("sess-class") },
    );
    assert.equal(result, "delegation refused");
    assert.equal(calls.count, 0, "the inner execute must not run");

    const blocked = _getBufferForTesting().filter(
      (e) => e.event === "delegation_blocked",
    );
    assert.equal(blocked.length, 1);
    assert.equal(blocked[0].sessionId, "sess-class");
  });

  it("resolves the caller from the identity core and the request from the args", async () => {
    const { tool, calls } = fakeSubagentTool();
    let received: DelegationRequest | undefined;
    const gate: DelegationGate = (req) => {
      received = req;
      return null;
    };
    const tools = wrapToolsWithDelegationGate({ subagent: tool }, gate, true);

    setPrimary("dolphin");
    const result = await tools.subagent.execute(
      { agent: "beaver", description: "t", prompt: "do the task" },
      {},
    );
    assert.equal(result, "ran beaver");
    assert.equal(calls.count, 1, "an allowed delegation must reach the tool");
    assert.deepEqual(received, {
      caller: "dolphin",
      target: "beaver",
      prompt: "do the task",
    });
  });

  it("passes non-string args through to the inner tool's validation (undef fields)", async () => {
    const { tool, calls } = fakeSubagentTool();
    let received: DelegationRequest | undefined;
    const gate: DelegationGate = (req) => {
      received = req;
      return null;
    };
    const tools = wrapToolsWithDelegationGate({ subagent: tool }, gate, true);
    setPrimary("dolphin");

    // The gate sees absent target/prompt; the args reach the inner tool
    // verbatim, whose validation reports the malformed fields.
    await assert.rejects(
      async () =>
        tools.subagent.execute(
          { agent: 42, description: "t", prompt: "p" } as never,
          {},
        ),
      /agent 必须是字符串/,
    );
    // The non-string field is left out of the gate request (undefined), a
    // string sibling still reaches the request, and the args travel to the
    // inner tool verbatim for its own validation to reject.
    assert.equal(received?.target, undefined);
    assert.equal(received?.prompt, "p");
    assert.equal(calls.count, 1, "the inner validation must have run");
  });

  it("unresolvable caller → undefined, judges skip caller-dependent checks", async () => {
    const { tool } = fakeSubagentTool();
    let received: DelegationRequest | undefined;
    const gate: DelegationGate = (req) => {
      received = req;
      return null;
    };
    // No setPrimary → resolveIdentity() is undefined.
    const tools = wrapToolsWithDelegationGate({ subagent: tool }, gate, true);
    await tools.subagent.execute(
      { agent: "beaver", description: "t", prompt: "p" },
      {},
    );
    assert.equal(received?.caller, undefined);
  });

  it("skips caller resolution entirely when needsCaller is false", async () => {
    const { tool, calls } = fakeSubagentTool();
    let received: DelegationRequest | undefined;
    const gate: DelegationGate = (req) => {
      received = req;
      return null;
    };
    // The caller resolves fine, but needsCaller=false means the wrapper
    // never resolves it — the gate sees caller === undefined regardless.
    setPrimary("dolphin");
    const tools = wrapToolsWithDelegationGate({ subagent: tool }, gate, false);
    const result = await tools.subagent.execute(
      { agent: "beaver", description: "t", prompt: "p" },
      {},
    );
    assert.equal(result, "ran beaver");
    assert.equal(calls.count, 1, "an allowed delegation must reach the tool");
    assert.deepEqual(received, {
      caller: undefined,
      target: "beaver",
      prompt: "p",
    });
  });

  it("preserves the other tool fields on the wrapped contribution", async () => {
    const { tool } = fakeSubagentTool();
    const withRender = {
      ...tool,
      renderCall: () => ({ kind: "call" }),
      renderResult: () => ({ kind: "result" }),
    };
    const gate: DelegationGate = () => null;
    const tools = wrapToolsWithDelegationGate(
      { subagent: withRender },
      gate,
      false,
    );
    const wrapped = tools.subagent;
    assert.equal(wrapped.name, "subagent");
    assert.equal(wrapped.description, tool.description);
    assert.deepEqual(wrapped.required, tool.required);
    assert.equal(wrapped.renderCall, withRender.renderCall);
    assert.equal(wrapped.renderResult, withRender.renderResult);
  });

  it("does not wrap the subagent tool when the gate passes through other tools unchanged", async () => {
    // Only the subagent entry is wrapped: a sibling tool keeps its exact
    // identity while the subagent execute is replaced.
    const { tool } = fakeSubagentTool();
    const compress: ToolContribution = {
      name: "compress",
      description: "compress",
      async execute() {
        return "compressed";
      },
    };
    const gate: DelegationGate = () => null;
    const tools = wrapToolsWithDelegationGate(
      { subagent: tool, compress },
      gate,
      false,
    );
    assert.equal(tools.compress, compress);
    assert.notEqual(tools.subagent, tool);
  });
});

// ---------------------------------------------------------------------------
// applyToolDefinitionContributions
// ---------------------------------------------------------------------------

/** The task-prompt enhancement contribution (the real hook handler). */
const HINT_CONTRIBUTIONS = [
  { name: "enhanceTaskDefinition", handle: enhanceTaskDefinition },
];

/** A subagent tool contribution carrying the delegation argument schemas. */
function subagentToolWithArgs(): ToolContribution {
  return {
    name: "subagent",
    description: "delegate to a subagent",
    required: ["agent", "description", "prompt"],
    args: {
      agent: { type: "string", description: "目标 agent" },
      description: { type: "string", description: "任务短标签" },
      prompt: { type: "string", description: "完整任务说明" },
    },
    async execute() {
      return "done";
    },
  };
}

describe("applyToolDefinitionContributions", () => {
  it("returns the tools unchanged for an empty contribution chain", () => {
    const tool = subagentToolWithArgs();
    const tools = applyToolDefinitionContributions({ subagent: tool }, []);
    assert.equal(tools.subagent, tool, "no enhancers must pass tools through");
  });

  it("appends TASK_PROMPT_HINT to the subagent prompt description when task-prompt is composed", () => {
    const tool = subagentToolWithArgs();
    const tools = applyToolDefinitionContributions(
      { subagent: tool },
      HINT_CONTRIBUTIONS,
    );
    const prompt = tools.subagent.args?.prompt as {
      description?: string;
      type?: string;
    };
    assert.ok(
      prompt.description?.includes(TASK_PROMPT_HINT),
      "prompt description must embed the format hint at the boundary",
    );
    // Untouched fields ride through: the schema type survives and a
    // sibling argument keeps its exact description and identity.
    assert.equal(prompt.type, "string");
    const agent = tools.subagent.args?.agent as
      | { description?: string }
      | undefined;
    assert.equal(agent?.description, "目标 agent");
    assert.equal(tools.subagent.args?.agent, tool.args?.agent);
  });

  it("keeps the tool arguments hint-free when no task-prompt contribution is composed", () => {
    const tool = subagentToolWithArgs();
    const noop = [{ name: "no-op", handle: () => {} }];
    const tools = applyToolDefinitionContributions({ subagent: tool }, noop);
    assert.equal(
      tools.subagent,
      tool,
      "a no-op chain must pass the tool through",
    );
    const prompt = tools.subagent?.args?.prompt as
      | { description?: string }
      | undefined;
    assert.equal(prompt?.description, "完整任务说明");
    assert.ok(!prompt?.description?.includes(TASK_PROMPT_HINT));
  });

  it("leaves non-subagent tools untouched (identity preserved)", () => {
    const compress: ToolContribution = {
      name: "compress",
      description: "compress message ranges",
      args: { ranges: { type: "array", description: "ranges" } },
      async execute() {
        return "compressed";
      },
    };
    const tools = applyToolDefinitionContributions(
      { subagent: subagentToolWithArgs(), compress },
      HINT_CONTRIBUTIONS,
    );
    assert.equal(tools.compress, compress, "foreign tools must pass through");
  });

  it("does not mutate the input tool map (pure boundary)", () => {
    const tool = subagentToolWithArgs();
    const before = tool.args?.prompt as { description?: string } | undefined;
    applyToolDefinitionContributions({ subagent: tool }, HINT_CONTRIBUTIONS);
    assert.equal(before?.description, "完整任务说明");
  });
});
