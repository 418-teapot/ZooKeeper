/**
 * `/dcp` command handling logic (sunk from the hooks layer).
 *
 * Provides the sentinel error, the `/dcp context|sweep [N]|compress`
 * handler, and the synthetic-message injection used to surface results
 * to the user.  Framework-agnostic by design: the client parameter is
 * typed against `src/core/context/dcp-client.ts` instead of any host
 * SDK type.
 *
 * @module
 */

import { log } from "../../utils/logger.js";
import type { ContextPruningConfig } from "../config-types.js";
import { formatContextReport, formatTokens } from "./context-report.js";
import type { DcpClient } from "./dcp-client.js";
import type { ContextMessageEntry } from "./metrics.js";
import { computeContextReport, isMessageIgnored } from "./metrics.js";
import {
  getOrCreateSessionState,
  liveBlocks,
  pendingCount as pendingCountDerived,
  pendingTokens as pendingTokensDerived,
  previewFold,
  reclaimedTokens as reclaimedTokensDerived,
  runSweep,
  saveSessionState,
  snapshotRefs,
} from "./pruning/index.js";

// ---------------------------------------------------------------------------
// Sentinel
// ---------------------------------------------------------------------------

/**
 * Error thrown after a `/dcp` command is handled to short-circuit
 * the `command()` flow and prevent the LLM from processing it.
 */
export const DCP_COMMAND_HANDLED = new Error(
  "/dcp command handled — no user message needed",
);

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * Handle the `/dcp` command.
 *
 * - `""` or `"context"` → fetches session messages, computes a context
 *   report, and injects it as an ignored (LLM-invisible) message.
 * - `"compress"` → arms a one-shot in-memory trigger; the next transform
 *   injects a synthetic user message driving the model to call the
 *   `compress` tool.
 * - Any other argument → shows a short help listing available subcommands.
 *
 * @param client - OpenCode client providing session APIs.
 * @param sessionID - The current session identifier.
 * @param args - The raw arguments string after `/dcp`.
 * @param contextConfig - Optional context pruning config (needed for
 *   the compress enable gate).  When absent, compress is skipped.
 * @throws Error when the messages API or prompt API is unavailable.
 */
export async function handleDcpCommand(
  client: DcpClient | null | undefined,
  sessionID: string,
  args: string,
  contextConfig?: ContextPruningConfig,
): Promise<void> {
  const trimmed = args.trim();

  // ── Sweep subcommand ──────────────────────────────────────────────
  if (trimmed === "sweep" || trimmed.startsWith("sweep ")) {
    await handleSweepSubcommand(client, sessionID, trimmed);
    return;
  }

  // ── Compress subcommand ──────────────────────────────────────────
  if (trimmed === "compress") {
    await handleCompressSubcommand(
      client,
      sessionID,
      contextConfig ?? { dedup: {}, purgeErrors: {} },
    );
    return;
  }

  // ── Unknown subcommand → show help ────────────────────────────────
  if (trimmed !== "" && trimmed !== "context") {
    const help = [
      "━━  用法 ━━",
      "",
      "/dcp context    — 显示上下文用量与缓存命中率",
      "/dcp            — 同上（默认）",
      "/dcp sweep      — 标记所有工具输出以在下一轮回收",
      "/dcp sweep N    — 标记最近 N 个工具输出",
      "/dcp compress   — 在下一轮触发模型驱动的历史压缩",
    ].join("\n");

    if (client?.session?.prompt) {
      await client.session.prompt({
        path: { id: sessionID },
        body: {
          noReply: true,
          parts: [{ type: "text", text: help, ignored: true }],
        },
      });
    }
    return;
  }

  // ── Fetch messages ────────────────────────────────────────────────
  if (!client?.session?.messages) {
    throw new Error("无法获取会话消息：会话消息 API 不可用");
  }

  let rawMessages: unknown;
  try {
    const res = await client.session.messages({
      path: { id: sessionID },
    });
    rawMessages = res;
  } catch (err) {
    log(
      "context-command",
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

  // Defensive: some SDKs wrap in { data: ..., error: ... }
  const rawObj = rawMessages as {
    data?: unknown;
    error?: { message?: string };
  };
  if (rawObj.error) {
    const msg = rawObj.error.message ?? String(rawObj.error);
    throw new Error(`获取会话消息失败：${msg}`);
  }
  const messages: ContextMessageEntry[] = (rawObj.data ??
    rawMessages) as ContextMessageEntry[];

  if (!Array.isArray(messages)) {
    throw new Error("会话消息格式异常：期望数组");
  }

  // ── Compute & format report ───────────────────────────────────────
  // Use in-memory session state so the tool category excludes pruned
  // tools and the unified "回收" stat line reflects the current
  // in-process cumulative values (avoids the one-turn lag of reading
  // from disk when the batch pipeline modifies state between transforms).
  let prunedCallIDs: Set<string> | undefined;
  let totalEff = 0;
  let curPendingCount = 0;
  let curPendingTokens = 0;
  let state: ReturnType<typeof getOrCreateSessionState> | undefined;
  try {
    state = getOrCreateSessionState(sessionID);
    prunedCallIDs = new Set(
      [...state.marks.entries()]
        .filter(([, mark]) => mark.effective)
        .map(([callID]) => callID),
    );
    totalEff = reclaimedTokensDerived(state);
    curPendingCount = pendingCountDerived(state);
    curPendingTokens = pendingTokensDerived(state);
  } catch {
    // Defensive: I/O failure is non-fatal — tools fully counted.
    prunedCallIDs = undefined;
  }
  // ── Compute dual-scope message counts (folded view vs storage) ──────
  let foldedCount: number | undefined;
  let storageCount: number | undefined;
  try {
    if (state) {
      const stateBlocks: import("./pruning/index.js").CompressionBlock[] = [];
      for (const [, block] of state.blocks) {
        stateBlocks.push(block);
      }
      const live = liveBlocks(stateBlocks, messages);
      const folded = previewFold(messages, live);
      foldedCount = folded.filter((m) => !isMessageIgnored(m)).length;
      storageCount = messages.filter((m) => !isMessageIgnored(m)).length;
    }
  } catch {
    // Defensive: error is non-fatal, fall back to single-count line.
  }

  const report = computeContextReport(messages, prunedCallIDs);
  const formatted = formatContextReport(report, {
    prunedTokens: totalEff,
    pendingCount: curPendingCount,
    pendingTokens: curPendingTokens,
    state,
    foldedMessageCount: foldedCount,
    storageMessageCount: storageCount,
  });

  log("context-command", "report_computed", sessionID, undefined, "info", {
    total: report.total,
    exact: report.exact,
    heuristic: report.heuristic,
    messageCount: report.messageCount,
  });

  // ── Inject as ignored message (chat-visible, LLM-invisible) ───────
  if (client?.session?.prompt) {
    try {
      await client.session.prompt({
        path: { id: sessionID },
        body: {
          noReply: true,
          parts: [{ type: "text", text: formatted, ignored: true }],
        },
      });
    } catch (err) {
      log(
        "context-command",
        "prompt_inject_failed",
        sessionID,
        undefined,
        "warn",
        { error: String(err) },
      );
      // Non-fatal — the report was already computed, inform the user
      throw new Error(
        `报告已生成但注入聊天失败（不影响使用）：${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Sweep subcommand handler
// ---------------------------------------------------------------------------

/**
 * Parse the numeric argument from a `/dcp sweep N` command.
 *
 * @param trimmed - The full arguments string (e.g. `"sweep 5"`).
 * @returns The count, or `undefined` for no-arg (`"sweep"`).
 */
export function parseSweepCount(trimmed: string): number | undefined {
  if (trimmed === "sweep") return undefined;
  const rest = trimmed.slice(5).trim(); // after "sweep"
  const n = Number(rest);
  if (!Number.isFinite(n) || n < 1 || !Number.isInteger(n)) {
    throw new Error("用法：/dcp sweep [N]，N 为要标记的工具输出数量（正整数）");
  }
  return n;
}

/**
 * Handle the `/dcp sweep` and `/dcp sweep N` subcommands.
 *
 * 1. Parses the count argument (optional).
 * 2. Fetches session messages.
 * 3. Collects tool call IDs for marking.
 * 4. Stores marks via addMark (writes to `state.marks`).
 * 5. Injects an ignored message reporting how many tools were marked
 *    and the estimated token reclaim.
 * 6. Returns normally — the caller in opencode.ts handles the sentinel
 *    throw to short-circuit the command flow.
 *
 * @param client - OpenCode client providing session APIs.
 * @param sessionID - The current session identifier.
 * @param trimmed - The full arguments string (e.g. `"sweep"`, `"sweep 3"`).
 * @throws Error on API failures or invalid arguments.
 */
async function handleSweepSubcommand(
  client: DcpClient | null | undefined,
  sessionID: string,
  trimmed: string,
): Promise<void> {
  const count = parseSweepCount(trimmed);

  // ── Fetch messages ──────────────────────────────────────────────
  if (!client?.session?.messages) {
    throw new Error("无法获取会话消息：会话消息 API 不可用");
  }

  let rawMessages: unknown;
  try {
    const res = await client.session.messages({
      path: { id: sessionID },
    });
    rawMessages = res;
  } catch (err) {
    log(
      "context-command",
      "sweep_fetch_failed",
      sessionID,
      undefined,
      "error",
      {
        error: String(err),
      },
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

  // ── Run sweep producer (collects + marks in one call) ────────────
  const state = getOrCreateSessionState(sessionID);
  const marks = runSweep(state, messages, { count });

  if (marks.length === 0) {
    // ── Nothing to mark ───────────────────────────────────────────
    const msg = "没有找到可标记的工具输出";
    if (client?.session?.prompt) {
      await client.session.prompt({
        path: { id: sessionID },
        body: {
          noReply: true,
          parts: [{ type: "text", text: msg, ignored: true }],
        },
      });
    }
    return;
  }

  // runSweep already wrote marks via addMark and set dirty.
  // Total estimate from the new marks.
  // Refresh the ref snapshot (piggyback — never per-turn writes) so the
  // persist below keeps refs stable across a restart.
  const totalEstimate = marks.reduce((sum, m) => sum + m.estimatedTokens, 0);
  const sweepRefsSnapshot = snapshotRefs(sessionID);
  if (sweepRefsSnapshot) state.refs = sweepRefsSnapshot;
  saveSessionState(sessionID, state);

  log("context-command", "sweep_marked", sessionID, undefined, "info", {
    markedCount: marks.length,
    totalEstimatedTokens: totalEstimate,
  });

  // ── Inject result message ───────────────────────────────────────
  const reportMsg = [
    `已标记 ${marks.length} 个工具输出，预计可回收 ${formatTokens(totalEstimate)} tokens`,
    "这些工具的输出将在下一轮 LLM 调用中被替换为占位文本。",
  ].join("\n");

  if (client?.session?.prompt) {
    try {
      await client.session.prompt({
        path: { id: sessionID },
        body: {
          noReply: true,
          parts: [{ type: "text", text: reportMsg, ignored: true }],
        },
      });
    } catch (err) {
      log(
        "context-command",
        "sweep_prompt_inject_failed",
        sessionID,
        undefined,
        "warn",
        { error: String(err) },
      );
      throw new Error(
        `标记已完成但通知失败：${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return;
}

// ---------------------------------------------------------------------------
// Compress subcommand handler
// ---------------------------------------------------------------------------

/**
 * Handle the `/dcp compress` subcommand.
 *
 * The command no longer runs a mechanical compression pipeline.  It arms
 * a per-session one-shot in-memory flag (`state.pendingManualTrigger`),
 * then the NEXT transform appends a synthetic user message
 * (`zoo-manual-compress`) that drives the model to call the `compress`
 * tool — command and tool now share a single model-driven path.
 *
 * 1. Checks the master enable gate — disabled config skips with a notice.
 * 2. Sets `state.pendingManualTrigger = true` (in-memory only, never
 *    persisted — same discipline as `pendingViewChange`; loss on restart
 *    is benign).
 * 3. Sends a single ignored notification telling the user the trigger
 *    will fire on the next turn.
 *
 * No message fetch, no blocks, no plan — the flag is consumed by the
 * transform's injection phase (context-pruning hook, Phase 6b).
 *
 * @param client - OpenCode client providing session APIs.
 * @param sessionID - The current session identifier.
 * @param contextConfig - The parsed context pruning config (needed for
 *   the compress enable gate).
 * @throws Error on API failures or invalid config.
 */
async function handleCompressSubcommand(
  client: DcpClient | null | undefined,
  sessionID: string,
  contextConfig: ContextPruningConfig,
): Promise<void> {
  // ── Enable gate ──────────────────────────────────────────────────
  // The compress section must be strictly parsed AND enabled.  Absent
  // section, an invalid section (config parse dropped it), or an explicit
  // `enabled = false` all refuse (the config parse already warned once
  // for bad keys).
  const compressCfg = contextConfig.compress;
  if (
    compressCfg?.enabled !== true ||
    compressCfg.protectedTokens === undefined ||
    compressCfg.thresholdTokens === undefined
  ) {
    const msg =
      "压缩功能未启用（[zoo.context.compress].enabled 未配置为 true）";
    if (client?.session?.prompt) {
      await client.session.prompt({
        path: { id: sessionID },
        body: {
          noReply: true,
          parts: [{ type: "text", text: msg, ignored: true }],
        },
      });
    }
    return;
  }

  // ── Arm the one-shot manual trigger ─────────────────────────────
  // In-memory only: never persisted, never fetched.  The next transform
  // consumes the flag and injects the synthetic user command.
  const state = getOrCreateSessionState(sessionID);
  state.pendingManualTrigger = true;

  log("context-command", "compress_armed", sessionID, undefined, "info", {
    trigger: "pendingManualTrigger",
  });

  // ── Notification ───────────────────────────────────────────────
  const notifyMsg =
    "已标记手动压缩：将在下一轮对话自动触发。届时会注入压缩指令，由模型调用 compress 工具执行。";

  if (client?.session?.prompt) {
    try {
      await client.session.prompt({
        path: { id: sessionID },
        body: {
          noReply: true,
          parts: [{ type: "text", text: notifyMsg, ignored: true }],
        },
      });
    } catch (err) {
      log(
        "context-command",
        "compress_notify_failed",
        sessionID,
        undefined,
        "warn",
        { error: String(err) },
      );
      throw new Error(
        `压缩触发已标记但通知失败：${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
