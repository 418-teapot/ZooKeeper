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
 * This module is a thin wiring layer — hook implementation lives in
 * `src/hooks/` submodules, and framework-independent logic lives in
 * `src/core/`.
 *
 * TODO: Add pi / oh-my-pi adapter (framework adapter).
 */

import { readdirSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import config from "../config.toml" with { type: "toml" };
import { BEAVER_PROMPT } from "./agents/beaver.js";
import { DOLPHIN_PROMPT } from "./agents/dolphin.js";
import { EAGLE_PROMPT } from "./agents/eagle.js";
import { KIWI_PROMPT } from "./agents/kiwi.js";
import { LYNX_PROMPT } from "./agents/lynx.js";
import { MOLA_PROMPT } from "./agents/mola.js";
import { SPIDER_PROMPT } from "./agents/spider.js";
import {
  initPluginLogger,
  parseContextConfig,
  parseLimits,
  parseSkillsConfig,
} from "./core/config-parse.js";
import { clearModelLimit, setModelLimit } from "./core/model-limits.js";
import {
  deleteSessionState,
  removeSession,
  stripRefsFromString,
  ZOO_MSG_ID_CANONICAL_END_REGEX,
} from "./core/pruning/index.js";
import { DCP_COMMAND_HANDLED, handleDcpCommand } from "./hooks/context-command";
import type { ContextMetricsOutput } from "./hooks/context-metrics";
import { measureContext } from "./hooks/context-metrics";
import { contextPruningTransformHandler } from "./hooks/context-pruning";
import type { ContextPruningConfig } from "./hooks/context-pruning/index.js";
import { nudgeDirectWorkForAgent } from "./hooks/direct-work-nudge";
import { recoverJsonError } from "./hooks/json-error-nudge";
import { handleGoCommand } from "./hooks/plan-lifecycle";
import { nudgePostTask } from "./hooks/post-task-nudge";
import { validateDelegationTarget } from "./hooks/task-delegation";
import {
  enhanceTaskDefinition,
  nudgeTaskOutput,
  validateBeforeExec,
} from "./hooks/task-prompt";
import {
  type CompressToolDefinition,
  createCompressTool,
} from "./tools/compress";
import {
  createDecompressTool,
  type DecompressToolDefinition,
} from "./tools/decompress";
import { log, setSessionId } from "./utils/logger.js";

// ---------------------------------------------------------------------------
// Agent identity tracking — populated by message.updated event, queried by hooks
// ---------------------------------------------------------------------------

/** Maps session IDs to agent names reported by message.updated events. */
const sessionAgentMap = new Map<string, string>();

/**
 * Cache of sub-agent status per session ID.
 *
 * Populated on first access during `experimental.chat.messages.transform`
 * by calling `client.session.get()`.  Cleared on `session.deleted`.
 *
 * Sub-agent sessions (created via the `task` tool) have a `parentID` set
 * on the session info; main sessions do not.
 */
const subAgentCache = new Map<string, boolean>();

const AGENT_PROMPTS: Record<string, string> = {
  dolphin: DOLPHIN_PROMPT,
  beaver: BEAVER_PROMPT,
  mola: MOLA_PROMPT,
  lynx: LYNX_PROMPT,
  spider: SPIDER_PROMPT,
  eagle: EAGLE_PROMPT,
  kiwi: KIWI_PROMPT,
};

const __dirname = dirname(fileURLToPath(import.meta.url));
const CORE_DIR = resolve(__dirname, "../core");

let _sessionIdSet = false;

// ---------------------------------------------------------------------------
// Config hook helpers
// ---------------------------------------------------------------------------

/** Log plugin init event with agent/skills summary. */
function logPluginInit(
  agents: Record<string, any>,
  limits: ReturnType<typeof parseLimits>,
  skillsConfig: Record<string, string>,
): void {
  log("plugin", "plugin_init", "", undefined, "info", {
    agents: Object.keys(agents),
    limits,
    skills: Object.keys(skillsConfig).filter(
      (k) => skillsConfig[k] === "enable",
    ),
  });
}

/** Inject prompt files into each agent config. */
function injectAgentPrompts(agents: Record<string, any>): void {
  for (const [name, agent] of Object.entries(agents)) {
    if (typeof agent !== "object" || agent === null) continue;
    const prompt = AGENT_PROMPTS[name];
    if (prompt) {
      (agent as any).prompt = prompt;
      log("plugin", "agent_loaded", "", undefined, "debug", {
        agent: name,
        prompt_len: prompt.length,
      });
    }
  }
}

/** Register enabled skills from the core/skills/ directory.
 *
 *  Fail-closed: a skill registers only when its `[zoo.skills]` entry is
 *  exactly `"enable"`.  Absent keys, typos, and junk values all disable
 *  the skill silently — no warn, because config.toml (the single source
 *  of truth) lists every skill explicitly and any deviation is
 *  intentional.
 */
function registerSkills(
  pluginConfig: any,
  skillsConfig: Record<string, string>,
): void {
  pluginConfig.skills ??= {};
  pluginConfig.skills.paths ??= [];
  const skillsDir = resolve(CORE_DIR, "skills");
  try {
    for (const entry of readdirSync(skillsDir)) {
      const skillPath = resolve(skillsDir, entry);
      if (!statSync(skillPath).isDirectory()) continue;
      if (skillsConfig[entry] !== "enable") continue;
      pluginConfig.skills.paths.push(skillPath);
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

// ---------------------------------------------------------------------------
// Hook handler helpers
// ---------------------------------------------------------------------------

/** Input shape for the tool.execute.after hook. */
interface AfterExecInput {
  tool: string;
  sessionID: string;
  callID: string;
  args?: Record<string, unknown>;
}

/** Output shape for the tool.execute.after hook. */
interface AfterExecOutput {
  output?: string;
}

/**
 * Resolve the current agent for a session.
 *
 * Resolution order:
 *   (a) `agentMap` (in-memory map populated solely by the message.updated
 *       handler — single source of truth)
 *   (b) `client.session.get()` API call — per-call fallback WITHOUT
 *       write-back to the map, so a mid-session agent change is reflected
 *       as soon as either the next message.updated or the next resolution
 *       happens.
 *   (c) `undefined` — current behavior preserved, debug log entry
 *
 * Exported for unit testing.
 */
export async function resolveSessionAgent(
  sessionID: string,
  client: any,
  agentMap: Map<string, string>,
): Promise<string | undefined> {
  // (a) Check in-memory map first (fast, no I/O).
  const mapped = agentMap.get(sessionID);
  if (mapped) return mapped;

  // (b) Fallback to session API — read the agent from the session object.
  //     The OpenCode Session type (both v1 and v2 SDKs) carries an
  //     optional `agent` field (verified in @opencode-ai/sdk types:
  //     SessionPromptData.body.agent and Session.agent).
  //     No write-back to agentMap: the map has a single writer
  //     (message.updated handler) to avoid stale-agent windows.
  if (client?.session?.get) {
    try {
      const sessionInfo = await client.session.get({
        path: { id: sessionID },
      });
      if (sessionInfo?.agent) {
        return sessionInfo.agent;
      }
    } catch {
      // Session not found — fall through to (c).
    }
  }

  // (c) Unknown — log debug entry and return undefined (preserves current
  //     behaviour where the notify message carries no agent).
  log(
    "context-pruning",
    "dedup_notify_no_agent",
    sessionID,
    undefined,
    "debug",
    {},
  );
  return undefined;
}

/**
 * Fire-and-forget notification for dedup batch release.
 *
 * Sends a silent (noReply + ignored) message to the session chat when the
 * agent is known; suppresses the notification entirely when the agent
 * cannot be resolved, logging the drop at warn level.
 *
 * Resolution order:
 *   (a) In-memory agentMap (fast, synchronous)
 *   (b) client.session.get() fallback (async)
 *   (c) Suppressed — agent unresolved
 *
 * Exported for unit testing.
 */
export function handleDedupNotify(
  sessionID: string,
  client: any,
  agentMap: Map<string, string>,
  text: string,
): void {
  const body: Record<string, unknown> = {
    noReply: true,
    parts: [{ type: "text", text, ignored: true }],
  };

  const send = () => {
    try {
      client?.session
        ?.prompt({
          path: { id: sessionID },
          body,
        })
        .catch((err: Error) => {
          log(
            "context-pruning",
            "dedup_notify_failed",
            sessionID,
            undefined,
            "warn",
            { error: String(err) },
          );
        });
    } catch (err) {
      log(
        "context-pruning",
        "dedup_notify_failed",
        sessionID,
        undefined,
        "warn",
        { error: String(err) },
      );
    }
  };

  // (a) Agent known from in-memory map — send immediately.
  const agent = agentMap.get(sessionID);
  if (agent) {
    body.agent = agent;
    send();
    return;
  }

  // (b)/(c) Agent not in map — try async fallback.
  // The promise chain is never awaited by the transform hook.
  resolveSessionAgent(sessionID, client, agentMap)
    .then((resolvedAgent) => {
      if (resolvedAgent) {
        body.agent = resolvedAgent;
        send();
        return;
      }
      // (c) Agent unresolved — suppress notification.
      log(
        "context-pruning",
        "dedup_notify_suppressed",
        sessionID,
        undefined,
        "warn",
        { reason: "agent unresolved" },
      );
    })
    .catch((err) => {
      log(
        "context-pruning",
        "dedup_notify_suppressed",
        sessionID,
        undefined,
        "warn",
        { reason: "agent unresolved", error: String(err) },
      );
    });
}

/** Track context metrics with error isolation. */
function handleMessagesTransform(output: ContextMetricsOutput): void {
  try {
    measureContext(output);
  } catch (err) {
    log(
      "plugin",
      "handler_crashed",
      output.messages?.[0]?.info?.sessionID ?? "",
      undefined,
      "error",
      { handler: "measureContext", error: String(err) },
    );
  }
}

/** Run context pruning on the messages transform output. */
function handleContextPruning(
  output: ContextMetricsOutput,
  config: ContextPruningConfig,
  client: any,
  isSubAgent?: boolean,
): void {
  try {
    const sessionID = output.messages?.[0]?.info?.sessionID ?? "";

    contextPruningTransformHandler(
      output.messages,
      config,
      // Fire-and-forget: notify the session chat with dedup release info.
      // Must NOT await — the transform hook must never block.
      (text: string) =>
        handleDedupNotify(sessionID, client, sessionAgentMap, text),
      isSubAgent,
    );
  } catch (err) {
    log(
      "plugin",
      "handler_crashed",
      output.messages?.[0]?.info?.sessionID ?? "",
      undefined,
      "error",
      { handler: "contextPruning", error: String(err) },
    );
  }
}

/** Run a list of after-exec handlers with per-handler error isolation. */
async function runAfterHandlers(
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

/** Per-plugin-instance dependencies captured by `buildAfterHandlers`. */
interface AfterHandlerDeps {
  limits: ReturnType<typeof parseLimits>;
  client: any;
  directory: string;
}

/**
 * Build the fixed `tool.execute.after` handler table.
 *
 * Defined once per plugin instance (module-level factory) so the hook body
 * stays a one-line dispatch.  Handler order is significant: task-output
 * nudges, JSON-error recovery, direct-work (dolphin-gated) nudges, then
 * post-task nudges.
 *
 * @param deps - The per-plugin-instance dependencies (limits, client, directory).
 * @returns The ordered handler table consumed by `runAfterHandlers`.
 */
function buildAfterHandlers(deps: AfterHandlerDeps): Array<{
  name: string;
  fn: (i: AfterExecInput, o: AfterExecOutput) => void | Promise<void>;
}> {
  return [
    {
      name: "nudgeTaskOutput",
      fn: (i: AfterExecInput, o: AfterExecOutput) =>
        nudgeTaskOutput(i, o, deps.limits),
    },
    {
      name: "recoverJsonError",
      fn: (i: AfterExecInput, o: AfterExecOutput) => recoverJsonError(i, o),
    },
    {
      name: "nudgeDirectWork",
      fn: (i: AfterExecInput, o: AfterExecOutput) =>
        nudgeDirectWorkForAgent(i, o, {
          todoClient: deps.client,
          planDir: deps.directory,
          agent: sessionAgentMap.get(i.sessionID),
        }),
    },
    {
      name: "nudgePostTask",
      fn: (i: AfterExecInput, o: AfterExecOutput) =>
        nudgePostTask(deps.client, i, o, deps.directory),
    },
  ];
}

/**
 * Inject a failed slash-command error into the session chat (silently).
 *
 * Logs the failure at warn level, then sends a `noReply` + `ignored` text
 * part so the user sees the error without triggering LLM processing.
 * Notification is best-effort — a failed `session.prompt` is swallowed.
 *
 * @param client - The OpenCode client.
 * @param sessionID - The session receiving the error message.
 * @param error - The thrown error (message text is extracted).
 * @param logHook - Logger hook module name (e.g. `"context-command"`).
 * @param logEvent - Logger event name (e.g. `"dcp_command_failed"`).
 */
async function notifySessionError(
  client: any,
  sessionID: string,
  error: unknown,
  logHook: string,
  logEvent: string,
): Promise<void> {
  const msg = error instanceof Error ? error.message : String(error);
  log(logHook, logEvent, sessionID, undefined, "warn", { error: msg });
  try {
    await client?.session?.prompt({
      path: { id: sessionID },
      body: {
        noReply: true,
        parts: [{ type: "text", text: msg, ignored: true }],
      },
    });
  } catch {
    // Best-effort notification
  }
}

// ---------------------------------------------------------------------------
// Compress / decompress tool hooks
// ---------------------------------------------------------------------------

/**
 * Build the tool-hooks map registered on the plugin.
 *
 * The range-mode compress tool is registered only when
 * `[zoo.context.compress].enabled` is explicitly `true`; the decompress
 * tool only when `[zoo.context.decompress].enabled` is explicitly `true`.
 * An absent section, an invalid section (config parse dropped it), or an
 * explicit `false` all mean the corresponding tool stays unregistered.
 * Returns `undefined` when NO tool is enabled so the `tool` hook key stays
 * absent.
 *
 * Exported for unit testing (the imported config cannot be overridden
 * per-test, so the gate is decided from the passed config here).
 *
 * @param client - The OpenCode client (captured by the factory closure).
 * @param contextConfig - The parsed context-pruning config.
 * @returns The tool-hooks map, or `undefined` when no tool is enabled.
 */
function buildToolHooks(
  client: any,
  contextConfig: ContextPruningConfig,
):
  | Record<string, CompressToolDefinition | DecompressToolDefinition>
  | undefined {
  const hooks: Record<
    string,
    CompressToolDefinition | DecompressToolDefinition
  > = {};
  if (contextConfig.compress?.enabled === true) {
    hooks.compress = createCompressTool(client, contextConfig);
  }
  if (contextConfig.decompress?.enabled === true) {
    hooks.decompress = createDecompressTool(client, contextConfig);
  }
  return Object.keys(hooks).length === 0 ? undefined : hooks;
}

/**
 * Append the compress tool to `experimental.primary_tools`.
 *
 * Preserves pre-existing entries and appends `"compress"` only when
 * `[zoo.context.compress].enabled` is explicitly `true` (same gate as
 * `buildToolHooks` — absent/invalid section or explicit `false` skip).
 *
 * Exported for unit testing.
 *
 * @param config - The config object being mutated by the `config` hook.
 * @param contextConfig - The parsed context-pruning config.
 */
function registerCompressToolInConfig(
  config: any,
  contextConfig: ContextPruningConfig,
): void {
  if (contextConfig.compress?.enabled !== true) return;
  config.experimental ??= {};
  config.experimental.primary_tools ??= [];
  if (!config.experimental.primary_tools.includes("compress")) {
    config.experimental.primary_tools.push("compress");
  }
}

/**
 * Append the decompress tool to `experimental.primary_tools`.
 *
 * Preserves pre-existing entries and appends `"decompress"` only when
 * `[zoo.context.decompress].enabled` is explicitly `true` (same gate as
 * `buildToolHooks` — absent/invalid section or explicit `false` skip).
 *
 * Exported for unit testing.
 *
 * @param config - The config object being mutated by the `config` hook.
 * @param contextConfig - The parsed context-pruning config.
 */
function registerDecompressToolInConfig(
  config: any,
  contextConfig: ContextPruningConfig,
): void {
  if (contextConfig.decompress?.enabled !== true) return;
  config.experimental ??= {};
  config.experimental.primary_tools ??= [];
  if (!config.experimental.primary_tools.includes("decompress")) {
    config.experimental.primary_tools.push("decompress");
  }
}

// ---------------------------------------------------------------------------
// Plugin entry point
// ---------------------------------------------------------------------------

/** Sentinel to short-circuit command processing after /go completes. */
const GO_HANDLED = new Error("/go command handled — no user message needed");

/**
 * @param input - OpenCode plugin input (unused).
 * @returns Plugin hooks object.
 */
export async function zookeeper(input: any) {
  const zooConfig = (config as any).zoo ?? {};
  const limits = parseLimits(zooConfig);
  const skillsConfig = parseSkillsConfig(zooConfig);
  const contextConfig = parseContextConfig(zooConfig);
  const client = input.client;
  const directory: string = (input as any).directory ?? "";

  initPluginLogger(zooConfig);

  // Register the range-mode compress tool (gated on compress.enabled).
  // When disabled, the `tool` key is absent from the hooks object.
  const toolHooks = buildToolHooks(client, contextConfig);

  // Fixed table of `tool.execute.after` handlers (per-plugin deps captured).
  const afterHandlers = buildAfterHandlers({ limits, client, directory });

  return {
    ...(toolHooks ? { tool: toolHooks } : {}),

    async config(config: any) {
      const agents = config.agent ?? {};
      logPluginInit(agents, limits, skillsConfig);
      injectAgentPrompts(agents);
      registerSkills(config, skillsConfig);
      registerCompressToolInConfig(config, contextConfig);
      registerDecompressToolInConfig(config, contextConfig);

      // Register /go slash command for plan-to-execution handoff.
      // Handoff is handled entirely in command.execute.before.
      config.command ??= {};
      config.command.go = {
        template: "",
        description: "Approve plan and handoff to dolphin",
      };

      // Register /dcp slash command for context/cache observability.
      config.command.dcp = {
        template: "",
        description: "显示上下文用量与缓存命中率",
      };
    },

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

      // Clean up on session deletion.
      if (type === "session.deleted") {
        const info = properties?.info as { id?: string } | undefined;
        if (info?.id) {
          sessionAgentMap.delete(info.id);
          subAgentCache.delete(info.id);
          clearModelLimit(info.id);
          removeSession(info.id);
          deleteSessionState(info.id);
        }
      }
    },

    async "experimental.chat.messages.transform"(
      _input: Record<string, never>,
      output: ContextMetricsOutput,
    ) {
      // ── Detect sub-agent status ──────────────────────────────
      // Sub-agent sessions (created by the `task` tool) have
      // `parentID` set on the session info.  Cache the result so we
      // don't query the session API on every transform tick.
      let isSubAgent = false;
      const sessionId = output.messages?.[0]?.info?.sessionID;
      if (sessionId) {
        const cached = subAgentCache.get(sessionId);
        if (cached !== undefined) {
          isSubAgent = cached;
        } else {
          try {
            const sessionInfo = await client.session.get({
              path: { id: sessionId },
            });
            isSubAgent = !!sessionInfo.parentID;
          } catch {
            // Could not determine — default to false.
          }
          subAgentCache.set(sessionId, isSubAgent);
        }
      }

      // Prune first so measureContext reflects post-prune token counts.
      handleContextPruning(output, contextConfig, client, isSubAgent);
      handleMessagesTransform(output);
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
      _input: {
        sessionID: string;
        messageID: string;
        partID: string;
      },
      output: { text: string },
    ) {
      // Strip zoo-msg-id tags from outbound assistant text so model
      // echoes never reach the user-visible transcript.
      const before = output.text;
      output.text = stripRefsFromString(output.text);

      // Detect fuzzy (non-canonical) tag stripping.
      // If the text changed and didn't just end with the exact
      // canonical well-formed tag, log a warning.
      if (
        before !== output.text &&
        !ZOO_MSG_ID_CANONICAL_END_REGEX.test(before)
      ) {
        log(
          "text.complete",
          "fuzzy_ref_stripped",
          _input.sessionID,
          undefined,
          "warn",
          { fragment: before.slice(-200) },
        );
      }
    },

    async "tool.definition"(
      input: { toolID: string },
      output: { description: string; parameters: any },
    ) {
      enhanceTaskDefinition(input, output);
    },

    async "tool.execute.before"(
      input: { tool: string; sessionID: string; callID: string },
      output: { args?: Record<string, unknown> },
    ) {
      validateBeforeExec(input, output, limits);
      await validateDelegationTarget(client, input, output);
    },

    async "tool.execute.after"(input: AfterExecInput, output: AfterExecOutput) {
      await runAfterHandlers(afterHandlers, input, output);
    },

    async "command.execute.before"(
      input: { command: string; sessionID: string; arguments: string },
      _output: { parts?: Array<{ type: string; text: string }> },
    ) {
      if (input.command === "dcp") {
        try {
          await handleDcpCommand(
            client,
            input.sessionID,
            input.arguments,
            contextConfig,
          );
        } catch (err) {
          await notifySessionError(
            client,
            input.sessionID,
            err,
            "context-command",
            "dcp_command_failed",
          );
        }
        throw DCP_COMMAND_HANDLED;
      }

      if (input.command !== "go") return;
      try {
        await handleGoCommand(client, input.sessionID, directory);
      } catch (err) {
        await notifySessionError(
          client,
          input.sessionID,
          err,
          "plan-lifecycle",
          "go_command_failed",
        );
        throw GO_HANDLED;
      }
      throw GO_HANDLED;
    },
  };
}

export default { id: "zookeeper", server: zookeeper };

// ---------------------------------------------------------------------------
// Test-only exports — exposed for unit testing
// ---------------------------------------------------------------------------
export {
  buildToolHooks,
  handleContextPruning,
  handleMessagesTransform,
  injectAgentPrompts,
  registerCompressToolInConfig,
  registerDecompressToolInConfig,
  registerSkills,
  runAfterHandlers,
  sessionAgentMap,
};
