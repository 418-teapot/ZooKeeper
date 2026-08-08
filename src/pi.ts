/**
 * ZooKeeper Pi extension — profile-driven prompt injection + skills.
 *
 * This extension registers two hooks, both driven by the active mode
 * profile (`[zoo.mode.<name>]`, parsed by `parseModeProfile`):
 * 1. `before_agent_start` — prepends the dolphin orchestrator prompt to
 *    the chainable system prompt, but only when the profile's agents
 *    list names `dolphin`.
 * 2. `resources_discover` — contributes the profile-listed skill
 *    directories from core/skills/ so pi can load them via
 *    loadSkillsFromDir; an empty profile skills list contributes none.
 *
 * Profile selection reuses the host-agnostic composition engine:
 * `composeProfile` (in `src/core/compose.ts`) is fed the registry
 * (`src/registry.ts`) filtered to the agent and skill units —
 * the only two slot kinds pi consumes — together with a narrowed
 * profile carrying only the agents/skills lists (the hooks/tools/
 * commands categories are emptied; pi never declares them).  When the
 * profile is `null` (absent or invalid) both contributions are skipped
 * — no defaults, no fallback to a full load.
 *
 * Config loading: the OpenCode entry imports config.toml directly with
 * Bun's `import ... with { type: "toml" }`.  pi's extension runtime is
 * Node.js + jiti (verified against pi 0.83.0: Node 24.18.1 and jiti
 * 2.7.0 reject `.toml` imports — `ERR_UNKNOWN_FILE_EXTENSION`), so pi
 * reads config.toml with `readFileSync` and parses it with the vendored
 * smol-toml 1.7.1 parser (`vendor/smol-toml/index.ts`) — an equivalent
 * mechanism that extracts the same `zoo` section object.
 *
 * @module
 */

import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "../vendor/smol-toml/index.js";
import { composeProfile } from "./core/compose.js";
import {
  parseContextConfig,
  parseLimits,
  parseModeProfile,
} from "./core/config-parse.js";
import type { ModeProfile } from "./core/config-types.js";
import type { ComposedResult, Deps, UnitDescriptor } from "./core/slots.js";
import { REGISTRY } from "./registry.js";

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
// Config loading
// ---------------------------------------------------------------------------

// realpathSync follows the symlink to the real src/pi.ts location,
// ensuring ../config.toml and ../core/skills resolve to the project
// directory even when loaded via pi's auto-discovery symlink.
const __dirname = dirname(realpathSync(fileURLToPath(import.meta.url)));

/** The project config.toml (sibling of src/). */
const CONFIG_PATH = resolve(__dirname, "../config.toml");

/**
 * Load the `zoo` section of config.toml.
 *
 * pi's Node/jiti runtime cannot import TOML (see module doc), so the
 * file is read and parsed with the vendored smol-toml `parse` parser.
 * A missing or unreadable file yields an empty zoo section, which every
 * profile-driven contribution skips (null profile).
 *
 * @returns The `zoo` section object (empty when absent/unreadable).
 */
function loadZooConfig(): any {
  try {
    const text = readFileSync(CONFIG_PATH, "utf-8");
    return parse(text).zoo ?? {};
  } catch {
    // config.toml missing or unreadable — behave as an absent section.
    return {};
  }
}

// ---------------------------------------------------------------------------
// Profile-driven composition
// ---------------------------------------------------------------------------

/**
 * Compose the profile-driven agent/skill contributions for pi.
 *
 * Only the agent and skill units are composed — pi consumes exactly
 * those two slot kinds (`before_agent_start` prompt injection and
 * `resources_discover` skill paths).  The profile handed to the engine
 * is narrowed to the agents/skills lists (other categories emptied), so
 * the hooks/tools/commands names never reach the `unknown_unit` warning
 * path.  Fields of `Deps` that pi does not use are kept minimal:
 * `client` is an empty object and `sessionAgentMap` a fresh map.
 *
 * Exported for unit testing — `zookeeperPi` wires this with the config
 * loaded from disk.
 *
 * @param zooConfig - The `zoo` section of config.toml.
 * @returns The parsed profile (or `null`) and the composed result.
 */
export function buildPiContributions(zooConfig: any): {
  profile: ModeProfile | null;
  composed: ComposedResult;
} {
  const limits = parseLimits(zooConfig);
  const contextConfig = parseContextConfig(zooConfig);
  const modeProfile = parseModeProfile(zooConfig);

  const deps: Deps = {
    limits,
    contextConfig,
    client: {},
    directory: "",
    sessionAgentMap: new Map(),
  };
  const units: UnitDescriptor[] = REGISTRY.filter(
    (unit) => unit.kind === "agent" || unit.kind === "skill",
  );
  // pi consumes only the agent/skill slot kinds, so narrow the profile
  // to those two lists — the other category names would otherwise
  // trigger spurious `unknown_unit` warnings in composeProfile.
  const narrowedProfile: ModeProfile | null =
    modeProfile === null
      ? null
      : {
          name: modeProfile.name,
          agents: modeProfile.agents,
          skills: modeProfile.skills,
          hooks: [],
          tools: [],
          commands: [],
        };
  const composed = composeProfile(narrowedProfile, units, deps);

  return { profile: modeProfile, composed };
}

// ---------------------------------------------------------------------------
// Skill discovery
// ---------------------------------------------------------------------------

/**
 * Collect the absolute paths of the profile-listed skill directories.
 *
 * pi's `loadSkillsFromDir` discovers a skill when a directory contains
 * SKILL.md.  A skill registers only when its directory name appears in
 * `profileSkills` AND the directory actually exists under core/skills/
 * (mirroring the OpenCode adapter's fail-closed `registerSkills`).
 *
 * @param profileSkills - Skill directory names declared by the profile.
 * @returns Absolute paths of the existing, profile-listed directories.
 */
export function collectSkillPaths(profileSkills: string[]): string[] {
  const skillsDir = resolve(__dirname, "../core/skills");
  const paths: string[] = [];
  try {
    for (const entry of readdirSync(skillsDir)) {
      if (!profileSkills.includes(entry)) continue;
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

// ---------------------------------------------------------------------------
// Handler factory
// ---------------------------------------------------------------------------

/**
 * Build the pi hook handlers from an explicit zoo config.
 *
 * `before_agent_start` prepends the composed dolphin prompt when the
 * profile's agents list names `dolphin`; otherwise the system prompt is
 * returned untouched.  `resources_discover` returns the profile-listed
 * skill paths, an empty array when the profile has none.
 *
 * Exported for unit testing — `zookeeperPi` wires this with the config
 * loaded from disk.
 *
 * @param zooConfig - The `zoo` section of config.toml.
 * @returns The two hook handlers.
 */
export function buildPiHandlers(zooConfig: any): {
  beforeAgentStart: (evt: {
    systemPrompt: string;
  }) => Promise<{ systemPrompt: string }>;
  resourcesDiscover: () => Promise<{ skillPaths: string[] }>;
} {
  const { composed } = buildPiContributions(zooConfig);

  const dolphinPrompt = composed.agents.find(
    (agent) => agent.name === "dolphin",
  )?.prompt;
  const profileSkills = composed.skills.map((skill) => skill.name);

  return {
    async beforeAgentStart(evt) {
      return {
        systemPrompt:
          dolphinPrompt === undefined
            ? evt.systemPrompt
            : `${dolphinPrompt}\n\n${evt.systemPrompt}`,
      };
    },
    async resourcesDiscover() {
      return { skillPaths: collectSkillPaths(profileSkills) };
    },
  };
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

/**
 * Register ZooKeeper hooks with pi.
 *
 * Strategy for `before_agent_start`:
 *   **Prepend** the dolphin prompt rather than replacing the chainable
 *   system prompt.  This keeps the orchestrator identity dominant while
 *   preserving pi's native coding-assistant prompt and tool
 *   descriptions.  Replacing outright would lose pi's tool-injection
 *   and built-in instructions.
 *
 * Both hooks are profile-driven: a `null` profile (absent or invalid)
 * skips prompt injection and skill contribution entirely.
 *
 * @param pi - pi ExtensionAPI instance (provided at runtime by pi).
 */
export function zookeeperPi(pi: ExtensionAPI): void {
  const handlers = buildPiHandlers(loadZooConfig());
  pi.on("before_agent_start", handlers.beforeAgentStart);
  pi.on("resources_discover", handlers.resourcesDiscover);
}

export default zookeeperPi;
