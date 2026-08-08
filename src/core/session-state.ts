/**
 * Shared per-session state registry.
 *
 * Holds the two module-level session maps (`sessionAgentMap`,
 * `subAgentCache`) and the single `cleanupSession` entry point that
 * drops every per-session record on `session.deleted` events.  Owned
 * here (host-agnostic core) so the entry point and the pruning hook
 * module consume the same instances without depending on each other;
 * adding a new session-level record means registering its cleanup in
 * `cleanupSession`, not adding a line to the host's event handler.
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

/**
 * Cache of sub-agent status per session ID.
 *
 * Populated on first access during the messages transform by calling
 * `client.session.get()`.  Sub-agent sessions (created via the `task`
 * tool) have a `parentID` set on the session info; main sessions do not.
 *
 * Ownership: the entry point only maintains `sessionAgentMap` via
 * `message.updated` events; this cache is filled and read by the
 * context-pruning hook's messages transform path.
 */
export const subAgentCache = new Map<string, boolean>();

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

/**
 * Drop every per-session record for the given session ID.
 *
 * Single cleanup entry point called on `session.deleted` events:
 * clears the two session maps above, the model-limit registry entry,
 * the pruning in-memory session state, and the persisted state file.
 *
 * @param sessionID - The session identifier to clean up.
 */
export function cleanupSession(sessionID: string): void {
  sessionAgentMap.delete(sessionID);
  subAgentCache.delete(sessionID);
  clearModelLimit(sessionID);
  removeSession(sessionID);
  deleteSessionState(sessionID);
}
