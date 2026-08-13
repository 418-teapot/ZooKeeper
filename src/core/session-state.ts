/**
 * Shared per-session state registry.
 *
 * Holds the `sessionAgentMap` and the single `cleanupSession` entry
 * point that drops every per-session record on `session.deleted`
 * events.  Owned here (host-agnostic core) so the entry point and the
 * pruning hook module consume the same instances without depending on
 * each other; adding a new session-level record means registering its
 * cleanup in `cleanupSession`, not adding a line to the host's event
 * handler.
 *
 * @module
 */

import { clearModelLimit } from "./context/model-limits.js";
import { deleteSessionState, removeSession } from "./context/pruning/index.js";

// ---------------------------------------------------------------------------
// Shared session maps
// ---------------------------------------------------------------------------

/**
 * Maps session IDs to agent names reported by message.updated events.
 *
 * Populated by the entry point's event handler; read by the pruning
 * hook's dedup notification to address the session chat.
 */
export const sessionAgentMap = new Map<string, string>();

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

/**
 * Drop every per-session record for the given session ID.
 *
 * Single cleanup entry point called on `session.deleted` events:
 * clears the session map above, the model-limit registry entry,
 * the pruning in-memory session state, and the persisted state file.
 *
 * @param sessionID - The session identifier to clean up.
 */
export function cleanupSession(sessionID: string): void {
  sessionAgentMap.delete(sessionID);
  clearModelLimit(sessionID);
  removeSession(sessionID);
  deleteSessionState(sessionID);
}
