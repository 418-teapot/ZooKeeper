/**
 * Session capability port.
 *
 * Pure types: the host client, the plugin working directory, and the
 * session → agent resolver.  The file imports types only — never an
 * implementation.
 *
 * @module
 */

/** The session capability. */
export interface SessionPort {
  /**
   * The host client (OpenCode / pi), opaque to this layer.
   *
   * Each host client differs, so this is deliberately an existing `any`
   * boundary.
   */
  client: any;
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
}
