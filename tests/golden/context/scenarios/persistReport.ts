/**
 * Golden scenarios — persistence round-trip and /dcp report (C8/C12).
 *
 * - G-PERSIST-01: state written to disk survives a simulated restart —
 *   blocks keep folding and effective marks keep pruning afterwards.
 * - G-REPORT-01: /dcp context report rendering — empty reclaim section,
 *   dual message counts, reclaim section with active blocks + marks,
 *   and the unknown-subcommand help.
 *
 * @module
 */

import { msg, textPart, toolPart } from "../messages.js";
import type { Scenario } from "../types.js";

const SID = "golden-g-persist-01";

/** Output long enough to clear the zero-benefit gate (~125 tokens). */
const LONG = "x".repeat(500);

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
      messages: [
        msg("user", "u0", [textPart("hello")], SID),
        msg(
          "assistant",
          "a1",
          [
            toolPart("c1", LONG, { cmd: "echo hello" }),
            toolPart("c2", LONG, { cmd: "echo hello" }),
          ],
          undefined,
          { input: 100000, output: 200 },
        ),
        msg("user", "u2", [textPart("again")], SID),
        msg("assistant", "a2", [toolPart("c3", LONG, { cmd: "echo x" })]),
      ],
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
      messages: [
        msg("user", "u0", [textPart("hello")], SID),
        msg(
          "assistant",
          "a1",
          [
            toolPart("c1", LONG, { cmd: "echo hello" }),
            toolPart("c2", LONG, { cmd: "echo hello" }),
          ],
          undefined,
          { input: 100000, output: 200 },
        ),
        msg("user", "u2", [textPart("again")], SID),
        msg("assistant", "a2", [toolPart("c3", LONG, { cmd: "echo x" })]),
      ],
      action: { kind: "restart" },
    },
    {
      label: "second-turn-after-restart",
      messages: [
        msg("user", "u0", [textPart("hello")], SID),
        msg(
          "assistant",
          "a1",
          [
            toolPart("c1", LONG, { cmd: "echo hello" }),
            toolPart("c2", LONG, { cmd: "echo hello" }),
          ],
          undefined,
          { input: 100000, output: 200 },
        ),
        msg("user", "u2", [textPart("again")], SID),
        msg("assistant", "a2", [toolPart("c3", LONG, { cmd: "echo x" })]),
      ],
    },
  ],
};

const RPT_SID = "golden-g-report-01";

/** Six-message view: first user + 3 tool messages + last user + answer. */
function reportView(sessionID: string) {
  return [
    msg("user", "u0", [textPart("开场问题")], sessionID),
    msg("assistant", "a1", [toolPart("c1", LONG)]),
    msg("assistant", "a2", [toolPart("c2", LONG)]),
    msg("assistant", "a3", [toolPart("c3", LONG)]),
    msg("user", "u4", [textPart("最后一个问题")], sessionID),
    msg("assistant", "a5", [textPart("回答完毕")]),
  ];
}

/**
 * G-REPORT-01 — /dcp context report and reclaim-section rendering.
 */
export const G_REPORT_01: Scenario = {
  id: "G-REPORT-01",
  sessionID: RPT_SID,
  config: {
    protectedMessages: 0,
    releasedPercent: 0,
    dedup: { thresholdContext: 100000 },
    purgeErrors: {},
  },
  rounds: [
    {
      label: "baseline-transform",
      messages: reportView(RPT_SID),
    },
    {
      label: "dcp-context-no-reclaim",
      messages: reportView(RPT_SID),
      action: { kind: "dcp", args: "context" },
    },
    {
      label: "create-block",
      messages: reportView(RPT_SID),
      action: {
        kind: "create-block",
        plan: {
          anchorMessageId: "a3",
          messageIds: ["a1", "a2", "a3"],
          summary: "report block.",
          title: "报告块",
          compressedTokens: 900,
          summaryTokens: 40,
        },
      },
    },
    {
      label: "seed-effective-mark",
      messages: reportView(RPT_SID),
      action: {
        kind: "add-mark",
        callID: "c1",
        tokens: 300,
        effective: true,
        action: "tool-output",
      },
    },
    {
      label: "seed-pending-mark",
      messages: reportView(RPT_SID),
      action: {
        kind: "add-mark",
        callID: "c2",
        tokens: 500,
        effective: false,
        action: "tool-output",
      },
    },
    {
      label: "dcp-context-with-reclaim",
      messages: reportView(RPT_SID),
      action: { kind: "dcp", args: "context" },
    },
    {
      label: "dcp-help-unknown-subcommand",
      messages: reportView(RPT_SID),
      action: { kind: "dcp", args: "bogus" },
    },
  ],
};
