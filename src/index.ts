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
import type { ContextMetricsOutput } from "./hooks/context-metrics";
import { measureContext } from "./hooks/context-metrics";
import { nudgeDirectWork } from "./hooks/direct-work-nudge";
import { recoverJsonError } from "./hooks/json-error-nudge";
import { handleGoCommand, rewritePlanPath } from "./hooks/plan-lifecycle";
import { nudgePostTask } from "./hooks/post-task-nudge";
import { validateDelegationTarget } from "./hooks/task-delegation";
import {
  enhanceTaskDefinition,
  nudgeTaskOutput,
  validateBeforeExec,
} from "./hooks/task-prompt";
import { initLogger, log, setSessionId } from "./utils/logger.js";

// ---------------------------------------------------------------------------
// Agent identity tracking — populated by message.updated event, queried by hooks
// ---------------------------------------------------------------------------

/** Maps session IDs to agent names reported by message.updated events. */
const sessionAgentMap = new Map<string, string>();

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

/** Extract word-count limits from zoo config. */
function parseLimits(zooConfig: any) {
  const v = zooConfig.validation ?? {};
  return {
    contextWordLimit: v.context_word_limit ?? 200,
    promptWordLimit: v.prompt_word_limit ?? 500,
  };
}

/** Extract skills config map from zoo config. */
function parseSkillsConfig(zooConfig: any): Record<string, string> {
  return zooConfig.skills ?? {};
}

/** Initialize file-based logger from [zoo.logging] config. */
function initPluginLogger(zooConfig: any): void {
  const logConfig = zooConfig.logging ?? {};
  initLogger("", {
    maxFileSize:
      typeof logConfig.max_file_size_mb === "number"
        ? logConfig.max_file_size_mb * 1024 * 1024
        : undefined,
    maxBackups:
      typeof logConfig.max_backups === "number"
        ? logConfig.max_backups
        : undefined,
    retentionDays:
      typeof logConfig.retention_days === "number"
        ? logConfig.retention_days
        : undefined,
  });
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
      (k) => skillsConfig[k] !== "disable",
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

/** Register enabled skills from the core/skills/ directory. */
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
      if (skillsConfig[entry] === "disable") continue;
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
  const client = input.client;
  const directory: string = (input as any).directory ?? "";

  initPluginLogger(zooConfig);

  return {
    async config(config: any) {
      const agents = config.agent ?? {};
      logPluginInit(agents, limits, skillsConfig);
      injectAgentPrompts(agents);
      registerSkills(config, skillsConfig);

      // Register /go slash command for plan-to-execution handoff.
      // Handoff is handled entirely in command.execute.before.
      config.command ??= {};
      config.command.go = {
        template: "",
        description: "Approve plan and handoff to dolphin",
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
        if (info?.id) sessionAgentMap.delete(info.id);
      }
    },

    async "experimental.chat.messages.transform"(
      _input: Record<string, never>,
      output: ContextMetricsOutput,
    ) {
      handleMessagesTransform(output);
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
      rewritePlanPath(input.tool, output.args, input.sessionID);
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
            return nudgeDirectWork(i, o, { todoClient: client });
          },
        },
        {
          name: "nudgePostTask",
          fn: (i: AfterExecInput, o: AfterExecOutput) =>
            nudgePostTask(client, i, o),
        },
      ];
      await runAfterHandlers(handlers, input, output);
    },

    async "command.execute.before"(
      input: { command: string; sessionID: string; arguments: string },
      _output: { parts?: Array<{ type: string; text: string }> },
    ) {
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
  handleMessagesTransform,
  injectAgentPrompts,
  parseLimits,
  parseSkillsConfig,
  registerSkills,
  runAfterHandlers,
};
