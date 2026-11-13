/**
 * Tests for the pi registration boundary (`src/adapters/pi/registration.ts`).
 *
 * Covers: the command-slot assembly (`buildPiCommandRegistrationPlan`), the
 * registration-boundary tool-definition application
 * (`applyToolDefinitionContributions`), and the event-key registration
 * (`registerPiHandlers`) with its gate and settle keys.
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { SUBAGENT_PROMPT_HINT } from "../../agents/parts.js";
import type { ComposedResult } from "../../core/compose.js";
import type {
  CommandInput,
  ToolContribution,
  ToolDefinitionView,
} from "../../core/unit.js";
import { enhanceSubagentDefinition } from "../../hooks/subagent-prompt/index.js";
import { _getBufferForTesting, _resetForTesting } from "../../utils/logger.js";
import {
  applyToolDefinitionContributions,
  buildPiCommandRegistrationPlan,
  registerPiHandlers,
} from "./registration.js";
import type { ExtensionAPI, PiEventHandlers } from "./types.js";

afterEach(() => {
  _resetForTesting();
});

// ---------------------------------------------------------------------------
// buildPiCommandRegistrationPlan
// ---------------------------------------------------------------------------

describe("buildPiCommandRegistrationPlan", () => {
  it("produces one registration per composed command with description passthrough", () => {
    const commands: ComposedResult["commands"] = {
      custom: {
        name: "custom",
        description: "custom description",
        handle: async () => {},
      },
    };
    const plan = buildPiCommandRegistrationPlan(commands);
    assert.equal(plan.length, 1);
    assert.equal(plan[0].name, "custom");
    assert.equal(plan[0].description, "custom description");
    assert.equal(typeof plan[0].handler, "function");
  });

  it("resolves the sessionID from ctx and passes arguments to the contribution", async () => {
    let captured: CommandInput | undefined;
    const commands: ComposedResult["commands"] = {
      custom: {
        name: "custom",
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
      command: "custom",
      sessionID: "sess-pi",
      arguments: "context",
    });
  });

  it("falls back to an empty session id when the context has no sessionManager", async () => {
    let captured: CommandInput | undefined;
    const commands: ComposedResult["commands"] = {
      custom: {
        name: "custom",
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

  it("carries the contribution's replacing claim", () => {
    const commands: ComposedResult["commands"] = {
      go: {
        name: "go",
        description: "go",
        replacesSession: true,
        handle: async () => {},
      },
      custom: {
        name: "custom",
        description: "custom",
        handle: async () => {},
      },
    };
    assert.deepEqual(
      buildPiCommandRegistrationPlan(commands).map((registration) => [
        registration.name,
        registration.replacesSession,
      ]),
      [
        ["go", true],
        ["custom", false],
      ],
    );
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
      return { text: "done" };
    },
  };
}

describe("applyToolDefinitionContributions", () => {
  it("returns the tools unchanged for an empty contribution chain", async () => {
    const tool = subagentToolWithArgs();
    const tools = await applyToolDefinitionContributions(
      { subagent: tool },
      [],
    );
    assert.equal(tools.subagent, tool, "no enhancers must pass tools through");
  });

  it("appends SUBAGENT_PROMPT_HINT to the subagent prompt description when subagent-prompt is composed", async () => {
    const tool = subagentToolWithArgs();
    const tools = await applyToolDefinitionContributions(
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

  it("keeps the tool arguments hint-free when no subagent-prompt contribution is composed", async () => {
    const tool = subagentToolWithArgs();
    const noop = [{ name: "no-op", handle: () => {} }];
    const tools = await applyToolDefinitionContributions(
      { subagent: tool },
      noop,
    );
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

  it("leaves non-subagent tools untouched (identity preserved)", async () => {
    const compress: ToolContribution = {
      name: "compress",
      description: "compress message ranges",
      args: { ranges: { type: "array", description: "ranges" } },
      async execute() {
        return { text: "compressed" };
      },
    };
    const tools = await applyToolDefinitionContributions(
      { subagent: subagentToolWithArgs(), compress },
      HINT_CONTRIBUTIONS,
    );
    assert.equal(tools.compress, compress, "foreign tools must pass through");
  });

  it("does not mutate the input tool map (pure boundary)", async () => {
    const tool = subagentToolWithArgs();
    const before = tool.args?.prompt as { description?: string } | undefined;
    await applyToolDefinitionContributions(
      { subagent: tool },
      HINT_CONTRIBUTIONS,
    );
    assert.equal(before?.description, "完整任务说明");
  });

  it("awaits an asynchronous enhancer before writing its change back", async () => {
    const tool = subagentToolWithArgs();
    const contributions = [
      {
        name: "async-enhancer",
        handle: async (view: ToolDefinitionView) => {
          await Promise.resolve();
          const prompt = view.args?.prompt;
          if (prompt) prompt.description = "async-enriched";
        },
      },
    ];

    const tools = await applyToolDefinitionContributions(
      { subagent: tool },
      contributions,
    );

    const prompt = tools.subagent.args?.prompt as
      | { description?: string }
      | undefined;
    assert.equal(
      prompt?.description,
      "async-enriched",
      "an async enhancer must be awaited before write-back",
    );
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
    messageEnd: async () => undefined,
    toolCall: async () => undefined,
    sessionStart: async () => {},
    sessionShutdown: async () => {},
    sessionTree: async () => {},
    hasSettledHandlers,
    hasGateHandlers,
    agentEnd: async () => {},
    beforeSettle: async () => ({}),
    agentSettled: async () => {},
    uiPromptStart: async () => {},
    uiPromptEnd: async () => {},
  };
}

describe("registerPiHandlers", () => {
  it("binds each resident key to its own handler, in order", () => {
    const pi = recordingPi();
    const handlers = stubHandlers(false);
    registerPiHandlers(pi as unknown as ExtensionAPI, handlers);
    assert.deepEqual(
      pi.registrations.map(([event]) => event),
      [
        "session_start",
        "session_shutdown",
        "before_agent_start",
        "resources_discover",
        "tool_result",
        "context",
        "message_end",
        "session_tree",
      ],
      "only the resident keys register without a settle handler",
    );
    // Each key must carry ITS handler, not a neighbour's: a swapped pair
    // would silently disable one event and mis-fire another.
    const expected: Record<string, unknown> = {
      session_start: handlers.sessionStart,
      session_shutdown: handlers.sessionShutdown,
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
      [
        "session_start",
        "session_shutdown",
        "before_agent_start",
        "resources_discover",
        "tool_result",
        "context",
        "message_end",
        "session_tree",
        "agent_end",
        "agent_before_settle",
        "agent_settled",
        "ui_prompt_start",
        "ui_prompt_end",
      ],
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
      [
        "session_start",
        "session_shutdown",
        "before_agent_start",
        "resources_discover",
        "tool_result",
        "context",
        "message_end",
        "session_tree",
        "tool_call",
      ],
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
        "session_start",
        "session_shutdown",
        "before_agent_start",
        "resources_discover",
        "tool_result",
        "context",
        "message_end",
        "session_tree",
        "tool_call",
        "agent_end",
        "agent_before_settle",
        "agent_settled",
        "ui_prompt_start",
        "ui_prompt_end",
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

  it("records the registration decision in the loop log", () => {
    registerPiHandlers(
      recordingPi() as unknown as ExtensionAPI,
      stubHandlers(true),
    );
    const registered = _getBufferForTesting().filter(
      (entry) => entry.hook === "loop" && entry.event === "events_registered",
    );
    assert.equal(registered.length, 1);
    assert.deepEqual(registered[0]?.events, [
      "agent_end",
      "agent_before_settle",
      "agent_settled",
      "ui_prompt_start",
      "ui_prompt_end",
    ]);
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
    assert.deepEqual(registered[0]?.events, ["tool_call"]);

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
