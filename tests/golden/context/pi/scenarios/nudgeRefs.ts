/**
 * Golden scenarios — context nudge and ref injection (C6/C7), pi lane.
 *
 * Ported from the opencode lane with pi numbering: nudge messages and
 * ref-injection fixtures translate each v1 tool part into an assistant
 * `toolCall` + `toolResult` pair.
 *
 * - G-NUDGE-01: first-evaluation silence, gentle/urgent levels, anchor
 *   ratchet down after compression, and both gate-closed paths (no
 *   compress tool / no nudge section).
 * - G-REF-01: injection placement branches (tool-output first, then
 *   last text part, then no injection on toolCall-only assistants —
 *   the pi lens does not inject into `tool-input` regions; user
 *   multi-part), and fold-view renumbering (covered messages do not
 *   occupy refs).
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

const SID = "golden-pi-g-nudge-01";

/**
 * Two-turn pi message view for nudge evaluation.
 *
 * Only a1 carries tokens (output > 0) so the last completed assistant
 * is a1 and `promptTokens` equals `inputTokens`.
 */
function nudgeMessages(sessionID: string, inputTokens: number): PiAgentMessage[] {
  return [
    userMsg("hello", { id: "u1" }),
    assistantMsg([toolCallPart("call-1", "bash", { cmd: "x" })], {
      id: "a1",
      usage: { input: inputTokens, output: 100 },
    }),
    toolResultMsg("call-1", "bash", [textPart("data one")], { id: "tr1" }),
    userMsg("again", { id: "u2" }),
    assistantMsg([toolCallPart("call-2", "bash", { cmd: "x" })], { id: "a2" }),
    toolResultMsg("call-2", "bash", [textPart("data two")], { id: "tr2" }),
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

const REF_SID = "golden-pi-g-ref-01";

/**
 * Message fixture for the injection-branch round.
 *
 * The v1 fixture's ignored message is omitted — pi has no
 * ignored-message concept (the adapter maps every message to visible
 * lens messages), so there is nothing to exercise.  The pi lens also
 * never injects into `tool-input` regions, so the toolCall-only
 * assistant renders without a line marker (it still occupies a line).
 */
function refMessages(sessionID: string): PiAgentMessage[] {
  return [
    // (1) user with two text parts — the first text part carries the tag.
    userMsg([textPart("part-a"), textPart("part-b")], { id: "u1" }),
    // (2) assistant with a completed tool output — tag goes there.
    assistantMsg([toolCallPart("c1", "bash", { input: "" })], { id: "a1" }),
    toolResultMsg("c1", "bash", [textPart("tool-out")], { id: "tr1" }),
    // (3) assistant with text only — tag on the last text part.
    assistantMsg([textPart("text-a"), textPart("text-b")], { id: "a2" }),
    // (4) assistant, no text and no tool result — tool-input regions are
    //     not injectable, so no marker appears on this message.
    assistantMsg([toolCallPart("c3", "bash", { input: "x" })], { id: "a3" }),
    // (5) user with only a non-text part — no text to inject.
    userMsg([{ type: "image", data: "eA==", mimeType: "image/png" }], {
      id: "u4",
    }),
    // (6) a message whose text mentions a fake ref mid-line — preserved.
    userMsg("note m0009 inline", { id: "u6" }),
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
        userMsg("hello", { id: "u1" }),
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
  ],
};
