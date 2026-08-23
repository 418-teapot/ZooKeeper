/**
 * Shared conversation fixtures for tool-driven golden scenarios.
 *
 * Mirrors the message shapes used by the compress tool tests
 * (`src/tools/compress.test.ts`) so ranges resolve against the real
 * protection gates (protectedMessages / protectedTokens / threshold).
 *
 * @module
 */

import type { ContextMessageEntry } from "../../../../../src/adapters/opencode/types.js";
import type { CompressRangeInput } from "../../../../../src/core/context/compress.js";
import { msg, textPart, toolPart } from "../messages.js";

/** Long tool output (~2000 heuristic tokens) so protection gates pass. */
export const LONG_OUTPUT = "x".repeat(8000);

/** Short tool output (~25 heuristic tokens) so low-benefit gates fire. */
export const SHORT_OUTPUT = "y".repeat(100);

/**
 * Ref string for a zero-based message-array index (m0001 = index 0).
 */
export function refFor(index: number): string {
  return `m${String(index + 1).padStart(4, "0")}`;
}

/**
 * A 31-message conversation: first user + 28 tool-heavy exchanges +
 * last user + final assistant.
 *
 * With protectedMessages=20 / protectedTokens=20000 / threshold=2000
 * the protection boundary lands at index 11, so valid ranges live
 * inside [1, 11).
 *
 * @param sessionID - Session id for the first message.
 * @returns The conversation (fresh objects every call).
 */
export function longConversation(sessionID: string): ContextMessageEntry[] {
  return conversation(sessionID, LONG_OUTPUT);
}

/**
 * A 31-message conversation with SHORT tool outputs.
 *
 * Same structure as `longConversation`, but each tool message is ~25
 * heuristic tokens — small ranges fall below the phantom threshold and
 * the negative-benefit gate fires on modest summaries.
 *
 * @param sessionID - Session id for the first message.
 * @returns The conversation (fresh objects every call).
 */
export function shortConversation(sessionID: string): ContextMessageEntry[] {
  return conversation(sessionID, SHORT_OUTPUT);
}

/**
 * Build the shared 31-message conversation with the given output size.
 *
 * @param sessionID - Session id for the first message.
 * @param output - Tool output text (length determines token estimates).
 * @returns The conversation (fresh objects every call).
 */
function conversation(
  sessionID: string,
  output: string,
): ContextMessageEntry[] {
  const msgs: ContextMessageEntry[] = [
    msg("user", "u0", [textPart("开场问题")], sessionID),
  ];
  for (let i = 1; i <= 28; i++) {
    msgs.push(
      msg("assistant", `a${i}`, [toolPart(`c-${i}`, output, { cmd: "x" })]),
    );
  }
  msgs.push(msg("user", "u29", [textPart("最后一个问题")]));
  msgs.push(msg("assistant", "a30", [textPart("回答完毕")]));
  return msgs;
}

/**
 * Build a single compress range over the long conversation.
 *
 * @param fromIndex - Start index (inclusive).
 * @param toIndex - End index (exclusive).
 * @param title - Block title.
 * @param summary - Model summary text.
 * @returns A valid `CompressRangeInput`.
 */
export function makeRange(
  fromIndex: number,
  toIndex: number,
  title = "执行命令主题",
  summary = "用户请求执行命令，助手完成了操作。",
): CompressRangeInput {
  return {
    fromRef: refFor(fromIndex),
    toRef: refFor(toIndex),
    title,
    summary,
  };
}
