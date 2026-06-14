/**
 * Context pruning configuration loader.
 *
 * Reads the `[zoo.context]` section from a zooConfig object (populated from
 * config.toml) and maps the TOML snake_case keys to camelCase
 * {@link ContextPruningConfig} fields with appropriate defaults.
 *
 * After loading raw values, nudgeThresholdTokens and urgentThresholdTokens
 * are resolved via {@link resolveEffectiveThresholds} which computes
 * `min(percent × contextLimit, absolute_value)` for each threshold.
 *
 * @module
 */

import type { ContextPruningConfig } from "./types";

/**
 * Raw percent/absolute threshold inputs read from config.toml.
 * These are private to the loader and never appear in the public
 * {@link ContextPruningConfig} interface.
 */
interface RawThresholds {
  nudgeThresholdPercent?: number;
  urgentThresholdPercent?: number;
  nudgeThresholdAbsolute?: number;
  urgentThresholdAbsolute?: number;
}

/** Raw default values for the private raw thresholds. */
const RAW_THRESHOLD_DEFAULTS: RawThresholds = {
  nudgeThresholdPercent: 20,
  urgentThresholdPercent: 40,
  nudgeThresholdAbsolute: 200_000,
  urgentThresholdAbsolute: 400_000,
};

/**
 * Raw default values for context pruning configuration.
 *
 * These mirror the defaults declared in `config.toml` under `[zoo.context]`.
 * Resolved threshold tokens are set to 0 and overwritten by
 * {@link resolveEffectiveThresholds}.
 */
const DEFAULTS: ContextPruningConfig = {
  enabled: true,
  nudgeThresholdTokens: 0,
  urgentThresholdTokens: 0,
  dedupEnabled: false,
  purgeErrorsEnabled: false,
  purgeErrorsTurns: 3,
  compressEnabled: false,
  compressMode: "range",
  nudgeFrequency: 5,
  compressLlmEnabled: false,
  compressMessageModeEnabled: false,
  commandsEnabled: false,
  persistState: false,
  protectedTools: ["task", "skill", "question"],
  turnProtection: 2,
  dedupProtectedTools: ["task", "skill", "read"],
  purgeErrorsProtectedTools: ["task", "skill"],
};

/**
 * Resolve a single threshold from its raw inputs.
 *
 * Computes `min(percent × contextLimit, absolute_value)` where:
 * - `percent` is applied to `contextLimit` when both are defined
 * - `absolute` serves as a standalone value or a ceiling when percent is active
 * - Only one need be present; the other is ignored if missing
 * - If neither raw input is available, returns 0
 *
 * @param percent - Percentage of the model's context window (0-100).
 * @param absolute - Absolute token count fallback/ceiling.
 * @param contextLimit - Model's context window in tokens.
 * @returns Resolved token count.
 */
export function resolveThreshold(
  percent: number | undefined,
  absolute: number | undefined,
  contextLimit?: number,
): number {
  const percentValue =
    percent !== undefined && contextLimit
      ? Math.round((contextLimit * percent) / 100)
      : undefined;
  const candidates = [percentValue, absolute].filter(
    (v): v is number => v !== undefined,
  );
  return candidates.length > 0 ? Math.min(...candidates) : 0;
}

/**
 * Load context pruning configuration from a zooConfig object.
 *
 * The `zooConfig` is expected to contain a `.context` property whose keys
 * follow the TOML snake_case naming convention.  Missing keys or an entirely
 * absent `[zoo.context]` section result in sensible defaults.
 *
 * The optional `contextLimit` parameter specifies the current model's context
 * window in tokens. When provided, percent-based thresholds are resolved
 * against it; otherwise only absolute thresholds are used.
 *
 * @param zooConfig - The parsed `[zoo]` section from config.toml (e.g.
 * `{ context: { nudge_threshold_percent: 20, ... } }`).  May be empty or
 * `undefined`.
 * @param contextLimit - Optional model context window in tokens (for percent
 * resolution).
 * @returns A fully populated {@link ContextPruningConfig} object.
 */
export function loadContextConfig(
  zooConfig: Record<string, any>,
  contextLimit?: number,
): ContextPruningConfig {
  const ctx: Record<string, any> = zooConfig?.context ?? {};

  // Read raw percent/absolute inputs into local variables (never exposed on config)
  const raw: RawThresholds = {
    nudgeThresholdPercent:
      ctx.nudge_threshold_percent ??
      RAW_THRESHOLD_DEFAULTS.nudgeThresholdPercent,
    urgentThresholdPercent:
      ctx.urgent_threshold_percent ??
      RAW_THRESHOLD_DEFAULTS.urgentThresholdPercent,
    nudgeThresholdAbsolute:
      ctx.nudge_threshold_absolute ??
      RAW_THRESHOLD_DEFAULTS.nudgeThresholdAbsolute,
    urgentThresholdAbsolute:
      ctx.urgent_threshold_absolute ??
      RAW_THRESHOLD_DEFAULTS.urgentThresholdAbsolute,
  };

  const config: ContextPruningConfig = {
    enabled: ctx.enabled ?? DEFAULTS.enabled,
    nudgeThresholdTokens: 0,
    urgentThresholdTokens: 0,
    dedupEnabled: ctx.dedup_enabled ?? DEFAULTS.dedupEnabled,
    purgeErrorsEnabled: ctx.purge_errors_enabled ?? DEFAULTS.purgeErrorsEnabled,
    purgeErrorsTurns: ctx.purge_errors_turns ?? DEFAULTS.purgeErrorsTurns,
    compressEnabled: ctx.compress_enabled ?? DEFAULTS.compressEnabled,
    compressMode: ctx.compress_mode ?? DEFAULTS.compressMode,
    nudgeFrequency: ctx.compress_nudge_frequency ?? DEFAULTS.nudgeFrequency,
    compressLlmEnabled: ctx.compress_llm_enabled ?? DEFAULTS.compressLlmEnabled,
    compressMessageModeEnabled:
      ctx.compress_message_mode_enabled ?? DEFAULTS.compressMessageModeEnabled,
    commandsEnabled: ctx.commands_enabled ?? DEFAULTS.commandsEnabled,
    persistState: ctx.persist_state ?? DEFAULTS.persistState,
    protectedTools: ctx.protected_tools ?? DEFAULTS.protectedTools,
    turnProtection: ctx.turn_protection ?? DEFAULTS.turnProtection,
    dedupProtectedTools:
      ctx.dedup_protected_tools ?? DEFAULTS.dedupProtectedTools,
    purgeErrorsProtectedTools:
      ctx.purge_errors_protected_tools ?? DEFAULTS.purgeErrorsProtectedTools,
  };

  // Resolve effective thresholds from local raw inputs
  config.nudgeThresholdTokens = resolveThreshold(
    raw.nudgeThresholdPercent,
    raw.nudgeThresholdAbsolute,
    contextLimit,
  );
  config.urgentThresholdTokens = resolveThreshold(
    raw.urgentThresholdPercent,
    raw.urgentThresholdAbsolute,
    contextLimit,
  );

  return config;
}
