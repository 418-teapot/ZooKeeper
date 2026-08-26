/**
 * ZooKeeper — OpenCode plugin entry point.
 *
 * Prompt injection via `config` hook + `task()` prompt validation via
 * `tool.execute.before` hook + advisory nudges via `tool.execute.after`.
 *
 * Tool deny-listing is a single source of truth defined in `config.toml`,
 * compiled by `install.py` into `~/.config/opencode/opencode.json`.
 * The plugin injects prompt files at runtime via `config` hook,
 * validates task() prompt structure via `tool.execute.before`,
 * and appends soft guidance nudges via `tool.execute.after`.
 *
 * Registration is driven by the active mode profile
 * (`[zoo.mode.<name>]`, parsed by `parseModeProfile`): the profile's
 * category lists declare which agents, skills, hook units, tools, and
 * slash commands load.  `composeProfile` (in `src/core/compose.ts`)
 * selects the enabled units from the registry
 * (`src/registry.ts`), and the OpenCode adapter
 *  (`src/compose-opencode.ts`) turns the host-agnostic result into hook
 *  registrations.  When the profile is `null` (absent or invalid) every
 *  profile-driven registration is skipped — no defaults, no fallback to a
 *  full load — while the always-on infrastructure hooks (event,
 *  experimental.chat.system.transform) keep working.
 *
 *  This module is the entry + always-on infrastructure: it wires the
 *  parsed config, consumes the shared `sessionAgentMap` (held by
 *  `src/core/context/runtime.ts`), and merges
 *  the adapter's profile-driven fragment with the always-on
 *  infrastructure hooks.
 */

import config from "../config.toml" with { type: "toml" };
import { createV1Adapter } from "./adapters/opencode/adapter.js";
import { createOpenCodeHandoffTarget } from "./adapters/opencode/handoff-target.js";
import { createV1ToolHost } from "./adapters/opencode/tool-host.js";
import { assembleOpenCodeHooks } from "./compose-opencode.js";
import { composeProfile } from "./core/compose.js";
import {
  initPluginLogger,
  parseAgentModes,
  parseAgentPermissions,
  parseContextConfig,
  parseLimits,
  parseModeProfile,
} from "./core/config-parse.js";
import type { ModeProfile } from "./core/config-types.js";
import { setModelLimit } from "./core/context/model-limits.js";
import { cleanupSession, sessionAgentMap } from "./core/context/runtime.js";
import type { Deps } from "./core/slots.js";
import { derivePrimaries } from "./core/subagent/identity.js";
import { REGISTRY } from "./registry.js";

// ---------------------------------------------------------------------------
// Plugin entry point
// ---------------------------------------------------------------------------

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
 * @returns Plugin hooks object.
 */
export async function buildPlugin(input: any, zooConfig: any, rawConfig?: any) {
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

  // ── Profile-driven composition ────────────────────────────────────
  // `sessionAgentMap` is the shared session → agent map held by
  // core/context/runtime.ts; this entry populates it via
  // `message.updated` events and the adapter's units read it.
  const deps: Deps = {
    limits,
    contextConfig,
    agentModes,
    agentPermissions,
    client,
    directory,
    sessionAgentMap,
    toolHost: createV1ToolHost(client, sessionAgentMap),
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
    // ── Always-on infrastructure hooks ────────────────────────────────
    async event(input: {
      event: { type: string; properties?: Record<string, unknown> };
    }) {
      const { type, properties } = input.event;

      // Track agent identity from message.updated events.
      // Covers user messages, assistant responses, and system messages
      // (e.g. /go handoff) — more comprehensive than chat.message alone.
      if (type === "message.updated") {
        const info = properties?.info as
          | { agent?: string; sessionID?: string }
          | undefined;
        if (info?.agent && info.sessionID) {
          sessionAgentMap.set(info.sessionID, info.agent);
        }
      }

      // Clean up on session deletion — single entry point that drops
      // every per-session record (maps, model limit, pruning state).
      if (type === "session.deleted") {
        const info = properties?.info as { id?: string } | undefined;
        if (info?.id) {
          cleanupSession(info.id);
        }
      }
    },

    async "experimental.chat.system.transform"(
      input: {
        sessionID?: string;
        model: { id: string; limit: { context: number; output: number } };
      },
      _output: { system: string[] },
    ) {
      // Capture the active model's context window per session so the
      // pruning nudge phase can resolve percentage thresholds against
      // the real limit.  Missing session IDs / limits are ignored by
      // the registry itself.
      if (input.model?.limit?.context !== undefined) {
        setModelLimit(
          input.sessionID ?? "",
          input.model.limit.context,
          input.model.id,
        );
      }
    },

    // ── Profile-driven registrations (from the adapter) ─────────────
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

export { createV1Adapter } from "./adapters/opencode/adapter.js";
// ---------------------------------------------------------------------------
// Test-only exports — exposed for unit testing
// ---------------------------------------------------------------------------
export {
  buildToolHooks,
  injectAgentPrompts,
  registerProfileToolsInConfig,
  registerSkills,
  runAfterHandlers,
} from "./compose-opencode.js";
export { sessionAgentMap } from "./core/context/runtime.js";
