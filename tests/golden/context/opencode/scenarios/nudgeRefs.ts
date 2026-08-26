/**
 * Golden scenarios — context nudge and ref injection (C6/C7).
 *
 * - G-NUDGE-01: first-evaluation silence, gentle/urgent levels, anchor
 *   ratchet down after compression, and both gate-closed paths (no
 *   compress tool / no nudge section).
 * - G-REF-01: injection placement branches (tool-output first, then
 *   last text part, then synthetic part; user multi-part), strip of
 *   own-injected tags, and fold-view renumbering (covered messages do
 *   not occupy refs).
 *
 * @module
 */

import { msg, msgWithInfo, textPart, toolPart } from "../messages.js";
import type { Scenario } from "../types.js";

const SID = "golden-g-nudge-01";

/**
 * Two-turn message view for nudge evaluation.
 *
 * Only a1 carries tokens (output > 0) so the last completed assistant
 * is a1 and `promptTokens` equals `inputTokens`.
 */
function nudgeMessages(sessionID: string, inputTokens: number) {
  return [
    msg("user", "u1", [textPart("hello")], sessionID),
    msg("assistant", "a1", [toolPart("call-1", "data one")], undefined, {
      input: inputTokens,
      output: 100,
    }),
    msg("user", "u2", [textPart("again")], sessionID),
    msg("assistant", "a2", [toolPart("call-2", "data two")]),
  ];
}

/** Transform config with the nudge section attached. */
function nudgeConfig(protectedMessages: number) {
  return {
    protectedMessages,
    nudge: {
      minContext: "60%",
      minContextCap: 200000,
      maxContext: "80%",
      maxContextCap: 300000,
      growthTokens: "5%",
    },
    compress: { protectedTokens: 0, thresholdTokens: 0 },
    dedup: {},
    purgeErrors: {},
  };
}

/**
 * G-NUDGE-01 — nudge threshold evaluation and injection.
 */
export const G_NUDGE_01: Scenario = {
  id: "G-NUDGE-01",
  sessionID: SID,
  config: nudgeConfig(2),
  hasCompressTool: true,
  rounds: [
    {
      label: "set-limit-baseline-silent",
      messages: nudgeMessages(SID, 140000),
      action: { kind: "set-model-limit", context: 200000 },
    },
    {
      label: "gentle-trigger",
      messages: nudgeMessages(SID, 150000),
    },
    {
      label: "frozen-silent",
      messages: nudgeMessages(SID, 150000),
    },
    {
      label: "ratchet-down-silent",
      messages: nudgeMessages(SID, 100000),
    },
    {
      label: "re-trigger-after-ratchet",
      messages: nudgeMessages(SID, 135000),
    },
    {
      label: "urgent-trigger",
      messages: nudgeMessages(SID, 165000),
    },
    {
      label: "gate-closed-no-compress-tool",
      messages: nudgeMessages(SID, 165000),
      hasCompressTool: false,
    },
    {
      label: "gate-closed-no-nudge-config",
      messages: nudgeMessages(SID, 165000),
      config: {
        protectedMessages: 2,
        compress: { protectedTokens: 0, thresholdTokens: 0 },
        dedup: {},
        purgeErrors: {},
      },
    },
  ],
};

const REF_SID = "golden-g-ref-01";

/** Message fixture for the injection-branch round. */
function refMessages(sessionID: string) {
  return [
    // (1) user with two text parts — every text part carries the tag.
    msg("user", "u1", [textPart("part-a"), textPart("part-b")], sessionID),
    // (2) assistant with a completed tool output — tag goes there.
    msg("assistant", "a1", [toolPart("c1", "tool-out")]),
    // (3) assistant with text only — tag on the last text part.
    msg("assistant", "a2", [textPart("text-a"), textPart("text-b")]),
    // (4) assistant, no text and no completed tool output — synthetic
    //     text part inserted before the first tool part.
    msgWithInfo({ role: "assistant", id: "a3" }, [
      { type: "tool", callID: "c3", state: { input: "x" }, tool: "bash" },
    ]),
    // (5) user with only a non-text part — synthetic text part appended.
    msgWithInfo({ role: "user", id: "u4", sessionID }, [
      { type: "custom", value: "x" },
    ]),
    // (6) ignored message — never numbered, never injected.
    msg("user", "u5", [textPart("ignored", true)], sessionID),
    // (7) a message whose text mentions a fake ref mid-line — preserved.
    msg("user", "u6", [textPart("note m0009 inline")], sessionID),
  ];
}

/**
 * G-REF-01 — ref injection placement, stripping, fold renumbering.
 */
export const G_REF_01: Scenario = {
  id: "G-REF-01",
  sessionID: REF_SID,
  config: { protectedMessages: 0, dedup: {}, purgeErrors: {} },
  rounds: [
    {
      label: "injection-branches",
      messages: refMessages(REF_SID),
    },
    {
      label: "strip-reinject-idempotent",
      messages: refMessages(REF_SID),
    },
    {
      label: "fold-renumbering-covered-messages-no-ref",
      messages: [
        msg("user", "u1", [textPart("hello")], REF_SID),
        msg("assistant", "a1", [toolPart("call-1", "data")]),
        msg("user", "u2", [textPart("again")], REF_SID),
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
  ],
};
