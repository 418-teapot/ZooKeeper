/**
 * Context Pruning barrel export.
 *
 * Re-exports all public API from the context pruning subsystem.
 *
 * @module
 */

export { applyCompression } from "./compress";
export { applyMessageCompression } from "./compress-message";
export { compressToolDef } from "./compress-tool";
export {
  loadContextConfig,
  resolveThreshold,
} from "./config-loader";
export { markDuplicates } from "./dedup";
export {
  estimateTokens,
  estimateTotalTokens,
  getContextTokens,
} from "./estimator";

export { buildNudges } from "./nudge";

export {
  prepareSession,
  runPipeline,
} from "./pipeline";
export { applyPruning } from "./prune";
export { markPurgeErrors } from "./purge-errors";
export {
  ContextPruningState,
  globalState,
} from "./state";
export type {
  CompressionBlock,
  CompressionMode,
  CompressionSummary,
  ContextPruningConfig,
  DedupEntry,
  ErrorEntry,
  MessageRef,
  PipelineInput,
  PipelineOutput,
  PipelineStats,
  PruneState,
  SessionState,
  ToolCallRef,
  ToolResultRef,
} from "./types";
