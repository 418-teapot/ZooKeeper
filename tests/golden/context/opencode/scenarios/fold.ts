/**
 * Golden scenarios — fold semantics (C1).
 *
 * - G-FOLD-01: multi-block folded view structure (summary position,
 *   gap preservation, first-user force-keep, summary text verbatim).
 * - G-FOLD-02: full deactivation restores the original view.
 * - G-FOLD-03: revert (truncation) deactivates the block and covered
 *   messages reappear; the deactivation forces a pending-mark flush.
 * - G-FOLD-04: compaction removes the anchor, deactivates the block,
 *   and renumbers refs from m0001.
 *
 * @module
 */

import { compactionSummaryMsg, msg, textPart, toolPart } from "../messages.js";
import type { Scenario } from "../types.js";

const BASE_CONFIG = { dedup: {}, purgeErrors: {} };

/**
 * A short conversation: first user + 8 tool exchanges + trailing user +
 * final assistant.  Enough structure for two disjoint blocks, a gap,
 * and a tail.
 */
function smallConversation(sessionID: string) {
  const msgs = [msg("user", "u0", [textPart("开场问题")], sessionID)];
  for (let i = 1; i <= 8; i++) {
    msgs.push(
      msg("assistant", `a${i}`, [toolPart(`c-a${i}`, `data ${i}`)], undefined),
    );
  }
  msgs.push(msg("user", "u9", [textPart("最后一个问题")], sessionID));
  msgs.push(msg("assistant", "a10", [textPart("回答完毕")]));
  return msgs;
}

/**
 * G-FOLD-01 — multi-block folded view structure.
 *
 * b1 covers [u0, a1, a2] anchored at a2 (the first user is covered →
 * force-kept, summary injected at the anchor position).  b2 covers
 * [a4, a5, a6] anchored at a6.  a3 is the inter-block gap; a7..a10 are
 * the tail.  Expected folded view: u0 (kept), summary(b1), a3,
 * summary(b2), a7..a10.
 */
export const G_FOLD_01: Scenario = {
  id: "G-FOLD-01",
  sessionID: "golden-g-fold-01",
  config: BASE_CONFIG,
  rounds: [
    {
      label: "baseline-no-blocks",
      messages: smallConversation("golden-g-fold-01"),
    },
    {
      label: "create-two-blocks-fold",
      messages: smallConversation("golden-g-fold-01"),
      action: {
        kind: "create-block",
        plan: {
          anchorMessageId: "a2",
          messageIds: ["u0", "a1", "a2"],
          summary: "first segment summary.",
          title: "第一段",
          compressedTokens: 900,
          summaryTokens: 40,
        },
      },
    },
    {
      label: "add-second-block-fold",
      messages: smallConversation("golden-g-fold-01"),
      action: {
        kind: "create-block",
        plan: {
          anchorMessageId: "a6",
          messageIds: ["a4", "a5", "a6"],
          summary: "second segment summary.",
          title: "第二段",
          compressedTokens: 900,
          summaryTokens: 40,
        },
      },
    },
  ],
};

/**
 * G-FOLD-02 — full deactivation restores the original view.
 *
 * Creates the same two blocks as G-FOLD-01 (folded view captured),
 * then deactivates them one at a time.  The final round's view is the
 * original message list byte-for-byte — no synthetic residue.
 */
export const G_FOLD_02: Scenario = {
  id: "G-FOLD-02",
  sessionID: "golden-g-fold-02",
  config: BASE_CONFIG,
  rounds: [
    {
      label: "create-b1",
      messages: smallConversation("golden-g-fold-02"),
      action: {
        kind: "create-block",
        plan: {
          anchorMessageId: "a2",
          messageIds: ["u0", "a1", "a2"],
          summary: "first segment summary.",
          title: "第一段",
          compressedTokens: 900,
          summaryTokens: 40,
        },
      },
    },
    {
      label: "create-b2",
      messages: smallConversation("golden-g-fold-02"),
      action: {
        kind: "create-block",
        plan: {
          anchorMessageId: "a6",
          messageIds: ["a4", "a5", "a6"],
          summary: "second segment summary.",
          title: "第二段",
          compressedTokens: 900,
          summaryTokens: 40,
        },
      },
    },
    {
      label: "deactivate-b1",
      messages: smallConversation("golden-g-fold-02"),
      action: { kind: "deactivate-block", blockId: 1 },
    },
    {
      label: "deactivate-b2-view-restored",
      messages: smallConversation("golden-g-fold-02"),
      action: { kind: "deactivate-block", blockId: 2 },
    },
  ],
};

/**
 * G-FOLD-03 — revert (truncation) deactivates the block; covered
 * messages reappear; pending marks are force-flushed.
 *
 * b1 covers [a1, u2] anchored at u2.  A revert physically deletes u2
 * (the anchor) while a1 stays in the view.  The round's transform
 * deactivates b1 (activeBefore > activeAfter → pendingViewChange),
 * which forces the release of the two pre-seeded pending marks.
 */
export const G_FOLD_03: Scenario = {
  id: "G-FOLD-03",
  sessionID: "golden-g-fold-03",
  config: { ...BASE_CONFIG, releasedPercent: 5 },
  rounds: [
    {
      label: "create-block-fold",
      messages: [
        msg("user", "u0", [textPart("hello")], "golden-g-fold-03"),
        msg("assistant", "a1", [toolPart("call-1", "data")]),
        msg("user", "u2", [textPart("again")], "golden-g-fold-03"),
        msg("assistant", "a2", [toolPart("call-2", "done")]),
      ],
      action: {
        kind: "create-block",
        plan: {
          anchorMessageId: "u2",
          messageIds: ["a1", "u2"],
          summary: "test summary.",
          title: "test",
          compressedTokens: 1500,
          summaryTokens: 80,
        },
      },
    },
    {
      label: "seed-pending-marks",
      messages: [
        msg("user", "u0", [textPart("hello")], "golden-g-fold-03"),
        msg("assistant", "a1", [toolPart("call-1", "data")]),
        msg("user", "u2", [textPart("again")], "golden-g-fold-03"),
        msg("assistant", "a2", [toolPart("call-2", "done")]),
      ],
      action: {
        kind: "add-mark",
        callID: "call-1",
        tokens: 100,
        effective: false,
        action: "tool-output",
      },
    },
    {
      label: "seed-pending-mark-two",
      messages: [
        msg("user", "u0", [textPart("hello")], "golden-g-fold-03"),
        msg("assistant", "a1", [toolPart("call-1", "data")]),
        msg("user", "u2", [textPart("again")], "golden-g-fold-03"),
        msg("assistant", "a2", [toolPart("call-2", "done")]),
      ],
      action: {
        kind: "add-mark",
        callID: "call-2",
        tokens: 200,
        effective: false,
        action: "tool-output",
      },
    },
    {
      label: "revert-anchor-deleted-deactivate-flush",
      messages: [
        msg("user", "u0", [textPart("hello")], "golden-g-fold-03"),
        // a1 was covered by the block — reappears after deactivation.
        msg("assistant", "a1", [toolPart("call-1", "data")]),
        // u2 (the anchor) is GONE — physically deleted by the revert.
        msg("assistant", "a2", [toolPart("call-2", "done")]),
      ],
    },
  ],
};

/**
 * G-FOLD-04 — compaction invalidates the block and renumbers refs.
 *
 * b1 covers [a1..a4] anchored at a4.  Host compaction replaces the old
 * history with a summary-boundary message (info.summary === true):
 * the anchor disappears → the block deactivates; the boundary id
 * changes → refs reset and renumber from m0001 over the new view.
 */
export const G_FOLD_04: Scenario = {
  id: "G-FOLD-04",
  sessionID: "golden-g-fold-04",
  config: BASE_CONFIG,
  rounds: [
    {
      label: "baseline-refs",
      messages: [
        msg("user", "u0", [textPart("hello")], "golden-g-fold-04"),
        msg("assistant", "a1", [toolPart("call-1", "data one")]),
        msg("assistant", "a2", [toolPart("call-2", "data two")]),
        msg("assistant", "a3", [toolPart("call-3", "data three")]),
        msg("assistant", "a4", [toolPart("call-4", "data four")]),
        msg("assistant", "a5", [toolPart("call-5", "data five")]),
      ],
      action: {
        kind: "create-block",
        plan: {
          anchorMessageId: "a4",
          messageIds: ["a1", "a2", "a3", "a4"],
          summary: "early segment.",
          title: "compacted",
          compressedTokens: 1200,
          summaryTokens: 60,
        },
      },
    },
    {
      label: "compaction-deactivates-renumbers",
      messages: [
        compactionSummaryMsg(
          "boundary_2",
          "golden-g-fold-04",
          "compaction summary",
        ),
        msg("user", "u0", [textPart("hello")], "golden-g-fold-04"),
        msg("assistant", "a5", [toolPart("call-5", "data five")]),
        msg("user", "u6", [textPart("again")], "golden-g-fold-04"),
        msg("assistant", "a7", [toolPart("call-7", "data seven")]),
      ],
    },
    {
      label: "compaction-stable-renumber-continues",
      messages: [
        compactionSummaryMsg(
          "boundary_2",
          "golden-g-fold-04",
          "compaction summary",
        ),
        msg("user", "u0", [textPart("hello")], "golden-g-fold-04"),
        msg("assistant", "a5", [toolPart("call-5", "data five")]),
        msg("user", "u6", [textPart("again")], "golden-g-fold-04"),
        msg("assistant", "a7", [toolPart("call-7", "data seven")]),
      ],
    },
  ],
};
