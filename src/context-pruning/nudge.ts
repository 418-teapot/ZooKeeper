/**
 * Context management nudge builder.
 *
 * Generates two tiers of nudges based on current token usage:
 *   1. Urgent nudge — token usage exceeds the urgent threshold
 *   2. Gentle nudge — token usage is between the nudge and urgent thresholds
 *
 * @module
 */

import type { ContextPruningConfig } from "./types";

export interface NudgeResult {
  nudges: string[];
}

/**
 * Build context management nudges based on current token totals.
 *
 * Two-tier nudge system:
 * 1. Context limit nudge (above max threshold) — urgent
 * 2. Turn nudge (between min and max) — gentle
 *
 * @param totalTokens - Current estimated total token count.
 * @param config - Context pruning configuration with thresholds.
 * @returns Array of nudge message strings (may be empty).
 */
export function buildNudges(
  totalTokens: number,
  config: ContextPruningConfig,
): string[] {
  const nudges: string[] = [];

  // Tier 1: Context limit (urgent)
  if (totalTokens >= config.urgentThresholdTokens) {
    nudges.push(buildUrgentNudge(totalTokens, config));
  }

  // Tier 2: Turn nudge (between min and max)
  if (
    totalTokens >= config.nudgeThresholdTokens &&
    totalTokens < config.urgentThresholdTokens
  ) {
    nudges.push(buildGentleNudge(totalTokens, config));
  }

  return nudges;
}

/**
 * Build an urgent nudge message.
 *
 * @param totalTokens - Current estimated total token count.
 * @param config - Context pruning configuration.
 * @returns The nudge message string.
 */
function buildUrgentNudge(
  totalTokens: number,
  config: ContextPruningConfig,
): string {
  return `[Context Warning] Token usage (${totalTokens.toLocaleString()}) exceeds urgent threshold (${config.urgentThresholdTokens.toLocaleString()}). Consider using the compress tool to reduce context or summarize completed task results.`;
}

/**
 * Build a gentle nudge message.
 *
 * @param totalTokens - Current estimated total token count.
 * @param config - Context pruning configuration.
 * @returns The nudge message string.
 */
function buildGentleNudge(
  totalTokens: number,
  config: ContextPruningConfig,
): string {
  return `[Context Notice] Token usage is at ${totalTokens.toLocaleString()} (threshold: ${config.nudgeThresholdTokens.toLocaleString()}). Compress completed work to keep context manageable.`;
}
