/**
 * ZooKeeper pi extension entry point.
 *
 * Wiring only: `loadConfig` reads the `zoo` section of config.toml,
 * `loadAgentsJson` reads the per-agent model map, `createPiScope` freezes
 * both into this configuration generation's snapshot, and the shared start
 * protocol (`core/runtime.ts`) starts this generation's runtime with the
 * main origin.  The runtime's publisher (`adapters/pi/publisher.ts`)
 * prepares the whole start — activating the extension, composing the
 * profile, building the handlers and the registrations — before it writes
 * anything into pi, and closes the runtime if any step fails.  All hooks
 * are profile-driven, so a null profile (absent or invalid config) yields an
 * empty composition and every handler no-ops (fail-closed, aligned with the
 * OpenCode host).
 *
 * The generation is parsed here, once per extension load: every instance
 * of the generation reads the same snapshot, and a reload creates the next
 * one.  The process state is the opposite: the entry reads this process's
 * one owner, so a reload keeps the session identities and the subagent run
 * records of the generation it replaces.
 *
 * This file also names itself: the path it reports as its own entry lets a
 * sub-session leave the file out of its extension set and load ZooKeeper
 * from the composition root's inline factory instead.
 *
 * @module
 */

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadAgentsJson } from "./adapters/pi/agent-models.js";
import { createPiScope, loadConfig } from "./adapters/pi/config.js";
import { piProcessState } from "./adapters/pi/process.js";
import { createPiRuntime } from "./adapters/pi/publisher.js";
import type { ExtensionAPI } from "./adapters/pi/types.js";
import { initPluginLogger } from "./core/config-parse.js";
import { MAIN_ORIGIN, startRuntime } from "./core/runtime.js";

/** The extension file pi loaded (canonical, so a symlink matches too). */
const ENTRY_PATH = realpathSync(fileURLToPath(import.meta.url));

/**
 * Start ZooKeeper on pi: start this generation's runtime.
 *
 * The runtime starts through the shared start protocol with the main
 * origin, so the main instance and every sub-session it spawns run the same
 * sequence.
 *
 * @param pi - pi ExtensionAPI instance (provided at runtime by pi).
 */
export async function zookeeperPi(pi: ExtensionAPI): Promise<void> {
  const rawConfig = loadConfig();
  const zooConfig = rawConfig.zoo ?? {};
  initPluginLogger(zooConfig, "pi");
  const scope = createPiScope({
    zooConfig,
    rawConfig,
    subagentModels: loadAgentsJson(),
  });
  const process = piProcessState();
  await startRuntime({
    scope,
    origin: MAIN_ORIGIN,
    createRuntime: ({ scope: startScope, origin }) =>
      createPiRuntime({
        scope: startScope,
        origin,
        process,
        pi,
        overrides: { entryPath: ENTRY_PATH },
      }),
  });
}

export default zookeeperPi;
