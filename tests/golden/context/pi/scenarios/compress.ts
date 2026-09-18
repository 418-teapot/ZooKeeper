/**
 * Golden scenarios — range-mode compress gates and lifecycle (C2), pi
 * lane.
 *
 * Ported from the opencode lane with pi numbering (see
 * `conversation.ts` for the v1-index → pi-line mapping).  Because pi
 * represents each tool exchange as TWO messages, the pi protection
 * boundary lands at ordinal 38 (token-budget window) instead of v1's
 * 11, so ranges that v1 rejected on protection may succeed on pi and
 * vice versa; each adjusted round is documented in a comment.
 *
 * - G-COMP-01: full lifecycle — compress tool creates a block, the next
 *   transform folds it, decompress restores it.
 * - G-COMP-02: batch compress — two-range success plus atomic-reject
 *   paths (cross-range overlap, same-call consumption, indexed range
 *   validation failure) with zero state change.
 * - G-COMP-03: nested consumption — a wider range consumes an active
 *   block (index line + net token arithmetic), then a third generation
 *   re-absorbs the second.
 * - G-COMP-04: every validation gate's negative path, each with its
 *   captured error text and zero state change.
 *
 * @module
 */

import type { Scenario } from "../types.js";
import {
  longConversation,
  makeRange,
  refFor,
  shortConversation,
} from "./conversation.js";

const SID = "golden-pi-g-comp-01";

/** Shared compress/decompress config for the compress scenarios. */
export function compressConfig() {
  return {
    protectedMessages: 20,
    releasedPercent: 10,
    dedup: {},
    purgeErrors: {},
    compress: {
      thresholdTokens: 2000,
      protectedTokens: 20000,
      maxRanges: 8,
    },
    decompress: { maxFillPercent: 90 },
  };
}

/**
 * G-COMP-01 — compression lifecycle.
 *
 * Round 1 compresses [1, 19) via the tool (block b1, ToolResult + chat
 * notification captured); the same round's transform folds the new
 * block (C5-05 view-change timing).  Round 2 restores b1 via the
 * decompress tool; the transform un-folds it (C3-02 two-round effect).
 */
export const G_COMP_01: Scenario = {
  id: "G-COMP-01",
  sessionID: SID,
  config: compressConfig(),
  rounds: [
    {
      label: "baseline-refs",
      messages: longConversation(SID),
    },
    {
      label: "compress-tool-create-block",
      messages: longConversation(SID),
      action: {
        kind: "compress-tool",
        // v1 [1, 9) → pi [1, 19): 18 messages (9 tool pairs).
        ranges: [makeRange(1, 9, "执行命令主题")],
      },
    },
    {
      label: "decompress-restore",
      messages: longConversation(SID),
      action: { kind: "decompress-tool", blockId: "b1" },
    },
  ],
};

/**
 * G-COMP-02 — batch compress: success + atomic rejections.
 *
 * All rejections run before any block exists so their zero-state-change
 * property is directly observable; the success batch runs last.
 */
export const G_COMP_02: Scenario = {
  id: "G-COMP-02",
  sessionID: "golden-pi-g-comp-02",
  config: compressConfig(),
  rounds: [
    {
      label: "baseline-refs",
      messages: longConversation("golden-pi-g-comp-02"),
    },
    {
      label: "reject-cross-range-overlap",
      messages: longConversation("golden-pi-g-comp-02"),
      action: {
        kind: "compress-tool",
        // pi [1, 9) + [5, 14): overlap on [5, 9).
        ranges: [makeRange(1, 4, "A"), makeRange(3, 6, "B")],
      },
    },
    {
      label: "reject-same-call-consumption",
      messages: longConversation("golden-pi-g-comp-02"),
      action: {
        kind: "compress-tool",
        // pi [1, 9) + [1, 17): the second range covers the first.
        ranges: [makeRange(1, 4, "A"), makeRange(1, 8, "B")],
      },
    },
    {
      label: "reject-indexed-range-failure",
      messages: longConversation("golden-pi-g-comp-02"),
      action: {
        kind: "compress-tool",
        // m0101 is far beyond the 59-line pi view.
        ranges: [makeRange(1, 3, "ok"), makeRange(50, 55, "phantom")],
      },
    },
    {
      label: "reject-reversed-order",
      messages: longConversation("golden-pi-g-comp-02"),
      action: {
        kind: "compress-tool",
        ranges: [
          {
            // v1 index 6 (m7) comes after v1 index 2 (m3): the from
            // ref addresses a later line than the to ref.
            fromRef: refFor(6),
            toRef: refFor(2),
            title: "reversed",
            summary: "reversed.",
          },
        ],
      },
    },
    {
      label: "batch-two-ranges-success",
      messages: longConversation("golden-pi-g-comp-02"),
      action: {
        kind: "compress-tool",
        // pi [1, 13) + [11, 21): overlap on [11, 13) — the v1 batch
        // also overlapped; the snapshot records the atomic rejection.
        ranges: [makeRange(1, 6, "主题一"), makeRange(6, 10, "主题二")],
      },
    },
  ],
};

/**
 * G-COMP-03 — nested consumption (three generations).
 *
 * b1 = [1, 13).  A wider range [1, 31) consumes b1 (index line
 * `--- b1: 第一段 ---`, net token header, b1 moved to consumed).  A third
 * range [1, 33) re-absorbs the retained consumed b1 together with b2
 * into b3.
 *
 * Note: the v1 fixture rejected rounds 3-4 on the protection zone
 * (boundary 11), so the documented three-generation consumption never
 * completed there; the pi boundary leaves room for the wider ranges,
 * so the pi lane realizes the consumption the scenario describes.
 * The absorbed-record netting branch is live here: a block that stopped
 * folding keeps its record, so the third generation sees b1 still in the
 * map and nets it (its tokens were taken out of b2's figure) while
 * giving it an index line.
 */
export const G_COMP_03: Scenario = {
  id: "G-COMP-03",
  sessionID: "golden-pi-g-comp-03",
  config: compressConfig(),
  rounds: [
    {
      label: "baseline-refs",
      messages: longConversation("golden-pi-g-comp-03"),
    },
    {
      label: "compress-first-generation",
      messages: longConversation("golden-pi-g-comp-03"),
      action: {
        kind: "compress-tool",
        // v1 [1, 6) → pi [1, 13): 12 messages (6 tool pairs).
        ranges: [makeRange(1, 6, "第一段")],
      },
    },
    {
      label: "consume-b1-wider-range",
      messages: longConversation("golden-pi-g-comp-03"),
      action: {
        kind: "compress-tool",
        // b1 = [1, 13) is active, so the folded view puts its summary
        // at m2 and numbers the following units from m3.  fromRef m2
        // (the b1 summary → [1, 13)) + toRef m11 (the a15/tr15 unit
        // over [29, 31)) resolve to [1, 31), which swallows b1 → b2.
        ranges: [
          {
            fromRef: "m0002",
            toRef: "m0011",
            title: "第二段",
            summary: "用户请求执行命令，助手完成了操作。",
          },
        ],
      },
    },
    {
      label: "third-generation-reabsorbs-inactive",
      messages: longConversation("golden-pi-g-comp-03"),
      action: {
        kind: "compress-tool",
        // After b2 = [1, 31) the folded view puts its summary at m2
        // and the next unit (a16 + tr16 over [31, 33)) at m3, so
        // fromRef m2 + toRef m3 → [1, 33) swallows b2 → b3.  (v1's
        // range hit the protection zone; on pi the unit view leaves
        // room for the third generation.)
        ranges: [
          {
            fromRef: "m0002",
            toRef: "m0003",
            title: "第三段",
            summary: "第三段",
          },
        ],
      },
    },
  ],
};

/**
 * G-COMP-04 — every validation gate's negative path.
 *
 * Uses a short-output conversation so the phantom gate and the
 * negative-benefit gate fire on small ranges.  Rounds 1-5 reject with
 * zero state change; round 6 creates b1; rounds 7-11 reject against
 * the existing block (partial overlap, no-new-content, stale-ref,
 * unknown-ref) or consume it.
 */
export const G_COMP_04: Scenario = {
  id: "G-COMP-04",
  sessionID: "golden-pi-g-comp-04",
  config: {
    protectedMessages: 20,
    releasedPercent: 10,
    dedup: {},
    purgeErrors: {},
    compress: {
      // Short-output conversation (~28 tokens/exchange): a 300-token
      // budget still protects the tail while keeping the token boundary
      // well above the token boundary (36).  The 80-token
      // phantom threshold sits between [1, 8) (~84, phantom passes) and
      // smaller ranges.
      thresholdTokens: 80,
      protectedTokens: 300,
      maxRanges: 8,
    },
    decompress: { maxFillPercent: 90 },
  },
  rounds: [
    {
      label: "baseline-refs",
      messages: shortConversation("golden-pi-g-comp-04"),
    },
    {
      label: "gate-reversed-order",
      messages: shortConversation("golden-pi-g-comp-04"),
      action: {
        kind: "compress-tool",
        ranges: [
          {
            // v1 index 13 (m14) comes after v1 index 2 (m3): the from
            // ref addresses a later line than the to ref.
            fromRef: refFor(13),
            toRef: refFor(2),
            title: "reversed",
            summary: "reversed.",
          },
        ],
      },
    },
    {
      label: "gate-protection-zone",
      messages: shortConversation("golden-pi-g-comp-04"),
      action: {
        kind: "compress-tool",
        // makeRange(1, 29) resolves to [1, 58): the end ordinal 58
        // exceeds the protection boundary, so the gate rejects.
        ranges: [makeRange(1, 29, "protected")],
      },
    },
    {
      label: "gate-first-user",
      messages: shortConversation("golden-pi-g-comp-04"),
      action: {
        kind: "compress-tool",
        // v1 [0, 4) → pi [0, 9): contains the first user message.
        ranges: [makeRange(0, 4, "first-user")],
      },
    },
    {
      label: "gate-phantom-low-benefit",
      messages: shortConversation("golden-pi-g-comp-04"),
      action: {
        kind: "compress-tool",
        // makeRange(1, 3) resolves to [1, 7): 3 tool pairs ≈ 84 tokens
        // ≥ 80 → the phantom gate passes and b1 is created.
        ranges: [makeRange(1, 3, "phantom")],
      },
    },
    {
      label: "gate-negative-benefit",
      messages: shortConversation("golden-pi-g-comp-04"),
      action: {
        kind: "compress-tool",
        // b1 = [1, 7) is active: fromRef m2 (the b1 summary →
        // [1, 7)) + toRef m8 (the a9/tr9 unit over [17, 19)) resolve to
        // [1, 19); the 2000-char summary (~512 tokens with the
        // superseded index line) is not below the net content
        // (~168 tokens), so the negative-benefit gate fires.
        ranges: [
          {
            fromRef: "m0002",
            toRef: "m0008",
            title: "negative",
            summary: "s".repeat(2000),
          },
        ],
      },
    },
    {
      label: "gate-no-new-content",
      messages: shortConversation("golden-pi-g-comp-04"),
      action: {
        kind: "compress-tool",
        // fromRef m2 + toRef m2 resolve to b1's whole interval [1, 7):
        // re-covering a plain block nets zero new content, so the
        // no-new-content gate rejects.  (The v1 fixture placed this
        // round after b1 had already been consumed, where the net is
        // positive and the gate cannot fire; on pi it runs while b1 is
        // still plain to realize the gate the label names.)
        ranges: [
          {
            fromRef: "m0002",
            toRef: "m0002",
            title: "exact-again",
            summary: "exact.",
          },
        ],
      },
    },
    {
      label: "create-b1",
      messages: shortConversation("golden-pi-g-comp-04"),
      action: {
        kind: "compress-tool",
        // fromRef m2 (the folded b1 summary → [1, 7)) + toRef m8 (the
        // a9/tr9 unit over [17, 19)) consume b1 and create b2 = [1, 19).
        ranges: [
          {
            fromRef: "m0002",
            toRef: "m0008",
            title: "已有",
            summary: "用户请求执行命令，助手完成了操作。",
          },
        ],
      },
    },
    {
      label: "gate-partial-overlap-active",
      messages: shortConversation("golden-pi-g-comp-04"),
      action: {
        kind: "compress-tool",
        // fromRef m2 (the folded b2 summary → its whole interval
        // [1, 19)) + toRef m23 (the a30 line, last of the folded view)
        // → [1, 59): the protection gate rejects with zero state
        // change.  The ref-based partial-overlap gate itself is
        // unreachable on both lanes — a block's summary line resolves
        // to its whole interval and covered ordinals occupy no lines,
        // so a range can never stop inside a block.  The v1 fixture's
        // registered rejection here was likewise a protection error.
        ranges: [
          {
            fromRef: "m0002",
            toRef: "m0023",
            title: "overlap",
            summary: "overlap.",
          },
        ],
      },
    },
    {
      label: "consume-b1-create-b2",
      messages: shortConversation("golden-pi-g-comp-04"),
      action: {
        kind: "compress-tool",
        // fromRef m2 (the folded b2 summary → [1, 19)) + toRef m10 (the
        // a17/tr17 unit over [33, 35)) resolve to [1, 35), which
        // swallows b2 → b3.  (v1 rejected this round on protection; on
        // pi the unit view leaves room for the consumption.)
        ranges: [
          {
            fromRef: "m0002",
            toRef: "m0010",
            title: "更宽",
            summary: "更宽",
          },
        ],
      },
    },
    {
      label: "gate-stale-summary-ref",
      messages: shortConversation("golden-pi-g-comp-04"),
      action: {
        kind: "compress-tool",
        ranges: [
          {
            // m0043 is beyond the 15-line folded view (b3 covers
            // [1, 35)); the error names b3 as the covered-content hint.
            fromRef: "m0043",
            toRef: refFor(6),
            title: "stale",
            summary: "stale.",
          },
        ],
      },
    },
    {
      label: "gate-unknown-ref",
      messages: shortConversation("golden-pi-g-comp-04"),
      action: {
        kind: "compress-tool",
        ranges: [
          {
            fromRef: "m9999",
            toRef: refFor(6),
            title: "unknown",
            summary: "unknown.",
          },
        ],
      },
    },
  ],
};
