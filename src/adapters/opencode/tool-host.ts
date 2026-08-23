/**
 * OpenCode v1 tool host — session services for tool adapters.
 *
 * Implements the host-free `ToolHost` contract against the OpenCode v1
 * client slice (`SessionClient`): resolves the session id from a tool
 * context, fetches the session history as lens messages, and posts
 * ignored chat notifications.  Tolerates both `sessionID` and
 * `sessionId` context shapes, unwraps `res.data ?? res` with a
 * `res.error` rejection, and treats notifications as best-effort.
 *
 * @module
 */

import type { SessionClient } from "../../core/client/session.js";
import type { ToolHost } from "../../core/client/tool-host.js";
import type { HostMessage } from "../../core/context/lens.js";
import { log } from "../../utils/logger.js";
import { history } from "./history.js";
import type { ContextMessageEntry } from "./types.js";

/**
 * Create the v1 tool host backed by an OpenCode session client.
 *
 * The client is captured by the closure; it may be partial (missing
 * session APIs) in tests.
 *
 * @param client - The OpenCode client (session.messages / session.prompt).
 * @returns The v1 tool host.
 */
export function createV1ToolHost(client: SessionClient): ToolHost {
  return {
    /**
     * Resolve the session id from the OpenCode tool context.
     *
     * The OpenCode SDK uses `sessionID`; a `sessionId` variant is
     * tolerated so the host survives SDK shape changes.  Returns
     * undefined when neither field carries a non-empty string.
     *
     * @param toolCtx - The tool execution context.
     * @returns The session identifier, or undefined when absent.
     */
    resolveSessionId(toolCtx: unknown): string | undefined {
      const ctx = toolCtx as { sessionID?: unknown; sessionId?: unknown };
      const id = ctx.sessionID ?? ctx.sessionId;
      if (typeof id !== "string" || id.length === 0) return undefined;
      return id;
    },

    /**
     * Fetch the session's full history and project it to lens messages.
     *
     * Unwraps `res.data ?? res` and rejects on `res.error`.
     *
     * @param sessionId - The session identifier.
     * @returns The projected host-agnostic transcript.
     * @throws A loud Chinese error when the messages API is unavailable,
     *   rejects, returns an empty result, carries an error field, or
     *   resolves to a non-array.
     */
    async fetchHistory(sessionId: string): Promise<HostMessage[]> {
      if (!client?.session?.messages) {
        throw new Error("无法获取会话消息：会话消息 API 不可用");
      }

      let rawMessages: unknown;
      try {
        const res = await client.session.messages({ path: { id: sessionId } });
        rawMessages = res;
      } catch (err) {
        log(
          "tool-host",
          "fetch_messages_failed",
          sessionId,
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
      return history(messages);
    },

    /**
     * Post an ignored chat notification to the session.
     *
     * Best-effort: failures are logged as warnings and swallowed, never
     * propagated to the caller.
     *
     * @param sessionId - The session identifier.
     * @param text - The notification text.
     */
    async notify(sessionId: string, text: string): Promise<void> {
      try {
        await client?.session?.prompt?.({
          path: { id: sessionId },
          body: {
            noReply: true,
            parts: [{ type: "text", text, ignored: true }],
          },
        });
      } catch (err) {
        log("tool-host", "notify_failed", sessionId, undefined, "warn", {
          error: String(err),
        });
      }
    },
  };
}
