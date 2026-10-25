/**
 * Declared profile → immutable selection.
 *
 * The planner is the pure first step of the assembly pipeline: given the
 * declared enablement (the mode profile plus the unit array), the
 * capability availability keys and the agent-modes map, it decides which
 * units will run and records why the others did not.  It never calls a
 * unit factory and never probes the environment — every environmental
 * question is answered by the availability keys the host declared.
 *
 * The result is an immutable {@link Selection}: the selected units in
 * registry order, the per-category facts derived from them, the resolved
 * orchestrator role, and the report that distinguishes "the profile does
 * not enable it" (absent from the profile), "the host does not provide
 * it" (`skipped`) and "the registry does not declare it" (`unknown`).
 * Nothing is ever assigned after planning, so a later stage cannot change
 * what was selected.
 *
 * The host may also declare the orchestrator role it requires ("is this
 * the primary the product orchestrates from?").  The planner never
 * invents that role: a declared orchestrator that is not one of the
 * selected primaries makes the selection `invalid`, which suppresses
 * every factory — no other primary is promoted into the role.
 *
 * Host materialisation facts (which agent names the host will create, and
 * which of them it accepts as its default agent) are inputs too, never a
 * later assignment: a selected agent the host will not materialise makes
 * the selection `invalid` before anything is bound or built.
 *
 * @module
 */

import type { AgentModeMap, ModeProfile } from "./config-types.js";
import { derivePrimaries } from "./subagent/identity.js";
import type { CapabilityKey, UnitDescriptor, UnitKind } from "./unit.js";

// ---------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------

/** The five profile categories, in declaration order. */
export const SELECTION_CATEGORIES = [
  "agents",
  "skills",
  "hooks",
  "tools",
  "commands",
] as const;

/** One profile category (the profile key a unit kind is gated by). */
export type SelectionCategory = (typeof SELECTION_CATEGORIES)[number];

/** Map a unit kind to the profile category that gates its enablement. */
const PROFILE_CATEGORY: Record<UnitKind, SelectionCategory> = {
  agent: "agents",
  skill: "skills",
  hook: "hooks",
  tool: "tools",
  command: "commands",
};

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

/** One profile name the unit array does not declare. */
export interface UnknownName {
  /** The profile category the name came from. */
  readonly category: SelectionCategory;
  /** The unresolvable name. */
  readonly name: string;
}

/** One selected-by-profile unit that cannot run for missing capabilities. */
export interface SkippedUnit {
  /** Unit name. */
  readonly name: string;
  /** The required capability keys the host does not provide. */
  readonly missing: readonly string[];
}

/**
 * What the planner decided during one selection pass.
 *
 * `selected` lists the units the profile enables, in registry order;
 * `skipped` records every unit whose `needs` were not satisfied together
 * with the missing keys; `unknown` records profile names with no matching
 * unit.  `skipped` and `unknown` stay separate so a host (or a test) can
 * tell "the host does not provide it" from "the registry does not declare
 * it".  `invalid` names the declared orchestrator role the selection could
 * not satisfy — a non-`null` value means nothing runs.
 */
export interface SelectionReport {
  /** Names of the units the profile enables, in registry order. */
  readonly selected: readonly string[];
  /** Units skipped for missing capabilities, with the missing keys. */
  readonly skipped: readonly SkippedUnit[];
  /** Profile names the registry does not declare, in profile order. */
  readonly unknown: readonly UnknownName[];
  /** The declared orchestrator the selection could not satisfy. */
  readonly invalid: InvalidOrchestrator | null;
  /**
   * Selected agents the host will not materialise, in profile order.
   *
   * A non-empty list makes the selection `invalid` even when the
   * orchestrator role itself resolved: the host cannot run an agent it
   * never creates.
   */
  readonly unmaterialised: readonly string[];
}

/**
 * The host's agent materialisation facts for a selection pass.
 *
 * Both halves are environment facts in the host's own vocabulary —
 * agent names, and which of them the host accepts as its default agent.
 * Supplying them at planning time keeps the decision host-agnostic while
 * making a selection the host cannot realise invalid before any
 * capability is bound or any factory runs.
 */
export interface AgentMaterialisation {
  /** Agent names the host will materialise. */
  readonly agents: readonly string[];
  /** Agent names the host will accept as its default agent. */
  readonly defaultAgents: readonly string[];
}

/**
 * Why a declared orchestrator is not the selection's orchestrator.
 *
 * - `unknown-unit` — the registry declares no such agent;
 * - `not-enabled` — declared, but the profile does not enable it;
 * - `needs-missing` — enabled, but its `needs` are unsatisfied;
 * - `not-primary` — selected, but the modes map does not mark it primary;
 * - `not-default-agent` — primary, but the host will not accept it as
 *   its default agent.
 */
export type InvalidOrchestratorCause =
  | "unknown-unit"
  | "not-enabled"
  | "needs-missing"
  | "not-primary"
  | "not-default-agent";

/**
 * The declared orchestrator role a selection pass could not satisfy.
 *
 * A host that declares an orchestrator role makes that agent a
 * requirement of the profile: if the selected primaries do not contain it,
 * the selection is invalid and no unit runs.  The reason stays observable
 * so a host can log an actionable message, and so no other primary is ever
 * promoted to the role.
 */
export interface InvalidOrchestrator {
  /** The orchestrator name the host declared as its role policy. */
  readonly orchestrator: string;
  /** Why the declared orchestrator is not the selection's orchestrator. */
  readonly cause: InvalidOrchestratorCause;
  /** The primaries the selection did derive, in profile order. */
  readonly primaries: readonly string[];
}

/**
 * The outcome of one selection pass.
 *
 * - `disabled` — no profile: nothing is enabled and no factory runs;
 * - `ready` — the enabled units and, when the host declared one, the
 *   orchestrator role resolved, and the host materialises every selected
 *   agent;
 * - `invalid` — the profile is enabled but the host cannot realise it:
 *   the declared orchestrator is unsatisfiable (see `report.invalid`) or
 *   a selected agent is not materialised (see `report.unmaterialised`),
 *   so nothing runs.
 */
export type SelectionStatus = "disabled" | "ready" | "invalid";

/**
 * The selection facts a unit factory may project through its `uses` list.
 *
 * Only facts with a consumer exist here: the selected agents (prompt
 * adaptation), the derived primaries (the switch commands), the selected
 * tools (the pruning/`/dcp` compress gate) and the resolved orchestrator
 * (the role-gated infrastructure hooks).  A category without a consumer
 * gets no global view — a unit that needs one adds it then.
 *
 * Every list holds the selected names in profile declaration order (first
 * occurrence wins), so a consumer that cares about order — the primary
 * derivation — sees exactly the order the config declares while names
 * that were skipped or never declared are absent.
 */
export interface SelectionFacts {
  /** Selected agent names, in profile order. */
  readonly agents: readonly string[];
  /** Primary agent names derived from the selected agents. */
  readonly primaries: readonly string[];
  /** Selected tool names, in profile order. */
  readonly tools: readonly string[];
  /**
   * The orchestrator role the host declared and the selection resolved,
   * or `undefined` when the host declared no role policy (or the selection
   * is not ready).  Consumers fail closed on `undefined`.
   */
  readonly orchestrator: string | undefined;
}

/**
 * The immutable outcome of one selection pass.
 *
 * Extends {@link SelectionFacts} with the selected descriptors themselves
 * (for the build step), the {@link SelectionStatus} and the
 * {@link SelectionReport}.  The whole structure is frozen: selection is
 * final, and no stage assigns to it afterwards.
 */
export interface Selection extends SelectionFacts {
  /**
   * The descriptors the profile enables, in registry order.  A selection
   * that is not `ready` instantiates none of them.
   */
  readonly chosen: readonly UnitDescriptor[];
  /** Whether nothing ran, the profile resolved, or it is invalid. */
  readonly status: SelectionStatus;
  /** What the planner selected, skipped, and could not resolve. */
  readonly report: SelectionReport;
}

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

/** The pure inputs of a selection pass. */
export interface SelectionInput {
  /** The declared mode profile, or `null` when absent/invalid. */
  profile: ModeProfile | null;
  /** The declared unit array (registry order is execution order). */
  units: readonly UnitDescriptor[];
  /** The capability keys the host can provide. */
  available: ReadonlySet<CapabilityKey>;
  /** Per-agent role map, used to derive the primaries. */
  agentModes: AgentModeMap;
  /**
   * The orchestrator role the host declares for this pass, or `undefined`
   * when the host declares no role policy (a role-agnostic selection).
   *
   * The planner never invents the role: a declared orchestrator that is
   * not among the selected primaries makes the selection invalid rather
   * than being replaced by another primary.
   */
  orchestrator?: string;
  /**
   * What the host will materialise, or `undefined` when the host imposes
   * no materialisation constraint (a host without such a notion).
   *
   * The facts are checked at planning time: a selected agent the host
   * will not create, or an orchestrator the host will not accept as its
   * default agent, makes the selection invalid and instantiates nothing.
   */
  materialisation?: AgentMaterialisation;
}

/** An empty (disabled) selection. */
function emptySelection(): Selection {
  return freezeSelection({
    chosen: [],
    agents: [],
    primaries: [],
    tools: [],
    orchestrator: undefined,
    status: "disabled",
    report: {
      selected: [],
      skipped: [],
      unknown: [],
      invalid: null,
      unmaterialised: [],
    },
  });
}

/**
 * Freeze a selection together with its nested lists.
 *
 * @param selection - The mutable selection being finalised.
 * @returns The same value, frozen.
 */
function freezeSelection(selection: Selection): Selection {
  const report: SelectionReport = Object.freeze({
    selected: Object.freeze([...selection.report.selected]),
    skipped: Object.freeze(
      selection.report.skipped.map((skip) =>
        Object.freeze({
          name: skip.name,
          missing: Object.freeze([...skip.missing]),
        }),
      ),
    ),
    unknown: Object.freeze(
      selection.report.unknown.map((entry) => Object.freeze({ ...entry })),
    ),
    invalid:
      selection.report.invalid === null
        ? null
        : Object.freeze({
            orchestrator: selection.report.invalid.orchestrator,
            cause: selection.report.invalid.cause,
            primaries: Object.freeze([...selection.report.invalid.primaries]),
          }),
    unmaterialised: Object.freeze([...selection.report.unmaterialised]),
  });
  return Object.freeze({
    agents: Object.freeze([...selection.agents]),
    primaries: Object.freeze([...selection.primaries]),
    tools: Object.freeze([...selection.tools]),
    orchestrator: selection.orchestrator,
    status: selection.status,
    chosen: Object.freeze([...selection.chosen]),
    report,
  });
}

/**
 * Keep the first occurrence of every name, preserving declaration order.
 *
 * @param names - The names to deduplicate.
 * @returns The distinct names in their original order.
 */
function distinct(names: readonly string[]): string[] {
  return [...new Set(names)];
}

/**
 * List the capability keys a unit declared but the host cannot provide.
 *
 * @param unit - The unit whose `needs` are checked.
 * @param available - The declared availability keys.
 * @returns The missing keys, in declaration order (empty when satisfied).
 */
function missingNeeds(
  unit: UnitDescriptor,
  available: ReadonlySet<CapabilityKey>,
): string[] {
  return unit.needs.filter((key) => !available.has(key));
}

/**
 * Classify why a declared orchestrator is not the selection's orchestrator.
 *
 * The causes are checked from the outermost reason inwards: a name the
 * registry does not declare cannot be enabled, an enabled one cannot be
 * primary while its `needs` are unmet, and a selected one is only missing
 * from the primaries when the modes map does not mark it primary.
 *
 * @param orchestrator - The declared orchestrator name.
 * @param units - The declared unit array.
 * @param profile - The declared mode profile.
 * @param skipped - The units skipped for missing capabilities.
 * @returns The cause of the invalid selection.
 */
function invalidCause(
  orchestrator: string,
  units: readonly UnitDescriptor[],
  profile: ModeProfile,
  skipped: readonly SkippedUnit[],
): InvalidOrchestratorCause {
  const declared = units.some(
    (unit) => unit.kind === "agent" && unit.name === orchestrator,
  );
  if (!declared) return "unknown-unit";
  if (!profile.agents.includes(orchestrator)) return "not-enabled";
  if (skipped.some((skip) => skip.name === orchestrator)) {
    return "needs-missing";
  }
  return "not-primary";
}

/**
 * Resolve the declared orchestrator role against the selection facts.
 *
 * The role is satisfied only by a selected primary the host also accepts
 * as its default agent: a primary the host would refuse to run by default
 * cannot serve the role, and no other primary is promoted.
 *
 * @param orchestrator - The declared orchestrator name.
 * @param primaries - The primaries the selection derived.
 * @param materialisation - The host's materialisation facts, or
 *   `undefined` when the host imposes none.
 * @param units - The declared unit array.
 * @param profile - The declared mode profile.
 * @param skipped - The units skipped for missing capabilities.
 * @returns The unsatisfied role, or `null` when it resolved.
 */
function orchestratorInvalid(
  orchestrator: string,
  primaries: readonly string[],
  materialisation: AgentMaterialisation | undefined,
  units: readonly UnitDescriptor[],
  profile: ModeProfile,
  skipped: readonly SkippedUnit[],
): InvalidOrchestrator | null {
  if (!primaries.includes(orchestrator)) {
    return {
      orchestrator,
      cause: invalidCause(orchestrator, units, profile, skipped),
      primaries,
    };
  }
  if (
    materialisation !== undefined &&
    !materialisation.defaultAgents.includes(orchestrator)
  ) {
    return { orchestrator, cause: "not-default-agent", primaries };
  }
  return null;
}

/**
 * Select the profile-enabled units whose needs the host can satisfy.
 *
 * A `null` profile selects nothing — no defaults, no fallback to a full
 * load.  Otherwise each unit in the array is checked against the profile
 * category that gates its kind: a unit with any unavailable `needs` key is
 * recorded as skipped (its factory never runs), a satisfiable one is
 * selected.  Profile names with no matching unit are recorded as unknown.
 *
 * A host may declare the orchestrator role it requires.  The role is
 * satisfied only by one of the selected primaries, so a role that is
 * unknown, not enabled, skipped or not marked primary makes the selection
 * `invalid` — never a different primary promoted in its place.  Without a
 * declared role the pass stays role-agnostic and `orchestrator` is
 * `undefined`.
 *
 * A host may also declare what it will materialise.  A selected agent the
 * host will not create, or an orchestrator the host will not accept as
 * its default agent, makes the selection `invalid` too: the facts are
 * part of the decision, not a later assignment.
 *
 * @param input - The profile, unit array, availability keys, modes, and
 *   optional orchestrator role and materialisation facts.
 * @returns The frozen selection.
 */
export function planSelection(input: SelectionInput): Selection {
  const { profile, units, available, agentModes, orchestrator } = input;
  const materialisation = input.materialisation;
  if (profile === null) return emptySelection();

  const chosen: UnitDescriptor[] = [];
  const selected: string[] = [];
  const skipped: SkippedUnit[] = [];
  const unknown: UnknownName[] = [];

  for (const unit of units) {
    const category = PROFILE_CATEGORY[unit.kind];
    if (!profile[category].includes(unit.name)) continue;
    const missing = missingNeeds(unit, available);
    if (missing.length > 0) {
      skipped.push({ name: unit.name, missing });
      continue;
    }
    chosen.push(unit);
    selected.push(unit.name);
  }

  const known = new Set(units.map((unit) => unit.name));
  for (const category of SELECTION_CATEGORIES) {
    for (const name of profile[category]) {
      if (!known.has(name)) unknown.push({ category, name });
    }
  }

  const chosenByCategory = new Map<SelectionCategory, Set<string>>(
    SELECTION_CATEGORIES.map((category) => [category, new Set<string>()]),
  );
  for (const unit of chosen) {
    chosenByCategory.get(PROFILE_CATEGORY[unit.kind])?.add(unit.name);
  }
  /** The selected names of one category, in profile order. */
  const selectedNames = (category: SelectionCategory): string[] =>
    distinct(
      profile[category].filter((name) =>
        chosenByCategory.get(category)?.has(name),
      ),
    );

  const agents = selectedNames("agents");
  const primaries = derivePrimaries(agents, agentModes);
  const tools = selectedNames("tools");
  const chosenFacts = { chosen, agents, primaries, tools };

  // The host facts join the decision here: an agent the host will not
  // create cannot run, whatever the profile enables.
  const unmaterialised =
    materialisation === undefined
      ? []
      : agents.filter((name) => !materialisation.agents.includes(name));

  const invalid =
    orchestrator === undefined
      ? null
      : orchestratorInvalid(
          orchestrator,
          primaries,
          materialisation,
          units,
          profile,
          skipped,
        );

  const status: SelectionStatus =
    unmaterialised.length > 0 || invalid !== null ? "invalid" : "ready";

  return freezeSelection({
    ...chosenFacts,
    orchestrator: status === "ready" ? orchestrator : undefined,
    status,
    report: { selected, skipped, unknown, invalid, unmaterialised },
  });
}
