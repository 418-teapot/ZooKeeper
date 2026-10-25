/**
 * OpenCode event-key adapter.
 *
 * The only module that understands OpenCode's event keys.  Given the
 * host-agnostic `ComposedResult` produced by the assembly pipeline, the
 * per-plugin-instance capability values and the {@link Selection} the
 * pipeline resolved, it assembles the
 * plugin-hook fragment consumed by the host entry point:
 *
 *  - `config` — final host materialisation check, default-agent adoption,
 *    agent prompt injection, skill registration, tool primary_tools
 *    append, and slash-command registration.  The selection itself was
 *    already planned from the pre-read host config, so this hook only
 *    guards against later plugin mutations.
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
import type { ComposedResult } from "./core/compose.js";
import { runIsolated } from "./core/compose.js";
import type { Capabilities } from "./core/ports/index.js";
import type { AgentMaterialisation, Selection } from "./core/selection.js";
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
  log.info({
    hook: "plugin",
    event: "plugin_init",
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
      log.debug({
        hook: "plugin",
        event: "agent_loaded",
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

/**
 * Read the host agent definition a selection name refers to.
 *
 * A host entry the config disables is deleted before OpenCode builds its
 * agent map, so a disabled entry is not a materialised agent: it resolves
 * to `null` exactly like a missing one.
 *
 * @param agents - The `config.agent` map from the config hook.
 * @param name - The selected agent name.
 * @returns The host agent definition, or `null` when the host will not
 *   create the agent.
 */
function materialisedAgent(
  agents: Record<string, any>,
  name: string,
): Record<string, any> | null {
  const agent = agents[name];
  if (typeof agent !== "object" || agent === null) return null;
  if (agent.disable === true) return null;
  return agent;
}

/**
 * Map the host's `config.agent` table onto the planner's materialisation
 * facts.
 *
 * OpenCode deletes a disabled entry before building its agent map, so a
 * disabled entry is not materialised.  A materialised entry can still be
 * unusable as the host's default agent: OpenCode resolves `default_agent`
 * on every request, and a subagent or hidden target fails there.
 *
 * The projection keeps this module the only place that knows the host's
 * config shape; the planner receives plain names.
 *
 * `defaultAgents` speaks the HOST's vocabulary, not the config's mode
 * enum: every materialised entry whose host mode is not `"subagent"` and
 * that is not hidden counts, so `mode: "all"` is a host default agent
 * exactly like `"primary"`.  The config layer only ever produces
 * `primary` / `subagent` (`AgentMode` in `core/config-types.ts`), and the
 * planner's role policy recognises that parsed mode alone — `"all"`
 * therefore never becomes an orchestrator.  A profile that enables no
 * parsed `primary` stays fail-closed (invalid selection) even when the
 * host would accept an `"all"` agent as its default.  The two mode enums
 * are unrelated.
 *
 * @param config - The host config returned by `config.get`.
 * @returns The names the host will create, and the ones it accepts as its
 *   default agent.
 */
export function hostMaterialisation(config: any): AgentMaterialisation {
  const agents: string[] = [];
  const defaultAgents: string[] = [];
  const table = config?.agent;
  if (table === null || typeof table !== "object" || Array.isArray(table)) {
    return { agents, defaultAgents };
  }
  for (const name of Object.keys(table)) {
    const agent = materialisedAgent(table, name);
    if (agent === null) continue;
    agents.push(name);
    if (agent.mode === "subagent" || agent.hidden === true) continue;
    defaultAgents.push(name);
  }
  return { agents, defaultAgents };
}

/**
 * Read the host config and project it onto the materialisation facts.
 *
 * The read happens before assembly: the selection must be planned from
 * host facts, not from the assumption that the host will create the
 * selected agents.  A client without the API, a failed request and a
 * response carrying no config data all fail here, before any unit
 * factory runs.
 *
 * @param client - The host SDK client.
 * @returns What the host will materialise.
 */
export async function readHostMaterialisation(
  client: any,
): Promise<AgentMaterialisation> {
  const api = client?.config;
  if (typeof api?.get !== "function") {
    throw new Error("宿主 SDK 客户端缺少 config.get，无法预读宿主配置");
  }
  const result = await api.get();
  const data = result?.data;
  if (data === null || typeof data !== "object") {
    const error = JSON.stringify(result?.error) ?? "无";
    throw new Error(`宿主 config.get 未返回配置数据（error: ${error}）`);
  }
  return hostMaterialisation(data);
}

/**
 * Describe why a selection cannot run.
 *
 * Shared by the entry point (which refuses the plugin before any hook is
 * returned) and the config hook (which refuses a host config that drifted
 * from the pre-read facts).
 *
 * @param selection - The invalid selection.
 * @returns The user-facing reason, including every reported cause.
 */
export function invalidSelectionMessage(selection: Selection): string {
  const problems: string[] = [];
  const invalid = selection.report.invalid;
  if (invalid !== null) {
    problems.push(
      `orchestrator "${invalid.orchestrator}" 不可用` +
        `（cause: ${invalid.cause}；primaries: ${
          invalid.primaries.join(", ") || "无"
        }）`,
    );
  }
  const missing = selection.report.unmaterialised;
  if (missing.length > 0) {
    problems.push(
      `选中的 agent 未由宿主物化（缺失或被禁用）：${missing.join(", ")}`,
    );
  }
  return `选中结果无效：${problems.join("；")}`;
}

/**
 * List why the host config cannot run a ready selection.
 *
 * Every selected agent must be materialised by `config.agent`, because the
 * composed prompts target exactly those entries.  The orchestrator
 * additionally becomes `config.default_agent`, which OpenCode resolves on
 * every request: a subagent or hidden target makes each request fail
 * there, so the mismatch is refused while the config can still be left
 * untouched.
 *
 * @param agents - The `config.agent` map from the config hook.
 * @param selection - The ready selection being realised.
 * @returns The problems found, empty when the host can run the selection.
 */
function unmaterialisedSelection(
  agents: Record<string, any>,
  selection: Selection,
): string[] {
  const problems: string[] = [];
  const missing = selection.agents.filter(
    (name) => materialisedAgent(agents, name) === null,
  );
  if (missing.length > 0) {
    problems.push(
      `选中的 agent 未由宿主配置物化（缺失或被禁用）：${missing.join(", ")}`,
    );
  }
  const orchestrator = selection.orchestrator;
  if (orchestrator === undefined) return problems;
  // The planner resolves the role from the primaries, so an unmaterialised
  // orchestrator is already listed above; the role checks only add what a
  // materialised entry can still get wrong.
  const agent = materialisedAgent(agents, orchestrator);
  if (agent?.mode === "subagent") {
    problems.push(
      `orchestrator "${orchestrator}" 在宿主配置中是 subagent，不能作为默认 agent`,
    );
  }
  if (agent?.hidden === true) {
    problems.push(
      `orchestrator "${orchestrator}" 在宿主配置中是 hidden，不能作为默认 agent`,
    );
  }
  return problems;
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
 * Assemble the selection-driven OpenCode hooks fragment.
 *
 * Event keys appear only when they have contributions.  The `config` hook
 * always exists and behaves according to the selection status: `disabled`
 * skips every profile-driven registration and leaves the host default
 * agent alone, `invalid` throws before touching the config, and `ready`
 * re-checks that the config about to be used still materialises the
 * selected agents before adopting the selection's orchestrator as
 * `default_agent` and registering the composed contributions.  Handler
 * arrays keep the registry's order.
 *
 * The invalid branch is a guard, not the normal refusal path: the host
 * entry point refuses an invalid selection before it returns any hook.
 *
 * @param composed - The host-agnostic composition result.
 * @param deps - Per-plugin-instance dependencies.
 * @param selection - The selection the composition was built from.
 * @returns The hooks object fragment merged into the plugin.
 */
export function assembleOpenCodeHooks(
  composed: ComposedResult,
  deps: Partial<Capabilities>,
  selection: Selection,
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
      // No active profile → no profile-driven registration at all, and no
      // default-agent takeover: the host keeps what it declared.
      if (selection.status === "disabled") return;

      // An invalid selection resolved no orchestrator, so registering
      // anything would run under an undeclared role.  The entry point
      // already refuses such a selection before returning any hook; this
      // keeps the hook closed when it is driven directly.
      if (selection.status === "invalid") {
        throw new Error(invalidSelectionMessage(selection));
      }

      // Final atomic check against the config the host hands over now:
      // an earlier plugin may have changed the agent table the pre-read
      // facts came from.  Validate before mutating, because the host
      // applies the plugin's mutations even when the hook throws.
      const problems = unmaterialisedSelection(agents, selection);
      if (problems.length > 0) {
        throw new Error(
          `宿主配置无法运行选中的 profile：${problems.join("；")}`,
        );
      }

      // The orchestrator is the host's default agent.  Deriving it from
      // the primary order or falling back to a built-in agent would run
      // the profile under an agent it did not select.
      if (selection.orchestrator !== undefined) {
        config.default_agent = selection.orchestrator;
      }

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
            // judges runs only for the subagent tool.  The caller is
            // resolved only when at least one judge needs it (an
            // asynchronous host query otherwise skipped); an unresolvable
            // caller stays `undefined`, which the judge refuses
            // (fail-closed).
            if (composed.gate !== null && mapped.tool === "subagent") {
              const caller =
                composed.gateNeedsCaller &&
                deps.resolveCallerAgent !== undefined
                  ? await deps.resolveCallerAgent(mapped.sessionID)
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
                log.warn({
                  hook: "delegation",
                  event: "gate_blocked",
                  sessionId: mapped.sessionID,
                  callId: mapped.callID,
                  caller: caller ?? null,
                  target: target ?? null,
                  judge: refusal.judge,
                  reason: refusal.reason,
                });
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
