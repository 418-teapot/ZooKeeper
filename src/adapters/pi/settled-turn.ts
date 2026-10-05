/**
 * Pi host adapter — settled-turn analysis for the pre-settle loop judge.
 *
 * The `agent_before_settle` boundary carries no transcript, so the loop
 * judge reconstructs the settled turn from the messages `agent_end`
 * recorded and derives its activity facts: how many tool calls the turn
 * issued, whether an `ask` parked on a headless `no-ui` slot, and pi's own
 * activity outcome.  These helpers read pi's duck-typed message shapes
 * without importing any pi package, and every payload is untrusted — a
 * malformed entry is skipped so the caller keeps its fail-closed verdict.
 *
 * @module
 */

import type { PiBoundaryResult } from "./types.js";

/** Message roles that start a fresh conversational turn. */
const TURN_BOUNDARY_ROLES: ReadonlySet<string> = new Set(["user", "custom"]);

/** The string `role` of a pi message, or `undefined` for a non-message. */
function messageRole(message: unknown): string | undefined {
  if (message === null || typeof message !== "object") return undefined;
  const role = (message as { role?: unknown }).role;
  return typeof role === "string" ? role : undefined;
}

/**
 * Slice the settled turn out of a run's messages.
 *
 * A turn starts right after the most recent boundary message — a
 * `user` message (a real prompt) or a `custom` message (an injected
 * follow-up such as the loop wake itself).  Everything after it
 * is the run the judge is asked about; with no boundary the whole array
 * is the turn.  Only the LAST boundary is honoured, so a multi-turn
 * transcript still resolves to the final run.
 *
 * @param messages - The `agent_end` payload's message array.
 * @returns The messages belonging to the settled turn.
 */
export function settledTurnMessages(messages: readonly unknown[]): unknown[] {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const role = messageRole(messages[i]);
    if (role !== undefined && TURN_BOUNDARY_ROLES.has(role)) {
      return messages.slice(i + 1);
    }
  }
  return messages.slice();
}

/**
 * Count the well-formed tool calls the settled turn issued.
 *
 * Walks every assistant message's content parts, counting each
 * well-formed `toolCall` part; tool names are never inspected further.
 * Non-assistant messages, non-object parts, and malformed calls are
 * skipped.
 *
 * @param messages - The settled turn's messages.
 * @returns The number of observed tool calls.
 */
export function countTurnToolCalls(messages: readonly unknown[]): number {
  let count = 0;
  for (const message of messages) {
    if (messageRole(message) !== "assistant") continue;
    const content = (message as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (part === null || typeof part !== "object") continue;
      const candidate = part as { type?: unknown; name?: unknown };
      if (candidate.type !== "toolCall" || typeof candidate.name !== "string") {
        continue;
      }
      count++;
    }
  }
  return count;
}

/**
 * Whether the settled turn's ask tool result went unanswered headlessly.
 *
 * In a non-TUI host (print / RPC / json mode) the ask tool cannot draw
 * its dialog, so instead of blocking it resolves every question with the
 * system-side `{ status: "unavailable", reason: "no-ui" }` slot.  The
 * agent therefore asked the user something no human could answer: the
 * run must stop so the user reads the question after the process exits
 * rather than auto-continuing into possibly-unwanted work.
 *
 * Scans the turn's `toolResult` messages for the `ask` tool and reads
 * the STRUCTURED `details` (`{ questions: [{ result }] }`) rather than
 * the rendered text, which is only a display rendering.  Only `no-ui` is
 * treated as a handback: `aborted` already has its own stop channel (the
 * run reports `stopReason: "aborted"`) and `timeout` is deliberately
 * excluded (a timed-out dialog may still warrant a wake).  Every
 * payload is untrusted, so malformed entries are skipped and a
 * transcript with no matching result yields `false` — fail closed toward
 * the ordinary settle logic.
 *
 * @param messages - The settled turn's messages.
 * @returns True when an ask result reports `unavailable`/`no-ui`.
 */
export function askWentUnanswered(messages: readonly unknown[]): boolean {
  for (const message of messages) {
    if (messageRole(message) !== "toolResult") continue;
    const result = message as { toolName?: unknown; details?: unknown };
    if (result.toolName !== "ask") continue;
    const details = result.details;
    if (details === null || typeof details !== "object") continue;
    const questions = (details as { questions?: unknown }).questions;
    if (!Array.isArray(questions)) continue;
    for (const question of questions) {
      if (question === null || typeof question !== "object") continue;
      const slot = (question as { result?: unknown }).result;
      if (slot === null || typeof slot !== "object") continue;
      const candidate = slot as { status?: unknown; reason?: unknown };
      if (candidate.status === "unavailable" && candidate.reason === "no-ui") {
        return true;
      }
    }
  }
  return false;
}

/**
 * Read the activity outcome pi reports on the pre-settle boundary event.
 *
 * pi derives it from the run's terminal stop reason, so it is the host's
 * own first-hand verdict.  pi currently reports three literals
 * (`"completed"` / `"aborted"` / `"error"`); a missing or non-string
 * payload returns `undefined`.  Either way the caller treats anything
 * other than `"completed"` as "not completed" (silence, fail closed), so
 * a wake requires the explicit `"completed"` outcome.
 *
 * @param evt - The `agent_before_settle` event.
 * @returns The reported outcome, or `undefined` when absent/unreadable.
 */
export function readActivityOutcome(evt: unknown): string | undefined {
  const outcome = (evt as { outcome?: unknown } | undefined)?.outcome;
  return typeof outcome === "string" ? outcome : undefined;
}

/**
 * Read the boundary drafts earlier handlers contributed.
 *
 * pi adopts a handler's returned `entries` as the new accumulated list
 * without merging, so the wake draft must be appended to whatever the
 * event already carries.
 *
 * @param evt - The `agent_before_settle` event.
 * @returns The accumulated drafts, or an empty list when absent/unreadable.
 */
export function boundaryEntries(
  evt: unknown,
): NonNullable<PiBoundaryResult["entries"]> {
  const entries = (evt as { entries?: unknown } | undefined)?.entries;
  return Array.isArray(entries)
    ? (entries as NonNullable<PiBoundaryResult["entries"]>)
    : [];
}

/**
 * Read the live model id from pi's handler context.
 *
 * pi exposes the active model on the extension context (`ctx.model.id`) —
 * the same duck-typed source `capturePiModelLimit` reads.  A missing
 * context, model, or string id resolves to undefined so the caller can
 * fail closed to the base prompt wording.
 *
 * @param ctx - The pi handler context (typed loosely on purpose).
 * @returns The model id, or undefined when pi did not expose one.
 */
export function resolveContextModelId(ctx: unknown): string | undefined {
  if (!ctx || typeof ctx !== "object") return undefined;
  const model = (ctx as { model?: unknown }).model;
  if (!model || typeof model !== "object") return undefined;
  const id = (model as { id?: unknown }).id;
  return typeof id === "string" ? id : undefined;
}
