/**
 * Context-pruning configuration schema types.
 *
 * Framework-independent schema interfaces for the `[zoo.context]` section
 * of config.toml (dedup / purge-errors / nudge / compress / decompress),
 * consumed by the config parser (`config-parse.ts`) and the pruning hook
 * adapter.  Pure type definitions only — no runtime logic.
 *
 * @module
 */

import type { NudgeConfig } from "./context/nudge.js";

/**
 * Per-subsystem gate config for a pruning strategy (dedup / purge-errors).
 *
 * Enablement is decided exclusively by the mode profile — a producer
 * registered via the `context-pruning` hook unit runs whenever its
 * prompt-side threshold is configured.  Absent sections mean the
 * producer is silently skipped.
 */
export interface ProducerGateConfig {
  /**
   * Minimum prompt-side total tokens (input + cache.read + cache.write)
   * before this producer runs.  Undefined → skip producer.
   */
  thresholdContext?: number;
  /** Tool names excluded from this strategy.  Undefined → empty list (neutral). */
  protectedTools?: string[];
}

/**
 * Per-subsystem gate config for the compression strategy.
 *
 * Strictly parsed: the section is absent (`undefined`) unless all three
 * keys are present and valid.  Enablement is decided exclusively by the
 * mode profile — the section itself carries no on/off switch.  The token
 * thresholds are defined whenever the section is returned.
 */
export interface CompressConfig {
  /**
   * Minimum estimated tokens a segment must have to bypass the phantom
   * gate.  Present whenever the section is returned.
   */
  thresholdTokens?: number;
  /**
   * Token budget to protect from the end of the session (CJK heuristic).
   * Present whenever the section is returned.
   */
  protectedTokens?: number;
  /**
   * Upper bound on the number of ranges accepted per compress tool call
   * (strictly parsed positive integer).  Present whenever the section is
   * returned — missing or invalid `max_ranges` drops the whole section.
   */
  maxRanges?: number;
}

/**
 * Context-nudge subsystem configuration (`[zoo.context.nudge]`).
 *
 * Alias of the pure decision-layer `NudgeConfig` — the hook-level
 * enable gate is gone, enablement is decided exclusively by the mode
 * profile (context-pruning hook + compress tool registered).  When the
 * section is absent the field is `undefined` and the subsystem is
 * silently absent; when present all five keys are required — any
 * missing, wrong-typed, or malformed value invalidates the whole
 * section (no fallbacks; the config parse already warned).
 */
export type ContextNudgeConfig = NudgeConfig;

/**
 * Per-subsystem gate config for the decompression strategy.
 *
 * Strictly parsed: the section is absent (`undefined`) unless
 * `maxFillPercent` is present and valid.  Enablement is decided
 * exclusively by the mode profile — the section itself carries no
 * on/off switch.  `maxFillPercent` is defined whenever the section is
 * returned.
 */
export interface DecompressConfig {
  /**
   * Max fill threshold (percent): restore of an active compression
   * block is rejected when the estimated post-restore tokens exceed
   * context_limit × maxFillPercent / 100.  Present whenever the
   * section is returned.
   */
  maxFillPercent?: number;
}

/**
 * Active mode profile (`[zoo.mode.<name>]`).
 *
 * The active profile is the single sub-table of `zoo.mode`; it declares
 * which loadable units the plugin registers: agent prompt injection,
 * skills, the seven switchable hook units, tools, and slash commands.
 * Each list is a plain array of names; an absent category means none of
 * that category load (no defaults).  The profile is `null` when the
 * section is missing or fails validation — every profile-driven
 * registration is then skipped while the remaining infrastructure hooks
 * keep working.
 */
export interface ModeProfile {
  /** Profile name (the single key under `zoo.mode`). */
  name: string;
  /** Agent names whose prompts are injected (subset of config.agent). */
  agents: string[];
  /** Skill directory names registered from core/skills/. */
  skills: string[];
  /** Hook unit names (task-prompt, task-delegation, ...). */
  hooks: string[];
  /** Tool names registered (compress, decompress). */
  tools: string[];
  /** Slash-command names registered (go, dcp). */
  commands: string[];
}

/**
 * An agent's declared role in the orchestration topology.
 *
 * Mirrors the `mode` field of the top-level `[agent.<name>]` tables in
 * config.toml.  `"primary"` agents are switchable orchestrators (e.g.
 * dolphin, mola); `"subagent"` agents are delegated helpers.  The parse
 * layer never invents a mode for an agent whose `mode` field is missing
 * or invalid — such an agent is skipped entirely (fail-closed).
 */
export type AgentMode = "primary" | "subagent";

/**
 * Per-agent mode map (`[agent.<name>].mode`).
 *
 * Maps every agent name whose `mode` field parsed successfully to its
 * declared mode.  Agents with a missing or invalid `mode` are absent
 * (skipped + warned by the parse layer) — no default mode is ever
 * injected.  An empty map means no primary agent is configured and the
 * identity machinery stays disabled.
 */
export type AgentModeMap = Record<string, AgentMode>;

/**
 * Per-agent status-bar color map (`[agent.<name>].color`).
 *
 * Maps every agent name whose `color` field parsed successfully to its
 * normalized uppercase `#RRGGBB` hex.  Agents with a missing or invalid
 * `color` are absent (skipped + warned by the parse layer) — no default
 * color is ever injected, and an absent entry means the agent's
 * indicator renders in the plain terminal color.
 */
export type AgentColorMap = Record<string, string>;

/**
 * Unified context-pruning configuration.
 *
 * Replaces the old flat `DedupOptions` used by the hook.  Each
 * producer (dedup, purge-errors) has its own gate sub-config;
 * `turnProtection` and `releaseThresholdPercent` remain shared.
 * Enablement is decided exclusively by the mode profile: registering
 * the `context-pruning` hook unit runs the whole pipeline, and
 * registering the `compress` tool gates the nudge / manual-compress
 * phases.  There is no master `enabled` switch.
 */
export interface ContextPruningConfig {
  /**
   * Number of most recent non-ignored messages to protect (shared).
   * Undefined → skip all producers (they early-return).
   */
  protectedMessages?: number;
  /**
   * Anchor token threshold for the first-user message ref protection.
   *
   * The first non-ignored user message in the session view is skipped
   * (no message ref assigned) when its heuristic token estimate does
   * not exceed this value; a larger estimate treats it as an ordinary
   * message.  `0` disables the protection.
   *
   * The parse layer maps a missing `anchor_tokens` key to `0`, so a
   * parsed config always carries a concrete number — the missing-key
   * default lives only at the parse boundary.
   */
  anchorTokens?: number;
  /**
   * Minimum percentage of prompt-side total that pending marks must
   * reach before batch release.  Undefined → skip release check.
   */
  releasedPercent?: number;
  /**
   * Context-nudge subsystem config (`[zoo.context.nudge]`).  Undefined
   * → the subsystem is silently absent (no reminders injected).
   */
  nudge?: ContextNudgeConfig;
  /**
   * Dedup producer gate & options (`[zoo.context.dedup]`).  Undefined →
   * the section is absent or was invalidated by the config parse
   * (whole-section discard) — the producer is silently absent.
   */
  dedup?: ProducerGateConfig;
  /**
   * Purge-errors producer gate & options (`[zoo.context.purge_errors]`).
   * Undefined → the section is absent or was invalidated by the config
   * parse (whole-section discard) — the producer is silently absent.
   */
  purgeErrors?: ProducerGateConfig;
  /**
   * Compress strategy gate & options (`[zoo.context.compress]`).
   * Undefined → the subsystem is silently absent (no tool, no nudge).
   */
  compress?: CompressConfig;
  /**
   * Decompress strategy gate & options (`[zoo.context.decompress]`).
   * Undefined → the subsystem is silently absent (no tool).
   */
  decompress?: DecompressConfig;
}
