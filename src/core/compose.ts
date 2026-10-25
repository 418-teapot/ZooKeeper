/**
 * Host-agnostic assembly: plan → bind → build.
 *
 * This module is the single assembly point of the capability model.  It
 * runs the three stages in a fixed order:
 *
 *  1. **Plan** — {@link planSelection} reads the declared enablement (mode
 *     profile plus unit array), the capability availability keys, the
 *     agent-modes map, the host's declared orchestrator role and the
 *     host's agent materialisation facts, and returns the immutable
 *     `Selection`.  No factory runs and nothing is probed.
 *  2. **Bind** — the host's `CapabilityBindings` turn that selection into
 *     the complete capability record; a key is unavailable exactly when
 *     the host cannot bind it.
 *  3. **Build** — {@link buildComposition} instantiates each selected unit
 *     exactly once, in registry order, handing it its declared capability
 *     slice and its `uses` fact projection, and collects the
 *     contributions.
 *
 * A selection that is `disabled` (no profile) or `invalid` (the declared
 * orchestrator role is unavailable, or the host will not materialise a
 * selected agent) stops after planning: nothing is bound, nothing is
 * instantiated, and only the report travels on.
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
import type { CapabilityBindings } from "./bindings.js";
import type { AgentModeMap, ModeProfile } from "./config-types.js";
import type { DelegationGate, DelegationJudgeContribution } from "./gate.js";
import { composeGate } from "./gate.js";
import type { SettledContribution } from "./loop/settle.js";
import type { Capabilities } from "./ports/index.js";
import type { Selection, SelectionReport } from "./selection.js";
import { type AgentMaterialisation, planSelection } from "./selection.js";
import type {
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

/** What the planner selected, skipped, and could not resolve. */
export type CompositionReport = SelectionReport;

/**
 * Host-agnostic contributions produced by the build stage.
 *
 * Handler arrays keep the registry's order; `tools` and `commands` are
 * keyed by contribution name.  The host adapter turns this into framework
 * registrations (event keys appear only when their arrays are non-empty).
 */
export interface ComposedResult {
  /** Selected agent prompt contributions. */
  agents: AgentContribution[];
  /** Selected skill contributions. */
  skills: SkillContribution[];
  /** Selected `tool.execute.after` handlers. */
  afterExec: AfterExecContribution[];
  /** Selected messages-transform handlers. */
  transform: TransformContribution[];
  /** Selected text-finalization handlers. */
  textComplete: TextCompleteContribution[];
  /** Selected `tool.definition` enhancers. */
  toolDefinition: ToolDefinitionContribution[];
  /** Selected loop settle handlers. */
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
  /** Selected tools, keyed by tool name. */
  tools: Record<string, ToolContribution>;
  /** Selected commands, keyed by command name. */
  commands: Record<string, CommandContribution>;
  /** What the planner selected, skipped, and could not resolve. */
  report: CompositionReport;
}

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
    report: {
      selected: [],
      skipped: [],
      unknown: [],
      invalid: null,
      unmaterialised: [],
    },
  };
}

/**
 * Build an empty composition result that carries the planner's report.
 *
 * @param report - The report of the pass that produced no contributions.
 * @returns The empty result.
 */
function emptyComposition(report: SelectionReport): ComposedResult {
  return { ...emptyResult(), report };
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
 * Build the capability slice handed to one unit's factory.
 *
 * Only the declared `needs` and `wants` keys are copied (a `wants` key may
 * be absent); every other catalog key stays invisible to the factory.
 *
 * @param unit - The unit being instantiated.
 * @param capabilities - The bound capability record.
 * @returns The unit's capability slice.
 */
function unitCapabilities(
  unit: UnitDescriptor,
  capabilities: Capabilities,
): Partial<Capabilities> {
  const caps: Partial<Capabilities> = {};
  // The catalog mixes port types, so a plain keyed read yields their union;
  // copying through an untyped record keeps the value the host supplied.
  const source = capabilities as unknown as Record<string, unknown>;
  const target = caps as Record<string, unknown>;
  for (const key of [...unit.needs, ...unit.wants]) {
    // Ports carry behavior (functions / method objects), never lazy
    // accessors, so a plain value copy can never trigger side effects.
    target[key] = source[key];
  }
  return caps;
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

/**
 * Instantiate the selected units and collect their contributions.
 *
 * Every selected unit's factory runs exactly once, in registry order.  The
 * planner already verified each unit's `needs` against the same key set
 * the binder produced, so the build stage does no further matching: a
 * missing port is a planning/binding inconsistency, not a runtime
 * possibility.
 *
 * A selection that is not `ready` (no profile, a declared orchestrator
 * the profile cannot provide, or a host that will not materialise a
 * selected agent) instantiates nothing and only carries its report
 * through.
 *
 * @param selection - The finished, frozen selection.
 * @param capabilities - The capability record bound for that selection.
 * @returns The composed host-agnostic contributions.
 */
export function buildComposition(
  selection: Selection,
  capabilities: Capabilities,
): ComposedResult {
  if (selection.status !== "ready") {
    return emptyComposition(selection.report);
  }

  const result = emptyResult();
  const judges: DelegationJudgeContribution[] = [];

  for (const unit of selection.chosen) {
    const contributions = unit.create(
      unitCapabilities(unit, capabilities),
      selection,
    );
    collect(result, contributions, judges);
  }

  // Compose the delegation judges into a single gate (empty chain →
  // `null`, allow — a valid profile with no delegation judges).  The
  // host always knows whether a strategy exists by inspecting the gate.
  result.gate = composeGate(judges);
  // Whether any judge needs the caller field — the OpenCode host uses
  // this to decide if the asynchronous caller resolution must run.
  result.gateNeedsCaller = judges.some((judge) => judge.needsCaller === true);
  result.report = selection.report;
  return result;
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

/** The inputs of one assembly pass. */
export interface AssembleInput {
  /** The declared mode profile, or `null` when absent/invalid. */
  profile: ModeProfile | null;
  /** The declared unit array (registry order is execution order). */
  units: readonly UnitDescriptor[];
  /** The host's capability declaration. */
  bindings: CapabilityBindings;
  /** Per-agent role map, used to derive the primaries. */
  agentModes: AgentModeMap;
  /**
   * The orchestrator role the host declares for this pass, or `undefined`
   * when the host declares none.  A declared orchestrator the enabled
   * primaries cannot provide makes the selection invalid.
   */
  orchestrator?: string;
  /**
   * What the host will materialise (agent names and the ones it accepts
   * as its default agent), or `undefined` when the host imposes no
   * materialisation constraint.  A selected agent the host will not
   * create makes the selection invalid before the bind stage runs.
   */
  materialisation?: AgentMaterialisation;
}

/** The outcome of one assembly pass. */
export interface Assembly {
  /** The frozen selection the build ran from. */
  readonly selection: Selection;
  /** The contributions the selected units produced. */
  readonly composed: ComposedResult;
}

/**
 * Log what the planner selected and skipped, and warn for every profile
 * name the unit array does not declare.
 *
 * @param selection - The finished selection.
 */
function logSelection(selection: Selection): void {
  const invalid = selection.report.invalid;
  if (selection.status === "invalid") {
    log.error({
      hook: "compose",
      event: "selection_invalid",
      orchestrator: invalid?.orchestrator,
      cause: invalid?.cause,
      primaries: invalid?.primaries,
      unmaterialised: selection.report.unmaterialised,
    });
  }
  for (const skip of selection.report.skipped) {
    log.info({
      hook: "compose",
      event: "unit_skipped",
      name: skip.name,
      missing: skip.missing,
    });
  }
  for (const entry of selection.report.unknown) {
    log.warn({
      hook: "compose",
      event: "unknown_unit",
      category: entry.category,
      name: entry.name,
    });
  }
}

/**
 * Run one assembly pass: plan, bind, then build.
 *
 * A `null` profile (absent or invalid) selects and instantiates nothing —
 * no defaults, no fallback to a full load.  Otherwise the planner matches
 * every profile-enabled unit against the host's availability keys, the
 * binder turns the selection into the complete capability record (a
 * declared key that cannot be bound throws before any factory runs), and
 * the build stage instantiates exactly the selected units in registry
 * order.
 *
 * A declared orchestrator role that the profile cannot provide, or a
 * selected agent the host will not materialise, is an invalid selection:
 * the pass logs it, binds nothing and instantiates nothing, so a
 * misconfigured profile stays empty instead of running with a role nobody
 * declared or an agent the host never creates.
 *
 * @param input - The profile, unit array, bindings, agent modes, role,
 *   and materialisation facts.
 * @returns The selection the pass ran from and the composed result.
 */
export function assemble(input: AssembleInput): Assembly {
  const selection = planSelection({
    profile: input.profile,
    units: input.units,
    available: input.bindings.keys,
    agentModes: input.agentModes,
    orchestrator: input.orchestrator,
    materialisation: input.materialisation,
  });
  logSelection(selection);
  const composed =
    selection.status === "ready"
      ? buildComposition(selection, input.bindings.bind(selection))
      : emptyComposition(selection.report);
  return { selection, composed };
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
