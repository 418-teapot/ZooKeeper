/**
 * Purge-errors marking function for the context pruning subsystem.
 *
 * This is a compress-time marking function called during `prepareSession()`.
 * It scans errored tool results from TWO sources and writes marks to
 * `state.prune.tools` so that `prune.ts` can replace them with placeholders
 * on every turn.
 *
 * The TWO sources are:
 *   1. `state.errorTracking` — iterates tracked error entries and marks those
 *      beyond the `purgeErrorsTurns` turn threshold.
 *   2. Messages scan — iterates tool-result messages and marks errors beyond
 *      the protected message window (`config.turnProtection * 4` from end).
 *      This provides immediate functionality without waiting for the planned
 *      OpenCode hooks integration to populate `errorTracking`.
 *
 * @module
 */

import { isToolNameProtected } from "./protected-patterns";
import type { ContextPruningConfig, MessageRef, SessionState } from "./types";

/**
 * Mark errored tool calls in `state.prune.tools` for later placeholder
 * replacement by `prune.ts`.
 *
 * Algorithm:
 * 1. Return 0 immediately if `config.purgeErrorsEnabled` is `false`.
 * 2. **Source A (errorTracking):** For each tracked error entry, if it is
 *    beyond `config.purgeErrorsTurns` turns old and the tool is not
 *    protected, mark its `toolCallId` in `state.prune.tools`.
 * 3. **Source B (messages scan):** Iterate tool-role messages older than the
 *    protected window (last `config.turnProtection * 4` messages). For each
 *    errored tool result (`isError === true` or non-empty `error` string),
 *    mark its `toolCallId` if the tool is not protected. Also record the
 *    entry in `state.errorTracking` if not already present.
 * 4. Return the count of **newly** marked entries (those not already in
 *    `state.prune.tools`).
 *
 * The `messages` array is NOT mutated. Only `state.prune.tools` (and
 * `state.errorTracking` for new entries from Source B) are written to.
 *
 * @param state - Session state whose `prune.tools` map receives marks.
 * @param config - Context pruning configuration with purge-errors settings.
 * @param messages - Message array (read-only — not mutated).
 * @returns Number of newly marked tool call IDs.
 */
export function markPurgeErrors(
  state: SessionState,
  config: ContextPruningConfig,
  messages: MessageRef[],
): number {
  if (!config.purgeErrorsEnabled) return 0;

  let newMarkCount = 0;

  // ── Source A: state.errorTracking ──────────────────────────
  // Iterate all tracked errors and mark those beyond the turn threshold.
  for (const [toolCallId, entry] of state.errorTracking) {
    // Skip protected tools
    if (isToolNameProtected(entry.toolName, config.purgeErrorsProtectedTools))
      continue;

    // Skip if already marked
    if (state.prune.tools.has(toolCallId)) continue;

    // Skip if still within the purge-errors turns window (not old enough)
    if (state.turnCount - entry.turnNumber < config.purgeErrorsTurns) continue;

    // Mark for pruning: set toolCallId → current turn count
    state.prune.tools.set(toolCallId, state.turnCount);
    newMarkCount++;
  }

  // ── Source B: Messages scan ───────────────────────────────
  // Build a lookup: toolCallId → toolName for all tool calls in messages.
  const toolNameByCallId = new Map<string, string>();
  for (const msg of messages) {
    if (msg.toolCalls) {
      for (const tc of msg.toolCalls) {
        toolNameByCallId.set(tc.id, tc.toolName);
      }
    }
  }

  // Messages within the protected window (last N messages) are NOT scanned.
  // Only errors in messages older than this window are candidates for marking.
  const protectedWindowSize = config.turnProtection * 4;
  const nonProtectedEnd = Math.max(0, messages.length - protectedWindowSize);

  for (let i = 0; i < nonProtectedEnd; i++) {
    const msg = messages[i];
    if (msg.role !== "tool" || !msg.toolResults) continue;

    for (const tr of msg.toolResults) {
      // Check if this is an error result
      const isError =
        tr.isError === true ||
        (typeof tr.error === "string" && tr.error.length > 0);
      if (!isError) continue;

      // Skip if already marked (from Source A or a previous call)
      if (state.prune.tools.has(tr.toolCallId)) continue;

      // Get tool name from the lookup and check protection
      const toolName = toolNameByCallId.get(tr.toolCallId) ?? "";
      if (isToolNameProtected(toolName, config.purgeErrorsProtectedTools))
        continue;

      // Mark for pruning
      state.prune.tools.set(tr.toolCallId, state.turnCount);
      newMarkCount++;

      // Record in errorTracking if not already there (so Source A can find
      // it on subsequent compress cycles)
      if (!state.errorTracking.has(tr.toolCallId)) {
        state.errorTracking.set(tr.toolCallId, {
          toolCallId: tr.toolCallId,
          toolName,
          turnNumber: state.turnCount,
          errorMessage: tr.error ?? "",
        });
      }
    }
  }

  return newMarkCount;
}
