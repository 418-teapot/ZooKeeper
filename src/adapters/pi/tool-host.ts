/**
 * Pi tool host — session services for the compress / decompress tools.
 *
 * Implements the host-free `ToolHost` contract against pi's
 * `ExtensionContext`: the session id comes from the tool execution context's
 * `sessionManager`, history is read from the session manager's context
 * entries, and notifications are best-effort via pi's in-session
 * `appendEntry` channel (a `zoo-notice` custom entry — persistent, never
 * part of the LLM context).
 *
 * pi sessions are single-session, so the host keeps a mutable reference to
 * the latest `ExtensionContext` supplied by the pi event handlers; tool
 * execution receives a context too, but using the latest ref lets the host
 * resolve the current session manager even when only the session id is
 * available.
 *
 * @module
 */

import type { ToolHost } from "../../core/client/tool-host.js";
import type { HostMessage } from "../../core/context/lens.js";
import { log } from "../../utils/logger.js";
import { history } from "./history.js";
import type { PiAgentMessage } from "./types.js";

/**
 * Minimal duck-type shape of pi's `ExtensionContext` that the tool host needs.
 *
 * No import from the pi package — these structural types are the only
 * contract the host relies on.
 */
export interface PiToolHostContext {
  /** Session manager (read-only). */
  sessionManager?: {
    getSessionId(): string;
    buildContextEntries?(): unknown[];
  };
  /** UI surface (widget updates from the pi entry point). */
  ui?: {
    setWidget?(
      key: string,
      content:
        | string[]
        | ((tui: unknown, theme: unknown) => unknown)
        | undefined,
      options?: { placement?: "aboveEditor" | "belowEditor" },
    ): void;
    /** Read the current editor text (fleet-widget key guard). */
    getEditorText?(): string;
    /** Listen to raw terminal input (fleet-widget keyboard). */
    onTerminalInput?(
      handler: (
        data: string,
      ) => { consume?: boolean; data?: string } | undefined,
    ): () => void;
  };
}

/**
 * Duck-type of pi's `ExtensionAPI.appendEntry`.
 *
 * The entry persists as a `CustomEntry` (session-visible only when a
 * renderer is registered for `customType`) and — unlike
 * `CustomMessageEntry` — is ignored by `buildSessionContext`, so it never
 * reaches the LLM context.  This is the pi-native equivalent of v1's
 * `ignored` parts.
 */
export type PiAppendEntry = (customType: string, data?: unknown) => void;

/**
 * The data payload carried by a `zoo-notice` custom entry.
 *
 * `content` holds the notification text; the renderer reads it back to
 * draw the card in the TUI.  Kept as a single string field so the payload
 * stays minimal and the entry stays durable JSON.
 */
export interface PiNoticeEntryData {
  content: string;
}

/**
 * Mutable holder for the latest pi context.
 *
 * pi passes a fresh `ExtensionContext` to every event handler; the tool
 * host reads the holder so it can access the current session manager and UI
 * without importing pi types.
 */
export interface PiContextHolder {
  current: PiToolHostContext | undefined;
}

/**
 * Test whether an unknown session entry message looks like a pi LLM message.
 *
 * Custom agent message roles are filtered out because the pi adapter only
 * understands `user`, `assistant`, and `toolResult`.
 *
 * @param value - The unknown message value.
 * @returns True when the value can be projected through the pi lens.
 */
function isPiAgentMessage(value: unknown): value is PiAgentMessage {
  if (value === null || typeof value !== "object") return false;
  const role = (value as Record<string, unknown>).role;
  return role === "user" || role === "assistant" || role === "toolResult";
}

/**
 * Create the pi tool host backed by a mutable context holder.
 *
 * The holder is updated by the pi extension entry point
 * (`src/pi.ts`) as each event handler fires.  All operations are
 * best-effort: fetch failures throw with Chinese guidance (so the model can
 * retry), while notification failures are swallowed and logged.
 *
 * @param contextHolder - Mutable reference to the latest pi context.
 * @param appendEntry - Optional pi `appendEntry` binding (extension API)
 *   that `notify` uses to post an in-session `zoo-notice` custom entry.
 *   Absent (e.g. headless mode) drops notifications with a debug log.
 * @returns The pi tool host.
 */
export function createPiToolHost(
  contextHolder: PiContextHolder,
  appendEntry?: PiAppendEntry,
): ToolHost {
  return {
    /**
     * Resolve the session id from the pi tool execution context.
     *
     * pi exposes the session id through `toolCtx.sessionManager.getSessionId()`.
     *
     * @param toolCtx - The tool execution context.
     * @returns The session identifier, or undefined when absent.
     */
    resolveSessionId(toolCtx: unknown): string | undefined {
      const ctx = toolCtx as {
        sessionManager?: { getSessionId(): string };
      };
      return ctx.sessionManager?.getSessionId();
    },

    /**
     * Fetch the session's LLM-context entries and project them to lens
     * messages.
     *
     * Uses `sessionManager.buildContextEntries()` so compaction summaries and
     * branch state are already applied.  Only message entries with a known
     * LLM role are kept; custom entry types are ignored.
     *
     * @param sessionId - The session identifier (used for logging only; pi
     *   sessions are single-session).
     * @returns The projected host-agnostic transcript.
     * @throws A loud Chinese error when the session manager is unavailable
     *   or returns no entries.
     */
    async fetchHistory(sessionId: string): Promise<HostMessage[]> {
      const ctx = contextHolder.current;
      const sessionManager = ctx?.sessionManager;
      if (!sessionManager?.buildContextEntries) {
        throw new Error("无法获取会话消息：会话管理器不可用");
      }

      let entries: unknown[];
      try {
        entries = sessionManager.buildContextEntries();
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

      if (!Array.isArray(entries)) {
        throw new Error("会话消息格式异常：期望数组");
      }

      const messages: PiAgentMessage[] = [];
      for (const entry of entries) {
        if (
          entry === null ||
          typeof entry !== "object" ||
          (entry as Record<string, unknown>).type !== "message"
        ) {
          continue;
        }
        const message = (entry as Record<string, unknown>).message;
        if (isPiAgentMessage(message)) {
          messages.push(message);
        }
      }

      return history(messages);
    },

    /**
     * Post a best-effort in-session notification via `appendEntry`.
     *
     * The notification is appended as a `zoo-notice` custom entry:
     * persistent in the session, rendered in the TUI by the registered
     * renderer, and never entering the LLM context.  When no `appendEntry`
     * is supplied (e.g. headless mode), the notification is dropped with a
     * debug log.  Failures are swallowed and logged as warnings — tools
     * already performed their work.
     *
     * @param _sessionId - The session identifier (logged but not used; pi
     *   appendEntry targets the active session).
     * @param text - The notification text.
     */
    async notify(_sessionId: string, text: string): Promise<void> {
      if (!appendEntry) {
        log("tool-host", "notify_skipped", _sessionId, undefined, "debug", {
          reason: "appendEntry unavailable",
        });
        return;
      }

      try {
        const data: PiNoticeEntryData = { content: text };
        appendEntry("zoo-notice", data);
      } catch (err) {
        log("tool-host", "notify_failed", _sessionId, undefined, "warn", {
          error: String(err),
        });
      }
    },
  };
}
