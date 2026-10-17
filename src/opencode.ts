/**
 * ZooKeeper — OpenCode plugin entry point.
 *
 * Wiring only: parses the `zoo` config, composes the active mode profile,
 * and merges the always-on infrastructure hooks with the adapter's
 * profile-driven fragment.  Registration is driven by the active mode
 * profile (`[zoo.mode.<name>]`, parsed by `parseModeProfile`): the
 * profile's category lists declare which agents, skills, hook units,
 * tools, and slash commands load, `composeProfile` (in `src/core/compose.ts`)
 * selects the enabled units from the registry (`src/registry.ts`), and the
 * OpenCode adapter (`src/compose-opencode.ts`) turns the host-agnostic
 * result into hook registrations.  When the profile is `null` (absent or
 * invalid) every profile-driven registration is skipped — no defaults, no
 * fallback to a full load — while the infrastructure hooks
 * (`src/adapters/opencode/infra-hooks.ts`) keep working.
 *
 * @module
 */

import config from "../config.toml" with { type: "toml" };
import { createV1Adapter } from "./adapters/opencode/adapter.js";
import { createOpenCodeHandoffTarget } from "./adapters/opencode/handoff-target.js";
import { buildInfraHooks } from "./adapters/opencode/infra-hooks.js";
import { createOpenCodeMessageInjector } from "./adapters/opencode/message-injector.js";
import { createV1ToolHost } from "./adapters/opencode/tool-host.js";
import { assembleOpenCodeHooks } from "./compose-opencode.js";
import { configCapabilities, parseCommonConfig } from "./core/capabilities.js";
import { composeProfile } from "./core/compose.js";
import { initPluginLogger } from "./core/config-parse.js";
import type { Capabilities } from "./core/ports/index.js";
import { filterDisjointVariants } from "./core/prompt-variant.js";
import { sessionAgentRegistry } from "./core/session-agent.js";
import { derivePrimaries } from "./core/subagent/identity.js";
import { REGISTRY } from "./registry.js";
import { log } from "./utils/logger.js";

/**
 * Build the plugin hooks object from an explicit zoo config.
 *
 * Profile-driven registrations (agents, skills, hook units, tools, slash
 * commands) are composed from the active `[zoo.mode.*]` profile; when the
 * profile is null they are all skipped while the infrastructure hooks
 * (event, experimental.chat.system.transform) keep working.
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

  // `sessionAgentRegistry` is the shared session → agent registry held
  // by core/session-agent.ts; the infrastructure hooks populate it via
  // `message.updated` events and the units read it through
  // `resolveAgent`.
  const resolveAgent = (sessionID: string): string | undefined =>
    sessionAgentRegistry.resolve(sessionID);
  const provided: Partial<Capabilities> = {
    ...configCapabilities(common),
    client,
    directory,
    zdebugExec: overrides?.zdebugExec,
    resolveAgent,
    toolHost: createV1ToolHost(client, resolveAgent),
    adapter: createV1Adapter(),
    handoffTarget: createOpenCodeHandoffTarget(
      client,
      derivePrimaries(modeProfile?.agents ?? [], agentModes)[0],
      directory,
    ),
    messageInjector: createOpenCodeMessageInjector(client, resolveAgent),
  };
  const composed = composeProfile(modeProfile, REGISTRY, provided);
  const profileHooks = assembleOpenCodeHooks(composed, provided, modeProfile);

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
    log("prompt-variant", "conflict_dropped", "", undefined, "warn", {
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
    }),
    // Profile-driven registrations (from the adapter).
    ...profileHooks,
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
