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

import type { NudgeConfig } from "./context/pruning/index.js";

/**
 * Per-subsystem gate config for a pruning strategy (dedup / purge-errors).
 */
export interface ProducerGateConfig {
  /** Hook-level enable gate.  Undefined → runs unless explicitly false. */
  enabled?: boolean;
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
 * keys are present and valid.  `enabled` is the hook-level gate —
 * `false` is parsed but disabled (no tool registration, no nudge).
 * The token thresholds are defined whenever the section is returned.
 */
export interface CompressConfig {
  /** Hook-level enable gate.  `false` → parsed but disabled. */
  enabled?: boolean;
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
 * Extends the pure decision-layer `NudgeConfig` with a hook-level
 * enable gate.  When the section is absent the field is `undefined`
 * and the subsystem is silently absent; when present all six keys are
 * required — any missing, wrong-typed, or malformed value invalidates
 * the whole section (no fallbacks; the config parse already warned).
 */
export interface ContextNudgeConfig extends NudgeConfig {
  /** Hook-level enable gate.  `false` → parsed but disabled (no injection). */
  enabled?: boolean;
}

/**
 * Per-subsystem gate config for the decompression strategy.
 *
 * Strictly parsed: the section is absent (`undefined`) unless both
 * keys are present and valid.  `enabled` is the hook-level gate —
 * `false` is parsed but disabled (no tool registration).
 * `maxFillPercent` is defined whenever the section is returned.
 */
export interface DecompressConfig {
  /** Hook-level enable gate.  `false` → parsed but disabled. */
  enabled?: boolean;
  /**
   * Max fill threshold (percent): restore of an active compression
   * block is rejected when the estimated post-restore tokens exceed
   * context_limit × maxFillPercent / 100.  Present whenever the
   * section is returned.
   */
  maxFillPercent?: number;
}

/**
 * Unified context-pruning configuration.
 *
 * Replaces the old flat `DedupOptions` used by the hook.  Each
 * producer (dedup, purge-errors) has its own gate sub-config;
 * `turnProtection` and `releaseThresholdPercent` remain shared.
 */
export interface ContextPruningConfig {
  /**
   * Master enable switch.  When not explicitly true the entire
   * transform no-ops: the entire pipeline (Phases 1–7) is skipped.  Undefined → disabled.
   */
  enabled?: boolean;
  /**
   * Number of most recent non-ignored messages to protect (shared).
   * Undefined → skip all producers (they early-return).
   */
  protectedMessages?: number;
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
