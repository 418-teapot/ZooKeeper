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
 * (`src/compose-opencode.ts`) turns the host-agnostic result into hook
 * registrations.  When the profile is `null` (absent or invalid) every
 * profile-driven registration is skipped — no defaults, no fallback to a
 * full load — while the always-on infrastructure hooks (chat.params,
 * event, experimental.chat.system.transform, experimental.text.complete)
 * keep working.
 *
 * This module is the entry + always-on infrastructure: it wires the
 * parsed config, consumes the shared `sessionAgentMap` (held by
 * `src/core/context/runtime.ts`), and merges
 * the adapter's profile-driven fragment with the always-on
 * infrastructure hooks.
 */

import config from "../config.toml" with { type: "toml" };
import { assembleOpenCodeHooks } from "./compose-opencode.js";
import { composeProfile } from "./core/compose.js";
import {
  initPluginLogger,
  parseContextConfig,
  parseLimits,
  parseModeProfile,
} from "./core/config-parse.js";
import type { ModeProfile } from "./core/config-types.js";
import { setModelLimit } from "./core/context/model-limits.js";
import { stripLineStartRefs } from "./core/context/reply-strip.js";
import { cleanupSession, sessionAgentMap } from "./core/context/runtime.js";
import type { Deps } from "./core/slots.js";
import { REGISTRY } from "./registry.js";
import { log, setSessionId } from "./utils/logger.js";

let _sessionIdSet = false;

// ---------------------------------------------------------------------------
// Plugin entry point
// ---------------------------------------------------------------------------

/**
 * Build the plugin hooks object from an explicit zoo config.
 *
 * Profile-driven registrations (agents, skills, hook units, tools, slash
 * commands) are composed from the active `[zoo.mode.*]` profile; when the
 * profile is null they are all skipped while the infrastructure hooks
 * (chat.params, event, experimental.chat.system.transform,
 * experimental.text.complete) keep working.
 *
 * Exported for unit testing — `zookeeper` wires this with the imported
 * config.toml.
 *
 * @param input - OpenCode plugin input (client, directory, ...).
 * @param zooConfig - The `zoo` section of config.toml.
 * @returns Plugin hooks object.
 */
export async function buildPlugin(input: any, zooConfig: any) {
  const limits = parseLimits(zooConfig);
  const contextConfig = parseContextConfig(zooConfig);
  const modeProfile: ModeProfile | null = parseModeProfile(zooConfig);
  const client = input.client;
  const directory: string = (input as any).directory ?? "";

  initPluginLogger(zooConfig);

  // ── Profile-driven composition ────────────────────────────────────
  // `sessionAgentMap` is the shared session → agent map held by
  // core/context/runtime.ts; this entry populates it via
  // `message.updated` events and the adapter's units read it.
  const deps: Deps = {
    limits,
    contextConfig,
    client,
    directory,
    sessionAgentMap,
  };
  const composed = composeProfile(modeProfile, REGISTRY, deps);
  const profileHooks = assembleOpenCodeHooks(composed, deps, modeProfile);

  return {
    // ── Always-on infrastructure hooks ────────────────────────────────
    async "chat.params"(
      input: { sessionID: string },
      _output: Record<string, unknown>,
    ) {
      if (!_sessionIdSet && input.sessionID) {
        setSessionId(input.sessionID);
        _sessionIdSet = true;
      }
    },

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

    async "experimental.text.complete"(
      input: {
        sessionID: string;
        messageID: string;
        partID: string;
      },
      output: { text: string },
    ) {
      // Strip exact line-start `[mN] ` echoes from outbound assistant
      // text so model-mimicked ref prefixes never reach the
      // user-visible transcript.
      const before = output.text;
      output.text = stripLineStartRefs(output.text);

      // Detect ref-prefix stripping: when the reply started with an
      // exact `[mN] ` echo, log a warning with the stripped tail.
      if (before !== output.text) {
        log(
          "text.complete",
          "reply_ref_stripped",
          input.sessionID,
          undefined,
          "warn",
          { fragment: before.slice(0, 200) },
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
  return buildPlugin(input, (config as any).zoo ?? {});
}

export default { id: "zookeeper", server: zookeeper };

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
export { handleMessagesTransform } from "./hooks/context-metrics";
export {
  handleDedupNotify,
  resolveSessionAgent,
} from "./hooks/context-pruning";
