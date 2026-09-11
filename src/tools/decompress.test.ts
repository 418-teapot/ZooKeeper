/**
 * Integration tests for the decompress tool adapter.
 *
 * Covers: the restore flow (block active → consumed, pending
 * view-change flag, persist, notify, single-line ToolResult), the recall
 * flow (summary body framed as a read-only recall, zero state change, no
 * notification, RECALL_MAX_CHARS truncation with the Chinese tail note),
 * the context-limit gate rejection (state untouched), the not-found error
 * listing the available block numbers, the loud config-guidance error
 * when the `[zoo.context.decompress]` section is absent, the
 * history-source rule (restore measures the published round view, host
 * read only as a fallback, guidance error when neither exists), and the
 * registration gate (absent section → no tool key, primary_tools
 * untouched).
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { ToolHost } from "../core/client/tool-host.js";
import { parseContextConfig } from "../core/config-parse.js";
import type { ContextPruningConfig } from "../core/config-types.js";
import type { HostMessage, Projection } from "../core/context/lens.js";
import { projectMessages } from "../core/context/lens-testkit.js";
import {
  _resetForTesting as _resetModelLimitsForTesting,
  setModelLimit,
} from "../core/context/model-limits.js";
import { publishRoundView } from "../core/context/round-view.js";
import {
  _resetContextStateManagerForTesting,
  consumePendingViewChange,
  getContextStateManager,
} from "../core/context/runtime.js";
import {
  allocateBlockId,
  type Block,
  RECALL_MAX_CHARS,
} from "../core/context/state.js";
import {
  buildPlugin,
  buildToolHooks,
  registerProfileToolsInConfig,
} from "../opencode.js";
import { _resetForTesting } from "../utils/logger.js";
import { createDecompressTool, unit as decompressUnit } from "./decompress.js";

// ---------------------------------------------------------------------------
// Session ids & teardown
// ---------------------------------------------------------------------------

const TEST_SESSION_ID = "sess-decompress-tool";

afterEach(() => {
  const store = getContextStateManager().store;
  store.delete(TEST_SESSION_ID);
  _resetContextStateManagerForTesting();
  _resetModelLimitsForTesting();
  _resetForTesting();
});

// ---------------------------------------------------------------------------
// Poly profile fixture
// ---------------------------------------------------------------------------

/**
 * A zoo config with the poly profile, mirroring config.toml's
 * `[zoo.context.decompress]` values so the flow tests keep their
 * `max_fill_percent = 90` gate.
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

const ORIGINAL_CONTENT = "这是需要恢复的原始消息正文，不得出现在 ToolResult 中";

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

/** A 3-message conversation whose restore would reveal the original content. */
function makeMessages(): HostMessage[] {
  return [
    makeUserLensMsg("开场问题"),
    makeUserLensMsg(ORIGINAL_CONTENT),
    makeAssistantLensMsg("回答完毕"),
  ];
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
      return projectMessages(messages);
    },
    async notify(sessionID: string, text: string): Promise<void> {
      notifyCalls.push({ sessionID, text });
    },
  };
  return { host, notifyCalls };
}

/** Parsed context config from POLY_ZOO. */
const PARSED_CONFIG = parseContextConfig(POLY_ZOO);

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
  messageID: "msg-decompress",
  agent: "dolphin",
  directory: "/tmp",
  worktree: "/tmp",
  abort: new AbortController().signal,
  metadata: () => {},
  ask: async () => {},
};

/** Valid decompress config (mirrors the parsed config.toml). */
const ENABLED_CONFIG: ContextPruningConfig = {
  dedup: {},
  purgeErrors: {},
  compress: {},
  decompress: { maxFillPercent: 90 },
};

/**
 * Seed a block in the shared manager's session state (b1 by default).
 *
 * The default span [0, 3) covers the 3-message transcript, with
 * compressedTokens 20000 / summaryTokens 500 (net delta 19500) — the
 * accounting the gate tests measure against.
 *
 * @param overrides - Block field overrides.
 * @returns The seeded block id.
 */
function seedBlock(overrides: Partial<Block> = {}): number {
  const manager = getContextStateManager();
  const state = manager.get(TEST_SESSION_ID);
  const id = allocateBlockId(state);
  state.blocks.set(id, {
    start: 0,
    end: 3,
    title: "测试块主题",
    summary: "该段的摘要正文",
    spanHash: "test-span-hash",
    status: "active",
    compressedTokens: 20000,
    summaryTokens: 500,
    createdAt: Date.now(),
    ...overrides,
  });
  assert.ok(state.blocks.get(id) !== undefined, "block must be seeded");
  return id;
}

/** Seed an active block b1 with the default span. */
function seedActiveBlock(): number {
  return seedBlock();
}

// ---------------------------------------------------------------------------
// History source — the single snapshot published by the transform
// ---------------------------------------------------------------------------

/** A host that records (or withholds) the optional history read. */
function sourceHost(options: {
  history?: HostMessage[];
  calls?: number[];
}): ToolHost {
  const host: ToolHost = {
    resolveSessionId: () => TEST_SESSION_ID,
    async notify(): Promise<void> {},
  };
  if (options.history !== undefined) {
    const messages = options.history;
    host.fetchHistory = async (): Promise<Projection> => {
      options.calls?.push(1);
      return projectMessages(messages);
    };
  }
  return host;
}

describe("decompress tool execute — history source", () => {
  it("restores against the published round view without reading the host", async () => {
    // The seeded block spans [0, 3): the round view says 3 messages, the
    // host read would answer with an empty transcript (0 messages).
    seedActiveBlock();
    publishRoundView(TEST_SESSION_ID, {
      projection: projectMessages(makeMessages()),
      numbered: [],
    });
    const calls: number[] = [];

    const tool = createDecompressTool(
      sourceHost({ history: [], calls }),
      PARSED_CONFIG,
    );
    const result = await tool.execute({ blockId: "b1" }, mockToolContext);

    assert.equal(
      calls.length,
      0,
      "the cached round view must not re-read the host",
    );
    assert.ok(
      result.includes("3 条原始消息"),
      `expected the cached view's message count, got: ${result}`,
    );
  });

  it("throws guidance when neither a view nor a host fallback exists", async () => {
    seedActiveBlock();
    const tool = createDecompressTool(sourceHost({}), PARSED_CONFIG);

    await assert.rejects(
      () => tool.execute({ blockId: "b1" }, mockToolContext),
      /无法解压：尚未取得当轮上下文视图/,
    );
    assert.equal(
      getContextStateManager().get(TEST_SESSION_ID).blocks.get(1)?.status,
      "active",
      "state untouched — the block stays folded",
    );
  });
});

// ---------------------------------------------------------------------------
// Restore happy path
// ---------------------------------------------------------------------------

describe("decompress tool execute — restore happy path", () => {
  it("consumes the block, flags the view change, persists, and notifies", async () => {
    const messages = makeMessages();
    const { host, notifyCalls } = fakeHost(messages);
    seedActiveBlock();

    const tool = createDecompressTool(host, PARSED_CONFIG);

    const result = await tool.execute({ blockId: "b1" }, mockToolContext);

    // (1) Block moved to consumed in the shared session state.
    const state = getContextStateManager().get(TEST_SESSION_ID);
    const block = state.blocks.get(1);
    assert.ok(block !== undefined);
    assert.equal(block.status, "consumed");
    assert.equal(consumePendingViewChange(TEST_SESSION_ID), true);

    // (2) State persisted to disk via the shared manager.
    const persisted = getContextStateManager().store.load(TEST_SESSION_ID);
    assert.equal(persisted.blocks.size, 1);
    assert.equal(persisted.blocks.get(1)?.status, "consumed");

    // (3) Ignored notification sent.
    assert.equal(notifyCalls.length, 1);
    assert.equal(notifyCalls[0].sessionID, TEST_SESSION_ID);
    assert.ok(
      notifyCalls[0].text.includes("上下文解压："),
      `expected "上下文解压：" prefix in prompt, got: ${notifyCalls[0].text}`,
    );

    // ToolResult: single-line confirmation with the expansion amount,
    // never the original content.
    assert.equal(typeof result, "string");
    assert.ok(!result.includes("\n"), "ToolResult must be a single line");
    assert.ok(result.includes("b1"), "ToolResult should include the block id");
    assert.ok(
      result.includes("3 条原始消息"),
      "ToolResult should include the message count",
    );
    assert.ok(
      result.includes("回胀") && result.includes("19.5K"),
      `expected 回胀量 in ToolResult, got: ${result}`,
    );
    assert.ok(
      result.includes("下一轮上下文生效"),
      "ToolResult should mention 下一轮上下文生效",
    );
    assert.ok(
      !result.includes(ORIGINAL_CONTENT),
      "ToolResult must not include original message content",
    );
  });
});

// ---------------------------------------------------------------------------
// Recall path
// ---------------------------------------------------------------------------

describe("decompress tool execute — recall path", () => {
  it("returns the summary body framed as a read-only recall, with zero state change and no notification", async () => {
    const { host, notifyCalls } = fakeHost([]);

    // Build a consumed block (as if swallowed by a wider recompression).
    seedBlock({
      status: "consumed",
      summary: "被消费旧块的完整摘要正文",
      title: "旧块主题",
    });

    const tool = createDecompressTool(host, PARSED_CONFIG);
    const result = await tool.execute({ blockId: "b1" }, mockToolContext);

    // The body is always framed by a note naming the block id and saying
    // out loud that no original text is restored — a bare body would read
    // like a completed restore.
    assert.ok(result.startsWith("【仅返回摘要，未恢复原文】压缩块 b1 "));
    assert.ok(result.includes("本次调用不改变状态"));
    assert.ok(!result.includes("已失效"), "a consumed block is not stale");
    assert.equal(
      result.slice(result.indexOf("\n") + 1),
      "被消费旧块的完整摘要正文",
    );

    // Zero state change.
    const after = getContextStateManager().get(TEST_SESSION_ID);
    assert.equal(after.blocks.get(1)?.status, "consumed");
    assert.equal(consumePendingViewChange(TEST_SESSION_ID), false);

    // No persistence, no notification.
    const persisted = getContextStateManager().store.load(TEST_SESSION_ID);
    assert.equal(persisted.blocks.size, 0);
    assert.equal(notifyCalls.length, 0);
  });

  it("truncates an over-long summary with a Chinese tail note", async () => {
    const { host } = fakeHost([]);
    const longSummary = "长".repeat(RECALL_MAX_CHARS + 100);
    seedBlock({
      status: "consumed",
      summary: longSummary,
      title: "超长块主题",
    });

    const tool = createDecompressTool(host, PARSED_CONFIG);
    const result = await tool.execute({ blockId: "b1" }, mockToolContext);

    // The recall note is one line; the truncated body follows it.
    assert.ok(result.startsWith("【仅返回摘要，未恢复原文】"));
    const body = result.slice(result.indexOf("\n") + 1);
    assert.ok(body.length <= RECALL_MAX_CHARS + 32);
    assert.ok(
      body.includes("[摘要过长已截断：省略 100 字符，省略部分无法取回]"),
      "expected truncation tail note",
    );
    assert.ok(
      body.startsWith("长".repeat(RECALL_MAX_CHARS)),
      "expected the first RECALL_MAX_CHARS characters",
    );
  });
});

// ---------------------------------------------------------------------------
// Gate rejection
// ---------------------------------------------------------------------------

describe("decompress tool execute — gate rejection", () => {
  it("rejects a restore that would exceed maxFillPercent, state untouched", async () => {
    const { host, notifyCalls } = fakeHost([]);
    seedActiveBlock();
    // Tiny window: after = 0 + 19500 > 1000 × 90% = 900 → rejected.
    setModelLimit(TEST_SESSION_ID, 1000, "test-model");

    const tool = createDecompressTool(host, PARSED_CONFIG);
    await assert.rejects(
      () => tool.execute({ blockId: "b1" }, mockToolContext),
      (err: unknown) =>
        err instanceof Error &&
        /超过解压阈值/.test(err.message) &&
        /19500/.test(err.message),
    );

    // State untouched: block still active, nothing saved, no notification.
    const state = getContextStateManager().get(TEST_SESSION_ID);
    assert.equal(state.blocks.get(1)?.status, "active");
    assert.equal(consumePendingViewChange(TEST_SESSION_ID), false);
    assert.equal(
      getContextStateManager().store.load(TEST_SESSION_ID).blocks.size,
      0,
    );
    assert.equal(notifyCalls.length, 0);
  });

  it("skips the gate when no model limit is captured (undefined context)", async () => {
    const messages = makeMessages();
    const { host, notifyCalls } = fakeHost(messages);
    seedActiveBlock();
    // No setModelLimit call → getModelLimit returns undefined → gate skipped.

    const tool = createDecompressTool(host, PARSED_CONFIG);
    const result = await tool.execute({ blockId: "b1" }, mockToolContext);

    const state = getContextStateManager().get(TEST_SESSION_ID);
    assert.equal(state.blocks.get(1)?.status, "consumed");
    assert.equal(typeof result, "string");
    assert.ok(result.includes("下一轮上下文生效"));
    assert.equal(notifyCalls.length, 1);
  });
});

// ---------------------------------------------------------------------------
// Target resolution errors (available block listing)
// ---------------------------------------------------------------------------

describe("decompress tool execute — target resolution errors", () => {
  it("throws a not-found error listing the available block numbers", async () => {
    const messages = makeMessages();
    const { host } = fakeHost(messages);
    seedActiveBlock();

    const tool = createDecompressTool(host, PARSED_CONFIG);
    await assert.rejects(
      () => tool.execute({ blockId: "b9" }, mockToolContext),
      (err: unknown) =>
        err instanceof Error &&
        /b9 不存在/.test(err.message) &&
        /1 个压缩块/.test(err.message) &&
        /b1/.test(err.message) &&
        /请勿凭记忆编造/.test(err.message),
    );
  });

  it("rejects a malformed block id with format guidance", async () => {
    const { host } = fakeHost([]);

    const tool = createDecompressTool(host, PARSED_CONFIG);
    await assert.rejects(
      () => tool.execute({ blockId: "9" }, mockToolContext),
      (err: unknown) =>
        err instanceof Error &&
        /格式非法/.test(err.message) &&
        /b<N>/.test(err.message) &&
        /请勿凭记忆编造/.test(err.message),
    );
  });

  it("reports the empty-session case when no block exists at all", async () => {
    const { host } = fakeHost([]);

    const tool = createDecompressTool(host, PARSED_CONFIG);
    await assert.rejects(
      () => tool.execute({ blockId: "b1" }, mockToolContext),
      (err: unknown) =>
        err instanceof Error &&
        /b1 不存在/.test(err.message) &&
        /没有已创建的压缩块/.test(err.message),
    );
  });
});

// ---------------------------------------------------------------------------
// Config guidance error
// ---------------------------------------------------------------------------

describe("decompress tool execute — config guidance error", () => {
  it("throws a loud config-guidance error when the decompress section is absent", async () => {
    const { host } = fakeHost([]);
    const tool = createDecompressTool(host, { dedup: {}, purgeErrors: {} });

    await assert.rejects(
      () => tool.execute({ blockId: "b1" }, mockToolContext),
      (err: unknown) =>
        err instanceof Error &&
        err.message.includes("[zoo.context.decompress]") &&
        /max_fill_percent/.test(err.message),
    );

    // No state was touched.
    const state = getContextStateManager().get(TEST_SESSION_ID);
    assert.equal(state.blocks.size, 0);
  });

  it("rejects a non-string blockId with a loud Chinese argument error", async () => {
    const { host } = fakeHost([]);
    const tool = createDecompressTool(host, ENABLED_CONFIG);

    await assert.rejects(
      () => tool.execute({ blockId: 3 }, mockToolContext),
      (err: unknown) =>
        err instanceof Error &&
        /blockId/.test(err.message) &&
        /字符串/.test(err.message),
    );
    const state = getContextStateManager().get(TEST_SESSION_ID);
    assert.equal(state.blocks.size, 0);
  });
});

// ---------------------------------------------------------------------------
// Registration gate (profile tools list)
// ---------------------------------------------------------------------------

describe("decompress tool registration gate", () => {
  it("decompress absent from the profile tools list → no decompress tool", () => {
    const { client } = mockClient([]);
    const hooks = buildToolHooks(client, { dedup: {}, purgeErrors: {} }, []);
    assert.equal(hooks, undefined);
  });

  it("compress only in the list → decompress stays unregistered", () => {
    const { client } = mockClient([]);
    const hooks = buildToolHooks(client, { dedup: {}, purgeErrors: {} }, [
      "compress",
    ]);
    assert.ok(hooks !== undefined, "compress tool registers");
    assert.equal(hooks.decompress, undefined);
  });

  it("decompress in the list → only decompress registered", () => {
    const { client } = mockClient([]);
    const hooks = buildToolHooks(client, { dedup: {}, purgeErrors: {} }, [
      "decompress",
    ]);
    assert.ok(hooks !== undefined);
    assert.equal(hooks.compress, undefined);
    assert.ok(hooks.decompress);
    assert.equal(typeof hooks.decompress.execute, "function");
  });

  it("both tools in the list → both tools registered", () => {
    const { client } = mockClient([]);
    const hooks = buildToolHooks(client, { dedup: {}, purgeErrors: {} }, [
      "compress",
      "decompress",
    ]);
    assert.ok(hooks !== undefined);
    assert.ok(hooks.compress);
    assert.ok(hooks.decompress);
  });

  it("registers plain JSON Schema args for OpenCode native tool loading", () => {
    const { client } = mockClient([]);
    const hooks = buildToolHooks(client, { dedup: {}, purgeErrors: {} }, [
      "decompress",
    ]);

    assert.ok(hooks?.decompress);
    const args = hooks.decompress.args as Record<
      string,
      { type: string; description: string }
    >;
    assert.deepEqual(Object.keys(args), ["blockId"]);
    assert.equal(args.blockId.type, "string");
    assert.ok(
      args.blockId.description.includes('形如 "b3"'),
      "blockId must show the id shape the model copies",
    );
    assert.ok(
      args.blockId.description.includes("[Block bN · K 条]"),
      "blockId must point at where ids are visible in the view",
    );
    assert.deepEqual(hooks.decompress.required, ["blockId"]);
  });

  it("carries the restore/recall contract in the description", () => {
    const { client } = mockClient([]);
    const hooks = buildToolHooks(client, { dedup: {}, purgeErrors: {} }, [
      "decompress",
    ]);

    assert.ok(hooks?.decompress);
    const description = hooks.decompress.description;
    assert.ok(!description.includes("\n"), "description stays a single line");
    assert.ok(
      description.includes("恢复") && description.includes("拒绝恢复"),
      "description must state the restore and its over-long rejection",
    );
    assert.ok(
      description.includes("下一轮"),
      "description must state that the restore takes effect next round",
    );
    assert.ok(
      description.includes("[Block bN · K 条] 的块可以恢复"),
      "description must restrict restore to active blocks",
    );
    assert.ok(
      description.includes("不能恢复原文"),
      "description must exclude terminal blocks from restore",
    );
    assert.ok(
      description.includes("只会返回保存的摘要") &&
        description.includes("不会改变状态"),
      "description must distinguish recall from restore",
    );
  });
});

// ---------------------------------------------------------------------------
// Config hook — primary_tools
// ---------------------------------------------------------------------------

describe("config hook — primary_tools", () => {
  it("decompress absent from the profile tools list → primary_tools untouched", () => {
    const config = { experimental: { primary_tools: ["bash"] } };
    registerProfileToolsInConfig(config, []);
    assert.deepEqual(config.experimental.primary_tools, ["bash"]);
  });

  it("compress only in the list → primary_tools gets no decompress", () => {
    const config = { experimental: { primary_tools: ["bash"] } };
    registerProfileToolsInConfig(config, ["compress"]);
    assert.deepEqual(config.experimental.primary_tools, ["bash", "compress"]);
  });

  it("decompress in the list → appends decompress preserving pre-existing entries", () => {
    const config = { experimental: { primary_tools: ["bash", "compress"] } };
    registerProfileToolsInConfig(config, ["compress", "decompress"]);
    assert.deepEqual(config.experimental.primary_tools, [
      "bash",
      "compress",
      "decompress",
    ]);
  });

  it("is idempotent — never duplicates decompress", () => {
    const config = { experimental: { primary_tools: ["decompress"] } };
    registerProfileToolsInConfig(config, ["decompress"]);
    assert.deepEqual(config.experimental.primary_tools, ["decompress"]);
  });

  it("plugin config hook appends both compress and decompress preserving entries", async () => {
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
});

// ---------------------------------------------------------------------------
// Unsupported host
// ---------------------------------------------------------------------------

describe("decompress tool unsupported host", () => {
  it("throws a single-line Chinese tool error when the host has no tool services", async () => {
    const tool = decompressUnit.create(
      {
        limits: {},
        contextConfig: ENABLED_CONFIG,
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
      () => tool.execute({ blockId: "b1" }, mockToolContext),
      (err: unknown) =>
        err instanceof Error &&
        !err.message.includes("\n") &&
        /在当前宿主上不可用/.test(err.message) &&
        /重试本工具无法解决/.test(err.message),
    );
  });
});
