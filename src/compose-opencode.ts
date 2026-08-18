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
 *  - `tool.execute.before` — sequential handlers; exceptions propagate
 *    (cancel tool execution).
 *  - `tool.execute.after` — per-handler error isolation (`runAfterHandlers`).
 *  - `experimental.chat.messages.transform` — sequential handlers.
 *  - `tool.definition` — sequential enhancers (one contributor today).
 *  - `command.execute.before` — routes by `input.command`, then throws
 *    the unified `COMMAND_HANDLED` sentinel to short-circuit the flow.
 *  - `tool` — the enabled tool contributions keyed by tool name.
 *
 * Event keys appear only when their contribution arrays are non-empty
 * (and `tool` only when at least one tool is enabled).
 *
 * The exported helper functions (`buildToolHooks`,
 * `injectAgentPrompts`, `registerProfileToolsInConfig`, `registerSkills`,
 * `runAfterHandlers`) are shared with the config hook and kept public
 * for unit tests.
 *
 * @module
 */

import { readdirSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ContextMetricsOutput } from "./adapters/opencode/types.js";
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
  ToolContribution,
  ToolDefinitionInput,
  ToolDefinitionOutput,
  ToolUnitDescriptor,
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
  const deps: Deps = {
    limits: {},
    contextConfig,
    client,
    directory: "",
    sessionAgentMap: new Map(),
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
  return {
    ...(Object.keys(composed.tools).length > 0 ? { tool: composed.tools } : {}),

    async config(config: any) {
      const agents = config.agent ?? {};
      logPluginInit(
        agents,
        composed.skills.map((s) => s.name),
        deps.limits,
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

    // Present only when at least one of context-pruning / context-metrics
    // is enabled by the profile.
    ...(composed.transform.length > 0
      ? {
          async "experimental.chat.messages.transform"(
            _input: Record<string, never>,
            output: ContextMetricsOutput,
          ) {
            for (const handler of composed.transform) {
              await handler.handle(output);
            }
          },
        }
      : {}),

    // Present only when the task-prompt hook unit is enabled.
    ...(composed.toolDefinition.length > 0
      ? {
          async "tool.definition"(
            input: ToolDefinitionInput,
            output: ToolDefinitionOutput,
          ) {
            for (const handler of composed.toolDefinition) {
              await handler.handle(input, output);
            }
          },
        }
      : {}),

    // Present only when at least one before-exec hook unit is enabled.
    // Exceptions propagate intentionally — they cancel tool execution.
    ...(composed.beforeExec.length > 0
      ? {
          async "tool.execute.before"(
            input: BeforeExecInput,
            output: BeforeExecOutput,
          ) {
            for (const handler of composed.beforeExec) {
              await handler.handle(input, output);
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
              input,
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
