/**
 * Tests for the `/dcp` command handler (src/commands/dcp/command.ts).
 *
 * Covers: fetching messages, injecting ignored notification, unknown
 * subcommand help, empty messages, unavailable host APIs, sweep
 * selection semantics and the compress gate.  The host dependency is
 * mocked as the host-agnostic `ToolHost` port (`fetchHistory` returns
 * lens `HostMessage[]`, `notify` records calls) and fixtures are built
 * with the core lens testkit — the handler never touches v1 shapes.
 * State is exercised through the new host-agnostic core: the shared
 * session-state manager (`getContextStateManager`) and its store.
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { ToolHost } from "../../core/client/tool-host.js";
import type { HostMessage } from "../../core/context/lens.js";
import {
  makeAssistantMsg,
  makeMsg,
  makeToolMsg,
} from "../../core/context/lens-testkit.js";
import { estimateTokenCount } from "../../core/context/measure.js";
import { PRUNED_TOOL_OUTPUT_REPLACEMENT } from "../../core/context/message-parts.js";
import {
  computeEdits,
  flipReleasedMarks,
  pendingTokens,
  reclaimedTokens,
} from "../../core/context/release.js";
import {
  _resetContextStateManagerForTesting,
  consumePendingViewChange,
  getContextStateManager,
  getRuntimeFlaggedState,
} from "../../core/context/runtime.js";
import { markKey } from "../../core/context/state.js";
import { _resetForTesting } from "../../utils/logger.js";
import { handleDcpCommand, parseSweepCount } from "./command.js";

// ---------------------------------------------------------------------------
// Logger & state cleanup
// ---------------------------------------------------------------------------

/** Session IDs that persist to disk during tests (need file cleanup). */
const SWEEP_TEST_SESSION_IDS = [
  "sess-sweep-success",
  "sess-short-output",
  "sess-sweep-1",
  "sess-no-double",
  "sess-persist-after-sweep",
];

afterEach(() => {
  _resetForTesting();
  const manager = getContextStateManager();
  for (const sid of SWEEP_TEST_SESSION_IDS) {
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
    fetchHistory: async () => messages,
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

  it("exports parseSweepCount as a function", () => {
    assert.equal(typeof parseSweepCount, "function");
  });
});

// ---------------------------------------------------------------------------
// parseSweepCount
// ---------------------------------------------------------------------------

describe("parseSweepCount", () => {
  it("returns undefined for bare 'sweep'", () => {
    assert.equal(parseSweepCount("sweep"), undefined);
  });

  it("throws for 'sweep' with trailing space (Number('')=0, rejected by n<1 guard)", () => {
    assert.throws(() => parseSweepCount("sweep  "), /正整数/);
  });

  it("parses a positive integer N from 'sweep N'", () => {
    assert.equal(parseSweepCount("sweep 3"), 3);
  });

  it("handles double spaces: 'sweep  3'", () => {
    assert.equal(parseSweepCount("sweep  3"), 3);
  });

  it("rejects N=0 (no-op, should be user error)", () => {
    assert.throws(() => parseSweepCount("sweep 0"), /正整数/);
  });

  it("rejects negative N", () => {
    assert.throws(() => parseSweepCount("sweep -1"), /正整数/);
  });

  it("rejects float N", () => {
    assert.throws(() => parseSweepCount("sweep 3.5"), /正整数/);
  });

  it("rejects non-numeric argument", () => {
    assert.throws(() => parseSweepCount("sweep abc"), /正整数/);
  });
});

// ---------------------------------------------------------------------------
// Sweep subcommand integration tests
// ---------------------------------------------------------------------------

describe("/dcp sweep subcommand — success path", () => {
  it("marks tool outputs, injects result, does NOT throw sentinel", async () => {
    // Messages with tool parts after the last user message.  The
    // assistant message (ordinal 1) carries two tool calls; each maps
    // to a tool-input/tool-output region pair.
    const output1 =
      "output 1 data with additional content to make the net token estimate positive after placeholder subtraction";
    const output2 =
      "output 2 longer content here with even more text to ensure a positive net reclaim estimate after subtracting the placeholder";
    const view: HostMessage[] = [
      makeMsg("user", ["do something"]),
      makeAssistantMsg({
        toolCalls: [
          { name: "bash", input: "{}", output: output1 },
          { name: "bash", input: "{}", output: output2 },
        ],
      }),
    ];

    const { toolHost, notifyCalls } = mockToolHost(view);

    // Should NOT throw.
    await handleDcpCommand(toolHost, "sess-sweep-success", "sweep");

    // Verify result message was injected.
    assert.ok(
      notifyCalls[0].text.includes("已标记"),
      `expected "已标记" in notify, got: ${notifyCalls[0].text}`,
    );
    assert.ok(
      notifyCalls[0].text.includes("预计可回收"),
      `expected "预计可回收" in notify, got: ${notifyCalls[0].text}`,
    );

    // Verify state was populated.  New-core marks are keyed by
    // `(ordinal, regionIndex)`: the assistant message is ordinal 1, and
    // its two tool parts map to regions [0]=input, [1]=output for
    // call-1 and [2]=input, [3]=output for call-2.
    const state = getContextStateManager().get("sess-sweep-success");
    assert.equal(state.marks.size, 2);
    assert.ok(state.marks.has(markKey(1, 1)));
    assert.ok(state.marks.has(markKey(1, 3)));

    // Token estimates reflect net reclaim (output - placeholder).
    const placeholderTokens = estimateTokenCount(
      PRUNED_TOOL_OUTPUT_REPLACEMENT,
    );
    const est1 = state.marks.get(markKey(1, 1))?.contentTokens ?? 0;
    const est2 = state.marks.get(markKey(1, 3))?.contentTokens ?? 0;
    assert.equal(
      est1,
      Math.max(0, estimateTokenCount(output1) - placeholderTokens),
      "unexpected net estimate for call-1",
    );
    assert.equal(
      est2,
      Math.max(0, estimateTokenCount(output2) - placeholderTokens),
      "unexpected net estimate for call-2",
    );

    // Sweep marks are pending; pendingTokens carries the reclaim total
    // until the next transform release flips them effective.
    assert.equal(
      pendingTokens(state),
      est1 + est2,
      "pendingTokens should reflect the sweep marks",
    );
  });

  it("short tool output yields zero estimatedTokens and does not inflate totalPruneTokens", async () => {
    // A very short output like "ok" (2 chars → 1 token) is shorter than
    // the placeholder (83 chars → 21 tokens), so Math.max floors to 0.
    const view: HostMessage[] = [
      makeMsg("user", ["run command"]),
      makeAssistantMsg({
        toolCalls: [{ name: "bash", input: "{}", output: "ok" }],
      }),
    ];

    const { toolHost, notifyCalls } = mockToolHost(view);

    await handleDcpCommand(toolHost, "sess-short-output", "sweep");

    const state = getContextStateManager().get("sess-short-output");
    assert.equal(state.marks.size, 1);
    assert.ok(state.marks.has(markKey(1, 1)));

    // contentTokens should be floored to 0 because "ok" (2 chars)
    // yields fewer tokens than the placeholder.
    const estValue = state.marks.get(markKey(1, 1))?.contentTokens ?? -1;
    assert.equal(estValue, 0, "short output should have 0 estimated tokens");

    // pendingTokens should NOT be inflated by the negative estimate.
    // Since contentTokens is 0, pendingTokens must stay at 0.
    assert.equal(
      pendingTokens(state),
      0,
      "pendingTokens should not change when contentTokens is 0",
    );

    // The user-facing report confirms 1 tool marked with 0 tokens.
    assert.ok(
      notifyCalls[0].text.includes("已标记 1 个工具输出"),
      "report should confirm 1 marked tool",
    );
  });

  it("accepts 'sweep 1' marking only the most recent tool", async () => {
    const view: HostMessage[] = [
      makeToolMsg("bash", "{}", "old output"),
      makeToolMsg("bash", "{}", "recent output"),
    ];

    const { toolHost } = mockToolHost(view);

    await handleDcpCommand(toolHost, "sess-sweep-1", "sweep 1");

    const state = getContextStateManager().get("sess-sweep-1");
    assert.equal(state.marks.size, 1);
    assert.ok(
      state.marks.has(markKey(1, 1)),
      "expected the most recent tool to be marked",
    );
    assert.ok(
      !state.marks.has(markKey(0, 1)),
      "expected the older tool to stay unmarked",
    );
  });

  it("totalPruneTokens accumulates once at mark time, NOT doubled by the release pass", async () => {
    // Simulate a sweep followed by two transform turns (release calls).
    const output =
      "some tool output with extra text to make net positive after subtracting the placeholder string fully";
    const view: HostMessage[] = [
      makeMsg("user", ["do something"]),
      makeAssistantMsg({
        toolCalls: [{ name: "bash", input: "{}", output }],
      }),
    ];

    const { toolHost } = mockToolHost(view);

    // Sweep (mark time): the reclaim total accumulates here; the sweep
    // arms the pending-view-change flag consumed by the next release.
    const sessionID = "sess-no-double";
    await handleDcpCommand(toolHost, sessionID, "sweep");

    const state = getContextStateManager().get(sessionID);
    const markTimeValue = pendingTokens(state);
    const placeholderTokens = estimateTokenCount(
      PRUNED_TOOL_OUTPUT_REPLACEMENT,
    );
    assert.equal(
      markTimeValue,
      Math.max(0, estimateTokenCount(output) - placeholderTokens),
      "pendingTokens should be net reclaim after sweep",
    );

    // Transform turn 1: the release pass consumes the view-change flag
    // and flips the pending mark effective — the reclaim total moves to
    // the effective side without doubling.  The edit selection confirms
    // the release pass targets the pending sweep mark's region; the flip
    // performs the state half.
    const turn1View = view;
    const viewChange = consumePendingViewChange(sessionID);
    const turn1Edits = computeEdits(state, turn1View, {
      promptTokens: 0,
      pendingViewChange: viewChange,
    });
    assert.equal(turn1Edits.length, 1, "the pending sweep mark is released");
    flipReleasedMarks(state, {
      promptTokens: 0,
      pendingViewChange: viewChange,
    });
    assert.equal(
      reclaimedTokens(state),
      markTimeValue,
      "release should move the reclaim total to effective, not double it (turn 1)",
    );
    assert.equal(
      pendingTokens(state),
      0,
      "no pending tokens remain after the release (turn 1)",
    );

    // Transform turn 2: reloaded from DB (output reverted to original),
    // the release applies again.  reclaimedTokens still unchanged.
    const reloadedView: HostMessage[] = [
      makeMsg("user", ["do something"]),
      makeAssistantMsg({
        toolCalls: [{ name: "bash", input: "{}", output }],
      }),
    ];
    // The now-effective mark still selects an edit; the closed gate
    // (promptTokens 0, no bypass) flips nothing.
    const turn2Edits = computeEdits(state, reloadedView, {
      promptTokens: 0,
      pendingViewChange: false,
    });
    assert.equal(turn2Edits.length, 1, "the effective mark is re-applied");
    flipReleasedMarks(state, {
      promptTokens: 0,
      pendingViewChange: false,
    });
    assert.equal(
      reclaimedTokens(state),
      markTimeValue,
      "release should NOT change reclaimedTokens across multiple turns",
    );
  });

  it("persists sweep marks to disk immediately via the shared manager", async () => {
    const sessionID = "sess-persist-after-sweep";
    const view: HostMessage[] = [
      makeMsg("user", ["do something"]),
      makeAssistantMsg({
        toolCalls: [
          {
            name: "bash",
            input: "{}",
            output:
              "some tool output that is long enough to make net reclaim positive after subtracting the placeholder text here and there",
          },
        ],
      }),
    ];

    const { toolHost } = mockToolHost(view);

    await handleDcpCommand(toolHost, sessionID, "sweep");

    // Verify marks survive a store reload (disk persistence).
    const manager = getContextStateManager();
    const persisted = manager.store.load(sessionID);
    assert.ok(persisted.marks.has(markKey(1, 1)), "mark persisted to disk");
    assert.ok(
      (persisted.marks.get(markKey(1, 1))?.contentTokens ?? 0) >= 0,
      "persisted estimate must be non-negative",
    );

    // Clean up persisted file.
    manager.store.delete(sessionID);
  });
});

describe("/dcp sweep subcommand — no-marks path", () => {
  it("injects no-marks message when no tool outputs exist, does NOT throw", async () => {
    const view: HostMessage[] = [
      makeMsg("user", ["hello"]),
      makeAssistantMsg({ text: "response" }),
    ];

    const { toolHost, notifyCalls } = mockToolHost(view);

    // Should NOT throw.
    await handleDcpCommand(toolHost, "sess-no-tools", "sweep");

    // Verify no-marks message was injected.
    assert.ok(
      notifyCalls[0].text.includes("没有找到可标记的工具输出"),
      `expected "没有找到可标记的工具输出" in notify, got: ${notifyCalls[0].text}`,
    );

    // State marks should be empty.
    const state = getContextStateManager().get("sess-no-tools");
    assert.equal(state.marks.size, 0);
  });

  it("returns no-marks message when all tool outputs are already marked", async () => {
    const view: HostMessage[] = [
      makeMsg("user", ["do it"]),
      makeToolMsg("bash", "{}", "only output"),
    ];

    // Pre-mark the position the sweep would claim (ordinal 1, tool-output
    // region index 1).
    const state = getContextStateManager().get("sess-already-marked");
    state.marks.set(markKey(1, 1), {
      anchorOrdinal: 1,
      regionIndex: 1,
      content: "only output",
      contentTokens: 100,
      effective: true,
      markedAt: Date.now(),
    });

    const { toolHost, notifyCalls } = mockToolHost(view);

    // Should NOT throw — no new marks to add.
    await handleDcpCommand(toolHost, "sess-already-marked", "sweep");

    // Should have injected the no-marks message.
    assert.ok(
      notifyCalls[0].text.includes("没有找到可标记的工具输出"),
      `expected no-marks message, got: ${notifyCalls[0].text}`,
    );
  });
});

describe("/dcp sweep subcommand — parse errors propagate", () => {
  it("throws for 'sweep 0' (not a positive integer)", async () => {
    const { toolHost } = mockToolHost([]);

    await assert.rejects(
      () => handleDcpCommand(toolHost, "sess", "sweep 0"),
      /正整数/,
    );
  });

  it("throws for 'sweep -1' (negative)", async () => {
    const { toolHost } = mockToolHost([]);

    await assert.rejects(
      () => handleDcpCommand(toolHost, "sess", "sweep -1"),
      /正整数/,
    );
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
    // must not fetch the message list (the mechanical pipeline is gone).
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
      fetchHistory: async () => [],
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
