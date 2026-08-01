/**
 * Context pruning — framework-agnostic pure logic.
 *
 * Provides the unified marks collection, two parameterised producers
 * (dedup + sweep), and the prune (replace) function.
 * OpenCode framework adapter lives in `src/hooks/context-pruning/`.
 *
 * @module
 */

export type { CompressionBlock, CompressionPlan } from "./blocks.js";
export {
  activeBlockCount,
  activeReclaimedTokens,
  createBlock,
  cumulativeReclaimedTokens,
  liveBlocks,
  syncBlocks,
} from "./blocks.js";
export type { CompressionPlanResult, CompressionSegment } from "./compress.js";
export {
  BLOCK_HEADER_TEMPLATE,
  buildBlockSummary,
  deriveBlockTitle,
  estimateSegmentTokens,
  firstUserMessageIndex,
  lastUserMessageIndex,
  planCompression,
  segmentInOutTokens,
  tokenBoundary,
} from "./compress.js";
export {
  foldCompressedBlocks,
  previewFold,
} from "./fold.js";
export type {
  Mark,
  PersistedRefs,
  PruneAction,
  SessionState,
} from "./marks.js";
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
  readPersistedRefs,
  reclaimedTokens,
  releaseBatch,
  removeSession,
  saveSessionState,
} from "./marks.js";
export {
  _clearAllRefsForTesting,
  _setNextRefForTesting,
  assignMessageRefs,
  getLastCompactionBoundaryId,
  getMessageIdByRef,
  injectMessageRefs,
  resetMessageRefs,
  setLastCompactionBoundaryId,
  snapshotRefs,
  stripHallucinatedRefs,
  stripRefsFromString,
} from "./message-refs.js";
export type { DedupMark, DedupOptions } from "./producers/dedup.js";
export { runDedup } from "./producers/dedup.js";
export type {
  PurgeErrorsMark,
  PurgeErrorsOptions,
} from "./producers/purge-errors.js";
export { runPurgeErrors } from "./producers/purge-errors.js";
export type { SweepMark } from "./producers/sweep.js";
export { runSweep } from "./producers/sweep.js";
export type { PruneReplacement } from "./prune.js";
export { pruneToolErrors, pruneToolOutputs } from "./prune.js";
export type { SweepToolPart } from "./types.js";
export {
  INPUT_HEAVY_TOOLS,
  MAX_INDEX,
  PRUNED_TOOL_ERROR_INPUT_REPLACEMENT,
  PRUNED_TOOL_INPUT_REPLACEMENT,
  PRUNED_TOOL_OUTPUT_REPLACEMENT,
  ZOO_MSG_ID_CANONICAL_END_REGEX,
  ZOO_MSG_ID_ORPHAN_REGEX,
  ZOO_MSG_ID_REGEX,
  ZOO_MSG_ID_TAG,
} from "./types.js";
