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
 *  - pi resolves from explicit sources — an existing binding, the fixed
 *    agent of a sub-session runtime, the run registry's `childSession`, a
 *    pending switch target, or the orchestrator (see
 *    `buildPiResolveAgent` in `src/adapters/pi/wire.ts`) — binding every
 *    result so later lookups hit this store directly; pi has no
 *    session-deletion event, so pi-side bindings live for the whole
 *    process — that accumulation is bounded by design.
 *
 * `clear` is the test seam; the process-wide singleton lives on the
 * `sessionAgentRegistry` export, shared by every host entry point and
 * read by units through `Capabilities.resolveAgent`.  The binding is a
 * retained session record (see `resources.ts`), so a session deletion
 * removes it.
 *
 * @module
 */

import type { RetainedSessionResource } from "./resources.js";

/**
 * Registry of session → agent bindings.
 *
 * All state is in-memory and per-process; a binding is process-owned, so a
 * runtime release keeps it (the next instance resolves the same session)
 * and only a session deletion drops it.
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
 * `message.updated`; pi via lazy resolution inside `resolveAgent`); the
 * session resource catalog removes entries on session deletion; hook units
 * read through `Capabilities.resolveAgent`.
 */
export const sessionAgentRegistry = new SessionAgentRegistry();

/**
 * The agent binding outlives a runtime release.
 *
 * Identity belongs to the process, not to a plugin instance: a stopped
 * runtime keeps the binding so the next instance resolves the same session,
 * and only a session deletion drops it.
 */
export const sessionAgentResource: RetainedSessionResource = {
  name: "sessionAgent",
  runtime: "retain",
  delete: (sessionID) => sessionAgentRegistry.delete(sessionID),
};
