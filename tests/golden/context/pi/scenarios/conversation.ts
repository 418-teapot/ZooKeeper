/**
 * Shared conversation fixtures for tool-driven pi golden scenarios.
 *
 * Mirrors the opencode lane's `conversation.ts` fixture (a 31-message
 * v1 conversation: first user + 28 tool-heavy exchanges + last user +
 * final assistant) translated to the pi wire shape: each v1 tool
 * exchange becomes TWO pi messages — an assistant message with a
 * `toolCall` block and a `toolResult` message — so the pi conversation
 * has 59 messages.
 *
 * The pi lane numbers every message as a dense view line (pi has no
 * hidden messages), so the compress-tool refs must use pi line numbers:
 * v1 index 0 (u0) is line 1, v1 index i in 1..28 spans lines 2i
 * (assistant toolCall) and 2i+1 (toolResult), v1 index 29 (u29) is
 * line 58, and v1 index 30 (a30) is line 59.  `makeRange` translates
 * the v1 index-based ranges into this pi address space.
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
 * First/last pi line of the pi messages translating a v1 index.
 *
 * pi has no hidden messages, so every pi message occupies a dense view
 * line: v1 index 0 → line 1; v1 indices 1..28 → the assistant toolCall
 * at line 2i and its toolResult at line 2i+1; v1 index 29 → line 58;
 * v1 index 30 → line 59.  Out-of-range indices (hallucinated refs)
 * map far beyond the 59-line view.
 *
 * @param v1Index - The v1 conversation index (0..30).
 * @returns The first and last pi line of that v1 message.
 */
function piLinesOf(v1Index: number): { first: number; last: number } {
  if (v1Index === 0) return { first: 1, last: 1 };
  if (v1Index >= 1 && v1Index <= 28) {
    return { first: 2 * v1Index, last: 2 * v1Index + 1 };
  }
  if (v1Index === 29) return { first: 58, last: 58 };
  if (v1Index === 30) return { first: 59, last: 59 };
  return { first: 2 * v1Index + 1, last: 2 * v1Index + 1 };
}

/**
 * Build the pi line-number ref (zero-padded, like the v1 fixtures) for
 * the first pi message of a v1 index.
 *
 * @param v1Index - The v1 conversation index.
 * @returns A `mNNNN` ref addressing the first pi message of the v1
 *   message.
 */
export function refFor(v1Index: number): string {
  return `m${String(piLinesOf(v1Index).first).padStart(4, "0")}`;
}

/**
 * Build the pi line-number ref for the LAST pi message of a v1 index.
 *
 * @param v1Index - The v1 conversation index.
 * @returns A `mNNNN` ref addressing the last pi message of the v1
 *   message (the toolResult for a tool exchange).
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
 * The v1 index-based range is translated into pi line refs: fromRef
 * addresses the FIRST pi message of the from v1 index (the assistant
 * toolCall), toRef the LAST pi message of the to v1 index (the
 * toolResult), so a range always covers whole tool pairs.
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
