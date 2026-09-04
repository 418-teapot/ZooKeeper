/**
 * Session → agent identity registry.
 *
 * Host-agnostic store mapping session IDs to the agent name driving
 * each session.  Entries appear through `bind` only; every other
 * operation reads or removes existing bindings.  An unbound session
 * resolves to `undefined` (fail-closed) — identity is never invented
 * here; the host decides what a session is bound to:
 *
 *  - OpenCode binds from `message.updated` events (the authoritative
 *    per-session agent reported by the host).
 *  - pi resolves lazily through the subagent run registry and the
 *    async-local identity (see `src/pi.ts`), binding every result so
 *    later lookups hit this store directly; pi has no session-
 *    deletion event, so pi-side bindings live for the whole process
 *    — that accumulation is bounded by design (see
 *    `buildPiResolveAgent`).
 *
 * `clear` is the test seam; the process-wide singleton lives on the
 * `sessionAgentRegistry` export, shared by every host entry point and
 * read by units through `Deps.resolveAgent`.
 *
 * @module
 */

/**
 * Registry of session → agent bindings.
 *
 * All state is in-memory and per-process; bindings are dropped by
 * `cleanupSession` (via `delete`) when the host reports a session
 * deletion.
 */
export class SessionAgentRegistry {
  private readonly bindings = new Map<string, string>();

  /**
   * Bind a session to an agent name, overwriting any previous binding.
   *
   * @param sessionID - The session identifier.
   * @param agentName - The agent name driving the session.
   */
  bind(sessionID: string, agentName: string): void {
    this.bindings.set(sessionID, agentName);
  }

  /**
   * Resolve the agent bound to a session.
   *
   * @param sessionID - The session identifier.
   * @returns The bound agent name, or `undefined` when unbound.
   */
  resolve(sessionID: string): string | undefined {
    return this.bindings.get(sessionID);
  }

  /**
   * Drop the binding of one session (no-op when unbound).
   *
   * @param sessionID - The session identifier.
   */
  delete(sessionID: string): void {
    this.bindings.delete(sessionID);
  }

  /** Drop every binding (test isolation seam). */
  clear(): void {
    this.bindings.clear();
  }
}

/**
 * The process-wide registry shared by every host entry point.
 *
 * The hosts' event handlers are the writers (OpenCode via
 * `message.updated`; pi via lazy resolution inside `resolveAgent`);
 * `cleanupSession` removes entries on session deletion; hook units
 * read through `Deps.resolveAgent`.
 */
export const sessionAgentRegistry = new SessionAgentRegistry();
