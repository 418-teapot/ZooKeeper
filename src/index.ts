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
 * TODO: Add Claude Code adapter (PreToolUse Python hook + CLAUDE.md).
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import config from "../config.toml" with { type: "toml" };
import { nudgeDirectWork } from "./hooks/direct-work-nudge";
import { injectFocusReminder } from "./hooks/focus-reminder";
import { recoverJsonError } from "./hooks/json-error-nudge";
import { nudgePostTask } from "./hooks/post-task-nudge";
import {
  enhanceTaskDefinition,
  loadValidationConfig,
  nudgeTaskOutput,
  validateBeforeExec,
} from "./hooks/task-prompt";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CORE_DIR = resolve(__dirname, "../core");

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
  const limits = loadValidationConfig();
  const skillsConfig: Record<string, string> =
    (config as any).zoo?.skills ?? {};
  const client = input.client;

  return {
    async config(config: any) {
      const agents = config.agent ?? {};
      for (const [name, agent] of Object.entries(agents)) {
        if (typeof agent !== "object" || agent === null) continue;

        const prompt = loadPrompt(name);
        if (prompt) (agent as any).prompt = prompt;
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
        }
      } catch {
        // skills/ directory does not exist or is inaccessible — skip.
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
        await injectFocusReminder(client, output);
      } catch {
        // Swallow errors so a reminder failure never disrupts the LLM turn.
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
      const handlers = [
        (i: typeof input, o: typeof output) => nudgeTaskOutput(i, o, limits),
        recoverJsonError,
        (i: typeof input, o: typeof output) => nudgeDirectWork(client, i, o),
        (i: typeof input, o: typeof output) => nudgePostTask(client, i, o),
      ] as const;
      for (const handler of handlers) {
        try {
          await handler(input, output);
        } catch {
          // Swallow per-handler errors so one failure does not
          // prevent other handlers from running.
        }
      }
    },
  };
}

export default { id: "zookeeper", server: zookeeper };
