/**
 * Tests for the OpenCode `session.idle` loop settle wiring.
 *
 * Covers the settled-turn wake path end to end through `buildPlugin`'s
 * persistent `event` hook: a dolphin idle with unfinished todos wakes
 * exactly once via `promptAsync` with the core-rendered text, while
 * non-dolphin sessions, awaiting-input turns, aborted turns, an
 * exhausted budget, and a profile without an `onSettled` contribution or
 * without a valid `[zoo.continuation].max_reminders` all stay silent.  A
 * real user message resets the per-session budget, the host's own
 * injected wake echo never does.
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { sessionAgentRegistry } from "./core/session-agent.js";
import { CONTINUATION_PROMPT } from "./hooks/todo-continuation/decide.js";
import {
  buildPlugin,
  hasUnansweredQuestion,
  lastAssistantAborted,
} from "./opencode.js";
import { _resetForTesting } from "./utils/logger.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** An OpenCode todo payload with active work. */
const ACTIVE_TODOS = [
  { content: "Wire source", status: "in_progress", priority: "high", id: "1" },
  { content: "Update tests", status: "pending", priority: "medium", id: "2" },
];

/**
 * A settled turn that performed mutating work: a user boundary, then an
 * assistant message carrying a `write` tool call and an ordinary final
 * text (a status report, not a user-directed question).
 */
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

/** The profile that enables the todo-continuation settle judge. */
const CONTINUATION_PROFILE = {
  agents: ["dolphin"],
  skills: [],
  hooks: ["todo-continuation"],
  tools: [],
  commands: [],
};

/**
 * Build a `[zoo]` config with the loop profile enabled.
 *
 * @param maxReminders - The `[zoo.continuation].max_reminders` value.
 * @param hooks - The profile hooks list.
 * @returns The zoo config.
 */
function zooConfig(maxReminders = 3, hooks = ["todo-continuation"]) {
  return {
    mode: { poly: { ...CONTINUATION_PROFILE, hooks } },
    continuation: { max_reminders: maxReminders },
  };
}

/** A recorded `promptAsync` call. */
type PromptCall = {
  path: { id: string };
  body: {
    agent?: string;
    messageID?: string;
    parts: Array<{ type: string; text: string }>;
  };
};

/**
 * Build a stub OpenCode client exposing the APIs the loop path
 * reads (`session.todo`, `session.messages`, `session.promptAsync`).
 *
 * @param opts - Per-test overrides for todos and the transcript.
 * @returns The client and the recorded `promptAsync` calls.
 */
function makeClient(
  opts: {
    todos?: Array<Record<string, unknown>>;
    messages?: Array<Record<string, unknown>>;
  } = {},
): { client: Record<string, any>; calls: PromptCall[] } {
  const calls: PromptCall[] = [];
  const client = {
    session: {
      todo: async () => ({ data: opts.todos ?? ACTIVE_TODOS }),
      messages: async () => ({ data: opts.messages ?? WORKED_TURN }),
      promptAsync: async (input: PromptCall) => {
        calls.push(input);
        return {};
      },
    },
  };
  return { client, calls };
}

/**
 * Bind a session to an agent through the infrastructure event hook.
 *
 * @param plugin - The plugin built by `buildPlugin`.
 * @param agent - The agent to bind.
 * @param sessionID - The session to bind.
 */
async function bindAgent(
  plugin: Record<string, any>,
  agent: string,
  sessionID = "s1",
): Promise<void> {
  await plugin.event({
    event: {
      type: "message.updated",
      properties: { info: { agent, sessionID } },
    },
  });
}

/**
 * Send a `session.idle` event for a session.
 *
 * @param plugin - The plugin built by `buildPlugin`.
 * @param sessionID - The settled session.
 */
async function idle(
  plugin: Record<string, any>,
  sessionID = "s1",
): Promise<void> {
  await plugin.event({
    event: { type: "session.idle", properties: { sessionID } },
  });
}

afterEach(() => {
  _resetForTesting();
  sessionAgentRegistry.clear();
});

// ---------------------------------------------------------------------------
// Wake path
// ---------------------------------------------------------------------------

describe("session.idle — dolphin wake path", () => {
  it("wakes once with the core reminder text", async () => {
    const { client, calls } = makeClient();
    const plugin = await buildPlugin({ client }, zooConfig());
    await bindAgent(plugin, "dolphin");

    await idle(plugin);

    assert.equal(calls.length, 1, "exactly one promptAsync");
    assert.equal(calls[0].path.id, "s1");
    assert.equal(calls[0].body.agent, "dolphin");
    assert.equal(calls[0].body.parts.length, 1);
    const text = calls[0].body.parts[0].text;
    assert.ok(text.startsWith(CONTINUATION_PROMPT));
    assert.ok(text.includes("Wire source"));
  });

  it("does not inject for a non-dolphin session", async () => {
    const { client, calls } = makeClient();
    const plugin = await buildPlugin({ client }, zooConfig());
    await bindAgent(plugin, "beaver");

    await idle(plugin);

    assert.equal(calls.length, 0);
  });

  it("does not inject when no onSettled contribution is enabled", async () => {
    const { client, calls } = makeClient();
    const plugin = await buildPlugin({ client }, zooConfig(3, []));
    await bindAgent(plugin, "dolphin");

    await idle(plugin);

    assert.equal(calls.length, 0);
  });

  it("stays inert without a valid max_reminders", async () => {
    for (const continuation of [
      undefined,
      {},
      { max_reminders: 0 },
      { max_reminders: "3" },
    ]) {
      const { client, calls } = makeClient();
      const plugin = await buildPlugin(
        { client },
        {
          mode: { poly: CONTINUATION_PROFILE },
          ...(continuation === undefined ? {} : { continuation }),
        },
      );
      await bindAgent(plugin, "dolphin");

      await idle(plugin);

      assert.equal(
        calls.length,
        0,
        `continuation ${JSON.stringify(continuation)} must be inert`,
      );
    }
  });

  it("does not inject when the todo list has no active work", async () => {
    const { client, calls } = makeClient({
      todos: [
        {
          content: "Ship it",
          status: "completed",
          priority: "low",
          id: "1",
        },
      ],
    });
    const plugin = await buildPlugin({ client }, zooConfig());
    await bindAgent(plugin, "dolphin");

    await idle(plugin);

    assert.equal(calls.length, 0);
  });
});

// ---------------------------------------------------------------------------
// Stop-cause classification
// ---------------------------------------------------------------------------

describe("session.idle — awaiting-input classification", () => {
  it("stays silent when the transcript ends at an unanswered question", async () => {
    const { client, calls } = makeClient({
      messages: [
        {
          info: { role: "assistant" },
          parts: [
            {
              type: "tool",
              tool: "question",
              state: { status: "pending" },
            },
          ],
        },
      ],
    });
    const plugin = await buildPlugin({ client }, zooConfig());
    await bindAgent(plugin, "dolphin");

    await idle(plugin);

    assert.equal(calls.length, 0);
  });

  it("does not treat a completed question as awaiting input", async () => {
    const { client, calls } = makeClient({
      messages: [
        {
          info: { role: "assistant" },
          parts: [
            {
              type: "tool",
              tool: "question",
              state: { status: "completed" },
            },
            { type: "tool", tool: "write", state: { status: "completed" } },
            { type: "text", text: "All set." },
          ],
        },
      ],
    });
    const plugin = await buildPlugin({ client }, zooConfig());
    await bindAgent(plugin, "dolphin");

    await idle(plugin);

    assert.equal(calls.length, 1);
  });
});

// ---------------------------------------------------------------------------
// Work-progress classification
// ---------------------------------------------------------------------------

describe("session.idle — work-progress classification", () => {
  /** Agent permission tables mirroring config.toml: lynx is read-only. */
  const PERMISSIONS = {
    agent: {
      beaver: { mode: "subagent", permission: {} },
      lynx: { mode: "subagent", permission: { edit: "deny" } },
    },
  };

  /**
   * Build a transcript with a user boundary and one assistant message
   * carrying the given parts.
   *
   * @param parts - The assistant message parts.
   * @returns The transcript.
   */
  function turnWith(
    parts: Array<Record<string, unknown>>,
  ): Array<Record<string, unknown>> {
    return [
      { info: { role: "user" }, parts: [{ type: "text", text: "go" }] },
      { info: { role: "assistant" }, parts },
    ];
  }

  it("wakes when the settled turn made a bash/edit/write call", async () => {
    for (const tool of ["bash", "edit", "write"]) {
      const { client, calls } = makeClient({
        messages: turnWith([
          { type: "tool", tool, state: { status: "completed" } },
          { type: "text", text: "Step done." },
        ]),
      });
      const plugin = await buildPlugin({ client }, zooConfig(), PERMISSIONS);
      await bindAgent(plugin, "dolphin");

      await idle(plugin);

      assert.equal(calls.length, 1, `${tool} should count as progress`);
    }
  });

  it("stays silent when the settled turn only updated the todo list", async () => {
    const { client, calls } = makeClient({
      messages: turnWith([
        { type: "tool", tool: "todo", state: { status: "completed" } },
        { type: "text", text: "Updated the list." },
      ]),
    });
    const plugin = await buildPlugin({ client }, zooConfig(), PERMISSIONS);
    await bindAgent(plugin, "dolphin");

    await idle(plugin);

    assert.equal(calls.length, 0);
  });

  it("wakes for a task delegation to an executor subagent", async () => {
    const { client, calls } = makeClient({
      messages: turnWith([
        {
          type: "tool",
          tool: "task",
          state: { status: "completed", input: { subagent_type: "beaver" } },
        },
        { type: "text", text: "Delegated the work." },
      ]),
    });
    const plugin = await buildPlugin({ client }, zooConfig(), PERMISSIONS);
    await bindAgent(plugin, "dolphin");

    await idle(plugin);

    assert.equal(calls.length, 1);
  });

  it("stays silent for a task delegation to a read-only subagent", async () => {
    const { client, calls } = makeClient({
      messages: turnWith([
        {
          type: "tool",
          tool: "task",
          state: { status: "completed", input: { subagent_type: "lynx" } },
        },
        { type: "text", text: "Delegated a search." },
      ]),
    });
    const plugin = await buildPlugin({ client }, zooConfig(), PERMISSIONS);
    await bindAgent(plugin, "dolphin");

    await idle(plugin);

    assert.equal(calls.length, 0);
  });

  it("stays silent when the final text solicits the user's approval", async () => {
    const { client, calls } = makeClient({
      messages: turnWith([
        { type: "tool", tool: "write", state: { status: "completed" } },
        { type: "text", text: "请确认是否继续。" },
      ]),
    });
    const plugin = await buildPlugin({ client }, zooConfig(), PERMISSIONS);
    await bindAgent(plugin, "dolphin");

    await idle(plugin);

    assert.equal(calls.length, 0);
  });

  it("wakes when the final text is an ordinary status report", async () => {
    const { client, calls } = makeClient({
      messages: turnWith([
        { type: "tool", tool: "write", state: { status: "completed" } },
        { type: "text", text: "Implemented the change." },
      ]),
    });
    const plugin = await buildPlugin({ client }, zooConfig(), PERMISSIONS);
    await bindAgent(plugin, "dolphin");

    await idle(plugin);

    assert.equal(calls.length, 1);
  });

  it("fails closed when the transcript cannot be read", async () => {
    const calls: PromptCall[] = [];
    const client = {
      session: {
        todo: async () => ({ data: ACTIVE_TODOS }),
        messages: async () => {
          throw new Error("boom");
        },
        promptAsync: async (input: PromptCall) => {
          calls.push(input);
          return {};
        },
      },
    };
    const plugin = await buildPlugin({ client }, zooConfig(), PERMISSIONS);
    await bindAgent(plugin, "dolphin");

    await idle(plugin);

    assert.equal(calls.length, 0);
  });
});

describe("session.idle — aborted classification", () => {
  it("stays silent after a session.error abort event", async () => {
    const { client, calls } = makeClient();
    const plugin = await buildPlugin({ client }, zooConfig());
    await bindAgent(plugin, "dolphin");

    await plugin.event({
      event: {
        type: "session.error",
        properties: {
          sessionID: "s1",
          error: { name: "MessageAbortedError" },
        },
      },
    });
    await idle(plugin);

    assert.equal(calls.length, 0);
  });

  it("stays silent when the last assistant message reports an abort", async () => {
    const { client, calls } = makeClient({
      messages: [
        {
          info: { role: "assistant", error: { name: "AbortError" } },
          parts: [],
        },
      ],
    });
    const plugin = await buildPlugin({ client }, zooConfig());
    await bindAgent(plugin, "dolphin");

    await idle(plugin);

    assert.equal(calls.length, 0);
  });

  it("fails closed when the transcript cannot be read", async () => {
    const { calls } = makeClient();
    const client = {
      session: {
        todo: async () => ({ data: ACTIVE_TODOS }),
        messages: async () => {
          throw new Error("boom");
        },
        promptAsync: async (input: PromptCall) => {
          calls.push(input);
          return {};
        },
      },
    };
    const plugin = await buildPlugin({ client }, zooConfig());
    await bindAgent(plugin, "dolphin");

    await idle(plugin);

    assert.equal(calls.length, 0);
  });
});

// ---------------------------------------------------------------------------
// Budget
// ---------------------------------------------------------------------------

describe("session.idle — reminder budget", () => {
  it("stops injecting once the budget is spent", async () => {
    const { client, calls } = makeClient();
    const plugin = await buildPlugin({ client }, zooConfig(1));
    await bindAgent(plugin, "dolphin");

    await idle(plugin);
    await idle(plugin);

    assert.equal(calls.length, 1);
  });

  it("resets the budget only on a real user message, never on the echo", async () => {
    const { client, calls } = makeClient();
    const plugin = await buildPlugin({ client }, zooConfig(1));
    await bindAgent(plugin, "dolphin");

    // First wake consumes the single reminder and records the injected
    // message id used to recognize its echo.
    await idle(plugin);
    assert.equal(calls.length, 1);
    const echoID = calls[0].body.messageID;
    assert.ok(echoID, "the injected message carries an id");

    // The wake echo is a user message too — it must not reset.
    await plugin.event({
      event: {
        type: "message.updated",
        properties: {
          info: { id: echoID, role: "user", sessionID: "s1", agent: "dolphin" },
        },
      },
    });
    await idle(plugin);
    assert.equal(calls.length, 1, "echo must not reset the budget");

    // A genuine user message resets the budget.
    await plugin.event({
      event: {
        type: "message.updated",
        properties: {
          info: {
            id: "msg_user_real",
            role: "user",
            sessionID: "s1",
            agent: "dolphin",
          },
        },
      },
    });
    await idle(plugin);

    assert.equal(calls.length, 2, "real user message resets the budget");
  });

  it("resets the budget on a real user message during the echo window", async () => {
    const { client, calls } = makeClient();
    const plugin = await buildPlugin({ client }, zooConfig(1));
    await bindAgent(plugin, "dolphin");

    // First wake consumes the single reminder; the echoed
    // `message.updated` has not arrived yet.
    await idle(plugin);
    assert.equal(calls.length, 1);

    // A genuine user message arrives before the echo.  Its id does not
    // match the recorded injection, so it must reset the budget instead
    // of being swallowed as the echo.
    await plugin.event({
      event: {
        type: "message.updated",
        properties: {
          info: {
            id: "msg_user_real",
            role: "user",
            sessionID: "s1",
            agent: "dolphin",
          },
        },
      },
    });
    await idle(plugin);

    assert.equal(
      calls.length,
      2,
      "a real user message in the echo window resets the budget",
    );
  });
});

// ---------------------------------------------------------------------------
// Classification helpers
// ---------------------------------------------------------------------------

describe("hasUnansweredQuestion", () => {
  it("detects a pending question in the last assistant turn", () => {
    assert.equal(
      hasUnansweredQuestion([
        {
          info: { role: "assistant" },
          parts: [{ type: "tool", name: "ask_user_question", state: {} }],
        },
      ]),
      true,
    );
  });

  it("returns false once a real user message follows", () => {
    assert.equal(
      hasUnansweredQuestion([
        {
          info: { role: "assistant" },
          parts: [{ type: "tool", tool: "question", state: {} }],
        },
        { info: { role: "user" } },
      ]),
      false,
    );
  });

  it("skips synthetic user messages when scanning backward", () => {
    assert.equal(
      hasUnansweredQuestion([
        { info: { role: "assistant" } },
        { info: { role: "user", synthetic: true } },
        {
          info: { role: "assistant" },
          parts: [{ type: "tool", tool: "question", state: {} }],
        },
      ]),
      true,
    );
  });
});

describe("lastAssistantAborted", () => {
  it("reports the last assistant message error name", () => {
    assert.equal(
      lastAssistantAborted([
        { info: { role: "assistant", error: { name: "MessageAbortedError" } } },
      ]),
      true,
    );
    assert.equal(
      lastAssistantAborted([
        { info: { role: "assistant", error: { name: "ApiError" } } },
      ]),
      false,
    );
    assert.equal(lastAssistantAborted([]), false);
  });
});
