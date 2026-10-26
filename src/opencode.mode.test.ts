/**
 * Tests for profile-driven registration composition in `buildPlugin`.
 *
 * Covers: poly-full registration parity with the full hook key set,
 * event-key composition by the enabled hook set (tool.definition /
 * tool.execute.before / tool.execute.after / messages.transform),
 * command atomic registration (go / dcp), tool / skill / agent gating by
 * the profile lists, and the null-profile skip (no registration, but the
 * infrastructure hooks keep working).
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { DELEGATION_LEAF_AGENTS_HEADER } from "./agents/parts.js";
import {
  COMMAND_HANDLED,
  normalizeToolName,
  registerProfileToolsInConfig,
} from "./compose-opencode.js";
import { _resetContextStateManagerForTesting } from "./core/context/runtime.js";
import { sessionAgentRegistry } from "./core/session-agent.js";
import type { AgentUnitDescriptor } from "./core/unit.js";
import { DIRECT_WORK_NUDGE } from "./hooks/direct-work-nudge";
import { JSON_ERROR_REMINDER } from "./hooks/json-error-nudge";
import { VERIFY_REMINDER } from "./hooks/post-subagent-nudge";
import { SUBAGENT_PROMPT_HINT } from "./hooks/subagent-prompt";
import { buildPlugin, zookeeper } from "./opencode.js";
import { REGISTRY } from "./registry.js";
import { composeToolHooks } from "./testkits/config.js";
import { withModeFile } from "./testkits/mode-file.js";
import { _getBufferForTesting, _resetForTesting } from "./utils/logger.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * The poly profile (mirrors the config.toml lists the parallel
 * task adds to `[zoo.mode.poly]`).
 *
 * The tools list carries `todo` exactly as config.toml does: the OpenCode
 * host supplies no todo candidate source, so the unit must fail closed and
 * keep `todo` off both the tool surface and `experimental.primary_tools`.
 */
const POLY_PROFILE = {
  agents: ["dolphin", "mola", "beaver", "lynx", "spider", "eagle", "kiwi"],
  skills: [
    "beaver-tdd",
    "code-review",
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
    "subagent-prompt",
    "subagent-delegation",
    "direct-work-nudge",
    "post-subagent-nudge",
    "json-error-nudge",
    "context-pruning",
    "reply-strip",
  ],
  tools: ["compress", "decompress", "todo"],
  commands: ["go", "dcp"],
};

/**
 * A full zoo config with the poly profile, mirroring config.toml's
 * `[zoo.context]` values so the tool flow tests keep their thresholds.
 */
const POLY_ZOO: Record<string, unknown> = {
  validation: { context_word_limit: 200, prompt_word_limit: 500 },
  context: {
    protected_messages: 20,
    released_percent: 10,
    dedup: { min_messages: 20, threshold_context: 100000, protected_tools: [] },
    purge_errors: {
      min_messages: 20,
      threshold_context: 100000,
      protected_tools: [],
    },
    compress: {
      threshold_tokens: 2000,
      protected_tokens: 20000,
      max_ranges: 8,
    },
    decompress: { max_fill_percent: 90 },
    nudge: {
      min_context: "60%",
      min_context_cap: 200000,
      max_context: "80%",
      max_context_cap: 300000,
      growth_tokens: "5%",
    },
  },
  mode: { poly: POLY_PROFILE },
};

/**
 * Raw config carrying each profile agent's role (mirrors the top-level
 * `[agent.<name>].mode` tables of config.toml).
 *
 * The host declares dolphin as its orchestrator, so the fixture must
 * provide it as a primary — an empty role table would leave the profile
 * invalid and register nothing.
 */
const POLY_RAW: Record<string, unknown> = {
  agent: {
    dolphin: { mode: "primary" },
    mola: { mode: "primary" },
    beaver: { mode: "subagent" },
    lynx: { mode: "subagent" },
    spider: { mode: "subagent" },
    eagle: { mode: "subagent" },
    kiwi: { mode: "subagent" },
  },
};

/**
 * A client stub carrying the host config the plugin pre-reads.
 *
 * The real OpenCode SDK client exposes both `config.get` and
 * `session.get`; the stub answers `config.get` with the same agent table
 * `install.py` writes and lets a test override either method.
 *
 * @param extra - Per-test method overrides (e.g. a `session` stub).
 * @returns The client stub.
 */
function hostClient(extra: Record<string, unknown> = {}): Record<string, any> {
  return {
    config: { get: async () => ({ data: hostConfig() }) },
    session: { get: async () => ({}) },
    ...extra,
  };
}

/** Build a plugin with the given zoo config and input. */
function makePlugin(
  zooConfig: Record<string, unknown> = POLY_ZOO,
  input: Record<string, unknown> = { client: hostClient() },
): Promise<Record<string, any>> {
  return buildPlugin(input, zooConfig, POLY_RAW) as Promise<
    Record<string, any>
  >;
}

/**
 * Build the host `config.agent` table `install.py` generates for the poly
 * profile: every named agent materialised with the mode config.toml
 * declares.  The config hook validates the selection against this table.
 */
function hostConfig(
  names: readonly string[] = POLY_PROFILE.agents,
): Record<string, any> {
  const modes = POLY_RAW.agent as Record<string, { mode: string }>;
  const agent: Record<string, any> = {};
  for (const name of names) {
    agent[name] = { mode: modes[name].mode };
  }
  return { agent };
}

/** A valid task() prompt whose CONTEXT contains a code block (soft warning). */
const PROMPT_WITH_CODE_BLOCK =
  "SUMMARY: Fix stuff\n" +
  "CONTEXT: See the block ```js\ncode\n``` around line 42\n" +
  "ACCEPTANCE: Tests pass";

/** A task() prompt missing the ACCEPTANCE section (hard error). */
const INVALID_PROMPT = "SUMMARY: Fix stuff\nCONTEXT: Short context";

/** Minimal messages for the messages.transform composition tests. */
function transformMessages(): Array<Record<string, any>> {
  return [
    {
      info: { role: "user", id: "u1", sessionID: "sess-transform" },
      parts: [{ type: "text", text: "hello" }],
    },
    {
      info: {
        role: "assistant",
        id: "a1",
        sessionID: "sess-transform",
        tokens: { input: 10, output: 5 },
      },
      parts: [{ type: "text", text: "world" }],
    },
  ];
}

afterEach(() => {
  _resetForTesting();
  sessionAgentRegistry.clear();
  _resetContextStateManagerForTesting();
  delete process.env.ZOO_MODE_FILE;
});

function logEvents(): Array<Record<string, unknown>> {
  return _getBufferForTesting();
}

// ---------------------------------------------------------------------------
// Poly full profile — registration parity
// ---------------------------------------------------------------------------

describe("poly full profile — registration parity", () => {
  it("registers exactly the full hook key set", async () => {
    const plugin = await makePlugin();
    assert.deepEqual(
      Object.keys(plugin).sort(),
      [
        "command.execute.before",
        "config",
        "event",
        "experimental.chat.messages.transform",
        "experimental.chat.system.transform",
        "experimental.text.complete",
        "tool",
        "tool.definition",
        "tool.execute.after",
        "tool.execute.before",
      ].sort(),
    );
  });

  it("registers both compress and decompress tools", async () => {
    const plugin = await makePlugin();
    assert.ok(plugin.tool, "tool key must be present");
    assert.ok(plugin.tool.compress, "compress tool must be registered");
    assert.ok(plugin.tool.decompress, "decompress tool must be registered");
    assert.equal(typeof plugin.tool.compress.execute, "function");
    assert.equal(typeof plugin.tool.decompress.execute, "function");
  });

  it("never registers todo on OpenCode: absent from the tool surface and from primary_tools", async () => {
    // config.toml lists `todo` in the poly profile, but the OpenCode host
    // supplies no todo state store (`todoStore`), so the fail-closed unit
    // contributes no tool — and the name must not leak into the config's
    // primary-tool surface either.
    const plugin = await makePlugin();
    assert.equal(
      plugin.tool.todo,
      undefined,
      "the todo tool must never register on OpenCode",
    );
    assert.deepEqual(
      Object.keys(plugin.tool).sort(),
      ["compress", "decompress"],
      "the OpenCode tool surface stays free of todo",
    );

    const config = hostConfig();
    await plugin.config(config);
    assert.deepEqual(
      config.experimental.primary_tools,
      ["compress", "decompress"],
      "todo must not pollute experimental.primary_tools",
    );
    assert.ok(!config.experimental.primary_tools.includes("todo"));
  });

  it("composeToolHooks fails closed for todo with OpenCode deps (no todoStore)", () => {
    // The compose-layer check: the OpenCode tool surface composes the real
    // registry with deps that carry a tool host but no todo store, so only
    // the host-port-free tools come back.
    const hooks = composeToolHooks({}, {}, ["compress", "decompress", "todo"]);
    assert.deepEqual(Object.keys(hooks ?? {}).sort(), [
      "compress",
      "decompress",
    ]);
  });

  it("registerProfileToolsInConfig never appends a tool name beyond compress/decompress", () => {
    // The config assembly is a fixed two-name append: a profile listing
    // `todo` (and unknown names) leaves `primary_tools` free of them while
    // preserving the host's pre-existing entries.
    const config: Record<string, any> = {
      experimental: { primary_tools: ["bash"] },
    };
    registerProfileToolsInConfig(config, [
      "todo",
      "ask",
      "subagent",
      "future-tool",
      "compress",
      "decompress",
    ]);
    assert.deepEqual(config.experimental.primary_tools, [
      "bash",
      "compress",
      "decompress",
    ]);
  });

  it("tool.execute.before runs the gate prompt judge (blocking prompt error)", async () => {
    const plugin = await makePlugin();
    await assert.rejects(
      plugin["tool.execute.before"](
        { tool: "task", sessionID: "s", callID: "c" },
        { args: { prompt: INVALID_PROMPT } },
      ),
      /Subagent prompt format error/,
    );
  });

  it("tool.execute.before runs the gate delegation judge (blocked delegation)", async () => {
    // The real OpenCode SDK client exposes `session.get` and has no
    // `getSession`: the caller must come from the gate's async capability
    // (registry miss → `session.get` fallback), not a fabricated method.
    const client = hostClient({
      session: { get: async () => ({ agent: "beaver" }) },
    });
    const plugin = await makePlugin(POLY_ZOO, { client });
    await assert.rejects(
      plugin["tool.execute.before"](
        { tool: "task", sessionID: "s", callID: "c" },
        { args: { subagent_type: "kiwi" } },
      ),
      /beaver can only delegate to lynx and spider/,
    );
  });

  it("tool.execute.before allows an allowlisted delegation (registry caller)", async () => {
    sessionAgentRegistry.bind("s", "beaver");
    const plugin = await makePlugin();
    await plugin["tool.execute.before"](
      { tool: "task", sessionID: "s", callID: "c" },
      { args: { subagent_type: "spider" } },
    );
  });

  it("tool.execute.before refuses when the caller cannot be resolved", async () => {
    // A session the host cannot attribute to any agent must not slip past
    // the allowlist — the delegation judge fails closed.
    const client = hostClient({ session: { get: async () => ({}) } });
    const plugin = await makePlugin(POLY_ZOO, { client });
    await assert.rejects(
      plugin["tool.execute.before"](
        { tool: "task", sessionID: "s", callID: "c" },
        { args: { subagent_type: "kiwi" } },
      ),
      /无法确定调用者身份/,
    );
  });

  it("tool.definition runs enhanceSubagentDefinition via the task→subagent mapping", async () => {
    // OpenCode names the delegation tool "task"; the compose-opencode
    // boundary maps it to the canonical "subagent" before handlers run,
    // so a raw "task" toolID must still reach the definition enhancer.
    const plugin = await makePlugin();
    const output = {
      description: "Launch a subagent",
      parameters: {
        type: "object",
        properties: {
          prompt: { description: "The subagent prompt", type: "string" },
        },
      },
    };
    await plugin["tool.definition"]({ toolID: "task" }, output);
    assert.equal(
      output.parameters.properties.prompt.description,
      `The subagent prompt\n\n${SUBAGENT_PROMPT_HINT}`,
    );
  });

  it("normalizeToolName maps the OpenCode dialect to the canonical name", () => {
    assert.equal(normalizeToolName("task"), "subagent");
    assert.equal(normalizeToolName("edit"), "edit");
    assert.equal(normalizeToolName("subagent"), "subagent");
  });

  it("tool.execute.after runs nudgeSubagentOutput then nudgePostSubagent in order", async () => {
    const plugin = await makePlugin();
    const output: { output?: string } = {};
    await plugin["tool.execute.after"](
      {
        tool: "task",
        sessionID: "s",
        callID: "c",
        args: { prompt: PROMPT_WITH_CODE_BLOCK },
      },
      output,
    );

    // subagent-prompt handler appended the guidance suffix first...
    const text = output.output ?? "";
    const guidanceAt = text.indexOf("--- Guidance for next time ---");
    assert.ok(guidanceAt >= 0, "guidance suffix must be appended");
    // ...post-subagent handler appended VERIFY_REMINDER afterwards.
    const verifyAt = text.indexOf(VERIFY_REMINDER);
    assert.ok(
      verifyAt > guidanceAt,
      "VERIFY_REMINDER must come after guidance",
    );
  });

  it("messages.transform runs context-pruning", async () => {
    const plugin = await makePlugin();
    const output = { messages: transformMessages() };
    await plugin["experimental.chat.messages.transform"]({}, output);

    const events = logEvents().map((e) => e.event);
    assert.ok(events.includes("refs_assigned"), "pruning handler must run");
  });

  it("text.complete strips leading [mN] echoes and logs the event", async () => {
    const plugin = await makePlugin();
    const output: { text: string } = { text: "[m3] [m5] hello world" };
    await plugin["experimental.text.complete"](
      { sessionID: "s4", messageID: "m", partID: "p" },
      output,
    );
    assert.equal(output.text, "hello world");

    const events = logEvents().filter((e) => e.event === "reply_ref_stripped");
    assert.equal(events.length, 1);
    assert.equal(events[0].hook, "reply-strip");
    assert.equal(events[0].level, "warn");
    assert.equal(events[0].sessionId, "s4");
    assert.equal(events[0].fragment, "[m3] [m5] hello world");
  });

  it("text.complete leaves clean replies unchanged without logging", async () => {
    const plugin = await makePlugin();
    const output: { text: string } = { text: "plain reply" };
    await plugin["experimental.text.complete"](
      { sessionID: "s5", messageID: "m", partID: "p" },
      output,
    );
    assert.equal(output.text, "plain reply");
    assert.equal(
      logEvents().filter((e) => e.event === "reply_ref_stripped").length,
      0,
    );
  });

  it("config hook injects all profile agents, skills, tools, and commands", async () => {
    const plugin = await makePlugin();
    const config = hostConfig();
    await plugin.config(config);

    for (const name of POLY_PROFILE.agents) {
      assert.ok(
        typeof config.agent[name].prompt === "string",
        `agent ${name} must get a prompt`,
      );
    }
    assert.equal(config.skills.paths.length, 10);
    assert.deepEqual(config.experimental.primary_tools, [
      "compress",
      "decompress",
    ]);
    assert.deepEqual(config.command.go, {
      template: "",
      description: "Approve plan and handoff to execution",
    });
    assert.deepEqual(config.command.dcp, {
      template: "",
      description: "显示上下文用量与缓存命中率",
    });
  });

  it("registers no /<agent> primary-switch commands on OpenCode", async () => {
    // The switch unit contributes a command per configured primary on
    // the pi host only.  OpenCode never provides the pi switch surfaces
    // (switchHost), so even with primaries in the profile no `/<agent>`
    // switch command may appear in the config hook (or be handled).
    const plugin = await makePlugin();
    const config = hostConfig();
    await plugin.config(config);
    assert.deepEqual(
      Object.keys(config.command ?? {}).sort(),
      ["dcp", "go"],
      "no config-derived /<agent> switch command on OpenCode",
    );

    // The switch command name (an agent name) is not handled — the hook
    // resolves without the COMMAND_HANDLED sentinel.
    const result = await plugin["command.execute.before"](
      { command: "dolphin", sessionID: "s", arguments: "" },
      {},
    );
    assert.equal(result, undefined);
  });

  it("config hook injects the mode-conditional mola prompt (poly)", async () => {
    const plugin = await makePlugin();
    const config = hostConfig();
    await plugin.config(config);
    // Poly mode: lynx/spider present → delegation sections in the prompt.
    assert.ok(
      config.agent.mola.prompt.includes(
        DELEGATION_LEAF_AGENTS_HEADER.trimEnd(),
      ),
      "poly mola prompt must teach delegation",
    );
  });

  it("config hook injects the mode-conditional mola prompt (mono)", async () => {
    const plugin = await makePlugin({
      ...POLY_ZOO,
      mode: { mono: { ...POLY_PROFILE, agents: ["dolphin", "mola"] } },
    });
    const config = hostConfig(["dolphin", "mola"]);
    await plugin.config(config);
    // Mono mode: no lynx/spider → no <Agents> section, no task tool.
    assert.ok(
      !config.agent.mola.prompt.includes("<Agents>"),
      "mono mola prompt must not contain an <Agents> section",
    );
    assert.ok(
      !config.agent.mola.prompt.includes("- **task** — delegate information"),
      "mono mola prompt must not list the task tool",
    );
  });

  it("config hook injects the mode-conditional dolphin prompt (mono)", async () => {
    const plugin = await makePlugin({
      ...POLY_ZOO,
      mode: { mono: { ...POLY_PROFILE, agents: ["dolphin", "mola"] } },
    });
    const config = hostConfig(["dolphin", "mola"]);
    await plugin.config(config);
    // Mono mode: no lynx/spider → self-sufficient worker prompt: no
    // <Agents> section, no task() delegation.
    assert.ok(
      !config.agent.dolphin.prompt.includes("<Agents>"),
      "mono dolphin prompt must not contain an <Agents> section",
    );
    assert.ok(
      !config.agent.dolphin.prompt.includes("task("),
      "mono dolphin prompt must not teach task() delegation",
    );
  });

  it("zookeeper with the real config.toml registers the full poly profile", async () => {
    // The real config.toml carries [zoo.mode.poly] (and, once the mono
    // profile lands, a second [zoo.mode.mono] sub-table).  Point the
    // mode state file at poly so the plugin entry point selects the
    // full profile and registers every profile-driven unit — not stay
    // infrastructure-only.
    await withModeFile(JSON.stringify({ mode: "poly" }), async () => {
      // The entry point pre-reads the host config, so the real config.toml
      // is paired with the agent table install.py generates for it.
      const plugin = (await zookeeper({ client: hostClient() })) as Record<
        string,
        any
      >;
      const handlerNames = [
        "tool.definition",
        "tool.execute.before",
        "tool.execute.after",
        "experimental.chat.messages.transform",
        "experimental.text.complete",
        "command.execute.before",
      ];
      for (const name of handlerNames) {
        assert.equal(
          typeof plugin[name],
          "function",
          `expected hook handler "${name}" to be a function`,
        );
      }
      assert.ok(plugin.tool, "tool key must be present");
      assert.ok(plugin.tool.compress, "compress tool must be registered");
      assert.ok(plugin.tool.decompress, "decompress tool must be registered");
    });
  });
});

// ---------------------------------------------------------------------------
// Event-key composition by enabled hook set
// ---------------------------------------------------------------------------

describe("event-key composition by enabled hook set", () => {
  function pluginWithHooks(hooks: string[]): Promise<Record<string, any>> {
    return makePlugin({
      ...POLY_ZOO,
      mode: { poly: { ...POLY_PROFILE, hooks } },
    });
  }

  it("no hooks enabled → the four shared event keys are absent", async () => {
    const plugin = await pluginWithHooks([]);
    assert.equal(plugin["tool.definition"], undefined);
    assert.equal(plugin["tool.execute.before"], undefined);
    assert.equal(plugin["tool.execute.after"], undefined);
    assert.equal(plugin["experimental.chat.messages.transform"], undefined);
    assert.equal(plugin["experimental.text.complete"], undefined);
    // tools are gated by the tools list, not hooks — still present here.
    assert.ok(plugin.tool, "tool key gated by tools list, not hooks");
  });

  it("reply-strip only → text.complete present, no other shared keys", async () => {
    const plugin = await pluginWithHooks(["reply-strip"]);
    assert.equal(typeof plugin["experimental.text.complete"], "function");

    const output: { text: string } = { text: "[m2] gated" };
    await plugin["experimental.text.complete"](
      { sessionID: "s", messageID: "m", partID: "p" },
      output,
    );
    assert.equal(output.text, "gated");

    assert.equal(plugin["tool.definition"], undefined);
    assert.equal(plugin["tool.execute.before"], undefined);
    assert.equal(plugin["tool.execute.after"], undefined);
    assert.equal(plugin["experimental.chat.messages.transform"], undefined);
  });

  it("subagent-prompt only → definition + prompt validation, no delegation", async () => {
    const plugin = await pluginWithHooks(["subagent-prompt"]);

    assert.equal(typeof plugin["tool.definition"], "function");

    // The prompt judge of the composed gate blocks the invalid prompt.
    await assert.rejects(
      plugin["tool.execute.before"](
        { tool: "task", sessionID: "s", callID: "c" },
        { args: { prompt: INVALID_PROMPT } },
      ),
      /Subagent prompt format error/,
    );

    // No delegation judge is enabled — a denied delegation passes even
    // for a caller the allowlist would otherwise restrict.
    sessionAgentRegistry.bind("s", "beaver");
    await plugin["tool.execute.before"](
      { tool: "task", sessionID: "s", callID: "c" },
      { args: { subagent_type: "kiwi" } },
    );
    assert.ok(true, "delegation validation must be skipped");
  });

  it("subagent-delegation only → delegation validation, no prompt validation", async () => {
    // The caller is read from the registry the `message.updated` handler
    // writes, exactly as on the live host.
    sessionAgentRegistry.bind("s", "beaver");
    const plugin = await makePlugin({
      ...POLY_ZOO,
      mode: { poly: { ...POLY_PROFILE, hooks: ["subagent-delegation"] } },
    });

    assert.equal(plugin["tool.definition"], undefined);

    // No prompt judge is enabled — an invalid prompt passes.
    await plugin["tool.execute.before"](
      { tool: "task", sessionID: "s", callID: "c" },
      { args: { prompt: INVALID_PROMPT } },
    );

    // The delegation judge blocks the denied delegation.
    await assert.rejects(
      plugin["tool.execute.before"](
        { tool: "task", sessionID: "s", callID: "c" },
        { args: { subagent_type: "kiwi" } },
      ),
      /not allowed/,
    );
  });

  it("subagent-prompt only → after runs nudgeSubagentOutput but not post-subagent", async () => {
    const plugin = await pluginWithHooks(["subagent-prompt"]);
    const output: { output?: string } = {};
    await plugin["tool.execute.after"](
      {
        tool: "task",
        sessionID: "s",
        callID: "c",
        args: { prompt: PROMPT_WITH_CODE_BLOCK },
      },
      output,
    );
    const text = output.output ?? "";
    assert.ok(text.includes("--- Guidance for next time ---"));
    assert.ok(
      !text.includes(VERIFY_REMINDER),
      "post-subagent handler must not run",
    );
  });

  it("post-subagent-nudge only → after appends VERIFY_REMINDER, no guidance", async () => {
    const plugin = await pluginWithHooks(["post-subagent-nudge"]);
    const output: { output?: string } = { output: "result" };
    await plugin["tool.execute.after"](
      { tool: "task", sessionID: "s", callID: "c" },
      output,
    );
    assert.ok(output.output?.includes(VERIFY_REMINDER));
    assert.ok(
      !output.output?.includes("--- Guidance for next time ---"),
      "subagent-prompt handler must not run",
    );
  });

  it("direct-work-nudge only → after appends the edit nudge for dolphin", async () => {
    const plugin = await pluginWithHooks(["direct-work-nudge"]);
    sessionAgentRegistry.bind("s", "dolphin");
    const output: { output?: string } = { output: "result" };
    await plugin["tool.execute.after"](
      { tool: "edit", sessionID: "s", callID: "c" },
      output,
    );
    assert.ok(output.output?.includes(DIRECT_WORK_NUDGE));
  });

  it("json-error-nudge only → after appends the recovery reminder", async () => {
    const plugin = await pluginWithHooks(["json-error-nudge"]);
    const output: { output?: string } = {
      output: "json parse error: unexpected token",
    };
    await plugin["tool.execute.after"](
      { tool: "edit", sessionID: "s", callID: "c" },
      output,
    );
    assert.ok(output.output?.includes(JSON_ERROR_REMINDER));
  });

  it("context-pruning only → transform prunes", async () => {
    const plugin = await pluginWithHooks(["context-pruning"]);
    const output = { messages: transformMessages() };
    await plugin["experimental.chat.messages.transform"]({}, output);

    const events = logEvents().map((e) => e.event);
    assert.ok(events.includes("refs_assigned"), "pruning handler must run");
  });
});

// ---------------------------------------------------------------------------
// Command atomic registration
// ---------------------------------------------------------------------------

describe("command atomic registration", () => {
  function pluginWithCommands(
    commands: string[],
  ): Promise<Record<string, any>> {
    return makePlugin({
      ...POLY_ZOO,
      mode: { poly: { ...POLY_PROFILE, commands } },
    });
  }

  it('commands=["go"] registers go only — command + handler branch', async () => {
    const plugin = await pluginWithCommands(["go"]);
    const config = hostConfig();
    await plugin.config(config);
    assert.ok(config.command.go, "go command must be registered");
    assert.equal(config.command.dcp, undefined);

    // go is handled (always short-circuits with COMMAND_HANDLED).
    await assert.rejects(
      plugin["command.execute.before"](
        { command: "go", sessionID: "s", arguments: "" },
        {},
      ),
      (err: unknown) => err === COMMAND_HANDLED,
    );
    // dcp is NOT handled — the hook resolves without touching it.
    const result = await plugin["command.execute.before"](
      { command: "dcp", sessionID: "s", arguments: "" },
      {},
    );
    assert.equal(result, undefined);
  });

  it('commands=["dcp"] registers dcp only — command + handler branch', async () => {
    const plugin = await pluginWithCommands(["dcp"]);
    const config = hostConfig();
    await plugin.config(config);
    assert.ok(config.command.dcp, "dcp command must be registered");
    assert.equal(config.command.go, undefined);

    await assert.rejects(
      plugin["command.execute.before"](
        { command: "dcp", sessionID: "s", arguments: "" },
        {},
      ),
      (err: unknown) => err === COMMAND_HANDLED,
    );
    const result = await plugin["command.execute.before"](
      { command: "go", sessionID: "s", arguments: "" },
      {},
    );
    assert.equal(result, undefined);
  });

  it("no commands → no command.execute.before key, config untouched", async () => {
    const plugin = await pluginWithCommands([]);
    assert.equal(plugin["command.execute.before"], undefined);

    const config = hostConfig();
    await plugin.config(config);
    assert.equal(config.command, undefined);
  });
});

// ---------------------------------------------------------------------------
// Tools gated by the profile tools list
// ---------------------------------------------------------------------------

describe("tools gated by the profile tools list", () => {
  function pluginWithTools(tools: string[]): Promise<Record<string, any>> {
    return makePlugin({
      ...POLY_ZOO,
      mode: { poly: { ...POLY_PROFILE, tools } },
    });
  }

  it('tools=["compress"] registers only compress', async () => {
    const plugin = await pluginWithTools(["compress"]);
    assert.ok(plugin.tool.compress, "compress must be registered");
    assert.equal(plugin.tool.decompress, undefined);

    const config = hostConfig();
    await plugin.config(config);
    assert.deepEqual(config.experimental.primary_tools, ["compress"]);
  });

  it('tools=["decompress"] registers only decompress', async () => {
    const plugin = await pluginWithTools(["decompress"]);
    assert.equal(plugin.tool.compress, undefined);
    assert.ok(plugin.tool.decompress, "decompress must be registered");

    const config = hostConfig();
    await plugin.config(config);
    assert.deepEqual(config.experimental.primary_tools, ["decompress"]);
  });

  it("no tools → tool key absent, primary_tools untouched", async () => {
    const plugin = await pluginWithTools([]);
    assert.equal(plugin.tool, undefined);

    const config = hostConfig();
    config.experimental = { primary_tools: ["bash"] };
    await plugin.config(config);
    assert.deepEqual(config.experimental.primary_tools, ["bash"]);
  });

  it("unknown tool names are ignored", async () => {
    const plugin = await pluginWithTools(["future-tool", "compress"]);
    assert.ok(plugin.tool.compress, "known tool still registers");
    assert.equal(plugin.tool["future-tool"], undefined);
  });
});

// ---------------------------------------------------------------------------
// Agents and skills gated by the profile lists
// ---------------------------------------------------------------------------

describe("agents gated by the profile agents list", () => {
  it("injects only the profile-listed agents", async () => {
    const plugin = await makePlugin({
      mode: { poly: { ...POLY_PROFILE, agents: ["dolphin"] } },
    });
    const config = hostConfig(["dolphin", "kiwi"]);
    await plugin.config(config);
    assert.ok(typeof config.agent.dolphin.prompt === "string");
    assert.equal(config.agent.kiwi.prompt, undefined);
  });

  it("empty agents list → no orchestrator, only the configuration closes", async () => {
    // A profile that enables no agent cannot provide the declared
    // orchestrator: the selection is invalid, so this configuration
    // registers nothing while the plugin (and its infrastructure) stays.
    const plugin = await makePlugin({
      mode: { poly: { ...POLY_PROFILE, agents: [] } },
    });
    assert.equal(plugin.tool, undefined);
    assert.equal(plugin["tool.definition"], undefined);
    assert.equal(plugin["command.execute.before"], undefined);
    assert.equal(typeof plugin.event, "function");

    const config: Record<string, any> = { agent: { ...hostConfig().agent } };
    await plugin.config(config);
    assert.equal(config.default_agent, undefined);
    assert.equal(config.skills, undefined);
    assert.equal(config.command, undefined);
  });
});

// ---------------------------------------------------------------------------
// Host config pre-read — the selection is planned from host facts
// ---------------------------------------------------------------------------

describe("buildPlugin — host config pre-read", () => {
  /** The profile of the pre-read cases: dolphin plus the probe agent. */
  const PROBE_PROFILE = {
    agents: ["dolphin", "probe"],
    skills: [],
    hooks: [],
    tools: [],
    commands: [],
  };

  /** The zoo config enabling that profile. */
  const PROBE_ZOO: Record<string, unknown> = { mode: { poly: PROBE_PROFILE } };

  /** The config's role table: dolphin primary, the probe a subagent. */
  const PROBE_RAW: Record<string, unknown> = {
    agent: { dolphin: { mode: "primary" }, probe: { mode: "subagent" } },
  };

  /** The host table that materialises both agents, dolphin by default. */
  const READY_HOST: Record<string, any> = {
    agent: {
      dolphin: { mode: "primary" },
      probe: { mode: "subagent" },
    },
  };

  /**
   * Run `body` with a probe agent unit in the registry, reporting how many
   * times its factory ran.
   *
   * The probe is a selected agent of the profile, so a factory run means
   * the assembly reached the build stage.
   *
   * @param body - Receives a getter for the factory run count.
   */
  async function withProbeFactory(
    body: (runs: () => number) => Promise<void>,
  ): Promise<void> {
    let runs = 0;
    const probe: AgentUnitDescriptor = {
      name: "probe",
      kind: "agent",
      needs: [],
      wants: [],
      uses: [],
      create() {
        runs += 1;
        return { kind: "agent", agents: [] };
      },
    };
    REGISTRY.push(probe);
    try {
      await body(() => runs);
    } finally {
      REGISTRY.pop();
    }
  }

  /** Build the probe plugin with a client answering `config.get`. */
  function probePlugin(client: Record<string, unknown>) {
    return buildPlugin({ client }, PROBE_ZOO, PROBE_RAW);
  }

  /** The buffered `selection_invalid` entry of the current pass. */
  function invalidEntry(): Record<string, unknown> | undefined {
    return _getBufferForTesting().find((e) => e.event === "selection_invalid");
  }

  /**
   * Assert the plugin kept its infrastructure and registered no profile
   * surface, and that the config hook leaves the host config alone.
   *
   * @param plugin - The plugin the entry point returned.
   */
  async function assertUnregistered(
    plugin: Record<string, any>,
  ): Promise<void> {
    assert.equal(typeof plugin.config, "function");
    assert.equal(typeof plugin.event, "function");
    assert.equal(plugin.tool, undefined);
    assert.equal(plugin["tool.definition"], undefined);
    assert.equal(plugin["tool.execute.before"], undefined);
    assert.equal(plugin["command.execute.before"], undefined);

    const config: Record<string, any> = {
      agent: {
        dolphin: { mode: "primary" },
        probe: { mode: "subagent" },
      },
      default_agent: "host-declared",
    };
    await plugin.config(config);
    assert.equal(config.default_agent, "host-declared");
    assert.equal(config.skills, undefined);
    assert.equal(config.command, undefined);
  }

  it("closes the configuration when the client has no config API", async () => {
    await withProbeFactory(async (runs) => {
      const plugin = (await probePlugin({})) as Record<string, any>;
      assert.equal(runs(), 0, "no unit factory may run");
      assert.equal(plugin.tool, undefined);
      assert.equal(plugin["tool.definition"], undefined);
      assert.equal(invalidEntry()?.hostFact !== undefined, true);
      assert.deepEqual(
        (invalidEntry()?.hostFact as Record<string, unknown>).cause,
        "no-api",
      );
      await assertUnregistered(plugin);
    });
  });

  it("closes the configuration when the config request fails", async () => {
    await withProbeFactory(async (runs) => {
      const client = {
        config: {
          get: async () => {
            throw new Error("instance not ready");
          },
        },
      };
      const plugin = (await probePlugin(client)) as Record<string, any>;
      assert.equal(runs(), 0, "no unit factory may run");
      const fact = invalidEntry()?.hostFact as Record<string, unknown>;
      assert.equal(fact.cause, "request-failed");
      assert.equal(String(fact.detail).includes("instance not ready"), true);
      await assertUnregistered(plugin);
    });
  });

  it("closes the configuration when the config carries no data", async () => {
    await withProbeFactory(async (runs) => {
      const client = {
        config: { get: async () => ({ error: { status: 500 } }) },
      };
      const plugin = (await probePlugin(client)) as Record<string, any>;
      assert.equal(runs(), 0, "no unit factory may run");
      const fact = invalidEntry()?.hostFact as Record<string, unknown>;
      assert.equal(fact.cause, "no-data");
      assert.equal(String(fact.detail).includes("500"), true);
      await assertUnregistered(plugin);
    });
  });

  it("closes the configuration when a selected agent is not materialised", async () => {
    await withProbeFactory(async (runs) => {
      const client = {
        config: {
          get: async () => ({
            data: { agent: { dolphin: { mode: "primary" } } },
          }),
        },
      };
      const plugin = (await probePlugin(client)) as Record<string, any>;
      assert.equal(runs(), 0, "no unit factory may run");
      assert.deepEqual(invalidEntry()?.unmaterialised, ["probe"]);
      await assertUnregistered(plugin);
    });
  });

  it("closes the configuration when the host disables a selected agent", async () => {
    await withProbeFactory(async (runs) => {
      const client = {
        config: {
          get: async () => ({
            data: {
              agent: {
                dolphin: { mode: "primary" },
                probe: { mode: "subagent", disable: true },
              },
            },
          }),
        },
      };
      const plugin = (await probePlugin(client)) as Record<string, any>;
      assert.equal(runs(), 0, "no unit factory may run");
      assert.deepEqual(invalidEntry()?.unmaterialised, ["probe"]);
      await assertUnregistered(plugin);
    });
  });

  it("closes the configuration when the orchestrator is a host subagent", async () => {
    await withProbeFactory(async (runs) => {
      const client = {
        config: {
          get: async () => ({
            data: {
              agent: {
                dolphin: { mode: "subagent" },
                probe: { mode: "subagent" },
              },
            },
          }),
        },
      };
      const plugin = (await probePlugin(client)) as Record<string, any>;
      assert.equal(runs(), 0, "no unit factory may run");
      assert.equal(invalidEntry()?.cause, "not-default-agent");
      assert.equal(invalidEntry()?.orchestrator, "dolphin");
      await assertUnregistered(plugin);
    });
  });

  it("closes the configuration when the orchestrator is hidden", async () => {
    await withProbeFactory(async (runs) => {
      const client = {
        config: {
          get: async () => ({
            data: {
              agent: {
                dolphin: { mode: "primary", hidden: true },
                probe: { mode: "subagent" },
              },
            },
          }),
        },
      };
      const plugin = (await probePlugin(client)) as Record<string, any>;
      assert.equal(runs(), 0, "no unit factory may run");
      assert.equal(invalidEntry()?.cause, "not-default-agent");
      await assertUnregistered(plugin);
    });
  });

  it("runs the factories and adopts the orchestrator when the host is ready", async () => {
    await withProbeFactory(async (runs) => {
      const client = {
        config: { get: async () => ({ data: READY_HOST }) },
      };
      const plugin = (await probePlugin(client)) as Record<string, any>;
      assert.equal(runs(), 1, "the build stage runs once");

      const config: Record<string, any> = {
        agent: {
          dolphin: { mode: "primary" },
          probe: { mode: "subagent" },
        },
        default_agent: "host-declared",
      };
      await plugin.config(config);
      assert.equal(config.default_agent, "dolphin");
    });
  });

  it("probes nothing and registers nothing for a null profile", async () => {
    let probed = 0;
    const client = {
      config: {
        get: async () => {
          probed += 1;
          return { data: READY_HOST };
        },
      },
    };
    const plugin = (await buildPlugin({ client }, {})) as Record<string, any>;
    assert.equal(probed, 0, "a disabled selection probes no host config");
    assert.equal(plugin["tool.definition"], undefined);
    assert.equal(plugin.tool, undefined);
  });
});

// ---------------------------------------------------------------------------
// Config hook — final atomic check against the config handed over
// ---------------------------------------------------------------------------

/**
 * The config hook is not the only refusal path: a disabled or invalid
 * selection still returns hooks — the infrastructure ones keep working and
 * only the profile-driven registrations are absent — so this hook closes
 * the configuration instead of refusing.  These cases therefore drive the
 * hook against a config that drifted after a ready selection — another
 * plugin removing, disabling or re-moding a selected agent — where the
 * final check must stay atomic and leave the host config untouched when it
 * refuses.
 */
describe("config hook — final atomic check against the host config", () => {
  it("sets default_agent to the selection orchestrator, not the first primary", async () => {
    // Profile order puts mola first, so deriving the default from the
    // primary order would pick mola; the orchestrator role decides it.
    // The host's stale default is overwritten.
    const plugin = await makePlugin({
      ...POLY_ZOO,
      mode: {
        poly: {
          ...POLY_PROFILE,
          agents: [
            "mola",
            "dolphin",
            ...POLY_PROFILE.agents.filter(
              (name) => name !== "mola" && name !== "dolphin",
            ),
          ],
        },
      },
    });
    const config: Record<string, any> = {
      ...hostConfig(),
      default_agent: "mola",
    };

    await plugin.config(config);

    assert.equal(config.default_agent, "dolphin");
  });

  it("accepts a host orchestrator on OpenCode's own default mode", async () => {
    // A configured agent OpenCode leaves on mode "all" is a valid default
    // agent; only "subagent" and `hidden: true` are refused there.
    const plugin = await makePlugin();
    const config = hostConfig();
    config.agent.dolphin.mode = "all";

    await plugin.config(config);

    assert.equal(config.default_agent, "dolphin");
  });

  it("rejects a selection whose agents the host has not materialised", async () => {
    const plugin = await makePlugin();
    const config: Record<string, any> = {
      agent: { dolphin: { mode: "primary" } },
    };

    await assert.rejects(plugin.config(config), (err: unknown) => {
      const message = (err as Error).message;
      return message.includes("mola") && message.includes("kiwi");
    });
    // The hook validates before mutating: nothing was registered.
    assert.equal(config.default_agent, undefined);
    assert.equal(config.skills, undefined);
    assert.equal(config.agent.dolphin.prompt, undefined);
  });

  it("rejects a selected agent the host config disables", async () => {
    // OpenCode deletes a disabled agent before building its agent map, so
    // the entry is not a materialised agent either.
    const plugin = await makePlugin({
      ...POLY_ZOO,
      mode: { poly: { ...POLY_PROFILE, agents: ["dolphin", "mola"] } },
    });
    const config = hostConfig(["dolphin", "mola"]);
    config.agent.mola.disable = true;

    await assert.rejects(plugin.config(config), /mola/);
    assert.equal(config.default_agent, undefined);
  });

  it("rejects an orchestrator the host marks as a subagent", async () => {
    const plugin = await makePlugin();
    const config = hostConfig();
    config.agent.dolphin.mode = "subagent";

    await assert.rejects(plugin.config(config), /dolphin/);
    assert.equal(config.default_agent, undefined);
    assert.equal(config.skills, undefined);
  });

  it("rejects a hidden orchestrator", async () => {
    const plugin = await makePlugin();
    const config = hostConfig();
    config.agent.dolphin.hidden = true;

    await assert.rejects(plugin.config(config), /dolphin/);
    assert.equal(config.default_agent, undefined);
  });

  it("leaves the host config alone for an invalid selection", async () => {
    // dolphin is absent from the profile's agent list, so the declared
    // orchestrator cannot be one of the selected primaries: this
    // configuration registers nothing and the hook mutates nothing.
    const plugin = await makePlugin({
      ...POLY_ZOO,
      mode: { poly: { ...POLY_PROFILE, agents: ["mola"] } },
    });
    const config: Record<string, any> = {
      ...hostConfig(),
      default_agent: "host-declared",
    };

    await plugin.config(config);

    assert.equal(config.default_agent, "host-declared");
    assert.equal(config.skills, undefined);
    assert.equal(config.command, undefined);
    assert.equal(config.agent.dolphin.prompt, undefined);
  });

  it("preserves host agents outside the selection", async () => {
    const plugin = await makePlugin();
    const config = hostConfig();
    config.agent["user-own"] = { mode: "primary", prompt: "keep me" };

    await plugin.config(config);

    assert.deepEqual(config.agent["user-own"], {
      mode: "primary",
      prompt: "keep me",
    });
    assert.equal(
      Object.keys(config.agent).length,
      POLY_PROFILE.agents.length + 1,
    );
  });
});

describe("skills gated by the profile skills list", () => {
  it("registers only the profile-listed skills", async () => {
    const plugin = await makePlugin({
      mode: { poly: { ...POLY_PROFILE, skills: ["git-commit"] } },
    });
    const config = hostConfig();
    await plugin.config(config);
    assert.equal(config.skills.paths.length, 1);
    assert.ok(config.skills.paths[0].endsWith("git-commit"));
  });

  it("empty skills list → no skill paths", async () => {
    const plugin = await makePlugin({
      mode: { poly: { ...POLY_PROFILE, skills: [] } },
    });
    const config = hostConfig();
    await plugin.config(config);
    assert.deepEqual(config.skills.paths, []);
  });
});

// ---------------------------------------------------------------------------
// Null profile — skip all profile-driven registration
// ---------------------------------------------------------------------------

describe("null profile — skip profile-driven registration", () => {
  it("buildPlugin without zoo.mode exposes only the infrastructure hooks", async () => {
    const plugin = await makePlugin({ validation: POLY_ZOO.validation });
    assert.deepEqual(
      Object.keys(plugin).sort(),
      ["config", "event", "experimental.chat.system.transform"].sort(),
    );
  });

  it("config hook performs no profile-driven registration when profile is null", async () => {
    const plugin = await makePlugin({});
    const config: Record<string, any> = {
      agent: { dolphin: {} },
      default_agent: "host-declared",
    };
    await plugin.config(config);
    assert.equal(config.agent.dolphin.prompt, undefined);
    assert.equal(config.skills, undefined);
    assert.equal(config.experimental, undefined);
    assert.equal(config.command, undefined);
    // A disabled selection does not take over the host's default agent.
    assert.equal(config.default_agent, "host-declared");
  });

  it("infrastructure hooks keep working with a null profile", async () => {
    const plugin = await makePlugin({});

    // experimental.chat.system.transform records the model limit.
    await plugin["experimental.chat.system.transform"](
      {
        sessionID: "s2",
        model: { id: "m", limit: { context: 1000, output: 100 } },
      },
      { system: [] },
    );

    // event tracks agent identity.
    await plugin.event({
      event: {
        type: "message.updated",
        properties: { info: { agent: "dolphin", sessionID: "s3" } },
      },
    });
    assert.equal(sessionAgentRegistry.resolve("s3"), "dolphin");
  });

  it("text.complete is absent — reply-strip is profile-gated", async () => {
    // The ref-echo stripping guard is profile-driven: with no active
    // profile no handler is contributed (fail-closed), so no event key
    // appears at all.
    const plugin = await makePlugin({});
    assert.equal(plugin["experimental.text.complete"], undefined);
  });
});

// ---------------------------------------------------------------------------
// System transform — runtime model prompt variant
// ---------------------------------------------------------------------------

describe("experimental.chat.system.transform — model prompt variant", () => {
  /** Base and gpt wordings for one dolphin prompt line. */
  const BASE = "- 有职责匹配的 agent 时，**不得**因省事自行接管其工作；";
  const GPT =
    "- 职责匹配只决定可以委派给谁，不决定一定委派或不委派；**不得**因为下一步动作更方便，或因为存在匹配的 agent，就跳过完整交付成本判断；";

  /** Transform input envelope with the given model id. */
  function input(modelId: string) {
    return {
      sessionID: "sess-variant",
      model: { id: modelId, limit: { context: 1000, output: 100 } },
    };
  }

  it("swaps system entries to the gpt variant and back", async () => {
    // The poly profile enables the dolphin agent, whose contribution
    // carries the two variant pairs the transform swaps.
    const plugin = await makePlugin();
    const output = { system: [`<Contract>\n${BASE}\n</Contract>`] };

    await plugin["experimental.chat.system.transform"](
      input("openai/gpt-5.5"),
      output,
    );
    assert.ok(output.system[0].includes(GPT));
    assert.ok(!output.system[0].includes(BASE));

    await plugin["experimental.chat.system.transform"](
      input("claude-x"),
      output,
    );
    assert.ok(output.system[0].includes(BASE));
    assert.ok(!output.system[0].includes(GPT));
  });

  it("leaves entries without the variant lines untouched", async () => {
    const plugin = await makePlugin();
    const output = { system: ["plain system prompt"] };
    await plugin["experimental.chat.system.transform"](
      input("gpt-5.5"),
      output,
    );
    assert.deepEqual(output.system, ["plain system prompt"]);
  });

  it("swaps nothing when no enabled agent ships variants", async () => {
    // A null profile composes no agents, so the transform receives an
    // empty variant list and leaves the system prompt untouched
    // (fail-closed).
    const plugin = await makePlugin({});
    const text = `<Contract>\n${BASE}\n</Contract>`;
    const output = { system: [text] };
    await plugin["experimental.chat.system.transform"](
      input("openai/gpt-5.5"),
      output,
    );
    assert.deepEqual(output.system, [text]);
  });
});

describe("experimental.chat.system.transform — variant conflict filtering", () => {
  const DOLPHIN_BASE =
    "- 有职责匹配的 agent 时，**不得**因省事自行接管其工作；";
  const DOLPHIN_GPT =
    "- 职责匹配只决定可以委派给谁，不决定一定委派或不委派；**不得**因为下一步动作更方便，或因为存在匹配的 agent，就跳过完整交付成本判断；";
  /**
   * A later agent whose variant reuses dolphin's gpt wording as its own
   * base: applied after dolphin, it would rewrite dolphin's output.
   */
  const conflictUnit: AgentUnitDescriptor = {
    name: "conflict-agent",
    kind: "agent",
    needs: [],
    wants: [],
    uses: [],
    create() {
      return {
        kind: "agent",
        agents: [
          {
            name: "conflict-agent",
            prompt: "",
            promptVariants: [{ base: DOLPHIN_GPT, gpt: "CONFLICT_MARKER" }],
          },
        ],
      };
    },
  };

  it("drops a later overlapping variant and logs its source", async () => {
    REGISTRY.push(conflictUnit);
    try {
      const withConflict = {
        ...POLY_ZOO,
        mode: {
          poly: {
            ...POLY_PROFILE,
            agents: [...POLY_PROFILE.agents, "conflict-agent"],
          },
        },
      };
      const plugin = await makePlugin(withConflict, {
        client: hostClient({
          config: {
            get: async () => ({
              data: {
                agent: {
                  ...hostConfig().agent,
                  "conflict-agent": { mode: "subagent" },
                },
              },
            }),
          },
        }),
      });
      const output = { system: [`<Contract>\n${DOLPHIN_BASE}\n</Contract>`] };
      await plugin["experimental.chat.system.transform"](
        {
          sessionID: "sess-conflict",
          model: { id: "gpt-5.5", limit: { context: 1000, output: 100 } },
        },
        output,
      );
      // Dolphin's pair is kept and applied; the later overlapping pair is
      // dropped, so its marker never reaches the rewritten prompt.
      assert.ok(output.system[0].includes(DOLPHIN_GPT));
      assert.ok(!output.system[0].includes("CONFLICT_MARKER"));

      const conflicts = _getBufferForTesting().filter(
        (entry) => entry.event === "conflict_dropped",
      );
      assert.equal(conflicts.length, 1);
      assert.equal(conflicts[0].level, "warn");
      assert.equal(conflicts[0].dropped, 1);
      assert.deepEqual(conflicts[0].sources, ["conflict-agent"]);
    } finally {
      REGISTRY.pop();
    }
  });
});
