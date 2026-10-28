/**
 * History priming shared by the two context scenarios.
 *
 * The production pipeline only compresses history outside its protection
 * windows: the trailing `protected_messages` (20) and the trailing
 * `protected_tokens` budget (20000), and never the first user message.  A
 * scenario therefore drives real prompts — one anchored opening turn, two
 * long target turns, then enough long filler turns — so the target turns sit
 * outside both windows when the model later compresses them.
 *
 * Every turn is answered by the in-process deterministic provider: no
 * network, no fixture transcript, and the resulting messages are the ones the
 * real pi session persists.
 */

import {
  CONTEXT_ANCHOR_PROMPT,
  CONTEXT_FILL_PROMPT,
  CONTEXT_FILL_TURNS,
  CONTEXT_SEGMENT_CHARS,
  CONTEXT_TARGET_PROMPT,
  CONTEXT_TARGET_TAGS,
} from "../harness/constants.js";
import type { ScenarioContext } from "../harness/scenario-runtime.js";

/** Unit repeated to fill a segment; CJK keeps the token estimate dense. */
const FILLER_UNIT = "这是一段用于跨过上下文压缩阈值的占位历史记录。";

/**
 * Build one long segment body carrying a sentinel tag.
 *
 * @param tag - Sentinel the assertions search the model request for.
 * @returns The filler text of `CONTEXT_SEGMENT_CHARS` characters.
 */
function segmentBody(tag: string): string {
  const head = `[${tag}] `;
  let text = head;
  while (text.length < CONTEXT_SEGMENT_CHARS) text += FILLER_UNIT;
  return text.slice(0, Math.max(CONTEXT_SEGMENT_CHARS, head.length));
}

/**
 * Prompt of one compressible target turn.
 *
 * @param position - 1-based target position (one prompt per target tag).
 * @returns The prompt text.
 */
export function targetPrompt(position: number): string {
  const tag = CONTEXT_TARGET_TAGS[position - 1] ?? "";
  return `${CONTEXT_TARGET_PROMPT}-${position}: ${segmentBody(tag)}`;
}

/**
 * Prompt of one filler turn.
 *
 * @param turn - 1-based filler turn.
 * @returns The prompt text.
 */
export function fillerPrompt(turn: number): string {
  return `${CONTEXT_FILL_PROMPT} ${turn}: ${segmentBody(`CTX-FILL-${turn}`)}`;
}

/**
 * Drive the conversation far enough for the targets to become compressible.
 *
 * @param ctx - Scenario context.
 */
export async function primeContextHistory(ctx: ScenarioContext): Promise<void> {
  await ctx.pi.prompt(CONTEXT_ANCHOR_PROMPT);
  for (
    let position = 1;
    position <= CONTEXT_TARGET_TAGS.length;
    position += 1
  ) {
    await ctx.pi.prompt(targetPrompt(position));
  }
  for (let turn = 1; turn <= CONTEXT_FILL_TURNS; turn += 1) {
    await ctx.pi.prompt(fillerPrompt(turn));
  }
  const state = await ctx.pi.state();
  ctx.checks.info(
    "history_primed",
    "真实对话已跨过压缩保护窗口",
    `turns=${CONTEXT_TARGET_TAGS.length + CONTEXT_FILL_TURNS + 1} messages=${state.messageCount} charsPerSegment=${CONTEXT_SEGMENT_CHARS}`,
  );
}
