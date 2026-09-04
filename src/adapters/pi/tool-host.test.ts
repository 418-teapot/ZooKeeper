/**
 * Tests for the pi tool host (`src/adapters/pi/tool-host.ts`).
 *
 * Covers: session id resolution from the tool execution context, history
 * fetching via `sessionManager.buildContextEntries` with custom-entry
 * filtering and role filtering, best-effort notification via pi's
 * `appendEntry` channel (`zoo-notice` custom entries, including missing
 * appendEntry and thrown appendEntry), and the transient `toast` port
 * through `ui.notify` (message rendering, silent drop without the UI
 * surface, and swallowed failures).
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

  it("notifies by appending a zoo-notice custom entry when appendEntry is available", async () => {
    const appended: Array<{ customType: string; data?: unknown }> = [];
    const host = createPiToolHost(makeHolder(), (customType, data) => {
      appended.push({ customType, data });
    });
    await host.notify("sess-1", "上下文压缩完成");

    assert.deepEqual(appended, [
      { customType: "zoo-notice", data: { content: "上下文压缩完成" } },
    ]);
  });

  it("no-ops gracefully when appendEntry is absent", async () => {
    const host = createPiToolHost(makeHolder());
    await assert.doesNotReject(async () => host.notify("s", "noop"));
  });

  it("swallows appendEntry failures and logs a warning", async () => {
    const host = createPiToolHost(makeHolder(), () => {
      throw new Error("session gone");
    });
    await host.notify("s", "boom"); // must not throw

    const logs = _getBufferForTesting().filter(
      (entry) => entry.event === "notify_failed",
    );
    assert.equal(logs.length, 1);
  });
});

describe("toast (pi ui.notify channel)", () => {
  it("renders source and level through ui.notify when available", () => {
    const notices: Array<{ message: string; type?: string }> = [];
    const host = createPiToolHost(
      makeHolder({
        ui: {
          notify: (message, type) => {
            notices.push({ message, type });
          },
        },
      }),
    );

    assert.doesNotThrow(() =>
      host.toast?.("sess-1", {
        source: "context-pruning",
        level: "warning",
        text: "上下文吃紧：已用 90%",
      }),
    );
    assert.deepEqual(notices, [
      {
        message: "[zoo][context-pruning] 上下文吃紧：已用 90%",
        type: "warning",
      },
    ]);
  });

  it("silently drops when the context carries no ui.notify", () => {
    // ui present, notify absent (print mode).
    const host = createPiToolHost(makeHolder({ ui: {} }));
    assert.doesNotThrow(() =>
      host.toast?.("s", { source: "x", level: "info", text: "hi" }),
    );
    // Whole context absent.
    const bare = createPiToolHost(makeHolder());
    assert.doesNotThrow(() =>
      bare.toast?.("s", { source: "x", level: "info", text: "hi" }),
    );
    assert.equal(
      _getBufferForTesting().some((entry) => entry.event === "toast_failed"),
      false,
      "silent drop must not log a failure",
    );
  });

  it("swallows ui.notify failures and logs a warning", () => {
    const host = createPiToolHost(
      makeHolder({
        ui: {
          notify: () => {
            throw new Error("tui gone");
          },
        },
      }),
    );
    assert.doesNotThrow(() =>
      host.toast?.("s", { source: "x", level: "info", text: "boom" }),
    );

    const logs = _getBufferForTesting().filter(
      (entry) => entry.event === "toast_failed",
    );
    assert.equal(logs.length, 1);
  });
});
