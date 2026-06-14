/**
 * Context Pruning barrel export.
 *
 * Re-exports all public API from the context pruning subsystem.
 *
 * @module
 */

export type {
  MessageRef,
  ToolCallRef,
  ToolResultRef,
  CompressionMode,
  CompressionBlock,
  CompressionSummary,
  SessionState,
  PruneState,
  DedupEntry,
  ErrorEntry,
  ContextPruningConfig,
  PipelineInput,
  PipelineOutput,
  PipelineStats,
} from "./types";

export {
  estimateTokens,
  estimateTotalTokens,
  getContextTokens,
} from "./estimator";

export {
  globalState,
  ContextPruningState,
} from "./state";

export {
  buildNudges,
} from "./nudge";

export {
  runPipeline,
  prepareSession,
} from "./pipeline";

export {
  loadContextConfig,
  resolveThreshold,
} from "./config-loader";
