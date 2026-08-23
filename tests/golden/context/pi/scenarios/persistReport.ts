/**
 * Golden scenarios — persistence round-trip (C8), pi lane.
 *
 * Ported from the opencode lane with pi numbering: each v1 tool part
 * becomes an assistant `toolCall` + `toolResult` pair.
 *
 * - G-PERSIST-01: state written to disk survives a simulated restart —
 *   blocks keep folding and effective marks keep pruning afterwards.
 * - G-REPORT-01 is NOT ported: it drives the /dcp `context` report
 *   command, which does not exist on pi.
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

const SID = "golden-pi-g-persist-01";

/** Output long enough to clear the zero-benefit gate (~125 tokens). */
const LONG = "x".repeat(500);

/** The round's pi view: u0, a1 (two calls), tr1, tr2, u2, a2, tr3. */
function persistView(): PiAgentMessage[] {
  return [
    userMsg("hello", { id: "u0" }),
    assistantMsg(
      [
        toolCallPart("c1", "bash", { cmd: "echo hello" }),
        toolCallPart("c2", "bash", { cmd: "echo hello" }),
      ],
      { id: "a1", usage: { input: 100000, output: 200 } },
    ),
    toolResultMsg("c1", "bash", [textPart(LONG)], { id: "tr1" }),
    toolResultMsg("c2", "bash", [textPart(LONG)], { id: "tr2" }),
    userMsg("again", { id: "u2" }),
    assistantMsg([toolCallPart("c3", "bash", { cmd: "echo x" })], {
      id: "a2",
    }),
    toolResultMsg("c3", "bash", [textPart(LONG)], { id: "tr3" }),
  ];
}

/**
 * G-PERSIST-01 — state write → restart → behaviour continuation.
 */
export const G_PERSIST_01: Scenario = {
  id: "G-PERSIST-01",
  sessionID: SID,
  config: {
    protectedMessages: 0,
    releasedPercent: 0,
    dedup: { thresholdContext: 100000 },
    purgeErrors: {},
  },
  rounds: [
    {
      label: "create-mark-and-block-persist",
      messages: persistView(),
      action: {
        kind: "create-block",
        plan: {
          anchorMessageId: "u2",
          messageIds: ["u2"],
          summary: "test summary.",
          title: "test",
          compressedTokens: 500,
          summaryTokens: 80,
        },
      },
    },
    {
      label: "restart-continues",
      messages: persistView(),
      action: { kind: "restart" },
    },
    {
      label: "second-turn-after-restart",
      messages: persistView(),
    },
  ],
};
