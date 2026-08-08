/**
 * Framework-independent config parsing for the ZooKeeper plugin.
 *
 * All parsing functions read the zoo config (the `zoo` section of
 * `config.toml`, compiled into the host config by `install.py`) and turn
 * it into typed, validated structures consumed by the plugin hooks.
 *
 * Every config section follows the same "whole-section discard" contract:
 * a section whose keys are individually optional keeps each present key
 * only when it is valid; ANY present-but-invalid (or, for strict sections,
 * any missing) key invalidates the WHOLE section — the section becomes
 * `undefined` (fail to skip) and exactly one warn is logged with the
 * offending key/value.
 *
 * Zero OpenCode framework dependencies — only the shared logger and core
 * regexes are imported, so this module is importable from any TS runtime.
 *
 * @module
 */

import { initLogger, log } from "../utils/logger.js";
import type {
  CompressConfig,
  ContextNudgeConfig,
  ContextPruningConfig,
  DecompressConfig,
  ModeProfile,
} from "./config-types.js";
import { NUDGE_PERCENT_RE } from "./context/pruning/index.js";
import type { ValidationLimits } from "./validate.js";

// ---------------------------------------------------------------------------
// Key-check table pattern
// ---------------------------------------------------------------------------

/** One row of a declarative config key-check table. */
type KeyCheck = [key: string, value: unknown, isValid: (v: unknown) => boolean];

/**
 * Find the first row whose value fails its validator.
 *
 * @param checks - The key-check table for a config section.
 * @returns The first offending row, or `undefined` when every row passes.
 */
function findBadKey(checks: KeyCheck[]): KeyCheck | undefined {
  return checks.find(([, value, isValid]) => !isValid(value));
}

/**
 * Log the single "section invalid" warn for an offending key.
 *
 * Event name is `<section>_config_invalid` (e.g. `nudge_config_invalid`),
 * carrying the offending key and value so the config edit is actionable.
 *
 * @param section - The config section name (prefix of the log event).
 * @param bad - The offending key-check row.
 */
function warnSectionInvalid(section: string, bad: KeyCheck): void {
  log("config", `${section}_config_invalid`, "", undefined, "warn", {
    key: bad[0],
    value: bad[1],
  });
}

// ---------------------------------------------------------------------------
// Shared validators (absent-OK semantics)
// ---------------------------------------------------------------------------

/** Accept `undefined` or a finite number `>= 0`. */
const isOptionalNonNegativeNumber = (v: unknown): boolean =>
  v === undefined || (typeof v === "number" && Number.isFinite(v) && v >= 0);

/** Accept `undefined` or a finite number `> 0`. */
const isOptionalPositiveNumber = (v: unknown): boolean =>
  v === undefined || (typeof v === "number" && Number.isFinite(v) && v > 0);

/** Accept `undefined` or an array of strings. */
const isOptionalStringArray = (v: unknown): boolean =>
  v === undefined ||
  (Array.isArray(v) && v.every((t: unknown) => typeof t === "string"));

/** Accept `undefined` or a finite number in `[0, 100]`. */
const isOptionalPercent = (v: unknown): boolean =>
  v === undefined ||
  (typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 100);

// ---------------------------------------------------------------------------
// Config parsers
// ---------------------------------------------------------------------------

/**
 * Extract word-count limits from the `[zoo.validation]` section.
 *
 * Whole-section discard: when the section is present and ANY present key
 * is invalid (non-number, non-finite, zero, or negative), both
 * `contextWordLimit` and `promptWordLimit` become `undefined` and exactly
 * one warn (`validation_config_invalid`) is logged.  Absent keys are fine
 * (their value stays `undefined`), and an absent section produces
 * `undefined` fields silently.
 *
 * @param zooConfig - The `zoo` section of the parsed config.toml.
 * @returns The parsed limits (fields `undefined` when not configured).
 */
export function parseLimits(zooConfig: any): ValidationLimits {
  const v = zooConfig.validation as Record<string, unknown> | undefined;
  if (v == null) {
    return { contextWordLimit: undefined, promptWordLimit: undefined };
  }

  const keyChecks: KeyCheck[] = [
    ["context_word_limit", v.context_word_limit, isOptionalPositiveNumber],
    ["prompt_word_limit", v.prompt_word_limit, isOptionalPositiveNumber],
  ];
  const bad = findBadKey(keyChecks);
  if (bad) {
    warnSectionInvalid("validation", bad);
    return { contextWordLimit: undefined, promptWordLimit: undefined };
  }

  return {
    contextWordLimit: v.context_word_limit as number | undefined,
    promptWordLimit: v.prompt_word_limit as number | undefined,
  };
}

/**
 * Extract the active mode profile from the `[zoo.mode.*]` section.
 *
 * `zoo.mode` holds exactly one sub-table — the active profile — whose
 * category lists (agents / skills / hooks / tools / commands) declare
 * which loadable units the plugin registers.  Fail to skip: an absent,
 * empty, ambiguous (multiple sub-tables), or malformed section yields
 * `null` and every profile-driven registration is skipped — no default
 * profile, no fallback to a full load.  Unknown keys inside the profile
 * are ignored; an absent category becomes an empty list.
 *
 * Whole-section discard: a present-but-invalid category (non-array or
 * non-string elements) invalidates the WHOLE profile with exactly one
 * `mode_config_invalid` warn; the same warn fires for an empty or
 * non-object `zoo.mode`, or for multiple profiles.
 *
 * @param zooConfig - The `zoo` section of the parsed config.toml.
 * @returns The active profile, or `null` when absent or invalid.
 */
export function parseModeProfile(zooConfig: any): ModeProfile | null {
  const mode = zooConfig.mode as unknown;
  if (mode === undefined || mode === null) return null;
  if (typeof mode !== "object" || Array.isArray(mode)) {
    warnSectionInvalid("mode", ["mode", mode, () => false]);
    return null;
  }

  const entries = Object.entries(mode as Record<string, unknown>);
  if (entries.length === 0) {
    warnSectionInvalid("mode", ["mode", mode, () => false]);
    return null;
  }
  if (entries.length > 1) {
    warnSectionInvalid("mode", [entries[1][0], entries[1][1], () => false]);
    return null;
  }

  const [name, profile] = entries[0];
  if (
    profile === null ||
    typeof profile !== "object" ||
    Array.isArray(profile)
  ) {
    warnSectionInvalid("mode", [name, profile, () => false]);
    return null;
  }

  const p = profile as Record<string, unknown>;
  const categories: ReadonlySet<string> = new Set([
    "agents",
    "skills",
    "hooks",
    "tools",
    "commands",
  ]);
  for (const [key, value] of Object.entries(p)) {
    if (!categories.has(key)) continue;
    if (!isOptionalStringArray(value)) {
      warnSectionInvalid("mode", [key, value, () => false]);
      return null;
    }
  }

  return {
    name,
    agents: (p.agents as string[] | undefined) ?? [],
    skills: (p.skills as string[] | undefined) ?? [],
    hooks: (p.hooks as string[] | undefined) ?? [],
    tools: (p.tools as string[] | undefined) ?? [],
    commands: (p.commands as string[] | undefined) ?? [],
  };
}

/**
 * Accept a nudge threshold value: a positive finite number (absolute
 * tokens) or a non-zero percentage string (`"NN%"`).  Zero, negative,
 * and malformed values are rejected — thresholds have no "disable"
 * meaning (enablement is decided by the mode profile).
 *
 * @param v - The raw config value.
 * @returns `true` when the value is a valid threshold.
 */
function isValidNudgeThreshold(v: unknown): boolean {
  if (typeof v === "number") return Number.isFinite(v) && v > 0;
  if (typeof v === "string") {
    const match = NUDGE_PERCENT_RE.exec(v);
    return match !== null && Number(match[1]) > 0;
  }
  return false;
}

/**
 * Extract context-pruning config from the `[zoo.context]` section.
 *
 * The section is composed of independent sub-sections, each with its own
 * whole-section discard contract.  Enablement is NOT part of this
 * section — the mode profile decides whether the pruning pipeline and
 * the compress / decompress tools load at all:
 *
 *  - The core group (`protected_messages`, `released_percent`) — keys
 *    are individually optional; any PRESENT invalid key invalidates the
 *    whole group (all become `undefined`) with one
 *    `context_config_invalid` warn.
 *  - `dedup` / `purge_errors` — keys individually optional; any present
 *    invalid key drops the whole sub-section (`undefined`) with one
 *    `dedup_config_invalid` / `purge_errors_config_invalid` warn.
 *  - `nudge` / `compress` / `decompress` — strict: all keys are required
 *    when the section is present; any missing or invalid key drops the
 *    whole sub-section with one `nudge_config_invalid` /
 *    `compress_config_invalid` / `decompress_config_invalid` warn.
 *
 * Unknown keys are silently ignored.
 *
 * @param zooConfig - The `zoo` section of the parsed config.toml.
 * @returns The unified context-pruning config (fail to skip).
 */
export function parseContextConfig(zooConfig: any): ContextPruningConfig {
  const c = (zooConfig.context ?? {}) as Record<string, unknown>;

  // ── Core group (protected_messages / released_percent) ────────────
  // Keys are individually optional; a PRESENT invalid key invalidates the
  // whole group (fail to skip) and logs exactly one warn.
  let protectedMessages: number | undefined;
  let releasedPercent: number | undefined;
  const coreChecks: KeyCheck[] = [
    ["protected_messages", c.protected_messages, isOptionalNonNegativeNumber],
    ["released_percent", c.released_percent, isOptionalPercent],
  ];
  const badCore = findBadKey(coreChecks);
  if (badCore) {
    warnSectionInvalid("context", badCore);
  } else {
    protectedMessages = c.protected_messages as number | undefined;
    releasedPercent = c.released_percent as number | undefined;
  }

  // ── Dedup producer gate ───────────────────────────────────────────────
  // Keys individually optional; a PRESENT invalid key invalidates the
  // whole sub-section (fail to skip — the producer is silently absent).
  let dedup: ContextPruningConfig["dedup"];
  const d = c.dedup as Record<string, unknown> | undefined;
  if (d != null) {
    const dedupChecks: KeyCheck[] = [
      ["threshold_context", d.threshold_context, isOptionalPositiveNumber],
      ["protected_tools", d.protected_tools, isOptionalStringArray],
    ];
    const badDedup = findBadKey(dedupChecks);
    if (badDedup) {
      warnSectionInvalid("dedup", badDedup);
    } else {
      dedup = {
        thresholdContext: d.threshold_context as number | undefined,
        protectedTools: d.protected_tools as string[] | undefined,
      };
    }
  }

  // ── Purge-errors producer gate ────────────────────────────────────────
  // Same contract as dedup.
  let purgeErrors: ContextPruningConfig["purgeErrors"];
  const pe = c.purge_errors as Record<string, unknown> | undefined;
  if (pe != null) {
    const peChecks: KeyCheck[] = [
      ["threshold_context", pe.threshold_context, isOptionalPositiveNumber],
      ["protected_tools", pe.protected_tools, isOptionalStringArray],
    ];
    const badPe = findBadKey(peChecks);
    if (badPe) {
      warnSectionInvalid("purge_errors", badPe);
    } else {
      purgeErrors = {
        thresholdContext: pe.threshold_context as number | undefined,
        protectedTools: pe.protected_tools as string[] | undefined,
      };
    }
  }

  // ── Nudge section ─────────────────────────────────────────────────────
  // Strict: all five keys are required when the section is present.  Any
  // missing, wrong-typed, or malformed value invalidates the WHOLE section
  // (fail to skip — the subsystem is silently absent) and logs exactly
  // one warn.
  let nudge: ContextNudgeConfig | undefined;
  if (c.nudge !== undefined) {
    const n = c.nudge as Record<string, unknown>;
    const nudgeChecks: KeyCheck[] = [
      ["min_context", n.min_context, isValidNudgeThreshold],
      [
        "min_context_cap",
        n.min_context_cap,
        (v) => typeof v === "number" && Number.isFinite(v) && v >= 0,
      ],
      ["max_context", n.max_context, isValidNudgeThreshold],
      [
        "max_context_cap",
        n.max_context_cap,
        (v) => typeof v === "number" && Number.isFinite(v) && v >= 0,
      ],
      ["growth_tokens", n.growth_tokens, isValidNudgeThreshold],
    ];
    const badNudge = findBadKey(nudgeChecks);
    if (badNudge) {
      warnSectionInvalid("nudge", badNudge);
    } else {
      nudge = {
        minContext: n.min_context as number | string,
        minContextCap: n.min_context_cap as number,
        maxContext: n.max_context as number | string,
        maxContextCap: n.max_context_cap as number,
        growthTokens: n.growth_tokens as number | string,
      };
    }
  }

  // ── Compress section ──────────────────────────────────────────────────
  // Strict: all three keys are required when the section is present.
  let compress: CompressConfig | undefined;
  if (c.compress !== undefined) {
    const cm = c.compress as Record<string, unknown>;
    const compressChecks: KeyCheck[] = [
      [
        "threshold_tokens",
        cm.threshold_tokens,
        (v) => typeof v === "number" && Number.isFinite(v) && v >= 0,
      ],
      [
        "protected_tokens",
        cm.protected_tokens,
        (v) => typeof v === "number" && Number.isFinite(v) && v >= 0,
      ],
      [
        "max_ranges",
        cm.max_ranges,
        (v) => typeof v === "number" && Number.isInteger(v) && v >= 1,
      ],
    ];
    const badCompress = findBadKey(compressChecks);
    if (badCompress) {
      warnSectionInvalid("compress", badCompress);
    } else {
      compress = {
        thresholdTokens: cm.threshold_tokens as number,
        protectedTokens: cm.protected_tokens as number,
        maxRanges: cm.max_ranges as number,
      };
    }
  }

  // ── Decompress section ────────────────────────────────────────────────
  // Strict: `max_fill_percent` is required when the section is present.
  let decompress: DecompressConfig | undefined;
  if (c.decompress !== undefined) {
    const dm = c.decompress as Record<string, unknown>;
    const decompressChecks: KeyCheck[] = [
      [
        "max_fill_percent",
        dm.max_fill_percent,
        (v) =>
          typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 100,
      ],
    ];
    const badDecompress = findBadKey(decompressChecks);
    if (badDecompress) {
      warnSectionInvalid("decompress", badDecompress);
    } else {
      decompress = {
        maxFillPercent: dm.max_fill_percent as number,
      };
    }
  }

  return {
    protectedMessages,
    releasedPercent,
    nudge,
    dedup,
    purgeErrors,
    compress,
    decompress,
  };
}

/**
 * Initialize the file-based logger from the `[zoo.logging]` section.
 *
 * Whole-section discard: when the section is present and ANY present key
 * is invalid (type/finite/range check), NO logging option is applied
 * (rotation, backup trimming, and old-log cleanup all stay disabled) and
 * exactly one warn (`logging_config_invalid`) is logged.
 *
 *  - `max_file_size_mb`: must be > 0 (file-rotation threshold).
 *  - `max_backups`: must be >= 0 (0 disables backups; negative is invalid).
 *  - `retention_days`: must be > 0 (negative would delete all logs).
 *
 * @param zooConfig - The `zoo` section of the parsed config.toml.
 */
export function initPluginLogger(zooConfig: any): void {
  const lc = zooConfig.logging as Record<string, unknown> | undefined;
  if (lc == null) {
    initLogger("");
    return;
  }

  const keyChecks: KeyCheck[] = [
    ["max_file_size_mb", lc.max_file_size_mb, isOptionalPositiveNumber],
    ["max_backups", lc.max_backups, isOptionalNonNegativeNumber],
    ["retention_days", lc.retention_days, isOptionalPositiveNumber],
  ];
  const bad = findBadKey(keyChecks);
  if (bad) {
    warnSectionInvalid("logging", bad);
    initLogger("");
    return;
  }

  const maxSizeRaw = lc.max_file_size_mb as number | undefined;
  initLogger("", {
    maxFileSize:
      maxSizeRaw === undefined ? undefined : maxSizeRaw * 1024 * 1024,
    maxBackups: lc.max_backups as number | undefined,
    retentionDays: lc.retention_days as number | undefined,
  });
}
