/**
 * Tests for the OpenCode plugin entry point.
 *
 * Covers the plugin object `src/opencode.ts` derives from the composition:
 * which hook handlers exist for a profile-driven selection and for a null
 * profile, and the `/go` handoff executor derived from the selection.
 * The behavior of each handler is covered by the adapter tests
 * (`adapters/opencode/`), and profile-driven registration by
 * `opencode.mode.test.ts`.
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { _resetOpenCodeProcessStateForTesting } from "./adapters/opencode/process.js";
import { buildPlugin } from "./opencode.js";
import { cleanupPlanDir, writePlanFile } from "./testkits/plans.js";
import { makeTmpDir } from "./testkits/tmp.js";
import { _resetForTesting } from "./utils/logger.js";

afterEach(() => {
  _resetOpenCodeProcessStateForTesting();
  _resetForTesting();
});

// ---------------------------------------------------------------------------
// Plugin wiring smoke test — hook handlers exist on the plugin object.
// Existence only; the behavior of each handler is covered by the hook tests
// (which drive the hook-directory adapters directly).  Profile-driven
// registration is covered in `src/opencode.mode.test.ts`.
// ---------------------------------------------------------------------------

describe("plugin wiring", () => {
  /** A minimal full-profile zoo config (mirrors [zoo.mode.poly]). */
  const POLY_ZOO = {
    mode: {
      poly: {
        agents: ["dolphin"],
        skills: [],
        hooks: [
          "subagent-prompt",
          "subagent-delegation",
          "direct-work-nudge",
          "post-subagent-nudge",
          "json-error-nudge",
          "context-pruning",
          "reply-strip",
        ],
        tools: [],
        commands: ["go", "dcp"],
      },
    },
  };

  /**
   * A client stub answering the pre-read `config.get` with the host's
   * agent table, exactly as the real SDK client does.
   *
   * @param agent - The host `config.agent` table.
   * @returns The client stub.
   */
  function hostClient(agent: Record<string, any>): Record<string, any> {
    return { config: { get: async () => ({ data: { agent } }) } };
  }

  it("exposes all profile-driven hook handlers when the poly profile is active", async () => {
    const plugin = (await buildPlugin(
      { client: hostClient({ dolphin: { mode: "primary" } }) },
      POLY_ZOO,
      { agent: { dolphin: { mode: "primary" } } },
    )) as Record<string, unknown>;
    const handlerNames = [
      "config",
      "event",
      "experimental.chat.messages.transform",
      "experimental.chat.system.transform",
      "experimental.text.complete",
      "tool.definition",
      "tool.execute.before",
      "tool.execute.after",
      "command.execute.before",
    ];
    for (const name of handlerNames) {
      assert.equal(
        typeof plugin[name],
        "function",
        `expected hook handler "${name}" to be a function`,
      );
    }
  });

  it("exposes only the infrastructure hooks when the profile is null", async () => {
    // An empty zoo config has no [zoo.mode.*] section — every
    // profile-driven registration is skipped.
    // A disabled selection needs no host config: the client exposes no
    // `config.get` at all and the entry point must not ask for one.
    const plugin = (await buildPlugin({ client: {} }, {})) as Record<
      string,
      unknown
    >;
    const infrastructure = [
      "config",
      "event",
      "experimental.chat.system.transform",
    ];
    for (const name of infrastructure) {
      assert.equal(
        typeof plugin[name],
        "function",
        `expected infrastructure hook "${name}" to be a function`,
      );
    }
    assert.equal(plugin["tool.definition"], undefined);
    assert.equal(plugin["tool.execute.before"], undefined);
    assert.equal(plugin["tool.execute.after"], undefined);
    assert.equal(plugin["experimental.chat.messages.transform"], undefined);
    assert.equal(plugin["experimental.text.complete"], undefined);
    assert.equal(plugin["command.execute.before"], undefined);
    assert.equal(plugin.tool, undefined);
  });
});

// ---------------------------------------------------------------------------
// /go handoff executor derived from the selection
// ---------------------------------------------------------------------------

describe("plugin wiring — /go handoff executor", () => {
  /** A workspace with one approved (planning-done) plan. */
  function planWorkspace(): string {
    const dir = makeTmpDir("zoo-go-handoff");
    writePlanFile(
      dir,
      "demo-plan.md",
      { status: "planning-done", slug: "demo-plan" },
      "body",
    );
    return dir;
  }

  /** A client that records the agent every created session carries. */
  function recordingClient(created: string[]): Record<string, unknown> {
    return {
      session: {
        create: async (input: { body: { agent: string } }) => {
          created.push(input.body.agent);
          return { data: { id: "ses-exec" } };
        },
        promptAsync: async () => ({}),
        prompt: async () => ({}),
      },
    };
  }

  /**
   * A client recording the executor each handoff step was given: the
   * created session, the `promptAsync` reference, and the silent
   * confirmation text.
   */
  function executorClient(recorded: {
    created: string[];
    delivered: string[];
    confirmed: string[];
  }): Record<string, unknown> {
    return {
      session: {
        create: async (input: { body: { agent: string } }) => {
          recorded.created.push(input.body.agent);
          return { data: { id: "ses-exec" } };
        },
        promptAsync: async (input: { body: { agent: string } }) => {
          recorded.delivered.push(input.body.agent);
          return {};
        },
        prompt: async (input: { body: { parts: Array<{ text: string }> } }) => {
          recorded.confirmed.push(input.body.parts[0].text);
          return {};
        },
      },
    };
  }

  /**
   * Answer the pre-read `config.get` with the host's agent table.
   *
   * @param client - The stub client.
   * @param agent - The host `config.agent` table.
   * @returns The client, extended with `config.get`.
   */
  function withAgentTable(
    client: Record<string, unknown>,
    agent: Record<string, any>,
  ): Record<string, any> {
    return { ...client, config: { get: async () => ({ data: { agent } }) } };
  }

  /** Run the `/go` command through the assembled hook. */
  async function runGo(
    plugin: Record<string, any>,
    sessionID: string,
  ): Promise<void> {
    await assert.rejects(() =>
      plugin["command.execute.before"]({
        command: "go",
        sessionID,
        arguments: "",
      }),
    );
  }

  it("creates the executor session under the selection's orchestrator", async () => {
    const dir = planWorkspace();
    const created: string[] = [];
    try {
      // The profile lists mola before dolphin; the executor must follow
      // the declared orchestrator role, never the profile's agent order.
      const plugin = (await buildPlugin(
        {
          client: withAgentTable(recordingClient(created), {
            dolphin: { mode: "primary" },
            mola: { mode: "primary" },
          }),
          directory: dir,
        },
        {
          mode: {
            poly: {
              agents: ["mola", "dolphin"],
              skills: [],
              hooks: [],
              tools: [],
              commands: ["go"],
            },
          },
        },
        {
          agent: {
            dolphin: { mode: "primary" },
            mola: { mode: "primary" },
          },
        },
      )) as Record<string, any>;

      await runGo(plugin, "ses-parent");

      assert.deepEqual(created, ["dolphin"]);
    } finally {
      cleanupPlanDir(dir);
    }
  });

  it("carries the selection's orchestrator through create, delivery, and confirmation", async () => {
    const dir = planWorkspace();
    const recorded: {
      created: string[];
      delivered: string[];
      confirmed: string[];
    } = { created: [], delivered: [], confirmed: [] };
    try {
      const plugin = (await buildPlugin(
        {
          client: withAgentTable(executorClient(recorded), {
            dolphin: { mode: "primary" },
          }),
          directory: dir,
        },
        {
          mode: {
            poly: {
              agents: ["dolphin"],
              skills: [],
              hooks: [],
              tools: [],
              commands: ["go"],
            },
          },
        },
        { agent: { dolphin: { mode: "primary" } } },
      )) as Record<string, any>;

      await runGo(plugin, "ses-parent");

      // One executor for the whole handoff: the created session, the
      // model-visible reference, and the silent confirmation.
      assert.deepEqual(recorded.created, ["dolphin"]);
      assert.deepEqual(recorded.delivered, ["dolphin"]);
      assert.deepEqual(recorded.confirmed, ["Plan handed off to dolphin."]);
    } finally {
      cleanupPlanDir(dir);
    }
  });

  it("keeps the plugin when the profile cannot provide the orchestrator", async () => {
    const dir = planWorkspace();
    const created: string[] = [];
    try {
      // beaver is a subagent and the orchestrator is absent: the selection
      // is invalid, so this configuration registers nothing — the
      // infrastructure hooks keep working and no unit factory runs.
      const plugin = (await buildPlugin(
        {
          client: withAgentTable(recordingClient(created), {
            beaver: { mode: "subagent" },
          }),
          directory: dir,
        },
        {
          mode: {
            poly: {
              agents: ["beaver"],
              skills: [],
              hooks: [],
              tools: [],
              commands: ["go"],
            },
          },
        },
        { agent: { beaver: { mode: "subagent" } } },
      )) as Record<string, any>;

      assert.equal(plugin["command.execute.before"], undefined);
      assert.equal(typeof plugin.event, "function");
      assert.equal(
        typeof plugin["experimental.chat.system.transform"],
        "function",
      );
      const config: Record<string, any> = { agent: {} };
      await plugin.config(config);
      assert.equal(config.default_agent, undefined);
      assert.deepEqual(created, []);
    } finally {
      cleanupPlanDir(dir);
    }
  });
});
