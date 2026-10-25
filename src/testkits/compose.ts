/**
 * Shared test-side assembly helpers.
 *
 * Production hosts declare their capabilities through
 * `capabilityBindings` and run `assemble`; a test usually only wants "run
 * the real pipeline with this capability bag", so the helpers here wrap
 * the same three stages without a host-specific binder.  The capability
 * bag is treated exactly as a host declaration: an `undefined` entry
 * declares nothing.
 *
 * @module
 */

import { capabilityBindings } from "../core/bindings.js";
import { type Assembly, assemble } from "../core/compose.js";
import type { AgentModeMap, ModeProfile } from "../core/config-types.js";
import type { Capabilities } from "../core/ports/index.js";
import type { SelectionFacts } from "../core/selection.js";
import type { UnitDescriptor } from "../core/unit.js";

/**
 * Build a selection-facts projection for a direct unit-factory test.
 *
 * A unit's `create` receives the projection of the facts it declared in
 * `uses`; a test that instantiates a unit directly supplies the same
 * shape.
 *
 * @param overrides - The facts to override; omitted facts stay empty.
 * @returns The fact projection.
 */
export function facts(overrides: Partial<SelectionFacts> = {}): SelectionFacts {
  return {
    agents: [],
    primaries: [],
    tools: [],
    orchestrator: undefined,
    ...overrides,
  };
}

/**
 * Assemble a profile against a plain capability bag.
 *
 * @param profile - The declared mode profile, or `null`.
 * @param units - The unit array to select from.
 * @param values - The capability values the "host" provides.
 * @param agentModes - Per-agent role map used to derive the primaries.
 * @param orchestrator - The orchestrator role the "host" declares, if any.
 * @returns The selection and the composed result.
 */
export function assembleForTest(
  profile: ModeProfile | null,
  units: readonly UnitDescriptor[],
  values: Partial<Capabilities>,
  agentModes: AgentModeMap = {},
  orchestrator?: string,
): Assembly {
  return assemble({
    profile,
    units,
    bindings: capabilityBindings({ values }),
    agentModes,
    orchestrator,
  });
}

/**
 * Compose a profile against a plain capability bag, returning only the
 * contributions.
 *
 * @param profile - The declared mode profile, or `null`.
 * @param units - The unit array to select from.
 * @param values - The capability values the "host" provides.
 * @param agentModes - Per-agent role map used to derive the primaries.
 * @param orchestrator - The orchestrator role the "host" declares, if any.
 * @returns The composed contributions.
 */
export function composeForTest(
  profile: ModeProfile | null,
  units: readonly UnitDescriptor[],
  values: Partial<Capabilities>,
  agentModes: AgentModeMap = {},
  orchestrator?: string,
) {
  return assembleForTest(profile, units, values, agentModes, orchestrator)
    .composed;
}
