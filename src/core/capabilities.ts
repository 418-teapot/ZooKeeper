/**
 * Shared config → capabilities assembly.
 *
 * Both host entry points parse the same host-independent slice of the
 * `zoo` config (`[zoo.validation]`, `[zoo.context]`, `[zoo.continuation]`,
 * `[zoo.autodebug]`, plus the top-level `agent` table) and then add their
 * own host ports.  Keeping that slice in one place means the two hosts can
 * never drift in which sections they honour, and a test assembly can build
 * the same slice without copying the parse list.
 *
 * @module
 */

import {
  parseAgentModes,
  parseAgentPermissions,
  parseAutoDebugConfig,
  parseContextConfig,
  parseContinuationConfig,
  parseLimits,
  parseModeProfile,
} from "./config-parse.js";
import type {
  AgentModeMap,
  AutoDebugConfig,
  ContextPruningConfig,
  ContinuationConfig,
  ModeProfile,
} from "./config-types.js";
import type { AgentPermissionMap } from "./permissions/deny-tools.js";
import type { Capabilities } from "./ports/index.js";
import type { ValidationLimits } from "./validate.js";

/** Everything parsed from the config that is host-independent. */
export interface CommonConfig {
  /** The active mode profile, or `null` when absent/invalid. */
  modeProfile: ModeProfile | null;
  /** Word-count limits from `[zoo.validation]`. */
  limits: ValidationLimits;
  /** Unified context-pruning configuration (`[zoo.context]`). */
  contextConfig: ContextPruningConfig;
  /** Auto-continuation budget (`[zoo.continuation]`), or `undefined`. */
  continuationConfig: ContinuationConfig | undefined;
  /** Auto-debug wake budget (`[zoo.autodebug]`), or `undefined`. */
  autoDebugConfig: AutoDebugConfig | undefined;
  /** Per-agent mode map from the top-level `agent` table. */
  agentModes: AgentModeMap;
  /** Per-agent tool-level deny map from the top-level `agent` table. */
  agentPermissions: AgentPermissionMap;
}

/**
 * Parse the host-independent config slice.
 *
 * Every section is parsed fail-closed by the config parsers: a missing or
 * invalid section yields `undefined` (never a default), so the
 * corresponding capability stays unprovided and `composeProfile` skips the
 * units that need it.
 *
 * @param zooConfig - The `zoo` section of the parsed config.toml.
 * @param rawConfig - The whole parsed config root (carries `agent` tables).
 * @returns The parsed common config.
 */
export function parseCommonConfig(
  zooConfig: any,
  rawConfig: any,
): CommonConfig {
  const root = rawConfig ?? {};
  return {
    modeProfile: parseModeProfile(zooConfig),
    limits: parseLimits(zooConfig),
    contextConfig: parseContextConfig(zooConfig),
    continuationConfig: parseContinuationConfig(zooConfig),
    autoDebugConfig: parseAutoDebugConfig(zooConfig),
    agentModes: parseAgentModes(root),
    agentPermissions: parseAgentPermissions(root),
  };
}

/**
 * Project the parsed config onto the capability catalog.
 *
 * Only the config-derived keys are produced; the host adds its own ports.
 *
 * @param common - The parsed common config.
 * @returns The config-derived capability slice.
 */
export function configCapabilities(
  common: CommonConfig,
): Partial<Capabilities> {
  return {
    limits: common.limits,
    contextConfig: common.contextConfig,
    continuationConfig: common.continuationConfig,
    autoDebugConfig: common.autoDebugConfig,
    agentModes: common.agentModes,
    agentPermissions: common.agentPermissions,
  };
}
