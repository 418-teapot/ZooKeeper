/**
 * Tests for the profile-driven pi extension (`src/pi.ts`).
 *
 * Covers: `buildPiContributions` composing the full registry from the
 * active `[zoo.mode.*]` profile (agents/skills/hooks/tools/commands,
 * unconditional pruning contribution, dolphin Map gating, null/invalid
 * profile → empty composition), `buildPiHandlers` wiring the five hook
 * handlers (dolphin prompt injection, skill discovery, compose-driven
 * `tool_result` nudge gating, native `context` handler returning the pruned
 * replacement, `message_end` ref-stripping), and the thin entry
 * (`zookeeperPi`) against the real config.toml.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import type { ToolHost } from "./core/client/tool-host.js";
import {
  DIRECT_WORK_NUDGE,
  JSON_ERROR_REMINDER_MARKER,
} from "./core/prompts.js";
import {
  buildPiContributions,
  buildPiDcpEntryRenderer,
  buildPiHandlers,
  zookeeperPi,
} from "./pi.js";
import { validateCompressArgs } from "./tools/compress.js";
import {
  _flushForTesting,
  _getBufferForTesting,
  _resetForTesting,
  initLogger,
  log,
} from "./utils/logger.js";
import { withModeFile } from "./utils/mode-file.js";

/** The poly profile (mirrors the `[zoo.mode.poly]` lists). */
const POLY_PROFILE = {
  agents: ["dolphin", "mola", "beaver", "lynx", "spider", "eagle", "kiwi"],
  skills: [
    "beaver-tdd",
    "code-review",
    "first-principles",
    "git-commit",
    "grill",
    "kiwi-distill",
    "kiwi-verify",
    "mola-plan",
    "wiki-ingest",
    "wiki-query",
    "wiki-verify",
  ],
  hooks: [
    "task-prompt",
    "task-delegation",
    "direct-work-nudge",
    "post-task-nudge",
    "json-error-nudge",
    "context-pruning",
  ],
  tools: ["compress", "decompress"],
  commands: ["go", "dcp"],
};

/** A full zoo config carrying the poly profile. */
const POLY_ZOO = {
  validation: { context_word_limit: 200, prompt_word_limit: 500 },
  context: { protected_messages: 20, released_percent: 10 },
  mode: { poly: POLY_PROFILE },
};

/** Session context shared by the handler tests. */
const SESSION_CTX = { sessionManager: { getSessionId: () => "sess-1" } };

/** A minimal stand-in for pi's ExtensionAPI that records handlers. */
function mockApi(): {
  handlers: Record<string, (...args: any[]) => unknown>;
  tools: unknown[];
  commands: Array<{ name: string; description?: string; handler: unknown }>;
  appendedEntries: Array<{ customType: string; data?: unknown }>;
  renderers: Array<{ customType: string; renderer: unknown }>;
  on(event: string, handler: (...args: any[]) => unknown): void;
  registerTool(tool: unknown): void;
  registerCommand(name: string, options: unknown): void;
  appendEntry(customType: string, data?: unknown): void;
  registerEntryRenderer(customType: string, renderer: unknown): void;
} {
  const handlers: Record<string, (...args: any[]) => unknown> = {};
  const tools: unknown[] = [];
  const commands: Array<{
    name: string;
    description?: string;
    handler: unknown;
  }> = [];
  const appendedEntries: Array<{ customType: string; data?: unknown }> = [];
  const renderers: Array<{ customType: string; renderer: unknown }> = [];
  return {
    on(event, handler) {
      handlers[event] = handler;
    },
    registerTool(tool) {
      tools.push(tool);
    },
    registerCommand(name, options) {
      const opts = options as { description?: string; handler: unknown };
      commands.push({
        name,
        description: opts.description,
        handler: opts.handler,
      });
    },
    appendEntry(customType, data) {
      appendedEntries.push({ customType, data });
    },
    registerEntryRenderer(customType, renderer) {
      renderers.push({ customType, renderer });
    },
    handlers,
    tools,
    commands,
    appendedEntries,
    renderers,
  };
}

/** Join the text of the content parts a tool_result handler returns. */
function joinedText(
  result: { content?: { type: string; text?: string }[] } | undefined,
): string {
  return (result?.content ?? [])
    .map((part) => (part.type === "text" ? (part.text ?? "") : ""))
    .join("");
}

afterEach(() => {
  _resetForTesting();
  delete process.env.ZOO_MODE_FILE;
});

// ---------------------------------------------------------------------------
// Profile-driven selection
// ---------------------------------------------------------------------------

describe("buildPiContributions — profile-driven selection", () => {
  it("poly full profile → 7 agents incl. dolphin prompt, 11 skills", () => {
    const { composed, profile } = buildPiContributions(POLY_ZOO);
    assert.equal(profile?.name, "poly");
    assert.equal(composed.agents.length, 7);
    assert.equal(composed.skills.length, 11);
    const dolphin = composed.agents.find((a) => a.name === "dolphin");
    assert.ok(dolphin, "dolphin must be composed");
    assert.ok(dolphin.prompt.startsWith("<Role>"));
    assert.ok(dolphin.prompt.includes("DELEGATE"));
  });

  it("poly full profile → full-registry composition incl. hooks/tools/commands", () => {
    const { composed } = buildPiContributions(POLY_ZOO);
    // afterExec from the registry's hook units, in registry order.
    assert.deepEqual(
      composed.afterExec.map((h) => h.name),
      [
        "nudgeTaskOutput",
        "recoverJsonError",
        "nudgeDirectWork",
        "nudgePostTask",
      ],
    );
    // context-pruning is no longer gated on client capabilities — the
    // unit contributes unconditionally, so the transform handler
    // appears.
    assert.deepEqual(
      composed.transform.map((h) => h.name),
      ["contextPruning"],
    );
    assert.deepEqual(
      composed.beforeExec.map((h) => h.name),
      ["validateBeforeExec", "validateDelegationTarget"],
    );
    // Tool/command units instantiate but pi never consumes their slots.
    assert.deepEqual(Object.keys(composed.tools).sort(), [
      "compress",
      "decompress",
    ]);
    assert.deepEqual(Object.keys(composed.commands).sort(), ["dcp", "go"]);
  });

  it("commandToolHost re-composes the commands slot with the command host", async () => {
    // The entry point supplies a command-specific tool host so slash
    // command chat notifications route through pi's `appendEntry`
    // channel.  A second composition pass with that host must replace
    // the commands slot while leaving the other slots untouched.
    const baseToolHost: ToolHost = {
      resolveSessionId: () => "sess",
      fetchHistory: async () => [],
      notify: async () => {},
    };
    let commandHostNotified = "";
    const commandToolHost: ToolHost = {
      ...baseToolHost,
      notify: async (_sessionID, text) => {
        commandHostNotified = text;
      },
    };
    const { composed } = buildPiContributions(POLY_ZOO, {
      toolHost: baseToolHost,
      commandToolHost,
    });

    // Commands re-composed with the command host: /dcp help routes
    // through the command host's notify.
    await composed.commands.dcp.handle({
      command: "dcp",
      sessionID: "sess",
      arguments: "foobar",
    });
    assert.ok(commandHostNotified.includes("用法"), "command host notify used");

    // The non-command slots still carry the base host (tool toast path).
    assert.deepEqual(Object.keys(composed.commands).sort(), ["dcp", "go"]);
  });

  it("agents=[dolphin] → only dolphin, no skills", () => {
    const zoo = {
      ...POLY_ZOO,
      mode: { poly: { ...POLY_PROFILE, agents: ["dolphin"], skills: [] } },
    };
    const { composed } = buildPiContributions(zoo);
    assert.deepEqual(
      composed.agents.map((a) => a.name),
      ["dolphin"],
    );
    assert.deepEqual(composed.skills, []);
  });

  it("agents=[mola] → no dolphin contribution", () => {
    const zoo = {
      ...POLY_ZOO,
      mode: { poly: { ...POLY_PROFILE, agents: ["mola"] } },
    };
    const { composed } = buildPiContributions(zoo);
    assert.deepEqual(
      composed.agents.map((a) => a.name),
      ["mola"],
    );
  });

  it("empty agents/skills lists → empty contributions", () => {
    const zoo = {
      mode: { poly: { ...POLY_PROFILE, agents: [], skills: [] } },
    };
    const { composed } = buildPiContributions(zoo);
    assert.deepEqual(composed.agents, []);
    assert.deepEqual(composed.skills, []);
  });

  it("absent zoo.mode → null profile, empty contributions", () => {
    const { composed, profile } = buildPiContributions({});
    assert.equal(profile, null);
    assert.deepEqual(composed.agents, []);
    assert.deepEqual(composed.skills, []);
    assert.deepEqual(composed.afterExec, []);
    assert.deepEqual(composed.transform, []);
  });

  it("poly full profile → no unknown_unit warnings (all names match the registry)", () => {
    // pi composes the full profile against the full registry: every
    // hooks/tools/commands/agents/skills name must match a unit or the
    // selection engine warns.
    buildPiContributions(POLY_ZOO);
    const unknownUnits = _getBufferForTesting().filter(
      (entry) => entry.event === "unknown_unit",
    );
    assert.deepEqual(unknownUnits, []);
  });

  it("unknown hooks/tools profile names reach the unknown_unit warning path", () => {
    // Unlike the old agent/skill-only narrowing, the full-profile
    // composition surfaces unmatched category names to the engine.
    const zoo = {
      mode: {
        poly: {
          ...POLY_PROFILE,
          hooks: [...POLY_PROFILE.hooks, "ghost-hook"],
          tools: [...POLY_PROFILE.tools, "ghost-tool"],
        },
      },
    };
    buildPiContributions(zoo);
    const unknownUnits = _getBufferForTesting().filter(
      (entry) => entry.event === "unknown_unit",
    );
    assert.deepEqual(
      unknownUnits.map((u) => u.name),
      ["ghost-hook", "ghost-tool"],
    );
  });

  it("command-host re-composition does not duplicate unknown_unit warnings", () => {
    // The second composition pass (command tool host) only re-composes
    // the commands slot.  An unknown non-command name must be warned
    // exactly once by the first pass — the re-composition must not fire
    // the same unknown_unit warnings again.
    const host: ToolHost = {
      resolveSessionId: () => "sess",
      fetchHistory: async () => [],
      notify: async () => {},
    };
    const zoo = {
      mode: {
        poly: {
          ...POLY_PROFILE,
          hooks: [...POLY_PROFILE.hooks, "ghost-hook"],
        },
      },
    };
    buildPiContributions(zoo, {
      toolHost: host,
      commandToolHost: host,
    });
    const unknownUnits = _getBufferForTesting().filter(
      (entry) => entry.event === "unknown_unit",
    );
    assert.deepEqual(
      unknownUnits.map((u) => u.name),
      ["ghost-hook"],
      "unknown name must be warned exactly once",
    );
  });

  it("ambiguous zoo.mode (two tables) → null profile, empty contributions", () => {
    // No mode state file: multi-profile selection must fail closed.
    process.env.ZOO_MODE_FILE = join(
      tmpdir(),
      "zoo-mode-test-nonexistent.json",
    );
    const zoo = {
      mode: { poly: POLY_PROFILE, slim: { agents: [], skills: [] } },
    };
    const { composed, profile } = buildPiContributions(zoo);
    assert.equal(profile, null);
    assert.deepEqual(composed.agents, []);
    assert.deepEqual(composed.skills, []);
  });
});

// ---------------------------------------------------------------------------
// Prompt injection + skill discovery handlers
// ---------------------------------------------------------------------------

describe("buildPiHandlers — prompt injection + skill discovery", () => {
  it("poly full → dolphin prompt prepended, all 11 skill dirs discovered", async () => {
    const handlers = buildPiHandlers(POLY_ZOO);
    const result = await handlers.beforeAgentStart({
      systemPrompt: "base",
    });
    assert.ok(result.systemPrompt.startsWith("<Role>"));
    assert.ok(result.systemPrompt.endsWith("base"));

    const resources = await handlers.resourcesDiscover();
    assert.equal(resources.skillPaths.length, 11);
    for (const path of resources.skillPaths) {
      assert.ok(fs.existsSync(path), `${path} must exist`);
      assert.ok(
        POLY_PROFILE.skills.some((name) => path.endsWith(name)),
        `${path} must match a profile skill`,
      );
    }
  });

  it("null profile → prompt untouched, no skill paths", async () => {
    const handlers = buildPiHandlers({});
    const result = await handlers.beforeAgentStart({
      systemPrompt: "base",
    });
    assert.equal(result.systemPrompt, "base");

    const resources = await handlers.resourcesDiscover();
    assert.deepEqual(resources.skillPaths, []);
  });

  it("profile without dolphin → prompt untouched; skills filtered", async () => {
    const zoo = {
      mode: {
        poly: { ...POLY_PROFILE, agents: ["mola"], skills: ["git-commit"] },
      },
    };
    const handlers = buildPiHandlers(zoo);
    const result = await handlers.beforeAgentStart({
      systemPrompt: "base",
    });
    assert.equal(result.systemPrompt, "base");

    const resources = await handlers.resourcesDiscover();
    assert.equal(resources.skillPaths.length, 1);
    assert.ok(resources.skillPaths[0].endsWith("git-commit"));
  });
});

// ---------------------------------------------------------------------------
// Compose-driven tool_result handler
// ---------------------------------------------------------------------------

describe("buildPiHandlers — compose-driven tool_result", () => {
  it("json-error-nudge in hooks → JSON reminder appended to error output", async () => {
    const handlers = buildPiHandlers(POLY_ZOO);
    const result = await handlers.toolResult(
      {
        type: "tool_result",
        toolName: "browser",
        toolCallId: "call-json",
        content: [{ type: "text", text: "Error: json parse error at line 3" }],
        isError: true,
      },
      SESSION_CTX,
    );
    assert.ok(result, "the reminder must be appended");
    assert.ok(
      joinedText(result).includes(JSON_ERROR_REMINDER_MARKER),
      "output must carry the JSON reminder marker",
    );
  });

  it("hooks without json-error-nudge → tool_result adds no JSON reminder", async () => {
    const zoo = {
      ...POLY_ZOO,
      mode: {
        poly: {
          ...POLY_PROFILE,
          hooks: POLY_PROFILE.hooks.filter((h) => h !== "json-error-nudge"),
        },
      },
    };
    const handlers = buildPiHandlers(zoo);
    const result = await handlers.toolResult(
      {
        type: "tool_result",
        toolName: "browser",
        toolCallId: "call-json",
        content: [{ type: "text", text: "Error: json parse error at line 3" }],
        isError: true,
      },
      SESSION_CTX,
    );
    assert.equal(result, undefined);
  });

  it("direct-work-nudge in hooks + dolphin agent → edit nudge appended", async () => {
    const handlers = buildPiHandlers(POLY_ZOO);
    const result = await handlers.toolResult(
      {
        type: "tool_result",
        toolName: "edit",
        toolCallId: "call-edit",
        content: [{ type: "text", text: "file.ts updated" }],
        isError: false,
      },
      SESSION_CTX,
    );
    assert.ok(result, "the direct-work nudge must fire");
    assert.ok(
      joinedText(result).includes(DIRECT_WORK_NUDGE),
      "output must carry the delegation reminder",
    );
  });

  it("profile without dolphin → direct-work nudge skipped", async () => {
    const zoo = {
      ...POLY_ZOO,
      mode: { poly: { ...POLY_PROFILE, agents: ["mola"] } },
    };
    const handlers = buildPiHandlers(zoo);
    const result = await handlers.toolResult(
      {
        type: "tool_result",
        toolName: "edit",
        toolCallId: "call-edit",
        content: [{ type: "text", text: "file.ts updated" }],
        isError: false,
      },
      SESSION_CTX,
    );
    assert.equal(result, undefined);
  });

  it("hooks without direct-work-nudge → no delegation nudge even for dolphin", async () => {
    const zoo = {
      ...POLY_ZOO,
      mode: {
        poly: {
          ...POLY_PROFILE,
          hooks: POLY_PROFILE.hooks.filter((h) => h !== "direct-work-nudge"),
        },
      },
    };
    const handlers = buildPiHandlers(zoo);
    const result = await handlers.toolResult(
      {
        type: "tool_result",
        toolName: "edit",
        toolCallId: "call-edit",
        content: [{ type: "text", text: "file.ts updated" }],
        isError: false,
      },
      SESSION_CTX,
    );
    assert.equal(result, undefined);
  });
});

// ---------------------------------------------------------------------------
// Compose-driven context handler
// ---------------------------------------------------------------------------

describe("buildPiHandlers — compose-driven context handler", () => {
  it("returns the native pi messages, possibly modified by pruning", async () => {
    const handlers = buildPiHandlers(POLY_ZOO);
    const result = (await handlers.contextHandler(
      {
        type: "context",
        messages: [{ role: "user", content: "hello" }],
      },
      SESSION_CTX,
    )) as { messages: Array<{ role: string; content: string }> } | undefined;
    assert.ok(result, "context handler must return a result");
    assert.equal(result.messages.length, 1);
    // The pruning pipeline injects the per-round line-number prefix on pi.
    assert.equal(result.messages[0].content, "[m1] hello");
  });

  it("returns an empty replacement for an empty message array", async () => {
    const handlers = buildPiHandlers(POLY_ZOO);
    const result = (await handlers.contextHandler(
      { type: "context", messages: [] },
      SESSION_CTX,
    )) as { messages: unknown[] } | undefined;
    assert.ok(result, "context handler must return a result");
    assert.deepEqual(result.messages, []);
  });
});

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

describe("buildPiHandlers — registerTool wiring", () => {
  it("registers compress and decompress with pi when the profile enables them", () => {
    const api = mockApi();
    buildPiHandlers(POLY_ZOO, api as any);
    const toolNames = api.tools.map((tool: any) => tool.name);
    assert.deepEqual(toolNames.sort(), ["compress", "decompress"]);
  });

  it("sets label to the tool name and wraps parameters in an object schema", () => {
    const api = mockApi();
    buildPiHandlers(POLY_ZOO, api as any);
    const compress = api.tools.find((tool: any) => tool.name === "compress");
    assert.ok(compress);
    assert.equal((compress as any).label, "compress");
    assert.equal((compress as any).parameters.type, "object");
    assert.deepEqual((compress as any).parameters.required, ["ranges"]);
    assert.ok((compress as any).parameters.properties.ranges);
  });

  it("bridged compress schema accepts what validateCompressArgs accepts", () => {
    const api = mockApi();
    buildPiHandlers(POLY_ZOO, api as any);
    const compress = api.tools.find((tool: any) => tool.name === "compress") as
      | {
          parameters: {
            properties: Record<string, unknown>;
            required: string[];
          };
        }
      | undefined;
    assert.ok(compress);

    // Valid input must satisfy both the bridged schema and the tool's own
    // validator.
    const validArgs = {
      ranges: [
        {
          fromRef: "m2",
          toRef: "m3",
          title: "summary",
          summary: "body",
        },
      ],
    };
    assert.doesNotThrow(() => validateCompressArgs(validArgs));
    assert.ok(
      compress.parameters.required.includes("ranges"),
      "schema must require ranges",
    );
    assert.ok(
      "ranges" in compress.parameters.properties,
      "schema must declare ranges",
    );

    // Malformed input is rejected by validateCompressArgs and is missing
    // the required ranges field.
    assert.throws(() => validateCompressArgs({}));
    assert.equal(
      (compress.parameters.required as string[]).includes("ranges"),
      true,
    );
  });

  it("execute wrapper delegates to the contribution and propagates errors", async () => {
    const api = mockApi();
    buildPiHandlers(
      {
        mode: {
          poly: {
            ...POLY_PROFILE,
            tools: ["decompress"],
            hooks: POLY_PROFILE.hooks.filter((h) => h !== "context-pruning"),
          },
        },
      },
      api as any,
    );
    const decompress = api.tools.find(
      (tool: any) => tool.name === "decompress",
    );
    assert.ok(decompress);

    // Missing blockId is rejected by the tool's own validator; the pi
    // execute wrapper does not swallow tool errors.
    await assert.rejects(
      async () =>
        (decompress as any).execute("call-1", {}, undefined, undefined, {
          sessionManager: { getSessionId: () => "sess-decompress" },
        }),
      /blockId/,
    );
  });
});

// ---------------------------------------------------------------------------
// Command registration wiring
// ---------------------------------------------------------------------------

describe("buildPiHandlers — registerCommand wiring", () => {
  it("registers composed commands with pi when the profile enables them", () => {
    const api = mockApi();
    buildPiHandlers(POLY_ZOO, api as any);
    const names = api.commands.map((c) => c.name).sort();
    assert.deepEqual(names, ["dcp", "go"]);
  });

  it("preserves description and a handler on each registration", () => {
    const api = mockApi();
    buildPiHandlers(POLY_ZOO, api as any);
    const dcp = api.commands.find((c) => c.name === "dcp");
    assert.ok(dcp, "dcp must be registered");
    assert.equal(dcp.description, "显示上下文用量与缓存命中率");
    assert.equal(typeof dcp.handler, "function");
  });

  it("null profile registers no commands (fail-closed)", () => {
    const api = mockApi();
    buildPiHandlers({}, api as any);
    assert.deepEqual(api.commands, []);
  });

  it("commands registered for a profile without commands list stay empty", () => {
    const api = mockApi();
    buildPiHandlers(
      {
        mode: {
          poly: { ...POLY_PROFILE, commands: [] },
        },
      },
      api as any,
    );
    assert.deepEqual(api.commands, []);
  });

  it("/dcp context appends a zoo-dcp custom entry (persistent, no LLM context)", async () => {
    const api = mockApi();
    buildPiHandlers(POLY_ZOO, api as any);
    const dcp = api.commands.find((c) => c.name === "dcp");
    assert.ok(dcp && typeof dcp.handler === "function");

    const ctx = {
      sessionManager: {
        getSessionId: () => "sess-dcp",
        buildContextEntries: () => [
          { type: "message", message: { role: "user", content: "hi" } },
        ],
      },
    };
    await (dcp.handler as (args: string, ctx: unknown) => Promise<void>)(
      "context",
      ctx,
    );

    assert.ok(
      api.appendedEntries.length >= 1,
      "dcp must append a custom entry",
    );
    const entry = api.appendedEntries.find((e) => e.customType === "zoo-dcp");
    assert.ok(entry, "dcp report must go through the zoo-dcp custom entry");
    assert.equal(typeof (entry.data as any)?.content, "string");
    assert.ok(String((entry.data as any)?.content).includes("上下文报告"));
  });

  it("/dcp errors route through notifySessionError into appendEntry", async () => {
    const api = mockApi();
    buildPiHandlers(POLY_ZOO, api as any);
    const dcp = api.commands.find((c) => c.name === "dcp");
    assert.ok(dcp && typeof dcp.handler === "function");

    // "sweep 0" is rejected by the sweep count parser, so the handler
    // surfaces the failure through notifySessionError → appendEntry.
    await (dcp.handler as (args: string, ctx: unknown) => Promise<void>)(
      "sweep 0",
      { sessionManager: { getSessionId: () => "sess-dcp" } },
    );

    const entry = api.appendedEntries.find((e) => e.customType === "zoo-dcp");
    assert.ok(entry, "dcp error must be surfaced via appendEntry");
    assert.ok(
      String((entry.data as any)?.content).includes("用法：/dcp sweep"),
    );
  });

  it("commands use the toast notify for tools but appendEntry for /dcp reports", async () => {
    const api = mockApi();
    buildPiHandlers(POLY_ZOO, api as any);

    // The compress tool's runtime notification stays on the toast path —
    // the pi tool host's ui.notify is untouched by the command wiring.
    const compress = api.tools.find((t: any) => t.name === "compress");
    assert.ok(compress, "compress tool must be registered");
    assert.equal(api.appendedEntries.length, 0, "no custom entry appended yet");
  });

  it("registers a zoo-dcp entry renderer with pi", () => {
    const api = mockApi();
    buildPiHandlers(POLY_ZOO, api as any);
    const renderer = api.renderers.find((r) => r.customType === "zoo-dcp");
    assert.ok(renderer, "zoo-dcp entry renderer must be registered");
    assert.equal(typeof renderer.renderer, "function");
  });

  it("non-null profile without dcp enabled registers no renderer", () => {
    // The renderer gate must follow the composed commands slot, not the
    // profile's nullness: a profile that enables no /dcp command needs no
    // zoo-dcp entry renderer even though the profile itself is non-null.
    const api = mockApi();
    buildPiHandlers(
      {
        mode: {
          poly: { ...POLY_PROFILE, commands: [] },
        },
      },
      api as any,
    );
    assert.deepEqual(
      api.renderers.filter((r) => r.customType === "zoo-dcp"),
      [],
      "no zoo-dcp renderer when /dcp is not registered",
    );
  });

  it("non-null profile with dcp enabled still registers the renderer", () => {
    // A profile that registers dcp (but no other command) must register
    // the zoo-dcp entry renderer so reports draw a card in the TUI.
    const api = mockApi();
    buildPiHandlers(
      {
        mode: {
          poly: { ...POLY_PROFILE, commands: ["dcp"] },
        },
      },
      api as any,
    );
    const renderer = api.renderers.find((r) => r.customType === "zoo-dcp");
    assert.ok(renderer, "zoo-dcp entry renderer must be registered");
    assert.equal(typeof renderer.renderer, "function");
  });

  it("null profile registers no renderers (fail-closed)", () => {
    const api = mockApi();
    buildPiHandlers({}, api as any);
    assert.deepEqual(api.renderers, []);
  });
});

// ---------------------------------------------------------------------------
// zoo-dcp entry renderer
// ---------------------------------------------------------------------------

describe("buildPiDcpEntryRenderer", () => {
  it("renders the report text from the entry data content", () => {
    const renderer = buildPiDcpEntryRenderer();
    const theme = { fg: (_color: string, text: string) => text };
    const component = renderer(
      { data: { content: "上下文报告\ntokens: 100" } },
      { expanded: false },
      theme,
    ) as { render(): string[] } | undefined;
    assert.ok(component, "a component must be returned");
    assert.deepEqual(component.render(), [
      "[zoo-dcp]",
      "上下文报告",
      "tokens: 100",
    ]);
  });

  it("uses the themed label when the theme exposes fg", () => {
    const renderer = buildPiDcpEntryRenderer();
    const theme = {
      fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
    };
    const component = renderer(
      { data: { content: "report" } },
      { expanded: false },
      theme,
    ) as { render(): string[] } | undefined;
    assert.ok(component);
    assert.deepEqual(component.render(), [
      "<customMessageLabel>[zoo-dcp]</customMessageLabel>",
      "report",
    ]);
  });

  it("returns undefined for an empty or missing payload", () => {
    const renderer = buildPiDcpEntryRenderer();
    assert.equal(renderer({ data: { content: "" } }, {}, undefined), undefined);
    assert.equal(renderer({ data: undefined }, {}, undefined), undefined);
    assert.equal(
      renderer({ data: { content: "  " } }, {}, undefined),
      undefined,
    );
  });
});

// ---------------------------------------------------------------------------
// Fail-closed behaviour
// ---------------------------------------------------------------------------

describe("buildPiHandlers — null profile fail-closed", () => {
  it("all five handlers no-op with a null profile", async () => {
    const handlers = buildPiHandlers({});
    const prompt = await handlers.beforeAgentStart({ systemPrompt: "base" });
    assert.equal(prompt.systemPrompt, "base");
    assert.deepEqual((await handlers.resourcesDiscover()).skillPaths, []);
    assert.equal(
      await handlers.toolResult(
        {
          type: "tool_result",
          toolName: "edit",
          toolCallId: "call-1",
          content: [{ type: "text", text: "x" }],
          isError: false,
        },
        SESSION_CTX,
      ),
      undefined,
    );
    const contextResult = await handlers.contextHandler(
      { type: "context", messages: [{ role: "user", content: "hi" }] },
      SESSION_CTX,
    );
    assert.deepEqual(contextResult, {
      messages: [{ role: "user", content: "hi" }],
    });
    assert.equal(
      await handlers.messageEnd(
        {
          type: "message_end",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "[m3] hi" }],
          },
        },
        SESSION_CTX,
      ),
      undefined,
    );
  });
});

// ---------------------------------------------------------------------------
// plugin_init load-time event
// ---------------------------------------------------------------------------

describe("buildPiHandlers — plugin_init load-time event", () => {
  it("emits plugin_init once at load with agents/skills/limits fields", () => {
    // Init the logger so the load-time plugin_init is attributed to a
    // temp log dir instead of tripping the one-time used-before-init
    // warning (isolation pattern used across this file).
    const logDir = fs.mkdtempSync(join(tmpdir(), "zoo-pi-log-"));
    try {
      initLogger("pi", { logDir });
      buildPiHandlers(POLY_ZOO);
      const inits = _getBufferForTesting().filter(
        (entry) => entry.event === "plugin_init",
      );
      assert.equal(inits.length, 1, "exactly one plugin_init at load");
      const init = inits[0];
      assert.equal(init.hook, "plugin");
      assert.equal(init.sessionId, "");
      assert.equal(init.level, "info");
      assert.deepEqual(
        init.agents,
        POLY_PROFILE.agents,
        "agents must list the composed agent names",
      );
      assert.deepEqual(
        init.skills,
        POLY_PROFILE.skills,
        "skills must list the composed skill names",
      );
      assert.deepEqual(init.limits, {
        contextWordLimit: 200,
        promptWordLimit: 500,
      });
    } finally {
      try {
        fs.rmSync(logDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  });

  it("null profile → plugin_init with empty agents/skills", () => {
    const logDir = fs.mkdtempSync(join(tmpdir(), "zoo-pi-log-"));
    try {
      initLogger("pi", { logDir });
      buildPiHandlers({});
      const inits = _getBufferForTesting().filter(
        (entry) => entry.event === "plugin_init",
      );
      assert.equal(inits.length, 1);
      assert.deepEqual(inits[0].agents, []);
      assert.deepEqual(inits[0].skills, []);
    } finally {
      try {
        fs.rmSync(logDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  });

  it("buffers plugin_init sessionless; flush into the first pi session's file", () => {
    const logDir = fs.mkdtempSync(join(tmpdir(), "zoo-pi-log-"));
    try {
      initLogger("pi", { logDir });
      buildPiHandlers(POLY_ZOO);

      // Load-time plugin_init is sessionless and no session exists yet:
      // it stays buffered and no pi.log host-level file is created.
      _flushForTesting();
      assert.equal(
        fs.existsSync(join(logDir, "pi.log")),
        false,
        "no host-level pi.log may be created",
      );
      assert.ok(
        _getBufferForTesting().some((e) => e.event === "plugin_init"),
        "plugin_init must remain buffered until a session exists",
      );

      // The first sessioned entry establishes the primary pi session;
      // the buffered plugin_init now flushes into its file.
      log("plugin", "handler", "pi-sess", undefined, "info");
      _flushForTesting();

      const primaryFile = join(logDir, "pi-pi-sess.log");
      assert.ok(
        fs.existsSync(primaryFile),
        "primary pi session file must exist",
      );
      const lines = fs.readFileSync(primaryFile, "utf-8").trimEnd().split("\n");
      const events = lines.map((line) => JSON.parse(line).event);
      assert.ok(
        events.includes("plugin_init"),
        "buffered plugin_init must land in the first pi session's file",
      );
      assert.equal(
        fs.existsSync(join(logDir, "pi.log")),
        false,
        "no host-level pi.log may be created",
      );
    } finally {
      try {
        fs.rmSync(logDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Thin entry wiring
// ---------------------------------------------------------------------------

describe("zookeeperPi — thin entry wiring", () => {
  it("registers all five hooks against the real config.toml (poly full)", async () => {
    // The real config.toml carries [zoo.mode.poly] (and a second
    // [zoo.mode.mono] sub-table).  Point the mode state file at poly so
    // the entry selects the full profile.
    await withModeFile(JSON.stringify({ mode: "poly" }), async () => {
      const api = mockApi();
      zookeeperPi(api as any);
      assert.equal(typeof api.handlers.before_agent_start, "function");
      assert.equal(typeof api.handlers.resources_discover, "function");
      assert.equal(typeof api.handlers.tool_result, "function");
      assert.equal(typeof api.handlers.context, "function");
      assert.equal(typeof api.handlers.message_end, "function");

      // The extension load logs a single plugin_init startup anchor with
      // the composed agents/skills/limits (mirrors the OpenCode host).
      const inits = _getBufferForTesting().filter(
        (entry) => entry.event === "plugin_init",
      );
      assert.equal(
        inits.length,
        1,
        "exactly one plugin_init at extension load",
      );
      const init = inits[0];
      assert.equal(init.hook, "plugin");
      assert.equal(init.sessionId, "");
      assert.equal(init.level, "info");
      assert.equal(
        (init.agents as string[]).length,
        7,
        "real poly profile composes 7 agents",
      );
      assert.equal(
        (init.skills as string[]).length,
        11,
        "real poly profile composes 11 skills",
      );
      assert.deepEqual(init.limits, {
        contextWordLimit: 200,
        promptWordLimit: 500,
      });

      // The zoo-dcp entry renderer is registered against the real
      // config.toml profile so dcp reports render in the TUI.
      assert.ok(
        api.renderers.some(
          (r) => r.customType === "zoo-dcp" && typeof r.renderer === "function",
        ),
        "zoo-dcp renderer must be registered",
      );

      const prompt = (await api.handlers.before_agent_start({
        systemPrompt: "base",
      })) as { systemPrompt: string };
      assert.ok(prompt.systemPrompt.startsWith("<Role>"));

      const resources = (await api.handlers.resources_discover()) as {
        skillPaths: string[];
      };
      assert.equal(resources.skillPaths.length, 11);

      // tool_result runs the real poly hooks: json-error-nudge is
      // enabled there, so a JSON parse error output gets the reminder.
      const toolResult = (await api.handlers.tool_result(
        {
          type: "tool_result",
          toolName: "browser",
          toolCallId: "call-json",
          content: [
            { type: "text", text: "Error: json parse error at line 3" },
          ],
          isError: true,
        },
        SESSION_CTX,
      )) as { content: { type: string; text?: string }[] } | undefined;
      assert.ok(
        toolResult,
        "json-error-nudge must fire on the real poly profile",
      );
      assert.ok(
        joinedText(toolResult).includes(JSON_ERROR_REMINDER_MARKER),
        "output must carry the JSON reminder marker",
      );

      // message_end strips model-imitated line-start ref echoes from
      // finalized assistant text.
      const messageEnd = (await api.handlers.message_end(
        {
          type: "message_end",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "[m3] hello" }],
          },
        },
        SESSION_CTX,
      )) as
        | {
            message: {
              role: string;
              content: { type: string; text: string }[];
            };
          }
        | undefined;
      assert.ok(messageEnd);
      assert.equal(messageEnd?.message?.content[0]?.text, "hello");
    });
  });
});
