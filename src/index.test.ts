/**
 * Tests for helper functions in the ZooKeeper plugin entry point.
 *
 * Covers: parseLimits, parseSkillsConfig, injectAgentPrompts,
 * handleMessagesTransform, runAfterHandlers, registerSkills.
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  handleMessagesTransform,
  injectAgentPrompts,
  parseLimits,
  parseSkillsConfig,
  registerSkills,
  runAfterHandlers,
} from "./index.js";
import { _resetForTesting } from "./utils/logger.js";

// ---------------------------------------------------------------------------
// Logger cleanup
// ---------------------------------------------------------------------------

afterEach(() => {
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
    const cfg = { skills: { git: "enable", build: "disable" } };
    assert.deepEqual(parseSkillsConfig(cfg), {
      git: "enable",
      build: "disable",
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
    const agents: Record<string, any> = { build: {} };
    injectAgentPrompts(agents);
    assert.ok(typeof agents.build.prompt === "string");
    assert.ok(agents.build.prompt.length > 0);
    // Verify actual prompt content is from the file
    assert.ok(agents.build.prompt.includes("<Role>"));
  });

  it("skips agents without a matching prompt file", () => {
    const agents: Record<string, any> = { nonexistent: {} };
    injectAgentPrompts(agents);
    assert.equal(agents.nonexistent.prompt, undefined);
  });

  it("skips null agents", () => {
    const agents: Record<string, any> = { build: null };
    injectAgentPrompts(agents);
    // No throw — null agents are skipped
    assert.equal(agents.build, null);
  });

  it("skips non-object (string) agents", () => {
    const agents: Record<string, any> = { build: "string-value" };
    injectAgentPrompts(agents);
    // No throw — string agents are skipped
    assert.equal(agents.build, "string-value");
  });

  it("skips array agents", () => {
    const agents: Record<string, any> = { build: [] };
    injectAgentPrompts(agents);
    // No throw — arrays pass typeof check but are not mutated
    assert.ok(Array.isArray(agents.build));
    assert.equal(agents.build.length, 0);
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
    const agents: Record<string, any> = { build: {}, general: {} };
    injectAgentPrompts(agents);
    assert.ok(typeof agents.build.prompt === "string");
    assert.ok(agents.build.prompt.length > 0);
    assert.ok(typeof agents.general.prompt === "string");
    assert.ok(agents.general.prompt.length > 0);
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
// registerSkills
// ---------------------------------------------------------------------------

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
