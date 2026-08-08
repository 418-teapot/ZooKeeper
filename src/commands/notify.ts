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
 * Inject a failed slash-command error into the session chat (silently).
 *
 * Logs the failure at warn level, then sends a `noReply` + `ignored` text
 * part so the user sees the error without triggering LLM processing.
 * Notification is best-effort — a failed `session.prompt` is swallowed.
 *
 * @param client - The host client.
 * @param sessionID - The session receiving the error message.
 * @param error - The thrown error (message text is extracted).
 * @param logHook - Logger hook module name (e.g. `"context-command"`).
 * @param logEvent - Logger event name (e.g. `"dcp_command_failed"`).
 */
export async function notifySessionError(
  client: any,
  sessionID: string,
  error: unknown,
  logHook: string,
  logEvent: string,
): Promise<void> {
  const msg = error instanceof Error ? error.message : String(error);
  log(logHook, logEvent, sessionID, undefined, "warn", { error: msg });
  try {
    await client?.session?.prompt({
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
