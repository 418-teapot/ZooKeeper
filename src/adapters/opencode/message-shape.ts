/**
 * OpenCode host adapter — message-shape helpers for idle classification.
 *
 * The `session.idle` loop reads a session transcript to decide why a turn
 * settled.  OpenCode's message and part shapes are duck-typed here (the
 * adapter imports no host SDK type): a few host variants rename the tool
 * field, so `tool` / `name` / `toolName` and the tool-part `type` spellings
 * are all probed.  Every payload is untrusted — a malformed entry simply
 * does not match, so the caller keeps its fail-closed verdict.
 *
 * @module
 */

/** Tool names that pose a question to the user and wait for an answer. */
const QUESTION_TOOL_NAMES: ReadonlySet<string> = new Set([
  "question",
  "ask_user_question",
  "askuserquestion",
]);

/** Assistant-turn error names that report an aborted request. */
export const ABORT_ERROR_NAMES: ReadonlySet<string> = new Set([
  "MessageAbortedError",
  "AbortError",
]);

/**
 * Build a message id in the host's own layout (`msg_` + 12 hex
 * characters + 12 base62 characters, mirroring OpenCode's identifier
 * encoding).  `promptAsync` honors a caller-supplied id, so the host can
 * recognize the resulting `message.updated` as its own injected
 * wake by `info.id` — the only stable discriminator that event
 * carries: `message.updated` transports message identity, not content
 * (text arrives separately via `message.part.updated`).
 *
 * @returns A fresh, host-format user message id.
 */
export function newInjectedMessageID(): string {
  const alphabet =
    "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
  // Low 48 bits of the (ms timestamp * 4096) counter, matching the
  // upstream identifier so the id sorts with its contemporaries.
  const time = (BigInt(Date.now()) * 4096n) & ((1n << 48n) - 1n);
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  let suffix = "";
  for (const b of bytes) suffix += alphabet[b % 62];
  return `msg_${time.toString(16).padStart(12, "0")}${suffix}`;
}

/** The minimal message shape read while classifying a settle cause. */
export interface IdleMessageEntry {
  info?: {
    role?: string;
    error?: { name?: string };
    /** Host-marked synthetic message (our own injections, summaries). */
    synthetic?: boolean;
  };
  parts?: Array<Record<string, unknown>>;
}

/**
 * Extract a tool name from a tool part.
 *
 * The OpenCode SDK names the tool `tool`; a few host variants expose it
 * as `name` / `toolName`, so all three are probed.
 *
 * @param part - A raw message part.
 * @returns The tool name, or `undefined` when the part carries none.
 */
function getPartToolName(part: Record<string, unknown>): string | undefined {
  const name = part.tool ?? part.name ?? part.toolName;
  return typeof name === "string" ? name : undefined;
}

/**
 * Whether a message part is a tool call.
 *
 * The OpenCode SDK uses `tool`; a few host variants expose `tool_use` or
 * `tool-invocation`, so all three are accepted.
 *
 * @param part - A raw message part.
 * @returns `true` when the part represents a tool call.
 */
function isToolPart(part: Record<string, unknown>): boolean {
  const type = part.type;
  return type === "tool" || type === "tool_use" || type === "tool-invocation";
}

/**
 * Whether a message part is an unanswered question-tool call.
 *
 * A question tool that has not reached the `completed` state is still
 * waiting for the user's answer.
 *
 * @param part - A raw message part.
 * @returns `true` when the part is a pending question call.
 */
function isUnansweredQuestionPart(part: Record<string, unknown>): boolean {
  if (!isToolPart(part)) return false;
  const name = getPartToolName(part)?.toLowerCase();
  if (name === undefined || !QUESTION_TOOL_NAMES.has(name)) return false;
  const state = part.state as { status?: unknown } | undefined;
  return state?.status !== "completed";
}

/**
 * Whether the transcript ends at a question tool call awaiting an answer.
 *
 * Messages are scanned backward: the first real user message terminates
 * the search (the question was answered or the turn interrupted), and
 * the first assistant message decides it.  Synthetic user messages (our
 * own wake injections, block summaries) are skipped so they do
 * not mask a still-pending question.
 *
 * @param messages - The session transcript in chronological order.
 * @returns `true` when an unanswered question tool call is pending.
 */
export function hasUnansweredQuestion(
  messages: readonly IdleMessageEntry[],
): boolean {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    const role = message?.info?.role;
    if (role === "user") {
      if (message.info?.synthetic === true) continue;
      return false;
    }
    if (role === "assistant") {
      const parts = Array.isArray(message.parts) ? message.parts : [];
      return parts.some(isUnansweredQuestionPart);
    }
  }
  return false;
}

/**
 * Whether the last assistant message reports an aborted turn.
 *
 * The `session.error` event is the primary abort signal; this inspection
 * is the fallback for an abort observed only in the persisted
 * transcript.
 *
 * @param messages - The session transcript in chronological order.
 * @returns `true` when the last assistant turn carries an abort error.
 */
export function lastAssistantAborted(
  messages: readonly IdleMessageEntry[],
): boolean {
  for (let i = messages.length - 1; i >= 0; i--) {
    const info = messages[i]?.info;
    if (info?.role !== "assistant") continue;
    const name = info.error?.name;
    return name !== undefined && ABORT_ERROR_NAMES.has(name);
  }
  return false;
}

/**
 * Count the well-formed tool calls the settled turn issued.
 *
 * The turn begins after the last user message: every user message is a
 * turn boundary.  The host's own wake injection also arrives as a user
 * message (a recorded id echo with customType-less text parts), so it
 * too starts a fresh turn — which is exactly the turn being
 * classified.  Only well-formed tool parts (ones carrying a name) are
 * counted; tool names are never inspected further.
 *
 * @param messages - The session transcript in chronological order.
 * @returns The number of tool calls in the turn.
 */
export function countTurnToolCalls(
  messages: readonly IdleMessageEntry[],
): number {
  let start = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.info?.role === "user") {
      start = i + 1;
      break;
    }
  }
  let count = 0;
  for (let i = start; i < messages.length; i++) {
    const message = messages[i];
    if (message?.info?.role !== "assistant") continue;
    const parts = Array.isArray(message.parts) ? message.parts : [];
    for (const part of parts) {
      if (!isToolPart(part)) continue;
      if (getPartToolName(part) !== undefined) count++;
    }
  }
  return count;
}
