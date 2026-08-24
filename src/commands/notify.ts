/**
 * Shared slash-command failure notification.
 *
 * Injects a failed slash-command error into the session chat (silently)
 * for both command units (`/go` and `/dcp`).  Kept as a neutral helper
 * module under `src/commands/` so neither command unit owns the other.
 *
 * @module
 */

import { log } from "../utils/logger.js";

/**
 * A host surface that posts chat notifications via `notify`.
 *
 * The tool-host shape used by `/dcp` (a host-agnostic `ToolHost`
 * carrying a best-effort `notify`).
 */
type NotifyChannel = {
  notify?: (sessionId: string, text: string) => Promise<void>;
};

/**
 * The legacy v1 client prompt channel.
 *
 * `/go` still hands the raw v1 client; the prompt path posts an ignored
 * `noReply` chat message as the notification fallback.
 */
type PromptChannel = {
  session?: {
    prompt?: (input: {
      path: { id: string };
      body: {
        noReply?: boolean;
        parts: Array<{ type: "text"; text: string; ignored?: boolean }>;
      };
    }) => Promise<unknown>;
  };
};

/**
 * Minimal host surface a command failure notification needs.
 *
 * Accepts either a host-agnostic `ToolHost` (`notify`) or the legacy
 * v1 client (`session.prompt`) — the `/go` command unit still hands
 * the raw v1 client while `/dcp` hands the tool host, so both shapes
 * are tolerated with the prompt path as fallback.
 */
type NotifyTarget = NotifyChannel | PromptChannel;

/**
 * Inject a failed slash-command error into the session chat (silently).
 *
 * Logs the failure at warn level, then sends a `noReply` + `ignored` text
 * part so the user sees the error without triggering LLM processing.
 * Notification is best-effort — a failed prompt/notify is swallowed.
 *
 * @param target - The host surface (`ToolHost.notify` preferred, the v1
 *   `session.prompt` fallback).
 * @param sessionID - The session receiving the error message.
 * @param error - The thrown error (message text is extracted).
 * @param logHook - Logger hook module name (e.g. `"context-command"`).
 * @param logEvent - Logger event name (e.g. `"dcp_command_failed"`).
 */
export async function notifySessionError(
  target: NotifyTarget | null | undefined,
  sessionID: string,
  error: unknown,
  logHook: string,
  logEvent: string,
): Promise<void> {
  const msg = error instanceof Error ? error.message : String(error);
  log(logHook, logEvent, sessionID, undefined, "warn", { error: msg });
  try {
    const notify = (target as NotifyChannel | null | undefined)?.notify;
    if (typeof notify === "function") {
      await notify(sessionID, msg);
      return;
    }
    const client = target as PromptChannel | null | undefined;
    await client?.session?.prompt?.({
      path: { id: sessionID },
      body: {
        noReply: true,
        parts: [{ type: "text", text: msg, ignored: true }],
      },
    });
  } catch {
    // Best-effort notification
  }
}
