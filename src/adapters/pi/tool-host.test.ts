/**
 * Tests for the pi tool host (`src/adapters/pi/tool-host.ts`).
 *
 * Covers: session id resolution from the tool execution context, history
 * fetching via `sessionManager.buildContextEntries` with custom-entry
 * filtering and role filtering, and best-effort notification via
 * `ctx.ui.notify` (including missing UI and thrown notifications).
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { _getBufferForTesting, _resetForTesting } from "../../utils/logger.js";
import { createPiToolHost, type PiContextHolder } from "./tool-host.js";

afterEach(() => {
  _resetForTesting();
});

function makeHolder(ctx?: PiContextHolder["current"]): PiContextHolder {
  return { current: ctx };
}

describe("createPiToolHost", () => {
  it("resolves the session id from the tool execution context", () => {
    const host = createPiToolHost(makeHolder());
    const sessionId = host.resolveSessionId({
      sessionManager: { getSessionId: () => "sess-pi-42" },
    });
    assert.equal(sessionId, "sess-pi-42");
  });

  it("returns undefined when the tool context has no sessionManager", () => {
    const host = createPiToolHost(makeHolder());
    assert.equal(host.resolveSessionId({}), undefined);
  });

  it("fetches history as lens messages from message entries", async () => {
    const holder = makeHolder({
      sessionManager: {
        getSessionId: () => "sess-1",
        buildContextEntries: () => [
          { type: "message", message: { role: "user", content: "hi" } },
          {
            type: "message",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "hello" }],
            },
          },
          {
            type: "custom",
            customType: "zoo-state",
            data: {},
          },
        ],
      },
    });
    const host = createPiToolHost(holder);
    const history = await host.fetchHistory("sess-1");

    assert.equal(history.length, 2);
    assert.equal(history[0]?.role, "user");
    assert.equal(history[1]?.role, "assistant");
  });

  it("filters out custom agent message roles", async () => {
    const holder = makeHolder({
      sessionManager: {
        getSessionId: () => "sess-1",
        buildContextEntries: () => [
          { type: "message", message: { role: "user", content: "hi" } },
          {
            type: "message",
            message: {
              role: "custom",
              customType: "notify",
              content: "ignored",
            },
          },
        ],
      },
    });
    const host = createPiToolHost(holder);
    const history = await host.fetchHistory("sess-1");

    assert.equal(history.length, 1);
    assert.equal(history[0]?.role, "user");
  });

  it("throws a Chinese error when buildContextEntries is unavailable", async () => {
    const host = createPiToolHost(
      makeHolder({ sessionManager: { getSessionId: () => "sess-1" } }),
    );
    await assert.rejects(
      async () => host.fetchHistory("sess-1"),
      /无法获取会话消息：会话管理器不可用/,
    );
  });

  it("notifies via ctx.ui.notify when available", async () => {
    const notifications: Array<{ message: string; type?: string }> = [];
    const holder = makeHolder({
      sessionManager: { getSessionId: () => "sess-1" },
      ui: {
        notify(message, type) {
          notifications.push({ message, type });
        },
      },
    });
    const host = createPiToolHost(holder);
    await host.notify("sess-1", "上下文压缩完成");

    assert.deepEqual(notifications, [
      { message: "上下文压缩完成", type: "info" },
    ]);
  });

  it("no-ops gracefully when ctx.ui.notify is absent", async () => {
    const holder = makeHolder({ sessionManager: { getSessionId: () => "s" } });
    const host = createPiToolHost(holder);
    await assert.doesNotReject(async () => host.notify("s", "noop"));
  });

  it("swallows notification failures and logs a warning", async () => {
    const holder = makeHolder({
      sessionManager: { getSessionId: () => "s" },
      ui: {
        notify: () => {
          throw new Error("ui closed");
        },
      },
    });
    const host = createPiToolHost(holder);
    await host.notify("s", "boom"); // must not throw

    const logs = _getBufferForTesting().filter(
      (entry) => entry.event === "notify_failed",
    );
    assert.equal(logs.length, 1);
  });
});
