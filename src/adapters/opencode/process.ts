/**
 * OpenCode process owner — the state one OpenCode process owns.
 *
 * The server plugin and the TUI panel are two entries of one OpenCode
 * host: the plugin writes the session → agent bindings and the subagent
 * run records, and the panel renders them.
 *
 * This module keeps the process-level holder: {@link openCodeProcessState}
 * creates the owner on first use and returns the same one to every later
 * load, so the state survives a reload.  Each entry passes the owner to its
 * runtime through an explicit parameter.  The core registries expose no
 * implicit global access, so a test creates an isolated owner with
 * {@link createProcessState} and resets the holder through
 * {@link _resetOpenCodeProcessStateForTesting}.
 *
 * The holder is module state, so it is shared only within one module
 * instance (the server and the TUI loaded together).  An attach/server
 * deployment may run the panel in its own process: that process holds a
 * separate owner, and the panel rebuilds the runs it renders from the host
 * events and API calls it receives.
 *
 * @module
 */

import {
  createProcessState,
  type ProcessState,
} from "../../core/process-state.js";

let current: ProcessState | undefined;

/**
 * The process state of this module instance.
 *
 * @returns The owner every entry of this module instance shares.
 */
export function openCodeProcessState(): ProcessState {
  current ??= createProcessState();
  return current;
}

/**
 * Drop the process-wide owner (test isolation).
 *
 * The next {@link openCodeProcessState} call creates a fresh owner; a
 * runtime that already received the previous one keeps it.
 */
export function _resetOpenCodeProcessStateForTesting(): void {
  current = undefined;
}
