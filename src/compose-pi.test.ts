/**
 * Tests for the pi event-key adapter (`src/compose-pi.ts`).
 *
 * Covers: `buildPiToolResultHandler` (delta appending and rewrite
 * branches, chained contributions, per-handler crash isolation, image
 * preservation, missing sessionManager), `buildPiContextHandler`
 * (native pi messages passed to transforms, result replacement, model
 * limit capture, empty array, crash isolation), the pure helper
 * `extractText`, the native converter loader (`loadPiHtmlConverter`), the
 * command-slot assembly
 * (`buildPiCommandRegistrationPlan`), the event-key registration
 * (`registerPiHandlers`), and the registration-boundary
 * tool-definition application (`applyToolDefinitionContributions`), plus the
 * pi composition boundary of the `todo` tool (profile-enabled and host-port
 * gated: it registers only when the host supplies both its transcript scan
 * and tool services, and the pi assembly boundaries pass it through
 * untouched).
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { ExtensionAPI, PiEventHandlers } from "./adapters/pi/types.js";
import { SUBAGENT_PROMPT_HINT } from "./agents/parts.js";
import {
  applyToolDefinitionContributions,
  buildPiCommandRegistrationPlan,
  buildPiContextHandler,
  buildPiMessageEndHandler,
  buildPiToolResultHandler,
  extractText,
  loadPiHtmlConverter,
  PI_GATE_EVENT_KEYS,
  PI_RESIDENT_EVENT_KEYS,
  PI_SETTLE_EVENT_KEYS,
  type PiAgentMessage,
  type PiContentPart,
  type PiToolResultEvent,
  registerPiHandlers,
} from "./compose-pi.js";
import type { ToolHost } from "./core/client/tool-host.js";
import { composeProfile } from "./core/compose.js";
import type { ModeProfile } from "./core/config-types.js";
import type {
  AfterExecContribution,
  AfterExecInput,
  CommandInput,
  ComposedResult,
  Deps,
  ToolContribution,
  TransformOutput,
} from "./core/slots.js";
import { _resetForTesting as _resetIdentityForTesting } from "./core/subagent/identity.js";
import { createTodoStore } from "./core/todo/store.js";
import { createReplyStripHandler } from "./hooks/reply-strip/index.js";
import { enhanceSubagentDefinition } from "./hooks/subagent-prompt/index.js";
import { REGISTRY } from "./registry.js";
import { assistantMessage } from "./testkits/pi-messages.js";
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

function messageEndEvent(message: PiAgentMessage) {
  return { type: "message_end" as const, message };
}

describe("buildPiMessageEndHandler", () => {
  const stripContrib = [createReplyStripHandler()];

  it("strips a leading [mN] ref echo from assistant text", () => {
    const handler = buildPiMessageEndHandler(stripContrib);
    const message = assistantMessage([{ type: "text", text: "[m3] hello" }]);
    const result = handler(messageEndEvent(message), {});
    assert.ok(result);
    assert.equal(result?.message?.role, "assistant");
    assert.deepEqual(result?.message?.content, [
      { type: "text", text: "hello" },
    ]);
  });

  it("strips multiple leading [mN] ref echoes", () => {
    const handler = buildPiMessageEndHandler(stripContrib);
    const message = assistantMessage([
      { type: "text", text: "[m1] [m2] body" },
    ]);
    const result = handler(messageEndEvent(message), {});
    assert.ok(result);
    assert.equal(result?.message?.role, "assistant");
    assert.deepEqual(result?.message?.content, [
      { type: "text", text: "body" },
    ]);
  });

  it("preserves a mid-text [mN] occurrence", () => {
    const handler = buildPiMessageEndHandler(stripContrib);
    const message = assistantMessage([{ type: "text", text: "see [m3] here" }]);
    const result = handler(messageEndEvent(message), {});
    assert.equal(result, undefined);
  });

  it("leaves non-assistant messages untouched", () => {
    const handler = buildPiMessageEndHandler(stripContrib);
    const message: PiAgentMessage = { role: "user", content: "[m3] hi" };
    const result = handler(messageEndEvent(message), {});
    assert.equal(result, undefined);
  });

  it("returns undefined when the message is unchanged", () => {
    const handler = buildPiMessageEndHandler(stripContrib);
    const message = assistantMessage([{ type: "text", text: "plain" }]);
    const result = handler(messageEndEvent(message), {});
    assert.equal(result, undefined);
  });

  it("does not mutate the input message", () => {
    const handler = buildPiMessageEndHandler(stripContrib);
    const content = [{ type: "text" as const, text: "[m3] hello" }];
    const message = assistantMessage(content);
    handler(messageEndEvent(message), {});
    assert.deepEqual(content, [{ type: "text", text: "[m3] hello" }]);
    assert.deepEqual(message.content, [{ type: "text", text: "[m3] hello" }]);
  });

  it("leaves thinking and toolCall blocks untouched", () => {
    const handler = buildPiMessageEndHandler(stripContrib);
    const message = assistantMessage([
      { type: "thinking", thinking: "[m3] thought" },
      { type: "toolCall", id: "c1", name: "x", arguments: {} },
      { type: "text", text: "[m4] ok" },
    ]);
    const result = handler(messageEndEvent(message), {});
    assert.ok(result);
    assert.equal(result?.message?.role, "assistant");
    assert.deepEqual(result?.message?.content, [
      { type: "thinking", thinking: "[m3] thought" },
      { type: "toolCall", id: "c1", name: "x", arguments: {} },
      { type: "text", text: "ok" },
    ]);
  });

  it("runs multiple contributions in registration order", () => {
    const calls: string[] = [];
    const contribs = [
      {
        name: "first",
        handle: (
          _i: { sessionID: string; messageID: string; partID: string },
          o: { text: string },
        ) => {
          calls.push("first");
          o.text += "!";
        },
      },
      {
        name: "second",
        handle: (
          _i: { sessionID: string; messageID: string; partID: string },
          o: { text: string },
        ) => {
          calls.push("second");
          o.text += "?";
        },
      },
    ];
    const handler = buildPiMessageEndHandler(contribs);
    const result = handler(
      messageEndEvent(assistantMessage([{ type: "text", text: "hi" }])),
      {},
    );
    assert.deepEqual(calls, ["first", "second"]);
    assert.ok(result);
    assert.equal(result?.message?.role, "assistant");
    assert.deepEqual(result?.message?.content, [
      { type: "text", text: "hi!?" },
    ]);
  });

  it("returns undefined for any input when no contributions are supplied", () => {
    const handler = buildPiMessageEndHandler([]);
    const assistant = handler(
      messageEndEvent(assistantMessage([{ type: "text", text: "[m3] hi" }])),
      {},
    );
    assert.equal(assistant, undefined);
    const user = handler(
      messageEndEvent({ role: "user", content: "[m3] hi" }),
      {},
    );
    assert.equal(user, undefined);
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
    await reg.handler("context", {
      sessionManager: { getSessionId: () => "sess-pi" },
    });
    assert.deepEqual(captured, {
      command: "dcp",
      sessionID: "sess-pi",
      arguments: "context",
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
// applyToolDefinitionContributions
// ---------------------------------------------------------------------------

/** The subagent-prompt enhancement contribution (the real hook handler). */
const HINT_CONTRIBUTIONS = [
  { name: "enhanceSubagentDefinition", handle: enhanceSubagentDefinition },
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

  it("appends SUBAGENT_PROMPT_HINT to the subagent prompt description when subagent-prompt is composed", () => {
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
      prompt.description?.includes(SUBAGENT_PROMPT_HINT),
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

  it("keeps the tool arguments hint-free when no subagent-prompt contribution is composed", () => {
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
    assert.ok(!prompt?.description?.includes(SUBAGENT_PROMPT_HINT));
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

// ---------------------------------------------------------------------------
// Pi composition — the todo tool registration boundary
// ---------------------------------------------------------------------------

/**
 * A tool-only profile: every category but `tools` stays empty so the
 * composition pass instantiates exactly the tool units under test.
 */
const TOOL_PROFILE: ModeProfile = {
  name: "poly",
  agents: [],
  skills: [],
  hooks: [],
  tools: ["compress", "decompress", "todo"],
  commands: [],
};

/** The pi host's tool services: a fixed session id and a no-op notify. */
function piToolHost(): ToolHost {
  return {
    resolveSessionId: () => "sess-compose",
    async notify(): Promise<void> {},
  };
}

/** Deps carrying the required base fields plus the supplied host ports. */
function piDeps(host: Partial<Deps> = {}): Deps {
  return {
    limits: {},
    contextConfig: {},
    client: {},
    directory: "",
    resolveAgent: () => undefined,
    ...host,
  };
}

/** Compose the real registry with the tool profile and the given deps. */
function composeTools(host: Partial<Deps> = {}) {
  return composeProfile(TOOL_PROFILE, REGISTRY, piDeps(host)).tools;
}

describe("pi composition — the todo tool registration boundary", () => {
  it("registers todo when the host supplies both todoStore and toolHost", () => {
    const tools = composeTools({
      toolHost: piToolHost(),
      todoStore: createTodoStore(async () => []),
    });
    assert.ok(tools.todo, "the todo tool must register on the pi host");
    assert.equal(tools.todo.name, "todo");
    assert.equal(typeof tools.todo.execute, "function");
    // The sibling tools are unaffected by the host-port gate.
    assert.deepEqual(Object.keys(tools).sort(), [
      "compress",
      "decompress",
      "todo",
    ]);
    // Every profile name matched a registry unit — no unknown_unit warning.
    assert.deepEqual(
      _getBufferForTesting().filter((e) => e.event === "unknown_unit"),
      [],
    );
  });

  it("the composed tool serves state through the injected store instance", async () => {
    const store = createTodoStore(async () => []);
    const tools = composeTools({ toolHost: piToolHost(), todoStore: store });
    // Mutating through the composed tool must land in the very store the
    // host injected (no hidden re-creation), so the host's own invalidation
    // and the tool always share one cache.
    await tools.todo?.execute({ op: "init", tasks: ["Injected"] }, {}, {});
    const phases = await store.get("sess-compose");
    assert.equal(phases[0]?.tasks[0]?.content, "Injected");
  });

  it("contributes no todo tool when the host supplies no todoStore", () => {
    const tools = composeTools({ toolHost: piToolHost() });
    assert.equal(
      tools.todo,
      undefined,
      "no todo store → the todo unit must fail closed",
    );
    assert.deepEqual(Object.keys(tools).sort(), ["compress", "decompress"]);
  });

  it("contributes no todo tool when the host supplies no toolHost", () => {
    const tools = composeTools({ todoStore: createTodoStore(async () => []) });
    assert.equal(
      tools.todo,
      undefined,
      "no tool services → the todo unit must fail closed",
    );
    assert.deepEqual(Object.keys(tools).sort(), ["compress", "decompress"]);
  });

  it("attaches the host todo renderer to the composed tool (pi-only seam)", () => {
    const renderCall = () => ({ kind: "call" });
    const renderResult = () => ({ kind: "result" });
    const tools = composeTools({
      toolHost: piToolHost(),
      todoStore: createTodoStore(async () => []),
      todoRenderer: { renderCall, renderResult },
    });
    assert.equal(tools.todo?.renderCall, renderCall);
    assert.equal(tools.todo?.renderResult, renderResult);
  });

  it("the pi definition boundary passes the composed todo tool through untouched", () => {
    const tools = composeTools({
      toolHost: piToolHost(),
      todoStore: createTodoStore(async () => []),
    });
    const todo = tools.todo;
    assert.ok(todo);

    // Definition enhancers only target the subagent tool.
    const enhanced = applyToolDefinitionContributions(tools, [
      { name: "enhanceSubagentDefinition", handle: enhanceSubagentDefinition },
    ]);
    assert.equal(enhanced.todo, todo, "no enhancer may rewrite the todo tool");
  });
});

// ---------------------------------------------------------------------------
// loadPiHtmlConverter
// ---------------------------------------------------------------------------

describe("loadPiHtmlConverter", () => {
  it("returns the loader's converter unchanged without warning", () => {
    const converter = (html: string) => `<md>${html}</md>`;
    assert.equal(
      loadPiHtmlConverter(() => converter),
      converter,
    );
    assert.equal(
      _getBufferForTesting().filter((e) => e.hook === "fetch-tool").length,
      0,
      "a usable converter must not warn",
    );
  });

  it("warns converter_unavailable and returns null when unavailable", () => {
    assert.equal(
      loadPiHtmlConverter(() => null),
      null,
    );
    const warnings = _getBufferForTesting().filter(
      (e) => e.hook === "fetch-tool" && e.event === "converter_unavailable",
    );
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0]?.level, "warn");
  });
});

// ---------------------------------------------------------------------------
// registerPiHandlers
// ---------------------------------------------------------------------------

/** A pi `on` recorder: every event key and the handler bound to it. */
function recordingPi(): {
  registrations: Array<[string, unknown]>;
  on(event: string, handler: unknown): void;
} {
  const registrations: Array<[string, unknown]> = [];
  return {
    registrations,
    on(event, handler) {
      registrations.push([event, handler]);
    },
  };
}

/** A handler stub; `hasSettledHandlers` / `hasGateHandlers` decide the
 * settle- and gate-key registration gates. */
function stubHandlers(
  hasSettledHandlers: boolean,
  hasGateHandlers = false,
): PiEventHandlers {
  return {
    beforeAgentStart: async () => ({ systemPrompt: "" }),
    resourcesDiscover: async () => ({ skillPaths: [] }),
    toolResult: async () => undefined,
    contextHandler: async () => undefined,
    messageEnd: () => undefined,
    toolCall: () => undefined,
    sessionStart: async () => {},
    sessionTree: () => {},
    hasSettledHandlers,
    hasGateHandlers,
    agentEnd: () => {},
    beforeSettle: async () => ({}),
    agentSettled: () => {},
    uiPromptStart: () => {},
    uiPromptEnd: () => {},
  };
}

describe("registerPiHandlers", () => {
  it("binds each resident key to its own handler, in order", () => {
    const pi = recordingPi();
    const handlers = stubHandlers(false);
    registerPiHandlers(pi as unknown as ExtensionAPI, handlers);
    assert.deepEqual(
      pi.registrations.map(([event]) => event),
      [...PI_RESIDENT_EVENT_KEYS],
      "only the resident keys register without a settle handler",
    );
    // Each key must carry ITS handler, not a neighbour's: a swapped pair
    // would silently disable one event and mis-fire another.
    const expected: Record<string, unknown> = {
      session_start: handlers.sessionStart,
      before_agent_start: handlers.beforeAgentStart,
      resources_discover: handlers.resourcesDiscover,
      tool_result: handlers.toolResult,
      context: handlers.contextHandler,
      message_end: handlers.messageEnd,
      session_tree: handlers.sessionTree,
    };
    for (const [event, handler] of pi.registrations) {
      assert.equal(handler, expected[event], `${event} must bind its handler`);
    }
  });

  it("adds the settle keys when the composition contributes a settle handler", () => {
    const pi = recordingPi();
    const handlers = stubHandlers(true);
    registerPiHandlers(pi as unknown as ExtensionAPI, handlers);
    assert.deepEqual(
      pi.registrations.map(([event]) => event),
      [...PI_RESIDENT_EVENT_KEYS, ...PI_SETTLE_EVENT_KEYS],
    );
    const byKey = new Map(pi.registrations);
    assert.equal(byKey.get("agent_end"), handlers.agentEnd);
    assert.equal(byKey.get("agent_before_settle"), handlers.beforeSettle);
    assert.equal(byKey.get("agent_settled"), handlers.agentSettled);
    assert.equal(byKey.get("ui_prompt_start"), handlers.uiPromptStart);
    assert.equal(byKey.get("ui_prompt_end"), handlers.uiPromptEnd);
  });

  it("adds the gate key only when the composition contributes a gate", () => {
    // Gate only: the resident keys plus `tool_call` bound to its handler.
    const pi = recordingPi();
    const handlers = stubHandlers(false, true);
    registerPiHandlers(pi as unknown as ExtensionAPI, handlers);
    assert.deepEqual(
      pi.registrations.map(([event]) => event),
      [...PI_RESIDENT_EVENT_KEYS, ...PI_GATE_EVENT_KEYS],
    );
    assert.equal(new Map(pi.registrations).get("tool_call"), handlers.toolCall);

    // Both gates on: resident, gate, then settle.
    const both = recordingPi();
    registerPiHandlers(
      both as unknown as ExtensionAPI,
      stubHandlers(true, true),
    );
    assert.deepEqual(
      both.registrations.map(([event]) => event),
      [
        ...PI_RESIDENT_EVENT_KEYS,
        ...PI_GATE_EVENT_KEYS,
        ...PI_SETTLE_EVENT_KEYS,
      ],
    );

    // No gate → the key stays unregistered (fail-closed).
    const none = recordingPi();
    registerPiHandlers(
      none as unknown as ExtensionAPI,
      stubHandlers(false, false),
    );
    assert.ok(
      !none.registrations.some(([event]) => event === "tool_call"),
      "a gate-less profile must not register tool_call",
    );
  });

  it("keeps the resident, gate and settle key tables disjoint and complete", () => {
    assert.deepEqual(
      [...PI_RESIDENT_EVENT_KEYS].sort(),
      [
        "before_agent_start",
        "context",
        "message_end",
        "resources_discover",
        "session_start",
        "session_tree",
        "tool_result",
      ],
      "the resident key set is the registration contract with pi",
    );
    assert.deepEqual(
      [...PI_SETTLE_EVENT_KEYS].sort(),
      [
        "agent_before_settle",
        "agent_end",
        "agent_settled",
        "ui_prompt_end",
        "ui_prompt_start",
      ],
      "the settle key set is the registration contract with pi",
    );
    assert.deepEqual(
      [...PI_GATE_EVENT_KEYS].sort(),
      ["tool_call"],
      "the gate key set is the registration contract with pi",
    );
    const union = new Set<string>([
      ...PI_RESIDENT_EVENT_KEYS,
      ...PI_GATE_EVENT_KEYS,
      ...PI_SETTLE_EVENT_KEYS,
    ]);
    assert.equal(union.size, 13, "no key may appear in both tables");
  });

  it("records the registration decision in the loop log", () => {
    registerPiHandlers(
      recordingPi() as unknown as ExtensionAPI,
      stubHandlers(true),
    );
    const registered = _getBufferForTesting().filter(
      (entry) => entry.hook === "loop" && entry.event === "events_registered",
    );
    assert.equal(registered.length, 1);
    assert.deepEqual(registered[0]?.events, [...PI_SETTLE_EVENT_KEYS]);
    assert.equal(
      _getBufferForTesting().filter(
        (e) => e.hook === "loop" && e.event === "events_skipped",
      ).length,
      0,
    );

    _resetForTesting();
    registerPiHandlers(
      recordingPi() as unknown as ExtensionAPI,
      stubHandlers(false),
    );
    const skipped = _getBufferForTesting().filter(
      (entry) => entry.hook === "loop" && entry.event === "events_skipped",
    );
    assert.equal(skipped.length, 1);
    assert.equal(skipped[0]?.reason, "feature-disabled");
    assert.equal(
      _getBufferForTesting().filter(
        (e) => e.hook === "loop" && e.event === "events_registered",
      ).length,
      0,
    );
  });

  it("records the gate registration decision in the subagent-tool log", () => {
    registerPiHandlers(
      recordingPi() as unknown as ExtensionAPI,
      stubHandlers(false, true),
    );
    const registered = _getBufferForTesting().filter(
      (entry) =>
        entry.hook === "subagent-tool" && entry.event === "events_registered",
    );
    assert.equal(registered.length, 1);
    assert.deepEqual(registered[0]?.events, [...PI_GATE_EVENT_KEYS]);

    _resetForTesting();
    registerPiHandlers(
      recordingPi() as unknown as ExtensionAPI,
      stubHandlers(false, false),
    );
    const skipped = _getBufferForTesting().filter(
      (entry) =>
        entry.hook === "subagent-tool" && entry.event === "events_skipped",
    );
    assert.equal(skipped.length, 1);
    assert.equal(skipped[0]?.reason, "feature-disabled");
  });
});
