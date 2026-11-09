/**
 * Pi tool host — session services for the compress / decompress tools.
 *
 * Implements the host-free `ToolHost` contract against pi's
 * `ExtensionContext`: notifications are best-effort via pi's in-session
 * `appendEntry` channel (a `zoo-notice` custom entry — persistent, never
 * part of the LLM context), and transient toasts go through the `ui.notify`
 * of the session the call names (silently dropped when that session has no
 * UI surface).
 *
 * No history read is offered: pi's `buildContextEntries()` channel is not
 * the same ordinal space the `context` event projects (compaction rewrites
 * it), so this host deliberately leaves the optional `fetchHistory`
 * fallback unwired.  The compress / decompress tools address the round view
 * published by the context transform instead.
 *
 * The toast port addresses one session at a time: pi tracks several live
 * sessions, so the ui of "the last event" would let one session's toast land
 * on another's TUI.  The host therefore resolves the ui of the session the
 * call names, and a session that bound no context toasts nothing.
 *
 * @module
 */

import {
  formatToastMessage,
  type ToastPayload,
  type ToolHost,
} from "../../core/ports/tool-host.js";
import { log } from "../../utils/logger.js";

/**
 * Minimal duck-type shape of pi's `ExtensionContext` that the session
 * contexts keep.
 *
 * No import from the pi package — these structural types are the only
 * contract the readers rely on.  `sessionManager.getSessionId` serves the
 * session-id resolution of the entry paths, `buildContextEntries` is read
 * by the pi entry point's session-start subagent-run rescan (never by this
 * host: it offers no history read for the compression tools), and `ui`
 * serves the toast port.
 */
export interface PiToolHostContext {
  /** Session manager (read-only). */
  sessionManager?: {
    getSessionId(): string;
    /**
     * Session file header, read by the replacement claim: pi records the
     * replaced session on the new session's header.
     */
    getHeader?(): { parentSession?: string } | null;
    /** Read by the pi entry point's run-registry rescan, not by the host. */
    buildContextEntries?(): unknown[];
    /** Raw entries of the active branch (incl. pre-compaction), read by the
     * pi entry point's todo snapshot scan. */
    getBranch?(): unknown[];
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
 * Resolver for one session's pi event context.
 *
 * The host names the session it serves, so an interleaved second session's
 * context is never returned.  The session contexts port satisfies it.
 */
export interface PiContextResolver {
  /** The context bound for one session, or undefined when it bound none. */
  forSession(sessionID: string | undefined): PiToolHostContext | undefined;
}

/**
 * Create the pi tool host backed by the session contexts.
 *
 * The toast port resolves the ui of the session the call names; the session
 * contexts are bound by the entry paths (`src/adapters/pi/handlers.ts` and
 * the tool / command bridges).
 * All operations are best-effort: notification failures are swallowed and
 * logged.
 *
 * @param contexts - Resolves one session's pi event context.
 * @param appendEntry - Optional pi `appendEntry` binding (extension API)
 *   that `notify` uses to post an in-session `zoo-notice` custom entry.
 *   Absent (e.g. headless mode) drops notifications with a debug log.
 * @returns The pi tool host.
 */
export function createPiToolHost(
  contexts: PiContextResolver,
  appendEntry?: PiAppendEntry,
): ToolHost {
  return {
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
        log.debug({
          hook: "tool-host",
          event: "notify_skipped",
          sessionId: _sessionId,
          reason: "appendEntry unavailable",
        });
        return;
      }

      try {
        const data: PiNoticeEntryData = { content: text };
        appendEntry("zoo-notice", data);
      } catch (err) {
        log.warn({
          hook: "tool-host",
          event: "notify_failed",
          sessionId: _sessionId,
          error: String(err),
        });
      }
    },

    /**
     * Show a transient toast via pi's `ui.notify` channel.
     *
     * The message is rendered by `formatToastMessage` and the level
     * passes through as the pi notification type, so producers stay
     * uniform across hosts.  Fire-and-forget and observational: the ui of
     * the session this call names is resolved from the session contexts;
     * a session that bound no UI surface (e.g. pi print mode) drops the
     * toast with a debug log.  Failures are swallowed and logged as
     * warnings.
     *
     * @param sessionID - The session the toast belongs to.
     * @param toast - The toast payload (source / level / text).
     */
    toast(sessionID: string, toast: ToastPayload): void {
      const ui = contexts.forSession(sessionID)?.ui;
      if (ui === undefined || typeof ui.notify !== "function") {
        log.debug({
          hook: "tool-host",
          event: "toast_skipped",
          sessionId: sessionID,
          reason: "ui.notify unavailable",
        });
        return;
      }

      try {
        ui.notify(formatToastMessage(toast), toast.level);
      } catch (err) {
        log.warn({
          hook: "tool-host",
          event: "toast_failed",
          sessionId: sessionID,
          error: String(err),
        });
      }
    },
  };
}
