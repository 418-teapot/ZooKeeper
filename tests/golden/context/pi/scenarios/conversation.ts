/**
 * Shared conversation fixtures for tool-driven pi golden scenarios.
 *
 * Mirrors the opencode lane's `conversation.ts` fixture (a 31-message
 * v1 conversation: first user + 28 tool-heavy exchanges + last user +
 * final assistant) translated to the pi wire shape: each v1 tool
 * exchange becomes TWO pi messages — an assistant message with a
 * `toolCall` block and a `toolResult` message — so the pi transcript
 * has 59 messages.
 *
 * The fold layer pairs each tool call with its linked result into one
 * indivisible unit, so those 59 messages number as a dense 31-line
 * view: v1 index i (0..30) occupies exactly one line, `i + 1`.  A unit
 * holds both halves of one exchange, so a compression range always
 * covers whole pairs and a ref never addresses a single half.
 * `makeRange` translates the v1 index-based ranges into this line
 * space.
 *
 * @module
 */

import type { PiAgentMessage } from "../../../../../src/adapters/pi/types.js";
import type { CompressRangeInput } from "../../../../../src/core/context/compress.js";
import {
  assistantMsg,
  textPart,
  toolCallPart,
  toolResultMsg,
  userMsg,
} from "../messages.js";

/** Long tool output (~2000 heuristic tokens) so protection gates pass. */
export const LONG_OUTPUT = "x".repeat(8000);

/** Short tool output (~25 heuristic tokens) so low-benefit gates fire. */
export const SHORT_OUTPUT = "y".repeat(100);

/**
 * First/last pi view line of the pi content translating a v1 index.
 *
 * The fold layer merges a tool call and its linked result into one
 * unit, so each v1 index occupies a single line and `first === last`:
 * v1 index i maps to line `i + 1` (v1 index 0 → line 1, v1 index 28 →
 * line 29, v1 index 29 → line 30, v1 index 30 → line 31).  Out-of-range
 * indices (hallucinated refs) map beyond the 31-line view.
 *
 * @param v1Index - The v1 conversation index (0..30).
 * @returns The first and last pi line of that v1 index (the same line).
 */
function piLinesOf(v1Index: number): { first: number; last: number } {
  const line = v1Index + 1;
  return { first: line, last: line };
}

/**
 * Build the pi line-number ref (zero-padded, like the v1 fixtures) for
 * a v1 index.
 *
 * @param v1Index - The v1 conversation index.
 * @returns A `mNNNN` ref addressing the unit line of the v1 index.
 */
export function refFor(v1Index: number): string {
  return `m${String(piLinesOf(v1Index).first).padStart(4, "0")}`;
}

/**
 * Build the pi line-number ref for the LAST pi message of a v1 index.
 *
 * Under unit addressing a v1 index occupies one line, so this equals
 * `refFor`; it is kept so range builders read as "start .. end".
 *
 * @param v1Index - The v1 conversation index.
 * @returns A `mNNNN` ref addressing the unit line of the v1 index.
 */
export function lastRefFor(v1Index: number): string {
  return `m${String(piLinesOf(v1Index).last).padStart(4, "0")}`;
}

/**
 * A 59-message pi conversation: first user + 28 tool exchanges (each an
 * assistant `toolCall` + `toolResult` pair) + last user + final
 * assistant.
 *
 * With protectedMessages=20 / protectedTokens=20000 / threshold=2000
 * the pi protection boundary lands at ordinal 38 (the token-budget
 * window: 10 tool exchanges from the end ≈ 20000 tokens), so valid
 * ranges live inside [1, 38).
 *
 * @param sessionID - Session id for the first message (carried on the
 *   user message for fixture symmetry; pi messages carry no session).
 * @returns The conversation (fresh objects every call).
 */
export function longConversation(sessionID: string): PiAgentMessage[] {
  return conversation(sessionID, LONG_OUTPUT);
}

/**
 * A 59-message pi conversation with SHORT tool outputs.
 *
 * Same structure as `longConversation`, but each tool result is ~25
 * heuristic tokens — small ranges fall below the phantom threshold and
 * the negative-benefit gate fires on modest summaries.
 *
 * @param sessionID - Session id for the first message.
 * @returns The conversation (fresh objects every call).
 */
export function shortConversation(sessionID: string): PiAgentMessage[] {
  return conversation(sessionID, SHORT_OUTPUT);
}

/**
 * Build the shared 59-message pi conversation with the given output
 * size.
 *
 * @param sessionID - Session id for the first message.
 * @param output - Tool output text (length determines token estimates).
 * @returns The conversation (fresh objects every call).
 */
function conversation(sessionID: string, output: string): PiAgentMessage[] {
  const msgs: PiAgentMessage[] = [userMsg("开场问题", { id: "u0" })];
  for (let i = 1; i <= 28; i++) {
    msgs.push(
      assistantMsg([toolCallPart(`c-${i}`, "bash", { cmd: "x" })], {
        id: `a${i}`,
      }),
    );
    msgs.push(
      toolResultMsg(`c-${i}`, "bash", [textPart(output)], { id: `tr${i}` }),
    );
  }
  msgs.push(userMsg("最后一个问题", { id: "u29" }));
  msgs.push(assistantMsg([textPart("回答完毕")], { id: "a30" }));
  return msgs;
}

/**
 * Build a single compress range over the long pi conversation.
 *
 * The v1 index-based range is translated into pi line refs: both
 * endpoints address the single unit line of their v1 index, so the
 * resolved interval always covers whole tool pairs.
 *
 * @param fromIndex - Start v1 index (inclusive).
 * @param toIndex - End v1 index (inclusive, per the v1 fixture
 *   semantics).
 * @param title - Block title.
 * @param summary - Model summary text.
 * @returns A valid `CompressRangeInput` in pi numbering.
 */
export function makeRange(
  fromIndex: number,
  toIndex: number,
  title = "执行命令主题",
  summary = "用户请求执行命令，助手完成了操作。",
): CompressRangeInput {
  return {
    fromRef: refFor(fromIndex),
    toRef: lastRefFor(toIndex),
    title,
    summary,
  };
}
