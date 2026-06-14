/**
 * Slash command handlers for /dcp context|stats|sweep|decompress|recompress.
 *
 * Framework-agnostic: each handler receives a {@link CommandContext} and
 * returns a string (the response message). The adapter layer (hook.ts)
 * handles actual message sending.
 *
 * @module
 */

import { estimateTokens } from "./estimator";
import { saveSessionState } from "./persist";
import { syncCompressionBlocks } from "./pipeline";
import {
  getFilePathsFromParameters,
  isFilePathProtected,
  isToolNameProtected,
} from "./protected-patterns";
import type {
  CompressionBlock,
  ContextPruningConfig,
  MessageRef,
  SessionState,
} from "./types";

// ── Command context ─────────────────────────────────────────

export interface CommandContext {
  sessionId: string;
  state: SessionState;
  config: ContextPruningConfig;
  messages: MessageRef[];
  args: string[];
  workingDirectory?: string;
}

// ── Format helpers ──────────────────────────────────────────

const UNITS = ["K", "M", "B"];

/**
 * Format a token count for human display (e.g. "12.5K", "1.2M").
 *
 * @param tokens - Raw token count.
 * @returns Formatted string with one decimal place and a unit suffix.
 */
export function formatTokenCount(tokens: number): string {
  if (tokens < 1_000) return String(tokens);
  let value = tokens;
  let unit = "";
  for (const u of UNITS) {
    value /= 1_000;
    if (value < 1_000) {
      unit = u;
      break;
    }
  }
  // Handle ≥ 1000B gracefully
  if (!unit) unit = "B";
  // Always show one decimal for readability
  return `${value.toFixed(1)}${unit}`;
}

/**
 * Build a compact list of pruned tool names with their token savings.
 *
 * @param items - Array of { toolName, tokens } pairs.
 * @returns Formatted string like "read (1.2K), bash (3.0K)".
 */
export function formatPrunedItemsList(
  items: Array<{ toolName: string; tokens: number }>,
): string {
  if (items.length === 0) return "none";
  return items
    .map((i) => `${i.toolName} (${formatTokenCount(i.tokens)})`)
    .join(", ");
}

// ── Command handlers ───────────────────────────────────────

/**
 * /dcp context — show per-role token breakdown as a visual bar chart.
 */
function handleContext(ctx: CommandContext): string {
  const { messages, state } = ctx;

  // Categorize estimated tokens per role
  let systemTokens = 0;
  let userTokens = 0;
  let assistantTokens = 0;
  let toolTokens = 0;

  for (const msg of messages) {
    const t = estimateTokens(msg.content);
    switch (msg.role) {
      case "system":
        systemTokens += t;
        break;
      case "user":
        userTokens += t;
        break;
      case "assistant":
        assistantTokens += t;
        break;
      case "tool":
        toolTokens += t;
        break;
    }
    // Tool results in tool-role messages
    if (msg.toolResults) {
      for (const tr of msg.toolResults) {
        toolTokens += estimateTokens(tr.output);
        if (tr.error) toolTokens += estimateTokens(tr.error);
      }
    }
  }

  const total = systemTokens + userTokens + assistantTokens + toolTokens;
  const barWidth = 20;

  /** Render a single role row with label, bar, and token count. */
  function row(label: string, tokens: number): string {
    const barLen = total > 0 ? Math.round((tokens / total) * barWidth) : 0;
    const filled = "█".repeat(Math.min(barLen, barWidth));
    const empty = "░".repeat(Math.max(barWidth - barLen, 0));
    const pct = total > 0 ? ((tokens / total) * 100).toFixed(1) : "0.0";
    return `${label.padEnd(12)} ${filled}${empty} ${formatTokenCount(tokens).padStart(7)} (${pct}%)`;
  }

  const lines: string[] = [
    "╭─ Context Token Breakdown ─────────────────────────────╮",
    row("System", systemTokens),
    row("User", userTokens),
    row("Assistant", assistantTokens),
    row("Tools", toolTokens),
    "├────────────────────────────────────────────────────────┤",
    `Total${"".padEnd(9)} ${formatTokenCount(total).padStart(7)} (100%)`,
  ];

  // Pruned tokens
  if (state.totalPrunedTokens > 0) {
    lines.push(
      `Pruned${"".padEnd(9)} ${formatTokenCount(state.totalPrunedTokens).padStart(7)}`,
    );
  }

  lines.push("╰────────────────────────────────────────────────────────╯");
  return lines.join("\n");
}

/**
 * /dcp stats — show compression and pruning statistics.
 */
function handleStats(ctx: CommandContext): string {
  const { state } = ctx;

  // Count active compression blocks
  let activeBlocks = 0;
  let totalCompressedTokens = 0;
  let totalSummaryTokens = 0;

  for (const block of state.blocksById.values()) {
    if (block.active) {
      activeBlocks++;
      totalCompressedTokens += block.compressedTokens;
      totalSummaryTokens += block.summaryTokens;
    }
  }

  const savings = totalCompressedTokens - totalSummaryTokens;
  const ratio =
    totalSummaryTokens > 0
      ? (totalCompressedTokens / totalSummaryTokens).toFixed(1)
      : "—";

  const lines: string[] = [
    "╭─ Compression Statistics ──────────────────────────────╮",
    `  Active blocks        ${String(activeBlocks).padStart(5)}`,
    `  Total pruned         ${formatTokenCount(state.totalPrunedTokens).padStart(8)}`,
    `  Compressed tokens    ${formatTokenCount(totalCompressedTokens).padStart(8)}`,
    `  Summary tokens       ${formatTokenCount(totalSummaryTokens).padStart(8)}`,
    `  Net savings          ${formatTokenCount(Math.max(0, savings)).padStart(8)}`,
    `  Compression ratio    ${ratio.padStart(5)}×`,
    "╰────────────────────────────────────────────────────────╯",
  ];

  return lines.join("\n");
}

/**
 * /dcp sweep [N] — prune tool outputs from messages.
 */
function handleSweep(ctx: CommandContext): string {
  const { state, config, messages, args } = ctx;

  // Parse optional N argument (number of tool calls to sweep)
  const n = args[0] !== undefined ? Number.parseInt(args[0], 10) : undefined;
  if (n !== undefined && (Number.isNaN(n) || n < 1)) {
    return "Usage: `/dcp sweep [N]` — N must be a positive integer.";
  }

  // Collect tool results eligible for pruning
  const candidates: Array<{
    messageIdx: number;
    toolCallId: string;
    toolName: string;
    params: Record<string, unknown>;
    estimatedTokens: number;
  }> = [];

  // Build tool name and params lookup
  const toolNameById = new Map<string, string>();
  const toolParamsById = new Map<string, Record<string, unknown>>();
  for (const msg of messages) {
    if (msg.toolCalls) {
      for (const tc of msg.toolCalls) {
        toolNameById.set(tc.id, tc.toolName);
        toolParamsById.set(tc.id, tc.parameters);
      }
    }
  }

  // Scan messages for tool results
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (!msg.toolResults) continue;

    for (const tr of msg.toolResults) {
      const toolName = toolNameById.get(tr.toolCallId) ?? "unknown";

      // Skip already-pruned
      if (state.prune.prunedCallIds.has(tr.toolCallId)) continue;

      // Skip protected tools
      if (isToolNameProtected(toolName, config.protectedTools)) continue;

      // Skip protected file paths
      const params = toolParamsById.get(tr.toolCallId);
      if (params) {
        const filePaths = getFilePathsFromParameters(params);
        if (
          filePaths.some((fp) =>
            isFilePathProtected(fp, config.protectedFilePatterns),
          )
        ) {
          continue;
        }
      }

      const estimated = estimateTokens(tr.output);
      candidates.push({
        messageIdx: i,
        toolCallId: tr.toolCallId,
        toolName,
        params: params ?? {},
        estimatedTokens: estimated,
      });
    }
  }

  // ── Determine which candidates to prune ─────────────────────
  let toPrune: typeof candidates;
  if (n !== undefined) {
    // Specific N: take last N tool outputs (scan backward)
    toPrune = candidates.slice(-n);
  } else {
    // Default: sweep tool results that appear after the last user message
    const lastUserIdx = messages.reduceRight(
      (idx, m, i) => (idx === -1 && m.role === "user" ? i : idx),
      -1,
    );
    if (lastUserIdx === -1) {
      return "No user message found — nothing to sweep.";
    }
    toPrune = candidates.filter((c) => c.messageIdx > lastUserIdx);
  }

  if (toPrune.length === 0) {
    return "No tool outputs available to sweep.";
  }

  // Mark in state
  let totalSavings = 0;
  const items: Array<{ toolName: string; tokens: number }> = [];
  for (const c of toPrune) {
    state.prune.tools.set(c.toolCallId, state.turnCount);
    state.prune.prunedCallIds.add(c.toolCallId);
    state.totalPrunedTokens += c.estimatedTokens;
    totalSavings += c.estimatedTokens;
    items.push({ toolName: c.toolName, tokens: c.estimatedTokens });
  }

  // Persist state changes so they survive a restart
  saveSessionState(state);

  return (
    `Swept ${toPrune.length} tool output(s). Total savings: ${formatTokenCount(totalSavings)}\n` +
    `Pruned: ${formatPrunedItemsList(items)}`
  );
}

/**
 * /dcp decompress [N] — list or restore previously compressed blocks.
 */
function handleDecompress(ctx: CommandContext): string {
  const { state, args } = ctx;

  // ── List available active blocks ──────────────────────────
  if (args.length === 0) {
    const active: CompressionBlock[] = [];
    for (const block of state.blocksById.values()) {
      if (block.active) active.push(block);
    }

    if (active.length === 0) return "No active compression blocks found.";

    const lines: string[] = [
      "╭─ Active Compression Blocks ──────────────────────────╮",
    ];
    for (const b of active) {
      const compressed = formatTokenCount(b.compressedTokens);
      const summary = formatTokenCount(b.summaryTokens);
      lines.push(
        `  #${String(b.blockId).padStart(3)}  ${b.topic.padEnd(30)} ${compressed.padStart(7)} → ${summary.padStart(5)}`,
      );
    }
    lines.push("╰────────────────────────────────────────────────────────╯");
    lines.push("Usage: `/dcp decompress <blockId>` to restore a block.");
    return lines.join("\n");
  }

  // ── Deactivate a specific block ───────────────────────────
  const blockId = Number.parseInt(args[0], 10);
  if (Number.isNaN(blockId) || blockId < 1) {
    return "Usage: `/dcp decompress <blockId>` — blockId must be a positive integer.";
  }

  const block = state.blocksById.get(blockId);
  if (!block) return `Block #${blockId} not found.`;

  if (!block.active) return `Block #${blockId} is already inactive.`;

  // BFS through entire ancestor chain — if ANY ancestor is active,
  // prevent decompression (the ancestor's compressed representation
  // depends on this block).
  if (block.parentBlockIds.length > 0) {
    const visited = new Set<number>();
    const queue = [...block.parentBlockIds];
    let anyAncestorActive = false;
    while (queue.length > 0) {
      const pid = queue.shift();
      if (pid === undefined) break;
      if (visited.has(pid)) continue;
      visited.add(pid);
      const parentBlock = state.blocksById.get(pid);
      if (parentBlock?.active) {
        anyAncestorActive = true;
        break;
      }
      if (parentBlock && parentBlock.parentBlockIds.length > 0) {
        queue.push(...parentBlock.parentBlockIds);
      }
    }
    if (anyAncestorActive) {
      return (
        `Block #${blockId} has an active ancestor block. ` +
        `Decompress ancestor blocks first.`
      );
    }
  }

  // Deactivate: mark block inactive and user-deactivated
  block.active = false;
  block.deactivatedByUser = true;
  block.deactivatedAt = Date.now();

  // Restore message IDs — remove dcp_c prefix from messages owned by this block
  let restoredCount = 0;
  for (const msgId of block.effectiveMessageIds) {
    const entry = state.byMessageId.get(msgId);
    if (entry) {
      entry.activeBlockIds = entry.activeBlockIds.filter(
        (id) => id !== blockId,
      );
      if (entry.activeBlockIds.length === 0) restoredCount++;
    }
  }

  state.activeBlockIds.delete(blockId);
  state.activeByAnchorMessageId.delete(block.anchorMessageId);

  // Decrement pruned token count since decompression restores messages
  // that were previously accounted as pruned.
  state.totalPrunedTokens = Math.max(
    0,
    state.totalPrunedTokens - block.compressedTokens,
  );

  // Sync compression blocks after deactivation to ensure consistency
  // (handles cascading deactivations and byMessageId cleanup).
  syncCompressionBlocks(state, ctx.messages);

  // Persist state changes so compression state survives a restart
  saveSessionState(state);

  const msgWord = restoredCount === 1 ? "message" : "messages";
  return (
    `Decompressed block #${blockId} "${block.topic}". ` +
    `Restored ${restoredCount} ${msgWord}, saving ~${formatTokenCount(block.summaryTokens)} tokens.`
  );
}

/**
 * /dcp recompress [N] — re-compress blocks previously decompressed by user.
 */
function handleRecompress(ctx: CommandContext): string {
  const { state, args } = ctx;

  // ── List user-decompressed blocks ─────────────────────────
  if (args.length === 0) {
    const inactive: CompressionBlock[] = [];
    for (const block of state.blocksById.values()) {
      if (!block.active && block.deactivatedByUser) inactive.push(block);
    }

    if (inactive.length === 0) return "No user-decompressed blocks available.";

    const lines: string[] = [
      "╭─ Available for Re-compression ───────────────────────╮",
    ];
    for (const b of inactive) {
      lines.push(
        `  #${String(b.blockId).padStart(3)}  ${b.topic.padEnd(30)} (was ${formatTokenCount(b.compressedTokens)} compressed)`,
      );
    }
    lines.push("╰────────────────────────────────────────────────────────╯");
    lines.push("Usage: `/dcp recompress <blockId>` to re-compress.");
    return lines.join("\n");
  }

  // ── Re-activate a specific block ──────────────────────────
  const blockId = Number.parseInt(args[0], 10);
  if (Number.isNaN(blockId) || blockId < 1) {
    return "Usage: `/dcp recompress <blockId>` — blockId must be a positive integer.";
  }

  const block = state.blocksById.get(blockId);
  if (!block) return `Block #${blockId} not found.`;

  if (block.active) return `Block #${blockId} is already active.`;
  if (!block.deactivatedByUser) {
    return `Block #${blockId} was not decompressed by user — it was superseded internally.`;
  }

  // Check if the origin message still exists in the current messages.
  // We look for actual message IDs matching the block's anchor or
  // compress message — the dcp_c prefix on a message ID means it was
  // created by compression itself, not the original source content.
  const originExists = ctx.messages.some(
    (m) => m.id === block.compressMessageId || m.id === block.anchorMessageId,
  );

  if (!originExists) {
    return (
      `Block #${blockId} cannot be re-compressed — its origin message ` +
      `("${block.compressMessageId}") no longer exists in context.`
    );
  }

  // Re-activate
  block.active = true;
  block.deactivatedByUser = false;
  delete block.deactivatedAt;

  state.activeBlockIds.add(blockId);
  state.activeByAnchorMessageId.set(block.anchorMessageId, blockId);

  // Re-register message IDs
  for (const msgId of block.effectiveMessageIds) {
    const entry = state.byMessageId.get(msgId);
    if (entry) {
      if (!entry.activeBlockIds.includes(blockId)) {
        entry.activeBlockIds.push(blockId);
      }
      if (!entry.allBlockIds.includes(blockId)) {
        entry.allBlockIds.push(blockId);
      }
    }
  }

  // Increment pruned token count since re-compression prunes these
  // messages again.
  state.totalPrunedTokens += block.compressedTokens;

  // Sync compression blocks after re-activation to ensure consistency
  // (handles cascading reactivations and byMessageId cleanup).
  syncCompressionBlocks(state, ctx.messages);

  // Persist state changes so compression state survives a restart
  saveSessionState(state);

  return (
    `Re-compressed block #${blockId} "${block.topic}". ` +
    `Saving ${formatTokenCount(block.compressedTokens)} tokens.`
  );
}

// ── Dispatch ────────────────────────────────────────────────

/**
 * Dispatch a /dcp subcommand to the appropriate handler.
 *
 * @param subcommand - The subcommand name (e.g. "context", "stats").
 * @param ctx - The command execution context.
 * @returns The response string, or `null` if the subcommand is unknown.
 */
export function dispatchCommand(
  subcommand: string,
  ctx: CommandContext,
): string | null {
  switch (subcommand) {
    case "context":
      return handleContext(ctx);
    case "stats":
      return handleStats(ctx);
    case "sweep":
      return handleSweep(ctx);
    case "decompress":
      return handleDecompress(ctx);
    case "recompress":
      return handleRecompress(ctx);
    default:
      return null;
  }
}
