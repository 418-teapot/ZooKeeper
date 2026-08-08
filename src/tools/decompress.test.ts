/**
 * Integration tests for the decompress tool adapter.
 *
 * Covers: the restore flow (deactivate → pendingViewChange → refs snapshot
 * → persist → notify → single-line ToolResult), the recall flow (summary
 * body, zero state change, no notification), the context-limit gate
 * rejection (state untouched), the loud config-guidance error when the
 * `[zoo.context.decompress]` section is absent, and the registration gate
 * (`enabled === false` / absent section → no tool key, primary_tools
 * untouched).
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { ContextPruningConfig } from "../core/config-types.js";
import type { DcpClient } from "../core/context/dcp-client.js";
import type { ContextMessageEntry } from "../core/context/metrics.js";
import {
  _resetForTesting as _resetModelLimitsForTesting,
  setModelLimit,
} from "../core/context/model-limits.js";
import {
  assignMessageRefs,
  createBlock,
  RECALL_MAX_CHARS,
} from "../core/context/pruning/index.js";
import {
  _clearAllSessionsForTesting,
  deleteSessionState,
  getOrCreateSessionState,
  loadSessionState,
} from "../core/context/pruning/marks.js";
import { _clearAllRefsForTesting } from "../core/context/pruning/message-refs.js";
import {
  buildToolHooks,
  registerDecompressToolInConfig,
  zookeeper,
} from "../opencode.js";
import { _resetForTesting } from "../utils/logger.js";
import { createDecompressTool } from "./decompress.js";

// ---------------------------------------------------------------------------
// Session ids & teardown
// ---------------------------------------------------------------------------

const TEST_SESSION_ID = "sess-decompress-tool";
const PERSISTED_SESSION_IDS = [TEST_SESSION_ID];

afterEach(() => {
  _resetForTesting();
  _resetModelLimitsForTesting();
  _clearAllSessionsForTesting();
  _clearAllRefsForTesting();
  for (const sid of PERSISTED_SESSION_IDS) {
    deleteSessionState(sid);
  }
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ORIGINAL_CONTENT = "这是需要恢复的原始消息正文，不得出现在 ToolResult 中";

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

/**
 * A small conversation whose messages are assigned refs so the restore path
 * can snapshot the ref registry.  The user message carries the original
 * content that the ToolResult must never echo.
 */
function makeMessages(): ContextMessageEntry[] {
  return [
    makeUserMsg("u0", "开场问题"),
    makeUserMsg("u1", ORIGINAL_CONTENT),
    makeAssistantMsg("a1", "回答完毕"),
  ];
}

/** Mock client that returns the given messages and captures prompt calls. */
function mockClient(messages: ContextMessageEntry[]): {
  client: DcpClient;
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

/**
 * Create an active block b1 in the session state (compressedTokens 20000,
 * summaryTokens 500, net delta 19500).
 */
function createActiveBlock(): void {
  const state = getOrCreateSessionState(TEST_SESSION_ID);
  const block = createBlock(state, {
    anchorMessageId: "a1",
    messageIds: ["u0", "u1", "a1"],
    summary: "该段的摘要正文",
    title: "测试块主题",
    compressedTokens: 20000,
    summaryTokens: 500,
  });
  assert.ok(block !== null, "block must be created");
}

/** Valid enabled decompress config (mirrors the parsed config.toml). */
const ENABLED_CONFIG: ContextPruningConfig = {
  dedup: {},
  purgeErrors: {},
  compress: { enabled: true },
  decompress: { enabled: true, maxFillPercent: 90 },
};

// ---------------------------------------------------------------------------
// Restore happy path
// ---------------------------------------------------------------------------

describe("decompress tool execute — restore happy path", () => {
  it("deactivates the block, persists state, and sends an ignored notification", async () => {
    const messages = makeMessages();
    const { client, promptCalls } = mockClient(messages);
    createActiveBlock();
    // Populate the ref registry so the restore path snapshots it.
    assignMessageRefs(TEST_SESSION_ID, messages);

    const plugin = (await zookeeper({ client })) as any;
    assert.ok(plugin.tool, "tool hooks must be registered");
    assert.ok(plugin.tool.decompress, "decompress tool must be registered");

    const result = await plugin.tool.decompress.execute(
      { blockId: "b1" },
      mockToolContext,
    );

    // (1) Block deactivated with the user-requested deactivation cause.
    const state = getOrCreateSessionState(TEST_SESSION_ID);
    const block = state.blocks.get("1");
    assert.ok(block !== undefined);
    assert.equal(block.active, false);
    assert.equal(block.deactivatedBy, "user");
    assert.equal(typeof block.deactivatedAt, "number");
    assert.equal(state.pendingViewChange, true);

    // (2) Refs snapshot saved on the state.
    assert.ok(state.refs !== undefined, "refs snapshot must be saved");

    // (3) State persisted to disk via saveSessionState.
    const persisted = loadSessionState(TEST_SESSION_ID);
    assert.ok(persisted !== null, "state must be persisted to disk");
    assert.equal(persisted.blocks.get("1")?.active, false);
    assert.equal(persisted.blocks.get("1")?.deactivatedBy, "user");
    assert.equal(typeof persisted.blocks.get("1")?.deactivatedAt, "number");
    assert.ok(persisted.refs !== undefined, "refs snapshot must be persisted");

    // (4) Ignored notification sent.
    assert.equal(promptCalls.length, 1);
    assert.equal(promptCalls[0].sessionID, TEST_SESSION_ID);
    assert.equal(promptCalls[0].noReply, true);
    assert.equal(promptCalls[0].ignored, true);
    assert.ok(
      promptCalls[0].text.includes("上下文解压："),
      `expected "上下文解压：" prefix in prompt, got: ${promptCalls[0].text}`,
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
  it("returns the summary body with zero state change and no notification", async () => {
    const messages = makeMessages();
    const { client, promptCalls } = mockClient(messages);

    // Build an inactive block (as if consumed by a wider recompression).
    const state = getOrCreateSessionState(TEST_SESSION_ID);
    const block = createBlock(state, {
      anchorMessageId: "a1",
      messageIds: ["u0", "u1", "a1"],
      summary: "被消费旧块的完整摘要正文",
      title: "旧块主题",
      compressedTokens: 20000,
      summaryTokens: 500,
    });
    assert.ok(block !== null);
    block.active = false;
    const dirtyBefore = state.dirty;

    const plugin = (await zookeeper({ client })) as any;
    const result = await plugin.tool.decompress.execute(
      { blockId: "b1" },
      mockToolContext,
    );

    // Returns the full summary body (untruncated — short summary).
    assert.equal(result, "被消费旧块的完整摘要正文");

    // Zero state change.
    const after = getOrCreateSessionState(TEST_SESSION_ID);
    assert.equal(after.blocks.get("1")?.active, false);
    assert.equal(after.blocks.get("1")?.deactivatedBy, undefined);
    assert.equal(after.dirty, dirtyBefore);
    assert.equal(after.pendingViewChange, false);

    // No persistence, no notification.
    assert.equal(loadSessionState(TEST_SESSION_ID), null);
    assert.equal(promptCalls.length, 0);
  });

  it("truncates an over-long summary with a Chinese tail note", async () => {
    const { client } = mockClient([]);
    const state = getOrCreateSessionState(TEST_SESSION_ID);
    const longSummary = "长".repeat(RECALL_MAX_CHARS + 100);
    const block = createBlock(state, {
      anchorMessageId: "a1",
      messageIds: ["u0"],
      summary: longSummary,
      title: "超长块主题",
      compressedTokens: 20000,
      summaryTokens: 500,
    });
    assert.ok(block !== null);
    block.active = false;

    const plugin = (await zookeeper({ client })) as any;
    const result = await plugin.tool.decompress.execute(
      { blockId: "b1" },
      mockToolContext,
    );

    assert.ok(result.length <= RECALL_MAX_CHARS + 64);
    assert.ok(
      result.includes("[摘要过长已截断：省略 100 字符]"),
      "expected truncation tail note",
    );
    assert.ok(
      result.startsWith("长".repeat(RECALL_MAX_CHARS)),
      "expected the first RECALL_MAX_CHARS characters",
    );
  });
});

// ---------------------------------------------------------------------------
// Gate rejection
// ---------------------------------------------------------------------------

describe("decompress tool execute — gate rejection", () => {
  it("rejects a restore that would exceed maxFillPercent, state untouched", async () => {
    const { client, promptCalls } = mockClient([]);
    createActiveBlock();
    // Tiny window: after = 0 + 19500 > 1000 × 90% = 900 → rejected.
    setModelLimit(TEST_SESSION_ID, 1000, "test-model");

    const plugin = (await zookeeper({ client })) as any;
    await assert.rejects(
      () => plugin.tool.decompress.execute({ blockId: "b1" }, mockToolContext),
      (err: unknown) =>
        err instanceof Error &&
        /超过解压阈值/.test(err.message) &&
        /19500/.test(err.message),
    );

    // State untouched: block still active, nothing saved, no notification.
    const state = getOrCreateSessionState(TEST_SESSION_ID);
    assert.equal(state.blocks.get("1")?.active, true);
    assert.equal(state.blocks.get("1")?.deactivatedBy, undefined);
    assert.equal(state.pendingViewChange, false);
    assert.equal(loadSessionState(TEST_SESSION_ID), null);
    assert.equal(promptCalls.length, 0);
  });

  it("skips the gate when no model limit is captured (undefined context)", async () => {
    const messages = makeMessages();
    const { client, promptCalls } = mockClient(messages);
    createActiveBlock();
    // No setModelLimit call → getModelLimit returns undefined → gate skipped.

    const plugin = (await zookeeper({ client })) as any;
    const result = await plugin.tool.decompress.execute(
      { blockId: "b1" },
      mockToolContext,
    );

    const state = getOrCreateSessionState(TEST_SESSION_ID);
    assert.equal(state.blocks.get("1")?.active, false);
    assert.equal(state.blocks.get("1")?.deactivatedBy, "user");
    assert.equal(typeof result, "string");
    assert.ok(result.includes("下一轮上下文生效"));
    assert.equal(promptCalls.length, 1);
  });
});

// ---------------------------------------------------------------------------
// Config guidance error
// ---------------------------------------------------------------------------

describe("decompress tool execute — config guidance error", () => {
  it("throws a loud config-guidance error when the decompress section is absent", async () => {
    const { client } = mockClient([]);
    const tool = createDecompressTool(client, { dedup: {}, purgeErrors: {} });

    await assert.rejects(
      () => tool.execute({ blockId: "b1" }, mockToolContext),
      (err: unknown) =>
        err instanceof Error &&
        err.message.includes("[zoo.context.decompress]") &&
        /enabled/.test(err.message),
    );

    // No state was touched.
    const state = getOrCreateSessionState(TEST_SESSION_ID);
    assert.equal(state.blocks.size, 0);
  });

  it("rejects a non-string blockId with a loud Chinese argument error", async () => {
    const { client } = mockClient([]);
    const tool = createDecompressTool(client, ENABLED_CONFIG);

    await assert.rejects(
      () => tool.execute({ blockId: 3 }, mockToolContext),
      (err: unknown) =>
        err instanceof Error &&
        /blockId/.test(err.message) &&
        /字符串/.test(err.message),
    );
    const state = getOrCreateSessionState(TEST_SESSION_ID);
    assert.equal(state.blocks.size, 0);
  });
});

// ---------------------------------------------------------------------------
// Registration gate (enabled === false / absent)
// ---------------------------------------------------------------------------

describe("decompress tool registration gate", () => {
  it("enabled=false → no decompress tool registered", () => {
    const { client } = mockClient([]);
    const hooks = buildToolHooks(client, {
      dedup: {},
      purgeErrors: {},
      decompress: { enabled: false },
    });
    assert.equal(hooks, undefined);
  });

  it("decompress section absent → no decompress tool registered", () => {
    const { client } = mockClient([]);
    const hooks = buildToolHooks(client, { dedup: {}, purgeErrors: {} });
    assert.equal(hooks, undefined);
  });

  it("compress disabled but decompress enabled → only decompress registered", () => {
    const { client } = mockClient([]);
    const hooks = buildToolHooks(client, {
      dedup: {},
      purgeErrors: {},
      decompress: { enabled: true },
    });
    assert.ok(hooks !== undefined);
    assert.equal(hooks.compress, undefined);
    assert.ok(hooks.decompress);
    assert.equal(typeof hooks.decompress.execute, "function");
  });

  it("both enabled → both tools registered", () => {
    const { client } = mockClient([]);
    const hooks = buildToolHooks(client, {
      dedup: {},
      purgeErrors: {},
      compress: { enabled: true },
      decompress: { enabled: true },
    });
    assert.ok(hooks !== undefined);
    assert.ok(hooks.compress);
    assert.ok(hooks.decompress);
  });

  it("registers plain JSON Schema args for OpenCode native tool loading", () => {
    const { client } = mockClient([]);
    const hooks = buildToolHooks(client, {
      dedup: {},
      purgeErrors: {},
      decompress: { enabled: true },
    });

    assert.ok(hooks?.decompress);
    assert.deepEqual(hooks.decompress.args, {
      blockId: {
        type: "string",
        description: `要恢复的块 ID（如 "b3"）。来源：块头 [Compression Block b3] 或索引行
--- bN: <title> ---。索引行指向的旧块返回摘要正文，活跃块恢复原始消息。`,
      },
    });
  });

  it("carries the verbatim decompress description", () => {
    const { client } = mockClient([]);
    const hooks = buildToolHooks(client, {
      dedup: {},
      purgeErrors: {},
      decompress: { enabled: true },
    });

    assert.ok(hooks?.decompress);
    assert.equal(
      hooks.decompress.description,
      `恢复一个压缩块的内容（compress 的反向操作）。

当摘要提供不了你需要的确切细节（原始代码、完整报错、文件原文）时使用本工具。

两种结果：

1. 活跃块（视图中带 [Compression Block bN] 块头）：块的原始消息在你的
   下一轮上下文中完整恢复。ToolResult 只返回一行确认，不含原文——不要
   在调用后的同一轮里引用原文内容。
2. 已被更大压缩块消费的旧块（仅以索引行 --- bN: <title> --- 出现）：
   立即返回该块保留的完整摘要正文，上下文不变。

参数：

- blockId: 要恢复的块 ID（如 "b3"）。取自块头 [Compression Block b3]
  或索引行 --- bN: <title> ---，不要凭记忆编造。

重要：

- 恢复活跃块会回胀上下文。预估恢复后超过上下文水位时调用会被拒绝，
  错误信息会给出替代指导（先压缩其他段腾空间）。
- 不要与 compress 并行调用——两者都修改压缩状态，可能冲突。
- 块不存在时会返回明确的错误指导，按提示修正后重试。`,
    );
  });
});

// ---------------------------------------------------------------------------
// Config hook — primary_tools
// ---------------------------------------------------------------------------

describe("config hook — primary_tools", () => {
  it("decompress section absent → primary_tools untouched", () => {
    const config = { experimental: { primary_tools: ["bash"] } };
    registerDecompressToolInConfig(config, { dedup: {}, purgeErrors: {} });
    assert.deepEqual(config.experimental.primary_tools, ["bash"]);
  });

  it("enabled=false → primary_tools untouched", () => {
    const config = { experimental: { primary_tools: ["bash"] } };
    registerDecompressToolInConfig(config, {
      dedup: {},
      purgeErrors: {},
      decompress: { enabled: false },
    });
    assert.deepEqual(config.experimental.primary_tools, ["bash"]);
  });

  it("enabled=true → appends decompress preserving pre-existing entries", () => {
    const config = { experimental: { primary_tools: ["bash", "compress"] } };
    registerDecompressToolInConfig(config, {
      dedup: {},
      purgeErrors: {},
      decompress: { enabled: true },
    });
    assert.deepEqual(config.experimental.primary_tools, [
      "bash",
      "compress",
      "decompress",
    ]);
  });

  it("is idempotent — never duplicates decompress", () => {
    const config = { experimental: { primary_tools: ["decompress"] } };
    registerDecompressToolInConfig(config, {
      dedup: {},
      purgeErrors: {},
      decompress: { enabled: true },
    });
    assert.deepEqual(config.experimental.primary_tools, ["decompress"]);
  });

  it("plugin config hook appends both compress and decompress preserving entries", async () => {
    const plugin = (await zookeeper({})) as any;
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
