/**
 * Pi process owner — the state one pi process owns.
 *
 * pi replays the extension factory on every reload and loads every
 * sub-session extension inside the same process, so the state a reload must
 * keep belongs to the process, not to a runtime: the core
 * {@link ProcessState} (the session → agent bindings and the subagent run
 * records) plus the `/<agent>` switch handoff slot, which spans two factory
 * executions by definition (see `switch-host.ts`).
 *
 * This module keeps the process-level holder: {@link piProcessState}
 * creates the owner on first use and returns the same one to every later
 * load, so the state survives a reload.  The entry passes the owner to its
 * runtime through an explicit parameter, and a sub-session runtime inherits
 * its parent's owner instead of creating one.  The core registries expose no
 * implicit global access, so a test creates an isolated owner with
 * {@link createPiProcessState} and resets the holder through
 * {@link _resetPiProcessStateForTesting}.
 *
 * @module
 */

import {
  createProcessState,
  type ProcessState,
} from "../../core/process-state.js";
import { createSwitchOpsStore, type SwitchOpsStore } from "./switch-host.js";

/** The state one pi process owns. */
export interface PiProcessState extends ProcessState {
  /** The pending `/<agent>` switch operations of this process. */
  readonly switchOps: SwitchOpsStore;
}

/**
 * Create the process state of one pi process.
 *
 * @returns A fresh owner with empty stores.
 */
export function createPiProcessState(): PiProcessState {
  return { ...createProcessState(), switchOps: createSwitchOpsStore() };
}

let current: PiProcessState | undefined;

/**
 * The process state of this pi process.
 *
 * @returns The owner every configuration generation of this process shares.
 */
export function piProcessState(): PiProcessState {
  current ??= createPiProcessState();
  return current;
}

/**
 * Drop the process-wide owner (test isolation).
 *
 * The next {@link piProcessState} call creates a fresh owner; a runtime that
 * already received the previous one keeps it.
 */
export function _resetPiProcessStateForTesting(): void {
  current = undefined;
}
