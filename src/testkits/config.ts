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

import { buildPlugin } from "../opencode.js";

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
