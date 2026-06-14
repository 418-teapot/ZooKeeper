/**
 * Context management nudge builder.
 *
 * Generates three tiers of nudges based on current token usage:
 *   1. Urgent nudge — token usage exceeds the urgent threshold
 *   2. Gentle nudge — token usage is between the nudge and urgent thresholds
 *   3. Iteration nudge — many assistant messages in the session
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
 * Three-tier nudge system:
 * 1. Context limit nudge (above max threshold) — urgent
 * 2. Turn nudge (between min and max, on new user turn) — gentle
 * 3. Iteration nudge (between min and max, many assistant msgs) — drift warning
 *
 * @param totalTokens - Current estimated total token count.
 * @param config - Context pruning configuration with thresholds.
 * @param turnCount - Optional current turn count (for iteration nudge).
 * @param iterationCount - Optional assistant message count (for iteration nudge).
 * @returns Array of nudge message strings (may be empty).
 */
export function buildNudges(
  totalTokens: number,
  config: ContextPruningConfig,
  turnCount?: number,
  iterationCount?: number,
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

  // Tier 3: Iteration nudge (if many iterations)
  if (iterationCount !== undefined && iterationCount > 10) {
    nudges.push(buildIterationNudge(iterationCount));
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

/**
 * Build an iteration nudge message.
 *
 * @param iterationCount - The number of assistant messages.
 * @returns The nudge message string.
 */
function buildIterationNudge(iterationCount: number): string {
  return `[Iteration Notice] ${iterationCount} assistant messages in this session. Consider summarizing completed rounds to maintain focus.`;
}
