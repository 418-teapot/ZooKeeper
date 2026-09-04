/**
 * OpenCode v1 tool host — session services for tool adapters.
 *
 * Implements the host-free `ToolHost` contract against the OpenCode v1
 * client slice (`SessionClient` + optional `tui.showToast`): resolves
 * the session id from a tool context, fetches the session history as
 * lens messages, posts ignored chat notifications, and shows transient
 * toasts through the TUI surface (silently dropped without it).
 * Tolerates both `sessionID` and `sessionId` context shapes, unwraps
 * `res.data ?? res` with a `res.error` rejection, and treats
 * notifications and toasts as best-effort.
 *
 * Notifications always resolve the session's agent before sending:
 * OpenCode's `session.prompt` carries no `body.agent` and would switch
 * the session agent to the default, so the notify path resolves the
 * agent (registry-backed resolver first, `session.get` fallback) and
 * suppresses the message when it cannot be resolved.
 *
 * @module
 */

import type { SessionClient } from "../../core/client/session.js";
import type { ToastPayload, ToolHost } from "../../core/client/tool-host.js";
import type { HostMessage } from "../../core/context/lens.js";
import { log } from "../../utils/logger.js";
import { history } from "./history.js";
import type { ContextMessageEntry } from "./types.js";

/**
 * Minimal client interface required by the v1 tool host.
 *
 * The host-facing `SessionClient` session APIs plus the optional TUI
 * toast surface (`tui.showToast`) consumed by the `toast` port.  The
 * full OpenCode client object is much larger; this slice keeps the host
 * thin while remaining trivially compatible with it.  Absent `tui`
 * (e.g. a partial or headless client) degrades the toast port to a
 * silent drop — the notification channel is deliberately NOT a
 * fallback, since a toast is transient by contract and persisting it
 * would change its semantics.
 */
export interface V1ToolHostClient extends SessionClient {
  tui?: {
    showToast?: (input: {
      body: {
        title?: string;
        message: string;
        variant: "info" | "success" | "warning" | "error";
        /** Duration in milliseconds. */
        duration?: number;
      };
    }) => Promise<unknown>;
  };
}

/**
 * Create the v1 tool host backed by an OpenCode session client.
 *
 * The client and the session-agent resolver are captured by the
 * closure; the client may be partial (missing session APIs) in tests.
 *
 * @param client - The OpenCode client (session.messages / session.prompt /
 *   session.get / tui.showToast).
 * @param resolveAgent - Resolves a session's agent name from the shared
 *   session-agent registry (populated by the entry point's
 *   message.updated handler).
 * @returns The v1 tool host.
 */
export function createV1ToolHost(
  client: V1ToolHostClient,
  resolveAgent: (sessionID: string) => string | undefined,
): ToolHost {
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
     * Resolves the session agent first (registry-backed resolver, then
     * a `session.get` fallback) so the prompt never switches the
     * session agent to the default; when the agent cannot be resolved
     * the notification is suppressed with a warn entry.  Best-effort:
     * failures are logged as warnings and swallowed, never propagated
     * to the caller.
     *
     * @param sessionId - The session identifier.
     * @param text - The notification text.
     */
    async notify(sessionId: string, text: string): Promise<void> {
      const body: {
        noReply: boolean;
        parts: Array<{ type: "text"; text: string; ignored: boolean }>;
        agent?: string;
      } = {
        noReply: true,
        parts: [{ type: "text", text, ignored: true }],
      };

      // Send the prompt; failures are logged and never propagate.
      const send = async (): Promise<void> => {
        try {
          await client?.session?.prompt?.({
            path: { id: sessionId },
            body,
          });
        } catch (err) {
          log("tool-host", "notify_failed", sessionId, undefined, "warn", {
            error: String(err),
          });
        }
      };

      try {
        // Resolve the agent (registry-backed resolver first,
        // `session.get` fallback); suppress the notification when
        // unresolved.
        const agent = await resolveSessionAgent(
          sessionId,
          client,
          resolveAgent,
        );
        if (agent) {
          body.agent = agent;
          await send();
          return;
        }
        log("tool-host", "notify_suppressed", sessionId, undefined, "warn", {
          reason: "agent unresolved",
        });
      } catch (err) {
        log("tool-host", "notify_suppressed", sessionId, undefined, "warn", {
          reason: "agent unresolved",
          error: String(err),
        });
      }
    },

    /**
     * Show a transient toast via the TUI `showToast` surface.
     *
     * The source and level are rendered here (the `[zoo][source]`
     * message prefix plus the toast variant) so producers stay uniform
     * across hosts.  Fire-and-forget: the request promise is detached —
     * rejections are logged and swallowed, and synchronous throws are
     * logged too.  When the client has no `tui.showToast` the toast
     * silently drops (debug log); the persisted notification channel is
     * deliberately not used as a fallback.
     *
     * @param sessionId - The session identifier (logged; the TUI toast
     *   targets the connected terminal, not a stored session record).
     * @param toast - The toast payload (source / level / text).
     */
    toast(sessionId: string, toast: ToastPayload): void {
      const tui = client.tui;
      if (tui === undefined || typeof tui.showToast !== "function") {
        log("tool-host", "toast_skipped", sessionId, undefined, "debug", {
          reason: "tui.showToast unavailable",
        });
        return;
      }

      const warnFailure = (err: unknown): void => {
        log("tool-host", "toast_failed", sessionId, undefined, "warn", {
          error: String(err),
        });
      };
      try {
        // Best-effort: detach the request so a rejection never reaches
        // the caller (the port is synchronous by contract).
        void tui
          .showToast({
            body: {
              message: `[zoo][${toast.source}] ${toast.text}`,
              variant: toast.level,
            },
          })
          .catch(warnFailure);
      } catch (err) {
        warnFailure(err);
      }
    },
  };
}

/**
 * Resolve the current agent for a session.
 *
 * Resolution order:
 *   (a) `resolveAgent` — the shared session-agent registry read
 *       (populated solely by the message.updated handler — single
 *       source of truth)
 *   (b) `client.session.get()` API call — per-call fallback WITHOUT
 *       write-back to the registry, so a mid-session agent change is
 *       reflected as soon as either the next message.updated or the
 *       next resolution happens.
 *   (c) `undefined` — current behavior preserved, debug log entry
 *
 * @param sessionID - The session identifier.
 * @param client - The host client (session.get availability checked).
 * @param resolveAgent - Registry-backed session → agent resolver.
 * @returns The resolved agent name, or `undefined` when unknown.
 */
export async function resolveSessionAgent(
  sessionID: string,
  client: SessionClient,
  resolveAgent: (sessionID: string) => string | undefined,
): Promise<string | undefined> {
  // (a) Check the registry first (fast, no I/O).
  const mapped = resolveAgent(sessionID);
  if (mapped) return mapped;

  // (b) Fallback to session API — read the agent from the session object.
  if (client?.session?.get) {
    try {
      const sessionInfo = await client.session.get({
        path: { id: sessionID },
      });
      if (sessionInfo?.agent) {
        return sessionInfo.agent;
      }
    } catch {
      // Session not found — fall through to (c).
    }
  }

  // (c) Unknown — log debug entry and return undefined.
  log("tool-host", "notify_no_agent", sessionID, undefined, "debug", {});
  return undefined;
}
