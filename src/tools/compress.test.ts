/**
 * Integration tests for the batch compress tool adapter.
 *
 * Covers: the full execute flow (round view published by the transform →
 * core batch → pending view-change flag → persist → notify →
 * ToolResult), the history-source rule (cached round view wins, host
 * read only as a fallback, fail-closed guidance when neither exists),
 * multi-range batch creation with a single persistence and a single
 * notification, the `max_ranges` overflow gate
 * (loud batch guidance), every argument-validation branch with its
 * G-TOOL-01 Chinese guidance text (missing/empty/non-array ranges,
 * non-object items, non-string fields, empty/control/hyphen/overlong
 * titles), core-gate rejections naming the 1-based range index (unknown
 * ref, reversed order, overlap, first-user protection), the config
 * guidance errors, the best-effort notify failure, and the registration
 * gate (tool hooks + primary_tools).
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { ToolHost } from "../core/client/tool-host.js";
import { parseContextConfig } from "../core/config-parse.js";
import { fold } from "../core/context/fold.js";
import type { HostMessage, Projection } from "../core/context/lens.js";
import { project } from "../core/context/lens.js";
import {
  _listRoundViewSessionsForTesting,
  publishRoundView,
} from "../core/context/round-view.js";
import {
  _resetContextStateManagerForTesting,
  consumePendingViewChange,
  getContextStateManager,
} from "../core/context/runtime.js";
import type { Block, SessionState } from "../core/context/state.js";
import { numberView } from "../core/context/view-refs.js";
import {
  buildPlugin,
  buildToolHooks,
  registerProfileToolsInConfig,
} from "../opencode.js";
import { _resetForTesting } from "../utils/logger.js";
import {
  type CompressToolDefinition,
  unit as compressUnit,
  createCompressTool,
} from "./compress.js";

// ---------------------------------------------------------------------------
// Session ids & teardown
// ---------------------------------------------------------------------------

const TEST_SESSION_ID = "sess-compress-tool";

afterEach(() => {
  const store = getContextStateManager().store;
  store.delete(TEST_SESSION_ID);
  _resetContextStateManagerForTesting();
  _resetForTesting();
});

// ---------------------------------------------------------------------------
// Poly profile fixture
// ---------------------------------------------------------------------------

/**
 * A zoo config with the poly profile, mirroring config.toml's
 * `[zoo.context.compress]` values so the flow tests keep their thresholds
 * (protectedMessages=20, thresholdTokens=2000, protectedTokens=20000,
 * maxRanges=8).
 */
const POLY_ZOO: Record<string, unknown> = {
  context: {
    protected_messages: 20,
    released_percent: 10,
    dedup: { threshold_context: 100000, protected_tools: [] },
    purge_errors: {
      threshold_context: 100000,
      protected_tools: [],
    },
    compress: {
      threshold_tokens: 2000,
      protected_tokens: 20000,
      max_ranges: 8,
    },
    decompress: { max_fill_percent: 90 },
  },
  mode: {
    poly: {
      tools: ["compress", "decompress"],
    },
  },
};

/** Build a plugin wired to the poly profile (tools: compress + decompress). */
function makePlugin(client: unknown = {}): Promise<Record<string, any>> {
  return buildPlugin({ client }, POLY_ZOO) as Promise<Record<string, any>>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Line-number ref of the visible message at the given index.
 *
 * A fresh session (no blocks, no hidden messages) has a dense
 * line-numbered view: message at index i carries line number i + 1.
 */
function refFor(index: number): string {
  return `m${index + 1}`;
}

/** Long tool output (~2000 heuristic tokens) so the protection gates pass. */
const LONG_OUTPUT = "x".repeat(8000);

/** Parsed context config from POLY_ZOO. */
const PARSED_CONFIG = parseContextConfig(POLY_ZOO);

function makeUserLensMsg(text: string): HostMessage {
  return {
    role: "user",
    hidden: false,
    regions: [{ kind: "content", get: () => text }],
  };
}

function makeAssistantLensMsg(text: string): HostMessage {
  return {
    role: "assistant",
    hidden: false,
    regions: [{ kind: "content", get: () => text }],
  };
}

function makeToolLensMsg(): HostMessage {
  return {
    role: "assistant",
    hidden: false,
    regions: [
      { kind: "tool-input", get: () => "x" },
      { kind: "tool-output", get: () => LONG_OUTPUT },
    ],
  };
}

/**
 * A 31-message conversation heavy enough to pass the real config gates
 * (protectedMessages=20, protectedTokens=20000, thresholdTokens=2000).
 *
 * Indices: u0 (first user) + 28 tool-heavy exchanges + last user + final
 * assistant.  The protection boundary lands at index 11, so valid ranges
 * live inside [1, 11).  Range [1, 6) covers ordinals 1..5 (5 tool
 * messages) and range [6, 10) covers ordinals 6..9 (4 more) — both
 * comfortably over the threshold.
 */
function makeMessages(): HostMessage[] {
  const msgs: HostMessage[] = [makeUserLensMsg("开场问题")];
  for (let i = 1; i <= 28; i++) {
    msgs.push(makeToolLensMsg());
  }
  msgs.push(makeUserLensMsg("最后一个问题"));
  msgs.push(makeAssistantLensMsg("回答完毕"));
  return msgs;
}

/** A single valid range on `makeMessages()` output (inclusive endpoints). */
function makeRange(
  fromIndex: number,
  toIndex: number,
  title = "执行命令主题",
  summary = "用户请求执行命令，助手完成了操作。",
): { fromRef: string; toRef: string; title: string; summary: string } {
  return {
    fromRef: refFor(fromIndex),
    toRef: refFor(toIndex),
    title,
    summary,
  };
}

/** Build a fake ToolHost over the given lens messages. */
function fakeHost(messages: HostMessage[]): {
  host: ToolHost;
  notifyCalls: Array<{ sessionID: string; text: string }>;
} {
  const notifyCalls: Array<{ sessionID: string; text: string }> = [];
  const host: ToolHost = {
    resolveSessionId(toolCtx: unknown): string | undefined {
      const ctx = toolCtx as { sessionID?: unknown; sessionId?: unknown };
      const id = ctx.sessionID ?? ctx.sessionId;
      if (typeof id !== "string" || id.length === 0) return undefined;
      return id;
    },
    async fetchHistory(_sessionId: string): Promise<Projection> {
      return project(messages, []);
    },
    async notify(sessionID: string, text: string): Promise<void> {
      notifyCalls.push({ sessionID, text });
    },
  };
  return { host, notifyCalls };
}

/** Mock OpenCode client for plugin-level integration tests. */
function mockClient(messages: any[]): {
  client: any;
  promptCalls: Array<{
    sessionID: string;
    text: string;
    noReply?: boolean;
    ignored?: boolean;
  }>;
} {
  const promptCalls: Array<{
    sessionID: string;
    text: string;
    noReply?: boolean;
    ignored?: boolean;
  }> = [];
  const client = {
    session: {
      messages: async () => ({ data: messages }),
      prompt: async (input: {
        path: { id: string };
        body: {
          noReply?: boolean;
          parts: Array<{ type: "text"; text: string; ignored?: boolean }>;
        };
      }) => {
        promptCalls.push({
          sessionID: input.path.id,
          text: input.body.parts[0]?.text ?? "",
          noReply: input.body.noReply,
          ignored: input.body.parts[0]?.ignored,
        });
      },
    },
  };
  return { client, promptCalls };
}

/** Hand-written minimal OpenCode ToolContext shape. */
const mockToolContext = {
  sessionID: TEST_SESSION_ID,
  messageID: "msg-compress",
  agent: "dolphin",
  directory: "/tmp",
  worktree: "/tmp",
  abort: new AbortController().signal,
  metadata: () => {},
  ask: async () => {},
};

/** The shared manager's live session state (same singleton the tool uses). */
function sessionState(): SessionState {
  return getContextStateManager().get(TEST_SESSION_ID);
}

/** The first (and only) block of the live session state. */
function firstBlock(): Block {
  const state = sessionState();
  assert.equal(state.blocks.size, 1, "exactly one block expected");
  const block = state.blocks.get(1);
  assert.ok(block !== undefined);
  return block;
}

// ---------------------------------------------------------------------------
// History source — the single snapshot published by the transform
// ---------------------------------------------------------------------------

/**
 * Publish the round view the transform would have published for `messages`.
 *
 * Built the same way the hook builds it (fold over the projection, then
 * dense numbering over the visible items), so the tool's cached path is
 * exercised with production-shaped data.
 */
function publishViewOf(messages: HostMessage[]): void {
  const snapshot = project(messages, []);
  const state = getContextStateManager().get(TEST_SESSION_ID);
  const { items } = fold(snapshot, state);
  const numbered = numberView(
    items,
    (ordinal) => snapshot.messages[ordinal].hidden,
  );
  publishRoundView(TEST_SESSION_ID, { projection: snapshot, numbered });
}

/**
 * A host whose optional history read is observable (call-counted) or absent.
 *
 * @param options.calls - Where to record each `fetchHistory` call; omit
 *   `history` entirely to model a host that offers no fallback.
 */
function sourceHost(options: { history?: HostMessage[]; calls?: number[] }): {
  host: ToolHost;
  notifyCalls: string[];
} {
  const notifyCalls: string[] = [];
  const host: ToolHost = {
    resolveSessionId: () => TEST_SESSION_ID,
    async notify(): Promise<void> {
      notifyCalls.push("notify");
    },
  };
  if (options.history !== undefined) {
    const messages = options.history;
    host.fetchHistory = async (): Promise<Projection> => {
      options.calls?.push(1);
      return project(messages, []);
    };
  }
  return { host, notifyCalls };
}

describe("compress tool execute — history source", () => {
  it("uses the published round view and never reads the host history", async () => {
    // A view is published for this round; the host read would answer with
    // an EMPTY transcript, so a host read would fail every ref — the
    // counter proves the tool never asked.
    publishViewOf(makeMessages());
    const calls: number[] = [];
    const { host, notifyCalls } = sourceHost({ history: [], calls });

    const tool = createCompressTool(host, PARSED_CONFIG);
    const result = await tool.execute(
      { ranges: [makeRange(1, 9)] },
      mockToolContext,
    );

    assert.equal(
      calls.length,
      0,
      "the cached round view must not re-read the host",
    );
    assert.equal(getContextStateManager().get(TEST_SESSION_ID).blocks.size, 1);
    assert.equal(consumePendingViewChange(TEST_SESSION_ID), true);
    assert.equal(notifyCalls.length, 1);
    assert.ok(result.includes("已压缩"));
  });

  it("falls back to the host history read when no round view exists", async () => {
    assert.deepEqual(_listRoundViewSessionsForTesting(), []);
    const calls: number[] = [];
    const { host } = sourceHost({ history: makeMessages(), calls });

    const tool = createCompressTool(host, PARSED_CONFIG);
    const result = await tool.execute(
      { ranges: [makeRange(1, 9)] },
      mockToolContext,
    );

    assert.equal(calls.length, 1, "the fallback read runs once");
    assert.equal(getContextStateManager().get(TEST_SESSION_ID).blocks.size, 1);
    assert.ok(result.includes("已压缩"));
  });

  it("fails closed with guidance when neither a view nor a fallback exists", async () => {
    const { host, notifyCalls } = sourceHost({});

    const tool = createCompressTool(host, PARSED_CONFIG);
    // An unaddressable view is not a model-recoverable condition: the
    // failure is thrown (never returned as a success-shaped string) and
    // says that repeating the call in this round changes nothing.
    await assert.rejects(
      () => tool.execute({ ranges: [makeRange(1, 9)] }, mockToolContext),
      (err: unknown) =>
        err instanceof Error &&
        /无法压缩/.test(err.message) &&
        /当轮上下文视图/.test(err.message) &&
        /本轮内重试结果相同/.test(err.message),
    );
    assert.equal(
      getContextStateManager().get(TEST_SESSION_ID).blocks.size,
      0,
      "state untouched — nothing was compressed",
    );
    assert.equal(
      consumePendingViewChange(TEST_SESSION_ID),
      false,
      "no view change armed by a refused call",
    );
    assert.deepEqual(notifyCalls, [], "no notification for a refused call");
    assert.equal(
      sessionState().nudges?.pendingReclaimTokens,
      undefined,
      "a refused call books no reclaim credit",
    );
  });
});

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe("compress tool execute — happy path", () => {
  it("creates a block for a single range, flags the view change, persists, and notifies", async () => {
    const messages = makeMessages();
    const { host, notifyCalls } = fakeHost(messages);

    const tool = createCompressTool(host, PARSED_CONFIG);

    const result = await tool.execute(
      { ranges: [makeRange(1, 9)] },
      mockToolContext,
    );

    // (1) Block created in the shared session state.
    const block = firstBlock();
    assert.equal(block.status, "active");
    assert.equal(block.title, "执行命令主题");
    assert.equal(block.end - block.start, 9, "range [1, 10) covers 9 ordinals");

    // (2) Pending view change flagged (transient, consumed by the hook).
    assert.equal(consumePendingViewChange(TEST_SESSION_ID), true);
    assert.equal(
      consumePendingViewChange(TEST_SESSION_ID),
      false,
      "flag is consumed and cleared",
    );

    // (2b) The reclaim is booked against the water level, so the pressure
    // the nudge measures drops with the view instead of waiting for the
    // next API measurement of it.
    assert.equal(
      sessionState().nudges?.pendingReclaimTokens,
      block.compressedTokens - block.summaryTokens,
      "booked reclaim equals what the block frees",
    );
    assert.ok(
      (sessionState().nudges?.pendingReclaimTokens ?? 0) > 0,
      "a landed compression books something",
    );

    // (3) State persisted to disk via the shared manager.
    const persisted = getContextStateManager().store.load(TEST_SESSION_ID);
    assert.equal(persisted.blocks.size, 1);
    assert.equal(persisted.blocks.get(1)?.status, "active");
    assert.equal(persisted.blocks.get(1)?.title, "执行命令主题");

    // (4) Ignored notification sent.
    assert.equal(notifyCalls.length, 1);
    assert.equal(notifyCalls[0].sessionID, TEST_SESSION_ID);
    assert.ok(
      notifyCalls[0].text.includes("上下文压缩："),
      `expected "上下文压缩：" prefix in prompt, got: ${notifyCalls[0].text}`,
    );
    assert.ok(
      notifyCalls[0].text.includes("已压缩"),
      `expected "已压缩" in prompt, got: ${notifyCalls[0].text}`,
    );
    assert.ok(
      notifyCalls[0].text.includes("b1"),
      `expected block id in prompt, got: ${notifyCalls[0].text}`,
    );
    assert.ok(
      notifyCalls[0].text.includes("执行命令主题"),
      `expected title in prompt, got: ${notifyCalls[0].text}`,
    );

    // ToolResult: single-line short text without the summary body.
    assert.equal(typeof result, "string");
    assert.ok(!result.includes("\n"), "ToolResult must be a single line");
    assert.ok(
      !result.includes("用户请求执行命令"),
      "ToolResult must not include the summary body",
    );
    assert.ok(result.includes("已压缩"), "ToolResult should mention 已压缩");
    assert.ok(
      result.includes("上下文压缩："),
      "ToolResult should carry the 上下文压缩 prefix",
    );
    assert.ok(result.includes("b1"), "ToolResult should include the block id");
    assert.ok(
      result.includes("执行命令主题"),
      "ToolResult should include the title",
    );
  });

  it("creates N blocks for N ranges in one call — single persist, single notify", async () => {
    const messages = makeMessages();
    const { host, notifyCalls } = fakeHost(messages);

    const tool = createCompressTool(host, PARSED_CONFIG);

    const result = await tool.execute(
      {
        ranges: [makeRange(1, 5, "主题一"), makeRange(6, 9, "主题二")],
      },
      mockToolContext,
    );

    // (1) Two blocks created in order.
    const state = sessionState();
    assert.equal(state.blocks.size, 2);
    assert.equal(state.blocks.get(1)?.title, "主题一");
    assert.equal(
      (state.blocks.get(1)?.end ?? 0) - (state.blocks.get(1)?.start ?? 0),
      5,
    );
    assert.equal(state.blocks.get(2)?.title, "主题二");
    assert.equal(
      (state.blocks.get(2)?.end ?? 0) - (state.blocks.get(2)?.start ?? 0),
      4,
    );
    assert.equal(consumePendingViewChange(TEST_SESSION_ID), true);

    // (2) Persisted exactly once (both blocks on disk).
    const persisted = getContextStateManager().store.load(TEST_SESSION_ID);
    assert.equal(persisted.blocks.size, 2);
    assert.equal(persisted.blocks.get(2)?.status, "active");

    // (3) ONE ignored notification covering both blocks.
    assert.equal(notifyCalls.length, 1, "single notification for the batch");
    assert.ok(notifyCalls[0].text.includes("已压缩 2 个范围"));
    assert.ok(notifyCalls[0].text.includes("b1、b2"));

    // ToolResult: single-line, mentions both blocks, no summary body.
    assert.equal(typeof result, "string");
    assert.ok(!result.includes("\n"));
    assert.ok(result.includes("已压缩 2 个范围"));
    assert.ok(result.includes("b1、b2"));
    assert.ok(!result.includes("用户请求执行命令"));
  });

  it("accepts a sessionId-shaped tool context (defensive)", async () => {
    const messages = makeMessages();
    const { host } = fakeHost(messages);
    const tool = createCompressTool(host, PARSED_CONFIG);

    const result = await tool.execute(
      { ranges: [makeRange(1, 9)] },
      { ...mockToolContext, sessionID: undefined, sessionId: TEST_SESSION_ID },
    );

    const state = sessionState();
    assert.equal(state.blocks.size, 1);
    assert.equal(typeof result, "string");
    assert.ok(result.includes("已压缩"));
    assert.ok(
      result.includes("上下文压缩："),
      "ToolResult should carry the 上下文压缩 prefix",
    );
  });

  it("accepts a title of exactly 80 characters", async () => {
    const messages = makeMessages();
    const { host } = fakeHost(messages);
    const tool = createCompressTool(host, PARSED_CONFIG);

    const title = "超".repeat(80);
    const result = await tool.execute(
      { ranges: [makeRange(1, 9, title)] },
      mockToolContext,
    );

    const state = sessionState();
    assert.equal(state.blocks.size, 1, "exactly one block expected");
    assert.equal(state.blocks.get(1)?.title, title);
    assert.equal(typeof result, "string");
    assert.ok(result.includes(title), "ToolResult should include the title");
  });
});

// ---------------------------------------------------------------------------
// Protection gates (core)
// ---------------------------------------------------------------------------

describe("compress tool execute — protection gates", () => {
  it("rejects a range containing the session's first user message", async () => {
    const messages = makeMessages();
    const { host } = fakeHost(messages);
    const tool = createCompressTool(host, PARSED_CONFIG);

    await assert.rejects(
      () => tool.execute({ ranges: [makeRange(0, 5)] }, mockToolContext),
      (err: unknown) =>
        err instanceof Error && /第一条用户消息/.test(err.message),
    );
    const state = sessionState();
    assert.equal(state.blocks.size, 0);
  });
});

// ---------------------------------------------------------------------------
// Error paths
// ---------------------------------------------------------------------------

describe("compress tool execute — error paths", () => {
  it("rejects more ranges than max_ranges with a loud batch-guidance error", async () => {
    const messages = makeMessages();
    const { host } = fakeHost(messages);
    const tool = createCompressTool(host, PARSED_CONFIG);

    // Real config.toml sets max_ranges = 8; 9 ranges must be rejected
    // BEFORE any ref resolution (refs are dummy on purpose).
    const ranges = Array.from({ length: 9 }, () => makeRange(1, 2));
    await assert.rejects(
      () => tool.execute({ ranges }, mockToolContext),
      (err: unknown) =>
        err instanceof Error &&
        /9/.test(err.message) &&
        /8/.test(err.message) &&
        /分批/.test(err.message),
    );

    // Nothing was created.
    const state = sessionState();
    assert.equal(state.blocks.size, 0);
  });

  it("rejects an empty ranges array", async () => {
    const messages = makeMessages();
    const { host } = fakeHost(messages);
    const tool = createCompressTool(host, PARSED_CONFIG);

    await assert.rejects(
      () => tool.execute({ ranges: [] }, mockToolContext),
      /不能为空/,
    );
    const state = sessionState();
    assert.equal(state.blocks.size, 0);
  });

  it("rejects a missing or non-array ranges argument", async () => {
    const messages = makeMessages();
    const { host } = fakeHost(messages);
    const tool = createCompressTool(host, PARSED_CONFIG);

    await assert.rejects(() => tool.execute({}, mockToolContext), /ranges/);
    await assert.rejects(
      () => tool.execute({ ranges: "m1" }, mockToolContext),
      /ranges/,
    );
    await assert.rejects(() => tool.execute(null, mockToolContext), /ranges/);
    const state = sessionState();
    assert.equal(state.blocks.size, 0);
  });

  it("propagates the unknown-ref guidance error naming the range index", async () => {
    const messages = makeMessages();
    const { host } = fakeHost(messages);
    const tool = createCompressTool(host, PARSED_CONFIG);

    await assert.rejects(
      () =>
        tool.execute(
          {
            ranges: [makeRange(1, 6), { ...makeRange(6, 9), fromRef: "m9999" }],
          },
          mockToolContext,
        ),
      (err: unknown) =>
        err instanceof Error &&
        /第 2 个范围/.test(err.message) &&
        /不存在/.test(err.message),
    );
  });

  it("propagates the reversed-order guidance error naming the range index", async () => {
    const messages = makeMessages();
    const { host } = fakeHost(messages);
    const tool = createCompressTool(host, PARSED_CONFIG);

    await assert.rejects(
      () =>
        tool.execute(
          {
            ranges: [
              makeRange(1, 6),
              {
                fromRef: refFor(9),
                toRef: refFor(1),
                title: "主题",
                summary: "摘要",
              },
            ],
          },
          mockToolContext,
        ),
      (err: unknown) =>
        err instanceof Error &&
        /第 2 个范围/.test(err.message) &&
        /顺序颠倒/.test(err.message),
    );
  });

  it("rejects overlapping ranges naming both indices", async () => {
    const messages = makeMessages();
    const { host } = fakeHost(messages);
    const tool = createCompressTool(host, PARSED_CONFIG);

    await assert.rejects(
      () =>
        tool.execute(
          { ranges: [makeRange(1, 6), makeRange(4, 9)] },
          mockToolContext,
        ),
      (err: unknown) =>
        err instanceof Error &&
        /第 2 个范围/.test(err.message) &&
        /第 1 个范围/.test(err.message) &&
        /重叠/.test(err.message),
    );
    const state = sessionState();
    assert.equal(state.blocks.size, 0);
  });

  it("rejects an empty title in a specific range naming that range", async () => {
    const messages = makeMessages();
    const { host } = fakeHost(messages);
    const tool = createCompressTool(host, PARSED_CONFIG);

    await assert.rejects(
      () =>
        tool.execute(
          {
            ranges: [makeRange(1, 6), makeRange(6, 9, "   ")],
          },
          mockToolContext,
        ),
      (err: unknown) =>
        err instanceof Error &&
        /第 2 个范围/.test(err.message) &&
        /不能为空/.test(err.message) &&
        /80/.test(err.message),
    );
    // Nothing was created.
    const state = sessionState();
    assert.equal(state.blocks.size, 0);
  });

  it("rejects a title longer than 80 characters with a loud Chinese guidance error", async () => {
    const messages = makeMessages();
    const { host } = fakeHost(messages);
    const tool = createCompressTool(host, PARSED_CONFIG);

    const longTitle = "超".repeat(81);
    await assert.rejects(
      () =>
        tool.execute({ ranges: [makeRange(1, 9, longTitle)] }, mockToolContext),
      (err: unknown) =>
        err instanceof Error &&
        /过长/.test(err.message) &&
        /80/.test(err.message),
    );
    const state = sessionState();
    assert.equal(state.blocks.size, 0);
  });

  it("rejects titles containing newlines or control characters with a loud single-line guidance error", async () => {
    const messages = makeMessages();
    const { host } = fakeHost(messages);
    const tool = createCompressTool(host, PARSED_CONFIG);

    const badTitles = [
      "foo\nbar",
      "foo\rbar",
      "foo\x07bar",
      "foo\x85bar",
      "foo\x9fbar",
    ];
    for (const title of badTitles) {
      await assert.rejects(
        () =>
          tool.execute({ ranges: [makeRange(1, 9, title)] }, mockToolContext),
        (err: unknown) =>
          err instanceof Error &&
          /单行/.test(err.message) &&
          /控制字符/.test(err.message),
      );
      // Nothing was created for any rejected title.
      const state = sessionState();
      assert.equal(state.blocks.size, 0);
    }
  });

  it("rejects titles containing three or more consecutive hyphens with a loud Chinese guidance error", async () => {
    const messages = makeMessages();
    const { host } = fakeHost(messages);
    const tool = createCompressTool(host, PARSED_CONFIG);

    const badTitles = ["foo---bar", "----", "a--b---c--d"];
    for (const title of badTitles) {
      await assert.rejects(
        () =>
          tool.execute({ ranges: [makeRange(1, 9, title)] }, mockToolContext),
        (err: unknown) =>
          err instanceof Error &&
          /连字符/.test(err.message) &&
          /---/.test(err.message),
      );
      // Nothing was created for any rejected title.
      const state = sessionState();
      assert.equal(state.blocks.size, 0);
    }
  });

  it("rejects non-string fields inside a range item before core validation", async () => {
    const messages = makeMessages();
    const { host } = fakeHost(messages);
    const tool = createCompressTool(host, PARSED_CONFIG);
    const cases: Array<{ name: string; item: Record<string, unknown> }> = [
      {
        name: "fromRef",
        item: { fromRef: 1, toRef: refFor(9), title: "主题", summary: "摘要" },
      },
      {
        name: "toRef",
        item: {
          fromRef: refFor(1),
          toRef: null,
          title: "主题",
          summary: "摘要",
        },
      },
      {
        name: "title",
        item: {
          fromRef: refFor(1),
          toRef: refFor(9),
          title: { text: "主题" },
          summary: "摘要",
        },
      },
      {
        name: "summary",
        item: {
          fromRef: refFor(1),
          toRef: refFor(9),
          title: "主题",
          summary: false,
        },
      },
    ];

    for (const item of cases) {
      await assert.rejects(
        () => tool.execute({ ranges: [item.item] }, mockToolContext),
        (err: unknown) =>
          err instanceof Error &&
          err.message.includes(item.name) &&
          /字符串/.test(err.message),
      );
      const state = sessionState();
      assert.equal(state.blocks.size, 0);
    }
  });

  it("rejects a non-object range item naming the range index", async () => {
    const messages = makeMessages();
    const { host } = fakeHost(messages);
    const tool = createCompressTool(host, PARSED_CONFIG);

    await assert.rejects(
      () => tool.execute({ ranges: ["m1"] }, mockToolContext),
      (err: unknown) =>
        err instanceof Error &&
        /第 1 个范围/.test(err.message) &&
        /格式错误/.test(err.message),
    );
    const state = sessionState();
    assert.equal(state.blocks.size, 0);
  });

  it("throws a loud error when the tool context lacks a session id", async () => {
    const messages = makeMessages();
    const { host } = fakeHost(messages);
    const tool = createCompressTool(host, PARSED_CONFIG);

    await assert.rejects(
      () =>
        tool.execute(
          { ranges: [makeRange(1, 9)] },
          { ...mockToolContext, sessionID: undefined, sessionId: undefined },
        ),
      /sessionID/,
    );
  });

  it("throws a loud config error when the compress section parsed without thresholds (defensive)", async () => {
    // Registration is profile-gated, so this config shape is reachable in
    // production when [zoo.context.compress] is missing — the check guides
    // the model to fix config.toml.
    const hooks = buildToolHooks(
      {},
      { dedup: {}, purgeErrors: {}, compress: {} },
      ["compress"],
    );
    assert.ok(hooks?.compress);

    await assert.rejects(
      () =>
        hooks.compress.execute({ ranges: [makeRange(1, 9)] }, mockToolContext),
      /\[zoo\.context\.compress\] 段缺失或非法/,
    );
  });

  it("throws a loud config error when protected_messages is missing (defensive)", async () => {
    const hooks = buildToolHooks(
      {},
      {
        dedup: {},
        purgeErrors: {},
        compress: {
          thresholdTokens: 2000,
          protectedTokens: 20000,
          maxRanges: 8,
        },
      },
      ["compress"],
    );
    assert.ok(hooks?.compress);

    await assert.rejects(
      () =>
        hooks.compress.execute({ ranges: [makeRange(1, 9)] }, mockToolContext),
      /protected_messages/,
    );
  });

  it("still returns the result when the ignored notification fails (best-effort)", async () => {
    const messages = makeMessages();
    const notifyErrorHost: ToolHost = {
      ...fakeHost(messages).host,
      notify: async () => {
        throw new Error("notify rejected");
      },
    };
    const tool = createCompressTool(notifyErrorHost, PARSED_CONFIG);

    const result = await tool.execute(
      { ranges: [makeRange(1, 9)] },
      mockToolContext,
    );

    // Compression still succeeded and returned a ToolResult.
    const state = sessionState();
    assert.equal(state.blocks.size, 1);
    assert.ok(result.includes("已压缩"));
  });
});

// ---------------------------------------------------------------------------
// Registration gate (profile tools list)
// ---------------------------------------------------------------------------

describe("compress tool registration gate", () => {
  it("compress absent from the profile tools list → no compress tool", () => {
    const { client } = mockClient([]);
    const hooks = buildToolHooks(client, { dedup: {}, purgeErrors: {} }, []);
    assert.equal(hooks, undefined);
  });

  it("decompress only in the list → compress stays unregistered", () => {
    const { client } = mockClient([]);
    const hooks = buildToolHooks(client, { dedup: {}, purgeErrors: {} }, [
      "decompress",
    ]);
    assert.ok(hooks !== undefined, "decompress tool registers");
    assert.equal(hooks.compress, undefined);
  });

  it("compress absent from the profile tools list → primary_tools untouched", () => {
    const config = { experimental: { primary_tools: ["bash"] } };
    registerProfileToolsInConfig(config, []);
    assert.deepEqual(config.experimental.primary_tools, ["bash"]);
  });

  it("decompress only in the list → primary_tools gets no compress", () => {
    const config = { experimental: { primary_tools: ["bash"] } };
    registerProfileToolsInConfig(config, ["decompress"]);
    assert.deepEqual(config.experimental.primary_tools, ["bash", "decompress"]);
  });

  it("compress in the profile tools list → registered with an executable", () => {
    const { client } = mockClient([]);
    const hooks = buildToolHooks(client, { dedup: {}, purgeErrors: {} }, [
      "compress",
    ]);
    assert.ok(hooks !== undefined);
    assert.ok(hooks.compress);
    assert.equal(typeof hooks.compress.execute, "function");
  });

  it("registers the ranges-array JSON Schema for OpenCode native tool loading", () => {
    const { client } = mockClient([]);
    const hooks = buildToolHooks(client, { dedup: {}, purgeErrors: {} }, [
      "compress",
    ]);

    assert.ok(hooks?.compress);
    const compressArgs = (hooks.compress as unknown as CompressToolDefinition)
      .args;
    assert.ok(compressArgs.ranges, "ranges arg must be present");
    assert.equal(compressArgs.ranges.type, "array");
    assert.equal(compressArgs.ranges.items.type, "object");
    assert.deepEqual(compressArgs.ranges.items.required, [
      "fromRef",
      "toRef",
      "title",
      "summary",
    ]);
    for (const field of ["fromRef", "toRef", "title", "summary"] as const) {
      assert.equal(compressArgs.ranges.items.properties[field].type, "string");
    }
  });

  it("carries the batch compress contract across description and args", () => {
    const { client } = mockClient([]);
    const hooks = buildToolHooks(client, { dedup: {}, purgeErrors: {} }, [
      "compress",
    ]);

    assert.ok(hooks?.compress);
    const tool = hooks.compress as unknown as CompressToolDefinition;
    assert.ok(
      tool.description.includes("不再需要逐字保留"),
      "description must state that verbatim retention is unnecessary for the compressed ranges",
    );
    assert.ok(
      tool.description.includes("独立的主题"),
      "description must require each range to be an independent topic",
    );
    assert.ok(
      tool.description.includes("压缩范围不能有重叠"),
      "description must forbid overlapping ranges",
    );
    assert.ok(
      tool.description.includes("端点使用当轮视图的行号") &&
        tool.description.includes("两端都包含"),
      "description must state the ref address space and that both endpoints are inclusive",
    );
    assert.ok(
      tool.description.includes("行号仅对当轮有效"),
      "description must state that line refs are round-scoped",
    );
    assert.ok(
      tool.description.includes("引用压缩块摘要行会把整个块纳入范围"),
      "description must state that a summary-line ref pulls in the whole block",
    );
    assert.ok(
      tool.args.ranges.description.includes("{fromRef, toRef, title, summary}"),
      "ranges arg must state the per-item fields",
    );
    assert.ok(
      tool.args.ranges.description.includes("整批不生效") &&
        tool.args.ranges.description.includes("全部失败范围"),
      "ranges arg must state batch atomicity and that all failures are listed",
    );
    assert.ok(
      tool.args.ranges.items.description.includes("一段连续的历史消息"),
      "items arg must describe a contiguous run of history",
    );
    assert.ok(
      tool.args.ranges.items.properties.fromRef.description.includes(
        "起点行号",
      ),
      "fromRef arg must point at the starting line number",
    );
    assert.ok(
      tool.args.ranges.items.properties.fromRef.description.includes(
        "该消息及其之后的内容会被压缩",
      ),
      "fromRef arg must state that the message and everything after it gets compressed",
    );
    assert.ok(
      tool.args.ranges.items.properties.toRef.description.includes("终点行号"),
      "toRef arg must point at the ending line number",
    );
    assert.ok(
      tool.args.ranges.items.properties.toRef.description.includes(
        "该消息及其之前的内容会被压缩",
      ),
      "toRef arg must state that the message and everything before it gets compressed",
    );
    assert.ok(
      tool.args.ranges.items.properties.title.description.includes(
        "不超过 80 字符的单行",
      ),
      "title arg must state the single-line 80-character limit",
    );
    assert.ok(
      tool.args.ranges.items.properties.summary.description.includes(
        "替换压缩范围内的原文",
      ),
      "summary arg must state the original-text replacement role",
    );
  });
});

// ---------------------------------------------------------------------------
// Config hook — primary_tools
// ---------------------------------------------------------------------------

describe("config hook — primary_tools", () => {
  it("appends compress + decompress preserving pre-existing entries", async () => {
    const plugin = (await makePlugin()) as any;
    const config = { experimental: { primary_tools: ["bash", "edit"] } };

    await plugin.config(config);

    assert.deepEqual(config.experimental.primary_tools, [
      "bash",
      "edit",
      "compress",
      "decompress",
    ]);
  });

  it("creates experimental.primary_tools when absent", async () => {
    const plugin = (await makePlugin()) as any;
    const config: Record<string, any> = {};

    await plugin.config(config);

    assert.deepEqual(config.experimental?.primary_tools, [
      "compress",
      "decompress",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Unsupported host
// ---------------------------------------------------------------------------

describe("compress tool unsupported host", () => {
  it("throws a single-line Chinese tool error when the host has no tool services", async () => {
    const tool = compressUnit.create(
      {
        limits: {},
        contextConfig: PARSED_CONFIG,
        client: {},
        directory: "",
        resolveAgent: () => undefined,
        toolHost: undefined,
      },
      {} as any,
    ).tools[0];

    // An unself-healable wiring fault is a real tool failure, never a
    // success-shaped returned string.
    await assert.rejects(
      () => tool.execute({ ranges: [makeRange(1, 9)] }, mockToolContext),
      (err: unknown) =>
        err instanceof Error &&
        !err.message.includes("\n") &&
        /在当前宿主上不可用/.test(err.message) &&
        /重试本工具无法解决/.test(err.message),
    );
  });
});
