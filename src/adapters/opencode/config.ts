/**
 * OpenCode host config boundary.
 *
 * The only module that knows the shape of the host configuration object.
 * It reads the host config before assembly, projects the `config.agent`
 * table onto the planner's materialisation facts, re-checks a ready
 * selection against the config the host hands over, and owns every write
 * of the `config` hook:
 *
 *  - `default_agent` — the selection's orchestrator;
 *  - agent prompts — the composed, profile-aware prompt of each agent;
 *  - `skills.paths` — the skill directories the start preparation read;
 *  - `experimental.primary_tools` — the `compress` / `decompress` tools
 *    the profile enables;
 *  - `command` — the registered slash commands.
 *
 * The selection was planned from the pre-read host config, so the hook
 * only guards against later plugin mutations: a selection that is not
 * `ready` makes it a no-op, and a ready one is validated before the first
 * write.
 *
 * @module
 */

import type { ComposedResult } from "../../core/compose.js";
import type { Capabilities } from "../../core/ports/index.js";
import type {
  AgentMaterialisation,
  HostMaterialisation,
  Selection,
} from "../../core/selection.js";
import type { AgentContribution } from "../../core/unit.js";
import { log } from "../../utils/logger.js";

// ---------------------------------------------------------------------------
// Reading the host config
// ---------------------------------------------------------------------------

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
function hostMaterialisation(config: any): AgentMaterialisation {
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
 * selected agents.  The three expected environment failures — a client
 * without the API, a failed request, a response carrying no config data —
 * are answered as unavailable facts, so the shared decision closes this
 * configuration instead of failing the whole extension.  Any other fault
 * of the client is a program error and still escapes.
 *
 * @param client - The host SDK client.
 * @returns The projected facts, or why the host could not answer.
 */
export async function readHostMaterialisation(
  client: any,
): Promise<HostMaterialisation> {
  const api = client?.config;
  if (typeof api?.get !== "function") {
    return {
      kind: "unavailable",
      cause: "no-api",
      detail: "宿主 SDK 客户端缺少 config.get，无法预读宿主配置",
    };
  }
  let result: any;
  try {
    result = await api.get();
  } catch (err) {
    return {
      kind: "unavailable",
      cause: "request-failed",
      detail: String(err),
    };
  }
  const data = result?.data;
  // An array is not a config table, so it carries no usable data either.
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    const error = JSON.stringify(result?.error) ?? "无";
    return {
      kind: "unavailable",
      cause: "no-data",
      detail: `宿主 config.get 未返回配置数据（error: ${error}）`,
    };
  }
  return { kind: "available", facts: hostMaterialisation(data) };
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
// Config writes
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
function injectAgentPrompts(
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
 * Register the skill directories the profile resolved.
 *
 * The paths come from the start preparation (see `publisher.ts`), which
 * reads the skill directories before any host write; the `config` hook
 * never scans.  This function only owns the OpenCode result sink
 * (initialising and appending to `config.skills.paths`).
 *
 * @param config - The config object being mutated by the `config` hook.
 * @param skillPaths - Absolute paths of the profile's skill directories.
 */
function registerSkillPaths(config: any, skillPaths: readonly string[]): void {
  config.skills ??= {};
  config.skills.paths ??= [];
  config.skills.paths.push(...skillPaths);
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
function registerProfileToolsInConfig(
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
 * Register the profile's slash commands as host command entries.
 *
 * The host runs them through `command.execute.before`, so the entry only
 * needs the description; the handler owns the flow.
 *
 * @param config - The config object being mutated by the `config` hook.
 * @param composed - The host-agnostic composition result.
 */
function registerCommands(config: any, composed: ComposedResult): void {
  for (const [name, contribution] of Object.entries(composed.commands)) {
    config.command ??= {};
    config.command[name] = {
      template: "",
      description: contribution.description,
    };
  }
}

// ---------------------------------------------------------------------------
// The config hook
// ---------------------------------------------------------------------------

/**
 * Create the `config` hook of one selection.
 *
 * The hook always exists and behaves according to the selection status:
 * `disabled` and `invalid` skip every profile-driven registration and
 * leave the host default agent alone, while `ready` re-checks that the
 * config about to be used still materialises the selected agents before
 * adopting the selection's orchestrator as `default_agent` and
 * registering the composed contributions.
 *
 * A non-ready selection is not an error here: the host entry point keeps
 * the infrastructure hooks and hands the selection over, so this hook
 * only has to leave the host configuration alone.
 *
 * @param composed - The host-agnostic composition result.
 * @param deps - Per-plugin-instance dependencies.
 * @param selection - The selection the composition was built from.
 * @param skillPaths - Absolute paths of the profile's skill directories,
 *   read by the start preparation.
 * @returns The hook the host calls with the config it is about to use.
 */
export function createConfigHook(
  composed: ComposedResult,
  deps: Partial<Capabilities>,
  selection: Selection,
  skillPaths: readonly string[],
): (config: any) => Promise<void> {
  return async (config: any): Promise<void> => {
    const agents = config.agent ?? {};
    logPluginInit(
      agents,
      composed.skills.map((s) => s.name),
      deps.limits,
    );
    // No runnable profile → no profile-driven registration at all, and
    // no default-agent takeover: the host keeps what it declared.  A
    // disabled or invalid selection was already logged during assembly
    // (see `selection_invalid`), and the configuration it could not
    // realise simply stays untouched.
    if (selection.status !== "ready") return;

    // Final atomic check against the config the host hands over now:
    // an earlier plugin may have changed the agent table the pre-read
    // facts came from.  Validate before mutating, because the host
    // applies the plugin's mutations even when the hook throws.
    const problems = unmaterialisedSelection(agents, selection);
    if (problems.length > 0) {
      throw new Error(`宿主配置无法运行选中的 profile：${problems.join("；")}`);
    }

    // The orchestrator is the host's default agent.  Deriving it from
    // the primary order or falling back to a built-in agent would run
    // the profile under an agent it did not select.
    if (selection.orchestrator !== undefined) {
      config.default_agent = selection.orchestrator;
    }

    injectAgentPrompts(agents, composed.agents);
    registerSkillPaths(config, skillPaths);
    registerProfileToolsInConfig(config, Object.keys(composed.tools));
    registerCommands(config, composed);
  };
}
