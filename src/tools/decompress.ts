/**
 * Decompression tool adapter — the inverse of the range-mode compress tool.
 *
 * Exposes the decompression core (`src/core/pruning/decompress.ts`) as an
 * OpenCode tool so the model can address a compression block by its `b<N>`
 * id and either restore it or recall its summary:
 *
 * - **restore** — the block is active: deactivate it (`deactivatedBy =
 *   "user"`) so the next transform round stops folding it and the original
 *   messages reappear in the view.  A context-limit gate rejects restores
 *   that would push the estimated prompt over `rejectPercent` of the model
 *   window.  The ToolResult is a single-line confirmation carrying the
 *   expansion amount — never the original message content.
 * - **recall** — the block is inactive (consumed, anchor invalidated, or
 *   previously restored): read-only and idempotent, returns the persisted
 *   summary body (truncated to `RECALL_MAX_CHARS`).  Zero state change,
 *   zero view impact, no notification.
 *
 * The client and the parsed context-pruning config are captured by the
 * factory closure.  Loud Chinese guidance errors from the core propagate to
 * the model unchanged — the model self-corrects by re-picking a valid block
 * id or freeing context first.
 *
 * @module
 */

import { formatTokens } from "../core/context-report.js";
import type { ContextMessageEntry } from "../core/metrics.js";
import { measureContext } from "../core/metrics.js";
import { getModelLimit } from "../core/model-limits.js";
import {
  applyDecompress,
  evaluateGate,
  getOrCreateSessionState,
  resolveTarget,
  saveSessionState,
  snapshotRefs,
  truncateRecallSummary,
} from "../core/pruning/index.js";
import type { DcpClient } from "../hooks/context-command/index.js";
import type { ContextPruningConfig } from "../hooks/context-pruning/index.js";
import { log } from "../utils/logger.js";

type JsonSchemaStringArg = {
  type: "string";
  description: string;
};

type DecompressToolArgs = {
  blockId: JsonSchemaStringArg;
};

type DecompressToolInput = {
  blockId: string;
};

export type DecompressToolDefinition = {
  description: string;
  args: DecompressToolArgs;
  execute(args: unknown, toolCtx: unknown): Promise<string>;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolve the session ID from the OpenCode tool context.
 *
 * Defensive: the OpenCode SDK uses `sessionID`; tolerate a `sessionId`
 * variant so the tool survives host SDK shape changes.
 *
 * @param toolCtx - The tool execution context.
 * @returns The session identifier.
 * @throws A loud Chinese error when no session ID is present.
 */
function resolveSessionId(toolCtx: unknown): string {
  const ctx = toolCtx as { sessionID?: unknown; sessionId?: unknown };
  const id = ctx.sessionID ?? ctx.sessionId;
  if (typeof id !== "string" || id.length === 0) {
    throw new Error("无法确定会话 ID：工具上下文缺少 sessionID。");
  }
  return id;
}

/**
 * Validate the tool arguments: a single required string `blockId`.
 *
 * @param args - The raw tool arguments.
 * @returns The validated input.
 * @throws A loud Chinese error when the arguments are not an object or
 *   `blockId` is not a string.
 */
function validateDecompressArgs(args: unknown): DecompressToolInput {
  if (args === null || typeof args !== "object" || Array.isArray(args)) {
    throw new Error(
      "解压工具参数格式错误：请提供包含 blockId 字符串参数的对象后重试。",
    );
  }

  const input = args as Record<string, unknown>;
  const blockId = input.blockId;
  if (typeof blockId !== "string") {
    throw new Error(
      'blockId 参数必须是字符串：请按工具参数说明提供要恢复的块 ID（如 "b3"）后重试。',
    );
  }
  return { blockId };
}

/**
 * Fetch the full session messages array.
 *
 * Mirrors the `/dcp` command path and the compress tool: unwraps
 * `res.data ?? res` and checks `res.error`, throwing loud Chinese errors
 * on API failure.
 *
 * @param client - The OpenCode client (may be partial in tests).
 * @param sessionID - The session identifier.
 * @returns The raw session messages array.
 */
async function fetchSessionMessages(
  client: DcpClient,
  sessionID: string,
): Promise<ContextMessageEntry[]> {
  if (!client?.session?.messages) {
    throw new Error("无法获取会话消息：会话消息 API 不可用");
  }

  let rawMessages: unknown;
  try {
    const res = await client.session.messages({ path: { id: sessionID } });
    rawMessages = res;
  } catch (err) {
    log(
      "decompress-tool",
      "fetch_messages_failed",
      sessionID,
      undefined,
      "error",
      { error: String(err) },
    );
    throw new Error(
      `无法获取会话消息：${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (!rawMessages) {
    throw new Error("会话消息 API 返回空结果");
  }

  const rawObj = rawMessages as {
    data?: unknown;
    error?: { message?: string };
  };
  if (rawObj.error) {
    const msg = rawObj.error.message ?? String(rawObj.error);
    throw new Error(`获取会话消息失败：${msg}`);
  }
  const messages = (rawObj.data ?? rawMessages) as ContextMessageEntry[];

  if (!Array.isArray(messages)) {
    throw new Error("会话消息格式异常：期望数组");
  }
  return messages;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create the decompression tool.
 *
 * The client and the parsed context config are captured by the closure so
 * each `execute` call is self-contained.
 *
 * @param client - The OpenCode client (session.messages / session.prompt).
 * @param contextConfig - The parsed context-pruning config (decompress
 *   gate).
 * @returns The OpenCode tool definition.
 */
export function createDecompressTool(
  client: DcpClient,
  contextConfig: ContextPruningConfig,
): DecompressToolDefinition {
  return {
    description: `恢复一个压缩块的内容（compress 的反向操作）。

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
    args: {
      blockId: {
        type: "string",
        description: `要恢复的块 ID（如 "b3"）。来源：块头 [Compression Block b3] 或索引行
--- bN: <title> ---。索引行指向的旧块返回摘要正文，活跃块恢复原始消息。`,
      },
    },
    async execute(args, toolCtx) {
      const sessionID = resolveSessionId(toolCtx);
      const input = validateDecompressArgs(args);

      // ── Config check (loud Chinese guidance) ─────────────────────
      // The registration gate only registers the tool when the decompress
      // section was strictly parsed with `enabled: true`, so reaching this
      // branch with an undefined section (or missing threshold) means the
      // config hook handed the tool a stale config — guide the user to fix
      // config.toml.
      const decompressCfg = contextConfig.decompress;
      if (!decompressCfg || decompressCfg.rejectPercent === undefined) {
        throw new Error(
          "解压功能未启用：请在 config.toml 的 [zoo.context.decompress] 段配置 enabled = true 与 reject_percent（1-100 的整数）后重试。",
        );
      }

      const state = getOrCreateSessionState(sessionID);
      const target = resolveTarget(state, input.blockId);

      // ── Recall path: read-only, idempotent, zero view impact ─────
      // No notification — nothing changed in the view.
      if (target.kind === "recall") {
        log(
          "decompress-tool",
          "decompress_recalled",
          sessionID,
          undefined,
          "info",
          {
            blockId: target.block.blockId,
            kind: "recall",
          },
        );
        return truncateRecallSummary(target.block.summary);
      }

      // ── Restore path ─────────────────────────────────────────────
      const block = target.block;
      const messages = await fetchSessionMessages(client, sessionID);
      const currentPromptTokens = measureContext({ messages }).estimated_tokens;
      const contextLimit = getModelLimit(sessionID)?.context;

      // Gate: undefined context limit skips the gate by design.
      const gate = evaluateGate(
        currentPromptTokens,
        block,
        contextLimit,
        decompressCfg.rejectPercent,
      );
      if (!gate.allowed) {
        // State untouched — the block stays active and nothing is saved.
        throw new Error(gate.reason);
      }

      applyDecompress(state, block);

      const msgCount = block.messageIds.length;
      const delta = block.compressedTokens - block.summaryTokens;

      // Mark the view change and persist so the next transform stops
      // folding the block (mirrors the compress tool).  Snapshot the ref
      // registry so refs survive a restart without renumbering.
      state.pendingViewChange = true;
      const refsSnapshot = snapshotRefs(sessionID);
      if (refsSnapshot) state.refs = refsSnapshot;
      saveSessionState(sessionID, state);

      log(
        "decompress-tool",
        "decompress_restored",
        sessionID,
        undefined,
        "info",
        {
          blockId: block.blockId,
          kind: "restore",
          messageCount: msgCount,
          deltaTokens: delta,
        },
      );

      // Ignored chat notification (best-effort — deactivation already
      // applied).  Same shape as the compress tool.
      const notifyMsg = `上下文解压：已恢复压缩块 b${block.blockId} 的 ${msgCount} 条原始消息，约回胀 ${formatTokens(delta)} tokens，下一轮上下文生效`;
      try {
        await client?.session?.prompt?.({
          path: { id: sessionID },
          body: {
            noReply: true,
            parts: [{ type: "text", text: notifyMsg, ignored: true }],
          },
        });
      } catch (err) {
        log("decompress-tool", "notify_failed", sessionID, undefined, "warn", {
          error: String(err),
        });
      }

      // Single-line short ToolResult — never the original content.
      return notifyMsg;
    },
  };
}
