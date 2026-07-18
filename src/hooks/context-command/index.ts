/**
 * Context command hook barrel export.
 *
 * Provides the `/dcp context` command handler and sentinel error
 * constant for the OpenCode plugin.
 *
 * @module
 */

import { formatContextReport } from "../../core/context-report.js";
import type { ContextMessageEntry } from "../../core/metrics.js";
import { computeContextReport } from "../../core/metrics.js";
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

  // ── Unknown subcommand → show help ────────────────────────────────
  if (trimmed !== "" && trimmed !== "context") {
    const help = [
      "━━  用法 ━━",
      "",
      "/dcp context   — 显示上下文用量与缓存命中率",
      "/dcp           — 同上（默认）",
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
  const report = computeContextReport(messages);
  const formatted = formatContextReport(report);

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
