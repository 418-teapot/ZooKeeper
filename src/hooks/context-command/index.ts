/**
 * Context command hook barrel export.
 *
 * Provides the `/dcp context` command handler and sentinel error
 * constant for the OpenCode plugin.
 *
 * @module
 */

import {
  formatContextReport,
  formatTokens,
} from "../../core/context-report.js";
import type { ContextMessageEntry } from "../../core/metrics.js";
import { computeContextReport } from "../../core/metrics.js";
import {
  collectSweepCallIDs,
  getOrCreateSessionState,
  loadSessionState,
} from "../../core/pruning/index.js";
import { log } from "../../utils/logger.js";

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
// Types
// ---------------------------------------------------------------------------

/**
 * Minimal client interface required for the `/dcp` command handler.
 *
 * Only the APIs used by `handleDcpCommand` are declared.
 */
export interface DcpClient {
  session?: {
    messages?: (input: {
      path: { id: string };
    }) => Promise<{ data?: unknown } | unknown[]>;
    prompt?: (input: {
      path: { id: string };
      body: {
        noReply?: boolean;
        parts: Array<{ type: "text"; text: string; ignored?: boolean }>;
      };
    }) => Promise<unknown>;
  };
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * Handle the `/dcp` command.
 *
 * - `""` or `"context"` → fetches session messages, computes a context
 *   report, and injects it as an ignored (LLM-invisible) message.
 * - Any other argument → shows a short help listing available subcommands.
 *
 * @param client - OpenCode client providing session APIs.
 * @param sessionID - The current session identifier.
 * @param args - The raw arguments string after `/dcp`.
 * @throws Error when the messages API or prompt API is unavailable.
 */
export async function handleDcpCommand(
  client: DcpClient | null | undefined,
  sessionID: string,
  args: string,
): Promise<void> {
  const trimmed = args.trim();

  // ── Sweep subcommand ──────────────────────────────────────────────
  if (trimmed === "sweep" || trimmed.startsWith("sweep ")) {
    await handleSweepSubcommand(client, sessionID, trimmed);
    return;
  }

  // ── Unknown subcommand → show help ────────────────────────────────
  if (trimmed !== "" && trimmed !== "context") {
    const help = [
      "━━  用法 ━━",
      "",
      "/dcp context   — 显示上下文用量与缓存命中率",
      "/dcp           — 同上（默认）",
      "/dcp sweep     — 标记所有工具输出以在下一轮回收",
      "/dcp sweep N   — 标记最近 N 个工具输出",
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
  // Load pruned state so the tool category excludes pruned tools and
  // the "pruned" stat line reflects persisted cumulative tokens.
  let prunedCallIDs: Set<string> | undefined;
  let totalPruneTokens = 0;
  try {
    const persisted = loadSessionState(sessionID);
    if (persisted) {
      prunedCallIDs = new Set(persisted.prune.tools.keys());
      totalPruneTokens = persisted.stats.totalPruneTokens;
    }
  } catch {
    // Defensive: I/O failure is non-fatal — tools fully counted.
    prunedCallIDs = undefined;
  }
  const report = computeContextReport(messages, prunedCallIDs);
  const formatted = formatContextReport(report, totalPruneTokens);

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
 * 4. Stores marks in `state.prune.tools`.
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

  // ── Collect callIDs for marking ─────────────────────────────────
  const state = getOrCreateSessionState(sessionID);
  const alreadyMarked = new Set(state.prune.tools.keys());
  const marks = collectSweepCallIDs(messages, alreadyMarked, count);

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

  // ── Store marks in state ────────────────────────────────────────
  let totalEstimate = 0;
  for (const mark of marks) {
    state.prune.tools.set(mark.callID, mark.estimatedTokens);
    totalEstimate += mark.estimatedTokens;
  }

  // Accumulate at mark time (DCP alignment: tally once at sweep, not
  // repeatedly at prune-time transforms).
  state.stats.totalPruneTokens += totalEstimate;
  state.dirty = true;

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
