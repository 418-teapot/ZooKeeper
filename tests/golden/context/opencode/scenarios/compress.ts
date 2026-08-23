/**
 * Golden scenarios — range-mode compress gates and lifecycle (C2).
 *
 * - G-COMP-01: full lifecycle — compress tool creates a block, the next
 *   transform folds it, decompress restores it.
 * - G-COMP-02: batch compress — two-range success plus atomic-reject
 *   paths (cross-range overlap, same-call consumption, indexed range
 *   validation failure) with zero state change.
 * - G-COMP-03: nested consumption — a wider range swallows an active
 *   block (index line + net token arithmetic), then a third generation
 *   swallows the second (the consumed predecessor is reclaimed by the
 *   fold phase before the next action).
 * - G-COMP-04: every validation gate's negative path, each with its
 *   captured error text and zero state change; the ref-based
 *   partial-overlap gate is documented as structurally unreachable.
 *
 * @module
 */

import type { Scenario } from "../types.js";
import {
  longConversation,
  makeRange,
  shortConversation,
} from "./conversation.js";

const SID = "golden-g-comp-01";

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
 * Round 1 compresses [1, 9) via the tool (block b1, ToolResult + chat
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
  sessionID: "golden-g-comp-02",
  config: compressConfig(),
  rounds: [
    {
      label: "baseline-refs",
      messages: longConversation("golden-g-comp-02"),
    },
    {
      label: "reject-cross-range-overlap",
      messages: longConversation("golden-g-comp-02"),
      action: {
        kind: "compress-tool",
        ranges: [makeRange(1, 4, "A"), makeRange(3, 6, "B")],
      },
    },
    {
      label: "reject-same-call-consumption",
      messages: longConversation("golden-g-comp-02"),
      action: {
        kind: "compress-tool",
        ranges: [makeRange(1, 4, "A"), makeRange(1, 8, "B")],
      },
    },
    {
      label: "reject-indexed-range-failure",
      messages: longConversation("golden-g-comp-02"),
      action: {
        kind: "compress-tool",
        ranges: [makeRange(1, 3, "ok"), makeRange(50, 55, "phantom")],
      },
    },
    {
      label: "reject-reversed-order",
      messages: longConversation("golden-g-comp-02"),
      action: {
        kind: "compress-tool",
        ranges: [
          {
            fromRef: "m0007",
            toRef: "m0003",
            title: "reversed",
            summary: "reversed.",
          },
        ],
      },
    },
    {
      label: "batch-two-ranges-success",
      messages: longConversation("golden-g-comp-02"),
      action: {
        kind: "compress-tool",
        ranges: [makeRange(1, 6, "主题一"), makeRange(6, 10, "主题二")],
      },
    },
  ],
};

/**
 * G-COMP-03 — nested consumption (three generations).
 *
 * b1 = [1, 7).  A wider range swallows b1 (index line
 * `--- b1: 第一段 ---`, net token arithmetic, b1 deactivated).  A third
 * generation swallows b2 into b3.
 *
 * The scenario lowers `protectedMessages` from the shared 20 to 10 so
 * the combined protection boundary lands at 18 instead of 11 — with
 * boundary 11 the wider round and the third generation resolve past the
 * window and are rejected, so the documented consumption never
 * completes.  The covered-inactive netting branch (an inactive block
 * still in the map when the action runs) is unreachable through the
 * runner: the transform's fold phase always reclaims inactive blocks
 * (`clearInactiveBlocks`) before the next action.
 */
export const G_COMP_03: Scenario = {
  id: "G-COMP-03",
  sessionID: "golden-g-comp-03",
  config: { ...compressConfig(), protectedMessages: 10 },
  rounds: [
    {
      label: "baseline-refs",
      messages: longConversation("golden-g-comp-03"),
    },
    {
      label: "compress-first-generation",
      messages: longConversation("golden-g-comp-03"),
      action: {
        kind: "compress-tool",
        ranges: [makeRange(1, 6, "第一段")],
      },
    },
    {
      label: "consume-b1-wider-range",
      messages: longConversation("golden-g-comp-03"),
      action: {
        kind: "compress-tool",
        ranges: [makeRange(1, 9, "第二段")],
      },
    },
    {
      label: "third-generation-reabsorbs-inactive",
      messages: longConversation("golden-g-comp-03"),
      action: {
        kind: "compress-tool",
        // After b2 = [1, 15) the folded view numbers the first message
        // after the block as line 3, so fromRef m2 (the b2 summary) +
        // toRef m3 resolve to [1, 16) and swallow b2 → b3.
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
 * negative-benefit gate fire on small ranges.  Rounds 2-5 reject with
 * zero state change (reversed order, protection zone, first user,
 * phantom); round 6 creates b1; rounds 7-8 reject against b1
 * (negative benefit, no-new-content); round 9 swallows b1 into b2;
 * rounds 10-12 reject against b2 (protection, stale ref, unknown ref).
 *
 * The ref-based partial-overlap gate is structurally unreachable: a
 * block's summary line resolves to its whole interval and covered
 * ordinals occupy no lines, so a range can never stop inside a block —
 * any range intersecting a block either fully covers it (swallow) or
 * misses it.  Round 10 therefore registers the closest reachable
 * behavior: a range anchored on the b2 summary line resolves past the
 * protection boundary and is rejected there.
 */
export const G_COMP_04: Scenario = {
  id: "G-COMP-04",
  sessionID: "golden-g-comp-04",
  config: {
    protectedMessages: 20,
    releasedPercent: 10,
    dedup: {},
    purgeErrors: {},
    compress: {
      // Short-output conversation (~28 tokens/msg): a 300-token budget
      // still protects the tail while keeping the token boundary well
      // above the message-count boundary (11).  The 80-token phantom
      // threshold sits between [1,3) (~56, phantom) and [1,4) (~84,
      // overlap/negative-benefit probes).
      thresholdTokens: 80,
      protectedTokens: 300,
      maxRanges: 8,
    },
    decompress: { maxFillPercent: 90 },
  },
  rounds: [
    {
      label: "baseline-refs",
      messages: shortConversation("golden-g-comp-04"),
    },
    {
      label: "gate-reversed-order",
      messages: shortConversation("golden-g-comp-04"),
      action: {
        kind: "compress-tool",
        ranges: [
          {
            fromRef: "m0008",
            toRef: "m0002",
            title: "reversed",
            summary: "reversed.",
          },
        ],
      },
    },
    {
      label: "gate-protection-zone",
      messages: shortConversation("golden-g-comp-04"),
      action: {
        kind: "compress-tool",
        ranges: [makeRange(1, 29, "protected")],
      },
    },
    {
      label: "gate-first-user",
      messages: shortConversation("golden-g-comp-04"),
      action: {
        kind: "compress-tool",
        ranges: [makeRange(0, 4, "first-user")],
      },
    },
    {
      label: "gate-phantom-low-benefit",
      messages: shortConversation("golden-g-comp-04"),
      action: {
        kind: "compress-tool",
        // [1, 3) is 2 messages ≈ 56 tokens < the 80-token threshold —
        // the phantom gate fires (the previous [1, 4) range crossed the
        // threshold and created a block).
        ranges: [makeRange(1, 2, "phantom")],
      },
    },
    {
      label: "create-b1",
      messages: shortConversation("golden-g-comp-04"),
      action: {
        kind: "compress-tool",
        ranges: [makeRange(1, 3, "已有")],
      },
    },
    {
      label: "gate-negative-benefit",
      messages: shortConversation("golden-g-comp-04"),
      action: {
        kind: "compress-tool",
        ranges: [
          {
            // m2 is b1's folded summary → resolves to b1's interval
            // [1, 4); m7 is a9 → end 9: [1, 9) swallows b1 and the
            // 2000-char summary (~512 tokens) is not below the net
            // content (~140 tokens).
            fromRef: "m0002",
            toRef: "m0007",
            title: "negative",
            summary: "s".repeat(2000),
          },
        ],
      },
    },
    {
      label: "gate-no-new-content",
      messages: shortConversation("golden-g-comp-04"),
      action: {
        kind: "compress-tool",
        ranges: [
          {
            // fromRef m2 + toRef m2 both resolve to b1's whole interval
            // [1, 4): re-covering the plain block nets zero new content,
            // so the no-new-content gate fires (the previous fixture ran
            // after the consume round, where the net is positive and the
            // gate cannot fire).
            fromRef: "m0002",
            toRef: "m0002",
            title: "exact-again",
            summary: "exact.",
          },
        ],
      },
    },
    {
      label: "consume-b1-create-b2",
      messages: shortConversation("golden-g-comp-04"),
      action: {
        kind: "compress-tool",
        // m8 is a10 → end 10: [1, 10) swallows b1 → b2.  (The previous
        // [1, 9] range resolved past the protection boundary 11.)
        ranges: [makeRange(1, 7, "更宽")],
      },
    },
    {
      label: "gate-partial-overlap-unreachable",
      messages: shortConversation("golden-g-comp-04"),
      action: {
        kind: "compress-tool",
        ranges: [
          {
            // The ref-based partial-overlap gate is unreachable (see the
            // docstring); this round registers the closest reachable
            // behavior — m2 (b2's summary → [1, 10)) + m5 (a13 → end 13)
            // resolve to [1, 13), which trips the protection gate.
            fromRef: "m0002",
            toRef: "m0005",
            title: "overlap",
            summary: "overlap.",
          },
        ],
      },
    },
    {
      label: "gate-stale-summary-ref",
      messages: shortConversation("golden-g-comp-04"),
      action: {
        kind: "compress-tool",
        ranges: [
          {
            // m0032 is beyond the 23-line folded view (b2 covers
            // [1, 10)); the error names b2 as the covered-content hint.
            fromRef: "m0032",
            toRef: "m0006",
            title: "stale",
            summary: "stale.",
          },
        ],
      },
    },
    {
      label: "gate-unknown-ref",
      messages: shortConversation("golden-g-comp-04"),
      action: {
        kind: "compress-tool",
        ranges: [
          {
            fromRef: "m9999",
            toRef: "m0006",
            title: "unknown",
            summary: "unknown.",
          },
        ],
      },
    },
  ],
};
