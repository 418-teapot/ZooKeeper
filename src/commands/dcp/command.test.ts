/**
 * Tests for the `/dcp` command handler (src/commands/dcp/command.ts).
 *
 * Covers: fetching messages, injecting ignored notification, unknown
 * subcommand help, empty messages, unavailable host APIs and the
 * compress gate.  The host dependency is
 * mocked as the host-agnostic `ToolHost` port (`fetchHistory` returns
 * lens `HostMessage[]`, `notify` records calls) and fixtures are built
 * with the core lens testkit — the handler never touches v1 shapes.
 * State is exercised through the new host-agnostic core: the shared
 * session-state manager (`getContextStateManager`) and its store.
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { ToolHost } from "../../core/client/tool-host.js";
import { type HostMessage, project } from "../../core/context/lens.js";
import { PRUNED_TOOL_OUTPUT_REPLACEMENT } from "../../core/context/message-parts.js";
import { publishRoundView } from "../../core/context/round-view.js";
import {
  _resetContextStateManagerForTesting,
  getContextStateManager,
  getRuntimeFlaggedState,
} from "../../core/context/runtime.js";
import { markKey } from "../../core/context/state.js";
import {
  makeAssistantMsg,
  makeMsg,
  makeToolMsg,
  projectMessages,
} from "../../testkits/context.js";
import { _resetForTesting } from "../../utils/logger.js";
import { handleDcpCommand } from "./command.js";

// ---------------------------------------------------------------------------
// Logger & state cleanup
// ---------------------------------------------------------------------------

/** Session IDs that persist to disk during tests (need file cleanup). */
const PERSIST_TEST_SESSION_IDS = ["sess-report-round-view"];

afterEach(() => {
  _resetForTesting();
  const manager = getContextStateManager();
  for (const sid of PERSIST_TEST_SESSION_IDS) {
    manager.store.delete(sid);
  }
  _resetContextStateManagerForTesting();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Create a mock tool host that returns given lens messages and tracks
 * notification calls.
 */
function mockToolHost(messages: HostMessage[]): {
  toolHost: ToolHost;
  notifyCalls: Array<{ sessionID: string; text: string }>;
} {
  const notifyCalls: Array<{ sessionID: string; text: string }> = [];

  const toolHost: ToolHost = {
    resolveSessionId: () => undefined,
    fetchHistory: async () => projectMessages(messages),
    notify: async (sessionID, text) => {
      notifyCalls.push({ sessionID, text });
    },
  };

  return { toolHost, notifyCalls };
}

/**
 * Assert that the notification call includes expected keywords.
 */
function assertNotifyContains(
  notifyCalls: Array<{ text: string }>,
  keyword: string,
  message?: string,
): void {
  assert.ok(notifyCalls.length > 0, "expected at least one notify call");
  assert.ok(
    notifyCalls[0].text.includes(keyword),
    message ?? `expected notify to contain "${keyword}"`,
  );
}

// ---------------------------------------------------------------------------
// Normal flow: context subcommand
// ---------------------------------------------------------------------------

describe("/dcp context subcommand", () => {
  it("fetches messages and injects ignored notification", async () => {
    const view: HostMessage[] = [
      makeMsg("user", ["Hi"]),
      makeAssistantMsg({
        text: "Hello",
        usage: { input: 100, output: 50 },
      }),
    ];
    const { toolHost, notifyCalls } = mockToolHost(view);

    await handleDcpCommand(toolHost, "sess-1", "context");

    assert.equal(notifyCalls.length, 1);
    assert.equal(notifyCalls[0].sessionID, "sess-1");
    assertNotifyContains(notifyCalls, "上下文报告");
    assertNotifyContains(notifyCalls, "tokens");
  });

  it("handles empty args (default to context)", async () => {
    const view: HostMessage[] = [makeMsg("user", ["Hi"])];
    const { toolHost, notifyCalls } = mockToolHost(view);

    await handleDcpCommand(toolHost, "sess-2", "");

    assert.equal(notifyCalls.length, 1);
    assertNotifyContains(notifyCalls, "上下文报告");
  });

  it("includes cache hit rate when available", async () => {
    const view: HostMessage[] = [
      makeMsg("user", ["Hi"]),
      makeAssistantMsg({
        text: "Response",
        usage: { input: 500, output: 100, cacheRead: 200, cacheWrite: 50 },
      }),
    ];
    const { toolHost, notifyCalls } = mockToolHost(view);

    await handleDcpCommand(toolHost, "sess-3", "context");

    assertNotifyContains(notifyCalls, "26.7%");
  });

  it("omits category breakdown from compact report", async () => {
    const view: HostMessage[] = [
      makeMsg("user", ["Hello"]),
      makeAssistantMsg({
        text: "World",
        usage: { input: 500, output: 100 },
      }),
    ];
    const { toolHost, notifyCalls } = mockToolHost(view);

    await handleDcpCommand(toolHost, "sess-4", "context");

    // Compact report: summary lines only, no category breakdown.
    assert.ok(
      !notifyCalls[0].text.includes("分类占比"),
      "should not contain category breakdown intro",
    );
    assert.ok(
      !notifyCalls[0].text.includes("user "),
      "should not contain category label",
    );
    assert.ok(
      !notifyCalls[0].text.includes("总计"),
      "should not contain total footer",
    );
  });
});

// ---------------------------------------------------------------------------
// Effective prune marks over the storage transcript
// ---------------------------------------------------------------------------

/**
 * OpenCode's `fetchHistory` reads the stored transcript, which still
 * carries the pre-prune original output; the handler must overlay the
 * shared state's effective marks so the report measures the model-visible
 * `input + placeholder` for a pruned call.
 */
describe("effective prune marks over storage", () => {
  const SID = "sess-marks-report";

  afterEach(() => {
    getContextStateManager().store.delete(SID);
    _resetContextStateManagerForTesting();
  });

  it("counts a pruned tool output as input plus placeholder", async () => {
    const output = "y".repeat(400);
    const view: HostMessage[] = [
      makeAssistantMsg({ text: "Hi", usage: { input: 500, output: 100 } }),
      makeToolMsg("bash", "echo hello world", output),
    ];

    // Seed the shared manager with an effective mark at the tool-output
    // region (ordinal 1, region index 1).
    const state = getContextStateManager().get(SID);
    state.marks.set(markKey(1, 1), {
      anchorOrdinal: 1,
      regionIndex: 1,
      content: output,
      contentTokens: 100,
      effective: true,
      markedAt: 1,
    });

    const { toolHost, notifyCalls } = mockToolHost(view);
    await handleDcpCommand(toolHost, SID, "context");

    assert.equal(notifyCalls.length, 1);
    // Raw total = exact 600 + tail (input 4 + output 100) = 704.
    // Marked total = 600 + (input 4 + placeholder 20) = 624.
    assert.match(notifyCalls[0].text, /~624 tokens/);
    assert.doesNotMatch(notifyCalls[0].text, /~704 tokens/);
  });

  it("does not double count a round-view placeholder a mark also addresses", async () => {
    // The pi round view is the transform's own projection, so its tool
    // output is already the placeholder; the mark overlay must stay
    // idempotent and the text recognition must count it exactly once.
    const sid = "sess-marks-roundview";
    const view: HostMessage[] = [
      makeAssistantMsg({ text: "Hi", usage: { input: 500, output: 100 } }),
      makeToolMsg("bash", "echo hello world", PRUNED_TOOL_OUTPUT_REPLACEMENT),
    ];
    const state = getContextStateManager().get(sid);
    state.marks.set(markKey(1, 1), {
      anchorOrdinal: 1,
      regionIndex: 1,
      content: "original output",
      contentTokens: 100,
      effective: true,
      markedAt: 1,
    });
    publishRoundView(sid, {
      projection: projectMessages(view),
      numbered: [],
    });

    const notices: string[] = [];
    const toolHost: ToolHost = {
      resolveSessionId: () => undefined,
      notify: async (_sessionID, text) => {
        notices.push(text);
      },
    };
    try {
      await handleDcpCommand(toolHost, sid, "context");
      assert.equal(notices.length, 1);
      // 600 + (input 4 + placeholder 20) = 624 — the placeholder is
      // counted once, never twice.
      assert.match(notices[0], /~624 tokens/);
    } finally {
      getContextStateManager().store.delete(sid);
    }
  });
});

// ---------------------------------------------------------------------------
// Unknown subcommand
// ---------------------------------------------------------------------------

describe("unknown subcommand", () => {
  it("injects help text instead of context report", async () => {
    const view: HostMessage[] = [makeMsg("user", ["Hi"])];
    const { toolHost, notifyCalls } = mockToolHost(view);

    await handleDcpCommand(toolHost, "sess-5", "foobar");

    assert.equal(notifyCalls.length, 1);
    assertNotifyContains(notifyCalls, "用法");
    assertNotifyContains(notifyCalls, "/dcp context");
    // Should NOT contain context report keywords
    assert.equal(
      notifyCalls[0].text.includes("上下文报告"),
      false,
      "help text should not include context report",
    );
  });
});

// ---------------------------------------------------------------------------
// Empty messages
// ---------------------------------------------------------------------------

describe("empty messages", () => {
  it("handles empty array gracefully", async () => {
    const { toolHost, notifyCalls } = mockToolHost([]);

    await handleDcpCommand(toolHost, "sess-6", "context");

    assert.equal(notifyCalls.length, 1);
    assertNotifyContains(notifyCalls, "0 tokens");
    assertNotifyContains(notifyCalls, "0 条");
  });
});

// ---------------------------------------------------------------------------
// Host with missing APIs
// ---------------------------------------------------------------------------

describe("missing host APIs", () => {
  it("throws when toolHost is null", async () => {
    await assert.rejects(
      () => handleDcpCommand(null, "sess-7", "context"),
      /无法获取/,
    );
  });

  it("throws when toolHost is undefined", async () => {
    await assert.rejects(
      () => handleDcpCommand(undefined, "sess-8", "context"),
      /无法获取/,
    );
  });

  it("throws when fetchHistory is unavailable", async () => {
    const toolHost = {} as ToolHost; // no fetchHistory at all
    await assert.rejects(
      () => handleDcpCommand(toolHost, "sess-9", "context"),
      /无法获取/,
    );
  });

  it("reports over the published round view when the host reads no history", async () => {
    // A host whose own read is not provably the transform's source (pi)
    // leaves `fetchHistory` unwired; the round view the last transform
    // published is then the only — and correct — report basis.
    const notices: string[] = [];
    const toolHost: ToolHost = {
      resolveSessionId: () => undefined,
      notify: async (_sid, text) => {
        notices.push(text);
      },
    };
    publishRoundView("sess-report-round-view", {
      projection: projectMessages([
        makeMsg("user", ["问题"]),
        makeAssistantMsg({
          toolCalls: [{ name: "bash", input: "{}", output: "输出内容" }],
        }),
      ]),
      numbered: [],
    });

    await handleDcpCommand(toolHost, "sess-report-round-view", "context");

    assert.equal(notices.length, 1);
    assert.match(notices[0], /上下文报告/);
  });

  it("propagates the fetchHistory rejection (HTTP error)", async () => {
    const toolHost: ToolHost = {
      resolveSessionId: () => undefined,
      fetchHistory: async () => {
        throw new Error("获取会话消息失败：rate limit exceeded");
      },
      notify: async () => {},
    };
    await assert.rejects(
      () => handleDcpCommand(toolHost, "sess-10", "context"),
      /rate limit exceeded/,
    );
  });
});

// ---------------------------------------------------------------------------
// Module exports
// ---------------------------------------------------------------------------

describe("module exports", () => {
  it("exports handleDcpCommand as a function", () => {
    assert.equal(typeof handleDcpCommand, "function");
  });
});

// ---------------------------------------------------------------------------
// Compress subcommand tests
// ---------------------------------------------------------------------------

describe("/dcp compress subcommand", () => {
  const SESSION_ID = "sess-compress-test";

  afterEach(() => {
    const manager = getContextStateManager();
    manager.store.delete(SESSION_ID);
    _resetContextStateManagerForTesting();
  });

  /** Gate-open config — compress section strictly parsed. */
  const compressConfig: Parameters<typeof handleDcpCommand>[3] = {
    dedup: {},
    purgeErrors: {},
    protectedMessages: 2,
    compress: { thresholdTokens: 1, protectedTokens: 1 },
  };

  it("compress tool not registered → command refuses with notice, no state writes", async () => {
    const { toolHost, notifyCalls } = mockToolHost([]);

    // Valid compress section, but the tool is NOT in the profile tools.
    await handleDcpCommand(
      toolHost,
      "sess-compress-disabled",
      "compress",
      {
        dedup: {},
        purgeErrors: {},
        compress: { thresholdTokens: 1, protectedTokens: 1 },
      },
      false,
    );

    assert.ok(
      notifyCalls[0].text.includes("压缩功能未启用"),
      `expected "压缩功能未启用" in notify, got: ${notifyCalls[0].text}`,
    );

    // State should be empty (no flag, no writes).
    const state = getRuntimeFlaggedState("sess-compress-disabled");
    assert.equal(state.blocks.size, 0);
    assert.equal(state.pendingManualTrigger, undefined);
  });

  it("compress section absent → command refuses with notice, no state writes", async () => {
    const { toolHost, notifyCalls } = mockToolHost([]);

    // Tool registered in the profile, but the compress section is absent.
    await handleDcpCommand(
      toolHost,
      "sess-compress-absent",
      "compress",
      {
        dedup: {},
        purgeErrors: {},
      },
      true,
    );

    assert.ok(
      notifyCalls[0].text.includes("压缩功能未启用"),
      `expected "压缩功能未启用" in notify, got: ${notifyCalls[0].text}`,
    );

    // State should be empty (no flag, no writes).
    const state = getRuntimeFlaggedState("sess-compress-absent");
    assert.equal(state.blocks.size, 0);
    assert.equal(state.pendingManualTrigger, undefined);
  });

  it("arms the one-shot trigger and notifies; creates no blocks, fetches no messages", async () => {
    // The tool host deliberately has NO fetchHistory — arming the trigger
    // must not fetch the message list (arming only sets the one-shot trigger).
    let notifyText = "";
    const toolHost: ToolHost = {
      resolveSessionId: () => undefined,
      fetchHistory: async () => {
        throw new Error("fetchHistory must not be called");
      },
      notify: async (_sessionID, text) => {
        notifyText = text;
      },
    };

    await handleDcpCommand(
      toolHost,
      SESSION_ID,
      "compress",
      compressConfig,
      true,
    );

    // Notification tells the user about the next-turn trigger.
    assert.ok(
      notifyText.includes("下一轮"),
      `expected next-turn trigger notice, got: ${notifyText}`,
    );

    // One-shot in-memory flag set; no blocks; the flag is never
    // persisted (the state file stays absent).
    const state = getRuntimeFlaggedState(SESSION_ID);
    assert.equal(state.pendingManualTrigger, true, "one-shot flag set");
    assert.equal(state.blocks.size, 0, "no blocks created");
  });

  it("repeat /dcp compress keeps the flag armed (idempotent)", async () => {
    const toolHost: ToolHost = {
      resolveSessionId: () => undefined,
      fetchHistory: async () => project([] as HostMessage[], []),
      notify: async () => {},
    };

    await handleDcpCommand(
      toolHost,
      SESSION_ID,
      "compress",
      compressConfig,
      true,
    );
    await handleDcpCommand(
      toolHost,
      SESSION_ID,
      "compress",
      compressConfig,
      true,
    );

    const state = getRuntimeFlaggedState(SESSION_ID);
    assert.equal(state.pendingManualTrigger, true, "flag stays armed");
    assert.equal(state.blocks.size, 0);
  });
});
