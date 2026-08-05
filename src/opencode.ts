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
import { clearModelLimit, setModelLimit } from "./core/model-limits.js";
import {
  stripRefsFromString,
  ZOO_MSG_ID_CANONICAL_END_REGEX,
} from "./core/pruning/index.js";
import { deleteSessionState, removeSession } from "./core/pruning/marks.js";
import { NUDGE_PERCENT_RE } from "./core/pruning/nudge.js";
import { DCP_COMMAND_HANDLED, handleDcpCommand } from "./hooks/context-command";
import type { ContextMetricsOutput } from "./hooks/context-metrics";
import { measureContext } from "./hooks/context-metrics";
import { contextPruningTransformHandler } from "./hooks/context-pruning";
import type {
  CompressConfig,
  ContextNudgeConfig,
  ContextPruningConfig,
  DecompressConfig,
} from "./hooks/context-pruning/index.js";
import { nudgeDirectWork } from "./hooks/direct-work-nudge";
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
import { initLogger, log, setSessionId } from "./utils/logger.js";

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
// Config helpers
// ---------------------------------------------------------------------------

/** Extract word-count limits from zoo config.
 *
 *  Each field is type-checked: only finite numbers greater than zero are
 *  accepted.  Missing or invalid values produce `undefined` (no fallback),
 *  and invalid values emit a warning log.
 */
function parseLimits(zooConfig: any) {
  const v = zooConfig.validation ?? {};

  const ctxRaw = v.context_word_limit;
  let contextWordLimit: number | undefined;
  if (typeof ctxRaw === "number" && Number.isFinite(ctxRaw) && ctxRaw > 0) {
    contextWordLimit = ctxRaw;
  } else if (ctxRaw !== undefined) {
    log("config", "invalid_context_word_limit", "", undefined, "warn", {
      key: "context_word_limit",
      value: ctxRaw,
    });
  }

  const promptRaw = v.prompt_word_limit;
  let promptWordLimit: number | undefined;
  if (
    typeof promptRaw === "number" &&
    Number.isFinite(promptRaw) &&
    promptRaw > 0
  ) {
    promptWordLimit = promptRaw;
  } else if (promptRaw !== undefined) {
    log("config", "invalid_prompt_word_limit", "", undefined, "warn", {
      key: "prompt_word_limit",
      value: promptRaw,
    });
  }

  return { contextWordLimit, promptWordLimit };
}

/** Extract skills config map from zoo config. */
function parseSkillsConfig(zooConfig: any): Record<string, string> {
  return zooConfig.skills ?? {};
}

/**
 * Accept a nudge threshold value: a positive finite number (absolute
 * tokens) or a non-zero percentage string (`"NN%"`).  Zero, negative,
 * and malformed values are rejected — thresholds have no "disable"
 * meaning (enabled=false covers that).
 *
 * @param v - The raw config value.
 * @returns `true` when the value is a valid threshold.
 */
function isValidNudgeThreshold(v: unknown): boolean {
  if (typeof v === "number") return Number.isFinite(v) && v > 0;
  if (typeof v === "string") {
    const match = NUDGE_PERCENT_RE.exec(v);
    return match !== null && Number(match[1]) > 0;
  }
  return false;
}

/** Extract context-pruning config from the [zoo.context] section.
 *
 *  `protected_messages` and `released_percent` are shared across
 *  pruning strategies (read from `[zoo.context]` top-level).  `dedup.*`
 *  and `purge_errors.*` are per-strategy gates read from their
 *  respective sub-sections.
 *
 *  Unknown keys are silently ignored.
 *
 *  Each field is type-checked: unrecognised / wrong-type values produce
 *  `undefined` (no fallback — "fail to skip"), and invalid values emit
 *  a warning log.  Missing fields produce `undefined` silently.
 */
function parseContextConfig(zooConfig: any): ContextPruningConfig {
  const c = zooConfig.context ?? {};
  const d = c.dedup ?? {};
  const pe = c.purge_errors ?? {};

  let enabled: boolean | undefined;
  if (typeof c.enabled === "boolean") {
    enabled = c.enabled;
  } else if (c.enabled !== undefined) {
    log("config", "invalid_context_pruning_enabled", "", undefined, "warn", {
      key: "enabled",
      value: c.enabled,
    });
  }

  let protectedMessages: number | undefined;
  if (
    typeof c.protected_messages === "number" &&
    Number.isFinite(c.protected_messages) &&
    c.protected_messages >= 0
  ) {
    protectedMessages = c.protected_messages;
  } else if (c.protected_messages !== undefined) {
    log("config", "invalid_protected_messages", "", undefined, "warn", {
      key: "protected_messages",
      value: c.protected_messages,
    });
  }

  let releasedPercent: number | undefined;
  if (
    typeof c.released_percent === "number" &&
    Number.isFinite(c.released_percent) &&
    c.released_percent >= 0 &&
    c.released_percent <= 100
  ) {
    releasedPercent = c.released_percent;
  } else if (c.released_percent !== undefined) {
    log("config", "invalid_released_percent", "", undefined, "warn", {
      key: "released_percent",
      value: c.released_percent,
    });
  }

  let dedupEnabled: boolean | undefined;
  if (typeof d.enabled === "boolean") {
    dedupEnabled = d.enabled;
  } else if (d.enabled !== undefined) {
    log("config", "invalid_dedup_enabled", "", undefined, "warn", {
      key: "dedup.enabled",
      value: d.enabled,
    });
  }

  let dedupThresholdContext: number | undefined;
  if (
    typeof d.threshold_context === "number" &&
    Number.isFinite(d.threshold_context) &&
    d.threshold_context > 0
  ) {
    dedupThresholdContext = d.threshold_context;
  } else if (d.threshold_context !== undefined) {
    log("config", "invalid_dedup_threshold_context", "", undefined, "warn", {
      key: "dedup.threshold_context",
      value: d.threshold_context,
    });
  }

  let dedupProtectedTools: string[] | undefined;
  if (
    Array.isArray(d.protected_tools) &&
    d.protected_tools.every((t: unknown) => typeof t === "string")
  ) {
    dedupProtectedTools = d.protected_tools;
  } else if (d.protected_tools !== undefined) {
    log("config", "invalid_dedup_protected_tools", "", undefined, "warn", {
      key: "dedup.protected_tools",
      value: d.protected_tools,
    });
  }

  let peEnabled: boolean | undefined;
  if (typeof pe.enabled === "boolean") {
    peEnabled = pe.enabled;
  } else if (pe.enabled !== undefined) {
    log("config", "invalid_purge_errors_enabled", "", undefined, "warn", {
      key: "purge_errors.enabled",
      value: pe.enabled,
    });
  }

  let peThresholdContext: number | undefined;
  if (
    typeof pe.threshold_context === "number" &&
    Number.isFinite(pe.threshold_context) &&
    pe.threshold_context > 0
  ) {
    peThresholdContext = pe.threshold_context;
  } else if (pe.threshold_context !== undefined) {
    log(
      "config",
      "invalid_purge_errors_threshold_context",
      "",
      undefined,
      "warn",
      {
        key: "purge_errors.threshold_context",
        value: pe.threshold_context,
      },
    );
  }

  let peProtectedTools: string[] | undefined;
  if (
    Array.isArray(pe.protected_tools) &&
    pe.protected_tools.every((t: unknown) => typeof t === "string")
  ) {
    peProtectedTools = pe.protected_tools;
  } else if (pe.protected_tools !== undefined) {
    log(
      "config",
      "invalid_purge_errors_protected_tools",
      "",
      undefined,
      "warn",
      {
        key: "purge_errors.protected_tools",
        value: pe.protected_tools,
      },
    );
  }

  // ── Parse nudge section ──────────────────────────────────────────
  // All six keys are required when the section is present.  Any missing,
  // wrong-typed, or malformed value invalidates the WHOLE section
  // (fail to skip — the subsystem is silently absent) and logs exactly
  // one warn.  `enabled: false` is valid — present but disabled.
  let nudge: ContextNudgeConfig | undefined;
  if (c.nudge !== undefined) {
    const n = c.nudge as Record<string, unknown>;
    const keyChecks: Array<[string, unknown, (v: unknown) => boolean]> = [
      ["enabled", n.enabled, (v) => typeof v === "boolean"],
      ["min_context", n.min_context, isValidNudgeThreshold],
      [
        "min_context_cap",
        n.min_context_cap,
        (v) => typeof v === "number" && Number.isFinite(v) && v >= 0,
      ],
      ["max_context", n.max_context, isValidNudgeThreshold],
      [
        "max_context_cap",
        n.max_context_cap,
        (v) => typeof v === "number" && Number.isFinite(v) && v >= 0,
      ],
      ["growth_tokens", n.growth_tokens, isValidNudgeThreshold],
    ];
    const bad = keyChecks.find(([, value, check]) => !check(value));
    if (bad) {
      log("config", "nudge_config_invalid", "", undefined, "warn", {
        key: bad[0],
        value: bad[1],
      });
    } else {
      nudge = {
        enabled: n.enabled as boolean,
        minContext: n.min_context as number | string,
        minContextCap: n.min_context_cap as number,
        maxContext: n.max_context as number | string,
        maxContextCap: n.max_context_cap as number,
        growthTokens: n.growth_tokens as number | string,
      };
    }
  }

  // ── Parse compress section ──────────────────────────────────────
  // All three keys are required when the section is present.  Any missing,
  // wrong-typed, or malformed value invalidates the WHOLE section
  // (fail to skip — the subsystem is silently absent) and logs exactly
  // one warn.  `enabled: false` is valid — present but disabled.
  let compress: CompressConfig | undefined;
  if (c.compress !== undefined) {
    const cm = c.compress as Record<string, unknown>;
    const keyChecks: Array<[string, unknown, (v: unknown) => boolean]> = [
      ["enabled", cm.enabled, (v) => typeof v === "boolean"],
      [
        "threshold_tokens",
        cm.threshold_tokens,
        (v) => typeof v === "number" && Number.isFinite(v) && v >= 0,
      ],
      [
        "protected_tokens",
        cm.protected_tokens,
        (v) => typeof v === "number" && Number.isFinite(v) && v >= 0,
      ],
    ];
    const bad = keyChecks.find(([, value, check]) => !check(value));
    if (bad) {
      log("config", "compress_config_invalid", "", undefined, "warn", {
        key: bad[0],
        value: bad[1],
      });
    } else {
      compress = {
        enabled: cm.enabled as boolean,
        thresholdTokens: cm.threshold_tokens as number,
        protectedTokens: cm.protected_tokens as number,
      };
    }
  }

  // ── Parse decompress section ────────────────────────────────────
  // Both keys are required when the section is present.  Any missing,
  // wrong-typed, or out-of-range value invalidates the WHOLE section
  // (fail to skip — the subsystem is silently absent) and logs exactly
  // one warn.  `enabled: false` is valid — present but disabled.
  let decompress: DecompressConfig | undefined;
  if (c.decompress !== undefined) {
    const dm = c.decompress as Record<string, unknown>;
    const keyChecks: Array<[string, unknown, (v: unknown) => boolean]> = [
      ["enabled", dm.enabled, (v) => typeof v === "boolean"],
      [
        "reject_percent",
        dm.reject_percent,
        (v) =>
          typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 100,
      ],
    ];
    const bad = keyChecks.find(([, value, check]) => !check(value));
    if (bad) {
      log("config", "decompress_config_invalid", "", undefined, "warn", {
        key: bad[0],
        value: bad[1],
      });
    } else {
      decompress = {
        enabled: dm.enabled as boolean,
        rejectPercent: dm.reject_percent as number,
      };
    }
  }

  return {
    enabled,
    protectedMessages,
    releasedPercent,
    nudge,
    dedup: {
      enabled: dedupEnabled,
      thresholdContext: dedupThresholdContext,
      protectedTools: dedupProtectedTools,
    },
    purgeErrors: {
      enabled: peEnabled,
      thresholdContext: peThresholdContext,
      protectedTools: peProtectedTools,
    },
    compress,
    decompress,
  };
}

/** Initialize file-based logger from [zoo.logging] config.
 *
 *  Each field is type-checked and range-checked:
 *   - `max_file_size_mb`: must be > 0 (file-rotation threshold).
 *   - `max_backups`: must be >= 0 (0 disables backups; negative is invalid).
 *   - `retention_days`: must be > 0 (negative would delete all logs).
 *
 *  Values that fail the check produce `undefined` (no fallback) and emit a
 *  warning log with the same pattern as `parseLimits`.
 */
function initPluginLogger(zooConfig: any): void {
  const logConfig = zooConfig.logging ?? {};

  const maxSizeRaw = logConfig.max_file_size_mb;
  let maxFileSize: number | undefined;
  if (
    typeof maxSizeRaw === "number" &&
    Number.isFinite(maxSizeRaw) &&
    maxSizeRaw > 0
  ) {
    maxFileSize = maxSizeRaw * 1024 * 1024;
  } else if (maxSizeRaw !== undefined) {
    log("config", "invalid_max_file_size_mb", "", undefined, "warn", {
      key: "max_file_size_mb",
      value: maxSizeRaw,
    });
  }

  const maxBackupsRaw = logConfig.max_backups;
  let maxBackups: number | undefined;
  if (
    typeof maxBackupsRaw === "number" &&
    Number.isFinite(maxBackupsRaw) &&
    maxBackupsRaw >= 0
  ) {
    maxBackups = maxBackupsRaw;
  } else if (maxBackupsRaw !== undefined) {
    log("config", "invalid_max_backups", "", undefined, "warn", {
      key: "max_backups",
      value: maxBackupsRaw,
    });
  }

  const retentionDaysRaw = logConfig.retention_days;
  let retentionDays: number | undefined;
  if (
    typeof retentionDaysRaw === "number" &&
    Number.isFinite(retentionDaysRaw) &&
    retentionDaysRaw > 0
  ) {
    retentionDays = retentionDaysRaw;
  } else if (retentionDaysRaw !== undefined) {
    log("config", "invalid_retention_days", "", undefined, "warn", {
      key: "retention_days",
      value: retentionDaysRaw,
    });
  }

  initLogger("", { maxFileSize, maxBackups, retentionDays });
}

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
      const handlers = [
        {
          name: "nudgeTaskOutput",
          fn: (i: AfterExecInput, o: AfterExecOutput) =>
            nudgeTaskOutput(i, o, limits),
        },
        {
          name: "recoverJsonError",
          fn: (i: AfterExecInput, o: AfterExecOutput) => recoverJsonError(i, o),
        },
        {
          name: "nudgeDirectWork",
          fn: (i: AfterExecInput, o: AfterExecOutput) => {
            if (sessionAgentMap.get(i.sessionID) !== "dolphin") {
              log(
                "direct-work-nudge",
                "nudge_skipped",
                i.sessionID,
                i.callID,
                "debug",
                { tool: i.tool, reason: "not_dolphin" },
              );
              return;
            }
            return nudgeDirectWork(i, o, {
              todoClient: client,
              planDir: directory,
            });
          },
        },
        {
          name: "nudgePostTask",
          fn: (i: AfterExecInput, o: AfterExecOutput) =>
            nudgePostTask(client, i, o, directory),
        },
      ];
      await runAfterHandlers(handlers, input, output);
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
          // Inject error message silently — no LLM processing.
          const msg = err instanceof Error ? err.message : String(err);
          log(
            "context-command",
            "dcp_command_failed",
            input.sessionID,
            undefined,
            "warn",
            { error: msg },
          );
          try {
            await client?.session?.prompt({
              path: { id: input.sessionID },
              body: {
                noReply: true,
                parts: [{ type: "text", text: msg, ignored: true }],
              },
            });
          } catch {
            // Best-effort notification
          }
        }
        throw DCP_COMMAND_HANDLED;
      }

      if (input.command !== "go") return;
      try {
        await handleGoCommand(client, input.sessionID, directory);
      } catch (err) {
        // Inject error message silently — no LLM processing.
        const msg = err instanceof Error ? err.message : String(err);
        log(
          "plan-lifecycle",
          "go_command_failed",
          input.sessionID,
          undefined,
          "warn",
          { error: msg },
        );
        try {
          await client?.session?.prompt({
            path: { id: input.sessionID },
            body: {
              noReply: true,
              parts: [{ type: "text", text: msg, ignored: true }],
            },
          });
        } catch {
          // Best-effort notification
        }
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
  initPluginLogger,
  injectAgentPrompts,
  parseContextConfig,
  parseLimits,
  parseSkillsConfig,
  registerCompressToolInConfig,
  registerDecompressToolInConfig,
  registerSkills,
  runAfterHandlers,
  sessionAgentMap,
};
