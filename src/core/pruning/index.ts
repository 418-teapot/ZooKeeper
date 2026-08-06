/**
 * Context pruning — framework-agnostic pure logic.
 *
 * Provides the unified marks collection, the parameterised producers
 * (dedup + purge-errors + sweep), the prune (replace) function, and the
 * range-mode compress / decompress / nudge subsystems.  OpenCode framework
 * adapter lives in `src/hooks/context-pruning/`.
 *
 * @module
 */

export type { CompressionBlock, CompressionPlan } from "./blocks.js";
export {
  activeBlockCount,
  activeReclaimedTokens,
  createBlock,
  liveBlocks,
  syncBlocks,
} from "./blocks.js";
export type {
  CompressionConfig,
  CompressionSegment,
} from "./compress.js";
export {
  BLOCK_HEADER_TEMPLATE,
  estimateSegmentTokens,
  segmentInOutTokens,
  tokenBoundary,
} from "./compress.js";
export {
  applyDecompress,
  evaluateGate,
  RECALL_MAX_CHARS,
  resolveTarget,
  truncateRecallSummary,
} from "./decompress.js";
export {
  foldCompressedBlocks,
  previewFold,
} from "./fold.js";
export type {
  Mark,
  PersistedRefs,
  PruneAction,
} from "./marks.js";
export {
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
  assignMessageRefs,
  getLastCompactionBoundaryId,
  getMessageIdByRef,
  getMessageRefById,
  injectMessageRefs,
  resetMessageRefs,
  setLastCompactionBoundaryId,
  snapshotRefs,
  stripHallucinatedRefs,
  stripRefsFromString,
} from "./message-refs.js";
export type { NudgeConfig } from "./nudge.js";
export {
  computeEligibility,
  evaluateNudge,
  NUDGE_PERCENT_RE,
  resolveThresholds,
} from "./nudge.js";
export type { DedupMark, DedupOptions } from "./producers/dedup.js";
export { runDedup } from "./producers/dedup.js";
export type {
  PurgeErrorsMark,
  PurgeErrorsOptions,
} from "./producers/purge-errors.js";
export { runPurgeErrors } from "./producers/purge-errors.js";
export type { SweepMark, SweepOptions } from "./producers/sweep.js";
export { runSweep } from "./producers/sweep.js";
export type { PruneReplacement } from "./prune.js";
export { pruneToolErrors, pruneToolOutputs } from "./prune.js";
export type { CompressRangeInput } from "./range.js";
export {
  applyRange,
  compressRanges,
  resolveSpan,
  validateRange,
} from "./range.js";
export type { ProducerOptions } from "./shared.js";
export {
  firstUserMessageIndex,
  lastUserMessageIndex,
} from "./shared.js";
export type { SessionState, SweepToolPart } from "./types.js";
export {
  getCallId,
  PRUNED_TOOL_OUTPUT_REPLACEMENT,
  ZOO_MSG_ID_CANONICAL_END_REGEX,
} from "./types.js";
