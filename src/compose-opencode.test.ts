/**
 * Tests for `src/compose-opencode.ts`.
 *
 * Covers the host-config projection the planner reads (which agents the
 * host will materialise, and which of them it accepts as its default
 * primary) and the tool-definition translation: the deep-copy view
 * boundary (a contributor's in-place mutation never reaches the native
 * output before the write-back pass) and the change detection that decides
 * which fields the write-back touches.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  applyToolDefinitionView,
  hostMaterialisation,
  readHostMaterialisation,
  toToolDefinitionView,
} from "./compose-opencode.js";
import type { ToolArgDefinition, ToolDefinitionView } from "./core/unit.js";

/** The view's argument map, asserted present. */
function argsOf(view: ToolDefinitionView): Record<string, ToolArgDefinition> {
  assert.ok(view.args);
  return view.args;
}

/** A raw OpenCode `tool.definition` output fixture. */
function output(): {
  description: string;
  parameters: Record<string, unknown>;
} {
  return {
    description: "Launch a subagent",
    parameters: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "The subagent prompt" },
        agent: { type: "string", description: "目标 agent" },
      },
    },
  };
}

describe("toToolDefinitionView / applyToolDefinitionView", () => {
  it("copies argument schemas so an in-place view edit never aliases the native output", () => {
    const native = output();
    const view = toToolDefinitionView("subagent", native);

    argsOf(view).prompt.description = "enriched";

    assert.equal(
      (native.parameters.properties as any).prompt.description,
      "The subagent prompt",
      "the native schema must stay untouched before write-back",
    );
    assert.equal(argsOf(view).prompt.description, "enriched");
  });

  it("writes only the changed description back into the native output", () => {
    const native = output();
    const view = toToolDefinitionView("subagent", native);
    argsOf(view).prompt.description = "enriched";

    applyToolDefinitionView(view, native);

    assert.equal(
      (native.parameters.properties as any).prompt.description,
      "enriched",
    );
    assert.equal(
      (native.parameters.properties as any).agent.description,
      "目标 agent",
      "an untouched argument keeps its native description",
    );
  });

  it("writes a changed top-level description back", () => {
    const native = output();
    const view = toToolDefinitionView("subagent", native);
    view.description = "rewritten";

    applyToolDefinitionView(view, native);

    assert.equal(native.description, "rewritten");
  });

  it("never clears the top-level description to undefined", () => {
    const native = output();
    const view = toToolDefinitionView("subagent", native);
    view.description = undefined;

    applyToolDefinitionView(view, native);

    assert.equal(native.description, "Launch a subagent");
  });

  it("ignores arguments a contributor added to the view", () => {
    const native = output();
    const view = toToolDefinitionView("subagent", native);
    argsOf(view).added = { description: "new arg" };

    applyToolDefinitionView(view, native);

    assert.equal(
      (native.parameters.properties as any).added,
      undefined,
      "the write-back must not add native properties",
    );
  });

  it("leaves the native output untouched when nothing changed", () => {
    const native = output();
    const view = toToolDefinitionView("subagent", native);
    const before = JSON.stringify(native);

    applyToolDefinitionView(view, native);

    assert.equal(JSON.stringify(native), before);
  });
});

describe("hostMaterialisation", () => {
  it("separates materialised agents from default-agent candidates", () => {
    const facts = hostMaterialisation({
      agent: {
        dolphin: { mode: "primary" },
        mola: { mode: "all" },
        beaver: { mode: "subagent" },
        hiddenOne: { mode: "primary", hidden: true },
        gone: { mode: "primary", disable: true },
      },
    });

    // A disabled entry is not materialised at all; a subagent or hidden
    // one is materialised but unusable as the host's default agent.
    assert.deepEqual(facts.agents, ["dolphin", "mola", "beaver", "hiddenOne"]);
    assert.deepEqual(facts.defaultAgents, ["dolphin", "mola"]);
  });

  it("reports nothing for a config without an agent table", () => {
    for (const config of [{}, null, undefined, { agent: [] }]) {
      assert.deepEqual(hostMaterialisation(config), {
        agents: [],
        defaultAgents: [],
      });
    }
  });
});

describe("readHostMaterialisation", () => {
  it("answers the projected facts when the host config is readable", async () => {
    const client = {
      config: {
        get: async () => ({
          data: {
            agent: {
              dolphin: { mode: "primary" },
              beaver: { mode: "subagent" },
            },
          },
        }),
      },
    };

    assert.deepEqual(await readHostMaterialisation(client), {
      kind: "available",
      facts: { agents: ["dolphin", "beaver"], defaultAgents: ["dolphin"] },
    });
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
    const client = { config: { get: async () => ({ data: [] }) } };

    const answer = await readHostMaterialisation(client);
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
