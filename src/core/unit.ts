/**
 * Declarative unit contract.
 *
 * A unit is the smallest loadable feature: an agent prompt, a skill
 * directory, a hook bundle, a tool, or a slash command.  A unit declares
 * the capabilities it consumes (`needs` = required, `wants` = optional
 * enhancement) and a factory; the `define*` helpers derive the factory's
 * capability slice from those two lists, so a factory body reads only the
 * ports it named and never has to check for an absent dependency — the
 * central matcher in `core/compose.ts` decides whether the unit runs at
 * all.
 *
 * This module owns the host-agnostic contribution vocabulary (handler and
 * tool shapes) and the descriptor union.  It imports types only.
 *
 * @module
 */

import type { DelegationJudgeContribution } from "./gate.js";
import type { SettledContribution } from "./loop/settle.js";
import type { Capabilities } from "./ports/index.js";
import type { PromptVariantPair } from "./prompt-variant.js";

// ---------------------------------------------------------------------------
// Enablement
// ---------------------------------------------------------------------------

/**
 * Enablement sets built from the active mode profile.
 *
 * Handed to unit factories so a unit can adapt its contributions to
 * sibling enablement (e.g. a hook unit checking whether the `compress`
 * tool is registered).
 */
export interface ActiveSet {
  /** Enabled agent names. */
  agents: ReadonlySet<string>;
  /** Enabled skill names. */
  skills: ReadonlySet<string>;
  /** Enabled hook unit names. */
  hooks: ReadonlySet<string>;
  /** Enabled tool names. */
  tools: ReadonlySet<string>;
  /** Enabled slash-command names. */
  commands: ReadonlySet<string>;
}

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
 * output (`parameters.properties`) in `compose-opencode.ts`; pi maps
 * `ToolContribution.args` at its registration boundary in
 * `compose-pi.ts`.  Contributors read the canonical tool `name` and mutate
 * per-argument `description` fields; the host writes the changes back into
 * its native definition.
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
 * errors.
 */
export interface TransformContribution {
  /** Handler label used for logging. */
  name: string;
  handle(output: TransformOutput): void | Promise<void>;
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
 * An OpenCode tool definition object, structurally equivalent to the
 * current `CompressToolDefinition` / `DecompressToolDefinition`.
 *
 * `name` doubles as the registry key and the log label.
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
   * `toolCtx` is the host tool execution context (an OpenCode tool context
   * on OpenCode, a pi `ExtensionContext` on pi).  The optional `hostCtx`
   * third argument carries the host-forwarded execution surface: the abort
   * `signal`, the tool-call `callId`, and the `onUpdate` repaint-signal
   * callback, all forwarded by the pi bridge from the native tool
   * signature.  `onUpdate` is a content-free repaint trigger, never a text
   * channel: pi re-renders a live tool card whenever a partial result
   * arrives, so a tool driving a live view sends an empty partial
   * `{ content: [] }` instead of streaming text.  Hosts that do not
   * forward these (OpenCode, which invokes tools natively) simply omit the
   * third argument.
   */
  execute(
    args: unknown,
    toolCtx: unknown,
    hostCtx?: {
      signal?: AbortSignal;
      /** The host tool-call id (the pi tool-call id), forwarded by the pi
       * bridge from the native tool signature.  Used as the run id by the
       * subagent tool's registry write. */
      callId?: string;
      /** The host's partial-result callback (pi's `onUpdate`): a
       * content-free repaint signal, never a text channel. */
      onUpdate?: unknown;
      /**
       * Write-back slot for a structured result payload (pi's tool-result
       * `details` slot).  The bridge allocates this object per call, reads
       * `details` back AFTER `execute` resolves, and merges a plain object
       * into the host result's details — so a tool whose text is a
       * model-facing summary can still hand renderers the structured
       * outcome behind it (the `ask` tool's per-question results).
       * Leaving it unset changes nothing; hosts that do not build this
       * object (OpenCode) never see it.
       */
      details?: unknown;
    },
  ): Promise<string>;
  /**
   * Optional scheduling hint forwarded to hosts that support it (pi's
   * native `ToolDefinition.executionMode`).
   *
   * `"sequential"` forces the tool to run one call at a time with respect
   * to every other tool call in the turn.  Tools that need exclusivity over
   * their own state get it from a sequencer instead (see
   * `core/sequencer.js`), because the host-wide hint would also block
   * unrelated concurrent work.  Omitted → the host default; hosts without
   * per-tool scheduling ignore it.
   */
  executionMode?: "sequential" | "parallel";
  /**
   * Optional host TUI renderers for the tool's transcript card.
   *
   * Present only on hosts that supply a renderer: `renderCall` draws the
   * initial tool-call card, `renderResult` draws the live partial /
   * terminal card from the structured progress in the result `details`.
   * Structurally loose (never importing host types in core); hosts that do
   * not render tools (OpenCode) simply omit them.
   */
  renderCall?(args: unknown, theme: unknown, context?: unknown): unknown;
  renderResult?(
    result: unknown,
    options: unknown,
    theme: unknown,
    context?: unknown,
  ): unknown;
}

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
  handle(input: CommandInput): Promise<void>;
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

/** A skill registration contribution (directory under skills/). */
export interface SkillContribution {
  /** Skill directory name (registry key). */
  name: string;
}

// ---------------------------------------------------------------------------
// Contribution collections
// ---------------------------------------------------------------------------

/** Contributions produced by an agent unit. */
export interface AgentUnitContributions {
  kind: "agent";
  agents: AgentContribution[];
}

/** Contributions produced by a skill unit. */
export interface SkillUnitContributions {
  kind: "skill";
  skills: SkillContribution[];
}

/**
 * Contributions produced by a hook unit.
 *
 * All handler slots are required arrays — a unit that does not contribute
 * to a slot returns an empty array (see {@link makeHookContributions}).
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
  | SkillUnitContributions
  | HookUnitContributions
  | ToolUnitContributions
  | CommandUnitContributions;

/**
 * Build a hook unit's contribution set with every slot defaulted to an
 * empty array and the named slots overridden.
 *
 * A hook unit contributes to at most a few slots; this constructor keeps
 * the unconcerned slots uniformly empty so `create` names only the
 * handlers it actually contributes.  `kind` is fixed to `"hook"` and is
 * never part of `partial`.
 *
 * @param partial - The slots to contribute; omitted slots stay empty.
 * @returns The complete hook contribution set.
 */
export function makeHookContributions(
  partial: Partial<Omit<HookUnitContributions, "kind">> = {},
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

/** The five loadable unit kinds. */
export type UnitKind = "agent" | "skill" | "hook" | "tool" | "command";

/** The capability keys a unit may declare in `needs` / `wants`. */
export type CapabilityKey = keyof Capabilities;

/** Descriptor of an agent unit. */
export interface AgentUnitDescriptor {
  name: string;
  kind: "agent";
  needs: readonly CapabilityKey[];
  wants: readonly CapabilityKey[];
  create(
    caps: Partial<Capabilities>,
    activeSet: ActiveSet,
  ): AgentUnitContributions;
}

/** Descriptor of a skill unit. */
export interface SkillUnitDescriptor {
  name: string;
  kind: "skill";
  needs: readonly CapabilityKey[];
  wants: readonly CapabilityKey[];
  create(
    caps: Partial<Capabilities>,
    activeSet: ActiveSet,
  ): SkillUnitContributions;
}

/** Descriptor of a hook unit. */
export interface HookUnitDescriptor {
  name: string;
  kind: "hook";
  needs: readonly CapabilityKey[];
  wants: readonly CapabilityKey[];
  create(
    caps: Partial<Capabilities>,
    activeSet: ActiveSet,
  ): HookUnitContributions;
}

/** Descriptor of a tool unit. */
export interface ToolUnitDescriptor {
  name: string;
  kind: "tool";
  needs: readonly CapabilityKey[];
  wants: readonly CapabilityKey[];
  create(
    caps: Partial<Capabilities>,
    activeSet: ActiveSet,
  ): ToolUnitContributions;
}

/** Descriptor of a command unit. */
export interface CommandUnitDescriptor {
  name: string;
  kind: "command";
  needs: readonly CapabilityKey[];
  wants: readonly CapabilityKey[];
  create(
    caps: Partial<Capabilities>,
    activeSet: ActiveSet,
  ): CommandUnitContributions;
}

/**
 * One self-describing loadable unit.
 *
 * The discriminated union lets `composeProfile` narrow both the unit kind
 * and its contribution collection from `create`.
 */
export type UnitDescriptor =
  | AgentUnitDescriptor
  | SkillUnitDescriptor
  | HookUnitDescriptor
  | ToolUnitDescriptor
  | CommandUnitDescriptor;

// ---------------------------------------------------------------------------
// Definition helpers
// ---------------------------------------------------------------------------

/**
 * The capability slice a factory body receives.
 *
 * `needs` keys are non-optional; `wants` keys may be absent.  Every other
 * catalog key is excluded, so a factory cannot accidentally read a port it
 * did not declare.
 */
export type UnitCaps<
  N extends readonly CapabilityKey[],
  W extends readonly CapabilityKey[],
> = Pick<Capabilities, N[number]> & Partial<Pick<Capabilities, W[number]>>;

/** The shape shared by every `define*` input. */
/**
 * Assemble a descriptor from a definition.
 *
 * The factory is wrapped so the shared descriptor `create` signature
 * receives the full capability bag while the definition body only sees the
 * declared slice.  The matcher has already verified every `needs` key is
 * present, which is what makes the slice's required keys safe to treat as
 * present.
 *
 * @param kind - The unit kind.
 * @param d - The definition.
 * @returns The descriptor.
 */
function defineUnit<K extends UnitKind, R>(
  kind: K,
  d: {
    name: string;
    needs: readonly CapabilityKey[];
    wants?: readonly CapabilityKey[];
    create(caps: never, activeSet: ActiveSet): R;
  },
): {
  name: string;
  kind: K;
  needs: readonly CapabilityKey[];
  wants: readonly CapabilityKey[];
  create(caps: Partial<Capabilities>, activeSet: ActiveSet): R;
} {
  return {
    name: d.name,
    kind,
    needs: d.needs,
    wants: d.wants ?? [],
    create(caps, activeSet) {
      return (d.create as (c: Partial<Capabilities>, a: ActiveSet) => R)(
        caps,
        activeSet,
      );
    },
  };
}

/**
 * Define an agent unit.
 *
 * @param d - Name, capability lists, and factory.
 * @returns The agent unit descriptor.
 */
export function defineAgent<
  const N extends readonly CapabilityKey[],
  const W extends readonly CapabilityKey[] = [],
>(d: {
  name: string;
  needs: N;
  wants?: W;
  create(caps: UnitCaps<N, W>, activeSet: ActiveSet): AgentUnitContributions;
}): AgentUnitDescriptor {
  return defineUnit("agent", d);
}

/**
 * Define a skill unit.
 *
 * @param d - Name, capability lists, and factory.
 * @returns The skill unit descriptor.
 */
export function defineSkill<
  const N extends readonly CapabilityKey[],
  const W extends readonly CapabilityKey[] = [],
>(d: {
  name: string;
  needs: N;
  wants?: W;
  create(caps: UnitCaps<N, W>, activeSet: ActiveSet): SkillUnitContributions;
}): SkillUnitDescriptor {
  return defineUnit("skill", d);
}

/**
 * Define a hook unit.
 *
 * @param d - Name, capability lists, and factory.
 * @returns The hook unit descriptor.
 */
export function defineHook<
  const N extends readonly CapabilityKey[],
  const W extends readonly CapabilityKey[] = [],
>(d: {
  name: string;
  needs: N;
  wants?: W;
  create(caps: UnitCaps<N, W>, activeSet: ActiveSet): HookUnitContributions;
}): HookUnitDescriptor {
  return defineUnit("hook", d);
}

/**
 * Define a tool unit.
 *
 * @param d - Name, capability lists, and factory.
 * @returns The tool unit descriptor.
 */
export function defineTool<
  const N extends readonly CapabilityKey[],
  const W extends readonly CapabilityKey[] = [],
>(d: {
  name: string;
  needs: N;
  wants?: W;
  create(caps: UnitCaps<N, W>, activeSet: ActiveSet): ToolUnitContributions;
}): ToolUnitDescriptor {
  return defineUnit("tool", d);
}

/**
 * Define a command unit.
 *
 * @param d - Name, capability lists, and factory.
 * @returns The command unit descriptor.
 */
export function defineCommand<
  const N extends readonly CapabilityKey[],
  const W extends readonly CapabilityKey[] = [],
>(d: {
  name: string;
  needs: N;
  wants?: W;
  create(caps: UnitCaps<N, W>, activeSet: ActiveSet): CommandUnitContributions;
}): CommandUnitDescriptor {
  return defineUnit("command", d);
}
