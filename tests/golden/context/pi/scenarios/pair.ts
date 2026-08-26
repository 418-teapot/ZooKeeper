/**
 * Golden scenario — tool-call / tool-result pair folding (pi-specific).
 *
 * PI-PAIR-01 exercises the pi pair semantics end to end: pi represents
 * a tool call and its result as TWO messages, so a compression range
 * must keep both halves together.  The compress gate chain rejects a
 * range that cuts a pair at CREATION time with loud Chinese guidance —
 * a range ending right after the toolCall half, with the linked
 * toolResult outside the interval — teaching the model to extend the
 * range instead of letting the render repair the cut silently.  Round 2
 * captures that rejection with zero state change; round 3 compresses
 * both pairs wholesale through the accepted path and the rendered
 * summary keeps its block id (`b1`) because the state block interval
 * matches the rendered summary exactly; round 4 restores the block and
 * the pairs reappear.
 *
 * @module
 */

import type { PiAgentMessage } from "../../../../../src/adapters/pi/types.js";
import {
  assistantMsg,
  textPart,
  toolCallPart,
  toolResultMsg,
  userMsg,
} from "../messages.js";
import type { Scenario } from "../types.js";

const SID = "golden-pi-pair-01";

/** Seven-message view: u0, two tool pairs, trailing user, answer. */
function pairView(): PiAgentMessage[] {
  return [
    userMsg("开场问题", { id: "u0" }),
    assistantMsg([toolCallPart("call-1", "bash", { cmd: "ls" })], { id: "a1" }),
    toolResultMsg("call-1", "bash", [textPart("data 1")], { id: "tr1" }),
    assistantMsg([toolCallPart("call-2", "bash", { cmd: "find" })], {
      id: "a2",
    }),
    toolResultMsg("call-2", "bash", [textPart("data 2")], { id: "tr2" }),
    userMsg("最后一个问题", { id: "u3" }),
    assistantMsg([textPart("回答完毕")], { id: "a4" }),
  ];
}

const BASE_CONFIG = {
  protectedMessages: 0,
  dedup: {},
  purgeErrors: {},
  compress: {
    // The pairView fixture messages are tiny: the full-pair interval
    // [1, 5) estimates to 10 heuristic tokens and the half-pair [3, 4)
    // to 3.  A low threshold keeps the phantom gate out of the pair
    // narrative — the mid-pair gate runs before it anyway and is the
    // rejection this scenario records.
    thresholdTokens: 5,
    protectedTokens: 0,
    maxRanges: 8,
  },
  decompress: { maxFillPercent: 90 },
};

/**
 * PI-PAIR-01 — tool pairs fold and un-fold as whole units.
 *
 * Round 2 asks to block only the toolCall half of the second pair
 * (a2): the pi lens addresses the linked toolResult (tr2) on the
 * tool-input region, and since tr2 sits outside the [3, 4) interval
 * the mid-pair gate rejects the range with loud guidance — zero state
 * change, nothing to decompress.  Round 3 compresses both pairs
 * wholesale ([1, 5)): the gate accepts, b1 is created, and the same
 * round's transform folds it — the rendered summary carries its block
 * id (`[Block b1 · 4 条]`) because the state block interval matches
 * the rendered summary exactly.  Round 4 restores b1 and the pairs
 * reappear.
 */
export const PI_PAIR_01: Scenario = {
  id: "PI-PAIR-01",
  sessionID: SID,
  config: BASE_CONFIG,
  rounds: [
    {
      label: "baseline",
      messages: pairView(),
    },
    {
      label: "reject-half-pair-cut",
      messages: pairView(),
      action: {
        kind: "compress-tool",
        // [3, 4) covers only the a2 toolCall half of the second pair;
        // its linked toolResult (tr2, ordinal 4) sits outside, so the
        // mid-pair gate rejects with loud guidance and zero state
        // change.
        ranges: [
          {
            fromRef: "m0004",
            toRef: "m0004",
            title: "对半",
            summary: "pair summary.",
          },
        ],
      },
    },
    {
      label: "block-full-pair-accepted",
      messages: pairView(),
      action: {
        kind: "compress-tool",
        // [1, 5) covers both halves of each pair (a1..tr2): the gate
        // accepts, b1 is created, and the fold renders the summary
        // with its block id because the rendered interval matches the
        // state block exactly.
        ranges: [
          {
            fromRef: "m0002",
            toRef: "m0005",
            title: "双对",
            summary: "both pairs summary.",
          },
        ],
      },
    },
    {
      label: "decompress-restores-pair",
      messages: pairView(),
      action: { kind: "decompress-tool", blockId: "b1" },
    },
  ],
};
