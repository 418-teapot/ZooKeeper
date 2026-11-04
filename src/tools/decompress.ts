/**
 * Decompression tool adapter — the inverse of the range-mode compress tool.
 *
 * Exposes the decompression core (`src/core/context/decompress.ts`) as a
 * host tool so the model can address a compression block by its
 * persistent `b<N>` id and either restore it or recall its summary:
 *
 * - **restore** — the block is active: move it to `consumed` so the next
 *   transform round stops folding its interval and the original messages
 *   reappear in the view.  A context-limit gate rejects restores that
 *   would push the estimated prompt over `maxFillPercent` of the model
 *   window.  The ToolResult is a single-line confirmation carrying the
 *   expansion amount and the "下一轮生效" caveat — never the original
 *   message content.
 * - **recall** — the block is in a terminal status (`consumed`, stale,
 *   or previously restored): read-only and idempotent, returns the
 *   persisted summary body (truncated to `RECALL_MAX_CHARS`) framed by a
 *   note that says out loud that NO original text is being restored and
 *   that the view is unchanged.  Zero state change, zero view impact, no
 *   notification.
 *
 * The host tool services, the parsed context-pruning config and the plugin
 * instance's context runtime are captured by the factory closure.  Every
 * state operation runs under the call's permit: the recall path reads, the
 * restore path reads and writes inside one `runtime.commit`, and a missing
 * or lapsed permit changes nothing.  The history the restore gate measures
 * is the round view published by the context transform (the same address
 * space the model sees), with the host's history read only as a fallback on
 * hosts that guarantee it is the same source.  Loud Chinese guidance errors
 * from the core propagate to the model unchanged — including the not-found
 * error that lists the currently available block numbers — the model
 * self-corrects by re-picking a valid block id or freeing context first.
 *
 * @module
 */

import type { ContextPruningConfig } from "../core/config-types.js";
import { formatTokens } from "../core/context/context-report.js";
import {
  applyDecompress,
  evaluateGate,
  recallOutput,
  resolveTarget,
} from "../core/context/decompress.js";
import { measureMessages } from "../core/context/measure.js";
import type { ContextRuntime } from "../core/context/runtime.js";
import type { ToolHost } from "../core/ports/tool-host.js";
import {
  defineTool,
  type ToolContribution,
  type ToolDefinition,
} from "../core/unit.js";
import { log } from "../utils/logger.js";

type DecompressToolInput = {
  blockId: string;
};

/** The decompress tool's host-independent metadata. */
type DecompressToolMetadata = Pick<
  ToolContribution,
  "description" | "args" | "required"
>;

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
    description:
      "根据块 ID 恢复被压缩块隐藏的原始消息；恢复将在下一轮上下文中生效，原文过长时会拒绝恢复。" +
      "只有当前仍显示为 [Block bN · K 条] 的块可以恢复；已经恢复过、被更大范围覆盖或已经失效的块不能恢复原文，" +
      "调用只会返回保存的摘要，不会改变状态。",
    args: {
      blockId: {
        type: "string",
        description:
          '要恢复的压缩块 id（形如 "b3"，取自当前视图的块头 [Block bN · K 条] 或索引行 --- bN: 标题 ---）',
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
  runtime: ContextRuntime,
): ToolDefinition {
  return {
    ...buildDecompressToolMetadata(contextConfig),
    async execute(args, toolCtx, hostCtx) {
      const sessionID = host.resolveSessionId(toolCtx);
      if (sessionID === undefined) {
        throw new Error(
          "无法解压：工具上下文缺少 sessionID，会话状态无法定位。" +
            "这是宿主接线问题，重试本工具无法解决，需重启宿主或由用户处理。",
        );
      }
      const permit = hostCtx?.permit;
      if (permit === undefined || !permit.isActive()) {
        throw new Error(
          "本次解压未生效：本次调用没有有效的会话工作凭证，会话可能已停止或已取消，会话状态未改动。",
        );
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
          "[zoo.context.decompress] 段缺失或非法：请在 config.toml 配置 " +
            "max_fill_percent（1-100 的整数），并重新安装生效。" +
            "配置错误不会因重试本工具而消失：请停止重试并告知用户修正配置。",
        );
      }

      // ── Recall path: read-only, idempotent, zero view impact ─────
      // No notification — nothing changed in the view.  A stale block
      // takes this path too: its summary survives, its original span
      // does not, and `recallOutput` says so.
      const recall = runtime.read(permit, (state) => {
        const target = resolveTarget(state, input.blockId);
        return target.kind === "recall"
          ? {
              text: recallOutput(target.block, target.blockId),
              blockId: target.blockId,
              status: target.block.status,
            }
          : null;
      });
      if (recall === undefined) {
        throw new Error(
          "本次解压未生效：会话已停止或本次调用已取消，会话状态未改动。",
        );
      }
      if (recall !== null) {
        log.info({
          hook: "decompress-tool",
          event: "decompress_recalled",
          sessionId: sessionID,
          blockId: recall.blockId,
          kind: "recall",
          status: recall.status,
        });
        return recall.text;
      }

      // ── Restore path ─────────────────────────────────────────────
      // The read and the write are one commit: the block status and the
      // pending-view-change flag become committed only while the permit
      // stays active.  Same source rule as the compress tool: the round
      // view published by the transform is the history this tool measures
      // and restores against; the host read is only a fallback for rounds
      // that ran without a published view (and only on hosts that wire
      // it).
      const outcome = await runtime.commit(permit, async (state) => {
        const target = resolveTarget(state, input.blockId);
        if (target.kind !== "restore") {
          throw new Error(
            "本次解压未生效：块状态在本次调用中已改变，会话状态未改动。",
          );
        }
        const cached = runtime.roundView(sessionID);
        const history =
          cached !== undefined
            ? cached.projection
            : await host.fetchHistory?.(sessionID);
        if (history === undefined) {
          throw new Error(
            "无法解压：尚未取得当轮上下文视图（上下文变换本轮还未运行），" +
              "且当前宿主不提供同源的历史回退，无法评估恢复后的上下文水位。" +
              "本轮内重试结果相同，请等下一轮上下文变换运行后再恢复；" +
              "若每轮都如此，属于宿主配置问题，请告知用户处理。",
          );
        }
        const view = history.messages;
        const currentPromptTokens = measureMessages(view).total;
        const contextLimit = runtime.modelLimit(sessionID)?.context;

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
        return { restored, delta: restored.restoredTokens };
      });
      if (outcome === undefined) {
        throw new Error(
          "本次解压未生效：会话已停止或本次调用已取消，会话状态未改动。",
        );
      }

      // Mark the view change so the next transform stops folding the block
      // (mirrors the compress tool).  Only a committed call flags it: a
      // permit that lapsed after the commit writes nothing.
      runtime.setPendingViewChange(permit);

      log.info({
        hook: "decompress-tool",
        event: "decompress_restored",
        sessionId: sessionID,
        blockId: outcome.restored.blockId,
        kind: "restore",
        messageCount: outcome.restored.messageCount,
        deltaTokens: outcome.delta,
      });

      // Ignored chat notification (best-effort — the status change is
      // already committed).  Same shape as the compress tool.
      const notifyMsg = `上下文解压：已恢复压缩块 b${outcome.restored.blockId} 的 ${outcome.restored.messageCount} 条原始消息，约回胀 ${formatTokens(outcome.delta)} tokens，下一轮上下文生效——本轮请勿引用其原文。`;
      try {
        await host.notify(sessionID, notifyMsg);
      } catch (err) {
        log.warn({
          hook: "decompress-tool",
          event: "notify_failed",
          sessionId: sessionID,
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
export const unit = defineTool({
  name: "decompress",
  needs: ["toolHost", "contextConfig", "contextRuntime"],
  create(caps) {
    return createDecompressTool(
      caps.toolHost,
      caps.contextConfig,
      caps.contextRuntime,
    );
  },
});
