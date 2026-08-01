/**
 * Integration tests for the range-mode compress tool adapter.
 *
 * Covers: the full execute flow (fetch → ref fallback → core → persist →
 * notify → ToolResult) against the real imported config, loud guidance
 * error propagation (unknown ref, reversed order), the `enabled === false`
 * registration gate (tool hooks + primary_tools), and the config-hook
 * primary_tools append preserving existing entries.
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { ContextMessageEntry } from "../core/metrics.js";
import {
  _clearAllSessionsForTesting,
  deleteSessionState,
  getOrCreateSessionState,
  loadSessionState,
} from "../core/pruning/marks.js";
import { _clearAllRefsForTesting } from "../core/pruning/message-refs.js";
import type { DcpClient } from "../hooks/context-command/index.js";
import type { ContextPruningConfig } from "../hooks/context-pruning/index.js";
import {
  buildToolHooks,
  registerCompressToolInConfig,
  zookeeper,
} from "../opencode.js";
import { _resetForTesting } from "../utils/logger.js";

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
 * assistant.  Range [1, 9) covers 8 tool messages (~16000 tokens), well
 * inside the protection boundary.
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
  it("creates a block, persists state, and sends an ignored notification", async () => {
    const messages = makeMessages();
    const { client, promptCalls } = mockClient(messages);

    const plugin = (await zookeeper({ client })) as any;
    assert.ok(plugin.tool, "tool hooks must be registered (compress enabled)");
    assert.ok(plugin.tool.compress, "compress tool must be registered");

    const result = await plugin.tool.compress.execute(
      {
        fromRef: refFor(1),
        toRef: refFor(9),
        summary: "用户请求执行命令，助手完成了操作。",
        title: "执行命令主题",
      },
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

  it("accepts a sessionId-shaped tool context (defensive)", async () => {
    const messages = makeMessages();
    const { client } = mockClient(messages);
    const plugin = (await zookeeper({ client })) as any;

    const result = await plugin.tool.compress.execute(
      {
        fromRef: refFor(1),
        toRef: refFor(9),
        summary: "用户请求执行命令，助手完成了操作。",
        title: "执行命令主题",
      },
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
    const plugin = (await zookeeper({ client })) as any;

    const title = "超".repeat(80);
    const result = await plugin.tool.compress.execute(
      {
        fromRef: refFor(1),
        toRef: refFor(9),
        summary: "摘要",
        title,
      },
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
// Error paths
// ---------------------------------------------------------------------------

describe("compress tool execute — error paths", () => {
  it("propagates the unknown-ref guidance error", async () => {
    const messages = makeMessages();
    const { client } = mockClient(messages);
    const plugin = (await zookeeper({ client })) as any;

    await assert.rejects(
      () =>
        plugin.tool.compress.execute(
          {
            fromRef: "m9999",
            toRef: refFor(9),
            summary: "摘要",
            title: "主题",
          },
          mockToolContext,
        ),
      /不存在/,
    );
  });

  it("propagates the reversed-order guidance error", async () => {
    const messages = makeMessages();
    const { client } = mockClient(messages);
    const plugin = (await zookeeper({ client })) as any;

    await assert.rejects(
      () =>
        plugin.tool.compress.execute(
          {
            fromRef: refFor(9),
            toRef: refFor(1),
            summary: "摘要",
            title: "主题",
          },
          mockToolContext,
        ),
      /顺序颠倒/,
    );
  });

  it("rejects an empty title with a loud Chinese guidance error", async () => {
    const messages = makeMessages();
    const { client } = mockClient(messages);
    const plugin = (await zookeeper({ client })) as any;

    await assert.rejects(
      () =>
        plugin.tool.compress.execute(
          {
            fromRef: refFor(1),
            toRef: refFor(9),
            summary: "摘要",
            title: "  ",
          },
          mockToolContext,
        ),
      (err: unknown) =>
        err instanceof Error &&
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
    const plugin = (await zookeeper({ client })) as any;

    const longTitle = "超".repeat(81);
    await assert.rejects(
      () =>
        plugin.tool.compress.execute(
          {
            fromRef: refFor(1),
            toRef: refFor(9),
            summary: "摘要",
            title: longTitle,
          },
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
    const plugin = (await zookeeper({ client })) as any;

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
            {
              fromRef: refFor(1),
              toRef: refFor(9),
              summary: "摘要",
              title,
            },
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
    const plugin = (await zookeeper({ client })) as any;

    const badTitles = ["foo---bar", "----", "a--b---c--d"];
    for (const title of badTitles) {
      await assert.rejects(
        () =>
          plugin.tool.compress.execute(
            {
              fromRef: refFor(1),
              toRef: refFor(9),
              summary: "摘要",
              title,
            },
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
});

// ---------------------------------------------------------------------------
// Registration gate (enabled === false)
// ---------------------------------------------------------------------------

describe("compress tool registration gate", () => {
  const DISABLED_CONFIG: ContextPruningConfig = {
    dedup: {},
    purgeErrors: {},
    compress: { enabled: false },
  };

  it("enabled=false → no compress tool registered", () => {
    const { client } = mockClient([]);
    const hooks = buildToolHooks(client, DISABLED_CONFIG);
    assert.equal(hooks, undefined);
  });

  it("enabled=false → primary_tools untouched", () => {
    const config = { experimental: { primary_tools: ["bash"] } };
    registerCompressToolInConfig(config, DISABLED_CONFIG);
    assert.deepEqual(config.experimental.primary_tools, ["bash"]);
  });

  it("enabled=true → compress tool registered with an executable", () => {
    const { client } = mockClient([]);
    const hooks = buildToolHooks(client, {
      dedup: {},
      purgeErrors: {},
      compress: { enabled: true },
    });
    assert.ok(hooks !== undefined);
    assert.ok(hooks.compress);
    assert.equal(typeof hooks.compress.execute, "function");
  });
});

// ---------------------------------------------------------------------------
// Config hook — primary_tools
// ---------------------------------------------------------------------------

describe("config hook — primary_tools", () => {
  it("appends compress preserving pre-existing entries", async () => {
    const plugin = (await zookeeper({})) as any;
    const config = { experimental: { primary_tools: ["bash", "edit"] } };

    await plugin.config(config);

    assert.deepEqual(config.experimental.primary_tools, [
      "bash",
      "edit",
      "compress",
    ]);
  });

  it("creates experimental.primary_tools when absent", async () => {
    const plugin = (await zookeeper({})) as any;
    const config: Record<string, any> = {};

    await plugin.config(config);

    assert.deepEqual(config.experimental?.primary_tools, ["compress"]);
  });
});
