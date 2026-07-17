/**
 * ZooKeeper Pi extension — injects orchestrator prompt + skills into pi.
 *
 * This extension registers two hooks:
 * 1. `before_agent_start` — prepends DOLPHIN_PROMPT (orchestrator identity)
 *    to the chainable system prompt, preserving pi's native tool descriptions.
 * 2. `resources_discover` — contributes all ZooKeeper skill directories
 *    from core/skills/ so pi can load them via loadSkillsFromDir.
 *
 * @module
 */

import { readdirSync, realpathSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DOLPHIN_PROMPT } from "./agents/dolphin.js";

// ---------------------------------------------------------------------------
// Local minimal interface — duck-type compatible with pi's ExtensionAPI.
// No external dependency on @earendil-works/pi-coding-agent.
// ---------------------------------------------------------------------------

/**
 * Minimal structural type for pi's ExtensionAPI.
 *
 * Only defines the `on` method with overloaded event signatures that
 * ZooKeeper uses.  pi passes its real ExtensionAPI object at runtime.
 */
interface ExtensionAPI {
  /** Register handler for `before_agent_start`. */
  on(
    event: "before_agent_start",
    handler: (
      evt: { systemPrompt: string },
      ctx: unknown,
    ) => { systemPrompt: string } | Promise<{ systemPrompt: string }>,
  ): void;
  /** Register handler for `resources_discover`. */
  on(
    event: "resources_discover",
    handler: (
      evt: unknown,
      _ctx: unknown,
    ) => { skillPaths: string[] } | Promise<{ skillPaths: string[] }>,
  ): void;
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

// realpathSync follows the symlink to the real src/pi.ts location,
// ensuring ../core/skills resolves to the project directory even
// when loaded via pi's auto-discovery symlink.
const __dirname = dirname(realpathSync(fileURLToPath(import.meta.url)));

/**
 * Collect all skill directory paths from core/skills/.
 *
 * pi's `loadSkillsFromDir` discovers a skill when a directory contains
 * SKILL.md.  ZooKeeper's layout (core/skills/<name>/SKILL.md) is directly
 * compatible — we enumerate every subdirectory and return its absolute path.
 *
 * @returns Absolute paths of all skill directories under core/skills/.
 */
function collectSkillPaths(): string[] {
  const skillsDir = resolve(__dirname, "../core/skills");
  const paths: string[] = [];
  try {
    for (const entry of readdirSync(skillsDir)) {
      const fullPath = resolve(skillsDir, entry);
      if (statSync(fullPath).isDirectory()) {
        paths.push(fullPath);
      }
    }
  } catch {
    // skillsDir does not exist — return empty array
  }
  return paths;
}

/**
 * Register ZooKeeper hooks with pi.
 *
 * Strategy for `before_agent_start`:
 *   **Prepend** DOLPHIN_PROMPT rather than replacing the chainable system
 *   prompt.  This keeps the orchestrator identity dominant while preserving
 *   pi's native coding-assistant prompt and tool descriptions.  Replacing
 *   outright would lose pi's tool-injection and built-in instructions.
 *
 * @param pi - pi ExtensionAPI instance (provided at runtime by pi).
 */
export default function zookeeperPi(pi: ExtensionAPI): void {
  pi.on("before_agent_start", async (evt, _ctx) => {
    return {
      systemPrompt: DOLPHIN_PROMPT + "\n\n" + evt.systemPrompt,
    };
  });

  pi.on("resources_discover", async (_evt, _ctx) => {
    return {
      skillPaths: collectSkillPaths(),
    };
  });
}
