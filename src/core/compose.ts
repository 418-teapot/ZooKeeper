/**
 * Host-agnostic profile → contribution selection.
 *
 * This module is the single matching point of the capability model: given
 * the active mode profile (or `null`) and the unit array, it builds the
 * enablement sets, decides for every enabled unit whether the supplied
 * capability bag satisfies the unit's `needs` list, and instantiates
 * exactly the matching units in registry order.  A unit whose `needs` are
 * not met is skipped and recorded in the {@link CompositionReport} — the
 * unit factory never runs and never has to check for an absent port.
 *
 * It also owns the isolated contribution runners: they are assembly-time
 * infrastructure shared by both host adapters.
 *
 * This module imports no concrete units and nothing from any host
 * framework — it only knows the contribution slot types and the profile
 * shape.
 *
 * @module
 */

import { log } from "../utils/logger.js";
import type { ModeProfile } from "./config-types.js";
import type { DelegationGate, DelegationJudgeContribution } from "./gate.js";
import { composeGate } from "./gate.js";
import type { SettledContribution } from "./loop/settle.js";
import type { Capabilities } from "./ports/index.js";
import type {
  ActiveSet,
  AfterExecContribution,
  AgentContribution,
  CommandContribution,
  SkillContribution,
  TextCompleteContribution,
  ToolContribution,
  ToolDefinitionContribution,
  TransformContribution,
  UnitContributions,
  UnitDescriptor,
} from "./unit.js";

// ---------------------------------------------------------------------------
// Composition result
// ---------------------------------------------------------------------------

/**
 * What the matcher did during one `composeProfile` pass.
 *
 * `activated` lists the units that ran, in registry order; `skipped`
 * records every unit whose `needs` were not satisfied and which capability
 * keys were missing.  The report is logged and returned so a host (or a
 * test) can tell "the profile does not enable it" from "the host does not
 * provide it".
 */
export interface CompositionReport {
  /** Names of the units that ran, in registry order. */
  activated: string[];
  /** Units skipped for missing capabilities, with the missing keys. */
  skipped: { name: string; missing: string[] }[];
}

/**
 * Host-agnostic intermediate structure produced by the selection
 * engine.
 *
 * Handler arrays keep the registry's order; `tools` and `commands` are
 * keyed by contribution name.  The host adapter turns this into framework
 * registrations (event keys appear only when their arrays are non-empty).
 */
export interface ComposedResult {
  /** Enabled agent prompt contributions. */
  agents: AgentContribution[];
  /** Enabled skill contributions. */
  skills: SkillContribution[];
  /** Enabled `tool.execute.after` handlers. */
  afterExec: AfterExecContribution[];
  /** Enabled messages-transform handlers. */
  transform: TransformContribution[];
  /** Enabled text-finalization handlers. */
  textComplete: TextCompleteContribution[];
  /** Enabled `tool.definition` enhancers. */
  toolDefinition: ToolDefinitionContribution[];
  /** Enabled loop settle handlers. */
  onSettled: SettledContribution[];
  /** The composed delegation gate, or `null` for an empty judge chain. */
  gate: DelegationGate | null;
  /**
   * Whether any composed judge needs the `caller` request field.
   *
   * Aggregated from the judges' `needsCaller` flags.  The consuming
   * host uses this to decide whether the asynchronous caller resolution
   * runs before judging — it is skipped entirely when no judge needs it.
   */
  gateNeedsCaller: boolean;
  /** Enabled tools, keyed by tool name. */
  tools: Record<string, ToolContribution>;
  /** Enabled commands, keyed by command name. */
  commands: Record<string, CommandContribution>;
  /** What the matcher activated and skipped. */
  report: CompositionReport;
}

// Map a unit kind to the profile category that gates its enablement.
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
    afterExec: [],
    transform: [],
    textComplete: [],
    toolDefinition: [],
    onSettled: [],
    tools: {},
    commands: {},
    gate: null,
    gateNeedsCaller: false,
    report: { activated: [], skipped: [] },
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
 * @param judges - The accumulating delegation judges.
 */
function collect(
  result: ComposedResult,
  contributions: UnitContributions,
  judges: DelegationJudgeContribution[],
): void {
  switch (contributions.kind) {
    case "agent":
      result.agents.push(...contributions.agents);
      break;
    case "skill":
      result.skills.push(...contributions.skills);
      break;
    case "hook":
      result.afterExec.push(...contributions.afterExec);
      result.transform.push(...contributions.transform);
      result.textComplete.push(...contributions.textComplete);
      result.toolDefinition.push(...contributions.toolDefinition);
      result.onSettled.push(...contributions.onSettled);
      judges.push(...contributions.delegation);
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
 * List the capability keys a unit declared but the host did not provide.
 *
 * @param unit - The unit whose `needs` are checked.
 * @param provided - The capability bag supplied by the host.
 * @returns The missing keys, in declaration order (empty when satisfied).
 */
function missingNeeds(
  unit: UnitDescriptor,
  provided: Partial<Capabilities>,
): string[] {
  return unit.needs.filter((key) => provided[key] === undefined);
}

/**
 * Build the capability slice handed to one unit's factory.
 *
 * Only the declared `needs` and `wants` keys are copied (a `wants` key may
 * be absent); every other catalog key stays invisible to the factory.
 *
 * @param unit - The unit being instantiated.
 * @param provided - The capability bag supplied by the host.
 * @returns The unit's capability slice.
 */
function unitCapabilities(
  unit: UnitDescriptor,
  provided: Partial<Capabilities>,
): Partial<Capabilities> {
  const caps: Partial<Capabilities> = {};
  // The catalog mixes port types, so a plain keyed read yields their union;
  // copying through an untyped record keeps the value the host supplied.
  const target = caps as Record<string, unknown>;
  for (const key of [...unit.needs, ...unit.wants]) {
    // Ports carry behavior (functions / method objects), never lazy
    // accessors, so a plain value copy can never trigger side effects.
    target[key] = provided[key];
  }
  return caps;
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
 * Select and instantiate the profile-enabled units whose needs are met.
 *
 * A `null` profile (absent or invalid) returns an empty result and
 * instantiates nothing — no defaults, no fallback to a full load.
 * Otherwise the enablement sets are derived from the profile lists and
 * each enabled unit is matched against `provided`: a unit with any `needs`
 * key absent is skipped and recorded, a matching unit's factory runs with
 * its declared capability slice in the unit array's order.  Profile names
 * with no matching unit in the array are warned once via the shared logger
 * (`unknown_unit` event), unless `warnUnknownUnits` is `false`.
 *
 * @param profile - The active mode profile, or `null` when absent.
 * @param units - The unit array (caller-supplied).
 * @param provided - The capability bag supplied by the host.
 * @param opts - Optional per-pass options.
 * @returns The composed host-agnostic contributions and match report.
 */
export function composeProfile(
  profile: ModeProfile | null,
  units: UnitDescriptor[],
  provided: Partial<Capabilities>,
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
  const judges: DelegationJudgeContribution[] = [];

  for (const unit of units) {
    const category = PROFILE_CATEGORY[unit.kind];
    if (!profile[category].includes(unit.name)) continue;
    const missing = missingNeeds(unit, provided);
    if (missing.length > 0) {
      result.report.skipped.push({ name: unit.name, missing });
      log.info({
        hook: "compose",
        event: "unit_skipped",
        name: unit.name,
        missing,
      });
      continue;
    }
    const contributions = unit.create(
      unitCapabilities(unit, provided),
      activeSet,
    );
    result.report.activated.push(unit.name);
    collect(result, contributions, judges);
  }

  // Compose the delegation judges into a single gate (empty chain →
  // `null`, allow — a valid profile with no delegation judges).  The
  // host always knows whether a strategy exists by inspecting the gate.
  result.gate = composeGate(judges);
  // Whether any judge needs the caller field — the OpenCode host uses
  // this to decide if the asynchronous caller resolution must run.
  result.gateNeedsCaller = judges.some((judge) => judge.needsCaller === true);

  if (opts?.warnUnknownUnits !== false) {
    for (const category of CATEGORIES) {
      for (const name of profile[category]) {
        if (!known.has(name)) {
          log.warn({
            hook: "compose",
            event: "unknown_unit",
            category,
            name,
          });
        }
      }
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Isolated contribution runs
// ---------------------------------------------------------------------------

/**
 * Log context for an isolated contribution run.
 */
export interface IsolationLogContext {
  /** Session the contributions run for. */
  sessionID: string;
  /**
   * Call identifier written to a crash entry, omitted from the entry when
   * `undefined`.  A transform run carries no call id; a text-finalization
   * run uses the text part index (pi) or part id (OpenCode).
   */
  callId?: string;
}

/**
 * Log one crashed contribution as `handler_crashed` and swallow its error.
 *
 * @param name - The contribution's handler label.
 * @param logCtx - Session and call fields for the entry.
 * @param err - The thrown or rejected value.
 */
function logHandlerCrash(
  name: string,
  logCtx: IsolationLogContext,
  err: unknown,
): void {
  log.error({
    hook: "plugin",
    event: "handler_crashed",
    sessionId: logCtx.sessionID,
    callId: logCtx.callId,
    handler: name,
    error: String(err),
  });
}

/**
 * Run named contributions sequentially with per-contribution isolation.
 *
 * A contribution that throws (or rejects) is logged as `handler_crashed`
 * and never blocks the next: the run always proceeds through the whole
 * list.  `invoke` adapts a slot's handler signature to a single call — the
 * transform slot takes only the output while after-exec and
 * text-finalization take an input and an output.
 *
 * @param contributions - The named contributions in execution order.
 * @param invoke - Calls one contribution; a rejection is isolated.
 * @param logCtx - Session and call fields for a crash entry.
 */
export async function runIsolated<T extends { name: string }>(
  contributions: readonly T[],
  invoke: (contribution: T) => void | Promise<void>,
  logCtx: IsolationLogContext,
): Promise<void> {
  for (const contribution of contributions) {
    try {
      await invoke(contribution);
    } catch (err) {
      logHandlerCrash(contribution.name, logCtx, err);
    }
  }
}

/**
 * Whether a contribution's return value is a thenable whose rejection the
 * synchronous runner must still observe.
 *
 * @param value - A handler's return value.
 * @returns True when the value exposes a callable `then`.
 */
function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    typeof (value as { then?: unknown } | null | undefined)?.then === "function"
  );
}

/**
 * Synchronous variant of {@link runIsolated} for a loop the host consumes
 * synchronously.
 *
 * Isolation covers both error paths: a synchronous throw is logged as
 * `handler_crashed` and never blocks the next contribution, and a promise
 * returned by an async handler is not awaited but its rejection is attached
 * to and logged the same way — the rejection never escapes as an unhandled
 * rejection.  The host contract stays synchronous: the loop returns before
 * any such rejection settles.
 *
 * @param contributions - The named contributions in execution order.
 * @param invoke - Calls one contribution; a throw or returned rejection is
 *   isolated.
 * @param logCtx - Session and call fields for a crash entry.
 */
export function runIsolatedSync<T extends { name: string }>(
  contributions: readonly T[],
  invoke: (contribution: T) => unknown,
  logCtx: IsolationLogContext,
): void {
  for (const contribution of contributions) {
    try {
      const result = invoke(contribution);
      if (isThenable(result)) {
        result.then(undefined, (err: unknown) => {
          logHandlerCrash(contribution.name, logCtx, err);
        });
      }
    } catch (err) {
      logHandlerCrash(contribution.name, logCtx, err);
    }
  }
}
