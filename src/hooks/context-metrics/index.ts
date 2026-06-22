/**
 * Context Metrics barrel export.
 *
 * Thin re-export — all logic lives in `src/core/metrics.ts`.
 *
 * @module
 */

export type {
  ContextMessageEntry,
  ContextMessageInfo,
  ContextMetricsOutput,
  ContextMetricsResult,
  ContextTextPart,
  ContextTokenInfo,
} from "../../core/metrics.js";
export {
  estimateMessageHeuristic,
  measureContext,
} from "../../core/metrics.js";
