/**
 * Golden scenarios — fold semantics (C1), pi lane.
 *
 * Ported from the opencode lane with pi numbering: each v1 tool
 * exchange becomes an assistant `toolCall` + `toolResult` message pair,
 * so a v1 plan over N tool exchanges covers 2N pi messages (plus any
 * user message in between).  Block plans use the pi fixture ids (`aN`
 * for the toolCall assistant, `trN` for the toolResult), and the folded
 * summaries render as synthetic pi user messages with the same
 * `[Block bN · K 条]` label (K counts pi messages).
 *
 * - G-FOLD-01: multi-block folded view structure (summary position,
 *   gap preservation, first-user force-keep, summary text verbatim).
 * - G-FOLD-02: full deactivation restores the original view.
 * - G-FOLD-03: revert (truncation) deactivates the block and covered
 *   messages reappear; the deactivation forces a pending-mark flush on
 *   the next turn.
 * - G-FOLD-04: compaction removes the anchor, deactivates the block,
 *   and renumbers refs from m1 — the pi compaction boundary is a user
 *   message with the `summary: true` marker and, unlike v1, occupies a
 *   numbered view line (pi has no hidden messages).
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

const BASE_CONFIG = { dedup: {}, purgeErrors: {} };

/**
 * A short pi conversation: first user + 8 tool exchanges (each an
 * assistant `toolCall` + `toolResult` pair) + trailing user + final
 * assistant — 19 messages.  Enough structure for two disjoint blocks,
 * a gap, and a tail.
 */
function smallConversation(sessionID: string): PiAgentMessage[] {
  const msgs: PiAgentMessage[] = [userMsg("开场问题", { id: "u0" })];
  for (let i = 1; i <= 8; i++) {
    msgs.push(
      assistantMsg([toolCallPart(`c-a${i}`, "bash", { cmd: "x" })], {
        id: `a${i}`,
      }),
    );
    msgs.push(
      toolResultMsg(`c-a${i}`, "bash", [textPart(`data ${i}`)], {
        id: `tr${i}`,
      }),
    );
  }
  msgs.push(userMsg("最后一个问题", { id: "u9" }));
  msgs.push(assistantMsg([textPart("回答完毕")], { id: "a10" }));
  return msgs;
}

/**
 * G-FOLD-01 — multi-block folded view structure.
 *
 * b1 covers [u0, a1, tr1, a2, tr2] anchored at a2 (the first user is
 * covered → force-kept, summary injected at the anchor position).  b2
 * covers [a4, tr4, a5, tr5, a6, tr6] anchored at a6.  a3/tr3 is the
 * inter-block gap; a7..a10 are the tail.  Expected folded view: u0
 * (kept), summary(b1), a3, tr3, summary(b2), a7..a10.
 */
export const G_FOLD_01: Scenario = {
  id: "G-FOLD-01",
  sessionID: "golden-pi-g-fold-01",
  config: BASE_CONFIG,
  rounds: [
    {
      label: "baseline-no-blocks",
      messages: smallConversation("golden-pi-g-fold-01"),
    },
    {
      label: "create-two-blocks-fold",
      messages: smallConversation("golden-pi-g-fold-01"),
      action: {
        kind: "create-block",
        plan: {
          anchorMessageId: "a2",
          messageIds: ["u0", "a1", "tr1", "a2", "tr2"],
          summary: "first segment summary.",
          title: "第一段",
          compressedTokens: 900,
          summaryTokens: 40,
        },
      },
    },
    {
      label: "add-second-block-fold",
      messages: smallConversation("golden-pi-g-fold-01"),
      action: {
        kind: "create-block",
        plan: {
          anchorMessageId: "a6",
          messageIds: ["a4", "tr4", "a5", "tr5", "a6", "tr6"],
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
  sessionID: "golden-pi-g-fold-02",
  config: BASE_CONFIG,
  rounds: [
    {
      label: "create-b1",
      messages: smallConversation("golden-pi-g-fold-02"),
      action: {
        kind: "create-block",
        plan: {
          anchorMessageId: "a2",
          messageIds: ["u0", "a1", "tr1", "a2", "tr2"],
          summary: "first segment summary.",
          title: "第一段",
          compressedTokens: 900,
          summaryTokens: 40,
        },
      },
    },
    {
      label: "create-b2",
      messages: smallConversation("golden-pi-g-fold-02"),
      action: {
        kind: "create-block",
        plan: {
          anchorMessageId: "a6",
          messageIds: ["a4", "tr4", "a5", "tr5", "a6", "tr6"],
          summary: "second segment summary.",
          title: "第二段",
          compressedTokens: 900,
          summaryTokens: 40,
        },
      },
    },
    {
      label: "deactivate-b1",
      messages: smallConversation("golden-pi-g-fold-02"),
      action: { kind: "deactivate-block", blockId: 1 },
    },
    {
      label: "deactivate-b2-view-restored",
      messages: smallConversation("golden-pi-g-fold-02"),
      action: { kind: "deactivate-block", blockId: 2 },
    },
  ],
};

/**
 * G-FOLD-03 — revert (truncation) deactivates the block; covered
 * messages reappear; pending marks are force-flushed.
 *
 * b1 covers [a1, tr1, u2] anchored at u2.  A revert physically deletes
 * u2 (the anchor) while a1 stays in the view.  The round's transform
 * deactivates b1 (activeBefore > activeAfter → pendingViewChange),
 * which forces the release of the two pre-seeded pending marks on the
 * next turn.
 */
export const G_FOLD_03: Scenario = {
  id: "G-FOLD-03",
  sessionID: "golden-pi-g-fold-03",
  config: { ...BASE_CONFIG, releasedPercent: 5 },
  rounds: [
    {
      label: "create-block-fold",
      messages: [
        userMsg("hello", { id: "u0" }),
        assistantMsg([toolCallPart("call-1", "bash", { cmd: "x" })], {
          id: "a1",
        }),
        toolResultMsg("call-1", "bash", [textPart("data")], { id: "tr1" }),
        userMsg("again", { id: "u2" }),
        assistantMsg([toolCallPart("call-2", "bash", { cmd: "x" })], {
          id: "a2",
        }),
        toolResultMsg("call-2", "bash", [textPart("done")], { id: "tr2" }),
      ],
      action: {
        kind: "create-block",
        plan: {
          anchorMessageId: "u2",
          messageIds: ["a1", "tr1", "u2"],
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
        userMsg("hello", { id: "u0" }),
        assistantMsg([toolCallPart("call-1", "bash", { cmd: "x" })], {
          id: "a1",
        }),
        toolResultMsg("call-1", "bash", [textPart("data")], { id: "tr1" }),
        userMsg("again", { id: "u2" }),
        assistantMsg([toolCallPart("call-2", "bash", { cmd: "x" })], {
          id: "a2",
        }),
        toolResultMsg("call-2", "bash", [textPart("done")], { id: "tr2" }),
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
        userMsg("hello", { id: "u0" }),
        assistantMsg([toolCallPart("call-1", "bash", { cmd: "x" })], {
          id: "a1",
        }),
        toolResultMsg("call-1", "bash", [textPart("data")], { id: "tr1" }),
        userMsg("again", { id: "u2" }),
        assistantMsg([toolCallPart("call-2", "bash", { cmd: "x" })], {
          id: "a2",
        }),
        toolResultMsg("call-2", "bash", [textPart("done")], { id: "tr2" }),
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
        userMsg("hello", { id: "u0" }),
        // a1 was covered by the block — reappears after deactivation.
        assistantMsg([toolCallPart("call-1", "bash", { cmd: "x" })], {
          id: "a1",
        }),
        toolResultMsg("call-1", "bash", [textPart("data")], { id: "tr1" }),
        // u2 (the anchor) is GONE — physically deleted by the revert.
        assistantMsg([toolCallPart("call-2", "bash", { cmd: "x" })], {
          id: "a2",
        }),
        toolResultMsg("call-2", "bash", [textPart("done")], { id: "tr2" }),
      ],
    },
  ],
};

/**
 * Build a pi compaction-boundary message (what the host inserts after
 * built-in compaction).
 *
 * pi has no ignored/hidden messages, so the boundary occupies a
 * numbered view line; the `summary: true` marker is what the pi
 * capture recognizes as the compaction boundary.
 *
 * @param text - The compaction summary text.
 * @returns The boundary user message.
 */
function compactionBoundaryMsg(text: string): PiAgentMessage {
  const message = userMsg(text) as unknown as Record<string, unknown>;
  message.summary = true;
  return message as unknown as PiAgentMessage;
}

/**
 * G-FOLD-04 — compaction invalidates the block and renumbers refs.
 *
 * b1 covers [a1..a4] (with their toolResults) anchored at a4.  Host
 * compaction replaces the old history with a summary-boundary message
 * (`summary: true`): the anchor disappears → the block deactivates;
 * the boundary id changes → refs reset and renumber from m1 over the
 * new view.  On pi the boundary message itself occupies a numbered
 * line (pi has no hidden messages — a documented lane difference from
 * v1, where the boundary is ignored/un-numbered).
 */
export const G_FOLD_04: Scenario = {
  id: "G-FOLD-04",
  sessionID: "golden-pi-g-fold-04",
  config: BASE_CONFIG,
  rounds: [
    {
      label: "baseline-refs",
      messages: [
        userMsg("hello", { id: "u0" }),
        assistantMsg([toolCallPart("call-1", "bash", { cmd: "x" })], {
          id: "a1",
        }),
        toolResultMsg("call-1", "bash", [textPart("data one")], { id: "tr1" }),
        assistantMsg([toolCallPart("call-2", "bash", { cmd: "x" })], {
          id: "a2",
        }),
        toolResultMsg("call-2", "bash", [textPart("data two")], { id: "tr2" }),
        assistantMsg([toolCallPart("call-3", "bash", { cmd: "x" })], {
          id: "a3",
        }),
        toolResultMsg("call-3", "bash", [textPart("data three")], {
          id: "tr3",
        }),
        assistantMsg([toolCallPart("call-4", "bash", { cmd: "x" })], {
          id: "a4",
        }),
        toolResultMsg("call-4", "bash", [textPart("data four")], {
          id: "tr4",
        }),
        assistantMsg([toolCallPart("call-5", "bash", { cmd: "x" })], {
          id: "a5",
        }),
        toolResultMsg("call-5", "bash", [textPart("data five")], {
          id: "tr5",
        }),
      ],
      action: {
        kind: "create-block",
        plan: {
          anchorMessageId: "a4",
          messageIds: ["a1", "tr1", "a2", "tr2", "a3", "tr3", "a4", "tr4"],
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
        compactionBoundaryMsg("compaction summary"),
        userMsg("hello", { id: "u0" }),
        assistantMsg([toolCallPart("call-5", "bash", { cmd: "x" })], {
          id: "a5",
        }),
        toolResultMsg("call-5", "bash", [textPart("data five")], {
          id: "tr5",
        }),
        userMsg("again", { id: "u6" }),
        assistantMsg([toolCallPart("call-7", "bash", { cmd: "x" })], {
          id: "a7",
        }),
        toolResultMsg("call-7", "bash", [textPart("data seven")], {
          id: "tr7",
        }),
      ],
    },
    {
      label: "compaction-stable-renumber-continues",
      messages: [
        compactionBoundaryMsg("compaction summary"),
        userMsg("hello", { id: "u0" }),
        assistantMsg([toolCallPart("call-5", "bash", { cmd: "x" })], {
          id: "a5",
        }),
        toolResultMsg("call-5", "bash", [textPart("data five")], {
          id: "tr5",
        }),
        userMsg("again", { id: "u6" }),
        assistantMsg([toolCallPart("call-7", "bash", { cmd: "x" })], {
          id: "a7",
        }),
        toolResultMsg("call-7", "bash", [textPart("data seven")], {
          id: "tr7",
        }),
      ],
    },
  ],
};
