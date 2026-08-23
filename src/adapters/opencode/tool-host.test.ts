/**
 * Tests for the OpenCode v1 tool host adapter (`tool-host.ts`).
 *
 * Covers the three host services against a fake `SessionClient`:
 * session-id resolution order (`sessionID` over `sessionId`, undefined
 * fallback), the history fetch unwrap shapes (`{ data: [...] }` wrapper
 * and a bare array) with every rejection branch, and the best-effort
 * notification payload with failure swallowing.
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { SessionClient } from "../../core/client/session.js";
import type { HostMessage } from "../../core/context/lens.js";
import { _getBufferForTesting, _resetForTesting } from "../../utils/logger.js";
import { createV1ToolHost } from "./tool-host.js";
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
 * The prompt payload shape recorded by the fake client.
 */
type PromptInput = {
  path: { id: string };
  body: {
    noReply?: boolean;
    parts: Array<{ type: "text"; text: string; ignored?: boolean }>;
  };
};

/**
 * Build a fake session client with optional messages/prompt behaviors.
 *
 * Absent options leave the corresponding session API undefined so the
 * "API unavailable" and "prompt missing" paths are exercised.
 */
function fakeClient(options: {
  messages?: () => unknown;
  prompt?: (input: PromptInput) => Promise<unknown>;
}): SessionClient {
  const session: Record<string, unknown> = {};
  if (options.messages !== undefined) {
    session.messages = async () => options.messages?.();
  }
  if (options.prompt !== undefined) {
    session.prompt = options.prompt;
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
    const host = createV1ToolHost(fakeClient({}));
    assert.equal(
      host.resolveSessionId({ sessionID: "s1", sessionId: "s2" }),
      "s1",
    );
  });

  it("falls back to sessionId when sessionID is absent", () => {
    const host = createV1ToolHost(fakeClient({}));
    assert.equal(host.resolveSessionId({ sessionId: "s2" }), "s2");
  });

  it("returns undefined when no session id is present", () => {
    const host = createV1ToolHost(fakeClient({}));
    assert.equal(host.resolveSessionId({}), undefined);
  });

  it("returns undefined for non-string or empty session ids", () => {
    const host = createV1ToolHost(fakeClient({}));
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
    );
    const msgs: HostMessage[] = await host.fetchHistory("sess-1");
    assert.equal(msgs.length, 1);
    assert.equal(msgs[0].role, "assistant");
  });

  it("maps an empty data array to an empty transcript", async () => {
    const host = createV1ToolHost(
      fakeClient({ messages: () => ({ data: [] }) }),
    );
    const msgs: HostMessage[] = await host.fetchHistory("sess-1");
    assert.deepEqual(msgs, []);
  });

  it("rejects on res.error with its message", async () => {
    const host = createV1ToolHost(
      fakeClient({ messages: () => ({ error: { message: "boom" } }) }),
    );
    await assert.rejects(host.fetchHistory("sess-1"), /获取会话消息失败：boom/);
  });

  it("rejects on res.error without a message field", async () => {
    const host = createV1ToolHost(
      fakeClient({ messages: () => ({ error: "raw error" }) }),
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
    const host = createV1ToolHost(fakeClient({}));
    await assert.rejects(
      host.fetchHistory("sess-1"),
      /无法获取会话消息：会话消息 API 不可用/,
    );
  });

  it("rejects on an empty response", async () => {
    const host = createV1ToolHost(fakeClient({ messages: () => null }));
    await assert.rejects(
      host.fetchHistory("sess-1"),
      /会话消息 API 返回空结果/,
    );
  });

  it("rejects on a non-array payload", async () => {
    const host = createV1ToolHost(
      fakeClient({ messages: () => ({ data: "nope" }) }),
    );
    await assert.rejects(
      host.fetchHistory("sess-1"),
      /会话消息格式异常：期望数组/,
    );
    const bareObjectHost = createV1ToolHost(
      fakeClient({ messages: () => ({}) }),
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
  it("posts an ignored text prompt carrying the session id", async () => {
    const promptCalls: PromptInput[] = [];
    const host = createV1ToolHost(
      fakeClient({
        prompt: async (input) => {
          promptCalls.push(input);
        },
      }),
    );
    await host.notify("sess-1", "上下文压缩：完成");
    assert.equal(promptCalls.length, 1);
    assert.equal(promptCalls[0].path.id, "sess-1");
    assert.equal(promptCalls[0].body.noReply, true);
    assert.deepEqual(promptCalls[0].body.parts, [
      { type: "text", text: "上下文压缩：完成", ignored: true },
    ]);
  });

  it("swallows prompt failures and logs a warn entry", async () => {
    const host = createV1ToolHost(
      fakeClient({
        prompt: async () => {
          throw new Error("net down");
        },
      }),
    );
    await assert.doesNotReject(host.notify("sess-1", "hi"));
    const warn = _getBufferForTesting().find(
      (entry) => entry.level === "warn" && entry.event === "notify_failed",
    );
    assert.ok(warn, "expected a notify_failed warn entry");
    assert.equal(warn.sessionId, "sess-1");
  });

  it("no-ops when the prompt API is missing", async () => {
    const host = createV1ToolHost(fakeClient({}));
    await assert.doesNotReject(host.notify("sess-1", "hi"));
  });
});
