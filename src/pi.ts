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
 * @module
 */

import { loadConfig } from "./adapters/pi/config.js";
import type { ExtensionAPI } from "./adapters/pi/types.js";
import { buildPiHandlers } from "./adapters/pi/wire.js";
import { registerPiHandlers } from "./compose-pi.js";
import { initPluginLogger } from "./core/config-parse.js";

/**
 * Register ZooKeeper's handlers with pi.
 *
 * @param pi - pi ExtensionAPI instance (provided at runtime by pi).
 */
export function zookeeperPi(pi: ExtensionAPI): void {
  const config = loadConfig();
  const zooConfig = config.zoo ?? {};
  initPluginLogger(zooConfig, "pi");
  registerPiHandlers(pi, buildPiHandlers(zooConfig, pi, config));
}

export default zookeeperPi;
