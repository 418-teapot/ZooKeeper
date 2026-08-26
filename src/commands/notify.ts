/**
 * Shared slash-command failure notification.
 *
 * Injects a failed slash-command error into the session chat (silently)
 * for the command units (`/go`, `/dcp`, `/switch`).  Kept as a neutral
 * helper module under `src/commands/` so no command unit owns the
 * others.
 *
 * @module
 */

import { log } from "../utils/logger.js";

/**
 * Minimal host surface a command failure notification needs.
 *
 * The host-agnostic `ToolHost` shape carrying a best-effort `notify`.
 */
type NotifyTarget = {
  notify?: (sessionId: string, text: string) => Promise<void>;
};

/**
 * Inject a failed slash-command error into the session chat (silently).
 *
 * Logs the failure at warn level, then sends a `noReply` + `ignored` text
 * part so the user sees the error without triggering LLM processing.
 * Notification is best-effort — a failed notify is swallowed.
 *
 * @param target - The host surface (`ToolHost.notify`).
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
    await target?.notify?.(sessionID, msg);
  } catch {
    // Best-effort notification
  }
}
