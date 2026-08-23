/**
 * Decompression tool adapter — the inverse of the range-mode compress tool.
 *
 * Exposes the decompression core (`src/core/context/decompress.ts`) as a
 * host tool so the model can address a compression block by its
 * persistent `b<N>` id and either restore it or recall its summary:
 *
 * - **restore** — the block is active: deactivate it so the next
 *   transform round stops folding its interval and the original messages
 *   reappear in the view.  A context-limit gate rejects restores that
 *   would push the estimated prompt over `maxFillPercent` of the model
 *   window.  The ToolResult is a single-line confirmation carrying the
 *   expansion amount — never the original message content.
 * - **recall** — the block is inactive (consumed, content invalidated, or
 *   previously restored): read-only and idempotent, returns the persisted
 *   summary body (truncated to `RECALL_MAX_CHARS`).  Zero state change,
 *   zero view impact, no notification.
 *
 * The host tool services and the parsed context-pruning config are
 * captured by the factory closure.  Loud Chinese guidance errors from the
 * core propagate to the model unchanged — including the not-found error
 * that lists the currently available block numbers — the model
 * self-corrects by re-picking a valid block id or freeing context first.
 *
 * @module
 */

import type { ToolHost } from "../core/client/tool-host.js";
import type { ContextPruningConfig } from "../core/config-types.js";
import { formatTokens } from "../core/context/context-report.js";
import {
  applyDecompress,
  evaluateGate,
  resolveTarget,
  truncateRecallSummary,
} from "../core/context/decompress.js";
import { measureMessages } from "../core/context/measure.js";
import { getModelLimit } from "../core/context/model-limits.js";
import {
  getContextStateManager,
  setPendingViewChange,
} from "../core/context/runtime.js";
import type { ToolUnitDescriptor } from "../core/slots.js";
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
  required?: string[];
  execute(args: unknown, toolCtx: unknown): Promise<string>;
};

export type DecompressToolMetadata = Omit<DecompressToolDefinition, "execute">;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Build the host-independent decompress tool metadata.
 *
 * The description and JSON-schema args depend only on the parsed context
 * config, not on host services.
 *
 * @param _contextConfig - The parsed context-pruning config.
 * @returns The tool description and args schema.
 */
function buildDecompressToolMetadata(
  _contextConfig: ContextPruningConfig,
): DecompressToolMetadata {
  return {
    description: `恢复一个压缩块的内容（compress 的反向操作）。

当摘要提供不了你需要的确切细节（原始代码、完整报错、文件原文）时使用本工具。

两种结果：

1. 活跃块（视图中带 [Block bN · K 条] 块头）：块的原始消息在你的下一轮上下文中完整恢复。ToolResult 只返回一行确认，不含原文——不要在调用后的同一轮里引用原文内容。
2. 已被更大压缩块消费的旧块（仅以索引行 --- bN: <title> --- 出现）：立即返回该块保留的完整摘要正文，上下文不变。

参数：

- blockId: 要恢复的块 ID（如 "b3"）。取自块头 [Block b3 · K 条] 或索引行 --- bN: <title> ---，不要凭记忆编造。

重要：

- 恢复活跃块会回胀上下文。预估恢复后超过上下文水位时调用会被拒绝，错误信息会给出替代指导（先压缩其他段腾空间）。
- 不要与 compress 并行调用——两者都修改压缩状态，可能冲突。
- 块不存在时会返回明确的错误指导（列出当前可用块号），按提示修正后重试。`,
    args: {
      blockId: {
        type: "string",
        description: `要恢复的块 ID（如 "b3"）。来源：块头 [Block b3 · K 条] 或索引行 --- bN: <title> ---。索引行指向的旧块返回摘要正文，活跃块恢复原始消息。`,
      },
    },
    required: ["blockId"],
  };
}

/**
 * Create the decompression tool.
 *
 * The host and the parsed context config are captured by the closure so
 * each `execute` call is self-contained.
 *
 * @param host - The host tool services (session resolution, history,
 *   best-effort notification).
 * @param contextConfig - The parsed context-pruning config (decompress
 *   gate).
 * @returns The decompress tool definition.
 */
export function createDecompressTool(
  host: ToolHost,
  contextConfig: ContextPruningConfig,
): DecompressToolDefinition {
  return {
    ...buildDecompressToolMetadata(contextConfig),
    async execute(args, toolCtx) {
      const sessionID = host.resolveSessionId(toolCtx);
      if (sessionID === undefined) {
        throw new Error("无法确定会话 ID：工具上下文缺少 sessionID。");
      }
      const input = validateDecompressArgs(args);

      // ── Config check (loud Chinese guidance) ─────────────────────
      // The registration gate only registers the tool when the profile's
      // tools list names it, so reaching this branch with an undefined
      // section (or missing threshold) means the config hook handed the
      // tool a stale config — guide the user to fix config.toml.
      const decompressCfg = contextConfig.decompress;
      if (!decompressCfg || decompressCfg.maxFillPercent === undefined) {
        throw new Error(
          "[zoo.context.decompress] 段缺失或非法：请在 config.toml 配置 max_fill_percent（1-100 的整数）后重试。",
        );
      }

      const manager = getContextStateManager();
      const state = manager.get(sessionID);
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
            blockId: target.blockId,
            kind: "recall",
          },
        );
        return truncateRecallSummary(target.block.summary);
      }

      // ── Restore path ─────────────────────────────────────────────
      const view = await host.fetchHistory(sessionID);
      const currentPromptTokens = measureMessages(view).total;
      const contextLimit = getModelLimit(sessionID)?.context;

      // Gate: undefined context limit skips the gate by design.
      const gate = evaluateGate(
        currentPromptTokens,
        target.block,
        target.blockId,
        contextLimit,
        decompressCfg.maxFillPercent,
      );
      if (!gate.allowed) {
        // State untouched — the block stays active and nothing is saved.
        throw new Error(gate.reason);
      }

      const restored = applyDecompress(state, target.blockId, view);
      const delta = restored.restoredTokens;

      // Mark the view change and persist so the next transform stops
      // folding the block (mirrors the compress tool).
      setPendingViewChange(sessionID);
      manager.save(sessionID);

      log(
        "decompress-tool",
        "decompress_restored",
        sessionID,
        undefined,
        "info",
        {
          blockId: restored.blockId,
          kind: "restore",
          messageCount: restored.messageCount,
          deltaTokens: delta,
        },
      );

      // Ignored chat notification (best-effort — deactivation already
      // applied).  Same shape as the compress tool.
      const notifyMsg = `上下文解压：已恢复压缩块 b${restored.blockId} 的 ${restored.messageCount} 条原始消息，约回胀 ${formatTokens(delta)} tokens，下一轮上下文生效`;
      try {
        await host.notify(sessionID, notifyMsg);
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

/**
 * Decompress tool unit descriptor.
 *
 * The tool contribution carries the decompression adapter; `name`
 * doubles as the registry key and the tool key.
 */
export const unit: ToolUnitDescriptor = {
  name: "decompress",
  kind: "tool",
  create(deps) {
    const host = deps.toolHost;
    const metadata = buildDecompressToolMetadata(deps.contextConfig);
    if (host === undefined) {
      return {
        kind: "tool",
        tools: [
          {
            name: "decompress",
            ...metadata,
            execute: async () => "此工具在当前 host 上不可用。",
          },
        ],
      };
    }
    return {
      kind: "tool",
      tools: [
        {
          name: "decompress",
          ...createDecompressTool(host, deps.contextConfig),
        },
      ],
    };
  },
};
