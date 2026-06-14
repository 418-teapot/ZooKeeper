/**
 * Apply pruning marks to messages — replaces tool outputs/errors with placeholder
 * strings for tool calls that have been marked for pruning in state.prune.tools.
 *
 * Split architecture:
 *   compress-time: markDuplicates/markPurgeErrors write to state.prune.tools
 *   every-turn:    applyPruning reads those marks and replaces message content
 *
 * The marks survive across turns (state is persistent) so that every call to
 * runPipeline can perform the replacements.
 *
 * @module
 */

import type { MessageRef, SessionState, ToolResultRef } from "./types";

/**
 * Apply pruning to messages — replaces tool outputs/errors with placeholder
 * strings when the toolCallId exists in state.prune.tools.
 *
 * Called every turn from runPipeline (not just at compress-time).
 * The function is idempotent: already-replaced placeholders are not
 * double-processed.
 *
 * @param state - The session state containing prune marks (state.prune.tools).
 * @param messages - The messages to prune in place (outer array is reused).
 * @returns The same messages array (mutated) plus counts of replacements.
 */
export function applyPruning(
  state: SessionState,
  messages: MessageRef[],
): { messages: MessageRef[]; prunedOutputs: number; prunedErrors: number } {
  const { tools } = state.prune;

  // Early return when there are no marks to apply
  if (tools.size === 0) {
    return { messages, prunedOutputs: 0, prunedErrors: 0 };
  }

  // Build a lookup: toolCallId → toolName by scanning all messages for
  // matching ToolCallRef entries. This avoids linear scan per replacement.
  const toolNameById = new Map<string, string>();
  for (const msg of messages) {
    if (msg.toolCalls) {
      for (const tc of msg.toolCalls) {
        toolNameById.set(tc.id, tc.toolName);
      }
    }
  }

  let prunedOutputs = 0;
  let prunedErrors = 0;

  for (const msg of messages) {
    if (!msg.toolResults || msg.toolResults.length === 0) {
      continue;
    }

    let changed = false;
    const newResults: ToolResultRef[] = [];

    for (const tr of msg.toolResults) {
      if (!tools.has(tr.toolCallId)) {
        // Not marked for pruning — keep as-is
        newResults.push(tr);
        continue;
      }

      // Look up tool name (moved before both tool-type and idempotency checks)
      const toolName = toolNameById.get(tr.toolCallId) ?? "unknown";

      // ── Skip question/edit/write tools ────────────────
      // Their outputs are user-visible and should not be pruned.
      if (["question", "edit", "write"].includes(toolName)) {
        newResults.push(tr);
        continue;
      }

      // ── Idempotency ──────────────────────────────────
      // If this toolCallId was already pruned in a previous turn, skip it.
      // Uses the prunedCallIds Set instead of checking output content,
      // which would break on JSON strings containing the placeholder prefix.
      if (state.prune.prunedCallIds.has(tr.toolCallId)) {
        newResults.push(tr);
        continue;
      }

      if (tr.isError) {
        // Error result — replace both output and error, count as error prune
        const replacement: ToolResultRef = {
          id: tr.id,
          toolCallId: tr.toolCallId,
          output: `[pruned: tool output removed — ${toolName}]`,
          isError: true,
          error: `[pruned: failed tool call — ${toolName}]`,
        };
        newResults.push(replacement);
        prunedErrors++;

        // Also replace tool call parameters for errored tools
        if (msg.toolCalls) {
          for (const tc of msg.toolCalls) {
            if (tc.id === tr.toolCallId) {
              tc.parameters = { pruned: true, reason: `[input removed — failed tool call: ${toolName}]` };
            }
          }
        }
      } else {
        // Non-error result — replace only output, count as output prune
        const replacement: ToolResultRef = {
          id: tr.id,
          toolCallId: tr.toolCallId,
          output: `[pruned: tool output removed — ${toolName}]`,
        };
        newResults.push(replacement);
        prunedOutputs++;
      }

      state.prune.prunedCallIds.add(tr.toolCallId);
      changed = true;
    }

    if (changed) {
      // Replace the entire toolResults array with new objects to avoid
      // mutable aliasing issues.
      msg.toolResults = newResults;
    }
  }

  return { messages, prunedOutputs, prunedErrors };
}
