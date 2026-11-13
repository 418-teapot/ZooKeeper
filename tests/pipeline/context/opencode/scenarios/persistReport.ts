/**
 * Scenario — persistence round-trip.
 *
 * - G-PERSIST-01: state written to disk survives a simulated restart —
 *   blocks keep folding and effective marks keep pruning afterwards.
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
    activeMessages: 0,
    releasedPercent: 0,
    dedup: { minMessages: 20, thresholdContext: 100000 },
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
