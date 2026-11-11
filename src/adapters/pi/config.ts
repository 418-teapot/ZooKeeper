/**
 * Pi host adapter — config.toml loading.
 *
 * The OpenCode entry imports config.toml directly with Bun's
 * `import ... with { type: "toml" }`.  pi's extension runtime is Node.js +
 * jiti (verified against pi 0.83.0: Node 24.18.1 and jiti 2.7.0 reject
 * `.toml` imports — `ERR_UNKNOWN_FILE_EXTENSION`), so pi reads config.toml
 * with `readFileSync` and parses it with the vendored smol-toml 1.7.1
 * parser — an equivalent mechanism that extracts the same `zoo` section
 * object.  config.toml stays the single source of truth: a missing or
 * unreadable file yields an empty root that every profile-driven
 * contribution skips (fail-closed), never a built-in default.
 *
 * The module also builds the pi configuration generation: `loadConfig`
 * reads the file, the entry point loads the model map, and `createPiScope`
 * parses both into the one immutable snapshot every instance of that
 * generation reads.
 *
 * @module
 */

import { readFileSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "../../../vendor/smol-toml/index.js";
import {
  parseAgentColors,
  parseAskConfig,
  parseCommonConfig,
} from "../../core/config-parse.js";
import {
  type ConfigSnapshot,
  createProcessScope,
  type ProcessScope,
} from "../../core/config-snapshot.js";
import type { AgentColorMap, AskConfig } from "../../core/config-types.js";
import {
  parseSkillPermissions,
  type SkillPermissionMap,
} from "../../core/permissions/skill-permissions.js";

// realpathSync follows the symlink to the real module location, ensuring
// ../../../config.toml resolves to the project directory even when loaded
// via pi's auto-discovery symlink.
const __dirname = dirname(realpathSync(fileURLToPath(import.meta.url)));

/** The project config.toml (three levels above src/adapters/pi/). */
const CONFIG_PATH = resolve(__dirname, "../../../config.toml");

/**
 * Load the whole parsed config.toml.
 *
 * pi's Node/jiti runtime cannot import TOML (see module doc), so the
 * file is read and parsed with the vendored smol-toml `parse` parser.
 * The whole root object is returned (it carries the top-level `agent`
 * table alongside `zoo`) — callers extract the `zoo` section and the
 * agent-mode map from it.  A missing or unreadable file yields an empty
 * root object, which every profile-driven contribution skips (null
 * profile) and which parses no agent modes.
 *
 * @returns The whole parsed config.toml root (empty when absent).
 */
export function loadConfig(): any {
  try {
    const text = readFileSync(CONFIG_PATH, "utf-8");
    return parse(text);
  } catch {
    // config.toml missing or unreadable — behave as an absent config.
    return {};
  }
}

/**
 * The static configuration of one pi configuration generation.
 *
 * Carries the host-independent snapshot plus the pi-only sections the
 * host parses (ask timeout, agent colors, skill permissions) and the
 * per-agent model map the installer materialised into agents.json.
 */
export interface PiConfigSnapshot extends ConfigSnapshot {
  /** The ask-tool timeout (`[zoo.ask]`), or `undefined` (no timeout). */
  readonly askConfig: AskConfig | undefined;
  /** Per-agent status colors (`[agent.<name>].color`). */
  readonly agentColors: AgentColorMap;
  /** Per-agent skill rules (`[agent.<name>].permission.skill`). */
  readonly skillPermissions: SkillPermissionMap;
  /**
   * Per-agent sub-session models (`agents.json`, `"provider/model"`).
   *
   * Strict mode: this map is the sole model source, so an absent entry
   * makes the delegation to that agent fail instead of inheriting a model.
   */
  readonly subagentModels: Record<string, string>;
}

/** One pi configuration generation: the main extension and its children. */
export type PiProcessScope = ProcessScope<PiConfigSnapshot>;

/** The loaded inputs one pi configuration generation is built from. */
export interface PiScopeSources {
  /** The `zoo` section of the loaded config.toml. */
  readonly zooConfig: any;
  /** The whole loaded config.toml root (carries the `agent` tables). */
  readonly rawConfig: any;
  /** The per-agent model map loaded from agents.json. */
  readonly subagentModels: Record<string, string>;
}

/**
 * Parse one pi configuration generation.
 *
 * The entry point calls this once per extension load and hands the scope
 * to the handlers; every instance of the generation (the main extension
 * and the sub-sessions it spawns) reads the same immutable snapshot
 * instead of parsing again.  A reload calls it again, which is the new
 * generation.
 *
 * @param sources - The loaded config root, its `zoo` section, and the
 *   model map.
 * @returns The frozen scope over the parsed snapshot.
 */
export function createPiScope(sources: PiScopeSources): PiProcessScope {
  return createProcessScope({
    ...parseCommonConfig(sources.zooConfig, sources.rawConfig),
    askConfig: parseAskConfig(sources.zooConfig),
    agentColors: parseAgentColors(sources.rawConfig ?? {}),
    skillPermissions: parseSkillPermissions(sources.rawConfig ?? {}),
    subagentModels: sources.subagentModels,
  });
}
