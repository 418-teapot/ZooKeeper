/**
 * Declarative unit contract.
 *
 * A unit is the smallest loadable feature: an agent prompt, a hook bundle,
 * a tool, or a slash command.  A skill is a selectable resource, not a
 * unit (see `core/skills.ts`), so it never appears here.  A unit declares
 * the capabilities it consumes (`needs` = required, `wants` = optional
 * enhancement) and the selection facts it reads (`uses`), plus a factory;
 * the `define*` helpers derive the factory's capability slice and fact
 * projection from those lists, so a factory body reads only the ports and
 * facts it named and never has to check for an absent dependency — the
 * planner in `core/selection.ts` decides whether the unit runs at all.
 *
 * The same helpers own the contribution shape: a hook factory names only
 * the slots it fills, a tool factory returns the definition whose name
 * the unit supplies, and a prompt-only agent is a name plus a prompt.
 * No unit registration spells out a contribution envelope by hand.
 *
 * This module owns the host-agnostic contribution vocabulary (handler and
 * tool shapes) and the descriptor union.  It imports types only.
 *
 * @module
 */

import type { QuestionChannel } from "./ask.js";
import type { DelegationJudgeContribution } from "./gate.js";
import type { WorkPermit } from "./lifecycle/index.js";
import type { SettledContribution } from "./loop/settle.js";
import type { Capabilities } from "./ports/index.js";
import type { PromptVariantPair } from "./prompt-variant.js";
import type { SelectionFacts } from "./selection.js";

// ---------------------------------------------------------------------------
// Selection projection
// ---------------------------------------------------------------------------

/**
 * The selection facts a unit may read.
 *
 * A factory never receives the whole selection; it names the facts it
 * reads in `uses` and receives exactly that projection.  Reading a fact
 * is passive — it never activates anything.
 */
export type SelectionFactKey = keyof SelectionFacts;

/**
 * The selection-facts projection a factory body receives for one `uses`
 * list.
 */
export type UnitUses<U extends readonly SelectionFactKey[]> = Pick<
  SelectionFacts,
  U[number]
>;

// ---------------------------------------------------------------------------
// Handler input / output shapes
// ---------------------------------------------------------------------------

/** Input shape of the `tool.execute.before` hook. */
export interface ToolBeforeInput {
  tool: string;
  sessionID: string;
  callID: string;
}

/** Output shape of the `tool.execute.before` hook. */
export interface ToolBeforeOutput {
  args?: Record<string, unknown>;
}

/** Input shape of the `tool.execute.after` hook. */
export interface AfterExecInput {
  tool: string;
  sessionID: string;
  callID: string;
  args?: Record<string, unknown>;
}

/** Output shape of the `tool.execute.after` hook. */
export interface AfterExecOutput {
  output?: string;
}

/**
 * One argument schema within a host tool definition.
 *
 * Only `description` is contractually meaningful to `tool.definition`
 * enhancers; the remaining fields (`type`, `enum`, ...) are opaque host
 * schema markup that ride through untouched.
 */
export interface ToolArgDefinition {
  description?: string;
  [key: string]: unknown;
}

/**
 * Host-neutral view of a tool definition handed to `tool.definition`
 * enhancers.
 *
 * Both hosts translate their native definition onto this shape before the
 * contribution chain runs — OpenCode maps its `tool.definition` hook
 * output (`parameters.properties`) in
 * `adapters/opencode/profile-hooks.ts`; pi maps
 * `ToolContribution.args` at its registration boundary in
 * `adapters/pi/registration.ts`.  Contributors read the canonical tool
 * `name` and mutate per-argument `description` fields; the host writes the
 * changes back into its native definition.
 */
export interface ToolDefinitionView {
  /** Canonical tool name (OpenCode's native `task` maps to `subagent`). */
  name: string;
  /** Tool description. */
  description?: string;
  /** Per-argument schemas keyed by argument name. */
  args?: Record<string, ToolArgDefinition>;
}

/** Input shape of a slash-command handler. */
export interface CommandInput {
  command: string;
  sessionID: string;
  arguments: string;
}

/**
 * Minimal messages-transform output shape.
 *
 * Core-owned and deliberately opaque: the host payload carries a
 * `messages` array whose entry shape the host adapter owns.  A core
 * module reads it only by forwarding it to a v1-specific handler (the
 * handler casts `messages` to its host entry type).
 */
export interface TransformOutput {
  messages: unknown;
}

// ---------------------------------------------------------------------------
// Contribution slots
// ---------------------------------------------------------------------------

/**
 * One named `tool.execute.after` handler contributed by a hook unit.
 *
 * The host adapter isolates each handler — a throwing handler never
 * blocks the next.
 */
export interface AfterExecContribution {
  /** Handler label used for logging. */
  name: string;
  handle(input: AfterExecInput, output: AfterExecOutput): void | Promise<void>;
}

/**
 * One named `experimental.chat.messages.transform` handler.
 *
 * Transform handlers run in registration order, each isolating its own
 * errors.  The handler receives the session its host admitted the event
 * for, so a transform that reads session-owned state addresses that
 * session instead of inferring one from the messages.
 */
export interface TransformContribution {
  /** Handler label used for logging. */
  name: string;
  /**
   * Transform the output in place.
   *
   * @param output - The messages transform output.
   * @param sessionID - The session the host admitted this event for, or
   *   undefined when the host could not name one.
   * @param permit - The permit the host admitted this event under, or
   *   undefined when the host holds no permit (a pure test call).  A
   *   handler that reads session records writes them only under an active
   *   permit.
   */
  handle(
    output: TransformOutput,
    sessionID?: string,
    permit?: WorkPermit,
  ): void | Promise<void>;
}

/** Input shape of the text-finalization hook. */
export interface TextCompleteInput {
  sessionID: string;
  messageID: string;
  partID: string;
}

/** Output shape of the text-finalization hook. */
export interface TextCompleteOutput {
  text: string;
}

/**
 * One named text-finalization handler contributed by a hook unit.
 *
 * The handler mutates `output.text` (e.g. stripping model-imitated
 * line-start ref echoes).  Handlers run in registration order, each
 * isolating its own errors.
 */
export interface TextCompleteContribution {
  /** Handler label used for logging. */
  name: string;
  handle(
    input: TextCompleteInput,
    output: TextCompleteOutput,
  ): void | Promise<void>;
}

/**
 * One named `tool.definition` enhancer contributed by a hook unit.
 *
 * The handler mutates the host-neutral {@link ToolDefinitionView},
 * typically appending guidance to a tool argument's `description`.
 */
export interface ToolDefinitionContribution {
  /** Handler label used for logging. */
  name: string;
  handle(view: ToolDefinitionView): void | Promise<void>;
}

/**
 * The structured payload of one tool call.
 *
 * A tool returns its model-facing `text` and, when it has one, the
 * structured payload a host persists with the result.  The tool never
 * writes into a host object: the host adapter maps the result onto its
 * own result shape.
 */
export interface ToolResult {
  /** Model-facing text. */
  text: string;
  /** Structured payload for hosts that persist one. */
  data?: unknown;
}

/**
 * The host-neutral context of one tool call.
 *
 * Every field the tool needs to run belongs here, already translated by
 * the host adapter: the tool never reads a host object.
 */
export interface ToolCallContext {
  /** The session this call belongs to. */
  sessionID: string;
  /** The host's tool-call id, when the host names one. */
  callID?: string;
  /**
   * The call's cancellation signal.  An admitted call receives the
   * permit's signal, so it stops when the session or the host stops.
   */
  signal: AbortSignal;
  /**
   * The permit the host admitted this call under.  A tool that reads or
   * writes session records uses it for every `ContextRuntime` operation.
   */
  permit?: WorkPermit;
  /**
   * Request a repaint of the host's live card for this call.
   *
   * A host without a live card omits it.  The call carries no payload:
   * the card projects its own state.
   */
  notifyChanged?(): void;
  /**
   * The host's question channel, or omitted when the host cannot ask the
   * user anything.
   */
  questionChannel?: QuestionChannel;
}

/**
 * One tool record, as the composition result and the host registration
 * boundary read it.
 *
 * A tool unit's factory returns the definition without the name (see
 * {@link ToolDefinition}); the descriptor adds it back, so `name` doubles
 * as the unit name, the registry key, and the log label.
 */
export interface ToolContribution {
  /** Tool name (registry key). */
  name: string;
  description: string;
  /** JSON-schema-style argument description (optional). */
  args?: Record<string, unknown>;
  /** Names of required top-level parameters within `args`. */
  required?: string[];
  /**
   * Execute the tool.
   *
   * The call context is already host-neutral: the adapter translated the
   * host's execution context into it.  The result is structured, so the
   * host adapter maps it onto its own result shape.
   *
   * @param args - The raw tool arguments.
   * @param call - The call's host-neutral context.
   * @returns The call's text and optional structured payload.
   */
  execute(args: unknown, call: ToolCallContext): Promise<ToolResult>;
}

/**
 * A tool definition as a tool unit's factory returns it.
 *
 * Everything a {@link ToolContribution} carries except the name: the
 * unit descriptor supplies that from its own `name`, so a tool is named
 * exactly once.
 */
export type ToolDefinition = Omit<ToolContribution, "name">;

/**
 * One slash-command record.
 *
 * Registration and handler are atomic: description and `handle` always
 * travel together.  `name` doubles as the registry key.
 */
export interface CommandContribution {
  /** Command name (registry key, e.g. `"go"`). */
  name: string;
  description: string;
  /**
   * Whether the command replaces the current host session: a plan handoff
   * or a primary switch closes the session it belongs to.  A host admits
   * such a command as a control operation that its own stop does not wait
   * for; every other command runs as ordinary session work.
   */
  replacesSession?: boolean;
  /**
   * Handle the command.
   *
   * @param input - The command name, session, and raw arguments.
   * @param permit - The permit the host admitted the command under, or
   *   undefined when the host holds none.  A handler that reads or writes
   *   session records writes them only under an active permit.
   */
  handle(input: CommandInput, permit?: WorkPermit): Promise<void>;
}

/** An agent prompt-injection contribution. */
export interface AgentContribution {
  /** Agent name (registry key). */
  name: string;
  /** The prompt text injected into the agent definition. */
  prompt: string;
  /**
   * Runtime model-family wordings for this agent's prompt, swapped by
   * `applyModelVariant` when the active model changes.  Omitted by an
   * agent that ships a single wording; the host then swaps nothing.
   */
  readonly promptVariants?: readonly PromptVariantPair[];
}

// ---------------------------------------------------------------------------
// Contribution collections
// ---------------------------------------------------------------------------

/** Contributions produced by an agent unit. */
export interface AgentUnitContributions {
  kind: "agent";
  agents: AgentContribution[];
}

/**
 * Contributions produced by a hook unit.
 *
 * All handler slots are required arrays — a hook factory names only the
 * slots it contributes to and {@link defineHook} fills the rest in.
 */
export interface HookUnitContributions {
  kind: "hook";
  afterExec: AfterExecContribution[];
  transform: TransformContribution[];
  textComplete: TextCompleteContribution[];
  toolDefinition: ToolDefinitionContribution[];
  delegation: DelegationJudgeContribution[];
  onSettled: SettledContribution[];
}

/** Contributions produced by a tool unit. */
export interface ToolUnitContributions {
  kind: "tool";
  tools: ToolContribution[];
}

/** Contributions produced by a command unit. */
export interface CommandUnitContributions {
  kind: "command";
  commands: CommandContribution[];
}

/** The union of all per-kind contribution collections. */
export type UnitContributions =
  | AgentUnitContributions
  | HookUnitContributions
  | ToolUnitContributions
  | CommandUnitContributions;

/**
 * Complete a hook unit's contribution set.
 *
 * A hook unit contributes to at most a few slots, so its factory names
 * only those and every other slot stays uniformly empty.  `kind` is fixed
 * here and never part of `partial`.
 *
 * @param partial - The slots the unit contributes; omitted slots stay
 *   empty.
 * @returns The complete hook contribution set.
 */
function completeHookContributions(
  partial: Partial<Omit<HookUnitContributions, "kind">>,
): HookUnitContributions {
  return {
    kind: "hook",
    afterExec: [],
    transform: [],
    textComplete: [],
    toolDefinition: [],
    delegation: [],
    onSettled: [],
    ...partial,
  };
}

// ---------------------------------------------------------------------------
// Descriptor contract
// ---------------------------------------------------------------------------

/** The four loadable unit kinds. */
export type UnitKind = "agent" | "hook" | "tool" | "command";

/** The capability keys a unit may declare in `needs` / `wants`. */
export type CapabilityKey = keyof Capabilities;

/** Descriptor of an agent unit. */
export interface AgentUnitDescriptor {
  name: string;
  kind: "agent";
  needs: readonly CapabilityKey[];
  wants: readonly CapabilityKey[];
  uses: readonly SelectionFactKey[];
  create(
    caps: Partial<Capabilities>,
    facts: SelectionFacts,
  ): AgentUnitContributions;
}

/** Descriptor of a hook unit. */
export interface HookUnitDescriptor {
  name: string;
  kind: "hook";
  needs: readonly CapabilityKey[];
  wants: readonly CapabilityKey[];
  uses: readonly SelectionFactKey[];
  create(
    caps: Partial<Capabilities>,
    facts: SelectionFacts,
  ): HookUnitContributions;
}

/** Descriptor of a tool unit. */
export interface ToolUnitDescriptor {
  name: string;
  kind: "tool";
  needs: readonly CapabilityKey[];
  wants: readonly CapabilityKey[];
  uses: readonly SelectionFactKey[];
  create(
    caps: Partial<Capabilities>,
    facts: SelectionFacts,
  ): ToolUnitContributions;
}

/** Descriptor of a command unit. */
export interface CommandUnitDescriptor {
  name: string;
  kind: "command";
  needs: readonly CapabilityKey[];
  wants: readonly CapabilityKey[];
  uses: readonly SelectionFactKey[];
  create(
    caps: Partial<Capabilities>,
    facts: SelectionFacts,
  ): CommandUnitContributions;
}

/**
 * One self-describing loadable unit.
 *
 * The discriminated union lets the build step narrow both the unit kind
 * and its contribution collection from `create`.
 */
export type UnitDescriptor =
  | AgentUnitDescriptor
  | HookUnitDescriptor
  | ToolUnitDescriptor
  | CommandUnitDescriptor;

// ---------------------------------------------------------------------------
// Definition helpers
// ---------------------------------------------------------------------------

/**
 * The capability slice a factory body receives.
 *
 * `needs` keys are required (the planner checks every need); `wants` keys
 * may be absent.  Every other catalog key is excluded, so a factory cannot
 * accidentally read a port it did not declare.  `Required` changes nothing
 * while every catalog field is required; it keeps `needs` required if a
 * field ever becomes optional.
 */
export type UnitCaps<
  N extends readonly CapabilityKey[],
  W extends readonly CapabilityKey[],
> = Required<Pick<Capabilities, N[number]>> &
  Partial<Pick<Capabilities, W[number]>>;

/**
 * Assemble a descriptor from a definition.
 *
 * The factory is wrapped so the shared descriptor `create` signature
 * receives the bound capability declaration and the finished selection
 * while the definition body only sees the declared capability slice and the
 * `uses` projection.  The planner has already verified every `needs` key is
 * available, which is what makes the slice's required keys safe to treat
 * as present.
 *
 * @param kind - The unit kind.
 * @param d - The definition.
 * @returns The descriptor.
 */
function defineUnit<
  K extends UnitKind,
  const N extends readonly CapabilityKey[],
  const W extends readonly CapabilityKey[],
  const U extends readonly SelectionFactKey[],
  R,
>(
  kind: K,
  d: {
    name: string;
    needs: N;
    wants?: W;
    uses?: U;
    create(caps: UnitCaps<N, W>, uses: UnitUses<U>): R;
  },
): {
  name: string;
  kind: K;
  needs: readonly CapabilityKey[];
  wants: readonly CapabilityKey[];
  uses: readonly SelectionFactKey[];
  create(caps: Partial<Capabilities>, facts: SelectionFacts): R;
} {
  const uses: readonly SelectionFactKey[] = d.uses ?? [];
  return {
    name: d.name,
    kind,
    needs: d.needs,
    wants: d.wants ?? [],
    uses,
    create(caps, facts) {
      return d.create(
        caps as UnitCaps<N, W>,
        projectFacts(facts, uses) as UnitUses<U>,
      );
    },
  };
}

/**
 * Project the named selection facts out of the finished selection.
 *
 * Only the keys the unit named in `uses` are copied, so a factory cannot
 * read a fact it did not declare.
 *
 * @param facts - The finished selection.
 * @param uses - The fact keys the unit declared.
 * @returns The unit's fact projection.
 */
function projectFacts(
  facts: SelectionFacts,
  uses: readonly SelectionFactKey[],
): Record<string, unknown> {
  const projected: Record<string, unknown> = {};
  for (const key of uses) {
    projected[key] = facts[key];
  }
  return projected;
}

/**
 * The prompt payload an agent unit's factory returns.
 *
 * An agent unit contributes exactly one agent — the one named by the
 * descriptor — so the factory returns the prompt data only and the
 * descriptor supplies the name.
 */
export interface AgentDefinition {
  /** The prompt text injected into the agent definition. */
  prompt: string;
  /** Runtime model-family wordings, swapped by `applyModelVariant`. */
  promptVariants?: readonly PromptVariantPair[];
}

/**
 * Define an agent unit.
 *
 * A selected agent unit always contributes exactly one agent contribution
 * under its own name, so the factory cannot contribute a differently
 * named or multi-entry agent set.
 *
 * @param d - Name, capability lists, fact uses, and prompt factory.
 * @returns The agent unit descriptor.
 */
export function defineAgent<
  const N extends readonly CapabilityKey[],
  const W extends readonly CapabilityKey[] = [],
  const U extends readonly SelectionFactKey[] = [],
>(d: {
  name: string;
  needs: N;
  wants?: W;
  uses?: U;
  create(caps: UnitCaps<N, W>, uses: UnitUses<U>): AgentDefinition;
}): AgentUnitDescriptor {
  return defineUnit("agent", {
    name: d.name,
    needs: d.needs,
    wants: d.wants,
    uses: d.uses,
    create(caps, uses) {
      const { prompt, promptVariants } = d.create(caps, uses);
      return {
        kind: "agent" as const,
        agents: [
          {
            name: d.name,
            prompt,
            ...(promptVariants !== undefined ? { promptVariants } : {}),
          },
        ],
      };
    },
  });
}

/**
 * Define a data-only agent unit: a fixed prompt under the agent's name.
 *
 * An agent that carries no runtime behavior contributes nothing but its
 * prompt, so its descriptor is generated from the name and the prompt
 * text — the name is written once and reaches both the descriptor and
 * the contribution.
 *
 * @param name - The agent name (registry key).
 * @param prompt - The prompt text injected into the agent definition.
 * @returns The agent unit descriptor.
 */
export function definePromptAgent(
  name: string,
  prompt: string,
): AgentUnitDescriptor {
  return defineAgent({
    name,
    needs: [],
    create() {
      return { prompt };
    },
  });
}

/**
 * Define a hook unit.
 *
 * The factory returns only the slots the unit contributes to; the
 * descriptor completes the set with empty arrays (see
 * {@link completeHookContributions}).
 *
 * @param d - Name, capability lists, fact uses, and factory.
 * @returns The hook unit descriptor.
 */
export function defineHook<
  const N extends readonly CapabilityKey[],
  const W extends readonly CapabilityKey[] = [],
  const U extends readonly SelectionFactKey[] = [],
>(d: {
  name: string;
  needs: N;
  wants?: W;
  uses?: U;
  create(
    caps: UnitCaps<N, W>,
    uses: UnitUses<U>,
  ): Partial<Omit<HookUnitContributions, "kind">>;
}): HookUnitDescriptor {
  return defineUnit("hook", {
    name: d.name,
    needs: d.needs,
    wants: d.wants,
    uses: d.uses,
    create(caps, uses) {
      return completeHookContributions(d.create(caps, uses));
    },
  });
}

/**
 * Define a tool unit.
 *
 * A selected tool unit always contributes exactly one tool named after
 * the unit, so the factory returns the definition itself: the host's
 * availability keys decide whether the unit runs at all, which leaves no
 * "environment unavailable" return path here.
 *
 * @param d - Name, capability lists, fact uses, and factory.
 * @returns The tool unit descriptor.
 */
export function defineTool<
  const N extends readonly CapabilityKey[],
  const W extends readonly CapabilityKey[] = [],
  const U extends readonly SelectionFactKey[] = [],
>(d: {
  name: string;
  needs: N;
  wants?: W;
  uses?: U;
  create(caps: UnitCaps<N, W>, uses: UnitUses<U>): ToolDefinition;
}): ToolUnitDescriptor {
  return defineUnit("tool", {
    name: d.name,
    needs: d.needs,
    wants: d.wants,
    uses: d.uses,
    create(caps, uses) {
      return {
        kind: "tool" as const,
        tools: [{ name: d.name, ...d.create(caps, uses) }],
      };
    },
  });
}

/**
 * Define a command unit.
 *
 * @param d - Name, capability lists, fact uses, and factory.
 * @returns The command unit descriptor.
 */
export function defineCommand<
  const N extends readonly CapabilityKey[],
  const W extends readonly CapabilityKey[] = [],
  const U extends readonly SelectionFactKey[] = [],
>(d: {
  name: string;
  needs: N;
  wants?: W;
  uses?: U;
  create(caps: UnitCaps<N, W>, uses: UnitUses<U>): CommandUnitContributions;
}): CommandUnitDescriptor {
  return defineUnit("command", d);
}
