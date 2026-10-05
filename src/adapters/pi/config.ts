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
 * @module
 */

import { readFileSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "../../../vendor/smol-toml/index.js";

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
