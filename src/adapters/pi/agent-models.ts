/**
 * pi per-agent model map loader (`~/.pi/agent/agents.json`).
 *
 * The installer materialises `[agent.<name>].model` (with `{env:}` tokens
 * resolved) into `~/.pi/agent/agents.json` on every install as a
 * `{provider, model}` pair, e.g.
 * `{"agents": {"lynx": {"provider": "Volces", "model": "volces/deepseek-v4-flash"}}}`.
 * This module is the runtime consumer of that file: it reads it once at
 * extension-load time and produces a plain `agent → "provider/model"` map
 * handed to the subagent tool for model resolution.  The value is the
 * CONCATENATED `"provider/model"` string — the pi model registry's primary
 * key is the model table's `id` field, which may itself carry a provider
 * prefix (e.g. `volces/deepseek-v4-flash`), so the concatenation keeps the
 * provider first and the full registry id intact after the first `/`.
 *
 * The TS runtime NEVER resolves `{env:}` placeholders or reads environment
 * variables — that is the installer's job.  This module only reads the
 * already-materialised file.  Fail-closed: a missing/unreadable file,
 * malformed JSON, a non-object root/`agents` table, or an entry missing a
 * non-string `provider` or `model` all yield an empty map (plus a single
 * warn for the actionable failures).  The error surface is concentrated in
 * the subagent tool (strict mode): an empty map — or an agent absent from
 * it — makes every delegation to that agent fail with an actionable Chinese
 * error naming agents.json, so LLM and user both see the misconfiguration.
 *
 * @module
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { log } from "../../utils/logger.js";

/** The default on-disk path of the per-agent model map. */
export const AGENTS_JSON_PATH = join(homedir(), ".pi", "agent", "agents.json");

/**
 * Parse a raw agents.json file into an agent → model map.
 *
 * Accepts `{"agents": {"<name>": {"provider": "P", "model": "id"}}}`.
 * Agents whose entry is missing, non-object, or whose `provider` / `model`
 * is not a non-empty string are skipped silently; a malformed root /
 * `agents` table or malformed JSON logs one `agents_json_invalid` warn and
 * yields an empty map (fail-closed).  The mapped value is the concatenated
 * `"provider/model"` string.
 *
 * @param text - The raw file text.
 * @param path - The file path (defaults to `AGENTS_JSON_PATH`), reported in
 *   the invalid-file warn so the failing config is actionable.
 * @returns The agent → `"provider/model"` map (empty when nothing parses).
 */
export function parseAgentsJson(
  text: string,
  path: string = AGENTS_JSON_PATH,
): Record<string, string> {
  let root: unknown;
  try {
    root = JSON.parse(text);
  } catch {
    log("config", "agents_json_invalid", "", undefined, "warn", {
      path,
      reason: "invalid-json",
    });
    return {};
  }
  if (root === null || typeof root !== "object" || Array.isArray(root)) {
    log("config", "agents_json_invalid", "", undefined, "warn", {
      path,
      reason: "non-object-root",
    });
    return {};
  }
  const agents = (root as Record<string, unknown>).agents;
  if (agents === null || typeof agents !== "object" || Array.isArray(agents)) {
    log("config", "agents_json_invalid", "", undefined, "warn", {
      path,
      reason: "non-object-agents",
    });
    return {};
  }
  const map: Record<string, string> = {};
  for (const [name, entry] of Object.entries(agents)) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      continue;
    }
    const record = entry as Record<string, unknown>;
    const provider = record.provider;
    const model = record.model;
    // Fail-closed per entry: a missing or non-string provider/model pair is
    // dropped silently (the error surface is the subagent tool's strict
    // mode, which reports the actionable agents.json error on delegation).
    if (
      typeof provider !== "string" ||
      provider.length === 0 ||
      typeof model !== "string" ||
      model.length === 0
    ) {
      continue;
    }
    map[name] = `${provider}/${model}`;
  }
  return map;
}

/**
 * Load the per-agent model map from disk, fail-closed.
 *
 * A missing/unreadable file yields an empty map silently (the error
 * surface is the subagent tool, which reports an actionable error naming
 * agents.json); a readable-but-invalid file yields an empty map with a
 * warn (see `parseAgentsJson`).
 *
 * @param path - The agents.json path (defaults to `AGENTS_JSON_PATH`;
 *   injectable for tests).
 * @returns The agent → `"provider/model"` map (empty when the file is
 *   missing or invalid).
 */
export function loadAgentsJson(
  path: string = AGENTS_JSON_PATH,
): Record<string, string> {
  let text: string;
  try {
    text = readFileSync(path, "utf-8");
  } catch {
    // File missing or unreadable — an empty map.  Strict mode: the
    // subagent tool surfaces the actionable error on each delegation.
    return {};
  }
  return parseAgentsJson(text, path);
}
