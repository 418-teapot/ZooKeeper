/**
 * Context pruning — framework-agnostic pure logic.
 *
 * Provides the unified marks collection, two parameterised producers
 * (dedup + sweep), and the prune (replace) function.
 * OpenCode framework adapter lives in `src/hooks/context-pruning/`.
 *
 * @module
 */

export type { Mark, SessionState } from "./marks.js";
export {
  _clearAllSessionsForTesting,
  addMark,
  deleteSessionState,
  getOrCreateSessionState,
  loadSessionState,
  markedCount,
  markedTokens,
  pendingCount,
  pendingTokens,
  reclaimedTokens,
  releaseBatch,
  removeSession,
  saveSessionState,
} from "./marks.js";
export type { DedupMark, DedupOptions } from "./producers/dedup.js";
export { runDedup } from "./producers/dedup.js";
export type { SweepMark } from "./producers/sweep.js";
export { runSweep } from "./producers/sweep.js";
export type { PruneReplacement } from "./prune.js";
export { pruneToolOutputs } from "./prune.js";
export type { SweepToolPart } from "./types.js";
export { PRUNED_TOOL_OUTPUT_REPLACEMENT } from "./types.js";
