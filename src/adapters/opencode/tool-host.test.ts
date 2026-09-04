/**
 * Tests for the OpenCode v1 tool host adapter (`tool-host.ts`).
 *
 * Covers the three host services against a fake `SessionClient`:
 * session-id resolution order (`sessionID` over `sessionId`, undefined
 * fallback), the history fetch unwrap shapes (`{ data: [...] }` wrapper
 * and a bare array) with every rejection branch, the best-effort
 * notification payload with agent resolution (resolver hit, `session.get`
 * fallback, unresolved-agent suppression), and the `resolveSessionAgent`
 * resolution order in isolation.
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { SessionClient } from "../../core/client/session.js";
import type { HostMessage } from "../../core/context/lens.js";
import { _getBufferForTesting, _resetForTesting } from "../../utils/logger.js";
import { createV1ToolHost, resolveSessionAgent } from "./tool-host.js";
import type { ContextMessageEntry } from "./types.js";

// ---------------------------------------------------------------------------
// Logger cleanup
// ---------------------------------------------------------------------------

afterEach(() => {
  _resetForTesting();
});

// ---------------------------------------------------------------------------
// Fake client helpers
// ---------------------------------------------------------------------------

/**
 * Build a session → agent resolver backed by a plain map.
 *
 * The resolver is the production wiring shape (`Deps.resolveAgent`
 * reads the session-agent registry); tests keep their own map so the
 * "resolver must not write back" contract stays observable.
 */
function mapResolver(map: Map<string, string>) {
  return (sessionID: string): string | undefined => map.get(sessionID);
}

/** A resolver that never identifies anything (unbound sessions). */
const NO_AGENT = () => undefined;

/**
 * The prompt payload shape recorded by the fake client.
 */
type PromptInput = {
  path: { id: string };
  body: {
    noReply?: boolean;
    parts: Array<{ type: "text"; text: string; ignored?: boolean }>;
    agent?: string;
  };
};

/**
 * Build a fake session client with optional messages/prompt/get behaviors.
 *
 * Absent options leave the corresponding session API undefined so the
 * "API unavailable", "prompt missing", and "no session.get" paths are
 * exercised.
 */
function fakeClient(options: {
  messages?: () => unknown;
  prompt?: (input: PromptInput) => Promise<unknown>;
  get?: (input: {
    path: { id: string };
  }) => Promise<{ agent?: string } | undefined>;
}): SessionClient {
  const session: Record<string, unknown> = {};
  if (options.messages !== undefined) {
    session.messages = async () => options.messages?.();
  }
  if (options.prompt !== undefined) {
    session.prompt = options.prompt;
  }
  if (options.get !== undefined) {
    session.get = options.get;
  }
  return { session } as unknown as SessionClient;
}

/**
 * Build a minimal v1 message entry.
 */
function v1Message(role: string, text: string): ContextMessageEntry {
  return {
    info: { role, id: "m1" } as ContextMessageEntry["info"],
    parts: [{ type: "text", text }] as ContextMessageEntry["parts"],
  };
}

// ---------------------------------------------------------------------------
// resolveSessionId
// ---------------------------------------------------------------------------

describe("resolveSessionId", () => {
  it("prefers sessionID over sessionId", () => {
    const host = createV1ToolHost(fakeClient({}), NO_AGENT);
    assert.equal(
      host.resolveSessionId({ sessionID: "s1", sessionId: "s2" }),
      "s1",
    );
  });

  it("falls back to sessionId when sessionID is absent", () => {
    const host = createV1ToolHost(fakeClient({}), NO_AGENT);
    assert.equal(host.resolveSessionId({ sessionId: "s2" }), "s2");
  });

  it("returns undefined when no session id is present", () => {
    const host = createV1ToolHost(fakeClient({}), NO_AGENT);
    assert.equal(host.resolveSessionId({}), undefined);
  });

  it("returns undefined for non-string or empty session ids", () => {
    const host = createV1ToolHost(fakeClient({}), NO_AGENT);
    assert.equal(host.resolveSessionId({ sessionID: 42 }), undefined);
    assert.equal(host.resolveSessionId({ sessionID: "" }), undefined);
    assert.equal(host.resolveSessionId({ sessionId: "" }), undefined);
  });
});

// ---------------------------------------------------------------------------
// fetchHistory
// ---------------------------------------------------------------------------

describe("fetchHistory", () => {
  it("unwraps the { data: [...] } wrapper and projects to lens messages", async () => {
    const host = createV1ToolHost(
      fakeClient({ messages: () => ({ data: [v1Message("user", "Hello")] }) }),
      NO_AGENT,
    );
    const msgs: HostMessage[] = await host.fetchHistory("sess-1");
    assert.equal(msgs.length, 1);
    assert.equal(msgs[0].role, "user");
    assert.equal(msgs[0].hidden, false);
    assert.equal(msgs[0].regions[0].get(), "Hello");
  });

  it("accepts a bare array response", async () => {
    const host = createV1ToolHost(
      fakeClient({ messages: () => [v1Message("assistant", "Hi")] }),
      NO_AGENT,
    );
    const msgs: HostMessage[] = await host.fetchHistory("sess-1");
    assert.equal(msgs.length, 1);
    assert.equal(msgs[0].role, "assistant");
  });

  it("maps an empty data array to an empty transcript", async () => {
    const host = createV1ToolHost(
      fakeClient({ messages: () => ({ data: [] }) }),
      NO_AGENT,
    );
    const msgs: HostMessage[] = await host.fetchHistory("sess-1");
    assert.deepEqual(msgs, []);
  });

  it("rejects on res.error with its message", async () => {
    const host = createV1ToolHost(
      fakeClient({ messages: () => ({ error: { message: "boom" } }) }),
      NO_AGENT,
    );
    await assert.rejects(host.fetchHistory("sess-1"), /获取会话消息失败：boom/);
  });

  it("rejects on res.error without a message field", async () => {
    const host = createV1ToolHost(
      fakeClient({ messages: () => ({ error: "raw error" }) }),
      NO_AGENT,
    );
    await assert.rejects(
      host.fetchHistory("sess-1"),
      /获取会话消息失败：raw error/,
    );
  });

  it("rejects with the API error when the messages call rejects", async () => {
    const host = createV1ToolHost(
      fakeClient({
        messages: () => {
          throw new Error("network down");
        },
      }),
      NO_AGENT,
    );
    await assert.rejects(
      host.fetchHistory("sess-1"),
      /无法获取会话消息：network down/,
    );
    const entries = _getBufferForTesting().filter(
      (entry) => entry.event === "fetch_messages_failed",
    );
    assert.ok(entries.length > 0, "expected a fetch_messages_failed entry");
    assert.equal(entries[0]?.level, "error");
  });

  it("rejects when the messages API is unavailable", async () => {
    const host = createV1ToolHost(fakeClient({}), NO_AGENT);
    await assert.rejects(
      host.fetchHistory("sess-1"),
      /无法获取会话消息：会话消息 API 不可用/,
    );
  });

  it("rejects on an empty response", async () => {
    const host = createV1ToolHost(
      fakeClient({ messages: () => null }),
      NO_AGENT,
    );
    await assert.rejects(
      host.fetchHistory("sess-1"),
      /会话消息 API 返回空结果/,
    );
  });

  it("rejects on a non-array payload", async () => {
    const host = createV1ToolHost(
      fakeClient({ messages: () => ({ data: "nope" }) }),
      NO_AGENT,
    );
    await assert.rejects(
      host.fetchHistory("sess-1"),
      /会话消息格式异常：期望数组/,
    );
    const bareObjectHost = createV1ToolHost(
      fakeClient({ messages: () => ({}) }),
      NO_AGENT,
    );
    await assert.rejects(
      bareObjectHost.fetchHistory("sess-1"),
      /会话消息格式异常：期望数组/,
    );
  });
});

// ---------------------------------------------------------------------------
// notify
// ---------------------------------------------------------------------------

describe("notify", () => {
  it("posts an ignored prompt carrying the agent from the map", async () => {
    const promptCalls: PromptInput[] = [];
    const host = createV1ToolHost(
      fakeClient({
        prompt: async (input) => {
          promptCalls.push(input);
        },
      }),
      mapResolver(new Map([["sess-1", "beaver"]])),
    );
    await host.notify("sess-1", "上下文压缩：完成");
    assert.equal(promptCalls.length, 1);
    assert.equal(promptCalls[0].path.id, "sess-1");
    assert.equal(promptCalls[0].body.noReply, true);
    assert.equal(promptCalls[0].body.agent, "beaver");
    assert.deepEqual(promptCalls[0].body.parts, [
      { type: "text", text: "上下文压缩：完成", ignored: true },
    ]);
  });

  it("resolves the agent via session.get when the map has no entry", async () => {
    const promptCalls: PromptInput[] = [];
    const host = createV1ToolHost(
      fakeClient({
        get: async () => ({ agent: "lynx" }),
        prompt: async (input) => {
          promptCalls.push(input);
        },
      }),
      NO_AGENT,
    );
    await host.notify("sess-1", "上下文清理：完成");
    assert.equal(promptCalls.length, 1);
    assert.equal(promptCalls[0].body.agent, "lynx");
  });

  it("suppresses the notification when the agent cannot be resolved", async () => {
    let promptCalled = false;
    const host = createV1ToolHost(
      fakeClient({
        prompt: async () => {
          promptCalled = true;
        },
      }),
      NO_AGENT,
    );
    await host.notify("sess-1", "上下文清理：完成");
    assert.equal(promptCalled, false, "prompt must not be called");
    const suppress = _getBufferForTesting().find(
      (entry) => entry.level === "warn" && entry.event === "notify_suppressed",
    );
    assert.ok(suppress, "expected a notify_suppressed warn entry");
    assert.equal(suppress.sessionId, "sess-1");
  });

  it("suppresses the notification when session.get throws", async () => {
    let promptCalled = false;
    const host = createV1ToolHost(
      fakeClient({
        get: async () => {
          throw new Error("session not found");
        },
        prompt: async () => {
          promptCalled = true;
        },
      }),
      NO_AGENT,
    );
    await host.notify("sess-1", "hi");
    assert.equal(promptCalled, false, "prompt must not be called");
    const suppress = _getBufferForTesting().find(
      (entry) => entry.event === "notify_suppressed",
    );
    assert.ok(suppress, "expected a notify_suppressed warn entry");
  });

  it("swallows prompt failures and logs a warn entry", async () => {
    const host = createV1ToolHost(
      fakeClient({
        prompt: async () => {
          throw new Error("net down");
        },
      }),
      mapResolver(new Map([["sess-1", "beaver"]])),
    );
    await assert.doesNotReject(host.notify("sess-1", "hi"));
    const warn = _getBufferForTesting().find(
      (entry) => entry.level === "warn" && entry.event === "notify_failed",
    );
    assert.ok(warn, "expected a notify_failed warn entry");
    assert.equal(warn.sessionId, "sess-1");
  });

  it("no-ops when the prompt API is missing", async () => {
    const host = createV1ToolHost(
      fakeClient({}),
      mapResolver(new Map([["sess-1", "beaver"]])),
    );
    await assert.doesNotReject(host.notify("sess-1", "hi"));
  });
});

// ---------------------------------------------------------------------------
// resolveSessionAgent
// ---------------------------------------------------------------------------

describe("resolveSessionAgent", () => {
  it("(a) returns agent from the resolver when present", async () => {
    const map = new Map<string, string>([["ses_test", "beaver"]]);
    const client = {
      session: {
        get: () => {
          throw new Error("should not be called");
        },
      },
    };

    const result = await resolveSessionAgent(
      "ses_test",
      client,
      mapResolver(map),
    );
    assert.equal(result, "beaver");
  });

  it("(b) falls back to client.session.get when the resolver has no entry", async () => {
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

    const result = await resolveSessionAgent(
      "ses_unknown",
      client,
      mapResolver(map),
    );
    assert.equal(result, "lynx");
    assert.equal(getCalled, true);
  });

  it("(b) does NOT write back through the resolver after session.get fallback", async () => {
    const map = new Map<string, string>();
    const client = {
      session: {
        get: async (_opts: { path: { id: string } }) => {
          return { agent: "mola" };
        },
      },
    };

    await resolveSessionAgent("ses_cache", client, mapResolver(map));
    assert.equal(
      map.has("ses_cache"),
      false,
      "resolver backing map must NOT be written by resolveSessionAgent — single writer is message.updated handler",
    );
  });

  it("reflects mid-session agent change when the resolver source is later updated", async () => {
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
    const result1 = await resolveSessionAgent(
      "ses_change",
      client,
      mapResolver(map),
    );
    assert.equal(result1, "lynx");
    assert.equal(getCount, 1);
    assert.equal(
      map.has("ses_change"),
      false,
      "resolver backing map must NOT be written by resolveSessionAgent",
    );

    // Simulate message.updated setting the agent
    map.set("ses_change", "beaver");

    // Second call — map has entry; returns it without calling session.get
    const result2 = await resolveSessionAgent(
      "ses_change",
      client,
      mapResolver(map),
    );
    assert.equal(result2, "beaver");
    assert.equal(getCount, 1, "session.get must not be called again");
  });

  it("(b) returns undefined when session.get returns no agent field", async () => {
    const map = new Map<string, string>();
    const client = {
      session: {
        get: async (_opts: { path: { id: string } }) => ({}),
      },
    };

    const result = await resolveSessionAgent(
      "ses_noagent",
      client,
      mapResolver(map),
    );
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

    const result = await resolveSessionAgent(
      "ses_err",
      client,
      mapResolver(map),
    );
    assert.equal(result, undefined);
  });

  it("(c) returns undefined when no source has the agent", async () => {
    const map = new Map<string, string>();
    const client = {};

    const result = await resolveSessionAgent(
      "ses_none",
      client,
      mapResolver(map),
    );
    assert.equal(result, undefined);
  });

  it("(c) returns undefined when client has no session.get method", async () => {
    const map = new Map<string, string>();
    const client = { session: {} };

    const result = await resolveSessionAgent(
      "ses_noget",
      client,
      mapResolver(map),
    );
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

    const result = await resolveSessionAgent(
      "ses_priority",
      client,
      mapResolver(map),
    );
    assert.equal(result, "kiwi");
    assert.equal(
      getCalled,
      false,
      "session.get must not be called when the resolver has an entry",
    );
  });
});
