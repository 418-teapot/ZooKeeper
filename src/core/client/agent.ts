/**
 * Framework-independent agent-type detection utilities.
 *
 * Provides a minimal `Clientish` interface and the async helper
 * `getAgentName` for resolving the agent name from a session.
 *
 * @module
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Minimal client interface required for agent name resolution.
 *
 * Only the `getSession` method is needed; it is optional because some
 * callers may not have a client available at all (e.g. in tests or before
 * OpenCode bootstraps the client object).
 */
export interface Clientish {
  getSession?: (id: string) => Promise<{ agent?: string }>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolve the agent name for a given session.
 *
 * Calls `client.getSession(sessionId)` and returns the `agent` field, or
 * `undefined` when:
 * - `client` is null/undefined
 * - `client.getSession` is not available
 * - `getSession` throws (failures are silently swallowed)
 * - the session has no `agent` field
 *
 * @param client - Framework client providing session access, or null/undefined.
 * @param sessionId - Session identifier to look up.
 * @returns The agent name string, or undefined when unavailable.
 */
export async function getAgentName(
  client: Clientish | null | undefined,
  sessionId: string,
): Promise<string | undefined> {
  if (!client?.getSession) return undefined;
  try {
    const session = await client.getSession(sessionId);
    return session?.agent;
  } catch {
    return undefined;
  }
}
