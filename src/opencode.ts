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
import { createV1ToolHost } from "./adapters/opencode/tool-host.js";
import { assembleOpenCodeHooks } from "./compose-opencode.js";
import { composeProfile } from "./core/compose.js";
import {
  initPluginLogger,
  parseAgentModes,
  parseAgentPermissions,
  parseAutoDebugConfig,
  parseContextConfig,
  parseContinuationConfig,
  parseLimits,
  parseModeProfile,
} from "./core/config-parse.js";
import type { ModeProfile } from "./core/config-types.js";
import { sessionAgentRegistry } from "./core/session-agent.js";
import type { Deps } from "./core/slots.js";
import { derivePrimaries } from "./core/subagent/identity.js";
import { REGISTRY } from "./registry.js";

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
    zdebugExec?: Deps["zdebugExec"];
  },
) {
  const limits = parseLimits(zooConfig);
  const contextConfig = parseContextConfig(zooConfig);
  const modeProfile: ModeProfile | null = parseModeProfile(zooConfig);
  // The `agent` table lives at the top level of config.toml, so the
  // fail-closed mode map is parsed from the whole parsed root (empty map
  // when no raw config was supplied).
  const agentModes = parseAgentModes(rawConfig ?? {});
  // Tool-level deny map for the primary-switch unit.  Populated for
  // parity with the pi host; OpenCode never provides `piSwitchHost`, so
  // the switch unit contributes no commands there regardless.
  const agentPermissions = parseAgentPermissions(rawConfig ?? {});
  const client = input.client;
  const directory: string = (input as any).directory ?? "";

  initPluginLogger(zooConfig, "opencode");

  // `sessionAgentRegistry` is the shared session → agent registry held
  // by core/session-agent.ts; the infrastructure hooks populate it via
  // `message.updated` events and the units read it through
  // `deps.resolveAgent`.
  const resolveAgent = (sessionID: string): string | undefined =>
    sessionAgentRegistry.resolve(sessionID);
  const deps: Deps = {
    limits,
    contextConfig,
    continuationConfig: parseContinuationConfig(zooConfig),
    autoDebugConfig: parseAutoDebugConfig(zooConfig),
    agentModes,
    agentPermissions,
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
  };
  const composed = composeProfile(modeProfile, REGISTRY, deps);
  const profileHooks = assembleOpenCodeHooks(composed, deps, modeProfile);

  return {
    // Always-on infrastructure hooks.
    ...buildInfraHooks({
      client,
      resolveAgent,
      onSettled: composed.onSettled,
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
