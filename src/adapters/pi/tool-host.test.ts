/**
 * Tests for the pi tool host (`src/adapters/pi/tool-host.ts`).
 *
 * Covers: session id resolution from the tool execution context, the
 * deliberate absence of a host history fallback (pi's context-entry read
 * is not the ordinal space the `context` event projects), best-effort
 * notification via pi's `appendEntry` channel (`zoo-notice` custom
 * entries, including missing appendEntry and thrown appendEntry), and the
 * transient `toast` port through the ui of the session the call names
 * (message rendering, per-session routing, silent drop without a UI
 * surface, and swallowed failures).
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { _getBufferForTesting, _resetForTesting } from "../../utils/logger.js";
import { createPiSessionContexts } from "./session-contexts.js";
import { createPiToolHost } from "./tool-host.js";

afterEach(() => {
  _resetForTesting();
});

/** A session context whose ui records the notices it receives. */
function sessionCtx(notices: string[]): unknown {
  return {
    ui: {
      notify: (message: string) => {
        notices.push(message);
      },
    },
  };
}

describe("createPiToolHost", () => {
  it("resolves the session id from the tool execution context", () => {
    const host = createPiToolHost(createPiSessionContexts());
    const sessionId = host.resolveSessionId({
      sessionManager: { getSessionId: () => "sess-pi-42" },
    });
    assert.equal(sessionId, "sess-pi-42");
  });

  it("returns undefined when the tool context has no sessionManager", () => {
    const host = createPiToolHost(createPiSessionContexts());
    assert.equal(host.resolveSessionId({}), undefined);
  });

  it("offers no history fallback (the tools read the transform's round view)", () => {
    // pi's buildContextEntries channel is a different ordinal space than
    // the one the context event projects, so the host must not expose it
    // as a fallback — a regression here silently resurrects the bug.
    const host = createPiToolHost(createPiSessionContexts());
    assert.equal(host.fetchHistory, undefined);
  });

  it("notifies by appending a zoo-notice custom entry when appendEntry is available", async () => {
    const appended: Array<{ customType: string; data?: unknown }> = [];
    const host = createPiToolHost(
      createPiSessionContexts(),
      (customType, data) => {
        appended.push({ customType, data });
      },
    );
    await host.notify("sess-1", "上下文压缩完成");

    assert.deepEqual(appended, [
      { customType: "zoo-notice", data: { content: "上下文压缩完成" } },
    ]);
  });

  it("no-ops gracefully when appendEntry is absent", async () => {
    const host = createPiToolHost(createPiSessionContexts());
    await assert.doesNotReject(async () => host.notify("s", "noop"));
  });

  it("swallows appendEntry failures and logs a warning", async () => {
    const host = createPiToolHost(createPiSessionContexts(), () => {
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
    const contexts = createPiSessionContexts();
    contexts.bind("sess-1", {
      ui: {
        notify: (message: string, type?: "info" | "warning" | "error") => {
          notices.push({ message, type });
        },
      },
    });
    const host = createPiToolHost(contexts);

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

  it("toasts on the ui of the session the call names", () => {
    const first: string[] = [];
    const second: string[] = [];
    const contexts = createPiSessionContexts();
    contexts.bind("sess-1", sessionCtx(first));
    contexts.bind("sess-2", sessionCtx(second));
    const host = createPiToolHost(contexts);

    host.toast?.("sess-1", { source: "x", level: "info", text: "to 1" });
    host.toast?.("sess-2", { source: "x", level: "info", text: "to 2" });

    assert.deepEqual(first, ["[zoo][x] to 1"]);
    assert.deepEqual(second, ["[zoo][x] to 2"]);
  });

  it("drops a toast for a session that bound no context", () => {
    const notices: string[] = [];
    const contexts = createPiSessionContexts();
    contexts.bind("sess-1", sessionCtx(notices));
    const host = createPiToolHost(contexts);

    // Fail closed: an unknown session never borrows another session's ui.
    assert.doesNotThrow(() =>
      host.toast?.("sess-2", { source: "x", level: "info", text: "hi" }),
    );
    assert.deepEqual(notices, []);
  });

  it("silently drops when the context carries no ui.notify", () => {
    // ui present, notify absent (print mode).
    const contexts = createPiSessionContexts();
    contexts.bind("s", { ui: {} });
    const host = createPiToolHost(contexts);
    assert.doesNotThrow(() =>
      host.toast?.("s", { source: "x", level: "info", text: "hi" }),
    );
    // Whole context absent.
    const bare = createPiToolHost(createPiSessionContexts());
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
    const contexts = createPiSessionContexts();
    contexts.bind("s", {
      ui: {
        notify: () => {
          throw new Error("tui gone");
        },
      },
    });
    const host = createPiToolHost(contexts);
    assert.doesNotThrow(() =>
      host.toast?.("s", { source: "x", level: "info", text: "boom" }),
    );

    const logs = _getBufferForTesting().filter(
      (entry) => entry.event === "toast_failed",
    );
    assert.equal(logs.length, 1);
  });
});
