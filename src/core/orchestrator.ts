/**
 * Orchestrator agent identity.
 *
 * The orchestration model rests on a single orchestrator agent, and the
 * product configures that agent as dolphin.  This constant is how the
 * production hosts *declare* that role: they hand it to the planner as the
 * orchestrator role policy, and the planner marks the profile invalid when
 * the enabled primaries cannot provide it.  Consumers then read the resolved
 * role from the selection (`selection.orchestrator`) instead of importing
 * this name, so no unit holds an agent-name literal of its own.
 *
 * @module
 */

/**
 * The agent name of the product's orchestrator.
 *
 * Declared to the planner by each production host entry point.  The planner
 * never invents the role — a declared orchestrator that is not a selected
 * primary makes the selection invalid instead of being replaced by another
 * primary.
 */
export const ORCHESTRATOR_AGENT_NAME = "dolphin";
