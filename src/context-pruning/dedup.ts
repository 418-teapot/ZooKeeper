/**
 * Mark duplicate tool calls in session state for later pruning.
 *
 * Called from runPipeline every turn. Scans all historical tool calls,
 * identifies duplicates by signature, and writes toolCallIds to state.prune.tools
 * so that prune.ts (called every turn) can replace them with placeholders.
 *
 * @module
 */

import {
  getFilePathsFromParameters,
  isFilePathProtected,
  isToolNameProtected,
} from "./protected-patterns";
import type { ContextPruningConfig, MessageRef, SessionState } from "./types";

/**
 * Normalize parameters by sorting keys alphabetically.
 *
 * @param params - The parameters to normalize.
 * @returns A new object with deterministically ordered keys.
 */
function normalizeParams(
  params: Record<string, unknown>,
): Record<string, unknown> {
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(params).sort()) {
    sorted[key] = params[key];
  }
  return sorted;
}

/**
 * Build a deterministic signature from tool name and parameters.
 *
 * @param toolName   - The tool name.
 * @param parameters - The tool call parameters.
 * @returns A signature string suitable for duplicate comparison.
 */
function buildSignature(
  toolName: string,
  parameters: Record<string, unknown>,
): string {
  const normalized = normalizeParams(parameters);
  return `${toolName}::${JSON.stringify(normalized)}`;
}

/**
 * Mark duplicate tool calls in session state for later pruning.
 *
 * Scans all assistant messages for tool calls, identifies duplicates by
 * signature (toolName + normalized parameters), and writes the older
 * duplicate's toolCallId to state.prune.tools. The newest occurrence
 * of each duplicate signature is kept.
 *
 * Only assistant messages are scanned for tool calls. Protected tools
 * (listed in config.dedupProtectedTools) are skipped. Tool calls from
 * messages within the last `config.turnProtection` turns are also
 * protected from marking.
 *
 * The messages array is NOT mutated — only state.prune.tools and
 * state.dedupCache are written to.
 *
 * @param state    - The session state to write prune markers into.
 * @param config   - Context pruning configuration.
 * @param messages - The messages to scan (not mutated).
 * @returns The number of newly marked tool call entries in state.prune.tools.
 */
export function markDuplicates(
  state: SessionState,
  config: ContextPruningConfig,
  messages: MessageRef[],
): number {
  if (!config.dedupEnabled) return 0;

  let newlyMarked = 0;

  // ── Protected turn guard ──────────────────────────────
  // Do NOT mark tool calls from messages that fall within the last
  // config.turnProtection turns.
  //
  // Heuristic: counts assistant messages from end to estimate turn
  // boundary.  This does not handle multi-assistant turns correctly.
  // Phase 4 will track per-message turn numbers.
  let protectedAssistantCount = 0;
  let cutoffIndex = messages.length;
  for (
    let i = messages.length - 1;
    i >= 0 && protectedAssistantCount < config.turnProtection;
    i--
  ) {
    if (messages[i].role === "assistant") {
      protectedAssistantCount++;
    }
    if (protectedAssistantCount <= config.turnProtection) {
      cutoffIndex = i;
    }
  }

  // ── Scan messages oldest to newest ────────────────────
  // Map: signature → toolCallId (always the newest seen so far)
  const seen = new Map<string, string>();

  for (let msgIdx = 0; msgIdx < messages.length; msgIdx++) {
    const msg = messages[msgIdx];

    // Only assistant messages have tool calls
    if (
      msg.role !== "assistant" ||
      !msg.toolCalls ||
      msg.toolCalls.length === 0
    ) {
      continue;
    }

    for (const tc of msg.toolCalls) {
      // Skip protected tools
      if (isToolNameProtected(tc.toolName, config.dedupProtectedTools)) {
        continue;
      }

      // Skip tool calls that touch protected file paths
      const filePaths = getFilePathsFromParameters(tc.parameters);
      if (
        filePaths.some((fp) =>
          isFilePathProtected(fp, config.protectedFilePatterns),
        )
      ) {
        continue;
      }

      // Skip tool calls from protected (recent) turns
      if (msgIdx >= cutoffIndex) {
        continue;
      }

      const sig = buildSignature(tc.toolName, tc.parameters);

      // Record in dedup cache for all non-protected tool calls
      if (!state.dedupCache.has(sig)) {
        state.dedupCache.set(sig, {
          toolName: tc.toolName,
          signature: sig,
          firstSeenAt: msg.id,
          latestSeenAt: msg.id,
          callCount: 1,
        });
      }

      const existing = seen.get(sig);

      if (existing !== undefined) {
        // Duplicate detected — mark the OLDER call (the one in `seen`).
        // Only count as newly marked if it wasn't already in the map.
        if (!state.prune.tools.has(existing)) {
          newlyMarked++;
        }
        const tokenEstimate = Math.ceil(
          JSON.stringify(tc.parameters).length / 4,
        );
        state.prune.tools.set(existing, tokenEstimate);

        // Update dedup cache
        const entry = state.dedupCache.get(sig);
        if (!entry) continue; // shouldn't happen — we just set it above
        entry.callCount++;
        entry.latestSeenAt = msg.id;

        // Update `seen` to point to the NEWER call (current one survives)
        seen.set(sig, tc.id);
      } else {
        // First occurrence — add to seen map
        seen.set(sig, tc.id);
      }
    }
  }

  return newlyMarked;
}
