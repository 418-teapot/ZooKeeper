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
 * This module is a thin wiring layer — all hook implementation lives in
 * `src/hooks/` submodules.
 *
 * TODO: Add pi / oh-my-pi adapter (framework adapter).
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import config from "../config.toml" with { type: "toml" };
import { measureContext } from "./hooks/context-metrics";
import { nudgeDirectWork } from "./hooks/direct-work-nudge";
import { recoverJsonError } from "./hooks/json-error-nudge";
import { nudgePostTask } from "./hooks/post-task-nudge";
import {
  enhanceTaskDefinition,
  nudgeTaskOutput,
  validateBeforeExec,
} from "./hooks/task-prompt";
import { initLogger, log, setSessionId } from "./utils/logger.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CORE_DIR = resolve(__dirname, "../core");

let _sessionIdSet = false;

// ---------------------------------------------------------------------------
// Prompt loading
// ---------------------------------------------------------------------------

/**
 * @param name - Agent name to locate `prompts/{name}.md`.
 * @returns Prompt content, or `undefined` if no file exists.
 */
function loadPrompt(name: string): string | undefined {
  try {
    return readFileSync(resolve(CORE_DIR, `prompts/${name}.md`), "utf-8");
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Plugin entry point
// ---------------------------------------------------------------------------

/**
 * @param input - OpenCode plugin input (unused).
 * @returns Plugin hooks object.
 */
export async function zookeeper(input: any) {
  const zooConfig = (config as any).zoo ?? {};
  const limits = {
    contextWordLimit: zooConfig.validation?.context_word_limit ?? 200,
    promptWordLimit: zooConfig.validation?.prompt_word_limit ?? 500,
  };
  const skillsConfig: Record<string, string> = zooConfig.skills ?? {};
  const client = input.client;

  // Initialize file-based logging from [zoo.logging] config.
  {
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

  return {
    async config(config: any) {
      const agents = config.agent ?? {};

      log("plugin", "plugin_init", "", undefined, "info", {
        agents: Object.keys(agents),
        limits,
        skills: Object.keys(skillsConfig).filter(
          (k) => skillsConfig[k] !== "disable",
        ),
      });

      for (const [name, agent] of Object.entries(agents)) {
        if (typeof agent !== "object" || agent === null) continue;

        const prompt = loadPrompt(name);
        if (prompt) {
          (agent as any).prompt = prompt;
          log("plugin", "agent_loaded", "", undefined, "debug", {
            agent: name,
            prompt_len: prompt.length,
          });
        }
      }

      // Register each skill in core/skills/ individually, skipping disabled ones.
      config.skills ??= {};
      config.skills.paths ??= [];
      const skillsDir = resolve(CORE_DIR, "skills");
      try {
        for (const entry of readdirSync(skillsDir)) {
          const skillPath = resolve(skillsDir, entry);
          if (!statSync(skillPath).isDirectory()) continue;
          if (skillsConfig[entry] === "disable") continue;
          config.skills.paths.push(skillPath);
          log("plugin", "skill_registered", "", undefined, "debug", {
            skill: entry,
          });
        }
      } catch {
        // skills/ directory does not exist or is inaccessible — skip.
      }
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

    async "experimental.chat.messages.transform"(
      _input: Record<string, never>,
      output: {
        messages?: Array<{
          info: {
            role: string;
            id: string;
            sessionID?: string;
            agent?: string;
          };
          parts: Array<{ type: "text"; text: string }>;
        }>;
      },
    ) {
      try {
        measureContext(output);
      } catch (err) {
        log(
          "plugin",
          "handler_crashed",
          output.messages?.[0]?.info?.sessionID ?? "",
          undefined,
          "error",
          {
            handler: "measureContext",
            error: String(err),
          },
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
    },

    async "tool.execute.after"(
      input: {
        tool: string;
        sessionID: string;
        callID: string;
        args?: Record<string, unknown>;
      },
      output: { output?: string },
    ) {
      const handlers: Array<{
        name: string;
        fn: (i: typeof input, o: typeof output) => void | Promise<void>;
      }> = [
        {
          name: "nudgeTaskOutput",
          fn: (i, o) => nudgeTaskOutput(i, o, limits),
        },
        {
          name: "recoverJsonError",
          fn: (i, o) => {
            recoverJsonError(i, o);
          },
        },
        {
          name: "nudgeDirectWork",
          fn: (i, o) => nudgeDirectWork(client, i, o),
        },
        { name: "nudgePostTask", fn: (i, o) => nudgePostTask(client, i, o) },
      ];
      for (const { name, fn } of handlers) {
        try {
          await fn(input, output);
        } catch (err) {
          log(
            "plugin",
            "handler_crashed",
            input.sessionID,
            input.callID,
            "error",
            { handler: name, error: String(err) },
          );
        }
      }
    },
  };
}

export default { id: "zookeeper", server: zookeeper };
