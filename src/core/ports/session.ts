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
   * resolves lazily through the subagent run registry and the
   * async-local identity, then binds).  Returns `undefined` for an unknown
   * session (fail-closed) — callers must treat an unresolved identity as
   * "not the orchestrator".
   */
  resolveAgent: (sessionID: string) => string | undefined;
  /**
   * Resolve the agent driving a session, including the host's own
   * authoritative fallback (OpenCode queries the session API; pi resolves
   * through its identity core).
   *
   * Asynchronous because that fallback is a host call.  This is the port
   * the delegation gate uses to identify the caller: unlike `resolveAgent`
   * (a pure registry read for event handlers), it also resolves a session
   * the registry has not observed yet.  Returns `undefined` when the
   * session cannot be attributed to an agent — callers must fail closed.
   */
  resolveCallerAgent: (sessionID: string) => Promise<string | undefined>;
}
