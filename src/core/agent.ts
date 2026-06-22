/**
 * Framework-independent agent-type detection utilities.
 *
 * Provides a minimal `Clientish` interface and two async helpers:
 * `getAgentName` for resolving the agent name from a session, and
 * `isBuildAgent` as a convenience boolean check.
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

/**
 * Check whether the session belongs to the `"build"` agent.
 *
 * Returns `true` only when `getAgentName` returns the exact string `"build"`.
 * When no client is available (null/undefined/missing getSession), returns
 * `false` — a conservative behaviour that causes callers to skip their action.
 *
 * @param client - Framework client providing session access, or null/undefined.
 * @param sessionId - Session identifier to look up.
 * @returns `true` when the agent is `"build"`, `false` otherwise.
 */
export async function isBuildAgent(
  client: Clientish | null | undefined,
  sessionId: string,
): Promise<boolean> {
  const agent = await getAgentName(client, sessionId);
  return agent === "build";
}
