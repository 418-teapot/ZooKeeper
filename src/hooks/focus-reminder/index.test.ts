/**
 * Tests for the Focus Reminder hook.
 *
 * Covers: injection into last user message for build agent, skipping for
 * non-build agents, empty messages, missing user messages, stateless
 * multiple-turn behavior, non-user message preservation, barrel exports,
 * and integration via `experimental.chat.messages.transform` plugin hook.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { zookeeper } from "../../index.js";
import { FOCUS_REMINDER, injectFocusReminder } from "./index.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface TextPart {
  type: "text";
  text: string;
}

interface MessageInfo {
  role: string;
  id: string;
  sessionID?: string;
  agent?: string;
}

interface MessageEntry {
  info: MessageInfo;
  parts: TextPart[];
}

interface Output {
  messages?: MessageEntry[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal message entry with the given role, agent, and optional text.
 */
function msg(
  role: string,
  agent?: string,
  text = "hello",
  overrides?: Partial<MessageInfo>,
): MessageEntry {
  return {
    info: { role, id: "m1", agent, ...overrides },
    parts: [{ type: "text", text }],
  };
}

/**
 * Build a mock OpenCode client.
 *
 * @param agent - Agent name returned by `getSession`, or undefined to omit.
 * @returns A mock client object.
 */
function mockClient(agent?: string): {
  getSession: (id: string) => Promise<{ agent?: string }>;
} {
  return {
    getSession: async () => ({ agent }),
  };
}

/**
 * Helper: invoke `injectFocusReminder` with given messages and optional
 * client, returning the mutated `output` object.
 */
async function applyReminder(
  messages: MessageEntry[],
  client?: { getSession: (id: string) => Promise<{ agent?: string }> },
): Promise<Output> {
  const output: Output = { messages };
  await injectFocusReminder(client ?? mockClient("build"), output);
  return output;
}

/**
 * Assert that the last user message in `output` contains the focus reminder.
 */
function assertHasReminder(output: Output, message?: string): void {
  if (!output.messages) {
    throw new Error(message ?? "expected messages to exist");
  }
  const msgs = output.messages;
  const lastUser = msgs.findLast((m) => m.info.role === "user");
  if (!lastUser) {
    throw new Error(message ?? "expected a user message to exist");
  }
  const hasReminder = lastUser.parts.some(
    (p) => p.type === "text" && p.text === FOCUS_REMINDER,
  );
  assert.ok(hasReminder, message ?? "expected focus reminder in parts");
}

/**
 * Assert that NO user message in `output` contains the focus reminder.
 */
function assertNoReminder(output: Output, message?: string): void {
  const msgs = output.messages;
  if (!msgs) return;
  const userMsgs = msgs.filter((m) => m.info.role === "user");
  for (const m of userMsgs) {
    const hasReminder = m.parts.some(
      (p) => p.type === "text" && p.text === FOCUS_REMINDER,
    );
    assert.equal(hasReminder, false, message ?? "expected no focus reminder");
  }
}

// ---------------------------------------------------------------------------
// Positive: build agent gets the reminder
// ---------------------------------------------------------------------------

describe("build agent gets the reminder", () => {
  it("injects reminder into last user message when agent is 'build'", async () => {
    const msgs: MessageEntry[] = [
      msg("system"),
      msg("user", "build", "Implement feature X"),
      msg("assistant"),
    ];
    const result = await applyReminder(msgs);
    assertHasReminder(result);
  });

  it("injects into the LAST user message when multiple user messages exist", async () => {
    const msgs: MessageEntry[] = [
      msg("user", "build", "First question"),
      msg("assistant"),
      msg("user", "build", "Follow-up instruction"),
    ];
    const result = await applyReminder(msgs);

    // The first user message should not have the reminder
    const firstUser = msgs[0];
    const firstHasReminder = firstUser.parts.some(
      (p) => p.type === "text" && p.text === FOCUS_REMINDER,
    );
    assert.equal(firstHasReminder, false);

    // The last user message should have the reminder
    assertHasReminder(result);
  });
});

// ---------------------------------------------------------------------------
// Negative: non-build agents are skipped
// ---------------------------------------------------------------------------

describe("non-build agents are skipped", () => {
  const skipAgents = ["general", "explore", "scout", "spider", "review", ""];

  for (const agent of skipAgents) {
    it(`skips agent "${agent || "(empty string)"}"`, async () => {
      const msgs: MessageEntry[] = [msg("user", agent, "Do something")];
      const result = await applyReminder(msgs);
      assertNoReminder(result);
    });
  }

  it("skips when agent is 'build' via info.agent but matched as different string", async () => {
    // Testing that exact match is required — "BUILD" should not match "build"
    const msgs: MessageEntry[] = [msg("user", "BUILD", "Do something")];
    const result = await applyReminder(msgs);
    assertNoReminder(result);
  });
});

// ---------------------------------------------------------------------------
// Agent resolved via client.getSession fallback
// ---------------------------------------------------------------------------

describe("agent resolved via client.getSession", () => {
  it("uses info.agent when present, ignoring getSession", async () => {
    const msgs: MessageEntry[] = [
      msg("user", "build", "Do work", { sessionID: "s1" }),
    ];
    // Client would return "general", but info.agent takes precedence
    const client = mockClient("general");
    const result = await applyReminder(msgs, client);
    assertHasReminder(result);
  });

  it("falls back to client.getSession when info.agent is absent", async () => {
    const msgs: MessageEntry[] = [
      msg("user", undefined, "Do work", { sessionID: "s1" }),
    ];
    const client = mockClient("build");
    const result = await applyReminder(msgs, client);
    assertHasReminder(result);
  });

  it("uses info.id as session fallback when sessionID is absent", async () => {
    const msgs: MessageEntry[] = [
      {
        info: { role: "user", id: "custom-session-id" },
        parts: [{ type: "text", text: "hi" }],
      },
    ];
    let capturedId = "";
    const client = {
      getSession: async (id: string) => {
        capturedId = id;
        return { agent: "build" };
      },
    };
    const result = await applyReminder(msgs, client);
    assert.equal(capturedId, "custom-session-id");
    assertHasReminder(result);
  });

  it("skips when getSession returns no agent", async () => {
    const msgs: MessageEntry[] = [
      msg("user", undefined, "Do work", { sessionID: "s1" }),
    ];
    const client = mockClient(undefined); // getSession returns { agent: undefined }
    const result = await applyReminder(msgs, client);
    assertNoReminder(result);
  });

  it("skips when getSession rejects (API failure)", async () => {
    const msgs: MessageEntry[] = [
      msg("user", undefined, "Do work", { sessionID: "s1" }),
    ];
    const client = {
      getSession: async () => {
        throw new Error("API failure");
      },
    };
    const result = await applyReminder(msgs, client);
    assertNoReminder(result);
  });
});

// ---------------------------------------------------------------------------
// Edge cases: missing messages
// ---------------------------------------------------------------------------

describe("missing messages", () => {
  it("skips when messages array is empty", async () => {
    const result = await applyReminder([]);
    assert.equal(result.messages?.length, 0);
  });

  it("skips when messages is undefined", async () => {
    const output: Output = {};
    await injectFocusReminder(mockClient("build"), output);
    assert.equal(output.messages, undefined);
  });

  it("skips when there are no user messages", async () => {
    const msgs: MessageEntry[] = [msg("system"), msg("assistant")];
    const result = await applyReminder(msgs);
    assertNoReminder(result);
  });

  it("skips when client is null and no info.agent available", async () => {
    const msgs: MessageEntry[] = [
      msg("user", undefined, "Do something", { sessionID: "s1" }),
    ];
    const output: Output = { messages: msgs };
    // info.agent is absent, client is null — cannot resolve agent → skip
    await injectFocusReminder(null, output);
    assertNoReminder(output);
  });

  it("skips when client is undefined and no info.agent available", async () => {
    const msgs: MessageEntry[] = [
      msg("user", undefined, "Do something", { sessionID: "s1" }),
    ];
    const output: Output = { messages: msgs };
    // info.agent is absent, client is undefined — cannot resolve agent → skip
    await injectFocusReminder(undefined, output);
    assertNoReminder(output);
  });

  it("skips when client has no getSession method", async () => {
    const msgs: MessageEntry[] = [
      msg("user", undefined, "Do something", { sessionID: "s1" }),
    ];
    const output: Output = { messages: msgs };
    // info.agent is absent AND client lacks getSession — cannot resolve agent
    await injectFocusReminder({} as any, output);
    assertNoReminder(output);
  });
});

// ---------------------------------------------------------------------------
// Does not modify assistant/system messages
// ---------------------------------------------------------------------------

describe("does not modify assistant/system messages", () => {
  it("only adds to last user message — assistant/system unchanged", async () => {
    const msgs: MessageEntry[] = [
      msg("system", undefined, "System prompt"),
      msg("user", "build", "Build this"),
      {
        info: { role: "assistant", id: "a1" },
        parts: [{ type: "text", text: "OK" }],
      },
    ];
    await applyReminder(msgs);

    // System message unchanged
    assert.equal(msgs[0].parts.length, 1);
    assert.equal(msgs[0].parts[0].text, "System prompt");

    // Assistant message unchanged
    assert.equal(msgs[2].parts.length, 1);
    assert.equal(msgs[2].parts[0].text, "OK");
  });
});

// ---------------------------------------------------------------------------
// Stateless — always injects (no dedup across turns)
// ---------------------------------------------------------------------------

describe("stateless — always injects", () => {
  it("injects every time for fresh message arrays", async () => {
    // Turn 1
    const msgs1: MessageEntry[] = [msg("user", "build", "Turn 1 request")];
    const out1 = await applyReminder(msgs1);
    assertHasReminder(out1);

    // Turn 2 — independent messages, should also get the reminder
    const msgs2: MessageEntry[] = [msg("user", "build", "Turn 2 request")];
    const out2 = await applyReminder(msgs2);
    assertHasReminder(out2);
  });
});

// ---------------------------------------------------------------------------
// Constants match expected values
// ---------------------------------------------------------------------------

describe("FOCUS_REMINDER contents", () => {
  it('starts with "!IMPORTANT!"', () => {
    assert.ok(FOCUS_REMINDER.startsWith("!IMPORTANT!"));
  });

  it('contains "orchestrate, don\'t implement"', () => {
    assert.ok(FOCUS_REMINDER.includes("orchestrate, don't implement"));
  });

  it('contains "Understand the request"', () => {
    assert.ok(FOCUS_REMINDER.includes("Understand the request"));
  });

  it('contains "delegate via task()"', () => {
    assert.ok(FOCUS_REMINDER.includes("delegate via task()"));
  });

  it('contains "verify the result"', () => {
    assert.ok(FOCUS_REMINDER.includes("verify the result"));
  });
});

// ---------------------------------------------------------------------------
// Barrel export
// ---------------------------------------------------------------------------

describe("barrel export", () => {
  it("exports injectFocusReminder as a function", () => {
    assert.equal(typeof injectFocusReminder, "function");
  });

  it("exports FOCUS_REMINDER as a string", () => {
    assert.equal(typeof FOCUS_REMINDER, "string");
  });
});

// ---------------------------------------------------------------------------
// Integration via plugin entry point
// ---------------------------------------------------------------------------

describe("integration via plugin (experimental.chat.messages.transform)", () => {
  it("injects reminder for build agent via plugin", async () => {
    const plugin = await zookeeper({ client: null });
    const output: Output = {
      messages: [msg("user", "build", "Build this feature")],
    };
    await plugin["experimental.chat.messages.transform"]({}, output);
    assertHasReminder(output);
  });

  it("skips for non-build agent via plugin", async () => {
    const plugin = await zookeeper({ client: null });
    const output: Output = {
      messages: [msg("user", "general", "Explore something")],
    };
    await plugin["experimental.chat.messages.transform"]({}, output);
    assertNoReminder(output);
  });

  it("skips when no user messages via plugin", async () => {
    const plugin = await zookeeper({ client: null });
    const output: Output = {
      messages: [msg("system"), msg("assistant")],
    };
    await plugin["experimental.chat.messages.transform"]({}, output);
    assertNoReminder(output);
  });

  it("handles empty messages gracefully via plugin", async () => {
    const plugin = await zookeeper({ client: null });
    const output: Output = { messages: [] };
    await plugin["experimental.chat.messages.transform"]({}, output);
    assert.equal(output.messages?.length, 0);
  });

  it("handles missing messages gracefully via plugin", async () => {
    const plugin = await zookeeper({ client: null });
    const output: Output = {};
    // Should not throw
    await plugin["experimental.chat.messages.transform"]({}, output);
    assert.equal(output.messages, undefined);
  });
});
