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
 * 3. Reads the round view published by the context transform — the
 *    frozen transcript snapshot plus the numbered fold the model was
 *    shown this round — so the refs it accepts address exactly the view
 *    the model sees.  Only when no round view exists yet (a call made
 *    before any transform ran) does it fall back to a host that
 *    guarantees a same-source history read, folding that snapshot
 *    itself; a host without that guarantee leaves the fallback unwired
 *    and the call fails as a tool error (unself-healable within the
 *    round, so it is never reported as a success-shaped string).
 * 4. Drives the core batch pipeline (resolve → validate → apply).  Every
 *    range is validated against the same snapshot; any invalid range
 *    rejects the whole call, leaving the state untouched.
 * 5. Books the reclaimed tokens as the nudge's reclaim credit, flags the
 *    pending view change, and persists the session state ONCE through the
 *    shared state manager.
 * 6. Posts a single ignored chat notification through the host.
 *
 * Every rejection is thrown as a tool error whose text is written in the
 * model's address space: per-range failures are aggregated (all of them,
 * each labelled with its 1-based range index and submitted refs) behind a
 * "本次压缩未生效" header, so the model re-picks refs and retries with the
 * whole picture instead of one failure at a time.  Config and wiring
 * errors say so explicitly — repeating the call cannot fix them.
 * The successful ToolResult is a single-line short summary (block ids /
 * message count / reclaimed-token estimate), never the summary bodies.
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
import type { Projection } from "../core/context/lens.js";
import { creditReclaim } from "../core/context/nudge.js";
import { getRoundView } from "../core/context/round-view.js";
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

export type CompressToolSpec = Omit<CompressToolDefinition, "execute">;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Validate one raw range item into a `CompressRangeInput`.
 *
 * Collects every field that is missing or not a string so one message
 * names them all, and always leads with the 1-based range position — in a
 * batch call the model has no other way to tell which item to fix.
 *
 * @param item - The raw range object.
 * @param position - The 1-based index of this range in `ranges`.
 * @returns The validated range input.
 * @throws A Chinese guidance error naming the position and the bad fields.
 */
function requireRangeFields(
  item: Record<string, unknown>,
  position: number,
): CompressRangeInput {
  const fields = ["fromRef", "toRef", "title", "summary"] as const;
  const values: Partial<Record<(typeof fields)[number], string>> = {};
  const bad: string[] = [];
  for (const field of fields) {
    const value = item[field];
    if (typeof value === "string") {
      values[field] = value;
    } else {
      bad.push(field);
    }
  }
  if (bad.length > 0) {
    throw new Error(
      `第 ${position} 个范围：${bad.join("、")} 参数必须是字符串` +
        (bad.length === fields.length
          ? "（四个字段全部缺失或类型错误）"
          : "（其余字段已提供）") +
        `。ranges 的每一项都必须同时包含 fromRef、toRef、title、summary 四个字符串，` +
        `请补齐该范围后重新提交整批范围。`,
    );
  }
  return values as CompressRangeInput;
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
    ranges.push(requireRangeFields(item as Record<string, unknown>, i + 1));
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
function buildCompressToolSpec(
  _contextConfig: ContextPruningConfig,
): CompressToolSpec {
  return {
    description:
      "将一段或多段连续的、不再需要逐字保留的历史消息压缩为摘要。每一段的压缩范围不能有重叠，且都应是独立的主题。" +
      "端点使用当轮视图的行号（如 m12）且两端都包含；行号仅对当轮有效，失效时重新读取视图。引用压缩块摘要行会把整个块纳入范围。",
    args: {
      ranges: {
        type: "array",
        description:
          "要压缩的范围数组，每项 {fromRef, toRef, title, summary}。任一范围校验失败时整批不生效，错误会列出全部失败范围。",
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
              description: "终点行号，该消息及其之前的内容会被压缩。",
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
    ...buildCompressToolSpec(contextConfig),
    async execute(args, toolCtx) {
      const sessionID = host.resolveSessionId(toolCtx);
      if (sessionID === undefined) {
        throw new Error(
          "无法压缩：工具上下文缺少 sessionID，会话状态无法定位。" +
            "这是宿主接线问题，重试本工具无法解决，需重启宿主或由用户处理。",
        );
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
          "[zoo.context.compress] 段缺失或非法：请在 config.toml 配置 " +
            "threshold_tokens、protected_tokens（非负整数）与 max_ranges（正整数），" +
            "并重新安装生效。配置错误不会因重试本工具而消失：请停止重试并告知用户修正配置。",
        );
      }
      if (contextConfig.protectedMessages === undefined) {
        throw new Error(
          "[zoo.context] protected_messages 缺失或非法：请在 config.toml 的 " +
            "[zoo.context] 段配置 protected_messages（非负整数），并重新安装生效。" +
            "配置错误不会因重试本工具而消失：请停止重试并告知用户修正配置。",
        );
      }

      // The history the model addressed is the round view published by
      // the last transform (frozen snapshot + numbered fold) — read it
      // back verbatim, never refolded.  Only a call made before any
      // transform ran (no round view) may fall back to a host history
      // read, and only for hosts that wire one (a host whose read path
      // is not provably the same source as the transform's projection
      // must leave `fetchHistory` unwired — then the call fails closed
      // with guidance instead of addressing a foreign ordinal space).
      const manager = getContextStateManager();
      const state = manager.get(sessionID);
      const cached = getRoundView(sessionID);
      let snapshot: Projection;
      let numbered: NumberedItem[];
      if (cached !== undefined) {
        snapshot = cached.projection;
        numbered = cached.numbered;
      } else if (host.fetchHistory !== undefined) {
        snapshot = await host.fetchHistory(sessionID);
        const { items } = fold(snapshot, state);
        numbered = numberView(
          items,
          (ordinal) => snapshot.messages[ordinal].hidden,
        );
      } else {
        log("compress-tool", "no_round_view", sessionID, undefined, "warn", {
          reason: "no published round view and no host history fallback",
        });
        // Not a retryable model error: the line numbers the model holds
        // cannot be resolved at all this round, and the same call made
        // again in this round fails identically.  Reported as a tool
        // failure so the host surfaces it as such — never a success-shaped
        // string that reads like a completed compression.
        throw new Error(
          "无法压缩：尚未取得当轮上下文视图（上下文变换本轮还未运行），" +
            "当前宿主也不提供同源的历史回退——行号无法定位到模型看到的视图。" +
            "本轮内重试结果相同，请等下一轮上下文变换运行后再压缩；" +
            "若每轮都如此，属于宿主配置问题，请告知用户处理。",
        );
      }

      // Compression options straight from the parsed config — no
      // fallbacks, config.toml is the single source of truth.
      const options: CompressOptions = {
        protectedMessages: contextConfig.protectedMessages,
        protectedTokens: compressCfg.protectedTokens,
        thresholdTokens: compressCfg.thresholdTokens,
        maxRanges: compressCfg.maxRanges,
      };
      // Core batch pipeline: the whole-call error (max_ranges overflow)
      // and the per-range failures both mean NOTHING was applied — the
      // core's per-range texts are written relative to the failing range,
      // so the range index is labelled exactly once here and every failure
      // of the call is reported together.
      const result = compressRanges(snapshot, numbered, state, options, ranges);

      if (result.error !== undefined) {
        throw new Error(`本次压缩未生效（会话状态未改动）：${result.error}`);
      }
      if (result.failed.length > 0) {
        const detail = result.failed
          .map(
            (failure) =>
              `- 第 ${failure.index} 个范围（${failure.range.fromRef} → ${failure.range.toRef}）：${failure.error}`,
          )
          .join("\n");
        throw new Error(
          `本次压缩未生效：${result.failed.length}/${ranges.length} 个范围校验失败，` +
            `会话状态未改动。请按下列提示修正后重新提交：\n${detail}`,
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
      //
      // The same figure is booked as the nudge's reclaim credit: the API
      // measurement the pressure level is read from comes from the call
      // that preceded this compression, so without the booking the water
      // level keeps counting tokens the compressed view has dropped.
      creditReclaim(state, reclaimed);
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
    const metadata = buildCompressToolSpec(deps.contextConfig);
    if (host === undefined) {
      return {
        kind: "tool",
        tools: [
          {
            name: "compress",
            ...metadata,
            execute: async () => {
              throw new Error(
                "compress 在当前宿主上不可用：没有宿主工具服务就无法定位会话与上下文视图。" +
                  "重试本工具无法解决，请告知用户或改用可用的宿主。",
              );
            },
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
