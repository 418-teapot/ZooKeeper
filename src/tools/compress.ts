/**
 * Batch range-mode compress tool adapter.
 *
 * Exposes the ordinal-based batch compression core
 * (`compressRanges` in `src/core/context/compress.ts`) as a host tool so
 * the model can compress N contiguous visible-history spans into N
 * model-written summaries in ONE call (zero extra API calls).
 *
 * The host tool services and the parsed context-pruning config are
 * captured by the factory closure.  Each execution:
 *
 * 1. Resolves the session ID from the tool context through the host.
 * 2. Validates the `ranges` argument (array of `{fromRef, toRef, title,
 *    summary}`); per-range title rules and the `max_ranges` upper bound
 *    are enforced by the core with loud batch guidance BEFORE any range
 *    is applied.
 * 3. Fetches the full session messages as a host-agnostic transcript
 *    through the host.
 * 4. Folds the transcript with the shared session state and numbers the
 *    visible view — the per-round line-number address space the model
 *    references (`mN` / `[mN]`).
 * 5. Drives the core batch pipeline (resolve → validate → apply).  Every
 *    range is validated against the same snapshot; any invalid range
 *    rejects the whole call naming the 1-based range index, leaving the
 *    state untouched.
 * 6. Flags the pending view change and persists the session state ONCE
 *    through the shared state manager.
 * 7. Posts a single ignored chat notification through the host.
 *
 * Loud Chinese guidance errors from the core propagate to the model
 * unchanged — the model self-corrects by re-picking refs and retrying.
 * The ToolResult is a single-line short summary (block ids / message
 * count / reclaimed-token estimate), never the summary bodies.
 *
 * @module
 */

import type { ToolHost } from "../core/client/tool-host.js";
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
  required?: string[];
  execute(args: unknown, toolCtx: unknown): Promise<string>;
};

export type CompressToolMetadata = Omit<CompressToolDefinition, "execute">;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
export function validateCompressArgs(args: unknown): CompressToolInput {
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
 * Build the host-independent compress tool metadata.
 *
 * The description and JSON-schema args depend only on the parsed context
 * config, not on host services.
 *
 * @param _contextConfig - The parsed context-pruning config.
 * @returns The tool description and args schema.
 */
function buildCompressToolMetadata(
  _contextConfig: ContextPruningConfig,
): CompressToolMetadata {
  return {
    description: `将一段或多段连续的、不再需要逐字保留的历史消息压缩为摘要。每一段的压缩范围不能有重叠，且都应是独立的主题。`,
    args: {
      ranges: {
        type: "array",
        description:
          "要压缩的范围数组，每项 {fromRef, toRef, title, summary}。",
        items: {
          type: "object",
          description: "压缩范围（一段连续的历史消息）。",
          properties: {
            fromRef: {
              type: "string",
              description: "起点行号，该消息及其之后的内容会被压缩。",
            },
            toRef: {
              type: "string",
              description: "终点行号，该消息之前的内容会被压缩。",
            },
            title: {
              type: "string",
              description: "标题，不超过 80 字符的单行。",
            },
            summary: {
              type: "string",
              description: "摘要，用于替换压缩范围内的原文。",
            },
          },
          required: ["fromRef", "toRef", "title", "summary"],
        },
      },
    },
    required: ["ranges"],
  };
}

/**
 * Create the batch range-mode compress tool.
 *
 * The host and the parsed context config are captured by the closure so
 * each `execute` call is self-contained.
 *
 * @param host - The host tool services (session resolution, history,
 *   best-effort notification).
 * @param contextConfig - The parsed context-pruning config (compress gate
 *   + protection defaults + max_ranges).
 * @returns The compress tool definition.
 */
export function createCompressTool(
  host: ToolHost,
  contextConfig: ContextPruningConfig,
): CompressToolDefinition {
  return {
    ...buildCompressToolMetadata(contextConfig),
    async execute(args, toolCtx) {
      const sessionID = host.resolveSessionId(toolCtx);
      if (sessionID === undefined) {
        throw new Error("无法确定会话 ID：工具上下文缺少 sessionID。");
      }
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

      // Fetch full messages as the host-agnostic transcript and build the
      // folded, line-numbered view of the current round.
      const view = await host.fetchHistory(sessionID);
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
        await host.notify(sessionID, notifyMsg);
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
    const host = deps.toolHost;
    const metadata = buildCompressToolMetadata(deps.contextConfig);
    if (host === undefined) {
      return {
        kind: "tool",
        tools: [
          {
            name: "compress",
            ...metadata,
            execute: async () => "此工具在当前 host 上不可用。",
          },
        ],
      };
    }
    return {
      kind: "tool",
      tools: [
        { name: "compress", ...createCompressTool(host, deps.contextConfig) },
      ],
    };
  },
};
