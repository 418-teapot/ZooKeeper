/**
 * Golden scenarios — decompress dual path and restore gate (C3).
 *
 * - G-DEC-01: restore vs recall — active block restores (two-round view
 *   effect), inactive block recalls its summary verbatim (idempotent,
 *   zero state change), long summaries are truncated with a Chinese
 *   tail note, and invalid / missing block ids error loudly.
 * - G-DEC-02: maxFillPercent gate three states — restore allowed, restore
 *   rejected (with delta guidance), and gate skipped when no model limit
 *   is known.
 *
 * @module
 */

import type { Scenario } from "../types.js";
import { longConversation, makeRange } from "./conversation.js";

const SID = "golden-g-dec-01";

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
 * b1 ([1, 6)) is consumed by b2 ([1, 9)) so it is inactive.  Recall b1
 * returns its summary body verbatim; restore b2 deactivates it; recall
 * stays idempotent; a third block with a 17000-char summary truncates
 * on recall.  Invalid ids error loudly.
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
        ranges: [makeRange(1, 6, "第一段")],
      },
    },
    {
      label: "consume-b1-create-b2",
      messages: longConversation(SID),
      action: {
        kind: "compress-tool",
        ranges: [makeRange(1, 9, "第二段")],
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
        ranges: [makeRange(9, 12, "长摘要", "x".repeat(17000))],
      },
    },
    {
      label: "consume-b3-create-b4",
      messages: longConversation(SID),
      action: {
        kind: "compress-tool",
        ranges: [makeRange(9, 13, "第四段")],
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
 * Restore of b1 with no model limit skips the gate; restore of b4 with
 * a 20000-token limit at 30% fill is rejected (delta guidance, zero
 * state change); the same restore with a 500000-token limit passes.
 */
export const G_DEC_02: Scenario = {
  id: "G-DEC-02",
  sessionID: "golden-g-dec-02",
  config: decConfig(30),
  rounds: [
    {
      label: "baseline-refs",
      messages: longConversation("golden-g-dec-02"),
    },
    {
      label: "create-b1",
      messages: longConversation("golden-g-dec-02"),
      action: {
        kind: "compress-tool",
        ranges: [makeRange(1, 6, "第一段")],
      },
    },
    {
      label: "restore-no-model-limit-skipped",
      messages: longConversation("golden-g-dec-02"),
      action: { kind: "decompress-tool", blockId: "b1" },
    },
    {
      label: "create-b4",
      messages: longConversation("golden-g-dec-02"),
      action: {
        kind: "compress-tool",
        ranges: [makeRange(6, 9, "第四段")],
      },
    },
    {
      label: "set-limit-20k",
      messages: longConversation("golden-g-dec-02"),
      action: { kind: "set-model-limit", context: 20000 },
    },
    {
      label: "restore-rejected-at-limit",
      messages: longConversation("golden-g-dec-02"),
      action: { kind: "decompress-tool", blockId: "b2" },
    },
    {
      label: "set-limit-500k",
      messages: longConversation("golden-g-dec-02"),
      action: { kind: "set-model-limit", context: 500000 },
    },
    {
      label: "restore-allowed-at-limit",
      messages: longConversation("golden-g-dec-02"),
      action: { kind: "decompress-tool", blockId: "b2" },
    },
  ],
};
