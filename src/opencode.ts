/**
 * ZooKeeper — OpenCode plugin entry point.
 *
 * Wiring only: it parses the imported config.toml into this plugin
 * instance's snapshot and starts the runtime through the shared start
 * protocol (`core/runtime.ts`) with the main origin.  The runtime's
 * publisher (`adapters/opencode/publisher.ts`) composes the active mode
 * profile and merges the always-on infrastructure hooks with the adapter's
 * profile-driven fragment.  Registration is driven by the active mode
 * profile (`[zoo.mode.<name>]`, parsed by `parseModeProfile`): the
 * profile's category lists declare which agents, skills, hook units,
 * tools, and slash commands load, the assembly in `src/core/compose.ts`
 * plans the selection from the registry (`src/registry.ts`), binds this
 * host's capabilities and builds the contributions, and the OpenCode
 * adapter (`src/adapters/opencode/profile-hooks.ts`) turns the
 * host-agnostic result into hook registrations.  The selection decides what
 * the adapter registers:
 * `disabled` (no profile) and `invalid` (a profile this host cannot
 * realise) skip every profile-driven registration — no defaults, no
 * fallback to a full load — while the infrastructure hooks
 * (`src/adapters/opencode/infra-hooks.ts`) keep working for every
 * selection.  An invalid selection closes this configuration only; it is
 * logged with its structured reason and never fails the extension.
 *
 * This host also declares the product's orchestrator role
 * (`ORCHESTRATOR_AGENT_NAME`) to the planner, so a profile that cannot
 * provide that agent as a primary is invalid and loads nothing instead of
 * running under an undeclared role.  The host config is read through the
 * SDK client before assembly, so the planner also knows which agents the
 * host will materialise and which of them it accepts as its default
 * agent; an unreadable config is an unavailable host fact, which closes
 * this configuration instead of being read as "no constraint".  For a
 * ready selection the adapter adopts that agent as the host's
 * `default_agent`.
 *
 * One lifecycle kernel backs the plugin instance (see
 * `adapters/opencode/lifecycle-wiring.ts`): its extension scope owns the
 * capability provision (including the host config pre-read) and the
 * assembled profile, so the publisher activates the extension before it
 * assembles any hook — no host code composes outside the graph.  Its session
 * scopes own the per-session state the always-on hooks drive, so
 * `session.created` is a real start notice, `session.deleted` stops exactly
 * that session, and the host's `dispose` stops every remaining session and
 * then the extension.
 * Every assembled hook that names a session enters through that session's
 * work permit, so a hook call that is the host's first word about a session
 * still gets its scope, a session the host deleted never runs another
 * hook, and a stop waits for running work before disposing the scope.  The
 * registered tools take the same path and receive the permit's signal as
 * their abort.  The hooks naming no session (`config` and `tool.definition`)
 * stay unwrapped: the configuration stage never enters the session
 * lifecycle.  The `event` hook sends a session creation and a deletion
 * straight to the lifecycle and admits only its per-session work.
 *
 * @module
 */

import config from "../config.toml" with { type: "toml" };
import { openCodeProcessState } from "./adapters/opencode/process.js";
import {
  createOpenCodeRuntime,
  type OpenCodeStartOverrides,
  type OpenCodeStartPublication,
} from "./adapters/opencode/publisher.js";
import { initPluginLogger } from "./core/config-parse.js";
import { createConfigScope } from "./core/config-snapshot.js";
import { MAIN_ORIGIN, startRuntime } from "./core/runtime.js";

/**
 * Build the plugin hooks object from an explicit zoo config.
 *
 * Profile-driven registrations (agents, skills, hook units, tools, slash
 * commands) are composed from the active `[zoo.mode.*]` profile, and the
 * adapter realises them from the resolved selection: a disabled or
 * invalid selection registers nothing (the invalid one only closes this
 * configuration, logged as `selection_invalid`), and a ready one adopts
 * the selection's orchestrator as `default_agent`.  The infrastructure
 * hooks (event, experimental.chat.system.transform) keep working for
 * every selection.
 *
 * The start runs through the shared start protocol
 * (`core/runtime.ts` over `adapters/opencode/publisher.ts`): the runtime
 * owner is created first, then every fallible step — the extension
 * activation, the profile assembly, the skill-directory read — completes
 * before the host receives the hooks, so a failure never leaves a
 * half-delivered plugin behind and closes the runtime it created.
 *
 * Exported for unit testing — `zookeeper` wires this with the imported
 * config.toml.
 *
 * @param input - OpenCode plugin input (client, directory, ...).
 * @param zooConfig - The `zoo` section of config.toml.
 * @param rawConfig - The whole parsed config root (agent tables).
 * @param overrides - Optional test seams: the auto-debug end-to-end suite
 *   injects a `zdebug` runner that points at a built binary so no `PATH`
 *   lookup is needed.
 * @returns The plugin publication: the host hooks plus the teardown.
 * @throws When a program error prevents assembly (a capability that
 *   cannot be bound, an inconsistent declaration).  A profile this host
 *   cannot realise is not an error here: it is logged and registers
 *   nothing, so the infrastructure keeps running.  A skill directory the
 *   scan cannot read is logged and skipped, so the start continues with
 *   the paths it collected.
 */
export async function buildPlugin(
  input: any,
  zooConfig: any,
  rawConfig?: any,
  overrides?: OpenCodeStartOverrides,
): Promise<OpenCodeStartPublication> {
  initPluginLogger(zooConfig, "opencode");
  const scope = createConfigScope(zooConfig, rawConfig);
  const process = openCodeProcessState();
  const handle = await startRuntime({
    scope,
    origin: MAIN_ORIGIN,
    createRuntime: ({ scope: startScope }) =>
      createOpenCodeRuntime({
        scope: startScope,
        process,
        pluginInput: input,
        ...(overrides === undefined ? {} : { overrides }),
      }),
  });
  return handle.publication;
}

/**
 * @param input - OpenCode plugin input (unused).
 * @returns The plugin publication.
 */
export async function zookeeper(input: any) {
  return buildPlugin(input, (config as any).zoo ?? {}, config as any);
}

export default { id: "zookeeper", server: zookeeper };
