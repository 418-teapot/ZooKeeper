/**
 * Tests for the OpenCode host config boundary.
 *
 * Covers the host-config projection the planner reads (which agents the
 * host will materialise, and which of them it accepts as its default
 * primary), the failure classification of the pre-read, and the writes the
 * `config` hook performs for a ready selection — including the final
 * materialisation check that runs before the first write.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Capabilities } from "../../core/ports/index.js";
import type { Selection } from "../../core/selection.js";
import type { ToolContribution } from "../../core/unit.js";
import {
  composedResult,
  readySelection,
} from "../../testkits/contributions.js";
import { createConfigHook, readHostMaterialisation } from "./config.js";

/** Minimal deps: the hook only reads `limits`. */
const DEPS: Partial<Capabilities> = { limits: {} };

/**
 * A tool contribution stub, keyed by name only.
 *
 * @param name - The tool name.
 * @returns The contribution.
 */
function tool(name: string): ToolContribution {
  return {
    name,
    description: name,
    execute: async () => ({ text: name }),
  };
}

/** A client stub answering the pre-read with the given config. */
function clientAnswering(data: unknown): Record<string, any> {
  return { config: { get: async () => ({ data }) } };
}

/** A host config table carrying the given agent entries. */
function hostConfig(agent: Record<string, any>): Record<string, any> {
  return { agent };
}

/**
 * Build the config hook under test.
 *
 * @param overrides - The composition slots the hook reads.
 * @param selection - The selection the composition was built from.
 * @returns The hook.
 */
function hookFor(
  overrides: Parameters<typeof composedResult>[0],
  selection: Selection = readySelection(),
): (config: any) => Promise<void> {
  return createConfigHook(composedResult(overrides), DEPS, selection);
}

// ---------------------------------------------------------------------------
// Host config projection
// ---------------------------------------------------------------------------

describe("readHostMaterialisation", () => {
  it("separates materialised agents from default-agent candidates", async () => {
    const facts = await readHostMaterialisation(
      clientAnswering({
        agent: {
          dolphin: { mode: "primary" },
          mola: { mode: "all" },
          beaver: { mode: "subagent" },
          hiddenOne: { mode: "primary", hidden: true },
          gone: { mode: "primary", disable: true },
        },
      }),
    );

    // A disabled entry is not materialised at all; a subagent or hidden
    // one is materialised but unusable as the host's default agent.
    assert.deepEqual(facts, {
      kind: "available",
      facts: {
        agents: ["dolphin", "mola", "beaver", "hiddenOne"],
        defaultAgents: ["dolphin", "mola"],
      },
    });
  });

  it("reports nothing for a config without an agent table", async () => {
    for (const config of [{}, { agent: [] }]) {
      assert.deepEqual(await readHostMaterialisation(clientAnswering(config)), {
        kind: "available",
        facts: { agents: [], defaultAgents: [] },
      });
    }
  });

  it("reports the missing API instead of throwing", async () => {
    assert.deepEqual(await readHostMaterialisation({}), {
      kind: "unavailable",
      cause: "no-api",
      detail: "宿主 SDK 客户端缺少 config.get，无法预读宿主配置",
    });
  });

  it("reports a failed request instead of throwing", async () => {
    const client = {
      config: {
        get: async () => {
          throw new Error("instance not ready");
        },
      },
    };

    const answer = await readHostMaterialisation(client);
    assert.equal(answer.kind, "unavailable");
    assert.equal(
      answer.kind === "unavailable" && answer.cause,
      "request-failed",
    );
    assert.ok(
      answer.kind === "unavailable" &&
        answer.detail.includes("instance not ready"),
    );
  });

  it("reports a response without data instead of throwing", async () => {
    const client = {
      config: { get: async () => ({ error: { status: 500 } }) },
    };

    const answer = await readHostMaterialisation(client);
    assert.equal(answer.kind, "unavailable");
    assert.equal(answer.kind === "unavailable" && answer.cause, "no-data");
    assert.ok(answer.kind === "unavailable" && answer.detail.includes("500"));
  });

  it("reports an array response as missing data", async () => {
    // An array is serialisable but cannot carry the config table, so it is
    // not a usable host config.
    const answer = await readHostMaterialisation(clientAnswering([]));
    assert.equal(answer.kind, "unavailable");
    assert.equal(answer.kind === "unavailable" && answer.cause, "no-data");
  });

  it("lets an unexpected program error escape", async () => {
    // Only the expected environment failures become facts: a fault of the
    // client itself is not a statement about the host's agents.
    const client = Object.defineProperty({}, "config", {
      get() {
        throw new Error("SDK bug");
      },
    });

    await assert.rejects(readHostMaterialisation(client), /SDK bug/);
  });
});

// ---------------------------------------------------------------------------
// Config writes of a ready selection
// ---------------------------------------------------------------------------

describe("createConfigHook — ready selection", () => {
  it("writes the orchestrator, prompts, skill paths, tools and commands", async () => {
    const hook = hookFor(
      {
        agents: [
          { name: "dolphin", prompt: "<Role>dolphin</Role>" },
          { name: "beaver", prompt: "<Role>beaver</Role>" },
        ],
        skills: [{ name: "wiki-query", path: "/zoo/skills/wiki-query" }],
        tools: { compress: tool("compress"), decompress: tool("decompress") },
        commands: {
          go: { name: "go", description: "交接计划", handle: async () => {} },
        },
      },
      readySelection(["dolphin", "beaver"], "dolphin"),
    );
    const config = hostConfig({
      dolphin: { mode: "primary" },
      beaver: { mode: "subagent" },
    });

    await hook(config);

    assert.equal(config.default_agent, "dolphin");
    assert.equal(config.agent.dolphin.prompt, "<Role>dolphin</Role>");
    assert.equal(config.agent.beaver.prompt, "<Role>beaver</Role>");
    assert.deepEqual(config.skills, { paths: ["/zoo/skills/wiki-query"] });
    assert.deepEqual(config.experimental.primary_tools, [
      "compress",
      "decompress",
    ]);
    assert.deepEqual(config.command, {
      go: { template: "", description: "交接计划" },
    });
  });

  it("skips a contributed agent the host does not materialise", async () => {
    const hook = hookFor(
      {
        agents: [
          { name: "dolphin", prompt: "<Role>dolphin</Role>" },
          { name: "ghost", prompt: "<Role>ghost</Role>" },
        ],
      },
      readySelection(["dolphin"], "dolphin"),
    );
    const config = hostConfig({
      dolphin: { mode: "primary" },
      ghost: "not-an-agent-table",
    });

    await hook(config);

    assert.equal(config.agent.dolphin.prompt, "<Role>dolphin</Role>");
    assert.equal(config.agent.ghost, "not-an-agent-table");
  });

  it("skips an empty prompt", async () => {
    const hook = hookFor(
      { agents: [{ name: "dolphin", prompt: "" }] },
      readySelection(["dolphin"], "dolphin"),
    );
    const config = hostConfig({ dolphin: { mode: "primary" } });

    await hook(config);

    assert.equal(config.agent.dolphin.prompt, undefined);
  });

  it("appends the selected skill paths after the host's own", async () => {
    const hook = hookFor(
      {
        skills: [
          { name: "a", path: "/zoo/skills/a" },
          { name: "b", path: "/zoo/skills/b" },
        ],
      },
      readySelection(),
    );
    const config = { skills: { paths: ["/host/skills"] } };

    await hook(config);

    assert.deepEqual(config.skills.paths, [
      "/host/skills",
      "/zoo/skills/a",
      "/zoo/skills/b",
    ]);
  });

  it("registers no skill when the profile resolved no directory", async () => {
    const hook = hookFor({}, readySelection());
    const config: Record<string, any> = {};

    await hook(config);

    assert.deepEqual(config.skills, { paths: [] });
  });

  it("leaves primary_tools untouched when the profile lists no known tool", async () => {
    const hook = hookFor({});
    const config = { experimental: { primary_tools: ["bash"] } };

    await hook(config);

    assert.deepEqual(config.experimental.primary_tools, ["bash"]);
  });

  it("appends compress then decompress and never duplicates them", async () => {
    const hook = hookFor({
      tools: { compress: tool("compress"), decompress: tool("decompress") },
    });
    const config = {
      experimental: { primary_tools: ["bash", "decompress"] },
    };

    await hook(config);

    assert.deepEqual(config.experimental.primary_tools, [
      "bash",
      "decompress",
      "compress",
    ]);

    await hook(config);

    assert.deepEqual(config.experimental.primary_tools, [
      "bash",
      "decompress",
      "compress",
    ]);
  });

  it("throws when a selected agent is not materialised, before any write", async () => {
    const hook = hookFor(
      {
        agents: [{ name: "dolphin", prompt: "<Role>dolphin</Role>" }],
        skills: [{ name: "wiki-query", path: "/zoo/skills/wiki-query" }],
      },
      readySelection(["dolphin", "beaver"], "dolphin"),
    );
    const config = hostConfig({ dolphin: { mode: "primary" } });
    const before = JSON.stringify(config);

    await assert.rejects(hook(config), /选中的 agent 未由宿主配置物化/);

    assert.equal(JSON.stringify(config), before);
  });

  it("throws when the orchestrator is a subagent in the host config", async () => {
    const hook = hookFor({}, readySelection(["dolphin"], "dolphin"));
    const config = hostConfig({ dolphin: { mode: "subagent" } });

    await assert.rejects(hook(config), /不能作为默认 agent/);
    assert.equal(config.default_agent, undefined);
  });

  it("throws when the orchestrator is hidden in the host config", async () => {
    const hook = hookFor({}, readySelection(["dolphin"], "dolphin"));
    const config = hostConfig({ dolphin: { mode: "primary", hidden: true } });

    await assert.rejects(hook(config), /不能作为默认 agent/);
    assert.equal(config.default_agent, undefined);
  });
});

// ---------------------------------------------------------------------------
// A non-ready selection registers nothing
// ---------------------------------------------------------------------------

describe("createConfigHook — non-ready selection", () => {
  it("leaves the config untouched for an invalid selection", async () => {
    // The entry point hands an invalid selection to the adapter instead of
    // refusing the plugin: the configuration is closed, the infrastructure
    // is not.
    const selection: Selection = {
      ...readySelection(["dolphin"], "dolphin"),
      status: "invalid",
    };
    const hook = hookFor(
      {
        agents: [{ name: "dolphin", prompt: "<Role>dolphin</Role>" }],
        skills: [{ name: "wiki-query", path: "/zoo/skills/wiki-query" }],
      },
      selection,
    );
    const config = hostConfig({ dolphin: { mode: "primary" } });
    config.default_agent = "host-declared";

    await hook(config);

    assert.equal(config.default_agent, "host-declared");
    assert.equal(config.agent.dolphin.prompt, undefined);
    assert.equal(config.skills, undefined);
    assert.equal(config.command, undefined);
  });

  it("leaves the config untouched for a disabled selection", async () => {
    const selection: Selection = { ...readySelection(), status: "disabled" };
    const hook = hookFor(
      { skills: [{ name: "wiki-query", path: "/zoo/skills/wiki-query" }] },
      selection,
    );
    const config: Record<string, any> = {};

    await hook(config);

    assert.deepEqual(config, {});
  });
});
