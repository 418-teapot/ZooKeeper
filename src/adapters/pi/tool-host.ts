/**
 * Pi tool host — session services for the compress / decompress tools.
 *
 * Implements the host-free `ToolHost` contract against pi's
 * `ExtensionContext`: the session id comes from the tool execution context's
 * `sessionManager`, notifications are best-effort via pi's in-session
 * `appendEntry` channel (a `zoo-notice` custom entry — persistent, never
 * part of the LLM context), and transient toasts go through the latest
 * context's `ui.notify` (silently dropped when no UI surface exists).
 *
 * No history read is offered: pi's `buildContextEntries()` channel is not
 * the same ordinal space the `context` event projects (compaction rewrites
 * it), so this host deliberately leaves the optional `fetchHistory`
 * fallback unwired.  The compress / decompress tools address the round view
 * published by the context transform instead.
 *
 * pi sessions are single-session, so the host keeps a mutable reference to
 * the latest `ExtensionContext` supplied by the pi event handlers; tool
 * execution receives a context too, but using the latest ref lets the host
 * resolve the current session manager even when only the session id is
 * available.
 *
 * @module
 */

import type { ToastPayload, ToolHost } from "../../core/client/tool-host.js";
import { log } from "../../utils/logger.js";

/**
 * Minimal duck-type shape of pi's `ExtensionContext` that the latest-context
 * holder keeps.
 *
 * No import from the pi package — these structural types are the only
 * contract the holder's readers rely on.  `sessionManager.getSessionId`
 * serves session-id resolution, `buildContextEntries` is read by the pi
 * entry point's session-start subagent-run rescan (never by this host: it
 * offers no history read for the compression tools), and `ui` serves the
 * toast port.
 */
export interface PiToolHostContext {
  /** Session manager (read-only). */
  sessionManager?: {
    getSessionId(): string;
    /** Read by the pi entry point's run-registry rescan, not by the host. */
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
    /** Open a full-screen overlay (fleet-widget run inspection). */
    custom?(factory: unknown, options?: unknown): unknown;
    /** Transient user notification (absent in pi's print mode). */
    notify?(message: string, type?: "info" | "warning" | "error"): void;
  };
}

/**
 * Duck-type of pi's `ExtensionAPI.appendEntry`.
 *
 * The entry persists as a `CustomEntry` (session-visible only when a
 * renderer is registered for `customType`) and — unlike
 * `CustomMessageEntry` — is ignored by `buildSessionContext`, so it never
 * reaches the LLM context.  This is the pi-native equivalent of
 * OpenCode's `ignored` parts.
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
 * Create the pi tool host backed by a mutable context holder.
 *
 * The holder is updated by the pi extension entry point
 * (`src/pi.ts`) as each event handler fires.  All operations are
 * best-effort: notification failures are swallowed and logged.
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

    /**
     * Show a transient toast via pi's `ui.notify` channel.
     *
     * The source and level are rendered here (the `[zoo][source]` prefix
     * plus the pi notification type) so producers stay uniform across
     * hosts.  Fire-and-forget and observational: the latest context is
     * read from the mutable holder (refreshed on every pi event, so it
     * is current whenever a transform runs); when the holder has no UI
     * surface (e.g. pi print mode) the call silently drops with a debug
     * log.  Failures are swallowed and logged as warnings.
     *
     * @param _sessionId - The session identifier (logged but not used;
     *   pi sessions are single-session and ui.notify targets the TUI).
     * @param toast - The toast payload (source / level / text).
     */
    toast(_sessionId: string, toast: ToastPayload): void {
      const ui = contextHolder.current?.ui;
      if (ui === undefined || typeof ui.notify !== "function") {
        log("tool-host", "toast_skipped", _sessionId, undefined, "debug", {
          reason: "ui.notify unavailable",
        });
        return;
      }

      try {
        ui.notify(`[zoo][${toast.source}] ${toast.text}`, toast.level);
      } catch (err) {
        log("tool-host", "toast_failed", _sessionId, undefined, "warn", {
          error: String(err),
        });
      }
    },
  };
}
