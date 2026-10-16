/**
 * Orchestrator agent identity.
 *
 * The orchestration model rests on a single orchestrator agent, and that
 * agent is always dolphin.  This is a system invariant, not a configuration
 * value: a top-level session resolves to the orchestrator, never to a
 * delegated subagent.  Modules that gate behavior on "is this the
 * orchestrator?" compare a resolved agent name against this constant rather
 * than repeating the literal.
 *
 * @module
 */

/**
 * The agent name of the system's orchestrator.
 *
 * Invariant: the orchestrator is always dolphin.  Callers resolve a
 * session's agent (through `Deps.resolveAgent`) and compare it to this name
 * to decide whether the session belongs to the orchestrator; an unresolved
 * session is not the orchestrator (fail-closed).
 */
export const ORCHESTRATOR_AGENT_NAME = "dolphin";
