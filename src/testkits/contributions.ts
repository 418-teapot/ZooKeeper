/**
 * Shared fixtures for the host adapter hook tests.
 *
 * The adapter hooks read a `ComposedResult` and a `Selection`, both of
 * which the assembly pipeline normally produces.  A hook test usually
 * exercises one contribution kind, so these fixtures start empty and let
 * the test fill the slot it drives.
 *
 * @module
 */

import type { ComposedResult } from "../core/compose.js";
import type { Selection, SelectionReport } from "../core/selection.js";

/** A report of a selection that resolved nothing. */
function emptyReport(): SelectionReport {
  return {
    selected: [],
    skipped: [],
    unknown: [],
    invalid: null,
    unmaterialised: [],
    hostFact: null,
  };
}

/**
 * Build a composition result carrying only the given contributions.
 *
 * @param overrides - The contribution slots to fill.
 * @returns The composition result.
 */
export function composedResult(
  overrides: Partial<ComposedResult> = {},
): ComposedResult {
  return {
    agents: [],
    skills: [],
    afterExec: [],
    transform: [],
    textComplete: [],
    toolDefinition: [],
    onSettled: [],
    gate: null,
    gateNeedsCaller: false,
    tools: {},
    commands: {},
    report: emptyReport(),
    ...overrides,
  };
}

/**
 * Build a ready selection over the given agent names.
 *
 * @param agents - The selected agent names.
 * @param orchestrator - The resolved orchestrator role, when one exists.
 * @returns The selection.
 */
export function readySelection(
  agents: readonly string[] = [],
  orchestrator?: string,
): Selection {
  return {
    chosen: [],
    agents: [...agents],
    primaries: [...agents],
    tools: [],
    orchestrator,
    status: "ready",
    report: emptyReport(),
  };
}
