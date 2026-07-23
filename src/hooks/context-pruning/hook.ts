/**
 * Context pruning transform handler — the sweep phase entry point.
 *
 * Called from the `experimental.chat.messages.transform` hook.
 * Reads `state.prune.tools` (set by a previous `/dcp sweep` command)
 * and replaces marked tool outputs with the placeholder text.
 *
 * @module
 */

import type { ContextMessageEntry } from "../../core/metrics.js";
import { pruneToolOutputs } from "../../core/pruning/prune.js";
import {
  getOrCreateSessionState,
  saveSessionState,
} from "../../core/pruning/state.js";
import { log } from "../../utils/logger.js";

/**
 * Handle the messages.transform hook for context pruning.
 *
 * 1. Extracts session ID from the first user message.
 * 2. Gets or creates session state (a new session ID naturally creates
 *    a fresh state via the map key — no explicit reset needed).
 * 3. Early-returns when the prune map is empty.
 * 4. Calls `pruneToolOutputs` to replace marked tool outputs.
 *
 * Does NOT catch errors — the caller (opencode.ts) wraps this in
 * try/catch so a pruning failure never disrupts the LLM turn.
 *
 * @param messages - The session messages array from the transform output.
 */
export function contextPruningTransformHandler(
  messages: ContextMessageEntry[] | null | undefined,
): void {
  if (!messages || messages.length === 0) return;

  // Extract session ID from the first message.
  const firstMsg = messages[0];
  const sessionId = firstMsg?.info?.sessionID;
  if (!sessionId) return;

  // Get or create state — new session ID naturally creates fresh state.
  const state = getOrCreateSessionState(sessionId);

  // If no marks exist, nothing to do.
  if (state.prune.tools.size === 0) return;

  // Snapshot the marked callIDs for the diagnostic log.
  const markedCallIDs: string[] = [...state.prune.tools.keys()];

  // Perform the prune (mutates messages in place).
  const replacedOutputs = pruneToolOutputs(state, messages);

  // Persist to disk only when state has been dirtied since the last
  // save.  saveSessionState already catches all errors internally.
  if (state.dirty) {
    saveSessionState(sessionId, state);
    state.dirty = false;
  }

  log("context-pruning", "prune_completed", sessionId, undefined, "info", {
    prunedToolCount: markedCallIDs.length,
    totalPruneTokens: state.stats.totalPruneTokens,
  });

  if (replacedOutputs.length > 0) {
    log("context-pruning", "prune_detail", sessionId, undefined, "info", {
      markedCallIDs,
      replacedOutputs,
    });
  }
}
