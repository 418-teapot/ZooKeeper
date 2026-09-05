/**
 * OpenCode event-key adapter.
 *
 * The only module that understands OpenCode's event keys.  Given the
 * host-agnostic `ComposedResult` produced by `composeProfile`, plus the
 * per-plugin-instance deps and the parsed mode profile, it assembles the
 * plugin-hook fragment consumed by the host entry point:
 *
 *  - `config` — agent prompt injection, skill registration, tool
 *    primary_tools append, and slash-command registration.
 *  - `tool.execute.before` — sequential handlers, then the composed
 *    delegation gate for subagent calls; exceptions propagate (cancel
 *    tool execution).
 *  - `tool.execute.after` — per-handler error isolation (`runAfterHandlers`).
 *  - `experimental.chat.messages.transform` — sequential handlers.
 *  - `experimental.text.complete` — sequential handlers (text
 *    finalization, e.g. ref-echo stripping).
 *  - `tool.definition` — the raw OpenCode output is mapped onto the
 *    host-neutral tool-definition view, enhancers run in order (one
 *    contributor today), and the changed fields are written back.
 *  - `command.execute.before` — routes by `input.command`, then throws
 *    the unified `COMMAND_HANDLED` sentinel to short-circuit the flow.
 *  - `tool` — the enabled tool contributions keyed by tool name.
 *
 * Event keys appear only when their contribution arrays are non-empty
 * (and `tool` only when at least one tool is enabled).
 *
 * The exported helper functions (`buildToolHooks`,
 * `injectAgentPrompts`, `registerProfileToolsInConfig`, `registerSkills`,
 * `runAfterHandlers`) are shared with the config hook
 * and kept public for unit tests.  `normalizeToolName` is exported
 * for unit tests only.
 *
 * @module
 */

import { readdirSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createV1ToolHost } from "./adapters/opencode/tool-host.js";
import { getAgentName } from "./core/client/agent.js";
import type { ContextPruningConfig, ModeProfile } from "./core/config-types.js";
import type {
  ActiveSet,
  AfterExecInput,
  AfterExecOutput,
  AgentContribution,
  BeforeExecInput,
  BeforeExecOutput,
  CommandInput,
  ComposedResult,
  Deps,
  TextCompleteInput,
  TextCompleteOutput,
  ToolArgDefinition,
  ToolContribution,
  ToolDefinitionView,
  ToolUnitDescriptor,
  TransformOutput,
} from "./core/slots.js";
import { REGISTRY } from "./registry.js";
import { log } from "./utils/logger.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CORE_DIR = resolve(__dirname, "../core");

// ---------------------------------------------------------------------------
// Unified slash-command sentinel
// ---------------------------------------------------------------------------

/**
 * Sentinel thrown after a registered slash command's handler resolves.
 *
 * Replaces the old per-command sentinels: the adapter throws it
 * uniformly to short-circuit the `command()` flow so a handled command
 * is never processed as a user message.
 */
export const COMMAND_HANDLED = new Error(
  "command handled — no user message needed",
);

// ---------------------------------------------------------------------------
// Unit lookups (derived once from the registry)
// ---------------------------------------------------------------------------

/** The tool units from the registry. */
const TOOL_UNITS: ToolUnitDescriptor[] = REGISTRY.filter(
  (unit): unit is ToolUnitDescriptor => unit.kind === "tool",
);

// ---------------------------------------------------------------------------
// Config hook helpers
// ---------------------------------------------------------------------------

/** Log plugin init event with agents/skills/limits summary. */
function logPluginInit(
  agents: Record<string, any>,
  skills: string[],
  limits: Deps["limits"],
): void {
  log("plugin", "plugin_init", "", undefined, "info", {
    agents: Object.keys(agents),
    skills,
    limits,
  });
}

/**
 * Inject prompt files into the agents listed by the composed
 * contributions.
 *
 * Only agents named by a contribution (and present in `config.agent`)
 * are considered; an agent absent from `config.agent` (or with an
 * empty prompt) is skipped silently.  The prompts come from the
 * composed result — profile-aware, so agents whose prompt depends on
 * the active mode profile (e.g. mola) receive the correct variant.
 *
 * @param agents - The `config.agent` map from the config hook.
 * @param agentContributions - The composed agent contributions.
 */
export function injectAgentPrompts(
  agents: Record<string, any>,
  agentContributions: AgentContribution[],
): void {
  for (const contribution of agentContributions) {
    const agent = agents[contribution.name];
    if (typeof agent !== "object" || agent === null) continue;
    if (contribution.prompt) {
      agent.prompt = contribution.prompt;
      log("plugin", "agent_loaded", "", undefined, "debug", {
        agent: contribution.name,
        prompt_len: contribution.prompt.length,
      });
    }
  }
}

/**
 * Register the skills named by `profileSkills` from the core/skills/ directory.
 *
 * Fail-closed: a skill registers only when its directory name appears in
 * `profileSkills`.  Absent names are skipped silently — config.toml (the
 * single source of truth) lists every skill explicitly.
 *
 * @param config - The config object being mutated by the `config` hook.
 * @param profileSkills - Skill directory names declared by the active profile.
 */
export function registerSkills(config: any, profileSkills: string[]): void {
  config.skills ??= {};
  config.skills.paths ??= [];
  const skillsDir = resolve(CORE_DIR, "skills");
  try {
    for (const entry of readdirSync(skillsDir)) {
      const skillPath = resolve(skillsDir, entry);
      if (!statSync(skillPath).isDirectory()) continue;
      if (!profileSkills.includes(entry)) continue;
      config.skills.paths.push(skillPath);
      log("plugin", "skill_registered", "", undefined, "debug", {
        skill: entry,
      });
    }
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code !== "ENOENT") {
      log("plugin", "skill_register_error", "", undefined, "warn", {
        error: String(err),
      });
    }
  }
}

/**
 * Append profile-listed tools to `experimental.primary_tools`.
 *
 * Preserves pre-existing entries and appends `"compress"` then
 * `"decompress"` when the profile's tools list names them (idempotent —
 * never duplicates).  Unknown tool names are not registered; when
 * neither known tool is listed the config is untouched.
 *
 * @param config - The config object being mutated by the `config` hook.
 * @param profileTools - Tool names declared by the active profile.
 */
export function registerProfileToolsInConfig(
  config: any,
  profileTools: string[],
): void {
  if (
    !profileTools.includes("compress") &&
    !profileTools.includes("decompress")
  ) {
    return;
  }
  config.experimental ??= {};
  config.experimental.primary_tools ??= [];
  if (
    profileTools.includes("compress") &&
    !config.experimental.primary_tools.includes("compress")
  ) {
    config.experimental.primary_tools.push("compress");
  }
  if (
    profileTools.includes("decompress") &&
    !config.experimental.primary_tools.includes("decompress")
  ) {
    config.experimental.primary_tools.push("decompress");
  }
}

// ---------------------------------------------------------------------------
// Tool hooks
// ---------------------------------------------------------------------------

/**
 * Build the tool-hooks map registered on the plugin `tool` key.
 *
 * The compress / decompress tools register only when the active profile's
 * tools list names them.  An absent tool name keeps the corresponding
 * tool unregistered.  Returns `undefined` when NO tool is enabled so the
 * `tool` hook key stays absent.
 *
 * Exported for unit testing (the profile list is decided by the caller).
 *
 * @param client - The OpenCode client (captured by the factory closure).
 * @param contextConfig - The parsed context-pruning config.
 * @param profileTools - Tool names declared by the active profile.
 * @returns The tool-hooks map, or `undefined` when no tool is enabled.
 */
export function buildToolHooks(
  client: any,
  contextConfig: ContextPruningConfig,
  profileTools: string[],
): Record<string, ToolContribution> | undefined {
  // Tool adapters never read the session agent — the stub resolver
  // keeps the fail-closed contract (an unknown session resolves to
  // `undefined`, never an invented agent).
  const deps: Deps = {
    limits: {},
    contextConfig,
    client,
    directory: "",
    resolveAgent: () => undefined,
    toolHost: createV1ToolHost(client, () => undefined),
  };
  const activeSet: ActiveSet = {
    agents: new Set(),
    skills: new Set(),
    hooks: new Set(),
    tools: new Set(profileTools),
    commands: new Set(),
  };
  const hooks: Record<string, ToolContribution> = {};
  for (const unit of TOOL_UNITS) {
    if (!profileTools.includes(unit.name)) continue;
    for (const tool of unit.create(deps, activeSet).tools) {
      hooks[tool.name] = tool;
    }
  }
  return Object.keys(hooks).length === 0 ? undefined : hooks;
}

// ---------------------------------------------------------------------------
// Handler runners
// ---------------------------------------------------------------------------

/**
 * Run a list of after-exec handlers with per-handler error isolation.
 *
 * A throwing handler is logged (`handler_crashed`) and never blocks the
 * next handler.
 *
 * @param handlers - The named handler list in handler execution order.
 * @param input - The after-exec hook input.
 * @param output - The after-exec hook output.
 */
export async function runAfterHandlers(
  handlers: Array<{
    name: string;
    fn: (i: AfterExecInput, o: AfterExecOutput) => void | Promise<void>;
  }>,
  input: AfterExecInput,
  output: AfterExecOutput,
): Promise<void> {
  for (const { name, fn } of handlers) {
    try {
      await fn(input, output);
    } catch (err) {
      log("plugin", "handler_crashed", input.sessionID, input.callID, "error", {
        handler: name,
        error: String(err),
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Tool-name normalization
// ---------------------------------------------------------------------------

/**
 * Map an OpenCode tool name to the canonical name the core hooks gate on.
 *
 * The core and hook layers speak a host-neutral vocabulary where the
 * delegation tool is named `"subagent"`; OpenCode registers that tool as
 * `"task"`.  Normalizing at this event-key boundary keeps every hook
 * identical across hosts (pi already names the tool "subagent").  All
 * other names pass through unchanged.
 *
 * @param name - The raw OpenCode tool name from the event input.
 * @returns The canonical tool name.
 */
export function normalizeToolName(name: string): string {
  return name === "task" ? "subagent" : name;
}

// ---------------------------------------------------------------------------
// Tool-definition translation (OpenCode ↔ host-neutral view)
// ---------------------------------------------------------------------------

/** Raw `tool.definition` hook input handed by OpenCode. */
interface OpenCodeToolDefinitionInput {
  toolID: string;
}

/** Raw `tool.definition` hook output handed by OpenCode (mutated in place). */
interface OpenCodeToolDefinitionOutput {
  description: string;
  parameters: Record<string, unknown>;
}

/**
 * Map an OpenCode `tool.definition` output onto the host-neutral view.
 *
 * The per-argument schemas are referenced directly (not copied): a
 * contributor's in-place `description` mutation lands on the native
 * schema objects immediately, so `applyToolDefinitionView` only has to
 * re-apply rebindings and a rewritten top-level description.
 *
 * @param name - The canonical (host-normalized) tool name.
 * @param output - The raw OpenCode hook output.
 * @returns The host-neutral tool-definition view.
 */
function toToolDefinitionView(
  name: string,
  output: OpenCodeToolDefinitionOutput,
): ToolDefinitionView {
  const args: Record<string, ToolArgDefinition> = {};
  const parameters =
    output.parameters && typeof output.parameters === "object"
      ? (output.parameters as { properties?: unknown }).properties
      : undefined;
  if (parameters && typeof parameters === "object") {
    for (const [key, value] of Object.entries(parameters)) {
      if (value !== null && typeof value === "object") {
        args[key] = value as ToolArgDefinition;
      }
    }
  }
  return { name, description: output.description, args };
}

/**
 * Write the neutral view's changes back into the raw OpenCode output.
 *
 * Per-argument entries are live references to the native schema property
 * objects, so in-place description mutations already landed; this pass
 * re-applies rebindings (a contributor replacing an entry wholesale)
 * and a rewritten top-level description.
 *
 * @param view - The (possibly mutated) host-neutral view.
 * @param output - The raw OpenCode hook output.
 */
function applyToolDefinitionView(
  view: ToolDefinitionView,
  output: OpenCodeToolDefinitionOutput,
): void {
  if (
    view.description !== undefined &&
    view.description !== output.description
  ) {
    output.description = view.description;
  }
  const parameters =
    output.parameters && typeof output.parameters === "object"
      ? (output.parameters as { properties?: Record<string, unknown> })
          .properties
      : undefined;
  if (parameters && typeof parameters === "object" && view.args !== undefined) {
    for (const [key, arg] of Object.entries(view.args)) {
      const property = parameters[key];
      if (property !== null && typeof property === "object") {
        const schema = property as { description?: unknown };
        if (schema.description !== arg.description) {
          schema.description = arg.description;
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Hook assembly
// ---------------------------------------------------------------------------

/**
 * Assemble the profile-driven OpenCode hooks fragment.
 *
 * Event keys appear only when they have contributions; a null profile
 * (absent or invalid) keeps the `config` hook but skips every
 * profile-driven registration inside it.  Handler arrays keep the
 * registry's order.
 *
 * @param composed - The host-agnostic composition result.
 * @param deps - Per-plugin-instance dependencies.
 * @param profile - The active mode profile, or `null` when absent.
 * @returns The hooks object fragment merged into the plugin.
 */
export function assembleOpenCodeHooks(
  composed: ComposedResult,
  deps: Deps,
  profile: ModeProfile | null,
): Record<string, any> {
  const fullDeps: Deps = {
    ...deps,
    toolHost: deps.toolHost ?? createV1ToolHost(deps.client, deps.resolveAgent),
  };
  return {
    ...(Object.keys(composed.tools).length > 0 ? { tool: composed.tools } : {}),

    async config(config: any) {
      const agents = config.agent ?? {};
      logPluginInit(
        agents,
        composed.skills.map((s) => s.name),
        fullDeps.limits,
      );
      // No active profile → no profile-driven registration at all.
      if (profile === null) return;

      injectAgentPrompts(agents, composed.agents);
      registerSkills(
        config,
        composed.skills.map((s) => s.name),
      );
      registerProfileToolsInConfig(config, Object.keys(composed.tools));
      for (const [name, contribution] of Object.entries(composed.commands)) {
        config.command ??= {};
        config.command[name] = {
          template: "",
          description: contribution.description,
        };
      }
    },

    // Present only when the context-pruning hook unit is enabled.
    ...(composed.transform.length > 0
      ? {
          async "experimental.chat.messages.transform"(
            _input: Record<string, never>,
            output: TransformOutput,
          ) {
            for (const handler of composed.transform) {
              await handler.handle(output);
            }
          },
        }
      : {}),

    // Present only when the reply-strip hook unit is enabled.
    ...(composed.textComplete.length > 0
      ? {
          async "experimental.text.complete"(
            input: TextCompleteInput,
            output: TextCompleteOutput,
          ) {
            for (const handler of composed.textComplete) {
              await handler.handle(input, output);
            }
          },
        }
      : {}),

    // Present only when the task-prompt hook unit is enabled.
    ...(composed.toolDefinition.length > 0
      ? {
          async "tool.definition"(
            input: OpenCodeToolDefinitionInput,
            output: OpenCodeToolDefinitionOutput,
          ) {
            const view = toToolDefinitionView(
              normalizeToolName(input.toolID),
              output,
            );
            for (const handler of composed.toolDefinition) {
              await handler.handle(view);
            }
            applyToolDefinitionView(view, output);
          },
        }
      : {}),

    // Present when at least one before-exec hook or one delegation
    // judge is enabled.  The generic before-exec chain runs first;
    // then the composed delegation gate judges every subagent call.
    // Exceptions propagate intentionally — they cancel tool execution.
    ...(composed.beforeExec.length > 0 || composed.gate !== null
      ? {
          async "tool.execute.before"(
            input: BeforeExecInput,
            output: BeforeExecOutput,
          ) {
            const mapped: BeforeExecInput = {
              ...input,
              tool: normalizeToolName(input.tool),
            };
            // Generic before-exec chain.  No unit contributes a
            // beforeExec handler today (all hook units keep the slot
            // empty); the slot is reserved for future units that need
            // to run before any tool call.  Event registration for the
            // delegation gate below is driven by `composed.gate`, not
            // by this chain.
            for (const handler of composed.beforeExec) {
              await handler.handle(mapped, output);
            }
            // Delegation gate — the strategy contributed by hook-unit
            // judges runs only for the subagent tool.  Each judge
            // handles its own field-absence skip, so the gate runs
            // whenever the tool is subagent, regardless of whether the
            // caller could be resolved.  The caller is resolved only
            // when at least one judge needs it (an asynchronous session
            // query otherwise skipped).
            if (composed.gate !== null && mapped.tool === "subagent") {
              const caller = composed.gateNeedsCaller
                ? await getAgentName(deps.client, mapped.sessionID)
                : undefined;
              const target =
                typeof output.args?.subagent_type === "string"
                  ? output.args.subagent_type
                  : undefined;
              const prompt =
                typeof output.args?.prompt === "string"
                  ? output.args.prompt
                  : undefined;
              const refusal = composed.gate({ caller, target, prompt });
              if (refusal !== null) {
                log(
                  "delegation",
                  "gate_blocked",
                  mapped.sessionID,
                  mapped.callID,
                  "warn",
                  {
                    caller: caller ?? null,
                    target: target ?? null,
                    judge: refusal.judge,
                    reason: refusal.reason,
                  },
                );
                throw new Error(refusal.reason);
              }
            }
          },
        }
      : {}),

    ...(composed.afterExec.length > 0
      ? {
          async "tool.execute.after"(
            input: AfterExecInput,
            output: AfterExecOutput,
          ) {
            await runAfterHandlers(
              composed.afterExec.map((handler) => ({
                name: handler.name,
                fn: handler.handle,
              })),
              { ...input, tool: normalizeToolName(input.tool) },
              output,
            );
          },
        }
      : {}),

    // Present only when at least one slash command is registered.
    ...(Object.keys(composed.commands).length > 0
      ? {
          async "command.execute.before"(input: CommandInput) {
            const contribution = composed.commands[input.command];
            // Unregistered command — pass through untouched.
            if (!contribution) return;
            await contribution.handle(input);
            throw COMMAND_HANDLED;
          },
        }
      : {}),
  };
}
