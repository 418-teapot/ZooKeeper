/**
 * Framework-agnostic core types for the context pruning subsystem.
 *
 * These types are designed to be framework-agnostic — they do not depend
 * on the OpenCode SDK or any other framework types.  Framework adapters
 * (OpenCode, pi, oh-my-pi) map their own message formats to/from these
 * types.
 *
 * @module
 */

// ── Message model ──────────────────────────────────────────

export interface MessageRef {
  id: string; // mNNNN format reference ID
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  toolCalls?: ToolCallRef[];
  toolResults?: ToolResultRef[];
  metadata?: Record<string, unknown>;
}

export interface ToolCallRef {
  id: string; // tNNNN format reference ID
  toolName: string;
  parameters: Record<string, unknown>;
}

export interface ToolResultRef {
  id: string;
  toolCallId: string;
  output: string;
  isError?: boolean;
  error?: string;
}

// ── Compression ────────────────────────────────────────────

export type CompressionMode = "range" | "message";

export interface CompressionBlock {
  blockId: string;
  runId: string;
  active: boolean;

  compressedTokens: number;
  summaryTokens: number;

  mode: CompressionMode;
  topic: string;

  startId: string;
  endId: string;

  directMessageIds: string[];
  directToolIds: string[];
  effectiveMessageIds: string[];
  effectiveToolIds: string[];

  summary: CompressionSummary;
}

export interface CompressionSummary {
  goal: string;
  progress: string;
  decisions: string;
  keyContext: string;
  files: string[];
}

// ── Session State ──────────────────────────────────────────

export interface SessionState {
  sessionId: string;

  // Compression blocks
  blocksById: Map<string, CompressionBlock>;
  byMessageId: Map<string, string[]>; // messageId → blockId[]
  activeBlockIds: Set<string>;

  // Dedup cache
  dedupCache: Map<string, DedupEntry>;

  // Error tracking
  errorTracking: Map<string, ErrorEntry>;

  // Turn protection
  protectedTurns: number;
  turnCount: number;

  // Prune state (tool outputs/errors marked for replacement)
  prune: PruneState;

  // Stats
  lastAccessedAt: number;
  totalPrunedTokens: number;
  totalCompressedTokens: number;
}

export interface DedupEntry {
  toolName: string;
  signature: string;
  firstSeenAt: string; // message ID
  latestSeenAt: string; // message ID
  callCount: number;
}

export interface ErrorEntry {
  toolCallId: string;
  toolName: string;
  turnNumber: number;
  errorMessage: string;
}

export interface PruneState {
  tools: Map<string, number>; // toolCallId → tokenCount (value unused, just set presence)
}

// ── Config ─────────────────────────────────────────────────

export interface ContextPruningConfig {
  enabled: boolean;

  // Resolved absolute token thresholds — computed by loadContextConfig() as
  // min(percent × contextLimit, absolute). Ready for direct use by nudges and
  // pipeline. Raw percent/absolute inputs are internal to config-loader.ts.
  nudgeThresholdTokens: number;
  urgentThresholdTokens: number;

  // Automatic strategies
  dedupEnabled: boolean;
  purgeErrorsEnabled: boolean;
  purgeErrorsTurns: number; // 3 — turns before error purge

  // Compression
  compressMode: CompressionMode;
  compressEnabled: boolean;
  nudgeFrequency: number; // 3 — how often context-limit nudge fires

  // LLM-driven compression (future: register compress tool for model use)
  compressLlmEnabled: boolean; // register compress tool for model use
  compressMessageModeEnabled: boolean; // enable Message mode (per-message LLM compression)

  // Commands (future: /context, /stats, /sweep etc.)
  commandsEnabled: boolean; // enable /context, /stats, /sweep etc.

  // Persistence (future: persist session state to disk)
  persistState: boolean; // persist session state to disk

  // Protection
  protectedTools: string[];
  protectUserMessages: boolean;
  turnProtection: number; // 2 — protect last N turns

  // Dedup
  dedupProtectedTools: string[];

  // Purge errors
  purgeErrorsProtectedTools: string[];
}

// ── Pipeline ───────────────────────────────────────────────

export interface PipelineInput {
  sessionId: string;
  messages: MessageRef[];
  config: ContextPruningConfig;
}

export interface PipelineOutput {
  messages: MessageRef[];
  nudges: string[];
  stats: PipelineStats;
}

export interface PipelineStats {
  dedupRemoved: number;
  errorPurged: number;
  compressedTokens: number;
  summaryTokens: number;
  prunedOutputs: number; // count of tool outputs replaced by prune
  prunedErrors: number;  // count of error inputs replaced by prune
}
