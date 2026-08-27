/**
 * Host-agnostic message reduction for subagent results.
 *
 * Reduces a host-neutral message view into the result text of a subagent
 * run.  Driver implementations adapt host-specific events into the minimal
 * `AgentMessage` shape defined here, so result computation stays framework
 * free and deterministic.
 *
 * The driver contract states that `prompt()` does not reject on abort; the
 * final message's `stopReason` is the source of truth for outcome
 * classification, which is why `classifyOutcome` inspects it rather than
 * trusting a rejected promise.
 *
 * @module
 */

import type { SubagentResult } from "./driver.js";

/**
 * The minimal host-agnostic message view driver implementations reduce host
 * events into.
 *
 * Only the fields needed for result computation are kept: the message role,
 * its text content, the stop reason of an assistant message, and whether the
 * message is errored.
 */
export interface AgentMessage {
  role: "user" | "assistant" | "toolResult";
  text: string;
  stopReason?: string;
  errored: boolean;
}

/**
 * Extract the text of the last non-errored assistant message.
 *
 * Assists are scanned from the end backwards; errored messages are skipped,
 * and the first non-errored assistant message found wins.  Returns an empty
 * string when no non-errored assistant message exists.
 *
 * @param messages - The host-agnostic message view to reduce.
 * @returns The last non-errored assistant text, or an empty string.
 */
export function reduceMessages(messages: AgentMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role === "assistant" && !message.errored) {
      return message.text;
    }
  }
  return "";
}

/**
 * Classify a subagent outcome from the final message's stop reason.
 *
 * A normal stop yields an `ok` result with the reduced text.  An `aborted`
 * stop reason yields an `aborted` result carrying the partial text.  An
 * `error` stop reason or an explicit error message yields an `error` result
 * carrying the partial text and the error message.  An empty message list
 * yields an `error` result — there is no evidence of any output.
 *
 * @param options - The outcome inputs.
 * @param options.stopReason - The final assistant message's stop reason, or
 *   undefined when unknown.
 * @param options.errorMessage - An explicit error message, when one exists.
 * @param options.messages - The host-agnostic message view.
 * @returns The classified `SubagentResult`.
 */
export function classifyOutcome({
  stopReason,
  errorMessage,
  messages,
}: {
  stopReason?: string;
  errorMessage?: string;
  messages: AgentMessage[];
}): SubagentResult {
  const text = reduceMessages(messages);

  if (errorMessage !== undefined) {
    return { kind: "error", text, errorMessage };
  }
  if (stopReason === "aborted") {
    return { kind: "aborted", text };
  }
  if (stopReason === "error") {
    return { kind: "error", text, errorMessage: "subagent stopped with error" };
  }
  if (stopReason === "stop" && messages.length > 0) {
    return { kind: "ok", text };
  }
  // No usable evidence: either no stop reason was observed or no messages
  // exist at all.  Treat it as a failure rather than guessing success.  This
  // also deliberately catches `"length"` (max-tokens truncation) and unknown
  // stop reasons — a truncated or indeterminate run must not be surfaced as
  // success.
  return {
    kind: "error",
    text,
    errorMessage: "no usable assistant message in subagent output",
  };
}
