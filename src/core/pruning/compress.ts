/**
 * Compression planning and mechanical summary generation for context pruning.
 *
 * Provides pure functions that determine which message segments can be
 * heuristically compressed and generate deterministic mechanical summaries.
 *
 * This is the "production layer" — it produces plans only. State writes
 * (creating CompressionBlock entries) are the responsibility of the
 * command orchestration layer (context-command hook).
 *
 * @module
 */

import type { ContextMessageEntry } from "../metrics.js";
import {
  estimateMessageHeuristic,
  estimateTokenCount,
  isMessageIgnored,
} from "../metrics.js";
import {
  firstUserMessageIndex,
  lastUserMessageIndex,
  protectedBoundary,
} from "./shared.js";

// Re-exported here so the barrel and existing consumers (range.ts,
// nudge.ts) that import these from ./compress.js keep working.
export { firstUserMessageIndex, lastUserMessageIndex };

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Configuration for the compression planner.
 */
export interface CompressionConfig {
  /** Number of most recent non-ignored messages to protect from compression. */
  protectedMessages: number;
  /** Token budget to protect from the end of the session (CJK heuristic). */
  protectedTokens: number;
  /** Minimum estimated tokens a segment must have to bypass the phantom gate. */
  thresholdTokens: number;
}

/**
 * A contiguous segment of messages eligible for compression.
 *
 * The segment spans `[startIndex, endIndex)` in the messages array and is
 * guaranteed to be contiguous — any excluded messages create separate
 * segments.
 *
 * Segments that pass both the phantom gate and the negative-benefit gate
 * carry precomputed `summary`, `inTokens`, and `outTokens` fields so that
 * downstream consumers (e.g. the command layer) can avoid recomputing them.
 */
export interface CompressionSegment {
  /** Inclusive start index in the messages array. */
  startIndex: number;
  /** Exclusive end index in the messages array. */
  endIndex: number;
  /** Precomputed mechanical summary (set for segments that pass both gates). */
  summary?: string;
  /** Precomputed input token estimate (set for accepted segments). */
  inTokens?: number;
  /** Precomputed output token estimate (set for accepted segments). */
  outTokens?: number;
}

/** Header prefix containing the block-id placeholder (`b<N>`). */
export const BLOCK_HEADER_TEMPLATE = "[Compression Block b<N>]";

/**
 * Derive a one-line block title from a block summary.
 *
 * Mechanical derivation at creation time (used by the `/dcp compress`
 * command path, which has no model-supplied title): the first real
 * content line of the summary, truncated to 80 characters
 * (surrogate-pair safe).  The block header line (the
 * `[Compression Block b<N>]` prefix) and section-marker lines
 * (`=== ... ===`, e.g. `=== User Requests ===`) are skipped — the header
 * is rebuilt by the caller with the derived title, and markers are fixed
 * boilerplate that would make every title identical.
 *
 * **Hyphen-run sanitization:** runs of three or more consecutive hyphens
 * are replaced with a single em dash.  This is the command-path side of
 * the title policy asymmetry — the tool path REJECTS such titles loudly
 * so the model can retry with other punctuation, while the unattended
 * command path cannot ask anyone to retry, so it SANITIZES instead (a
 * `---` run in the title would visually merge with the `--- b<N>:
 * <title> ---` separators of superseded index lines).
 *
 * Returns the empty string when the summary has no content beyond the
 * header and markers; the caller is responsible for ensuring a non-empty
 * title (title is required at block creation time).
 *
 * @param summary - The block summary text.
 * @returns The derived title (may be empty).
 */
export function deriveBlockTitle(summary: string): string {
  for (const line of summary.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    if (trimmed.startsWith(BLOCK_HEADER_TEMPLATE)) continue;
    if (/^={3}.*={3}$/.test(trimmed)) continue;
    const title = trimmed.replace(/-{3,}/g, "—");
    if (title.length <= 80) return title;
    // Avoid splitting a surrogate pair (emoji = 2 UTF-16 code units) when
    // the 80th code unit is the high half of a pair — truncate to 79 then.
    const atCut = title.charCodeAt(79);
    return atCut >= 0xd800 && atCut <= 0xdbff
      ? title.slice(0, 79)
      : title.slice(0, 80);
  }
  return "";
}

/**
 * The output of `planCompression`.
 */
export interface CompressionPlanResult {
  /** Segments eligible for compression. May be empty. */
  segments: CompressionSegment[];
}

// ---------------------------------------------------------------------------
// Token-accumulation boundary
// ---------------------------------------------------------------------------

/**
 * Compute the inclusive start index of the token-protection window.
 *
 * Messages are accumulated from the end (backward) until the cumulative
 * heuristic estimate reaches `protectedTokens`.  Ignored messages do not
 * contribute to the cumulative total.
 *
 * @param messages - The session messages array.
 * @param protectedTokens - Token budget to protect from the end.
 * @returns Inclusive start index of the protection window.  0 = all messages
 *   protected; `messages.length` = empty window.
 */
export function tokenBoundary(
  messages: ContextMessageEntry[],
  protectedTokens: number,
): number {
  if (protectedTokens <= 0 || messages.length === 0) return messages.length;

  let accumulated = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (!isMessageIgnored(messages[i])) {
      accumulated += estimateMessageHeuristic(messages[i]);
      if (accumulated >= protectedTokens) return i;
    }
  }
  return 0;
}

// ---------------------------------------------------------------------------
// planCompression
// ---------------------------------------------------------------------------

/**
 * Compute a compression plan for the given messages.
 *
 * **Triple protection:**
 * 1. Message-count protection — the last `protectedMessages` non-ignored
 *    messages are protected via `protectedBoundary`.
 * 2. Token-accumulation protection — messages from the end whose cumulative
 *    heuristic estimate reaches `protectedTokens` are protected.
 * 3. Last non-ignored user message is always in the protection zone.
 *
 * The final protection boundary is the minimum index of all three (most
 * conservative, i.e. protects the most messages).
 *
 * **Candidate pool** consists of all messages before the protection
 * boundary, excluding:
 * - The first user message (never eligible for compression)
 * - Messages already covered by existing compression blocks
 *   (`alreadyCompressedIds`)
 * - Ignored messages
 *
 * Exclusions split the candidate pool into contiguous segments.  Each
 * segment is then subject to:
 * - **Phantom gate:** skipped if estimated tokens < `thresholdTokens`.
 * - **Negative-benefit gate:** skipped if the summary text's token
 *   estimate >= the segment's token estimate.
 *
 * @param messages - The full session messages array.
 * @param config - Compression configuration.
 * @param alreadyCompressedIds - Optional set of message indices already
 *   covered by existing compression blocks.  Passed as a separate parameter
 *   because blocks.ts is being built in parallel.
 * @returns A compression plan with zero or more eligible segments.
 */
export function planCompression(
  messages: ContextMessageEntry[],
  config: CompressionConfig,
  alreadyCompressedIds?: Set<number>,
): CompressionPlanResult {
  if (messages.length === 0) return { segments: [] };

  // ── Step 1: Triple protection ───────────────────────────────────────
  const msgBoundary = protectedBoundary(messages, config.protectedMessages);
  const tokBoundary = tokenBoundary(messages, config.protectedTokens);
  const lastUserIdx = lastUserMessageIndex(messages);

  // More conservative (smaller index) = protects more messages.
  const protectionBoundary = Math.min(msgBoundary, tokBoundary, lastUserIdx);

  // ── Step 2: Build exclusion set ─────────────────────────────────────
  const excludedIndices = new Set<number>();

  // First user message is never eligible for compression.
  const firstUserIdx = firstUserMessageIndex(messages);
  if (firstUserIdx >= 0) excludedIndices.add(firstUserIdx);

  // Already-compressed message indices.
  if (alreadyCompressedIds) {
    for (const id of alreadyCompressedIds) {
      excludedIndices.add(id);
    }
  }

  // Ignored messages within the candidate range.
  for (let i = 0; i < protectionBoundary; i++) {
    if (isMessageIgnored(messages[i])) {
      excludedIndices.add(i);
    }
  }

  // ── Step 3: Build candidate index list ──────────────────────────────
  const candidateIndices: number[] = [];
  for (let i = 0; i < protectionBoundary; i++) {
    if (!excludedIndices.has(i)) {
      candidateIndices.push(i);
    }
  }

  // ── Step 4: Split into contiguous segments ──────────────────────────
  const rawSegments: CompressionSegment[] = [];
  let segStart = -1;
  for (let i = 0; i < candidateIndices.length; i++) {
    const idx = candidateIndices[i];
    if (segStart < 0) {
      segStart = idx;
    }
    if (
      i === candidateIndices.length - 1 ||
      candidateIndices[i + 1] !== idx + 1
    ) {
      rawSegments.push({
        startIndex: segStart,
        endIndex: idx + 1,
      });
      segStart = -1;
    }
  }

  // ── Step 5: Phantom gate + negative-benefit filter ──────────────────
  const segments: CompressionSegment[] = [];
  for (const seg of rawSegments) {
    const segTokens = estimateSegmentTokens(messages, seg);

    // Phantom gate: skip segments below the threshold.
    if (segTokens < config.thresholdTokens) continue;

    // Negative-benefit gate: compute a quick summary and compare tokens.
    const summaryText = buildBlockSummary(seg, messages);
    const summaryTokens = estimateTokenCount(summaryText);

    if (summaryTokens >= segTokens) continue;

    // Precompute input/output token split for downstream consumers.
    const { inTokens, outTokens } = segmentInOutTokens(messages, seg);

    segments.push({ ...seg, summary: summaryText, inTokens, outTokens });
  }

  return { segments };
}

// ---------------------------------------------------------------------------
// Summary extraction helpers
// ---------------------------------------------------------------------------

/** Minimal tool-part shape for extracting fields during summary building. */
interface PartWithToolFields {
  type: string;
  tool?: string;
  callID?: string;
  state?: {
    input?: unknown;
    output?: unknown;
    status?: string;
  };
  text?: string;
}

/**
 * Extract the text content from a user message (first text part).
 */
function extractUserText(msg: ContextMessageEntry): string {
  if (!msg.parts) return "";
  for (const part of msg.parts) {
    const p = part as { type?: string; text?: string };
    if (p.text) return p.text;
  }
  return "";
}

/**
 * Extract a `filePath` string from a tool part's `state.input`.
 */
function extractFilePath(part: unknown): string | null {
  const p = part as Record<string, unknown>;
  const state = p.state as Record<string, unknown> | undefined;
  if (!state) return null;
  const input = state.input;
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const record = input as Record<string, unknown>;
  const filePath = record.filePath;
  if (typeof filePath === "string") return filePath;
  return null;
}

/**
 * Extract a named field from a tool part's `state.input`.
 */
function extractInputField(part: unknown, field: string): unknown {
  const p = part as Record<string, unknown>;
  const state = p.state as Record<string, unknown> | undefined;
  if (!state) return undefined;
  const input = state.input;
  if (!input || typeof input !== "object" || Array.isArray(input))
    return undefined;
  const record = input as Record<string, unknown>;
  return record[field];
}

/**
 * Extract the question string from a question tool's input.
 *
 * Handles various input shapes: string, object with `question` field,
 * or array of strings/objects.
 */
function extractQuestionFromInput(input: unknown): string | null {
  if (!input) return null;
  if (typeof input === "string") return input;
  if (Array.isArray(input)) {
    if (input.length === 0) return null;
    const first = input[0];
    if (typeof first === "string") return first;
    if (first && typeof first === "object") {
      const f = first as Record<string, unknown>;
      const q = f.question;
      if (typeof q === "string") return q;
      const text = f.text;
      if (typeof text === "string") return text;
    }
    return null;
  }
  if (typeof input === "object") {
    const obj = input as Record<string, unknown>;
    const q = obj.question;
    if (typeof q === "string") return q;
    const text = obj.text;
    if (typeof text === "string") return text;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Segment in/out token estimation
// ---------------------------------------------------------------------------

/**
 * Sum estimated input and output tokens for a contiguous message segment.
 *
 * - Input tokens: user text + tool part inputs.
 * - Output tokens: assistant text + tool part outputs.
 *
 * Exported for use by the command orchestration layer (creates blocks).
 *
 * @returns `{ inTokens, outTokens }` — heuristic token estimates.
 */
export function segmentInOutTokens(
  messages: ContextMessageEntry[],
  segment: CompressionSegment,
): { inTokens: number; outTokens: number } {
  let inTokens = 0;
  let outTokens = 0;
  for (let mi = segment.startIndex; mi < segment.endIndex; mi++) {
    const msg = messages[mi];
    if (!msg.parts) continue;
    for (const part of msg.parts) {
      const p = part as PartWithToolFields;
      if (p.type === "tool" && p.state) {
        inTokens += estimateTokenCount(p.state.input);
        outTokens += estimateTokenCount(p.state.output);
      } else if (p.text) {
        if (msg.info?.role === "user") {
          inTokens += estimateTokenCount(p.text);
        } else if (msg.info?.role === "assistant") {
          outTokens += estimateTokenCount(p.text);
        } else {
          // System or other roles — count as input.
          inTokens += estimateTokenCount(p.text);
        }
      }
    }
  }
  return { inTokens, outTokens };
}

// ---------------------------------------------------------------------------
// Segment token estimation
// ---------------------------------------------------------------------------

/**
 * Estimate total heuristic tokens for a contiguous segment of messages.
 *
 * Used internally by the compression planner for phantom gating; the
 * command orchestration layer uses `segmentInOutTokens` instead so that
 * the stored `compressedTokens` and the user notification share a single
 * code path.
 *
 * @param messages - The full session messages array.
 * @param segment - The segment to estimate.
 * @returns Heuristic token count (sum of per-message estimates).
 */
export function estimateSegmentTokens(
  messages: ContextMessageEntry[],
  segment: CompressionSegment,
): number {
  let total = 0;
  for (let i = segment.startIndex; i < segment.endIndex; i++) {
    total += estimateMessageHeuristic(messages[i]);
  }
  return total;
}

// ---------------------------------------------------------------------------
// buildBlockSummary
// ---------------------------------------------------------------------------

/**
 * Build a deterministic mechanical summary for a segment of messages.
 *
 * The summary consists of a header followed by up to six information
 * blocks (only present when their data source exists in the segment):
 *
 * 1. **Header:** block id placeholder / message count / estimated in/out
 *    tokens.
 * 2. **User requests:** each user message text truncated to 80 characters.
 * 3. **Q&A records:** question-tool Q→A extraction (hardcoded; always
 *    included when question tool calls exist).
 * 4. **Tool statistics:** per-tool call counts, including error counts
 *    (non-completed status).
 * 5. **Task delegations:** `input.description` from task tool calls.
 * 6. **Files involved:** deduplicated, order-preserving, capped at 10.
 * 7. **Final progress:** last assistant text in the segment truncated to
 *    200 characters.
 *
 * @param segment - The segment to summarise.
 * @param messages - The full session messages array.
 * @returns A deterministic summary string.
 */
export function buildBlockSummary(
  segment: CompressionSegment,
  messages: ContextMessageEntry[],
): string {
  const lines: string[] = [];

  // Count messages in the segment.
  const msgCount = segment.endIndex - segment.startIndex;

  // ── 1. Header ─────────────────────────────────────────────────────
  const { inTokens, outTokens } = segmentInOutTokens(messages, segment);
  lines.push(
    `${BLOCK_HEADER_TEMPLATE} — ${msgCount} messages, ~${inTokens} in, ~${outTokens} out`,
  );

  // ── 2. User requests ──────────────────────────────────────────────
  const userRequests: string[] = [];
  for (let i = segment.startIndex; i < segment.endIndex; i++) {
    const msg = messages[i];
    if (msg.info?.role !== "user") continue;
    const text = extractUserText(msg);
    if (text) {
      const truncated = text.length > 80 ? `${text.slice(0, 80)}...` : text;
      userRequests.push(truncated);
    }
  }
  if (userRequests.length > 0) {
    lines.push("");
    lines.push("=== User Requests ===");
    for (const req of userRequests) {
      lines.push(`- ${req}`);
    }
  }

  // ── 3. Q&A Records ────────────────────────────────────────────────
  interface QAPair {
    question: string;
    answer: string;
  }
  const qaPairs: QAPair[] = [];
  for (let i = segment.startIndex; i < segment.endIndex; i++) {
    const msg = messages[i];
    if (!msg.parts) continue;
    for (const part of msg.parts) {
      const p = part as PartWithToolFields;
      if (p.type !== "tool" || p.tool !== "question") continue;
      const question = extractQuestionFromInput(p.state?.input);
      const answer = p.state?.output;
      if (question && answer != null) {
        qaPairs.push({
          question,
          answer: typeof answer === "string" ? answer : JSON.stringify(answer),
        });
      }
    }
  }
  if (qaPairs.length > 0) {
    lines.push("");
    lines.push("=== Q&A Records ===");
    for (const qa of qaPairs) {
      lines.push(`- Q: ${qa.question}`);
      lines.push(`  A: ${qa.answer}`);
    }
  }

  // ── 4. Tool Statistics ────────────────────────────────────────────
  const toolCounts = new Map<string, number>();
  const errorCounts = new Map<string, number>();
  for (let i = segment.startIndex; i < segment.endIndex; i++) {
    const msg = messages[i];
    if (!msg.parts) continue;
    for (const part of msg.parts) {
      const p = part as PartWithToolFields;
      if (p.type !== "tool") continue;
      const toolName = p.tool ?? "unknown";
      toolCounts.set(toolName, (toolCounts.get(toolName) ?? 0) + 1);
      if (p.state?.status && p.state.status !== "completed") {
        errorCounts.set(toolName, (errorCounts.get(toolName) ?? 0) + 1);
      }
    }
  }
  if (toolCounts.size > 0) {
    lines.push("");
    lines.push("=== Tool Statistics ===");
    // Sort by count descending.
    const sorted = [...toolCounts.entries()].sort((a, b) => b[1] - a[1]);
    for (const [tool, count] of sorted) {
      const errCount = errorCounts.get(tool) ?? 0;
      if (errCount > 0) {
        lines.push(`- ${tool}: ${count} (${errCount} errors)`);
      } else {
        lines.push(`- ${tool}: ${count}`);
      }
    }
  }

  // ── 5. Task Delegations ───────────────────────────────────────────
  const taskDescriptions: string[] = [];
  for (let i = segment.startIndex; i < segment.endIndex; i++) {
    const msg = messages[i];
    if (!msg.parts) continue;
    for (const part of msg.parts) {
      const p = part as PartWithToolFields;
      if (p.type !== "tool" || p.tool !== "task") continue;
      const desc = extractInputField(p, "description");
      if (desc && typeof desc === "string") {
        taskDescriptions.push(desc);
      }
    }
  }
  if (taskDescriptions.length > 0) {
    lines.push("");
    lines.push("=== Task Delegations ===");
    for (const desc of taskDescriptions) {
      lines.push(`- ${desc}`);
    }
  }

  // ── 6. Files Involved ─────────────────────────────────────────────
  const seenFiles = new Set<string>();
  const files: string[] = [];
  for (let i = segment.startIndex; i < segment.endIndex; i++) {
    const msg = messages[i];
    if (!msg.parts) continue;
    for (const part of msg.parts) {
      const p = part;
      if ((p as PartWithToolFields).type !== "tool") continue;
      const filePath = extractFilePath(p);
      if (filePath && !seenFiles.has(filePath)) {
        seenFiles.add(filePath);
        if (files.length < 10) {
          files.push(filePath);
        }
      }
    }
  }
  if (files.length > 0) {
    lines.push("");
    lines.push("=== Files Involved ===");
    for (const file of files) {
      lines.push(`- ${file}`);
    }
  }

  // ── 7. Final Progress ─────────────────────────────────────────────
  let lastAssistantText = "";
  for (let i = segment.endIndex - 1; i >= segment.startIndex; i--) {
    const msg = messages[i];
    if (msg.info?.role !== "assistant") continue;
    if (msg.parts) {
      for (let pi = msg.parts.length - 1; pi >= 0; pi--) {
        const part = msg.parts[pi] as { type?: string; text?: string };
        if (part.text) {
          lastAssistantText = part.text;
          break;
        }
      }
    }
    if (lastAssistantText) break;
  }
  if (lastAssistantText) {
    const truncated =
      lastAssistantText.length > 200
        ? `${lastAssistantText.slice(0, 200)}...`
        : lastAssistantText;
    lines.push("");
    lines.push("=== Final Progress ===");
    lines.push(truncated);
  }

  return lines.join("\n");
}
