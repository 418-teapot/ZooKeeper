/**
 * Golden scenarios — compress/decompress tool observable contracts
 * (C10), pi lane.
 *
 * Ported from the opencode lane with pi numbering (see
 * `conversation.ts`): ranges over v1 tool exchanges cover twice as many
 * pi messages.
 *
 * G-TOOL-01 drives the tool factories directly and captures every
 * ToolResult, notification text, and loud Chinese error path: happy-path
 * single/batch compress, argument-validation rejections (missing ranges,
 * empty array, non-string fields, empty/control/hyphen/overlong titles,
 * max_ranges overflow), decompress restore/recall results, and config /
 * session-id failures.
 *
 * @module
 */

import type { Scenario } from "../types.js";
import { longConversation, makeRange } from "./conversation.js";

const SID = "golden-pi-g-tool-01";

/** Full tool config with a relaxed protection window (boundary ~38). */
function toolConfig() {
  return {
    protectedMessages: 5,
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

/** Nine ranges (max_ranges = 8) to trigger the overflow gate. */
function nineRanges() {
  const ranges = [];
  for (let i = 1; i <= 9; i++) {
    ranges.push(makeRange(i, i + 1, `主题${i}`));
  }
  return ranges;
}

/**
 * G-TOOL-01 — tool ToolResult and notification contracts.
 */
export const G_TOOL_01: Scenario = {
  id: "G-TOOL-01",
  sessionID: SID,
  config: toolConfig(),
  rounds: [
    {
      label: "baseline-refs",
      messages: longConversation(SID),
    },
    {
      label: "compress-single-range",
      messages: longConversation(SID),
      action: {
        kind: "compress-tool",
        // v1 [1, 9) → pi [1, 19): 18 messages (9 tool pairs).
        ranges: [makeRange(1, 9, "执行命令主题")],
      },
    },
    {
      label: "compress-batch-two-ranges",
      messages: longConversation(SID),
      action: {
        kind: "compress-tool",
        // v1 [9, 13] + [13, 17] → pi [34, 44) + [42, 52) in the folded
        // view (b1 = [1, 19) active): the first range runs into the pi
        // protection boundary (38) and the batch is rejected — the same
        // rejection shape the v1 snapshot registered.
        ranges: [makeRange(9, 13, "主题一"), makeRange(13, 17, "主题二")],
      },
    },
    {
      label: "compress-max-ranges-overflow",
      messages: longConversation(SID),
      action: { kind: "compress-tool", ranges: nineRanges() },
    },
    {
      label: "compress-args-not-object",
      messages: longConversation(SID),
      action: { kind: "compress-tool-raw", args: {} },
    },
    {
      label: "compress-empty-ranges",
      messages: longConversation(SID),
      action: { kind: "compress-tool-raw", args: { ranges: [] } },
    },
    {
      label: "compress-empty-title",
      messages: longConversation(SID),
      action: {
        kind: "compress-tool-raw",
        // Title validation runs before ref resolution, so the raw v1
        // refs are never resolved.
        args: {
          ranges: [
            { fromRef: "m0002", toRef: "m0006", title: "", summary: "s" },
          ],
        },
      },
    },
    {
      label: "compress-hyphen-title",
      messages: longConversation(SID),
      action: {
        kind: "compress-tool-raw",
        args: {
          ranges: [
            { fromRef: "m0002", toRef: "m0006", title: "a---b", summary: "s" },
          ],
        },
      },
    },
    {
      label: "compress-non-string-field",
      messages: longConversation(SID),
      action: {
        kind: "compress-tool-raw",
        args: {
          ranges: [{ fromRef: 123, toRef: "m0006", title: "t", summary: "s" }],
        },
      },
    },
    {
      label: "decompress-restore-result",
      messages: longConversation(SID),
      action: { kind: "decompress-tool", blockId: "b1" },
    },
    {
      label: "decompress-recall-inactive",
      messages: longConversation(SID),
      action: { kind: "decompress-tool", blockId: "b1" },
    },
    {
      label: "decompress-missing-session-id",
      messages: longConversation(SID),
      action: {
        kind: "decompress-tool-raw",
        args: { blockId: "b1" },
        toolCtx: {},
      },
    },
    {
      label: "compress-config-section-missing",
      messages: longConversation(SID),
      action: {
        kind: "compress-tool",
        ranges: [makeRange(1, 3, "x")],
      },
      config: {
        compress: undefined,
        protectedMessages: 5,
        dedup: {},
        purgeErrors: {},
      },
    },
    {
      label: "decompress-config-section-missing",
      messages: longConversation(SID),
      action: { kind: "decompress-tool", blockId: "b1" },
      config: {
        decompress: undefined,
        protectedMessages: 5,
        dedup: {},
        purgeErrors: {},
      },
    },
  ],
};
