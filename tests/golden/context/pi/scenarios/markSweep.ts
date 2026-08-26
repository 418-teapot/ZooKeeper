/**
 * Golden scenarios — mark-sweep producers and release timing (C4/C5),
 * pi lane.
 *
 * Ported from the opencode lane with pi numbering: a v1 `dupView`
 * (user + assistant with tool parts) becomes user + assistant with
 * `toolCall` blocks (carrying the usage) + one `toolResult` message per
 * call.
 *
 * - G-MS-01: dedup — gate, two-turn effect, zero-benefit skip,
 *   idempotent re-runs, and the message-count protection window.  Like
 *   v1, no round sets a model limit, so the producer gates stay closed
 *   and every round is a no-op.
 * - G-MS-02: purge-errors — error-input marking, next-turn replacement
 *   (placeholder visible in a later round's captured view),
 *   completed-part exclusion, zero-benefit skip, protected tools.  A
 *   model limit and a >20-message view open the producer gates, so the
 *   rounds exercise the producer for real on pi-shaped input: the
 *   error call's input and output live in different messages, linked by
 *   the positional `ToolMeta.output` reference the pi lens populates on
 *   the tool-input region.
 * - G-MS-03 is NOT ported: it drives the /dcp `sweep` command, which
 *   does not exist on pi.
 * - G-MS-04: batch release — accumulation across rounds to the
 *   released_percent threshold, forced flush via pendingViewChange, and
 *   silence when nothing is pending.
 *
 * @module
 */

import type { PiAgentMessage } from "../../../../../src/adapters/pi/types.js";
import {
  assistantMsg,
  textPart,
  toolCallPart,
  toolResultMsg,
  userMsg,
} from "../messages.js";
import type { Scenario } from "../types.js";

/** Output long enough to clear the zero-benefit gate (~125 tokens). */
const LONG = "x".repeat(500);

/**
 * Fresh pi view: one user + one assistant with toolCall blocks (with
 * usage) + one toolResult per call.
 *
 * @param sessionID - Session id for the first message.
 * @param calls - The tool calls (id + name + args).
 * @param inputTokens - The assistant's reported input tokens.
 * @param error - Mark the tool results as failed (purge-errors shape).
 * @returns The pi message view.
 */
function dupView(
  sessionID: string,
  calls: Array<{ id: string; args: Record<string, unknown> }>,
  inputTokens: number,
  error = false,
): PiAgentMessage[] {
  const msgs: PiAgentMessage[] = [userMsg("do it", { id: "u0" })];
  msgs.push(
    assistantMsg(
      calls.map((call) => toolCallPart(call.id, "bash", call.args)),
      { id: "a1", usage: { input: inputTokens, output: 200 } },
    ),
  );
  for (const call of calls) {
    msgs.push(
      toolResultMsg(
        call.id,
        "bash",
        [textPart(error ? "error output" : LONG)],
        {
          id: `tr-${call.id}`,
          ...(error ? { isError: true } : {}),
        },
      ),
    );
  }
  return msgs;
}

/**
 * One trailing call pair of the long purge-errors view.
 */
interface LongPair {
  /** User instruction opening the pair. */
  userText: string;
  /** The tool calls (id + name + args). */
  calls: Array<{ id: string; args: Record<string, unknown> }>;
  /** The pair assistant's reported input tokens. */
  inputTokens: number;
  /** Mark the pair's tool results as failed (purge-errors shape). */
  error?: boolean;
}

/**
 * Long pi view: six filler triplets push the message count past the
 * purge-errors floor (> 20), then one trailing call pair per entry.
 *
 * The LAST pair's assistant reports `inputTokens` — it is the last
 * completed assistant, so the measured total is dominated by that usage
 * (100200+), opening the purge-errors context gate (configured
 * `thresholdContext: 100000`) while staying below the sweep producer's
 * 0.8-of-limit gate (model limit 200000 → sweep opens at 160000), so
 * the captured marks come from purge-errors alone.
 *
 * @param sessionID - Session id for the first message.
 * @param pairs - The trailing call pairs, in order.
 * @returns The pi message view.
 */
function longView(sessionID: string, pairs: LongPair[]): PiAgentMessage[] {
  const msgs: PiAgentMessage[] = [];
  for (let i = 0; i < 6; i++) {
    msgs.push(userMsg("filler", { id: `u${i}` }));
    msgs.push(
      assistantMsg([toolCallPart(`f${i}`, "bash", { cmd: "echo filler" })], {
        id: `a${i}`,
      }),
    );
    msgs.push(
      toolResultMsg(`f${i}`, "bash", [textPart("ok")], { id: `tr${i}` }),
    );
  }
  for (const pair of pairs) {
    msgs.push(userMsg(pair.userText, { id: `u-${pair.calls[0]?.id}` }));
    msgs.push(
      assistantMsg(
        pair.calls.map((call) => toolCallPart(call.id, "bash", call.args)),
        {
          id: `a-${pair.calls[0]?.id}`,
          usage: { input: pair.inputTokens, output: 200 },
        },
      ),
    );
    for (const call of pair.calls) {
      msgs.push(
        toolResultMsg(
          call.id,
          "bash",
          [textPart(pair.error ? "error output" : LONG)],
          {
            id: `tr-${call.id}`,
            ...(pair.error ? { isError: true } : {}),
          },
        ),
      );
    }
  }
  return msgs;
}

/**
 * G-MS-01 — dedup.
 *
 * No round sets a model limit, so `fractionOf(100000, undefined)` stays
 * undefined and the dedup context gate stays closed — every round is a
 * no-op, exactly as registered in the v1 snapshot.
 */
export const G_MS_01: Scenario = {
  id: "G-MS-01",
  sessionID: "golden-pi-g-ms-01",
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
        "golden-pi-g-ms-01",
        [
          { id: "c1", args: { cmd: "echo hello" } },
          { id: "c2", args: { cmd: "echo hello" } },
        ],
        99999,
      ),
    },
    {
      label: "gate-open-marks-created-not-applied",
      messages: dupView(
        "golden-pi-g-ms-01",
        [
          { id: "c1", args: { cmd: "echo hello" } },
          { id: "c2", args: { cmd: "echo hello" } },
        ],
        100000,
      ),
    },
    {
      label: "applies-next-turn",
      messages: dupView(
        "golden-pi-g-ms-01",
        [
          { id: "c1", args: { cmd: "echo hello" } },
          { id: "c2", args: { cmd: "echo hello" } },
        ],
        100000,
      ),
    },
    {
      label: "zero-benefit-short-output",
      messages: dupView(
        "golden-pi-g-ms-01",
        [
          { id: "c3", args: { cmd: "echo hi" } },
          { id: "c4", args: { cmd: "echo hi" } },
        ],
        100000,
      ),
    },
    {
      label: "idempotent-rerun-no-new-marks",
      messages: dupView(
        "golden-pi-g-ms-01",
        [
          { id: "c1", args: { cmd: "echo hello" } },
          { id: "c2", args: { cmd: "echo hello" } },
        ],
        100000,
      ),
    },
    {
      label: "protected-window-skips",
      messages: [
        userMsg("do it", { id: "u0" }),
        assistantMsg([toolCallPart("c5", "bash", { cmd: "echo x" })], {
          id: "a1",
        }),
        toolResultMsg("c5", "bash", [textPart(LONG)], { id: "tr-c5" }),
        userMsg("again", { id: "u2" }),
        assistantMsg([toolCallPart("c5", "bash", { cmd: "echo x" })], {
          id: "a2",
          usage: { input: 100000, output: 200 },
        }),
        toolResultMsg("c5", "bash", [textPart(LONG)], { id: "tr-c5-2" }),
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
 *
 * Exercises the producer for real on pi-shaped input.  Round 1 arms a
 * model limit (200000) and opens the context gate
 * (`thresholdContext: 100000` → measured total >= 100000), while the
 * message-count floor clears via the six filler triplets (21+ messages);
 * the sweep producer stays closed (opens at 160000), so the captured
 * marks come from purge-errors alone.  Round 2 replays the same view:
 * the released mark writes the error-input placeholder into the linked
 * tool-input region, visible in the captured view.  Rounds 3–5 keep
 * the already-marked ce1 at its original ordinal — the effective mark
 * re-applies its placeholder every turn (the two-turn lifecycle) — and
 * add a second call under test at a distinct ordinal so each assertion
 * (completed-part exclusion, zero-benefit skip, protected tools) is
 * observable on a fresh call.
 */
export const G_MS_02: Scenario = {
  id: "G-MS-02",
  sessionID: "golden-pi-g-ms-02",
  config: {
    protectedMessages: 0,
    releasedPercent: 0,
    dedup: {},
    purgeErrors: { thresholdContext: 100000 },
  },
  rounds: [
    {
      label: "marks-error-input-pending-released",
      messages: longView("golden-pi-g-ms-02", [
        {
          userText: "do it",
          calls: [{ id: "ce1", args: { cmd: LONG } }],
          inputTokens: 100000,
          error: true,
        },
      ]),
      action: { kind: "set-model-limit", context: 200000 },
    },
    {
      label: "applies-next-turn",
      messages: longView("golden-pi-g-ms-02", [
        {
          userText: "do it",
          calls: [{ id: "ce1", args: { cmd: LONG } }],
          inputTokens: 100000,
          error: true,
        },
      ]),
    },
    {
      label: "completed-parts-ignored",
      messages: longView("golden-pi-g-ms-02", [
        {
          userText: "do it",
          calls: [{ id: "ce1", args: { cmd: LONG } }],
          inputTokens: 100000,
          error: true,
        },
        {
          userText: "again",
          calls: [{ id: "c2", args: { cmd: "echo hello" } }],
          inputTokens: 100000,
        },
      ]),
    },
    {
      label: "zero-benefit-short-input",
      messages: longView("golden-pi-g-ms-02", [
        {
          userText: "do it",
          calls: [{ id: "ce1", args: { cmd: LONG } }],
          inputTokens: 100000,
          error: true,
        },
        {
          userText: "again",
          calls: [{ id: "ce3", args: { cmd: "ok" } }],
          inputTokens: 100000,
          error: true,
        },
      ]),
    },
    {
      label: "protected-tool-skipped",
      messages: longView("golden-pi-g-ms-02", [
        {
          userText: "do it",
          calls: [{ id: "ce1", args: { cmd: LONG } }],
          inputTokens: 100000,
          error: true,
        },
        {
          userText: "again",
          calls: [{ id: "ce4", args: { cmd: LONG } }],
          inputTokens: 100000,
          error: true,
        },
      ]),
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
 * G-MS-04 — batch release accumulation and forced flush.
 *
 * Mirrors the v1 registered behavior: the second `add-mark` (c7)
 * anchors to the same `(ordinal, regionIndex)` key as the first (c5) —
 * every dupView places its first tool result at the same position — so
 * the mark is refused and the pending total stays at 2400 until the
 * forced flush.
 */
export const G_MS_04: Scenario = {
  id: "G-MS-04",
  sessionID: "golden-pi-g-ms-04",
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
        "golden-pi-g-ms-04",
        [
          { id: "c1", args: { cmd: "echo hello" } },
          { id: "c2", args: { cmd: "echo hello" } },
        ],
        100000,
      ),
    },
    {
      label: "accumulate-more",
      messages: dupView(
        "golden-pi-g-ms-04",
        [
          { id: "c3", args: { cmd: "echo hello" } },
          { id: "c4", args: { cmd: "echo hello" } },
        ],
        100000,
      ),
    },
    {
      label: "seed-mark-toward-threshold",
      messages: dupView(
        "golden-pi-g-ms-04",
        [
          { id: "c5", args: { cmd: "echo hello" } },
          { id: "c6", args: { cmd: "echo hello" } },
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
        "golden-pi-g-ms-04",
        [
          { id: "c7", args: { cmd: "echo hello" } },
          { id: "c8", args: { cmd: "echo hello" } },
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
        "golden-pi-g-ms-04",
        [
          { id: "c9", args: { cmd: "echo hello" } },
          { id: "c10", args: { cmd: "echo hello" } },
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
        userMsg("do it", { id: "u0" }),
        assistantMsg([textPart("answer")], {
          id: "a1",
          usage: { input: 100000, output: 200 },
        }),
      ],
      action: { kind: "set-pending-view-change" },
    },
    {
      label: "no-pending-no-notification",
      messages: dupView(
        "golden-pi-g-ms-04",
        [
          { id: "c12", args: { cmd: "echo hello" } },
          { id: "c13", args: { cmd: "echo hello" } },
        ],
        100000,
      ),
    },
  ],
};
