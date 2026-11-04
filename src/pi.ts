/**
 * ZooKeeper pi extension entry point.
 *
 * Wiring only: `loadConfig` reads the `zoo` section of config.toml,
 * `buildPiHandlers` composes the profile and registers its pi surfaces,
 * and `registerPiHandlers` binds the handlers to pi's event keys.  All
 * hooks are profile-driven, so a null profile (absent or invalid config)
 * yields an empty composition and every handler no-ops (fail-closed,
 * aligned with the OpenCode host).
 *
 * This file also names itself: the path it reports as its own entry lets a
 * sub-session leave the file out of its extension set and load ZooKeeper
 * from the composition root's inline factory instead.
 *
 * @module
 */

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./adapters/pi/config.js";
import type { ExtensionAPI } from "./adapters/pi/types.js";
import { buildPiHandlers } from "./adapters/pi/wire.js";
import { registerPiHandlers } from "./compose-pi.js";
import { initPluginLogger } from "./core/config-parse.js";

/** The extension file pi loaded (canonical, so a symlink matches too). */
const ENTRY_PATH = realpathSync(fileURLToPath(import.meta.url));

/**
 * Register ZooKeeper's handlers with pi.
 *
 * @param pi - pi ExtensionAPI instance (provided at runtime by pi).
 */
export async function zookeeperPi(pi: ExtensionAPI): Promise<void> {
  const config = loadConfig();
  const zooConfig = config.zoo ?? {};
  initPluginLogger(zooConfig, "pi");
  registerPiHandlers(
    pi,
    await buildPiHandlers(zooConfig, pi, config, { entryPath: ENTRY_PATH }),
  );
}

export default zookeeperPi;
