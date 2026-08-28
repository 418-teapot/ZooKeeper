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
 *  - `afterExec` contributions are isolated per handler (a throwing
 *     handler never blocks the next).
 *  - `transform` and `textComplete` contributions run in registration
 *    order.
 *  - Event keys appear only when they have contributions.
 *  - Command registration and handler are atomic (one record).
 *
 * @module
 */

import type { ToolHost } from "./client/tool-host.js";
import type { AgentModeMap, ContextPruningConfig } from "./config-types.js";
import type { HostAdapter } from "./context/lens.js";
import type { HandoffTarget } from "./handoff.js";
import type { AgentPermissionMap } from "./permissions/deny-tools.js";
import type { SubagentDriver } from "./subagent/driver.js";
import type { ValidationLimits } from "./validate.js";

// ---------------------------------------------------------------------------
// Dependencies and enablement
// ---------------------------------------------------------------------------

/**
 * pi host surfaces used by the primary-switch command.
 *
 * `getBaselineTools` / `setActiveTools` come from pi's `ExtensionAPI`;
 * `setWidget` is read from the latest extension context's `ui` (the pi
 * entry keeps a mutable context holder).  `newSession` delegates to the
 * pi command context's `newSession` (the full re-bind: the new session
 * re-resolves the primary's prompt, skill filter, tool trim, and widget
 * at bind time).  The switch command unit contributes no commands when
 * this capability is absent (fail closed — OpenCode never provides it,
 * so `/<agent>` commands never register there).
 */
export interface PiSwitchHost {
  /**
   * The full untrimmed tool baseline, captured ONCE before any switch.
   *
   * Every switch computes `baseline minus deniedTools(target)` from this
   * fixed set, so tool denies never accumulate across switches.  The
   * capture is deferred to the first `getBaselineTools` call (which
   * always happens inside a switch handler — pi forbids calling action
   * methods at extension-load time) and cached.  `undefined` when the
   * baseline was unavailable — callers skip the trim then (fail-closed).
   */
  getBaselineTools(): string[] | undefined;
  /** Replace the active tool set (used to trim denied tools). */
  setActiveTools(toolNames: string[]): void;
  /**
   * Render a widget above the editor (e.g. the active primary).
   *
   * Mirrors pi's `ExtensionUIContext.setWidget` shape: `lines` is the
   * widget's single-line content rendered above the editor.  `undefined`
   * hides the widget.
   */
  setWidget(key: string, lines: string[] | undefined): void;
  /**
   * Replace the current session with a fresh one bound to the new
   * primary identity.
   *
   * Mirrors pi's `ExtensionCommandContext.newSession` shape
   * (`{ parentSession?, withSession? }`): the caller stashes the current
   * session id as `parentSession`, and `withSession` runs against the
   * fresh session once it is created.  All post-replacement work must be
   * done through the `PiSwitchNewSessionOps` facade handed to
   * `withSession` — never through this host's own methods, which close
   * over the process-level (pre-replacement) API.  A `{ cancelled: true }`
   * result means the replacement was aborted and no session was created.
   * Absent on hosts without the replacement API — the switch fails
   * closed.
   */
  newSession(options: {
    parentSession?: string;
    withSession?: (ops: PiSwitchNewSessionOps) => void | Promise<void>;
  }): Promise<{ cancelled: boolean }>;
}

/**
 * Per-fresh-session operations handed to a `newSession` `withSession`
 * callback.
 *
 * REGRESSION NOTE: pi invalidates the captured extension API and command
 * context after `ctx.newSession()` (the old runtime's action methods
 * throw "This extension ctx is stale after session replacement or
 * reload...").  Post-replacement work — widget, tool trim — MUST
 * therefore run through the handles provided here, which the host binds
 * to the fresh session (via the real `ReplacedSessionContext` pi passes
 * to `withSession`), never through a process-level `PiSwitchHost`
 * captured before the switch.
 *
 * A host may not be able to execute every operation synchronously inside
 * `withSession`: pi's `ReplacedSessionContext` structurally inherits the
 * command-context surface, but the tool actions operate on the OLD
 * session's bindings, which pi invalidates on replacement — calling them
 * there throws the stale-context error.  The host therefore defers the
 * trim and applies it at the new session's first `before_agent_start`
 * (or other fresh-context event) where a non-stale API exists.
 */
export interface PiSwitchNewSessionOps {
  /**
   * Render a widget above the editor (e.g. the active primary).
   *
   * `undefined` hides the widget.
   */
  setWidget(key: string, lines: string[] | undefined): void;
  /** Replace the fresh session's active tool set (denied-tool trim). */
  setActiveTools(toolNames: string[]): void;
}

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
  /**
   * Per-agent mode map (`[agent.*].mode`), parsed fail-closed.
   *
   * Maps every agent whose `mode` field parsed successfully to
   * `"primary"` / `"subagent"`; agents with a missing or invalid `mode`
   * are absent.  Consumed by the identity layer (e.g. `derivePrimaries`)
   * — an empty or absent map means no primary agent is configured and
   * the identity machinery stays disabled.
   */
  agentModes?: AgentModeMap;
  /**
   * Per-agent tool-level deny map (`[agent.<name>].permission`), parsed
   * fail-closed by `parseAgentPermissions`.
   *
   * Maps every agent with at least one tool-level deny to its sorted
   * denied tool names; agents with none are absent.  Consumed by the
   * primary-switch command to trim the pi active tool set — an empty or
   * absent map leaves the active tool set untouched.
   */
  agentPermissions?: AgentPermissionMap;
  /**
   * pi-specific switch surfaces (only on the pi host).
   *
   * Undefined on hosts without them (OpenCode) — the switch command
   * unit contributes no commands then (fail-closed, so no `/<agent>`
   * command ever registers on OpenCode).
   */
  piSwitchHost?: PiSwitchHost;
  /**
   * Host subagent driver (only on the pi host).
   *
   * Undefined on hosts without it (OpenCode) — the subagent tool unit
   * then contributes no tools (fail-closed, so no `subagent` tool ever
   * registers there; OpenCode keeps its native `task` tool).
   */
  subagentDriver?: SubagentDriver;
  /**
   * Optional host renderer for the subagent tool card (only on the pi
   * host).
   *
   * Structurally loose (never importing pi types in core): when present
   * the subagent tool unit attaches its `renderCall` / `renderResult`
   * callbacks to the contributed tool, so pi's TUI draws a live
   * transcript card instead of the plain text snapshot.  Undefined on
   * hosts without a renderer (OpenCode) — the tool keeps its text-only
   * behavior unchanged.
   */
  subagentRenderer?: {
    renderCall(args: unknown, theme: unknown, context?: unknown): unknown;
    renderResult(
      result: unknown,
      options: unknown,
      theme: unknown,
      context?: unknown,
    ): unknown;
  };
  /**
   * The host's full untrimmed tool-name baseline for subagent capability
   * computation.
   *
   * Mirrors the switch command's baseline source (`piApi.getActiveTools`),
   * captured once.  Undefined when the host cannot supply it — the
   * subagent tool then runs with whatever `computeCapabilitySet` yields
   * (an empty set, fail-closed; permissions are never invented).
   */
  subagentBaseline?: string[];
  /**
   * Per-agent model map for subagent sessions (`~/.pi/agent/agents.json`).
   *
   * Materialised by the installer from `[agent.<name>].model` as a
   * `{provider, model}` pair whose mapped value here is the concatenated
   * `"provider/model"` string (the TS runtime never resolves `{env:}`
   * tokens or reads environment variables).  Strict mode: this map is the
   * SOLE model source — the subagent tool errors (never inherits or falls
   * back) when the target agent's entry is absent.  Empty when the file is
   * missing/invalid (fail-closed — every subagent delegation then reports
   * an actionable error naming agents.json).
   */
  subagentModels?: Record<string, string>;
  /**
   * The host-specific session handoff surface for the `/go` command.
   *
   * Undefined on hosts that do not wire a handoff target — the `/go`
   * command unit then fails closed with the missing-client error.
   */
  handoffTarget?: HandoffTarget;
  /** The host client (OpenCode / pi), opaque to this layer. */
  client: any;
  /** The plugin working directory. */
  directory: string;
  /**
   * Session → agent map held by the host entry point (populated by
   * `message.updated` events).  Read-only for units.
   */
  sessionAgentMap: Map<string, string>;
  /** Host tool services used by tool adapters. */
  toolHost?: ToolHost;
  /**
   * Host adapter for context-pruning.  Undefined when the host has no
   * adapter wired; the pruning unit contributes no transform handler in
   * that case (fail-closed).
   */
  adapter?: HostAdapter<unknown>;
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
  /** Names of required top-level parameters within `args`. */
  required?: string[];
  /**
   * Execute the tool.
   *
   * `toolCtx` is the host tool execution context (an OpenCode tool context
   * on OpenCode, a pi `ExtensionContext` on pi).  The optional `hostCtx`
   * third argument carries the host-forwarded execution surface: the
   * abort `signal` and the `onUpdate` streaming callback, both forwarded
   * by the pi bridge from the native tool signature.  Hosts that do not
   * forward these (OpenCode, which invokes tools natively) simply omit the
   * third argument.
   */
  execute(
    args: unknown,
    toolCtx: unknown,
    hostCtx?: { signal?: AbortSignal; onUpdate?: unknown },
  ): Promise<string>;
  /**
   * Optional host TUI renderers for the tool's transcript card.
   *
   * Present only on hosts that supply a renderer (pi): `renderCall` draws
   * the initial tool-call card, `renderResult` draws the live partial /
   * terminal card from the structured progress in the result `details`.
   * Structurally loose (never importing pi types in core); hosts that do
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
 * All five handler slots are required arrays — a unit that does not
 * contribute to a slot returns an empty array.
 */
export interface HookUnitContributions {
  kind: "hook";
  beforeExec: BeforeExecContribution[];
  afterExec: AfterExecContribution[];
  transform: TransformContribution[];
  textComplete: TextCompleteContribution[];
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
  /** Enabled text-finalization handlers. */
  textComplete: TextCompleteContribution[];
  /** Enabled `tool.definition` enhancers. */
  toolDefinition: ToolDefinitionContribution[];
  /** Enabled tools, keyed by tool name. */
  tools: Record<string, ToolContribution>;
  /** Enabled commands, keyed by command name. */
  commands: Record<string, CommandContribution>;
}
