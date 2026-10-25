/**
 * ZooKeeper — OpenCode plugin entry point.
 *
 * Wiring only: parses the `zoo` config, composes the active mode profile,
 * and merges the always-on infrastructure hooks with the adapter's
 * profile-driven fragment.  Registration is driven by the active mode
 * profile (`[zoo.mode.<name>]`, parsed by `parseModeProfile`): the
 * profile's category lists declare which agents, skills, hook units,
 * tools, and slash commands load, the assembly in `src/core/compose.ts`
 * plans the selection from the registry (`src/registry.ts`), binds this
 * host's capabilities and builds the contributions, and the OpenCode
 * adapter (`src/compose-opencode.ts`) turns the host-agnostic result into
 * hook registrations.  The selection decides what the adapter registers:
 * `disabled` (no profile) skips every profile-driven registration, while
 * `invalid` makes the entry point throw before any hook is returned — no
 * defaults, no fallback to a full load — and the infrastructure hooks
 * (`src/adapters/opencode/infra-hooks.ts`) keep working for the disabled
 * and ready selections.
 *
 * This host also declares the product's orchestrator role
 * (`ORCHESTRATOR_AGENT_NAME`) to the planner, so a profile that cannot
 * provide that agent as a primary is invalid and loads nothing instead of
 * running under an undeclared role.  The host config is read through the
 * SDK client before assembly, so the planner also knows which agents the
 * host will materialise and which of them it accepts as its default
 * agent.  For a ready selection the adapter adopts that agent as the
 * host's `default_agent`.
 *
 * @module
 */

import config from "../config.toml" with { type: "toml" };
import { createV1Adapter } from "./adapters/opencode/adapter.js";
import { createOpenCodeHandoffTarget } from "./adapters/opencode/handoff-target.js";
import { buildInfraHooks } from "./adapters/opencode/infra-hooks.js";
import { createOpenCodeMessageInjector } from "./adapters/opencode/message-injector.js";
import { todoSourceFromClient } from "./adapters/opencode/todo-source.js";
import {
  createV1ToolHost,
  resolveSessionAgent,
} from "./adapters/opencode/tool-host.js";
import {
  assembleOpenCodeHooks,
  invalidSelectionMessage,
  readHostMaterialisation,
} from "./compose-opencode.js";
import { capabilityBindings } from "./core/bindings.js";
import { configCapabilities, parseCommonConfig } from "./core/capabilities.js";
import { assemble } from "./core/compose.js";
import { initPluginLogger } from "./core/config-parse.js";
import { ORCHESTRATOR_AGENT_NAME } from "./core/orchestrator.js";
import type { Capabilities } from "./core/ports/index.js";
import { filterDisjointVariants } from "./core/prompt-variant.js";
import { sessionAgentRegistry } from "./core/session-agent.js";
import { REGISTRY } from "./registry.js";
import { log } from "./utils/logger.js";

/**
 * Build the plugin hooks object from an explicit zoo config.
 *
 * Profile-driven registrations (agents, skills, hook units, tools, slash
 * commands) are composed from the active `[zoo.mode.*]` profile, and the
 * adapter realises them from the resolved selection: a disabled selection
 * registers nothing, an invalid one is refused before any hook is
 * returned, and a ready one adopts the selection's orchestrator as
 * `default_agent`.  The infrastructure hooks (event,
 * experimental.chat.system.transform) keep working for the disabled and
 * ready selections.
 *
 * Exported for unit testing — `zookeeper` wires this with the imported
 * config.toml.
 *
 * @param input - OpenCode plugin input (client, directory, ...).
 * @param zooConfig - The `zoo` section of config.toml.
 * @param rawConfig - The whole parsed config root (agent tables).
 * @param overrides - Optional host-dependency overrides.  Only used by
 *   tests: the auto-debug end-to-end suite injects a `zdebug` runner that
 *   points at a built binary so no `PATH` lookup is needed.
 * @returns Plugin hooks object.
 * @throws When the active profile cannot be realised on this host — the
 *   host config is unreadable, a selected agent is not materialised, or
 *   the declared orchestrator is unusable.  Throwing keeps the host from
 *   loading the plugin at all, so no partial hook set survives.
 */
export async function buildPlugin(
  input: any,
  zooConfig: any,
  rawConfig?: any,
  overrides?: {
    /** Test seam: `zdebug` runner for the auto-debug strategy. */
    zdebugExec?: Partial<Capabilities>["zdebugExec"];
  },
) {
  const common = parseCommonConfig(zooConfig, rawConfig);
  const { modeProfile, agentModes } = common;
  const client = input.client;
  const directory: string = (input as any).directory ?? "";

  initPluginLogger(zooConfig, "opencode");

  // The host's materialisation facts are read before anything is bound or
  // built: the selection is planned from what the host will actually
  // create, so a profile the host cannot realise never runs a unit
  // factory.  A disabled selection asks the host nothing.
  const materialisation =
    modeProfile === null ? undefined : await readHostMaterialisation(client);

  // `sessionAgentRegistry` is the shared session → agent registry held
  // by core/session-agent.ts; the infrastructure hooks populate it via
  // `message.updated` events and the units read it through
  // `resolveAgent`.
  const resolveAgent = (sessionID: string): string | undefined =>
    sessionAgentRegistry.resolve(sessionID);
  // The asynchronous counterpart the delegation gate uses to identify the
  // caller: the registry read above, then the host's own `session.get` —
  // the OpenCode SDK exposes no other session-access method.
  const resolveCallerAgent = (sessionID: string): Promise<string | undefined> =>
    resolveSessionAgent(sessionID, client, resolveAgent);
  // The selection-independent capability values.  Also handed to the
  // adapter, which reads the limits for its init log and the caller resolver
  // for the delegation gate (both are host facts, not selection facts).
  const values: Partial<Capabilities> = {
    ...configCapabilities(common),
    // OpenCode serves the todo read from its SDK client; the assembly is
    // the single place that binds the backend (pi binds its state store).
    todoSource: todoSourceFromClient(client),
    directory,
    zdebugExec: overrides?.zdebugExec,
    resolveAgent,
    resolveCallerAgent,
    toolHost: createV1ToolHost(client, resolveAgent),
    adapter: createV1Adapter(),
    messageInjector: createOpenCodeMessageInjector(client, resolveAgent),
    // The `/go` handoff target.  Built from host facts only — the
    // executor agent travels with each handoff call, so the target is the
    // same for every selection.
    handoffTarget: createOpenCodeHandoffTarget(client, directory),
  };
  const bindings = capabilityBindings({ values });
  const { composed, selection } = assemble({
    profile: modeProfile,
    units: REGISTRY,
    bindings,
    agentModes,
    // The product's orchestrator role.  The planner decides whether the
    // enabled profile can provide it; this host holds no fallback.
    orchestrator: ORCHESTRATOR_AGENT_NAME,
    // What the host will materialise, as read above.
    materialisation,
  });

  // A selection the host cannot realise is refused before any hook is
  // returned: OpenCode discards a plugin whose factory throws, so the
  // profile never runs with a missing agent or an unusable orchestrator.
  // The config hook keeps its own atomic check for later plugin edits.
  if (selection.status === "invalid") {
    throw new Error(invalidSelectionMessage(selection));
  }

  const selectionHooks = assembleOpenCodeHooks(composed, values, selection);

  // Assemble the model-family wordings from every enabled agent, tracking
  // the contributing agent so a dropped pair can be traced.  The union is
  // filtered before injection: `applyModelVariant` rewrites the text pair
  // by pair, so a pair whose wording overlaps an earlier pair would
  // rewrite that pair's output (cross-talk).  Keeping the first
  // occurrence and dropping the rest is fail-closed; the conflict is
  // logged rather than applied.
  const contributedVariants = composed.agents.flatMap((agent) =>
    (agent.promptVariants ?? []).map((pair) => ({ agent: agent.name, pair })),
  );
  const { kept: promptVariants, dropped } = filterDisjointVariants(
    contributedVariants.map((item) => item.pair),
  );
  if (dropped.length > 0) {
    const droppedPairs = new Set(dropped);
    const sources = [
      ...new Set(
        contributedVariants
          .filter((item) => droppedPairs.has(item.pair))
          .map((item) => item.agent),
      ),
    ];
    log.warn({
      hook: "prompt-variant",
      event: "conflict_dropped",
      dropped: dropped.length,
      sources,
    });
  }

  return {
    // Always-on infrastructure hooks.
    ...buildInfraHooks({
      client,
      resolveAgent,
      onSettled: composed.onSettled,
      promptVariants,
      orchestrator: selection.orchestrator,
    }),
    // Selection-driven registrations (from the adapter).
    ...selectionHooks,
  };
}

/**
 * @param input - OpenCode plugin input (unused).
 * @returns Plugin hooks object.
 */
export async function zookeeper(input: any) {
  return buildPlugin(input, (config as any).zoo ?? {}, config as any);
}

export default { id: "zookeeper", server: zookeeper };
