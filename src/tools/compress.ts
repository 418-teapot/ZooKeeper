/**
 * Range-mode compress tool adapter.
 *
 * Exposes the range-compression core (`src/core/pruning/range.ts`) as an
 * OpenCode tool so the model can compress a contiguous visible-history span
 * into a single model-written summary (zero extra API calls).
 *
 * The client and the parsed context-pruning config are captured by the
 * factory closure.  Each execution:
 *
 * 1. Resolves the session ID from the tool context (tolerates both
 *    `sessionID` and `sessionId` shapes).
 * 2. Fetches the full session messages (same unwrap + error check as the
 *    `/dcp` command path).
 * 3. Ensures the ref registry is populated (idempotent fallback — the
 *    transform pipeline normally does this).
 * 4. Drives the resolve → validate → apply pipeline.
 * 5. Persists the session state with `pendingViewChange`.
 * 6. Injects an ignored chat notification (best-effort).
 *
 * Loud Chinese guidance errors from the core propagate to the model
 * unchanged — the model self-corrects by re-picking refs and retrying.
 * The ToolResult is a single-line short summary (block id / message count /
 * reclaimed-token estimate), never the summary body.
 *
 * @module
 */

import { formatTokens } from "../core/context-report.js";
import type { ContextMessageEntry } from "../core/metrics.js";
import {
  applyRange,
  assignMessageRefs,
  type CompressionConfig,
  getOrCreateSessionState,
  resolveSpan,
  saveSessionState,
  snapshotRefs,
  validateRange,
} from "../core/pruning/index.js";
import type { DcpClient } from "../hooks/context-command/index.js";
import type { ContextPruningConfig } from "../hooks/context-pruning/index.js";
import { log } from "../utils/logger.js";

type JsonSchemaStringArg = {
  type: "string";
  description: string;
};

type CompressToolArgs = {
  fromRef: JsonSchemaStringArg;
  toRef: JsonSchemaStringArg;
  title: JsonSchemaStringArg;
  summary: JsonSchemaStringArg;
};

type CompressToolInput = {
  fromRef: string;
  toRef: string;
  title: string;
  summary: string;
};

export type CompressToolDefinition = {
  description: string;
  args: CompressToolArgs;
  execute(args: unknown, toolCtx: unknown): Promise<string>;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Check whether a string contains any ASCII or C1 control character.
 *
 * Covers the C0 controls (NUL..US, i.e. `\x00`..`\x1F`) plus the full
 * C1 range — DEL (`\x7F`) and the C1 controls (`\x80`..`\x9F`) — the
 * set that would break the single-line block header / index lines.
 *
 * @param value - The string to inspect.
 * @returns `true` when the string contains a control character.
 */
function hasControlCharacter(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
}

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

function requireStringArg(
  args: Record<string, unknown>,
  name: keyof CompressToolInput,
): string {
  const value = args[name];
  if (typeof value !== "string") {
    throw new Error(
      `${name} 参数必须是字符串：请按工具参数说明提供 fromRef、toRef、title、summary 四个必填字符串后重试。`,
    );
  }
  return value;
}

function validateCompressArgs(args: unknown): CompressToolInput {
  if (args === null || typeof args !== "object" || Array.isArray(args)) {
    throw new Error(
      "压缩工具参数格式错误：请提供包含 fromRef、toRef、title、summary 四个必填字符串的对象后重试。",
    );
  }

  const input = args as Record<string, unknown>;
  return {
    fromRef: requireStringArg(input, "fromRef"),
    toRef: requireStringArg(input, "toRef"),
    title: requireStringArg(input, "title"),
    summary: requireStringArg(input, "summary"),
  };
}

/**
 * Fetch the full session messages array.
 *
 * Mirrors the `/dcp` command path: unwraps `res.data ?? res` and checks
 * `res.error`, throwing loud Chinese errors on API failure.
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
      "compress-tool",
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
 * Create the range-mode compress tool.
 *
 * The client and the parsed context config are captured by the closure so
 * each `execute` call is self-contained.
 *
 * @param client - The OpenCode client (session.messages / session.prompt).
 * @param contextConfig - The parsed context-pruning config (compress gate
 *   + protection defaults).
 * @returns The OpenCode tool definition.
 */
export function createCompressTool(
  client: DcpClient,
  contextConfig: ContextPruningConfig,
): CompressToolDefinition {
  return {
    description: `压缩一段连续可见历史为一条摘要（该范围将被你的摘要替换）。

何时使用：

收到上下文压力提醒（nudge）建议压缩时，或你判断一段已完成的探索/
委派历史不再需要逐字保留时。压缩是非破坏性的——原文保留在会话存储
中，之后可用 decompress 工具按块召回。

消息寻址（REFS）：

- 可见消息带有 <zoo-msg-id>mNNNN</zoo-msg-id> 标签，fromRef/toRef
  使用此 ref（如 "m0001"）。
- ref 是地址而非序号，数值可能不连续——按阅读顺序（位置先后）选择
  起点与终点，不要按数字大小比较。
- 两个端点都必须当前可见。压缩范围到 toRef 之前为止（toRef 本身
  不压缩）。
- 不要凭记忆编造 ref——只使用当前可见消息上的标签。

压缩块：

- 已压缩的段显示为 [Compression Block bN] 块头加摘要。其上的 ref
  指向整块——用它作端点将消费整个块；范围必须完整覆盖该块，部分
  重叠会被拒绝并给出指导。
- 被消费块的索引行（--- bN: <title> ---）会自动加入新块摘要，无需
  手动提及。

保护边界：

- 末尾保护窗（最近若干条消息与 token 预算）与最后一条用户消息不可
  压，越界会被拒绝并给出可压范围。
- 会话第一条用户消息永远不可压。
- 收益不足的短段会被幻影门拒绝——选择更长的段。

参数：

- fromRef / toRef：范围端点 ref（规则如上）。
- title：一行主题（不超过 80 字符，单行纯文本，不含 "---"），此块
  日后被更大范围消费时作为索引行展示。
- summary：替换整个范围的完整摘要。保留关键决策、结论与文件路径，
  确保后续工作无需回看原文。

选择失败会返回响亮的中文错误指导——按提示重新选择后重试。`,
    args: {
      fromRef: {
        type: "string",
        description:
          '范围起点消息的 ref（如 "m0001"，对应消息上的 <zoo-msg-id> 标签）。该消息及其之后的内容将被压缩。ref 是地址而非序号，数值上可能不连续。',
      },
      toRef: {
        type: "string",
        description:
          "范围终点消息的 ref，压缩范围到该消息之前为止（该消息本身不压缩）。请选择位置在起点之后的可见消息。",
      },
      title: {
        type: "string",
        description:
          "一行主题说明（必填，不超过 80 字符）：概括这段被压缩内容，将来此块被更大范围压缩时作为索引行展示。",
      },
      summary: {
        type: "string",
        description:
          "块正文总结：替换整个压缩范围的完整摘要文本。请保留关键决策、结论与文件路径，确保后续工作无需回看原文。",
      },
    },
    async execute(args, toolCtx) {
      const sessionID = resolveSessionId(toolCtx);
      const input = validateCompressArgs(args);

      // ── Title validation (loud Chinese guidance) ───────────────────
      // The title becomes the block's one-line index entry when a wider
      // recompression consumes this block, so it must be short and
      // non-empty.
      const title = input.title.trim();
      if (title.length === 0) {
        throw new Error(
          "title 不能为空：请用一行不超过 80 字符的主题说明概括这段压缩内容（将来此块被更大范围压缩时，该主题会作为索引行展示）。",
        );
      }
      // Control characters (newline, carriage return, tab, NUL, BEL, DEL,
      // C1 controls, ...) would split the single-line block header / index
      // lines the title is interpolated into, so reject them up front.
      if (hasControlCharacter(title)) {
        throw new Error("title 必须用单行纯文本概括主题，不含换行或控制字符。");
      }
      // Runs of 3+ hyphens would visually merge with the `--- b<N>: <title>
      // ---` separators of superseded index lines, so reject them loudly —
      // the model retries with other punctuation.
      if (/-{3,}/.test(title)) {
        throw new Error(
          "title 不能包含三个及以上连续连字符（---），否则会破坏压缩块索引行的分隔格式。请改用其他标点（如破折号 ——）或文字分隔。",
        );
      }
      if (title.length > 80) {
        throw new Error(
          `title 过长（${title.length} 字符，超过 80 字符上限）：请压缩到 80 字符以内后重试。一行主题足够，详细内容请放进 summary。`,
        );
      }

      // Fetch full messages, then ensure the ref registry is populated
      // (idempotent re-entry by design — covers the empty-registry case).
      const messages = await fetchSessionMessages(client, sessionID);
      assignMessageRefs(sessionID, messages);

      // Build the compression config from the parsed context config with
      // NO fallbacks — config.toml is the single source of truth.  The
      // registration gate only registers the tool when the compress
      // section was strictly parsed with `enabled: true`, so the token
      // thresholds are guaranteed present; `protectedMessages` is a
      // lenient top-level key and may still be missing → loud config
      // guidance error.
      const compressCfg = contextConfig.compress;
      if (
        !compressCfg ||
        compressCfg.protectedTokens === undefined ||
        compressCfg.thresholdTokens === undefined
      ) {
        throw new Error(
          "压缩功能未启用：请在 config.toml 的 [zoo.context.compress] 段配置 enabled = true、threshold_tokens 与 protected_tokens（非负整数）后重试。",
        );
      }
      if (contextConfig.protectedMessages === undefined) {
        throw new Error(
          "[zoo.context] protected_messages 缺失或非法：请在 config.toml 的 [zoo.context] 段配置 protected_messages（非负整数）后重试。",
        );
      }
      const config: CompressionConfig = {
        protectedMessages: contextConfig.protectedMessages,
        protectedTokens: compressCfg.protectedTokens,
        thresholdTokens: compressCfg.thresholdTokens,
      };

      // Core pipeline: loud Chinese guidance errors propagate unchanged.
      const state = getOrCreateSessionState(sessionID);
      const span = resolveSpan(
        sessionID,
        messages,
        state,
        input.fromRef,
        input.toRef,
      );
      validateRange(span, messages, state, config);
      const block = applyRange(state, span, messages, input.summary, title);

      const msgCount = block.messageIds.length;
      const reclaimed = block.compressedTokens - block.summaryTokens;

      // Mark the view change and persist so the next transform folds the
      // new block (mirrors the command path).  Snapshot the ref registry
      // so refs survive a restart without renumbering (the folded view
      // would otherwise shift every ref after the folded region).
      state.pendingViewChange = true;
      const refsSnapshot = snapshotRefs(sessionID);
      if (refsSnapshot) state.refs = refsSnapshot;
      saveSessionState(sessionID, state);

      log("compress-tool", "compress_created", sessionID, undefined, "info", {
        blockId: block.blockId,
        messageCount: msgCount,
        compressedTokens: block.compressedTokens,
        summaryTokens: block.summaryTokens,
        title,
      });

      // Ignored chat notification (best-effort — compression already done).
      const notifyMsg = `上下文压缩：已压缩 ${msgCount} 条消息为压缩块 b${block.blockId}：${title}，约回收 ${formatTokens(reclaimed)} tokens`;
      try {
        await client?.session?.prompt?.({
          path: { id: sessionID },
          body: {
            noReply: true,
            parts: [{ type: "text", text: notifyMsg, ignored: true }],
          },
        });
      } catch (err) {
        log("compress-tool", "notify_failed", sessionID, undefined, "warn", {
          error: String(err),
        });
      }

      // Single-line short ToolResult — never the summary body.
      return notifyMsg;
    },
  };
}
