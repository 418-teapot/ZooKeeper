/**
 * Tests for the OpenCode `session.idle` loop settle wiring.
 *
 * Covers the settled-turn wake path end to end through `buildPlugin`'s
 * persistent `event` hook: the todo list is the sole wake authority — a
 * dolphin idle with unfinished active work wakes via `promptAsync` with
 * the core-rendered text whatever the settled turn did (read-only, no,
 * or delegating), and prose never suppresses the wake because a real
 * wait on the user is declared through the `blocked` status.  Structural
 * exemptions stay silent: aborted turns and turns ending at an
 * unanswered question tool.  A delivered wake locks the session: a
 * text-only reply to a wake stays silent without spending budget, any
 * tool activity releases the lock, and a real user message clears both
 * the lock and the budget.  Non-dolphin sessions, an exhausted budget,
 * and a profile without an `onSettled` contribution or without a valid
 * `[zoo.continuation].max_reminders` all stay silent.
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

/**
 * The host's injected wake, echoed back into the transcript as a user
 * message (the turn boundary of the reply being classified).
 */
const WAKE_ECHO = {
  info: { role: "user" },
  parts: [{ type: "text", text: CONTINUATION_PROMPT }],
};

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
 * The transcript is mutable through `setTranscript` so one test can
 * replay a sequence of settles (wake, then the turn the wake triggered).
 *
 * @param opts - Per-test overrides for todos and the transcript.
 * @returns The client, the recorded `promptAsync` calls, and a transcript
 *   setter.
 */
function makeClient(
  opts: {
    todos?: Array<Record<string, unknown>>;
    messages?: Array<Record<string, unknown>>;
  } = {},
): {
  client: Record<string, any>;
  calls: PromptCall[];
  setTranscript(messages: Array<Record<string, unknown>>): void;
} {
  const calls: PromptCall[] = [];
  let transcript = opts.messages ?? WORKED_TURN;
  const client = {
    session: {
      todo: async () => ({ data: opts.todos ?? ACTIVE_TODOS }),
      messages: async () => ({ data: transcript }),
      promptAsync: async (input: PromptCall) => {
        calls.push(input);
        return {};
      },
    },
  };
  return {
    client,
    calls,
    setTranscript: (messages) => {
      transcript = messages;
    },
  };
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
// Settled turns: the todo list is the sole wake authority
// ---------------------------------------------------------------------------

describe("session.idle — the list decides wakefulness", () => {
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
      const plugin = await buildPlugin({ client }, zooConfig());
      await bindAgent(plugin, "dolphin");

      await idle(plugin);

      assert.equal(calls.length, 1, `${tool} should count as activity`);
    }
  });

  it("wakes when the settled turn's only tool call is read-only", async () => {
    // The old no-progress false-negative hole: a read-only or planning
    // turn is still activity, and wakefulness is the list's call.
    for (const tool of ["read", "grep", "todo"]) {
      const { client, calls } = makeClient({
        messages: turnWith([
          { type: "tool", tool, state: { status: "completed" } },
          { type: "text", text: "Just looked around." },
        ]),
      });
      const plugin = await buildPlugin({ client }, zooConfig());
      await bindAgent(plugin, "dolphin");

      await idle(plugin);

      assert.equal(calls.length, 1, `${tool} + active list must wake`);
    }
  });

  it("wakes even when the settled turn made no tool call at all", async () => {
    // Without a prior wake there is no lock, so a pure-text settle with
    // unfinished active work still wakes: prose is never a stop signal.
    const { client, calls } = makeClient({
      messages: turnWith([{ type: "text", text: "Everything is done." }]),
    });
    const plugin = await buildPlugin({ client }, zooConfig());
    await bindAgent(plugin, "dolphin");

    await idle(plugin);

    assert.equal(calls.length, 1);
  });

  it("wakes for a task delegation whatever the delegated agent", async () => {
    // The executor/read-only distinction is gone: any tool call is
    // activity, the list decides wakefulness.
    for (const agent of ["beaver", "lynx"]) {
      const { client, calls } = makeClient({
        messages: turnWith([
          {
            type: "tool",
            tool: "task",
            state: { status: "completed", input: { subagent_type: agent } },
          },
          { type: "text", text: "Delegated." },
        ]),
      });
      const plugin = await buildPlugin({ client }, zooConfig());
      await bindAgent(plugin, "dolphin");

      await idle(plugin);

      assert.equal(calls.length, 1, `delegation to ${agent} must wake`);
    }
  });

  it("wakes even when the final text solicits the user's approval", async () => {
    // A genuine wait on the user is declared through a blocked task,
    // never guessed from the turn's prose.
    const { client, calls } = makeClient({
      messages: turnWith([
        { type: "tool", tool: "write", state: { status: "completed" } },
        { type: "text", text: "请确认是否继续。" },
      ]),
    });
    const plugin = await buildPlugin({ client }, zooConfig());
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
    const plugin = await buildPlugin({ client }, zooConfig());
    await bindAgent(plugin, "dolphin");

    await idle(plugin);

    assert.equal(calls.length, 0);
  });
});

// ---------------------------------------------------------------------------
// Blocked tasks: the declared wait on the user
// ---------------------------------------------------------------------------

describe("session.idle — blocked tasks", () => {
  it("stays silent when every remaining task is blocked", async () => {
    const { client, calls } = makeClient({
      todos: [
        {
          content: "Wire source",
          status: "completed",
          priority: "high",
          id: "1",
        },
        {
          content: "Await sign-off",
          status: "blocked",
          priority: "medium",
          id: "2",
        },
      ],
    });
    const plugin = await buildPlugin({ client }, zooConfig());
    await bindAgent(plugin, "dolphin");

    await idle(plugin);

    assert.equal(calls.length, 0, "a blocked list waits on the user");
  });

  it("wakes a mixed list and renders blocked lines without a suffix", async () => {
    // The OpenCode todo payload carries no blocker field, so the
    // waiting-on suffix is absent there by construction.
    const { client, calls } = makeClient({
      todos: [
        {
          content: "Update tests",
          status: "pending",
          priority: "high",
          id: "1",
        },
        {
          content: "Await sign-off",
          status: "blocked",
          priority: "medium",
          id: "2",
        },
      ],
    });
    const plugin = await buildPlugin({ client }, zooConfig());
    await bindAgent(plugin, "dolphin");

    await idle(plugin);

    assert.equal(calls.length, 1);
    const text = calls[0].body.parts[0].text;
    assert.ok(text.includes("- [blocked] Await sign-off"));
    assert.ok(
      !text.includes("(waiting on:"),
      "the client payload carries no blocker field, so no suffix",
    );
  });
});

// ---------------------------------------------------------------------------
// Awaiting-progress lock
// ---------------------------------------------------------------------------

describe("session.idle — awaiting-progress lock", () => {
  /** Consume the wake's user-message echo exactly as the host would. */
  async function feedWakeEcho(
    plugin: Record<string, any>,
    messageID: string | undefined,
  ): Promise<void> {
    await plugin.event({
      event: {
        type: "message.updated",
        properties: {
          info: {
            id: messageID,
            role: "user",
            sessionID: "s1",
            agent: "dolphin",
          },
        },
      },
    });
  }

  /** An assistant message carrying the given parts. */
  function assistantTurn(
    parts: Array<Record<string, unknown>>,
  ): Record<string, unknown> {
    return { info: { role: "assistant" }, parts };
  }

  it("stays silent on a text-only reply to a wake without spending budget", async () => {
    const { client, calls, setTranscript } = makeClient();
    const plugin = await buildPlugin({ client }, zooConfig(2));
    await bindAgent(plugin, "dolphin");

    await idle(plugin);
    assert.equal(calls.length, 1, "the working settle wakes");
    await feedWakeEcho(plugin, calls[0].body.messageID);

    // The woken turn merely answers in prose: silence, and the lock
    // holds.
    setTranscript([
      ...WORKED_TURN,
      WAKE_ECHO,
      assistantTurn([{ type: "text", text: "All work is complete." }]),
    ]);
    await idle(plugin);
    assert.equal(calls.length, 1, "a text-only reply to a wake stays silent");

    // A later active turn still wakes: the silenced reply left the
    // second allowance untouched.
    setTranscript([
      ...WORKED_TURN,
      WAKE_ECHO,
      assistantTurn([
        { type: "tool", tool: "edit", state: { status: "completed" } },
        { type: "text", text: "Verified and continued." },
      ]),
    ]);
    await idle(plugin);
    assert.equal(calls.length, 2, "the text-only silence spent no budget");
  });

  it("releases the lock when the reply makes a read-only tool call", async () => {
    const { client, calls, setTranscript } = makeClient();
    const plugin = await buildPlugin({ client }, zooConfig(2));
    await bindAgent(plugin, "dolphin");

    await idle(plugin);
    assert.equal(calls.length, 1);
    await feedWakeEcho(plugin, calls[0].body.messageID);

    // Any tool call releases the lock — reads and todo updates
    // included — and the list is re-judged normally.
    setTranscript([
      ...WORKED_TURN,
      WAKE_ECHO,
      assistantTurn([
        { type: "tool", tool: "read", state: { status: "completed" } },
        { type: "text", text: "Checked once more." },
      ]),
    ]);
    await idle(plugin);

    assert.equal(calls.length, 2, "read-only activity releases the lock");
    assert.ok(calls[1].body.parts[0].text.startsWith(CONTINUATION_PROMPT));
  });

  it("clears the lock along with the budget on a real user message", async () => {
    const { client, calls, setTranscript } = makeClient();
    const plugin = await buildPlugin({ client }, zooConfig(1));
    await bindAgent(plugin, "dolphin");

    await idle(plugin);
    assert.equal(calls.length, 1, "the working settle wakes");
    await feedWakeEcho(plugin, calls[0].body.messageID);

    setTranscript([
      ...WORKED_TURN,
      WAKE_ECHO,
      assistantTurn([{ type: "text", text: "All work is complete." }]),
    ]);
    await idle(plugin);
    assert.equal(calls.length, 1, "the lock silences the text-only reply");

    // A genuine user turn resets the budget AND clears the lock, so
    // even a text-only settle under the fresh budget wakes again.
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
    setTranscript([
      { info: { role: "user" }, parts: [{ type: "text", text: "keep going" }] },
      assistantTurn([{ type: "text", text: "Nothing left to add." }]),
    ]);
    await idle(plugin);

    assert.equal(calls.length, 2, "a real user turn clears the lock too");
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
