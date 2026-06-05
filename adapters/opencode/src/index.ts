/**
 * ZooKeeper — OpenCode plugin entry point.
 * Tool deny-listing + prompt injection via a single `config` hook.
 *
 * TODO: Add Claude Code adapter (PreToolUse Python hook + CLAUDE.md).
 * TODO: Add hook-based deny for runtime interception.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BLOCKED } from "./blocked-tools";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CORE_DIR = resolve(__dirname, "../../../core");

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

/**
 * @param input - OpenCode plugin input (unused in current implementation).
 * @returns Plugin hooks object.
 */
export default async function zookeeper(input: any) {
  return {
    async config(config: any) {
      const agents = config.agent ?? {};
      for (const [name, agent] of Object.entries(agents)) {
        if (typeof agent !== "object" || agent === null) continue;

        const prompt = loadPrompt(name);
        if (prompt) (agent as any).prompt = prompt;

        // Deny listed tools so the LLM cannot see or invoke them
        const blocked = BLOCKED[name] ?? [];
        if (blocked.length > 0) {
          const permission = { ...((agent as any).permission ?? {}) };
          for (const tool of blocked) {
            permission[tool] = "deny";
          }
          (agent as any).permission = permission;
        }
      }
    },
  };
}
