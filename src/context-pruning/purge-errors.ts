/**
 * Purge-errors marking function for the context pruning subsystem.
 *
 * Called from runPipeline every turn. Scans errored tool results from TWO
 * sources and writes marks to `state.prune.tools` so that `prune.ts` can
 * replace them with placeholders on every turn.
 *
 * The TWO sources are:
 *   1. `state.errorTracking` — iterates tracked error entries and marks those
 *      beyond the `purgeErrorsTurns` turn threshold.
 *   2. Messages scan — iterates messages with toolResults and marks errors
 *      that are both beyond the protected turn window (last `config.turnProtection`
 *      assistant messages) and older than `config.purgeErrorsTurns`. This
 *      provides immediate functionality without waiting for the planned OpenCode
 *      hooks integration to populate `errorTracking`.
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
 * Mark errored tool calls in `state.prune.tools` for later placeholder
 * replacement by `prune.ts`.
 *
 * Algorithm:
 * 1. Return 0 immediately if `config.purgeErrorsEnabled` is `false`.
 * 2. **Source A (errorTracking):** For each tracked error entry, if it is
 *    beyond `config.purgeErrorsTurns` turns old and the tool is not
 *    protected, mark its `toolCallId` in `state.prune.tools`.
 * 3. **Source B (messages scan):** Iterate messages with toolResults,
 *    scanning only those beyond the protected turn window (last
 *    `config.turnProtection` assistant messages). For each errored tool
 *    result (`isError === true` or non-empty `error` string), mark its
 *    `toolCallId` if the tool is not protected, file paths are not protected,
 *    and the error is older than `config.purgeErrorsTurns`. Also record the
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

    // Skip entries within the protected turn window (recent turns)
    if (state.turnCount - entry.turnNumber <= state.protectedTurns) continue;

    // Skip if still within the purge-errors turns window (not old enough)
    if (state.turnCount - entry.turnNumber < config.purgeErrorsTurns) continue;

    // Mark for pruning: set toolCallId → current turn count
    state.prune.tools.set(toolCallId, state.turnCount);
    newMarkCount++;
  }

  // ── Source B: Messages scan ───────────────────────────────
  // Build lookups: toolCallId → toolName and toolCallId → parameters.
  const toolNameByCallId = new Map<string, string>();
  const toolParamsByCallId = new Map<string, Record<string, unknown>>();
  for (const msg of messages) {
    if (msg.toolCalls) {
      for (const tc of msg.toolCalls) {
        toolNameByCallId.set(tc.id, tc.toolName);
        toolParamsByCallId.set(tc.id, tc.parameters);
      }
    }
  }

  // Messages within the protected turn window are NOT scanned.
  // Only errors in messages older than this window are candidates for marking.
  // Heuristic: counts assistant messages from end (same as dedup.ts).
  // Phase 4 will use per-message turn numbers.
  let assistantCount = 0;
  let nonProtectedEnd = messages.length;
  for (
    let i = messages.length - 1;
    i >= 0 && assistantCount < config.turnProtection;
    i--
  ) {
    if (messages[i].role === "assistant") {
      assistantCount++;
    }
    nonProtectedEnd = i;
  }

  for (let i = 0; i < nonProtectedEnd; i++) {
    const msg = messages[i];
    // Scan any message with toolResults, regardless of role
    if (!msg.toolResults || msg.toolResults.length === 0) continue;

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

      // Check file path protection
      const params = toolParamsByCallId.get(tr.toolCallId);
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

      // Count assistant messages up to this tool result to determine
      // which turn the error actually occurred in.
      let turnsBeforeError = 0;
      for (let j = 0; j <= i; j++) {
        if (messages[j].role === "assistant") {
          turnsBeforeError++;
        }
      }

      // D18: Check error age — must be old enough per purgeErrorsTurns
      const errorAge = state.turnCount - turnsBeforeError;
      if (errorAge < config.purgeErrorsTurns) continue;

      // Mark for pruning
      state.prune.tools.set(tr.toolCallId, state.turnCount);
      newMarkCount++;

      // Record in errorTracking if not already there (so Source A can find
      // it on subsequent compress cycles)
      if (!state.errorTracking.has(tr.toolCallId)) {
        state.errorTracking.set(tr.toolCallId, {
          toolCallId: tr.toolCallId,
          toolName,
          turnNumber: turnsBeforeError,
          errorMessage: tr.error ?? "",
        });
      }
    }
  }

  return newMarkCount;
}
