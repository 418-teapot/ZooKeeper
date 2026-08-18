/**
 * Batch range-mode compress tool adapter.
 *
 * Exposes the ordinal-based batch compression core
 * (`compressRanges` in `src/core/context/compress.ts`) as an OpenCode
 * tool so the model can compress N contiguous visible-history spans
 * into N model-written summaries in ONE call (zero extra API calls).
 *
 * The client and the parsed context-pruning config are captured by the
 * factory closure.  Each execution:
 *
 * 1. Resolves the session ID from the tool context (tolerates both
 *    `sessionID` and `sessionId` shapes).
 * 2. Validates the `ranges` argument (array of `{fromRef, toRef, title,
 *    summary}`); per-range title rules and the `max_ranges` upper bound
 *    are enforced by the core with loud batch guidance BEFORE any range
 *    is applied.
 * 3. Fetches the full session messages (same unwrap + error check as the
 *    `/dcp` command path) and maps them to the host-agnostic transcript
 *    through the v1 adapter (`history`).
 * 4. Folds the transcript with the shared session state and numbers the
 *    visible view — the per-round line-number address space the model
 *    references (`mN` / `[mN]`).
 * 5. Drives the core batch pipeline (resolve → validate → apply).  Every
 *    range is validated against the same snapshot; any invalid range
 *    rejects the whole call naming the 1-based range index, leaving the
 *    state untouched.
 * 6. Flags the pending view change and persists the session state ONCE
 *    through the shared state manager.
 * 7. Injects a single ignored chat notification covering all blocks.
 *
 * Loud Chinese guidance errors from the core propagate to the model
 * unchanged — the model self-corrects by re-picking refs and retrying.
 * The ToolResult is a single-line short summary (block ids / message
 * count / reclaimed-token estimate), never the summary bodies.
 *
 * @module
 */

import { history } from "../adapters/opencode/history.js";
import type { ContextMessageEntry } from "../adapters/opencode/types.js";
import type { SessionClient } from "../core/client/session.js";
import type { ContextPruningConfig } from "../core/config-types.js";
import {
  type CompressOptions,
  type CompressRangeInput,
  compressRanges,
} from "../core/context/compress.js";
import { formatTokens } from "../core/context/context-report.js";
import { fold } from "../core/context/fold.js";
import {
  getContextStateManager,
  setPendingViewChange,
} from "../core/context/runtime.js";
import type { Block, SessionState } from "../core/context/state.js";
import { type NumberedItem, numberView } from "../core/context/view-refs.js";
import { COMPRESS_GUIDANCE } from "../core/prompts.js";
import type { ToolUnitDescriptor } from "../core/slots.js";
import { log } from "../utils/logger.js";

type JsonSchemaStringArg = {
  type: "string";
  description: string;
};

type JsonSchemaObjectArg = {
  type: "object";
  description: string;
  properties: {
    fromRef: JsonSchemaStringArg;
    toRef: JsonSchemaStringArg;
    title: JsonSchemaStringArg;
    summary: JsonSchemaStringArg;
  };
  required: string[];
};

type CompressToolArgs = {
  ranges: {
    type: "array";
    description: string;
    items: JsonSchemaObjectArg;
  };
};

type CompressToolInput = {
  ranges: CompressRangeInput[];
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
  item: Record<string, unknown>,
  name: keyof CompressRangeInput,
): string {
  const value = item[name];
  if (typeof value !== "string") {
    throw new Error(
      `${name} 参数必须是字符串：ranges 数组的每一项都必须包含 fromRef、toRef、title、summary 四个必填字符串后重试。`,
    );
  }
  return value;
}

/**
 * Validate the raw tool arguments into a `ranges` array of items.
 *
 * Rejects missing / non-array / empty `ranges` and non-object items with
 * loud Chinese guidance.  Field type checks live here so malformed items
 * never reach the core.
 *
 * @param args - The raw tool arguments.
 * @returns The validated ranges.
 */
function validateCompressArgs(args: unknown): CompressToolInput {
  if (args === null || typeof args !== "object" || Array.isArray(args)) {
    throw new Error(
      "压缩工具参数格式错误：请提供包含 ranges 数组的对象（ranges 的每一项为 {fromRef, toRef, title, summary} 四个必填字符串）后重试。",
    );
  }
  const input = args as Record<string, unknown>;
  if (!Array.isArray(input.ranges)) {
    throw new Error(
      "压缩工具参数格式错误：ranges 必须是数组，其每一项为 {fromRef, toRef, title, summary} 四个必填字符串。请将想要压缩的每一段作为一个范围提交。",
    );
  }
  if (input.ranges.length === 0) {
    throw new Error(
      "压缩工具参数格式错误：ranges 不能为空。请至少提供一个范围（{fromRef, toRef, title, summary}），或分批提交。",
    );
  }
  const ranges: CompressRangeInput[] = [];
  for (let i = 0; i < input.ranges.length; i++) {
    const item = input.ranges[i];
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(
        `第 ${i + 1} 个范围格式错误：ranges 的每一项必须是包含 fromRef、toRef、title、summary 四个必填字符串的对象。`,
      );
    }
    const record = item as Record<string, unknown>;
    ranges.push({
      fromRef: requireStringArg(record, "fromRef"),
      toRef: requireStringArg(record, "toRef"),
      title: requireStringArg(record, "title"),
      summary: requireStringArg(record, "summary"),
    });
  }
  return { ranges };
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
  client: SessionClient,
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

/**
 * Map the created blocks to their persistent block ids.
 *
 * The core's `Block` records carry no id — the id is the block-map key
 * (`bN`).  The created objects are the same references inserted into
 * `state.blocks`, so identity matching recovers each id in request
 * order.
 *
 * @param state - The session state (block map).
 * @param created - The blocks created by the call, in request order.
 * @returns The persistent block ids in the same order.
 */
function createdBlockIds(state: SessionState, created: Block[]): number[] {
  const idByBlock = new Map<Block, number>();
  for (const [id, block] of state.blocks) {
    idByBlock.set(block, id);
  }
  const ids: number[] = [];
  for (const block of created) {
    const id = idByBlock.get(block);
    if (id !== undefined) ids.push(id);
  }
  return ids;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create the batch range-mode compress tool.
 *
 * The client and the parsed context config are captured by the closure so
 * each `execute` call is self-contained.
 *
 * @param client - The OpenCode client (session.messages / session.prompt).
 * @param contextConfig - The parsed context-pruning config (compress gate
 *   + protection defaults + max_ranges).
 * @returns The OpenCode tool definition.
 */
export function createCompressTool(
  client: SessionClient,
  contextConfig: ContextPruningConfig,
): CompressToolDefinition {
  return {
    description: `压缩一段或多段连续可见历史为摘要（每个范围将被你的摘要替换）。

何时使用：

收到上下文压力提醒（nudge）建议压缩时，或你判断一段已完成的探索/委派历史不再需要逐字保留时。压缩是非破坏性的——原文保留在会话存储中，之后可用 decompress 工具按块召回。

${COMPRESS_GUIDANCE}

消息寻址（行号）：

- 每条可见消息以 [mN] 前缀编号（如 [m3]），fromRef/toRef 使用此编号（"m3" 或 "[m3]" 均可）。
- 行号是当轮视图的地址而非序号，每轮重新编号——只引用当前可见消息行首的编号，不要凭记忆编造，也不要跨轮复用。
- 两个端点都必须当前可见，起点须在终点之前。范围覆盖 fromRef 与 toRef 之间的全部连续消息（两端点均包含）；端点落在压缩块摘要上时覆盖整个块。
- 压缩块覆盖的消息不再占用行号——引用已压入块内容的消息行号会得到"行号不存在"的指导，可先用 decompress 恢复该块再压缩。

压缩块：

- 已压入压缩块的段显示为 [Block bN · K 条] 块头加摘要，其覆盖的消息不再占用行号。bN 是块在会话中的持久编号——用作端点将消费整个块；范围必须完整覆盖该块，部分重叠会被拒绝并给出指导。
- 被消费块的索引行（--- bN: <title> ---）会自动加入新块摘要，无需手动提及。

保护边界：

- 末尾保护窗（最近若干条消息与 token 预算）与最后一条用户消息不可压，越界会被拒绝并给出可压范围。
- 会话第一条用户消息永远不可压。
- 收益不足的短段会被幻影门拒绝——选择更长的段。

批量提交（ranges）：

- 一次调用通过 ranges 数组提交多个范围，每个范围独立建块。先全校验后统一生效——任一范围非法，整次调用被拒绝并指明第几个范围。
- 范围必须互不重叠，且不得消费同一次调用内其他范围刚创建的块。
- 单次调用最多提交 max_ranges 个范围，超限会被拒绝——请分批提交。

参数：

- ranges：数组，每项为 {fromRef, toRef, title, summary}。
- fromRef / toRef：范围端点的当轮行号（"m3" 或 "[m3]"），规则如上。
- title：一行主题（不超过 80 字符，单行纯文本，不含 "---"），此块日后被更大范围消费时作为索引行展示。
- summary：替换整个范围的完整摘要。保留关键决策、结论与文件路径，确保后续工作无需回看原文。

选择失败会返回响亮的中文错误指导——按提示重新选择后重试。`,
    args: {
      ranges: {
        type: "array",
        description:
          "要压缩的范围数组，每项为 {fromRef, toRef, title, summary}。所有范围先统一校验、任一非法整次拒绝；范围必须互不重叠；单次调用不超过 max_ranges 个。",
        items: {
          type: "object",
          description: "一个压缩范围（一段连续可见历史）。",
          properties: {
            fromRef: {
              type: "string",
              description:
                '范围起点消息的当轮行号（如 "m3" 或 "[m3]"，对应可见消息行首的 [mN] 前缀）。该消息及其之后的内容将被压缩。行号是地址而非序号，每轮重新编号——请从当前视图行首标记中取用。',
            },
            toRef: {
              type: "string",
              description:
                "范围终点消息的当轮行号，范围覆盖 fromRef 与 toRef 之间的全部连续消息（两端点均包含）。请选择位置在起点之后的可见消息行号。",
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
          required: ["fromRef", "toRef", "title", "summary"],
        },
      },
    },
    async execute(args, toolCtx) {
      const sessionID = resolveSessionId(toolCtx);
      const { ranges } = validateCompressArgs(args);

      // ── Build the compression options from the parsed context config
      // with NO fallbacks — config.toml is the single source of truth.
      // The registration gate only registers the tool when the profile's
      // tools list names it, so reaching execute means the tool is
      // enabled by the profile; the token thresholds AND max_ranges are
      // guaranteed present by the strict parse.  `protectedMessages` is
      // a lenient top-level key and may still be missing → loud config
      // guidance error.
      const compressCfg = contextConfig.compress;
      if (
        !compressCfg ||
        compressCfg.protectedTokens === undefined ||
        compressCfg.thresholdTokens === undefined ||
        compressCfg.maxRanges === undefined
      ) {
        throw new Error(
          "[zoo.context.compress] 段缺失或非法：请在 config.toml 配置 threshold_tokens、protected_tokens（非负整数）与 max_ranges（正整数）后重试。",
        );
      }
      if (contextConfig.protectedMessages === undefined) {
        throw new Error(
          "[zoo.context] protected_messages 缺失或非法：请在 config.toml 的 [zoo.context] 段配置 protected_messages（非负整数）后重试。",
        );
      }

      // Fetch full messages, then build the host-agnostic transcript and
      // the folded, line-numbered view of the current round.
      const messages = await fetchSessionMessages(client, sessionID);
      const view = history(messages);
      const manager = getContextStateManager();
      const state = manager.get(sessionID);
      const { items } = fold(view, state);
      const numbered: NumberedItem[] = numberView(
        items,
        (ordinal) => view[ordinal].hidden,
      );

      // Core batch pipeline: loud Chinese guidance errors come back as a
      // whole-call error (max_ranges overflow) or per-range failures
      // (already range-indexed by the core).
      const options: CompressOptions = {
        protectedMessages: contextConfig.protectedMessages,
        protectedTokens: compressCfg.protectedTokens,
        thresholdTokens: compressCfg.thresholdTokens,
        maxRanges: compressCfg.maxRanges,
      };
      const result = compressRanges(view, numbered, state, options, ranges);

      if (result.error !== undefined) {
        throw new Error(result.error);
      }
      if (result.failed.length > 0) {
        const failure = result.failed[0];
        // Core span-resolution errors are not range-indexed; prefix them
        // with the range index the legacy contract exposed.  Title and
        // cross-range errors already carry their range index verbatim.
        const indexed = failure.error.startsWith(`第 ${failure.index} 个范围`);
        throw new Error(
          indexed
            ? failure.error
            : `第 ${failure.index} 个范围校验失败：${failure.error}`,
        );
      }

      const blockIds = createdBlockIds(state, result.created)
        .map((id) => `b${id}`)
        .join("、");
      const msgCount = result.created.reduce(
        (s, b) => s + (b.end - b.start),
        0,
      );
      const reclaimed = result.created.reduce(
        (s, b) => s + (b.compressedTokens - b.summaryTokens),
        0,
      );

      // The view differs next round (new fold blocks) — flag the view
      // change and persist ONCE so the next transform folds the new
      // blocks and its release phase flushes pending marks.
      setPendingViewChange(sessionID);
      manager.save(sessionID);

      log("compress-tool", "compress_created", sessionID, undefined, "info", {
        blockIds: createdBlockIds(state, result.created),
        rangeCount: result.created.length,
        messageCount: msgCount,
        reclaimedTokens: reclaimed,
        titles: result.created.map((b) => b.title),
      });

      // Ignored chat notification (best-effort — compression already done).
      const notifyMsg =
        result.created.length === 1
          ? `上下文压缩：已压缩 ${msgCount} 条消息为压缩块 ${blockIds}：${result.created[0].title}，约回收 ${formatTokens(reclaimed)} tokens`
          : `上下文压缩：已压缩 ${result.created.length} 个范围，共 ${msgCount} 条消息（${blockIds}），约回收 ${formatTokens(reclaimed)} tokens`;
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

      // Single-line short ToolResult — never the summary bodies.
      return notifyMsg;
    },
  };
}

/**
 * Compress tool unit descriptor.
 *
 * The tool contribution carries the batch range-mode compress adapter;
 * `name` doubles as the registry key and the tool key.
 */
export const unit: ToolUnitDescriptor = {
  name: "compress",
  kind: "tool",
  create(deps) {
    return {
      kind: "tool",
      tools: [
        {
          name: "compress",
          ...createCompressTool(deps.client, deps.contextConfig),
        },
      ],
    };
  },
};
