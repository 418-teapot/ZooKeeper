/**
 * Tests for profile-driven registration composition in `buildPlugin`.
 *
 * Covers: poly-full registration parity with the pre-refactor key set,
 * event-key composition by the enabled hook set (tool.definition /
 * tool.execute.before / tool.execute.after / messages.transform),
 * command atomic registration (go / dcp), tool / skill / agent gating by
 * the profile lists, and the null-profile skip (no registration, but the
 * infrastructure hooks keep working).
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { COMMAND_HANDLED } from "./compose-opencode.js";
import { _clearAllSessionsForTesting } from "./core/context/pruning/marks.js";
import { _clearAllRefsForTesting } from "./core/context/pruning/message-refs.js";
import { DIRECT_WORK_NUDGE } from "./hooks/direct-work-nudge";
import { JSON_ERROR_REMINDER } from "./hooks/json-error-nudge";
import { VERIFY_REMINDER } from "./hooks/post-task-nudge";
import { buildPlugin, sessionAgentMap, zookeeper } from "./opencode.js";
import { _getBufferForTesting, _resetForTesting } from "./utils/logger.js";
import { withModeFile } from "./utils/mode-file.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * The poly profile (mirrors the config.toml lists the parallel
 * task adds to `[zoo.mode.poly]`).
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
    "task-prompt",
    "task-delegation",
    "direct-work-nudge",
    "post-task-nudge",
    "json-error-nudge",
    "context-pruning",
    "context-metrics",
  ],
  tools: ["compress", "decompress"],
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
    dedup: { threshold_context: 100000, protected_tools: [] },
    purge_errors: {
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

/** Build a plugin with the given zoo config and input. */
function makePlugin(
  zooConfig: Record<string, unknown> = POLY_ZOO,
  input: Record<string, unknown> = { client: {} },
): Promise<Record<string, any>> {
  return buildPlugin(input, zooConfig) as Promise<Record<string, any>>;
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
  sessionAgentMap.clear();
  _clearAllSessionsForTesting();
  _clearAllRefsForTesting();
  delete process.env.ZOO_MODE_FILE;
});

function logEvents(): Array<Record<string, unknown>> {
  return _getBufferForTesting();
}

// ---------------------------------------------------------------------------
// Poly full profile — registration parity
// ---------------------------------------------------------------------------

describe("poly full profile — registration parity", () => {
  it("registers exactly the pre-refactor hook key set", async () => {
    const plugin = await makePlugin();
    assert.deepEqual(
      Object.keys(plugin).sort(),
      [
        "chat.params",
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

  it("tool.execute.before runs validateBeforeExec (blocking prompt error)", async () => {
    const plugin = await makePlugin();
    await assert.rejects(
      plugin["tool.execute.before"](
        { tool: "task", sessionID: "s", callID: "c" },
        { args: { prompt: INVALID_PROMPT } },
      ),
      /Task prompt format error/,
    );
  });

  it("tool.execute.before runs validateDelegationTarget (blocked delegation)", async () => {
    const client = { getSession: async () => ({ agent: "beaver" }) };
    const plugin = await makePlugin(POLY_ZOO, { client });
    await assert.rejects(
      plugin["tool.execute.before"](
        { tool: "task", sessionID: "s", callID: "c" },
        { args: { subagent_type: "kiwi" } },
      ),
      /not allowed/,
    );
  });

  it("tool.execute.after runs nudgeTaskOutput then nudgePostTask in order", async () => {
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

    // task-prompt handler appended the guidance suffix first...
    const text = output.output ?? "";
    const guidanceAt = text.indexOf("--- Guidance for next time ---");
    assert.ok(guidanceAt >= 0, "guidance suffix must be appended");
    // ...post-task handler appended VERIFY_REMINDER afterwards.
    const verifyAt = text.indexOf(VERIFY_REMINDER);
    assert.ok(
      verifyAt > guidanceAt,
      "VERIFY_REMINDER must come after guidance",
    );
  });

  it("messages.transform runs context-pruning then context-metrics", async () => {
    const plugin = await makePlugin();
    const output = { messages: transformMessages() };
    await plugin["experimental.chat.messages.transform"]({}, output);

    const events = logEvents().map((e) => e.event);
    assert.ok(events.includes("refs_assigned"), "pruning handler must run");
    assert.ok(events.includes("context_measured"), "metrics handler must run");
  });

  it("config hook injects all profile agents, skills, tools, and commands", async () => {
    const plugin = await makePlugin();
    const config: Record<string, any> = {
      agent: {
        dolphin: {},
        mola: {},
        beaver: {},
        lynx: {},
        spider: {},
        eagle: {},
        kiwi: {},
      },
    };
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
      description: "Approve plan and handoff to dolphin",
    });
    assert.deepEqual(config.command.dcp, {
      template: "",
      description: "显示上下文用量与缓存命中率",
    });
  });

  it("config hook injects the mode-conditional mola prompt (poly)", async () => {
    const plugin = await makePlugin();
    const config: Record<string, any> = {
      agent: { dolphin: {}, mola: {}, lynx: {}, spider: {} },
    };
    await plugin.config(config);
    // Poly mode: lynx/spider present → delegation sections in the prompt.
    assert.ok(
      config.agent.mola.prompt.includes("Two subagents are available"),
      "poly mola prompt must teach task() delegation",
    );
    assert.ok(
      config.agent.mola.prompt.includes("- **task** — delegate information"),
      "poly mola prompt must list the task tool",
    );
  });

  it("config hook injects the mode-conditional mola prompt (mono)", async () => {
    const plugin = await makePlugin({
      ...POLY_ZOO,
      mode: { mono: { ...POLY_PROFILE, agents: ["dolphin", "mola"] } },
    });
    const config: Record<string, any> = { agent: { dolphin: {}, mola: {} } };
    await plugin.config(config);
    // Mono mode: no lynx/spider → no <Agents> section + web tools.
    assert.ok(
      !config.agent.mola.prompt.includes("<Agents>"),
      "mono mola prompt must not contain an <Agents> section",
    );
    assert.ok(
      config.agent.mola.prompt.includes("- **websearch** — broad queries"),
      "mono mola prompt must list the websearch tool",
    );
    assert.ok(
      config.agent.mola.prompt.includes("- **webfetch** — read specific URLs"),
      "mono mola prompt must list the webfetch tool",
    );
    assert.ok(
      !config.agent.mola.prompt.includes("- **task** — delegate information"),
      "mono mola prompt must not list the task tool",
    );
  });

  it("zookeeper with the real config.toml registers the full poly profile", async () => {
    // The real config.toml carries [zoo.mode.poly] (and, once the mono
    // profile lands, a second [zoo.mode.mono] sub-table).  Point the
    // mode state file at poly so the plugin entry point selects the
    // full profile and registers every profile-driven unit — not stay
    // infrastructure-only.
    await withModeFile(JSON.stringify({ mode: "poly" }), async () => {
      const plugin = (await zookeeper({ client: {} })) as Record<string, any>;
      const handlerNames = [
        "tool.definition",
        "tool.execute.before",
        "tool.execute.after",
        "experimental.chat.messages.transform",
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
    // tools are gated by the tools list, not hooks — still present here.
    assert.ok(plugin.tool, "tool key gated by tools list, not hooks");
  });

  it("task-prompt only → definition + prompt validation, no delegation", async () => {
    const plugin = await pluginWithHooks(["task-prompt"]);

    assert.equal(typeof plugin["tool.definition"], "function");

    // validateBeforeExec runs (blocking prompt error).
    await assert.rejects(
      plugin["tool.execute.before"](
        { tool: "task", sessionID: "s", callID: "c" },
        { args: { prompt: INVALID_PROMPT } },
      ),
      /Task prompt format error/,
    );

    // validateDelegationTarget does NOT run — a denied delegation passes.
    const client = { getSession: async () => ({ agent: "beaver" }) };
    const plugin2 = await makePlugin(
      {
        ...POLY_ZOO,
        mode: { poly: { ...POLY_PROFILE, hooks: ["task-prompt"] } },
      },
      { client },
    );
    await plugin2["tool.execute.before"](
      { tool: "task", sessionID: "s", callID: "c" },
      { args: { subagent_type: "kiwi" } },
    );
    assert.ok(true, "delegation validation must be skipped");
  });

  it("task-delegation only → delegation validation, no prompt validation", async () => {
    const client = { getSession: async () => ({ agent: "beaver" }) };
    const plugin = await makePlugin(
      {
        ...POLY_ZOO,
        mode: { poly: { ...POLY_PROFILE, hooks: ["task-delegation"] } },
      },
      { client },
    );

    assert.equal(plugin["tool.definition"], undefined);

    // validateBeforeExec does NOT run — an invalid prompt passes.
    await plugin["tool.execute.before"](
      { tool: "task", sessionID: "s", callID: "c" },
      { args: { prompt: INVALID_PROMPT } },
    );

    // validateDelegationTarget runs — a denied delegation is blocked.
    await assert.rejects(
      plugin["tool.execute.before"](
        { tool: "task", sessionID: "s", callID: "c" },
        { args: { subagent_type: "kiwi" } },
      ),
      /not allowed/,
    );
  });

  it("task-prompt only → after runs nudgeTaskOutput but not post-task", async () => {
    const plugin = await pluginWithHooks(["task-prompt"]);
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
      "post-task handler must not run",
    );
  });

  it("post-task-nudge only → after appends VERIFY_REMINDER, no guidance", async () => {
    const plugin = await pluginWithHooks(["post-task-nudge"]);
    const output: { output?: string } = { output: "result" };
    await plugin["tool.execute.after"](
      { tool: "task", sessionID: "s", callID: "c" },
      output,
    );
    assert.ok(output.output?.includes(VERIFY_REMINDER));
    assert.ok(
      !output.output?.includes("--- Guidance for next time ---"),
      "task-prompt handler must not run",
    );
  });

  it("direct-work-nudge only → after appends the edit nudge for dolphin", async () => {
    const plugin = await pluginWithHooks(["direct-work-nudge"]);
    sessionAgentMap.set("s", "dolphin");
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

  it("context-metrics only → transform measures but does not prune", async () => {
    const plugin = await pluginWithHooks(["context-metrics"]);
    const output = { messages: transformMessages() };
    await plugin["experimental.chat.messages.transform"]({}, output);

    const events = logEvents().map((e) => e.event);
    assert.ok(events.includes("context_measured"), "metrics handler must run");
    assert.ok(
      !events.includes("refs_assigned"),
      "pruning handler must not run",
    );
  });

  it("context-pruning only → transform prunes but does not measure", async () => {
    const plugin = await pluginWithHooks(["context-pruning"]);
    const output = { messages: transformMessages() };
    await plugin["experimental.chat.messages.transform"]({}, output);

    const events = logEvents().map((e) => e.event);
    assert.ok(events.includes("refs_assigned"), "pruning handler must run");
    assert.ok(
      !events.includes("context_measured"),
      "metrics handler must not run",
    );
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
    const config: Record<string, any> = {};
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
    const config: Record<string, any> = {};
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

    const config: Record<string, any> = {};
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

    const config: Record<string, any> = {};
    await plugin.config(config);
    assert.deepEqual(config.experimental.primary_tools, ["compress"]);
  });

  it('tools=["decompress"] registers only decompress', async () => {
    const plugin = await pluginWithTools(["decompress"]);
    assert.equal(plugin.tool.compress, undefined);
    assert.ok(plugin.tool.decompress, "decompress must be registered");

    const config: Record<string, any> = {};
    await plugin.config(config);
    assert.deepEqual(config.experimental.primary_tools, ["decompress"]);
  });

  it("no tools → tool key absent, primary_tools untouched", async () => {
    const plugin = await pluginWithTools([]);
    assert.equal(plugin.tool, undefined);

    const config = { experimental: { primary_tools: ["bash"] } };
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
    const config: Record<string, any> = { agent: { dolphin: {}, kiwi: {} } };
    await plugin.config(config);
    assert.ok(typeof config.agent.dolphin.prompt === "string");
    assert.equal(config.agent.kiwi.prompt, undefined);
  });

  it("empty agents list → no prompt injection", async () => {
    const plugin = await makePlugin({
      mode: { poly: { ...POLY_PROFILE, agents: [] } },
    });
    const config: Record<string, any> = { agent: { dolphin: {} } };
    await plugin.config(config);
    assert.equal(config.agent.dolphin.prompt, undefined);
  });
});

describe("skills gated by the profile skills list", () => {
  it("registers only the profile-listed skills", async () => {
    const plugin = await makePlugin({
      mode: { poly: { ...POLY_PROFILE, skills: ["git-commit"] } },
    });
    const config: Record<string, any> = {};
    await plugin.config(config);
    assert.equal(config.skills.paths.length, 1);
    assert.ok(config.skills.paths[0].endsWith("git-commit"));
  });

  it("empty skills list → no skill paths", async () => {
    const plugin = await makePlugin({
      mode: { poly: { ...POLY_PROFILE, skills: [] } },
    });
    const config: Record<string, any> = {};
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
      [
        "chat.params",
        "config",
        "event",
        "experimental.chat.system.transform",
        "experimental.text.complete",
      ].sort(),
    );
  });

  it("config hook performs no profile-driven registration when profile is null", async () => {
    const plugin = await makePlugin({});
    const config: Record<string, any> = { agent: { dolphin: {} } };
    await plugin.config(config);
    assert.equal(config.agent.dolphin.prompt, undefined);
    assert.equal(config.skills, undefined);
    assert.equal(config.experimental, undefined);
    assert.equal(config.command, undefined);
  });

  it("infrastructure hooks keep working with a null profile", async () => {
    const plugin = await makePlugin({});

    // experimental.text.complete strips zoo-msg-id refs.
    const out = { text: "foo <zoo-msg-id>m0001</zoo-msg-id>" };
    await plugin["experimental.text.complete"](
      { sessionID: "s", messageID: "m", partID: "p" },
      out,
    );
    assert.equal(out.text, "foo ");

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
    assert.equal(sessionAgentMap.get("s3"), "dolphin");
  });
});
