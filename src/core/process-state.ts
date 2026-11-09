/**
 * Process state — the state one OS process owns, shared by every
 * configuration generation it runs.
 *
 * A host process runs its configuration generations one after another (a
 * reload, a new plugin instance) and, on pi, every sub-session runtime
 * inside the same process.  Two facts outlive one generation, so they
 * cannot belong to a generation's runtime:
 *
 *  - the session → agent identities ({@link SessionAgentRegistry}), because
 *    a reloaded generation resolves the sessions that already exist;
 *  - the subagent run records ({@link RunRegistry}), because a reloaded
 *    fleet widget renders the runs a previous generation recorded.
 *
 * The run records are the process history, not one runtime's active work.
 * Every runtime creates its own scope over that table
 * ({@link RunRegistry.createScope}) and writes its runs through it, so the
 * runtime's stop ends exactly the runs it started and the history stays.
 * One writer is a host fact: a host's subagent translator (the OpenCode TUI
 * panel) writes the table directly, so those records belong to the process
 * history and no runtime stop ends them.
 *
 * Both are created by one {@link createProcessState} call.  Each host process
 * module keeps that owner in a process-level holder that outlives a reload
 * (`adapters/pi/process.ts`, `adapters/opencode/process.ts`), and every
 * runtime receives it through an explicit parameter.  The registries
 * themselves expose no implicit global access, so a test creates its own
 * instance instead of clearing shared state.
 *
 * @module
 */

import { SessionAgentRegistry } from "./session/agent.js";
import { createRunRegistry, type RunRegistry } from "./subagent/registry.js";

/** The state one OS process owns. */
export interface ProcessState {
  /** The session → agent bindings of this process. */
  readonly sessionAgents: SessionAgentRegistry;
  /**
   * The subagent run records of this process.
   *
   * The process history every runtime reads; a runtime writes its own runs
   * through a scope over it (`createScope`), and a host-fact translator
   * writes the table directly.
   */
  readonly runs: RunRegistry;
}

/**
 * Create the process state of one host process.
 *
 * @returns A fresh owner with empty stores.
 */
export function createProcessState(): ProcessState {
  return {
    sessionAgents: new SessionAgentRegistry(),
    runs: createRunRegistry(),
  };
}
