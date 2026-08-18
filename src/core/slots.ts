/**
 * Host-agnostic contribution slot types shared by every host adapter.
 *
 * Defines the unit descriptor contract (name + kind + factory), the
 * contribution shapes a unit can produce, and the dependency /
 * enablement shapes.  Pure type definitions only — zero runtime logic
 * and no OpenCode imports, so this module is importable from any TS
 * runtime.
 *
 * Composition semantics (declared here, implemented by the OpenCode
 * adapter (`src/compose-opencode.ts`)):
 *   - `beforeExec` contributions propagate exceptions (cancel
 *     execution).
 *   - `afterExec` contributions are isolated per handler (a throwing
 *     handler never blocks the next).
 *   - `transform` contributions run in registration order.
 *   - Event keys appear only when they have contributions.
 *   - Command registration and handler are atomic (one record).
 *
 * @module
 */

import type { ContextMetricsOutput } from "../adapters/opencode/types.js";
import type { ContextPruningConfig } from "./config-types.js";
import type { ValidationLimits } from "./validate.js";

// ---------------------------------------------------------------------------
// Dependencies and enablement
// ---------------------------------------------------------------------------

/**
 * Per-plugin-instance dependencies captured by unit factories.
 *
 * Host-agnostic: `client` is intentionally untyped (each host client
 * differs) and is treated as an existing `any` boundary.
 */
export interface Deps {
  /** Word-count limits from `[zoo.validation]`. */
  limits: ValidationLimits;
  /** Unified context-pruning configuration (`[zoo.context]`). */
  contextConfig: ContextPruningConfig;
  /** The host client (OpenCode / pi), opaque to this layer. */
  client: any;
  /** The plugin working directory. */
  directory: string;
  /**
   * Session → agent map held by the host entry point (populated by
   * `message.updated` events).  Read-only for units.
   */
  sessionAgentMap: Map<string, string>;
}

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
export interface BeforeExecInput {
  tool: string;
  sessionID: string;
  callID: string;
}

/** Output shape of the `tool.execute.before` hook. */
export interface BeforeExecOutput {
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

/** Input shape of the `tool.definition` hook. */
export interface ToolDefinitionInput {
  toolID: string;
}

/** Output shape of the `tool.definition` hook. */
export interface ToolDefinitionOutput {
  description: string;
  parameters: Record<string, unknown>;
}

/** Input shape of a slash-command handler. */
export interface CommandInput {
  command: string;
  sessionID: string;
  arguments: string;
}

// ---------------------------------------------------------------------------
// Contribution slot types
// ---------------------------------------------------------------------------

/**
 * One named `tool.execute.before` handler contributed by a hook unit.
 *
 * Exceptions intentionally propagate — they cancel tool execution.
 */
export interface BeforeExecContribution {
  /** Handler label used for logging. */
  name: string;
  handle(
    input: BeforeExecInput,
    output: BeforeExecOutput,
  ): void | Promise<void>;
}

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
  handle(output: ContextMetricsOutput): void | Promise<void>;
}

/**
 * One named `tool.definition` enhancer contributed by a hook unit.
 */
export interface ToolDefinitionContribution {
  /** Handler label used for logging. */
  name: string;
  handle(
    input: ToolDefinitionInput,
    output: ToolDefinitionOutput,
  ): void | Promise<void>;
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
  execute(args: unknown, toolCtx: unknown): Promise<string>;
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

// ---------------------------------------------------------------------------
// Agent / skill contributions
// ---------------------------------------------------------------------------

/** An agent prompt-injection contribution. */
export interface AgentContribution {
  /** Agent name (registry key). */
  name: string;
  /** The prompt text injected into the agent definition. */
  prompt: string;
}

/** A skill registration contribution (directory under core/skills/). */
export interface SkillContribution {
  /** Skill directory name (registry key). */
  name: string;
}

// ---------------------------------------------------------------------------
// Unit descriptor contract
// ---------------------------------------------------------------------------

/** The five loadable unit kinds. */
export type UnitKind = "agent" | "skill" | "hook" | "tool" | "command";

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
 * All four handler slots are required arrays — a unit that does not
 * contribute to a slot returns an empty array.
 */
export interface HookUnitContributions {
  kind: "hook";
  beforeExec: BeforeExecContribution[];
  afterExec: AfterExecContribution[];
  transform: TransformContribution[];
  toolDefinition: ToolDefinitionContribution[];
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

/** Descriptor of an agent unit. */
export interface AgentUnitDescriptor {
  name: string;
  kind: "agent";
  create(deps: Deps, activeSet: ActiveSet): AgentUnitContributions;
}

/** Descriptor of a skill unit. */
export interface SkillUnitDescriptor {
  name: string;
  kind: "skill";
  create(deps: Deps, activeSet: ActiveSet): SkillUnitContributions;
}

/** Descriptor of a hook unit. */
export interface HookUnitDescriptor {
  name: string;
  kind: "hook";
  create(deps: Deps, activeSet: ActiveSet): HookUnitContributions;
}

/** Descriptor of a tool unit. */
export interface ToolUnitDescriptor {
  name: string;
  kind: "tool";
  create(deps: Deps, activeSet: ActiveSet): ToolUnitContributions;
}

/** Descriptor of a command unit. */
export interface CommandUnitDescriptor {
  name: string;
  kind: "command";
  create(deps: Deps, activeSet: ActiveSet): CommandUnitContributions;
}

/**
 * One self-describing loadable unit.
 *
 * The discriminated union lets `composeProfile` narrow both the
 * unit kind and its contribution collection from `create`.
 */
export type UnitDescriptor =
  | AgentUnitDescriptor
  | SkillUnitDescriptor
  | HookUnitDescriptor
  | ToolUnitDescriptor
  | CommandUnitDescriptor;

// ---------------------------------------------------------------------------
// Composition result
// ---------------------------------------------------------------------------

/**
 * Host-agnostic intermediate structure produced by the selection
 * engine.
 *
 * Handler arrays keep the registry's order; `tools` and
 * `commands` are keyed by contribution name.  The host adapter turns
 * this into framework registrations (event keys appear only when their
 * arrays are non-empty).
 */
export interface ComposedResult {
  /** Enabled agent prompt contributions. */
  agents: AgentContribution[];
  /** Enabled skill contributions. */
  skills: SkillContribution[];
  /** Enabled `tool.execute.before` handlers. */
  beforeExec: BeforeExecContribution[];
  /** Enabled `tool.execute.after` handlers. */
  afterExec: AfterExecContribution[];
  /** Enabled messages-transform handlers. */
  transform: TransformContribution[];
  /** Enabled `tool.definition` enhancers. */
  toolDefinition: ToolDefinitionContribution[];
  /** Enabled tools, keyed by tool name. */
  tools: Record<string, ToolContribution>;
  /** Enabled commands, keyed by command name. */
  commands: Record<string, CommandContribution>;
}
