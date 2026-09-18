/**
 * Golden scenario — tool-call / tool-result pair folding (pi-specific).
 *
 * PI-PAIR-01 exercises the pi pair semantics end to end: pi represents
 * a tool call and its result as TWO messages, which the fold layer
 * merges into one indivisible unit.  Unit addressing is the whole story
 * of this scenario — a compression range can only name whole lines, so
 * a "half pair" (one message of a call/result exchange) has no ref and
 * cannot be expressed at all: there is nothing for a gate to reject.
 * Round 2 folds the first pair as a unit, round 3 folds the second
 * pair as a unit so the view carries two independent pair summaries,
 * and round 4 restores the first block: that pair reappears while the
 * second keeps folding.
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
    // The pairView fixture messages are tiny: each pair is one unit
    // whose line covers a1+tr1 ([1, 3), ~5 tokens) and a2+tr2
    // ([3, 5), ~6 tokens).  A low threshold keeps the phantom gate out
    // of the pair narrative, which is about unit addressing rather
    // than token mass.
    thresholdTokens: 5,
    protectedTokens: 0,
    maxRanges: 8,
  },
  decompress: { maxFillPercent: 90 },
};

/**
 * PI-PAIR-01 — tool pairs fold and un-fold as whole units.
 *
 * Round 2 folds the first pair (m2, the a1/tr1 unit over [1, 3)) into
 * b1; round 3 folds the second pair (m3, the a2/tr2 unit over [3, 5))
 * into b2, so the view then carries two independent pair summaries.
 * Round 4 restores b1: the first pair reappears while b2 keeps
 * folding.
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
      label: "fold-first-pair",
      messages: pairView(),
      action: {
        kind: "compress-tool",
        // m2 is the first pair's single unit line: a1 and its linked
        // result tr1 both live in the unit [1, 3), so the range names
        // the whole pair and b1 is created over it.
        ranges: [
          {
            fromRef: "m2",
            toRef: "m2",
            title: "第一对",
            summary: "first pair.",
          },
        ],
      },
    },
    {
      label: "fold-second-pair",
      messages: pairView(),
      action: {
        kind: "compress-tool",
        // b1 already folds [1, 3), so the second pair is m3 — the
        // a2/tr2 unit over [3, 5).  It is a separate unit line and a
        // separate block (b2); neither range can touch a single half.
        ranges: [
          {
            fromRef: "m3",
            toRef: "m3",
            title: "第二对",
            summary: "second pair.",
          },
        ],
      },
    },
    {
      label: "restore-first-pair",
      messages: pairView(),
      action: { kind: "decompress-tool", blockId: "b1" },
    },
  ],
};
