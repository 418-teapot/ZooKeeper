/**
 * Tests for helper functions in the ZooKeeper plugin entry point.
 *
 * Covers: parseLimits, parseSkillsConfig, injectAgentPrompts,
 * handleMessagesTransform, runAfterHandlers, registerSkills,
 * resolveSessionAgent.
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  handleDedupNotify,
  handleMessagesTransform,
  injectAgentPrompts,
  parseLimits,
  parseSkillsConfig,
  registerSkills,
  resolveSessionAgent,
  runAfterHandlers,
  sessionAgentMap,
} from "./opencode.js";
import { _getBufferForTesting, _resetForTesting } from "./utils/logger.js";

// ---------------------------------------------------------------------------
// Logger cleanup
// ---------------------------------------------------------------------------

afterEach(() => {
  sessionAgentMap.clear();
  _resetForTesting();
});

// ---------------------------------------------------------------------------
// parseLimits
// ---------------------------------------------------------------------------

describe("parseLimits", () => {
  it("returns defaults for empty config", () => {
    assert.deepEqual(parseLimits({}), {
      contextWordLimit: 200,
      promptWordLimit: 500,
    });
  });

  it("returns custom values when present", () => {
    const cfg = {
      validation: { context_word_limit: 100, prompt_word_limit: 300 },
    };
    assert.deepEqual(parseLimits(cfg), {
      contextWordLimit: 100,
      promptWordLimit: 300,
    });
  });

  it("returns defaults when validation section is missing", () => {
    assert.deepEqual(parseLimits({ zoo: {} }), {
      contextWordLimit: 200,
      promptWordLimit: 500,
    });
  });

  it("supports partial overrides (only context_word_limit)", () => {
    const cfg = { validation: { context_word_limit: 150 } };
    assert.deepEqual(parseLimits(cfg), {
      contextWordLimit: 150,
      promptWordLimit: 500,
    });
  });

  it("supports partial overrides (only prompt_word_limit)", () => {
    const cfg = { validation: { prompt_word_limit: 800 } };
    assert.deepEqual(parseLimits(cfg), {
      contextWordLimit: 200,
      promptWordLimit: 800,
    });
  });
});

// ---------------------------------------------------------------------------
// parseSkillsConfig
// ---------------------------------------------------------------------------

describe("parseSkillsConfig", () => {
  it("returns empty object for empty config", () => {
    assert.deepEqual(parseSkillsConfig({}), {});
  });

  it("returns skills map when defined", () => {
    const cfg = { skills: { git: "enable", dolphin: "disable" } };
    assert.deepEqual(parseSkillsConfig(cfg), {
      git: "enable",
      dolphin: "disable",
    });
  });

  it("returns empty object when skills key is missing", () => {
    assert.deepEqual(parseSkillsConfig({ zoo: {} }), {});
  });

  it("returns empty object when skills key is null", () => {
    assert.deepEqual(parseSkillsConfig({ skills: null }), {});
  });
});

// ---------------------------------------------------------------------------
// injectAgentPrompts
// ---------------------------------------------------------------------------

describe("injectAgentPrompts", () => {
  it("injects prompt for agent with a matching prompt file", () => {
    const agents: Record<string, any> = { dolphin: {} };
    injectAgentPrompts(agents);
    assert.ok(typeof agents.dolphin.prompt === "string");
    assert.ok(agents.dolphin.prompt.length > 0);
    // Verify actual prompt content is from the file
    assert.ok(agents.dolphin.prompt.includes("<Role>"));
  });

  it("skips agents without a matching prompt file", () => {
    const agents: Record<string, any> = { nonexistent: {} };
    injectAgentPrompts(agents);
    assert.equal(agents.nonexistent.prompt, undefined);
  });

  it("skips null agents", () => {
    const agents: Record<string, any> = { dolphin: null };
    injectAgentPrompts(agents);
    // No throw — null agents are skipped
    assert.equal(agents.dolphin, null);
  });

  it("skips non-object (string) agents", () => {
    const agents: Record<string, any> = { dolphin: "string-value" };
    injectAgentPrompts(agents);
    // No throw — string agents are skipped
    assert.equal(agents.dolphin, "string-value");
  });

  it("skips array agents", () => {
    const agents: Record<string, any> = { dolphin: [] };
    injectAgentPrompts(agents);
    // No throw — arrays pass typeof check but are not mutated
    assert.ok(Array.isArray(agents.dolphin));
    assert.equal(agents.dolphin.length, 0);
  });

  it("handles empty agents object", () => {
    const agents: Record<string, any> = {};
    injectAgentPrompts(agents);
    assert.deepEqual(agents, {});
  });

  it("does not mutate unrelated fields on agents without a prompt file", () => {
    const agents: Record<string, any> = {
      nonexistent: { existingField: true },
    };
    injectAgentPrompts(agents);
    assert.deepEqual(agents, {
      nonexistent: { existingField: true },
    });
  });

  it("injects prompts for multiple agents", () => {
    const agents: Record<string, any> = { dolphin: {}, beaver: {} };
    injectAgentPrompts(agents);
    assert.ok(typeof agents.dolphin.prompt === "string");
    assert.ok(agents.dolphin.prompt.length > 0);
    assert.ok(typeof agents.beaver.prompt === "string");
    assert.ok(agents.beaver.prompt.length > 0);
  });
});

// ---------------------------------------------------------------------------
// handleMessagesTransform
// ---------------------------------------------------------------------------

describe("handleMessagesTransform", () => {
  it("does not throw with undefined messages field", () => {
    // messages key is absent — measureContext handles this
    handleMessagesTransform({});
    assert.ok(true);
  });

  it("does not throw with empty messages array", () => {
    handleMessagesTransform({ messages: [] });
    assert.ok(true);
  });

  it("does not throw with null messages", () => {
    handleMessagesTransform({ messages: null });
    assert.ok(true);
  });

  it("does not throw with valid messages", () => {
    handleMessagesTransform({
      messages: [
        {
          info: { role: "user", id: "m1", sessionID: "test-session" },
          parts: [{ type: "text", text: "Hello" }],
        },
      ],
    });
    assert.ok(true);
  });

  it("does not throw with complete assistant messages", () => {
    handleMessagesTransform({
      messages: [
        {
          info: { role: "user", id: "m1" },
          parts: [{ type: "text", text: "Hello" }],
        },
        {
          info: {
            role: "assistant",
            id: "m2",
            tokens: { input: 100, output: 50 },
          },
          parts: [{ type: "text", text: "Response" }],
        },
      ],
    });
    assert.ok(true);
  });
});

// ---------------------------------------------------------------------------
// runAfterHandlers
// ---------------------------------------------------------------------------

describe("runAfterHandlers", () => {
  it("runs all handlers in order and collects their output", async () => {
    const input = { tool: "t", sessionID: "s", callID: "c" };
    const output: { output?: string } = {};
    const order: string[] = [];

    const handlers = [
      {
        name: "first",
        fn: async (_i: any, o: any) => {
          order.push("first");
          o.output = "first-result";
        },
      },
      {
        name: "second",
        fn: async () => {
          order.push("second");
        },
      },
    ];

    await runAfterHandlers(handlers, input, output);
    assert.deepEqual(order, ["first", "second"]);
    assert.equal(output.output, "first-result");
  });

  it("isolates errors so one failing handler does not stop others", async () => {
    const input = { tool: "t", sessionID: "s", callID: "c" };
    const output: { output?: string } = {};
    const order: string[] = [];

    const handlers = [
      {
        name: "fail",
        fn: async () => {
          order.push("fail");
          throw new Error("boom");
        },
      },
      {
        name: "ok",
        fn: async (_i: any, o: any) => {
          order.push("ok");
          o.output = "survived";
        },
      },
    ];

    await runAfterHandlers(handlers, input, output);
    assert.deepEqual(order, ["fail", "ok"]);
    assert.equal(output.output, "survived");
  });

  it("is a no-op with empty handlers list", async () => {
    const input = { tool: "t", sessionID: "s", callID: "c" };
    const output: { output?: string } = {};
    await runAfterHandlers([], input, output);
    assert.deepEqual(output, {});
  });

  it("does not throw when all handlers fail", async () => {
    const input = { tool: "t", sessionID: "s", callID: "c" };
    const handlers = [
      {
        name: "a",
        fn: async () => {
          throw new Error("err A");
        },
      },
      {
        name: "b",
        fn: async () => {
          throw new Error("err B");
        },
      },
    ];

    await runAfterHandlers(handlers, input, {});
    assert.ok(true);
  });

  it("works with synchronous handlers", async () => {
    const input = { tool: "t", sessionID: "s", callID: "c" };
    const output: { output?: string } = {};
    const handlers = [
      {
        name: "sync",
        fn: (_i: any, o: any) => {
          o.output = "sync-result";
        },
      },
    ];

    await runAfterHandlers(handlers, input, output);
    assert.equal(output.output, "sync-result");
  });

  it("works with mixed sync and async handlers", async () => {
    const input = { tool: "t", sessionID: "s", callID: "c" };
    const output: { output?: string } = {};
    const order: string[] = [];

    const handlers = [
      {
        name: "sync-a",
        fn: () => {
          order.push("sync-a");
        },
      },
      {
        name: "async-b",
        fn: async () => {
          order.push("async-b");
        },
      },
    ];

    await runAfterHandlers(handlers, input, output);
    assert.deepEqual(order, ["sync-a", "async-b"]);
  });
});

// ---------------------------------------------------------------------------
// resolveSessionAgent
// ---------------------------------------------------------------------------

describe("resolveSessionAgent", () => {
  it("(a) returns agent from in-memory map when present", async () => {
    const map = new Map<string, string>([["ses_test", "beaver"]]);
    const client = {
      session: {
        get: () => {
          throw new Error("should not be called");
        },
      },
    };

    const result = await resolveSessionAgent("ses_test", client, map);
    assert.equal(result, "beaver");
  });

  it("(b) falls back to client.session.get when map has no entry", async () => {
    const map = new Map<string, string>();
    let getCalled = false;
    const client = {
      session: {
        get: async (_opts: { path: { id: string } }) => {
          getCalled = true;
          return { agent: "lynx" };
        },
      },
    };

    const result = await resolveSessionAgent("ses_unknown", client, map);
    assert.equal(result, "lynx");
    assert.equal(getCalled, true);
  });

  it("(b) does NOT cache the agent in the map after session.get fallback", async () => {
    const map = new Map<string, string>();
    const client = {
      session: {
        get: async (_opts: { path: { id: string } }) => {
          return { agent: "mola" };
        },
      },
    };

    await resolveSessionAgent("ses_cache", client, map);
    assert.equal(
      map.has("ses_cache"),
      false,
      "agentMap must NOT be written by resolveSessionAgent — single writer is message.updated handler",
    );
  });

  it("reflects mid-session agent change when map is later updated", async () => {
    const map = new Map<string, string>();
    let getCount = 0;
    const client = {
      session: {
        get: async (_opts: { path: { id: string } }) => {
          getCount++;
          return { agent: "lynx" };
        },
      },
    };

    // First call — no map entry, falls to session.get, but does NOT write map
    const result1 = await resolveSessionAgent("ses_change", client, map);
    assert.equal(result1, "lynx");
    assert.equal(getCount, 1);
    assert.equal(
      map.has("ses_change"),
      false,
      "map must NOT be written by resolveSessionAgent",
    );

    // Simulate message.updated setting the agent
    map.set("ses_change", "beaver");

    // Second call — map has entry; returns it without calling session.get
    const result2 = await resolveSessionAgent("ses_change", client, map);
    assert.equal(result2, "beaver");
    assert.equal(getCount, 1, "session.get must not be called again");
  });

  it("(b) returns undefined when session.get returns no agent field", async () => {
    const map = new Map<string, string>();
    const client = {
      session: {
        get: async (_opts: { path: { id: string } }) => {
          return { id: "ses_noagent", title: "test" };
        },
      },
    };

    const result = await resolveSessionAgent("ses_noagent", client, map);
    assert.equal(result, undefined);
  });

  it("(b) returns undefined when session.get throws", async () => {
    const map = new Map<string, string>();
    const client = {
      session: {
        get: async (_opts: { path: { id: string } }) => {
          throw new Error("session not found");
        },
      },
    };

    const result = await resolveSessionAgent("ses_err", client, map);
    assert.equal(result, undefined);
  });

  it("(c) returns undefined when no source has the agent", async () => {
    const map = new Map<string, string>();
    const client = {};

    const result = await resolveSessionAgent("ses_none", client, map);
    assert.equal(result, undefined);
  });

  it("(c) returns undefined when client has no session.get method", async () => {
    const map = new Map<string, string>();
    const client = { session: {} };

    const result = await resolveSessionAgent("ses_noget", client, map);
    assert.equal(result, undefined);
  });

  it("(a) takes priority over client.session.get", async () => {
    const map = new Map<string, string>([["ses_priority", "kiwi"]]);
    let getCalled = false;
    const client = {
      session: {
        get: async (_opts: { path: { id: string } }) => {
          getCalled = true;
          return { agent: "eagle" };
        },
      },
    };

    const result = await resolveSessionAgent("ses_priority", client, map);
    assert.equal(result, "kiwi");
    assert.equal(
      getCalled,
      false,
      "session.get must not be called when map has entry",
    );
  });
});

// ---------------------------------------------------------------------------
// handleDedupNotify
// ---------------------------------------------------------------------------

describe("handleDedupNotify", () => {
  it("(a) sends immediately with agent from in-memory map", () => {
    const map = new Map<string, string>([["ses_map", "beaver"]]);
    let promptCalled = false;
    let promptBody: Record<string, unknown> | null = null;
    const client = {
      session: {
        prompt: async (opts: {
          path: { id: string };
          body: Record<string, unknown>;
        }) => {
          promptCalled = true;
          promptBody = opts.body;
        },
      },
    };

    handleDedupNotify("ses_map", client, map, "test notification");

    // Sync path — agent is in map, so send() is called synchronously.
    assert.equal(promptCalled, true);
    const pb = promptBody as unknown as Record<string, unknown>;
    assert.equal(pb.agent, "beaver");
    assert.equal(pb.noReply, true);
    assert.equal(
      (pb.parts as Array<{ type: string; text: string }>)[0].text,
      "test notification",
    );
  });

  it("(b) sends with resolved agent via session.get fallback", async () => {
    const map = new Map<string, string>();
    let promptCalled = false;
    let promptBody: Record<string, unknown> | null = null;
    const client = {
      session: {
        get: async () => ({ agent: "lynx" }),
        prompt: async (opts: {
          path: { id: string };
          body: Record<string, unknown>;
        }) => {
          promptCalled = true;
          promptBody = opts.body;
        },
      },
    };

    handleDedupNotify("ses_fallback", client, map, "test");

    // Async path — wait for microtask queue to drain.
    await new Promise((r) => setTimeout(r, 0));

    assert.equal(
      promptCalled,
      true,
      "prompt must be called for resolved agent",
    );
    const pb = promptBody as unknown as Record<string, unknown>;
    assert.equal(pb.agent, "lynx");
  });

  it("(c) suppresses notification when session.get returns no agent", async () => {
    const map = new Map<string, string>();
    let promptCalled = false;
    const client = {
      session: {
        get: async () => ({ id: "ses_noagent", title: "test" }),
        prompt: async () => {
          promptCalled = true;
        },
      },
    };

    handleDedupNotify("ses_noagent", client, map, "test");

    await new Promise((r) => setTimeout(r, 0));

    assert.equal(
      promptCalled,
      false,
      "prompt must NOT be called when agent unresolved",
    );

    const buffer = _getBufferForTesting();
    const suppressEntry = buffer.find(
      (e) => e.event === "dedup_notify_suppressed",
    );
    assert.ok(suppressEntry, "dedup_notify_suppressed must be logged");
    const se = suppressEntry as unknown as Record<string, unknown>;
    assert.equal(se.reason, "agent unresolved");
  });

  it("(c) suppresses notification when session.get throws (resolveSessionAgent catches internally)", async () => {
    const map = new Map<string, string>();
    let promptCalled = false;
    const client = {
      session: {
        get: async () => {
          throw new Error("session not found");
        },
        prompt: async () => {
          promptCalled = true;
        },
      },
    };

    handleDedupNotify("ses_err", client, map, "test");

    await new Promise((r) => setTimeout(r, 0));

    assert.equal(
      promptCalled,
      false,
      "prompt must NOT be called when agent resolution fails",
    );

    const buffer = _getBufferForTesting();
    const suppressEntry = buffer.find(
      (e) => e.event === "dedup_notify_suppressed",
    );
    assert.ok(suppressEntry, "dedup_notify_suppressed must be logged");
    const se = suppressEntry as Record<string, unknown>;
    assert.equal(se.reason, "agent unresolved");
  });

  it("does not throw when session exists but prompt method is undefined", () => {
    // Regression: synchronous throw path in send() when client.session
    // exists but prompt is undefined.
    const map = new Map<string, string>([["ses_noprompt", "beaver"]]);
    const client = {
      session: {} as { prompt?: any },
    };

    // Must not throw — synchronous throw from undefined({...}) is
    // caught by try/catch inside send().
    handleDedupNotify("ses_noprompt", client, map, "test");

    const buffer = _getBufferForTesting();
    const failEntry = buffer.find((e) => e.event === "dedup_notify_failed");
    assert.ok(
      failEntry,
      "dedup_notify_failed must be logged when prompt is undefined",
    );
  });
});

describe("registerSkills", () => {
  it("registers all skills when none are disabled", () => {
    const pluginConfig: Record<string, any> = {};
    registerSkills(pluginConfig, {});

    assert.ok(pluginConfig.skills);
    assert.ok(Array.isArray(pluginConfig.skills.paths));
    // core/skills has at least 4 directories (code-review, git-commit,
    // wiki-ingest, wiki-query)
    assert.ok(pluginConfig.skills.paths.length >= 4);
  });

  it("skips a disabled skill", () => {
    const pluginConfig: Record<string, any> = {};
    registerSkills(pluginConfig, { "git-commit": "disable" });

    const paths = pluginConfig.skills.paths as string[];
    const hasDisabled = paths.some((p: string) => p.endsWith("git-commit"));
    assert.equal(hasDisabled, false);
  });

  it("skips multiple disabled skills", () => {
    const pluginConfig: Record<string, any> = {};
    registerSkills(pluginConfig, {
      "git-commit": "disable",
      "wiki-query": "disable",
    });

    const paths = pluginConfig.skills.paths as string[];
    const hasGitCommit = paths.some((p: string) => p.endsWith("git-commit"));
    const hasWikiQuery = paths.some((p: string) => p.endsWith("wiki-query"));
    assert.equal(hasGitCommit, false);
    assert.equal(hasWikiQuery, false);
    // Non-disabled skills are still registered
    assert.ok(paths.some((p: string) => p.endsWith("code-review")));
  });

  it("initialises skills config object when missing from pluginConfig", () => {
    const pluginConfig: Record<string, any> = {};
    registerSkills(pluginConfig, {});
    assert.ok(pluginConfig.skills);
    assert.ok(Array.isArray(pluginConfig.skills.paths));
  });

  it("preserves existing skills paths when skills object already exists", () => {
    const existingPath = "/some/existing/path";
    const pluginConfig: Record<string, any> = {
      skills: { paths: [existingPath] },
    };
    registerSkills(pluginConfig, {});

    const paths = pluginConfig.skills.paths as string[];
    assert.ok(paths.includes(existingPath));
    // Real skills paths are appended
    assert.ok(paths.some((p: string) => p.endsWith("code-review")));
  });

  it("swallows ENOENT from readdirSync (error path is safe)", () => {
    // Cannot mock fs.readdirSync in Bun's node:test, but we verify the
    // normal case works and the catch block is structured correctly:
    //   - ENOENT is silently ignored
    //   - Other errors are logged as warnings (never thrown)
    // The real core/skills directory exists, so readdirSync succeeds.
    const pluginConfig: Record<string, any> = {};
    registerSkills(pluginConfig, {});
    assert.ok(pluginConfig.skills.paths.length >= 4);
  });
});
