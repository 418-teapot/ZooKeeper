/**
 * Immutable configuration snapshot and the host's process scope.
 *
 * A host parses its static configuration once per configuration
 * generation and hands every instance of that generation the same
 * snapshot.  The pi host creates one scope per extension load (and thus a
 * new generation on each reload), OpenCode one per plugin instance; the
 * scope is never a module-level singleton, so two loads never exchange
 * configuration.
 *
 * The snapshot is immutable at the boundary: the factory deep-freezes it,
 * so a consumer that tries to rewrite a parsed value fails instead of
 * silently changing what a sibling instance reads.
 *
 * @module
 */

import { type CommonConfig, parseCommonConfig } from "./config-parse.js";

/**
 * The host-independent configuration of one generation.
 *
 * Carries every field `parseCommonConfig` produces and feeds
 * `configCapabilities` directly, so both hosts read the same typed values
 * instead of re-parsing the raw config.
 */
export type ConfigSnapshot = Readonly<CommonConfig>;

/**
 * The configuration generation a host instance belongs to.
 *
 * Every instance of one generation (the main extension and the
 * sub-sessions it spawns) shares the same scope, so the configuration is
 * parsed once per generation and never re-read per instance.
 */
export interface ProcessScope<S> {
  /** The immutable configuration snapshot of this generation. */
  readonly snapshot: S;
}

/** Freeze a value and every nested object it reaches. */
function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }
  for (const nested of Object.values(value as Record<string, unknown>)) {
    deepFreeze(nested);
  }
  return Object.freeze(value);
}

/**
 * Create one process scope over a snapshot.
 *
 * The snapshot and all its nested values are frozen here, so the boundary
 * — not a comment — enforces immutability.
 *
 * @param snapshot - The parsed configuration of this generation.
 * @returns The frozen scope.
 */
export function createProcessScope<S>(snapshot: S): ProcessScope<S> {
  return Object.freeze({ snapshot: deepFreeze(snapshot) });
}

/**
 * Parse the host-independent config into a new configuration generation.
 *
 * Called once per host instance: a reload parses again, so the new
 * generation reads the configuration it started with.
 *
 * @param zooConfig - The `zoo` section of the parsed config.toml.
 * @param rawConfig - The whole parsed config root (carries `agent` tables).
 * @returns The scope over the parsed snapshot.
 */
export function createConfigScope(
  zooConfig: any,
  rawConfig: any,
): ProcessScope<ConfigSnapshot> {
  return createProcessScope(parseCommonConfig(zooConfig, rawConfig));
}
