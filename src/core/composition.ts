/**
 * Shared composition service: the one assembly seam of both hosts.
 *
 * A host declares its capabilities as an extension service and hands that
 * declaration here.  The composition service depends on it, reads the
 * configuration generation from the host's {@link ProcessScope}, binds the
 * capability values the host provides, runs the declared unit array
 * through {@link assemble}, and returns the host-agnostic
 * {@link Assembly}.  Every consumer downstream (the loop engine, the
 * handler wiring, the adapter's registration) reads that same assembly, so
 * neither host owns a second assembly path.
 *
 * The known contract is deliberate: the host provides values and
 * materialisation facts, and it adopts the finished selection.  A host
 * whose identity resolver depends on the resolved orchestrator (pi's
 * session resolver) therefore keeps that state in its own service, and the
 * composition stays free of any dependency back to it — the graph is
 * acyclic in both directions.
 *
 * Dynamic host facts stay the host's business: a fact that must be read
 * from the host (an SDK config probe) is read while the host's capabilities
 * service is created, which is a service-creation step of the same graph,
 * not a step of the assembly.
 *
 * @module
 */

import { capabilityBindings } from "./bindings.js";
import { type Assembly, assemble } from "./compose.js";
import type { ConfigSnapshot, ProcessScope } from "./config-snapshot.js";
import {
  defineExtensionService,
  type ExtensionServiceDefinition,
} from "./lifecycle/index.js";
import type { Capabilities } from "./ports/index.js";
import type { HostMaterialisation, Selection } from "./selection.js";
import type { UnitDescriptor } from "./unit.js";

/**
 * What a host's capabilities service provides to the composition.
 *
 * `values` is the host's capability declaration (the availability keys are
 * derived from it, so a missing value declares nothing); `materialisation`
 * is what the host will actually create, when it can say; `adopt` receives
 * the finished selection so host-owned identity state can follow it.
 */
export interface HostCapabilities {
  /** The selection-independent capability values of this host instance. */
  readonly values: Partial<Capabilities>;
  /**
   * What the host will materialise, or absent when the host imposes no
   * materialisation constraint.
   */
  readonly materialisation?: HostMaterialisation;
  /**
   * Adopt the finished selection.
   *
   * Called once per composition pass, including a `disabled` or `invalid`
   * one, so host state never keeps a role a later pass did not resolve.
   */
  adopt?(selection: Selection): void;
}

/** The fixed inputs of one host's composition. */
export interface CompositionInput {
  /** The configuration generation this composition belongs to. */
  readonly scope: ProcessScope<ConfigSnapshot>;
  /** The declared unit array (registry order is execution order). */
  readonly units: readonly UnitDescriptor[];
  /**
   * The orchestrator role the host declares for this pass, or `undefined`
   * when it declares none.  A declared role the enabled primaries cannot
   * provide makes the selection invalid.
   */
  readonly orchestrator?: string;
}

/**
 * Run one composition pass over a host's capabilities.
 *
 * The pass reads the profile and the agent-mode map from the scope's
 * snapshot, binds the host values, plans and builds, and finally hands the
 * selection to the host.  A `null` profile selects nothing; an invalid
 * selection instantiates nothing.  Either way the host adopts what the pass
 * resolved, so a consumer of its identity state fails closed.
 *
 * @param scope - The configuration generation of this host instance.
 * @param capabilities - The host's capability provision.
 * @param input - The unit array and the declared orchestrator role.
 * @returns The selection the pass ran from and its contributions.
 */
export function composeAssembly(
  scope: ProcessScope<ConfigSnapshot>,
  capabilities: HostCapabilities,
  input: CompositionInput,
): Assembly {
  const { modeProfile, agentModes } = scope.snapshot;
  const assembly = assemble({
    profile: modeProfile,
    units: input.units,
    bindings: capabilityBindings({ values: capabilities.values }),
    agentModes,
    ...(input.orchestrator === undefined
      ? {}
      : { orchestrator: input.orchestrator }),
    ...(capabilities.materialisation === undefined
      ? {}
      : { materialisation: capabilities.materialisation }),
  });
  capabilities.adopt?.(assembly.selection);
  return assembly;
}

/**
 * Declare the composition service over a host's capabilities service.
 *
 * The returned declaration is what a host puts in its service graph after
 * its capabilities service; every consumer of the assembly declares this
 * definition as a dependency, so the assembly is created once per
 * extension scope and read by all of them.
 *
 * @param input - The scope, the unit array, the declared role, and the
 *   capabilities declaration to depend on.
 * @returns The composition service declaration.
 */
export function defineCompositionService(
  input: CompositionInput & {
    /** The host's capabilities declaration. */
    capabilities: ExtensionServiceDefinition<string, any, HostCapabilities>;
  },
): ExtensionServiceDefinition<
  "composition",
  [typeof input.capabilities],
  Assembly
> {
  const { capabilities } = input;
  return defineExtensionService({
    name: "composition",
    deps: [capabilities],
    create: ({ deps }) =>
      composeAssembly(input.scope, deps[capabilities.name], input),
  });
}
