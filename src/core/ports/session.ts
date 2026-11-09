/**
 * Session capability port.
 *
 * Pure types: the plugin working directory and the session → agent
 * resolver.  The file imports types only — never an implementation.
 *
 * @module
 */

/** The session capability. */
export interface SessionPort {
  /** The plugin working directory. */
  directory: string;
  /**
   * Resolve the agent driving a session (e.g. `"dolphin"`).
   *
   * Backed by the shared `SessionAgentRegistry`: the host entry point owns
   * the bindings (OpenCode populates from `message.updated` events; pi
   * resolves from explicit sources — an existing binding, its runtime's
   * fixed subagent, the run registry's `childSession`, the replacement
   * `session_start` claim, or the orchestrator — then binds).  Returns
   * `undefined` for an unknown session (fail-closed) — callers must treat
   * an unresolved identity as "not the orchestrator".
   */
  resolveAgent: (sessionID: string) => string | undefined;
  /**
   * Resolve the agent driving a session, including the host's own
   * authoritative fallback (OpenCode queries the session API; pi reads its
   * session → agent resolver).
   *
   * Asynchronous because that fallback is a host call.  This is the port
   * the delegation gate uses to identify the caller: unlike `resolveAgent`
   * (a pure registry read for event handlers), it also resolves a session
   * the registry has not observed yet.  Returns `undefined` when the
   * session cannot be attributed to an agent — callers must fail closed.
   */
  resolveCallerAgent: (sessionID: string) => Promise<string | undefined>;
}
