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
 *    agent of a sub-session runtime, the run registry's `childSession`, or
 *    the orchestrator (see `buildPiResolveAgent` in
 *    `src/adapters/pi/wire.ts`) — binding every result so later lookups
 *    hit this store directly.  A replacement `session_start` claim binds
 *    its target here before the session's bind-time events, so the
 *    resolver answers it as an existing binding.  pi has no
 *    session-deletion event, so pi-side bindings live for the whole
 *    process — that accumulation is bounded by design.
 *
 * One instance belongs to the host's process owner
 * (`core/process-state.ts`), which hands the same instance to every
 * configuration generation and to every sub-runtime of that process; units
 * read it through `Capabilities.resolveAgent`.  The binding is a retained
 * session record (see `resources.ts`), so a session deletion removes it.
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
 * Declare the session record over one process's agent registry.
 *
 * The binding outlives a runtime release: identity belongs to the process,
 * not to a plugin instance, so a stopped runtime keeps it and the next
 * instance resolves the same session; only a session deletion drops it.
 *
 * @param registry - The registry of the process that owns this record.
 * @returns The retained session record the catalog applies on a stop.
 */
export function createSessionAgentResource(
  registry: SessionAgentRegistry,
): RetainedSessionResource {
  return {
    name: "sessionAgent",
    runtime: "retain",
    delete: (sessionID) => registry.delete(sessionID),
  };
}
