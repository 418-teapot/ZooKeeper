/**
 * Golden scenarios — mark-sweep producers and release timing (C4/C5).
 *
 * - G-MS-01: dedup — gate, two-turn effect, zero-benefit skip, idempotent
 *   re-runs, and the message-count protection window.
 * - G-MS-02: purge-errors — error-input marking, next-turn replacement,
 *   completed-part exclusion, zero-benefit skip, protected tools.
 * - G-MS-03: sweep — no-arg and numeric modes via /dcp, immediate
 *   effectiveness, and the invalid-count error.
 * - G-MS-04: batch release — accumulation across rounds to the
 *   released_percent threshold, forced flush via pendingViewChange, and
 *   silence when nothing is pending.
 *
 * @module
 */

import { msg, textPart, toolPart } from "../messages.js";
import type { Scenario } from "../types.js";

/** Output long enough to clear the zero-benefit gate (~125 tokens). */
const LONG = "x".repeat(500);

/** Tool part builder for an error-status call. */
function errorToolPart(callID: string, input: unknown) {
  return toolPart(callID, "error output", input, "bash", "error");
}

/** Fresh two-message view: one user + one assistant with tool parts. */
function dupView(
  sessionID: string,
  parts: ReturnType<typeof toolPart>[],
  inputTokens: number,
) {
  return [
    msg("user", "u0", [textPart("do it")], sessionID),
    msg("assistant", "a1", parts, undefined, {
      input: inputTokens,
      output: 200,
    }),
  ];
}

/**
 * G-MS-01 — dedup.
 */
export const G_MS_01: Scenario = {
  id: "G-MS-01",
  sessionID: "golden-g-ms-01",
  config: {
    protectedMessages: 0,
    releasedPercent: 0,
    dedup: { thresholdContext: 100000 },
    purgeErrors: {},
  },
  rounds: [
    {
      label: "gate-closed-below-threshold",
      messages: dupView(
        "golden-g-ms-01",
        [
          toolPart("c1", LONG, { cmd: "echo hello" }),
          toolPart("c2", LONG, { cmd: "echo hello" }),
        ],
        99999,
      ),
    },
    {
      label: "gate-open-marks-created-not-applied",
      messages: dupView(
        "golden-g-ms-01",
        [
          toolPart("c1", LONG, { cmd: "echo hello" }),
          toolPart("c2", LONG, { cmd: "echo hello" }),
        ],
        100000,
      ),
    },
    {
      label: "applies-next-turn",
      messages: dupView(
        "golden-g-ms-01",
        [
          toolPart("c1", LONG, { cmd: "echo hello" }),
          toolPart("c2", LONG, { cmd: "echo hello" }),
        ],
        100000,
      ),
    },
    {
      label: "zero-benefit-short-output",
      messages: dupView(
        "golden-g-ms-01",
        [
          toolPart("c3", "ok", { cmd: "echo hi" }),
          toolPart("c4", "ok", { cmd: "echo hi" }),
        ],
        100000,
      ),
    },
    {
      label: "idempotent-rerun-no-new-marks",
      messages: dupView(
        "golden-g-ms-01",
        [
          toolPart("c1", LONG, { cmd: "echo hello" }),
          toolPart("c2", LONG, { cmd: "echo hello" }),
        ],
        100000,
      ),
    },
    {
      label: "protected-window-skips",
      messages: [
        msg("user", "u0", [textPart("do it")], "golden-g-ms-01"),
        msg("assistant", "a1", [toolPart("c5", LONG, { cmd: "echo x" })]),
        msg("user", "u2", [textPart("again")], "golden-g-ms-01"),
        msg(
          "assistant",
          "a2",
          [toolPart("c5", LONG, { cmd: "echo x" })],
          undefined,
          { input: 100000, output: 200 },
        ),
      ],
      config: {
        protectedMessages: 2,
        releasedPercent: 0,
        dedup: { thresholdContext: 100000 },
        purgeErrors: {},
      },
    },
  ],
};

/**
 * G-MS-02 — purge-errors.
 */
export const G_MS_02: Scenario = {
  id: "G-MS-02",
  sessionID: "golden-g-ms-02",
  config: {
    protectedMessages: 0,
    releasedPercent: 0,
    dedup: {},
    purgeErrors: { thresholdContext: 100000 },
  },
  rounds: [
    {
      label: "marks-error-input-pending-released",
      messages: dupView(
        "golden-g-ms-02",
        [errorToolPart("ce1", { cmd: LONG })],
        100000,
      ),
    },
    {
      label: "applies-next-turn",
      messages: dupView(
        "golden-g-ms-02",
        [errorToolPart("ce1", { cmd: LONG })],
        100000,
      ),
    },
    {
      label: "completed-parts-ignored",
      messages: dupView(
        "golden-g-ms-02",
        [toolPart("c2", LONG, { cmd: "echo hello" })],
        100000,
      ),
    },
    {
      label: "zero-benefit-short-input",
      messages: dupView(
        "golden-g-ms-02",
        [errorToolPart("ce3", { cmd: "ok" })],
        100000,
      ),
    },
    {
      label: "protected-tool-skipped",
      messages: dupView(
        "golden-g-ms-02",
        [errorToolPart("ce4", { cmd: LONG })],
        100000,
      ),
      config: {
        protectedMessages: 0,
        releasedPercent: 0,
        dedup: {},
        purgeErrors: {
          thresholdContext: 100000,
          protectedTools: ["bash"],
        },
      },
    },
  ],
};

/**
 * G-MS-03 — sweep via /dcp.
 */
export const G_MS_03: Scenario = {
  id: "G-MS-03",
  sessionID: "golden-g-ms-03",
  config: {
    protectedMessages: 0,
    releasedPercent: 0,
    dedup: {},
    purgeErrors: {},
  },
  rounds: [
    {
      label: "dcp-sweep-no-arg",
      messages: [
        msg("user", "u0", [textPart("do it")], "golden-g-ms-03"),
        msg("assistant", "a1", [toolPart("c1", LONG)]),
        msg("user", "u2", [textPart("again")], "golden-g-ms-03"),
        msg("assistant", "a2", [toolPart("c2", LONG)]),
      ],
      action: { kind: "dcp", args: "sweep" },
    },
    {
      label: "dcp-sweep-numeric-two",
      messages: [
        msg("user", "u0", [textPart("do it")], "golden-g-ms-03"),
        msg("assistant", "a1", [toolPart("c4", LONG)]),
        msg("user", "u2", [textPart("again")], "golden-g-ms-03"),
        msg("assistant", "a2", [toolPart("c5", LONG)]),
        msg("user", "u3", [textPart("more")], "golden-g-ms-03"),
        msg("assistant", "a3", [toolPart("c6", LONG)]),
      ],
      action: { kind: "dcp", args: "sweep 2" },
    },
    {
      label: "dcp-sweep-nothing",
      messages: [
        msg("user", "u0", [textPart("do it")], "golden-g-ms-03"),
        msg("assistant", "a1", [textPart("no tools")]),
      ],
      action: { kind: "dcp", args: "sweep" },
    },
    {
      label: "dcp-sweep-invalid-count",
      messages: [
        msg("user", "u0", [textPart("do it")], "golden-g-ms-03"),
        msg("assistant", "a1", [toolPart("c7", LONG)]),
      ],
      action: { kind: "dcp", args: "sweep 0" },
    },
  ],
};

/**
 * G-MS-04 — batch release accumulation and forced flush.
 */
export const G_MS_04: Scenario = {
  id: "G-MS-04",
  sessionID: "golden-g-ms-04",
  config: {
    protectedMessages: 0,
    releasedPercent: 5,
    dedup: { thresholdContext: 0 },
    purgeErrors: {},
  },
  rounds: [
    {
      label: "accumulate-below-threshold",
      messages: dupView(
        "golden-g-ms-04",
        [
          toolPart("c1", LONG, { cmd: "echo hello" }),
          toolPart("c2", LONG, { cmd: "echo hello" }),
        ],
        100000,
      ),
    },
    {
      label: "accumulate-more",
      messages: dupView(
        "golden-g-ms-04",
        [
          toolPart("c3", LONG, { cmd: "echo hello" }),
          toolPart("c4", LONG, { cmd: "echo hello" }),
        ],
        100000,
      ),
    },
    {
      label: "seed-mark-toward-threshold",
      messages: dupView(
        "golden-g-ms-04",
        [
          toolPart("c5", LONG, { cmd: "echo hello" }),
          toolPart("c6", LONG, { cmd: "echo hello" }),
        ],
        100000,
      ),
      action: {
        kind: "add-mark",
        callID: "c5",
        tokens: 2400,
        effective: false,
        action: "tool-output",
      },
    },
    {
      label: "reach-threshold-release",
      messages: dupView(
        "golden-g-ms-04",
        [
          toolPart("c7", LONG, { cmd: "echo hello" }),
          toolPart("c8", LONG, { cmd: "echo hello" }),
        ],
        100000,
      ),
      action: {
        kind: "add-mark",
        callID: "c7",
        tokens: 2600,
        effective: false,
        action: "tool-output",
      },
    },
    {
      label: "seed-pending-below-threshold",
      messages: dupView(
        "golden-g-ms-04",
        [
          toolPart("c9", LONG, { cmd: "echo hello" }),
          toolPart("c10", LONG, { cmd: "echo hello" }),
        ],
        100000,
      ),
      action: {
        kind: "add-mark",
        callID: "c9",
        tokens: 100,
        effective: false,
        action: "tool-output",
      },
    },
    {
      label: "forced-flush-view-change",
      messages: [
        msg("user", "u0", [textPart("do it")], "golden-g-ms-04"),
        msg("assistant", "a1", [textPart("answer")], undefined, {
          input: 100000,
          output: 200,
        }),
      ],
      action: { kind: "set-pending-view-change" },
    },
    {
      label: "no-pending-no-notification",
      messages: dupView(
        "golden-g-ms-04",
        [
          toolPart("c12", LONG, { cmd: "echo hello" }),
          toolPart("c13", LONG, { cmd: "echo hello" }),
        ],
        100000,
      ),
    },
  ],
};
