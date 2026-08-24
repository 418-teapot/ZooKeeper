/**
 * Host-agnostic profile → contribution selection.
 *
 * Given the active mode profile (or `null`) and the unit array, builds
 * the enablement sets and instantiates exactly the enabled units in
 * registry order, collecting their contributions into the
 * host-agnostic `ComposedResult` consumed by the host adapter.
 *
 * This module imports no concrete units and nothing from any host
 * framework — it only knows the contribution slot types and the
 * profile shape.
 *
 * @module
 */

import { log } from "../utils/logger.js";
import type { ModeProfile } from "./config-types.js";
import type {
  ActiveSet,
  ComposedResult,
  Deps,
  UnitContributions,
  UnitDescriptor,
} from "./slots.js";

/** Map a unit kind to the profile category that gates its enablement. */
const PROFILE_CATEGORY: Record<
  UnitDescriptor["kind"],
  "agents" | "skills" | "hooks" | "tools" | "commands"
> = {
  agent: "agents",
  skill: "skills",
  hook: "hooks",
  tool: "tools",
  command: "commands",
};

/** The five profile categories, in declaration order. */
const CATEGORIES = ["agents", "skills", "hooks", "tools", "commands"] as const;

/** Build an empty composition result. */
function emptyResult(): ComposedResult {
  return {
    agents: [],
    skills: [],
    beforeExec: [],
    afterExec: [],
    transform: [],
    textComplete: [],
    toolDefinition: [],
    tools: {},
    commands: {},
  };
}

/**
 * Merge one unit's contributions into the result.
 *
 * Handler arrays are appended (registry order preserved); tools and
 * commands are keyed by contribution name.
 *
 * @param result - The accumulating composition result.
 * @param contributions - The unit's contribution collection.
 */
function collect(
  result: ComposedResult,
  contributions: UnitContributions,
): void {
  switch (contributions.kind) {
    case "agent":
      result.agents.push(...contributions.agents);
      break;
    case "skill":
      result.skills.push(...contributions.skills);
      break;
    case "hook":
      result.beforeExec.push(...contributions.beforeExec);
      result.afterExec.push(...contributions.afterExec);
      result.transform.push(...contributions.transform);
      result.textComplete.push(...contributions.textComplete);
      result.toolDefinition.push(...contributions.toolDefinition);
      break;
    case "tool":
      for (const tool of contributions.tools) {
        result.tools[tool.name] = tool;
      }
      break;
    case "command":
      for (const command of contributions.commands) {
        result.commands[command.name] = command;
      }
      break;
  }
}

/**
 * Options controlling a single `composeProfile` pass.
 */
export interface ComposeOptions {
  /**
   * Warn once per profile name absent from the unit array (`unknown_unit`
   * event).  Default `true`.  A caller re-composing a pass for a single
   * slot (e.g. the pi command host) disables it so the first pass's
   * warnings are not repeated — the profile is unchanged, so the active
   * set handed to factories stays correct.
   */
  warnUnknownUnits?: boolean;
}

/**
 * Select and instantiate the profile-enabled units.
 *
 * A `null` profile (absent or invalid) returns an empty result and
 * instantiates nothing — no defaults, no fallback to a full load.
 * Otherwise the enablement sets are derived from the profile lists and
 * each enabled unit's factory runs in the unit array's order.  Profile
 * names with no matching unit in the array are warned once via the
 * shared logger (`unknown_unit` event), unless `warnUnknownUnits` is
 * `false` (a re-composition pass that repeats the same profile for a
 * single slot must not duplicate the first pass's warnings).
 *
 * @param profile - The active mode profile, or `null` when absent.
 * @param units - The unit array (caller-supplied).
 * @param deps - Per-plugin-instance dependencies.
 * @param opts - Optional per-pass options.
 * @returns The composed host-agnostic contributions.
 */
export function composeProfile(
  profile: ModeProfile | null,
  units: UnitDescriptor[],
  deps: Deps,
  opts?: ComposeOptions,
): ComposedResult {
  if (profile === null) return emptyResult();

  const activeSet: ActiveSet = {
    agents: new Set(profile.agents),
    skills: new Set(profile.skills),
    hooks: new Set(profile.hooks),
    tools: new Set(profile.tools),
    commands: new Set(profile.commands),
  };

  const result = emptyResult();
  const known = new Set(units.map((unit) => unit.name));

  for (const unit of units) {
    const category = PROFILE_CATEGORY[unit.kind];
    if (!profile[category].includes(unit.name)) continue;
    const contributions = unit.create(deps, activeSet);
    collect(result, contributions);
  }

  for (const category of CATEGORIES) {
    if (opts?.warnUnknownUnits === false) continue;
    for (const name of profile[category]) {
      if (!known.has(name)) {
        log("compose", "unknown_unit", "", undefined, "warn", {
          category,
          name,
        });
      }
    }
  }

  return result;
}
