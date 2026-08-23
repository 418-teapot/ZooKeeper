/**
 * Golden scenario — pi summary materialization semantics.
 *
 * PI-SUMMARY-01 pins down how the pi render layer materializes folded
 * blocks (`materializeSummary` in `src/adapters/pi/render.ts`): the
 * summary renders as a synthetic pi USER message whose string content
 * carries the `[mN] ` line prefix, the `[Block bN · K 条]` label and
 * the summary body — there is no `isCompacted`/summary flag on the
 * message (that marker is reserved for host compaction boundaries; the
 * capture surfaces it as `boundary`).  The scenario also proves
 * `validateBlock` survives across rounds: an unchanged view keeps
 * folding the same blocks, and deactivating one block un-folds it
 * while the other keeps folding.
 *
 * @module
 */

import type { PiAgentMessage } from "../../../../../src/adapters/pi/types.js";
import type { Scenario } from "../types.js";
import {
  assistantMsg,
  textPart,
  toolCallPart,
  toolResultMsg,
  userMsg,
} from "../messages.js";

const SID = "golden-pi-summary-01";

/** Seven-message view: u0, two tool pairs, trailing user, answer. */
function summaryView(): PiAgentMessage[] {
  return [
    userMsg("开场问题", { id: "u0" }),
    assistantMsg([toolCallPart("call-1", "bash", { cmd: "ls" })], { id: "a1" }),
    toolResultMsg("call-1", "bash", [textPart("data 1")], { id: "tr1" }),
    userMsg("中间问题", { id: "u2" }),
    assistantMsg([toolCallPart("call-2", "bash", { cmd: "find" })], {
      id: "a2",
    }),
    toolResultMsg("call-2", "bash", [textPart("data 2")], { id: "tr2" }),
    userMsg("最后一个问题", { id: "u3" }),
    assistantMsg([textPart("回答完毕")], { id: "a3" }),
  ];
}

const BASE_CONFIG = { dedup: {}, purgeErrors: {} };

/**
 * PI-SUMMARY-01 — folded summaries materialize as pi user messages and
 * survive across rounds.
 */
export const PI_SUMMARY_01: Scenario = {
  id: "PI-SUMMARY-01",
  sessionID: SID,
  config: BASE_CONFIG,
  rounds: [
    {
      label: "baseline",
      messages: summaryView(),
    },
    {
      label: "create-block-materializes-user-summary",
      messages: summaryView(),
      action: {
        kind: "create-block",
        plan: {
          anchorMessageId: "tr1",
          messageIds: ["a1", "tr1"],
          summary: "first summary.",
          title: "第一段",
          compressedTokens: 400,
          summaryTokens: 20,
        },
      },
    },
    {
      label: "validate-block-survives-round",
      messages: summaryView(),
    },
    {
      label: "add-second-block",
      messages: summaryView(),
      action: {
        kind: "create-block",
        plan: {
          anchorMessageId: "tr2",
          messageIds: ["a2", "tr2"],
          summary: "second summary.",
          title: "第二段",
          compressedTokens: 400,
          summaryTokens: 20,
        },
      },
    },
    {
      label: "both-blocks-survive",
      messages: summaryView(),
    },
    {
      label: "deactivate-first-unfolds-one",
      messages: summaryView(),
      action: { kind: "deactivate-block", blockId: 1 },
    },
  ],
};
