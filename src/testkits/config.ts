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
import { composeProfile } from "../core/compose.js";
import type {
  ContextPruningConfig,
  ModeProfile,
} from "../core/config-types.js";
import type { Capabilities } from "../core/ports/index.js";
import type { ToolContribution } from "../core/unit.js";
import { buildPlugin } from "../opencode.js";
import { REGISTRY } from "../registry.js";

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
      tools: ["compress", "decompress"],
    },
  },
};

/** Build a plugin wired to the poly profile (tools: compress + decompress). */
export function makePlugin(client: unknown = {}): Promise<Record<string, any>> {
  return buildPlugin({ client }, POLY_ZOO) as Promise<Record<string, any>>;
}

/**
 * Assemble the OpenCode `tool` surface for a tool-only profile.
 *
 * Drives the production path — `composeProfile` over the real registry,
 * then `assembleOpenCodeHooks` — with deps matching `buildPlugin`'s
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
  const composed = composeProfile(profile, REGISTRY, deps);
  return assembleOpenCodeHooks(composed, deps, profile).tool;
}
