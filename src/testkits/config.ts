/**
 * Shared plugin-config fixture for the OpenCode-host tool-flow suites.
 *
 * `POLY_ZOO` mirrors config.toml's `[zoo.context.compress]` /
 * `[zoo.context.decompress]` values so the `compress` / `decompress` flow
 * tests keep their thresholds (protectedMessages=20, thresholdTokens=2000,
 * protectedTokens=20000, maxRanges=8, max_fill_percent=90); `makePlugin`
 * wires that payload to the real `buildPlugin`.
 *
 * @module
 */

import { createV1ToolHost } from "../adapters/opencode/tool-host.js";
import { assembleOpenCodeHooks } from "../compose-opencode.js";
import type {
  ContextPruningConfig,
  ModeProfile,
} from "../core/config-types.js";
import type { Capabilities } from "../core/ports/index.js";
import type { ToolContribution } from "../core/unit.js";
import { buildPlugin } from "../opencode.js";
import { REGISTRY } from "../registry.js";
import { assembleForTest } from "./compose.js";

/** A zoo config carrying the poly profile's tool-flow gates. */
export const POLY_ZOO: Record<string, unknown> = {
  context: {
    protected_messages: 20,
    released_percent: 10,
    dedup: { min_messages: 20, threshold_context: 100000, protected_tools: [] },
    purge_errors: {
      min_messages: 20,
      threshold_context: 100000,
      protected_tools: [],
    },
    compress: {
      threshold_tokens: 2000,
      protected_tokens: 20000,
      max_ranges: 8,
    },
    decompress: { max_fill_percent: 90 },
  },
  mode: {
    poly: {
      agents: ["dolphin"],
      tools: ["compress", "decompress"],
    },
  },
};

/**
 * Raw config carrying the profile agent's mode.
 *
 * The host declares dolphin as its orchestrator, so the profile must
 * provide it as a primary; without the role table the selection would be
 * invalid and no tool would register.
 */
export const POLY_RAW: Record<string, unknown> = {
  agent: { dolphin: { mode: "primary" } },
};

/**
 * Build the host `config.agent` table `install.py` generates for POLY_ZOO.
 *
 * The config hook refuses a selection whose agents the host has not
 * materialised, so a test that drives the hook hands over the same table
 * the installer writes: POLY_RAW's agents, modes included.
 */
export function polyHostConfig(): Record<string, any> {
  const modes = POLY_RAW.agent as Record<string, { mode: string }>;
  const agent: Record<string, any> = {};
  for (const [name, { mode }] of Object.entries(modes)) agent[name] = { mode };
  return { agent };
}

/**
 * Provide the pre-read host config on a stub OpenCode client.
 *
 * The plugin reads the host config through `client.config.get` before it
 * plans the selection, so every stub client that drives `buildPlugin`
 * has to answer that request with the host's agent table.
 *
 * @param client - The stub client (session / tool APIs).
 * @param config - The host config to answer with.
 * @returns The client, extended with `config.get`.
 */
export function withHostConfig(
  client: unknown = {},
  config: Record<string, any> = polyHostConfig(),
): Record<string, any> {
  return {
    ...(client as Record<string, any>),
    config: { get: async () => ({ data: config }) },
  };
}

/** Build a plugin wired to the poly profile (tools: compress + decompress). */
export function makePlugin(client: unknown = {}): Promise<Record<string, any>> {
  return buildPlugin(
    { client: withHostConfig(client) },
    POLY_ZOO,
    POLY_RAW,
  ) as Promise<Record<string, any>>;
}

/**
 * Assemble the OpenCode `tool` surface for a tool-only profile.
 *
 * Drives the production path — the assembly pipeline over the real
 * registry, then `assembleOpenCodeHooks` — with deps matching `buildPlugin`'s
 * construction (the tool units read only `contextConfig` and `toolHost`).
 * Returns `undefined` when the profile enables no tool, matching the
 * plugin's absent `tool` key.
 *
 * @param client - The host client backing the tool host.
 * @param contextConfig - The parsed context-pruning config.
 * @param tools - The profile's tool names.
 * @returns The composed tool map, or `undefined` when none registers.
 */
export function composeToolHooks(
  client: any,
  contextConfig: ContextPruningConfig,
  tools: string[],
): Record<string, ToolContribution> | undefined {
  const resolveAgent = (): string | undefined => undefined;
  const deps: Partial<Capabilities> = {
    limits: {},
    contextConfig,
    directory: "",
    resolveAgent,
    toolHost: createV1ToolHost(client, resolveAgent),
  };
  const profile: ModeProfile = {
    name: "test",
    agents: [],
    skills: [],
    hooks: [],
    tools,
    commands: [],
  };
  const { composed, selection } = assembleForTest(profile, REGISTRY, deps);
  return assembleOpenCodeHooks(composed, deps, selection).tool;
}
