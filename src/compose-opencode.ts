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
 *  - `tool.execute.before` — the composed delegation gate for subagent
 *    calls; a refusal propagates as an error (cancels tool execution).
 *  - `tool.execute.after` — per-handler error isolation (`runAfterHandlers`).
 *  - `experimental.chat.messages.transform` — isolated handlers (a crash
 *    is logged and skipped).
 *  - `experimental.text.complete` — isolated handlers (text
 *    finalization, e.g. ref-echo stripping).
 *  - `tool.definition` — the raw OpenCode output is mapped onto the
 *    host-neutral tool-definition view, enhancers run in order (the
 *    subagent-prompt contributor), and the changed fields are written back.
 *  - `command.execute.before` — routes by `input.command`, then throws
 *    the unified `COMMAND_HANDLED` sentinel to short-circuit the flow.
 *  - `tool` — the enabled tool contributions keyed by tool name.
 *
 * Event keys appear only when their contribution arrays are non-empty
 * (and `tool` only when at least one tool is enabled).
 *
 * The exported helper functions (`injectAgentPrompts`,
 * `registerProfileToolsInConfig`, `registerSkills`, `runAfterHandlers`)
 * are shared with the config hook and kept public for unit tests.
 * `normalizeToolName` is shared with the tool registration path, and
 * `toToolDefinitionView` / `applyToolDefinitionView` are the thin
 * host-side halves of the definition boundary — all kept public for unit
 * tests.
 *
 * @module
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentName } from "./core/client/agent.js";
import type { ComposedResult } from "./core/compose.js";
import { runIsolated } from "./core/compose.js";
import type { ModeProfile } from "./core/config-types.js";
import type { Capabilities } from "./core/ports/index.js";
import { scanSkillDirectories } from "./core/skills.js";
import {
  collectToolDefinitionChanges,
  createToolDefinitionView,
  runToolDefinitionContributions,
} from "./core/tool-definition.js";
import type {
  AfterExecInput,
  AfterExecOutput,
  AgentContribution,
  CommandInput,
  TextCompleteInput,
  TextCompleteOutput,
  ToolBeforeInput,
  ToolBeforeOutput,
  ToolDefinitionView,
  TransformOutput,
} from "./core/unit.js";
import { log } from "./utils/logger.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = resolve(__dirname, "..");

// ---------------------------------------------------------------------------
// Unified slash-command sentinel
// ---------------------------------------------------------------------------

/**
 * Sentinel thrown after a registered slash command's handler resolves.
 *
 * The adapter throws it uniformly to short-circuit the `command()` flow
 * so a handled command is never processed as a user message.
 */
export const COMMAND_HANDLED = new Error(
  "command handled — no user message needed",
);

// ---------------------------------------------------------------------------
// Config hook helpers
// ---------------------------------------------------------------------------

/** Log plugin init event with agents/skills/limits summary. */
function logPluginInit(
  agents: Record<string, any>,
  skills: string[],
  limits: Partial<Capabilities>["limits"],
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
 * Register the skills named by `profileSkills` from the skills/ directory.
 *
 * Fail-closed: a skill registers only when its directory name appears in
 * `profileSkills`.  Absent names are skipped silently — config.toml (the
 * single source of truth) lists every skill explicitly.  The scan itself is
 * shared with the pi adapter (`scanSkillDirectories`); this function only
 * owns the OpenCode result sink (initialising and appending to
 * `config.skills.paths`).
 *
 * @param config - The config object being mutated by the `config` hook.
 * @param profileSkills - Skill directory names declared by the active profile.
 */
export function registerSkills(config: any, profileSkills: string[]): void {
  config.skills ??= {};
  config.skills.paths ??= [];
  const skillsDir = resolve(ROOT_DIR, "skills");
  for (const skillPath of scanSkillDirectories(skillsDir, profileSkills)) {
    config.skills.paths.push(skillPath);
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
// Handler runners
// ---------------------------------------------------------------------------

/**
 * Run a list of after-exec handlers with per-handler error isolation.
 *
 * Delegates to the shared {@link runIsolated} runner: a throwing handler
 * is logged (`handler_crashed`) and never blocks the next handler.
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
  await runIsolated(handlers, (handler) => handler.fn(input, output), {
    sessionID: input.sessionID,
    callId: input.callID,
  });
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
 * Read the native per-argument schemas out of an OpenCode output.
 *
 * @param output - The raw OpenCode hook output.
 * @returns The `parameters.properties` map, or `undefined` when absent.
 */
function nativeProperties(
  output: OpenCodeToolDefinitionOutput,
): Record<string, unknown> | undefined {
  const parameters =
    output.parameters && typeof output.parameters === "object"
      ? (output.parameters as { properties?: unknown }).properties
      : undefined;
  return parameters && typeof parameters === "object"
    ? (parameters as Record<string, unknown>)
    : undefined;
}

/**
 * Map an OpenCode `tool.definition` output onto the host-neutral view.
 *
 * The per-argument schemas are copied onto the view (never referenced):
 * a contributor's in-place `description` mutation stays on the view until
 * `applyToolDefinitionView` writes the changed fields back into the
 * native output.
 *
 * @param name - The canonical (host-normalized) tool name.
 * @param output - The raw OpenCode hook output.
 * @returns The host-neutral tool-definition view.
 */
export function toToolDefinitionView(
  name: string,
  output: OpenCodeToolDefinitionOutput,
): ToolDefinitionView {
  return createToolDefinitionView(
    name,
    output.description,
    nativeProperties(output),
  );
}

/**
 * Write the neutral view's changes back into the raw OpenCode output.
 *
 * Only the fields the contributors actually changed are written; the
 * target stays the native `output` object because the host hook contract
 * requires an in-place mutation.
 *
 * @param view - The (possibly mutated) host-neutral view.
 * @param output - The raw OpenCode hook output.
 */
export function applyToolDefinitionView(
  view: ToolDefinitionView,
  output: OpenCodeToolDefinitionOutput,
): void {
  const parameters = nativeProperties(output);
  const changes = collectToolDefinitionChanges(
    view,
    output.description,
    parameters,
  );
  if (changes.description !== undefined) {
    output.description = changes.description;
  }
  if (parameters === undefined) return;
  for (const [key, description] of Object.entries(changes.args)) {
    const property = parameters[key];
    if (property !== null && typeof property === "object") {
      (property as { description?: unknown }).description = description;
    }
  }
}

// ---------------------------------------------------------------------------
// Hook assembly
// ---------------------------------------------------------------------------

/**
 * Derive the conversation session id from a transform output.
 *
 * The OpenCode `experimental.chat.messages.transform` hook input carries
 * no session context; the host conversation's first entry does.  Core's
 * `TransformOutput.messages` is deliberately opaque, so the id is read
 * structurally with a `""` fallback for an empty or malformed list.
 *
 * @param output - The transform output being handled.
 * @returns The session id, or `""` when it cannot be derived.
 */
function transformSessionID(output: TransformOutput): string {
  const first = (
    output.messages as
      | Array<{ info?: { sessionID?: unknown } }>
      | null
      | undefined
  )?.[0];
  const id = first?.info?.sessionID;
  return typeof id === "string" ? id : "";
}

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
  deps: Partial<Capabilities>,
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

    // Present only when the context-pruning hook unit is enabled.
    ...(composed.transform.length > 0
      ? {
          async "experimental.chat.messages.transform"(
            _input: Record<string, never>,
            output: TransformOutput,
          ) {
            await runIsolated(
              composed.transform,
              (handler) => handler.handle(output),
              { sessionID: transformSessionID(output) },
            );
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
            await runIsolated(
              composed.textComplete,
              (handler) => handler.handle(input, output),
              { sessionID: input.sessionID, callId: input.partID },
            );
          },
        }
      : {}),

    // Present only when the subagent-prompt hook unit is enabled.
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
            await runToolDefinitionContributions(view, composed.toolDefinition);
            applyToolDefinitionView(view, output);
          },
        }
      : {}),

    // Present only when at least one delegation judge is enabled — the
    // composed gate judges every subagent call and a refusal propagates
    // as an error, cancelling tool execution.
    ...(composed.gate !== null
      ? {
          async "tool.execute.before"(
            input: ToolBeforeInput,
            output: ToolBeforeOutput,
          ) {
            const mapped: ToolBeforeInput = {
              ...input,
              tool: normalizeToolName(input.tool),
            };
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
