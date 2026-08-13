/**
 * Integration tests for the batch compress tool adapter.
 *
 * Covers: the full execute flow (fetch → ref fallback → core → persist →
 * notify → ToolResult) against the real imported config with the `ranges`
 * array parameter, multi-range batch creation with a single persistence and
 * a single notification, the `max_ranges` overflow gate (loud batch
 * guidance), per-range validation errors naming the range index, the
 * profile-tools registration gate (tool hooks + primary_tools), and
 * the config-hook primary_tools append preserving existing entries.
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { SessionClient } from "../core/client/session.js";
import type { ContextMessageEntry } from "../core/context/metrics.js";
import {
  _clearAllSessionsForTesting,
  deleteSessionState,
  getOrCreateSessionState,
  loadSessionState,
} from "../core/context/pruning/marks.js";
import {
  _clearAllRefsForTesting,
  getMessageRefById,
} from "../core/context/pruning/message-refs.js";
import { COMPRESS_GUIDANCE } from "../core/prompts.js";
import {
  buildPlugin,
  buildToolHooks,
  registerProfileToolsInConfig,
} from "../opencode.js";
import { _resetForTesting } from "../utils/logger.js";
import type { CompressToolDefinition } from "./compress.js";

// ---------------------------------------------------------------------------
// Session ids & teardown
// ---------------------------------------------------------------------------

const TEST_SESSION_ID = "sess-compress-tool";
const PERSISTED_SESSION_IDS = [TEST_SESSION_ID];

afterEach(() => {
  _resetForTesting();
  _clearAllSessionsForTesting();
  _clearAllRefsForTesting();
  for (const sid of PERSISTED_SESSION_IDS) {
    deleteSessionState(sid);
  }
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

/** Ref string for a zero-based message-array index (m0001 = index 0). */
function refFor(index: number): string {
  return `m${String(index + 1).padStart(4, "0")}`;
}

/** Long tool output (~2000 heuristic tokens) so the protection gates pass. */
const LONG_OUTPUT = "x".repeat(8000);

function makeUserMsg(id: string, text: string): ContextMessageEntry {
  return {
    info: { role: "user", id } as ContextMessageEntry["info"],
    parts: [{ type: "text", text }] as ContextMessageEntry["parts"],
  };
}

function makeAssistantMsg(id: string, text: string): ContextMessageEntry {
  return {
    info: { role: "assistant", id } as ContextMessageEntry["info"],
    parts: [{ type: "text", text }] as ContextMessageEntry["parts"],
  };
}

function makeToolMsg(id: string): ContextMessageEntry {
  return {
    info: { role: "assistant", id } as ContextMessageEntry["info"],
    parts: [
      {
        type: "tool",
        callID: `c-${id}`,
        tool: "bash",
        state: { input: { cmd: "x" }, output: LONG_OUTPUT },
      },
    ] as unknown as ContextMessageEntry["parts"],
  };
}

/**
 * A 31-message conversation heavy enough to pass the real config gates
 * (protectedMessages=20, protectedTokens=20000, thresholdTokens=2000).
 *
 * Indices: u0 (first user) + 28 tool-heavy exchanges + last user + final
 * assistant.  The protection boundary lands at index 11, so valid ranges
 * live inside [1, 11).  Range [1, 6) covers 5 tool messages (~10000 tokens)
 * and range [6, 10) covers 4 more — both comfortably over the threshold.
 */
function makeMessages(): ContextMessageEntry[] {
  const msgs: ContextMessageEntry[] = [makeUserMsg("u0", "开场问题")];
  for (let i = 1; i <= 28; i++) {
    msgs.push(makeToolMsg(`a${i}`));
  }
  msgs.push(makeUserMsg("u29", "最后一个问题"));
  msgs.push(makeAssistantMsg("a30", "回答完毕"));
  return msgs;
}

/** A single valid range on `makeMessages()` output. */
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

/** Mock client that returns the given messages and captures prompt calls. */
function mockClient(messages: ContextMessageEntry[]): {
  client: SessionClient;
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

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe("compress tool execute — happy path", () => {
  it("creates a block for a single range, persists state, and sends an ignored notification", async () => {
    const messages = makeMessages();
    const { client, promptCalls } = mockClient(messages);

    const plugin = (await makePlugin(client)) as any;
    assert.ok(
      plugin.tool,
      "tool hooks must be registered (compress in profile tools)",
    );
    assert.ok(plugin.tool.compress, "compress tool must be registered");

    const result = await plugin.tool.compress.execute(
      { ranges: [makeRange(1, 9)] },
      mockToolContext,
    );

    // (1) Block created in session state.
    const state = getOrCreateSessionState(TEST_SESSION_ID);
    assert.equal(state.blocks.size, 1, "exactly one block expected");
    const block = state.blocks.get("1");
    assert.ok(block !== undefined);
    assert.equal(block.active, true);
    assert.equal(block.blockId, 1);
    assert.equal(block.title, "执行命令主题");
    assert.equal(block.messageIds.length, 8);
    assert.equal(state.pendingViewChange, true);

    // (2) State persisted to disk via saveSessionState.
    const persisted = loadSessionState(TEST_SESSION_ID);
    assert.ok(persisted !== null, "state must be persisted to disk");
    assert.equal(persisted.blocks.size, 1);
    assert.equal(persisted.blocks.get("1")?.active, true);
    assert.equal(persisted.blocks.get("1")?.title, "执行命令主题");

    // (3) Ignored notification sent.
    assert.equal(promptCalls.length, 1);
    assert.equal(promptCalls[0].sessionID, TEST_SESSION_ID);
    assert.equal(promptCalls[0].noReply, true);
    assert.equal(promptCalls[0].ignored, true);
    assert.ok(
      promptCalls[0].text.includes("上下文压缩："),
      `expected "上下文压缩：" prefix in prompt, got: ${promptCalls[0].text}`,
    );
    assert.ok(
      promptCalls[0].text.includes("已压缩"),
      `expected "已压缩" in prompt, got: ${promptCalls[0].text}`,
    );
    assert.ok(
      promptCalls[0].text.includes("b1"),
      `expected block id in prompt, got: ${promptCalls[0].text}`,
    );
    assert.ok(
      promptCalls[0].text.includes("执行命令主题"),
      `expected title in prompt, got: ${promptCalls[0].text}`,
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
    const { client, promptCalls } = mockClient(messages);

    const plugin = (await makePlugin(client)) as any;

    const result = await plugin.tool.compress.execute(
      { ranges: [makeRange(1, 6, "主题一"), makeRange(6, 10, "主题二")] },
      mockToolContext,
    );

    // (1) Two blocks created in order.
    const state = getOrCreateSessionState(TEST_SESSION_ID);
    assert.equal(state.blocks.size, 2);
    assert.equal(state.blocks.get("1")?.title, "主题一");
    assert.equal(state.blocks.get("1")?.messageIds.length, 5);
    assert.equal(state.blocks.get("2")?.title, "主题二");
    assert.equal(state.blocks.get("2")?.messageIds.length, 4);
    assert.equal(state.pendingViewChange, true);

    // (2) Persisted exactly once (both blocks on disk).
    const persisted = loadSessionState(TEST_SESSION_ID);
    assert.ok(persisted !== null);
    assert.equal(persisted.blocks.size, 2);
    assert.equal(persisted.blocks.get("2")?.active, true);

    // (3) ONE ignored notification covering both blocks.
    assert.equal(promptCalls.length, 1, "single notification for the batch");
    assert.ok(promptCalls[0].text.includes("已压缩 2 个范围"));
    assert.ok(promptCalls[0].text.includes("b1、b2"));

    // ToolResult: single-line, mentions both blocks, no summary body.
    assert.equal(typeof result, "string");
    assert.ok(!result.includes("\n"));
    assert.ok(result.includes("已压缩 2 个范围"));
    assert.ok(result.includes("b1、b2"));
    assert.ok(!result.includes("用户请求执行命令"));
  });

  it("accepts a sessionId-shaped tool context (defensive)", async () => {
    const messages = makeMessages();
    const { client } = mockClient(messages);
    const plugin = (await makePlugin(client)) as any;

    const result = await plugin.tool.compress.execute(
      { ranges: [makeRange(1, 9)] },
      { ...mockToolContext, sessionID: undefined, sessionId: TEST_SESSION_ID },
    );

    const state = getOrCreateSessionState(TEST_SESSION_ID);
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
    const { client } = mockClient(messages);
    const plugin = (await makePlugin(client)) as any;

    const title = "超".repeat(80);
    const result = await plugin.tool.compress.execute(
      { ranges: [makeRange(1, 9, title)] },
      mockToolContext,
    );

    const state = getOrCreateSessionState(TEST_SESSION_ID);
    assert.equal(state.blocks.size, 1, "exactly one block expected");
    assert.equal(state.blocks.get("1")?.title, title);
    assert.equal(typeof result, "string");
    assert.ok(result.includes(title), "ToolResult should include the title");
  });
});

// ---------------------------------------------------------------------------
// Anchor protection pass-through
// ---------------------------------------------------------------------------

describe("compress tool execute — anchor protection pass-through", () => {
  it("keeps the first user message ref-less when anchor_tokens covers it", async () => {
    // anchor_tokens=10 protects u0 ("开场问题" = 4 CJK chars →
    // ceil(4/1.5) = 3 heuristic tokens ≤ 10).  Without the pass-through
    // the tool's assignMessageRefs re-entry would assign u0 a ref,
    // silently bypassing the transform-side anchor protection.
    const messages = makeMessages();
    const { client } = mockClient(messages);
    const anchoredZoo = {
      ...POLY_ZOO,
      context: {
        ...(POLY_ZOO.context as Record<string, unknown>),
        anchor_tokens: 10,
      },
    };
    const plugin = (await buildPlugin({ client }, anchoredZoo)) as any;

    const result = await plugin.tool.compress.execute(
      { ranges: [makeRange(1, 9)] },
      mockToolContext,
    );

    // Compression still succeeds; the anchor shifts refs by one but the
    // range (m0002..m0010) still covers 8 messages.
    const state = getOrCreateSessionState(TEST_SESSION_ID);
    assert.equal(state.blocks.size, 1);
    assert.equal(state.blocks.get("1")?.messageIds.length, 8);
    assert.ok(result.includes("已压缩"));

    // The anchor survived the compress-tool re-entry: u0 has NO ref,
    // while a1 (the first compressible message) holds m0001.
    assert.equal(getMessageRefById(TEST_SESSION_ID, "u0"), undefined);
    assert.equal(getMessageRefById(TEST_SESSION_ID, "a1"), "m0001");
  });
});

// ---------------------------------------------------------------------------
// Error paths
// ---------------------------------------------------------------------------

describe("compress tool execute — error paths", () => {
  it("rejects more ranges than max_ranges with a loud batch-guidance error", async () => {
    const messages = makeMessages();
    const { client } = mockClient(messages);
    const plugin = (await makePlugin(client)) as any;

    // Real config.toml sets max_ranges = 8; 9 ranges must be rejected
    // BEFORE any core validation (refs are dummy on purpose).
    const ranges = Array.from({ length: 9 }, () => makeRange(1, 2));
    await assert.rejects(
      () => plugin.tool.compress.execute({ ranges }, mockToolContext),
      (err: unknown) =>
        err instanceof Error &&
        /9/.test(err.message) &&
        /8/.test(err.message) &&
        /分批/.test(err.message),
    );

    // Nothing was created.
    const state = getOrCreateSessionState(TEST_SESSION_ID);
    assert.equal(state.blocks.size, 0);
  });

  it("rejects an empty ranges array", async () => {
    const messages = makeMessages();
    const { client } = mockClient(messages);
    const plugin = (await makePlugin(client)) as any;

    await assert.rejects(
      () => plugin.tool.compress.execute({ ranges: [] }, mockToolContext),
      /不能为空/,
    );
    const state = getOrCreateSessionState(TEST_SESSION_ID);
    assert.equal(state.blocks.size, 0);
  });

  it("rejects a missing or non-array ranges argument", async () => {
    const messages = makeMessages();
    const { client } = mockClient(messages);
    const plugin = (await makePlugin(client)) as any;

    await assert.rejects(
      () => plugin.tool.compress.execute({}, mockToolContext),
      /ranges/,
    );
    await assert.rejects(
      () => plugin.tool.compress.execute({ ranges: "m0001" }, mockToolContext),
      /ranges/,
    );
    await assert.rejects(
      () => plugin.tool.compress.execute(null, mockToolContext),
      /ranges/,
    );
    const state = getOrCreateSessionState(TEST_SESSION_ID);
    assert.equal(state.blocks.size, 0);
  });

  it("propagates the unknown-ref guidance error naming the range index", async () => {
    const messages = makeMessages();
    const { client } = mockClient(messages);
    const plugin = (await makePlugin(client)) as any;

    await assert.rejects(
      () =>
        plugin.tool.compress.execute(
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
    const { client } = mockClient(messages);
    const plugin = (await makePlugin(client)) as any;

    await assert.rejects(
      () =>
        plugin.tool.compress.execute(
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
    const { client } = mockClient(messages);
    const plugin = (await makePlugin(client)) as any;

    await assert.rejects(
      () =>
        plugin.tool.compress.execute(
          { ranges: [makeRange(1, 6), makeRange(4, 9)] },
          mockToolContext,
        ),
      (err: unknown) =>
        err instanceof Error &&
        /第 2 个范围/.test(err.message) &&
        /第 1 个范围/.test(err.message) &&
        /重叠/.test(err.message),
    );
    const state = getOrCreateSessionState(TEST_SESSION_ID);
    assert.equal(state.blocks.size, 0);
  });

  it("rejects an empty title in a specific range naming that range", async () => {
    const messages = makeMessages();
    const { client } = mockClient(messages);
    const plugin = (await makePlugin(client)) as any;

    await assert.rejects(
      () =>
        plugin.tool.compress.execute(
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
    const state = getOrCreateSessionState(TEST_SESSION_ID);
    assert.equal(state.blocks.size, 0);
  });

  it("rejects a title longer than 80 characters with a loud Chinese guidance error", async () => {
    const messages = makeMessages();
    const { client } = mockClient(messages);
    const plugin = (await makePlugin(client)) as any;

    const longTitle = "超".repeat(81);
    await assert.rejects(
      () =>
        plugin.tool.compress.execute(
          { ranges: [makeRange(1, 9, longTitle)] },
          mockToolContext,
        ),
      (err: unknown) =>
        err instanceof Error &&
        /过长/.test(err.message) &&
        /80/.test(err.message),
    );
    const state = getOrCreateSessionState(TEST_SESSION_ID);
    assert.equal(state.blocks.size, 0);
  });

  it("rejects titles containing newlines or control characters with a loud single-line guidance error", async () => {
    const messages = makeMessages();
    const { client } = mockClient(messages);
    const plugin = (await makePlugin(client)) as any;

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
          plugin.tool.compress.execute(
            { ranges: [makeRange(1, 9, title)] },
            mockToolContext,
          ),
        (err: unknown) =>
          err instanceof Error &&
          /单行/.test(err.message) &&
          /控制字符/.test(err.message),
      );
      // Nothing was created for any rejected title.
      const state = getOrCreateSessionState(TEST_SESSION_ID);
      assert.equal(state.blocks.size, 0);
    }
  });

  it("rejects titles containing three or more consecutive hyphens with a loud Chinese guidance error", async () => {
    const messages = makeMessages();
    const { client } = mockClient(messages);
    const plugin = (await makePlugin(client)) as any;

    const badTitles = ["foo---bar", "----", "a--b---c--d"];
    for (const title of badTitles) {
      await assert.rejects(
        () =>
          plugin.tool.compress.execute(
            { ranges: [makeRange(1, 9, title)] },
            mockToolContext,
          ),
        (err: unknown) =>
          err instanceof Error &&
          /连字符/.test(err.message) &&
          /---/.test(err.message),
      );
      // Nothing was created for any rejected title.
      const state = getOrCreateSessionState(TEST_SESSION_ID);
      assert.equal(state.blocks.size, 0);
    }
  });

  it("rejects non-string fields inside a range item before core validation", async () => {
    const messages = makeMessages();
    const { client } = mockClient(messages);
    const plugin = (await makePlugin(client)) as any;
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
        () =>
          plugin.tool.compress.execute(
            { ranges: [item.item] },
            mockToolContext,
          ),
        (err: unknown) =>
          err instanceof Error &&
          err.message.includes(item.name) &&
          /字符串/.test(err.message),
      );
      const state = getOrCreateSessionState(TEST_SESSION_ID);
      assert.equal(state.blocks.size, 0);
    }
  });

  it("rejects a non-object range item naming the range index", async () => {
    const messages = makeMessages();
    const { client } = mockClient(messages);
    const plugin = (await makePlugin(client)) as any;

    await assert.rejects(
      () =>
        plugin.tool.compress.execute({ ranges: ["m0001"] }, mockToolContext),
      (err: unknown) =>
        err instanceof Error &&
        /第 1 个范围/.test(err.message) &&
        /格式错误/.test(err.message),
    );
    const state = getOrCreateSessionState(TEST_SESSION_ID);
    assert.equal(state.blocks.size, 0);
  });

  it("throws a loud error when the tool context lacks a session id", async () => {
    const messages = makeMessages();
    const { client } = mockClient(messages);
    const plugin = (await makePlugin(client)) as any;

    await assert.rejects(
      () =>
        plugin.tool.compress.execute(
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
    const { client } = mockClient(makeMessages());
    const hooks = buildToolHooks(
      client,
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
    const { client } = mockClient(makeMessages());
    const hooks = buildToolHooks(
      client,
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
    const { client } = mockClient(messages);
    // Make the prompt call reject — the notify failure must be swallowed.
    const failingClient = {
      session: {
        ...client.session,
        prompt: async () => {
          throw new Error("prompt rejected");
        },
      },
    };
    const plugin = (await makePlugin(failingClient)) as any;

    const result = await plugin.tool.compress.execute(
      { ranges: [makeRange(1, 9)] },
      mockToolContext,
    );

    // Compression still succeeded and returned a ToolResult.
    const state = getOrCreateSessionState(TEST_SESSION_ID);
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

  it("injects the teaching skeleton into the tool description", () => {
    const { client } = mockClient([]);
    const hooks = buildToolHooks(client, { dedup: {}, purgeErrors: {} }, [
      "compress",
    ]);

    assert.ok(hooks?.compress);
    const description = (hooks.compress as unknown as CompressToolDefinition)
      .description;
    assert.ok(
      description.includes(COMPRESS_GUIDANCE),
      "description must carry the full teaching skeleton (all four points)",
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
