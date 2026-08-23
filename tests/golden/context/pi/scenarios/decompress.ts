/**
 * Golden scenarios — decompress dual path and restore gate (C3), pi
 * lane.
 *
 * Ported from the opencode lane with pi numbering (see
 * `conversation.ts`): a v1 range over N tool exchanges covers 2N pi
 * messages, so the covered counts and the reclaimed-token figures in
 * the ToolResults are roughly doubled.
 *
 * - G-DEC-01: restore vs recall — active block restores (two-round view
 *   effect), inactive block recall errors listing the surviving blocks,
 *   long summaries are truncated with a Chinese tail note, and invalid
 *   / missing block ids error loudly.
 * - G-DEC-02: maxFillPercent gate three states — restore allowed, and
 *   gate skipped when no model limit is known.
 *
 * @module
 */

import type { Scenario } from "../types.js";
import { longConversation, makeRange } from "./conversation.js";

const SID = "golden-pi-g-dec-01";

/** Compress + decompress config shared by both scenarios. */
function decConfig(maxFillPercent: number) {
  return {
    protectedMessages: 15,
    releasedPercent: 10,
    dedup: {},
    purgeErrors: {},
    compress: {
      thresholdTokens: 2000,
      protectedTokens: 20000,
      maxRanges: 8,
    },
    decompress: { maxFillPercent },
  };
}

/**
 * G-DEC-01 — restore and recall dual path.
 *
 * b1 ([1, 13)) is consumed by b2 ([1, 31)) so it is reclaimed and
 * recalls error listing b2; restore b2 deactivates it; recalls stay
 * not-found after the restore; a third block with a 17000-char summary
 * is created and then consumed; invalid ids error loudly.
 */
export const G_DEC_01: Scenario = {
  id: "G-DEC-01",
  sessionID: SID,
  config: decConfig(90),
  rounds: [
    {
      label: "baseline-refs",
      messages: longConversation(SID),
    },
    {
      label: "create-b1",
      messages: longConversation(SID),
      action: {
        kind: "compress-tool",
        // v1 [1, 6) → pi [1, 13): 12 messages (6 tool pairs).
        ranges: [makeRange(1, 6, "第一段")],
      },
    },
    {
      label: "consume-b1-create-b2",
      messages: longConversation(SID),
      action: {
        kind: "compress-tool",
        // v1 [1, 9) → pi [1, 30): swallows b1 → b2.  In the folded view
        // (b1 [1, 13) active) line 19 lands on a15's toolCall half, so
        // the mid-pair gate would reject [1, 30); extending toRef to
        // m20 (tr15) keeps the pair complete and the range covers
        // [1, 31).  (The v1 fixture rejected this round on the
        // protection zone (boundary 16); the pi boundary (38) leaves
        // room, so the consumption the label names actually happens
        // here.)
        ranges: [
          {
            fromRef: "m0002",
            toRef: "m0020",
            title: "第二段",
            summary: "用户请求执行命令，助手完成了操作。",
          },
        ],
      },
    },
    {
      label: "recall-inactive-b1",
      messages: longConversation(SID),
      action: { kind: "decompress-tool", blockId: "b1" },
    },
    {
      label: "restore-active-b2",
      messages: longConversation(SID),
      action: { kind: "decompress-tool", blockId: "b2" },
    },
    {
      label: "recall-b1-idempotent",
      messages: longConversation(SID),
      action: { kind: "decompress-tool", blockId: "b1" },
    },
    {
      label: "recall-b2-after-restore",
      messages: longConversation(SID),
      action: { kind: "decompress-tool", blockId: "b2" },
    },
    {
      label: "decompress-nonexistent",
      messages: longConversation(SID),
      action: { kind: "decompress-tool", blockId: "b99" },
    },
    {
      label: "decompress-bad-format",
      messages: longConversation(SID),
      action: { kind: "decompress-tool", blockId: "3" },
    },
    {
      label: "create-long-summary-block",
      messages: longConversation(SID),
      action: {
        kind: "compress-tool",
        // v1 [9, 12] → pi [17, 25): 8 messages (4 tool pairs).
        ranges: [makeRange(9, 12, "长摘要", "x".repeat(17000))],
      },
    },
    {
      label: "consume-b3-create-b4",
      messages: longConversation(SID),
      action: {
        kind: "compress-tool",
        // v1 [9, 13] → pi fromRef m18 (folded b1 summary) + toRef m28:
        // [17, 35) swallows the long-summary block → b4.  toRef lands
        // on the toolResult line (tr17) — a range ending on the
        // toolCall half (m27) would be rejected by the mid-pair gate.
        // (The v1 fixture rejected this on the protection zone; on pi
        // the doubled message count leaves room.)
        ranges: [
          {
            fromRef: "m0018",
            toRef: "m0028",
            title: "第四段",
            summary: "第四段",
          },
        ],
      },
    },
    {
      label: "recall-truncated",
      messages: longConversation(SID),
      action: { kind: "decompress-tool", blockId: "b3" },
    },
  ],
};

/**
 * G-DEC-02 — maxFillPercent gate three states.
 *
 * Restore of b1 with no model limit skips the gate; the restore is
 * repeated after a model limit is set, but — mirroring the v1
 * fixture's registered behavior — the rounds target `b2`, which was
 * never created, so they error with the not-found guidance listing the
 * one existing block (`b1`) instead of exercising the fill gate.  The
 * maxFill rejection path is covered by the decompress core unit tests;
 * the golden fixture keeps the v1 outcome verbatim.
 */
export const G_DEC_02: Scenario = {
  id: "G-DEC-02",
  sessionID: "golden-pi-g-dec-02",
  config: decConfig(30),
  rounds: [
    {
      label: "baseline-refs",
      messages: longConversation("golden-pi-g-dec-02"),
    },
    {
      label: "create-b1",
      messages: longConversation("golden-pi-g-dec-02"),
      action: {
        kind: "compress-tool",
        // v1 [1, 6) → pi [1, 13): 12 messages (6 tool pairs).
        ranges: [makeRange(1, 6, "第一段")],
      },
    },
    {
      label: "restore-no-model-limit-skipped",
      messages: longConversation("golden-pi-g-dec-02"),
      action: { kind: "decompress-tool", blockId: "b1" },
    },
    {
      label: "create-b4",
      messages: longConversation("golden-pi-g-dec-02"),
      action: {
        kind: "compress-tool",
        // v1 [6, 9] → pi [11, 19): 8 messages (4 tool pairs).
        ranges: [makeRange(6, 9, "第四段")],
      },
    },
    {
      label: "set-limit-20k",
      messages: longConversation("golden-pi-g-dec-02"),
      action: { kind: "set-model-limit", context: 20000 },
    },
    {
      label: "restore-rejected-at-limit",
      messages: longConversation("golden-pi-g-dec-02"),
      action: { kind: "decompress-tool", blockId: "b2" },
    },
    {
      label: "set-limit-500k",
      messages: longConversation("golden-pi-g-dec-02"),
      action: { kind: "set-model-limit", context: 500000 },
    },
    {
      label: "restore-allowed-at-limit",
      messages: longConversation("golden-pi-g-dec-02"),
      action: { kind: "decompress-tool", blockId: "b2" },
    },
  ],
};
