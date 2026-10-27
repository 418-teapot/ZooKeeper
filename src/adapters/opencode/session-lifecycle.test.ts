/**
 * End-to-end session lifetime through `buildPlugin`.
 *
 * The always-on event hook is the only place OpenCode reports session
 * lifetime and per-session state, so this suite drives the assembled
 * plugin the way the host does: an abort, a wake echo, a deletion, the
 * plugin's own dispose — in the orders that used to leak one session's
 * state into another.  The expectations are the host-visible effects: the
 * `promptAsync` wakes delivered to the orchestrator, the agent registry,
 * and the captured model limit.  A deletion ends a session, a dispose only
 * stops this instance's scopes: the registry and the persisted context
 * survive the latter.
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  clearModelLimit,
  getModelLimit,
  setModelLimit,
} from "../../core/context/model-limits.js";
import { _resetContextStateManagerForTesting } from "../../core/context/runtime.js";
import { sessionAgentRegistry } from "../../core/session-agent.js";
import { buildPlugin } from "../../opencode.js";
import { _resetForTesting } from "../../utils/logger.js";

/** The agent-role table config.toml declares: dolphin is the orchestrator. */
const RAW_AGENTS = { agent: { dolphin: { mode: "primary" } } };

/** The profile that enables the todo-continuation settle judge. */
const PROFILE = {
  agents: ["dolphin"],
  skills: [],
  hooks: ["todo-continuation"],
  tools: [],
  commands: [],
};

/** An active todo item: the settle judge wakes on it. */
const ACTIVE_TODOS = [
  { content: "Wire source", status: "in_progress", priority: "high", id: "1" },
];

/** A settled turn that made progress, so nothing else silences it. */
const WORKED_TURN = [
  {
    info: { role: "user" },
    parts: [{ type: "text", text: "Implement the change." }],
  },
  {
    info: { role: "assistant" },
    parts: [
      { type: "tool", tool: "write", state: { status: "completed" } },
      { type: "text", text: "Implemented the change." },
    ],
  },
];

/** A recorded `promptAsync` call. */
type PromptCall = {
  path: { id: string };
  body: { agent?: string; messageID?: string };
};

/**
 * Build a stub OpenCode client answering the loop path and the pre-read.
 *
 * @param maxWakes - The `[zoo.continuation].max_wakes` allowance.
 * @returns The plugin, the recorded wakes, and the plugin input.
 */
async function buildTestPlugin(maxWakes = 3) {
  const calls: PromptCall[] = [];
  const client = {
    config: { get: async () => ({ data: RAW_AGENTS }) },
    session: {
      todo: async () => ({ data: ACTIVE_TODOS }),
      messages: async () => ({ data: WORKED_TURN }),
      promptAsync: async (input: PromptCall) => {
        calls.push(input);
        return {};
      },
    },
  };
  const plugin = (await buildPlugin(
    { client },
    {
      mode: { poly: PROFILE },
      continuation: { max_wakes: maxWakes },
    },
    RAW_AGENTS,
  )) as Record<string, any>;
  return { plugin, calls };
}

/** Bind one session to the orchestrator, as `message.updated` does. */
async function bindAgent(
  plugin: Record<string, any>,
  sessionID: string,
): Promise<void> {
  await plugin.event({
    event: {
      type: "message.updated",
      properties: { info: { agent: "dolphin", sessionID } },
    },
  });
}

/** Send one `session.idle` event for a session. */
async function idle(
  plugin: Record<string, any>,
  sessionID: string,
): Promise<void> {
  await plugin.event({
    event: { type: "session.idle", properties: { sessionID } },
  });
}

/** Delete one session. */
async function deleted(
  plugin: Record<string, any>,
  sessionID: string,
): Promise<void> {
  await plugin.event({
    event: { type: "session.deleted", properties: { info: { id: sessionID } } },
  });
}

afterEach(() => {
  _resetForTesting();
  _resetContextStateManagerForTesting();
  for (const sessionID of ["s1", "s2", "ghost"]) {
    sessionAgentRegistry.delete(sessionID);
    clearModelLimit(sessionID);
  }
});

describe("session lifetime — first observation", () => {
  it("wakes a session whose first event was not session.created", async () => {
    const { plugin, calls } = await buildTestPlugin();

    // No `session.created` ever reaches the plugin: the message binding and
    // the settle are the first words about this session.
    await bindAgent(plugin, "s1");
    await idle(plugin, "s1");

    assert.equal(calls.length, 1);
    assert.equal(calls[0].path.id, "s1");
  });

  it("creates nothing for an event without a session id", async () => {
    const { plugin, calls } = await buildTestPlugin();

    await plugin.event({
      event: { type: "message.updated", properties: { info: { agent: "x" } } },
    });
    await plugin.event({ event: { type: "session.idle", properties: {} } });
    await plugin.event({ event: { type: "session.error", properties: {} } });

    assert.equal(calls.length, 0);
    assert.equal(sessionAgentRegistry.resolve(""), undefined);
  });
});

describe("session lifetime — per-session state", () => {
  it("keeps one session's abort away from its sibling", async () => {
    const { plugin, calls } = await buildTestPlugin();
    await bindAgent(plugin, "s1");
    await bindAgent(plugin, "s2");

    await plugin.event({
      event: {
        type: "session.error",
        properties: { sessionID: "s1", error: { name: "MessageAbortedError" } },
      },
    });
    await idle(plugin, "s2");

    assert.deepEqual(
      calls.map((call) => call.path.id),
      ["s2"],
    );
  });

  it("keeps one session's reminder budget away from its sibling", async () => {
    const { plugin, calls } = await buildTestPlugin(1);
    await bindAgent(plugin, "s1");
    await bindAgent(plugin, "s2");

    await idle(plugin, "s1");
    await idle(plugin, "s1");
    assert.equal(calls.length, 1, "s1's allowance is spent");

    await idle(plugin, "s2");
    assert.deepEqual(
      calls.map((call) => call.path.id),
      ["s1", "s2"],
    );
  });
});

describe("session lifetime — deletion", () => {
  it("stops only the deleted session", async () => {
    const { plugin, calls } = await buildTestPlugin();
    await bindAgent(plugin, "s1");
    await bindAgent(plugin, "s2");

    await deleted(plugin, "s1");
    await idle(plugin, "s2");

    assert.deepEqual(
      calls.map((call) => call.path.id),
      ["s2"],
    );
    assert.equal(sessionAgentRegistry.resolve("s1"), undefined);
    assert.equal(sessionAgentRegistry.resolve("s2"), "dolphin");
  });

  it("does not rebuild a deleted session from a late event", async () => {
    const { plugin, calls } = await buildTestPlugin();
    await bindAgent(plugin, "s1");
    await deleted(plugin, "s1");

    // A late message update must not restore the binding the deletion
    // released, nor wake the deleted session.
    await plugin.event({
      event: {
        type: "message.updated",
        properties: { info: { agent: "dolphin", sessionID: "s1" } },
      },
    });
    await idle(plugin, "s1");

    assert.equal(sessionAgentRegistry.resolve("s1"), undefined);
    assert.equal(calls.length, 0);
  });

  it("cleans the process-level records of a session it never observed", async () => {
    const { plugin } = await buildTestPlugin();
    // Records written by an earlier plugin instance in this process.
    sessionAgentRegistry.bind("ghost", "dolphin");
    setModelLimit("ghost", 1000, "model");

    await deleted(plugin, "ghost");

    assert.equal(sessionAgentRegistry.resolve("ghost"), undefined);
    assert.equal(getModelLimit("ghost"), undefined);
  });
});

describe("session lifetime — plugin dispose", () => {
  it("is exposed as the host's dispose hook", async () => {
    const { plugin } = await buildTestPlugin();

    assert.equal(typeof plugin.dispose, "function");
    await plugin.dispose();
  });

  it("stops every session and leaves nothing to rebuild", async () => {
    const { plugin, calls } = await buildTestPlugin();
    await bindAgent(plugin, "s1");
    await bindAgent(plugin, "s2");

    await plugin.dispose();

    // A dispose stops the scopes but does not end the sessions: the agent
    // identity the host reported stays available for the next instance.
    assert.equal(sessionAgentRegistry.resolve("s1"), "dolphin");
    assert.equal(sessionAgentRegistry.resolve("s2"), "dolphin");
    await idle(plugin, "s1");
    await plugin.event({
      event: {
        type: "message.updated",
        properties: { info: { agent: "dolphin", sessionID: "s1" } },
      },
    });
    assert.equal(calls.length, 0, "a disposed session must not wake");
    assert.equal(sessionAgentRegistry.resolve("s1"), "dolphin");
  });

  it("keeps the persisted context of a disposed session", async () => {
    const { plugin } = await buildTestPlugin();
    await bindAgent(plugin, "s1");
    // The plugin's own instance captured the model limit; a dispose drops
    // that runtime record while the session itself lives on.
    setModelLimit("s1", 1000, "model");

    await plugin.dispose();

    assert.equal(getModelLimit("s1"), undefined);
    assert.equal(sessionAgentRegistry.resolve("s1"), "dolphin");
  });

  it("cleans up a resident plugin with no profile", async () => {
    const plugin = (await buildPlugin({ client: {} }, {})) as Record<
      string,
      any
    >;

    assert.equal(typeof plugin.dispose, "function");
    await plugin.dispose();
  });
});

describe("session lifetime — system transform", () => {
  it("captures the model limit of a live session", async () => {
    const { plugin } = await buildTestPlugin();

    await plugin["experimental.chat.system.transform"](
      {
        sessionID: "s1",
        model: { id: "model", limit: { context: 1000, output: 100 } },
      },
      { system: [] },
    );

    assert.deepEqual(getModelLimit("s1"), {
      context: 1000,
      modelId: "model",
    });
  });
});
