/**
 * Context Metrics barrel export.
 *
 * Thin re-export — all logic lives in `src/core/context/metrics.ts`.
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
} from "../../core/context/metrics.js";
export {
  estimateMessageHeuristic,
  measureContext,
} from "../../core/context/metrics.js";
