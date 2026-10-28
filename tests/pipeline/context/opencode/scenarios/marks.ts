/**
 * Scenarios — prune producers and release timing.
 *
 * - G-MS-01: dedup — the context floor of the gate, the two-turn mark
 *   lifecycle, the zero-benefit skip, idempotent re-runs, and the
 *   protection window.
 * - G-MS-02: purge-errors — a failed call's input is marked, replaced on
 *   the next turn, and never marked for completed calls, short inputs or
 *   protected tools.
 * - G-MS-04: batch release — pending marks accumulate to the
 *   `releasedPercent` threshold, and the view-change bypass flushes a
 *   batch that sits below it.
 *
 * A call's input and output live in one tool part, so a view grows by
 * one message per turn and appending a turn never moves an earlier
 * call's address.
 *
 * @module
 */

import type { ContextMessageEntry } from "../../../../../src/adapters/opencode/types.js";
import { msg, textPart, toolPart } from "../messages.js";
import type { Scenario } from "../types.js";

/** Tool output long enough that replacing it reclaims tokens (~125). */
const LONG = "x".repeat(500);

/** Tool output short enough that replacing it reclaims nothing. */
const SHORT = "ok";

/** One tool call of a fixture turn. */
interface Call {
  /** Tool call id. */
  id: string;
  /** Tool arguments — the dedup signature compares them verbatim. */
  args: Record<string, unknown>;
  /** Result text; defaults to `LONG`. */
  output?: string;
  /** Report the call as failed (`state.status: "error"`). */
  error?: boolean;
}

/** One user turn of a fixture view. */
interface Turn {
  /** The user instruction that opens the turn. */
  userText: string;
  /** The turn's tool calls, in call order. */
  calls: Call[];
  /** API-reported input tokens of the turn's assistant; omit for none. */
  inputTokens?: number;
}

/**
 * Build one turn: the user message and the assistant carrying every
 * call as a tool part.
 *
 * @param sessionID - Session id carried by the user message.
 * @param turn - The turn fixture.
 * @returns The turn's messages, in view order.
 */
function turnMessages(sessionID: string, turn: Turn): ContextMessageEntry[] {
  const firstId = turn.calls[0]?.id ?? "none";
  return [
    msg("user", `u-${firstId}`, [textPart(turn.userText)], sessionID),
    msg(
      "assistant",
      `a-${firstId}`,
      turn.calls.map((call) =>
        toolPart(
          call.id,
          call.output ?? (call.error ? "error output" : LONG),
          call.args,
          "bash",
          call.error ? "error" : undefined,
        ),
      ),
      undefined,
      turn.inputTokens !== undefined
        ? { input: turn.inputTokens, output: 200 }
        : undefined,
    ),
  ];
}

/**
 * Build a long view: an opening user message plus twenty filler turns
 * (21 messages, past the producers' message floor) followed by the
 * given turns.  Filler outputs are short, so they never reclaim
 * anything.
 *
 * @param sessionID - Session id carried by the user messages.
 * @param turns - The trailing turns the scenario drives.
 * @returns The message view.
 */
function longView(sessionID: string, turns: Turn[]): ContextMessageEntry[] {
  const fillers: Turn[] = Array.from({ length: 20 }, (_, index) => ({
    userText: `filler ${index}`,
    calls: [{ id: `f${index}`, args: { cmd: "echo filler" }, output: SHORT }],
  }));
  const messages = [msg("user", "u0", [textPart("开场问题")], sessionID)];
  for (const turn of [...fillers, ...turns]) {
    messages.push(...turnMessages(sessionID, turn));
  }
  return messages;
}

/** The dedup fixture's duplicate pair: same tool, same arguments. */
function duplicateTurn(inputTokens: number, output: string): Turn {
  return {
    userText: "do it",
    calls: [
      { id: "c1", args: { cmd: "echo hello" }, output },
      { id: "c2", args: { cmd: "echo hello" }, output },
    ],
    inputTokens,
  };
}

/** Producer gates for the dedup scenario. */
const DEDUP_CONFIG = {
  protectedMessages: 0,
  releasedPercent: 0,
  compress: { protectedTokens: 0, thresholdTokens: 0 },
  dedup: { minMessages: 20, thresholdContext: 100000 },
  purgeErrors: {},
};

/**
 * G-MS-01 — dedup gate, two-turn effect and exclusion rules.
 *
 * A model limit of 200000 turns the configured `thresholdContext`
 * (100000) into a 0.5 fraction of the measured total, so the 21 filler
 * messages plus the measured usage decide the gate.  The duplicate pair
 * sits at the end of the view; its older call is the mark candidate.
 *
 * - `gate-closed-below-threshold`: 99000 input tokens leave the total
 *   below the floor — nothing is marked, nothing announced.
 * - `protected-window-skips`: the same view over the floor, but
 *   `protectedMessages: 2` puts the pair inside the protection window.
 * - `gate-open-marks-created-not-applied`: the gate opens at equality;
 *   the producer writes a pending mark and the turn itself prunes
 *   nothing (release runs before the producers).
 * - `applies-next-turn`: replaying the view releases the mark and writes
 *   its placeholder.
 * - `zero-benefit-short-output`: a fresh pair of short duplicates follows
 *   the marked turn; replacing them saves nothing, so no mark appears.
 * - `idempotent-rerun-no-new-marks`: the marked view again — the claimed
 *   position is skipped, so the newest duplicate stays unmarked and no
 *   second notice fires.
 */
export const G_MS_01: Scenario = {
  id: "G-MS-01",
  sessionID: "golden-g-ms-01",
  config: DEDUP_CONFIG,
  rounds: [
    {
      label: "gate-closed-below-threshold",
      messages: longView("golden-g-ms-01", [duplicateTurn(99000, LONG)]),
      action: { kind: "set-model-limit", context: 200000 },
    },
    {
      label: "protected-window-skips",
      messages: longView("golden-g-ms-01", [duplicateTurn(100000, LONG)]),
      config: { ...DEDUP_CONFIG, protectedMessages: 2 },
    },
    {
      label: "gate-open-marks-created-not-applied",
      messages: longView("golden-g-ms-01", [duplicateTurn(100000, LONG)]),
    },
    {
      label: "applies-next-turn",
      messages: longView("golden-g-ms-01", [duplicateTurn(100000, LONG)]),
    },
    {
      label: "zero-benefit-short-output",
      messages: longView("golden-g-ms-01", [
        duplicateTurn(100000, LONG),
        {
          userText: "again",
          calls: [
            { id: "c3", args: { cmd: "echo hi" }, output: SHORT },
            { id: "c4", args: { cmd: "echo hi" }, output: SHORT },
          ],
        },
      ]),
    },
    {
      label: "idempotent-rerun-no-new-marks",
      messages: longView("golden-g-ms-01", [duplicateTurn(100000, LONG)]),
    },
  ],
};

/** Producer gates for the purge-errors scenario. */
const PURGE_CONFIG = {
  protectedMessages: 0,
  releasedPercent: 0,
  compress: { protectedTokens: 0, thresholdTokens: 0 },
  dedup: {},
  purgeErrors: { minMessages: 20, thresholdContext: 100000 },
};

/**
 * G-MS-02 — purge-errors two-turn effect and exclusion rules.
 *
 * The view starts with 21 filler messages and one long failed call
 * (`ce1`); the trailing assistant reports 100000 input tokens, so the
 * measured total clears the configured `thresholdContext` and the
 * producer runs.  Later rounds append a second call under test, so the
 * marked call keeps its ordinals and each exclusion is observed on a
 * fresh call.
 *
 * - `marks-error-input-pending-released`: the failed call's input is
 *   marked, not replaced, in the turn that marks it.
 * - `applies-next-turn`: the released mark replaces that input; the
 *   call's output is untouched.
 * - `completed-parts-ignored`: a completed call is never marked.
 * - `zero-benefit-short-input`: a short input is not marked.
 * - `protected-tool-skipped`: `protectedTools: ["bash"]` keeps a fresh
 *   bash error call unmarked.
 */
export const G_MS_02: Scenario = {
  id: "G-MS-02",
  sessionID: "golden-g-ms-02",
  config: PURGE_CONFIG,
  rounds: [
    {
      label: "marks-error-input-pending-released",
      messages: longView("golden-g-ms-02", [
        {
          userText: "do it",
          calls: [{ id: "ce1", args: { cmd: LONG }, error: true }],
          inputTokens: 100000,
        },
      ]),
      action: { kind: "set-model-limit", context: 200000 },
    },
    {
      label: "applies-next-turn",
      messages: longView("golden-g-ms-02", [
        {
          userText: "do it",
          calls: [{ id: "ce1", args: { cmd: LONG }, error: true }],
          inputTokens: 100000,
        },
      ]),
    },
    {
      label: "completed-parts-ignored",
      messages: longView("golden-g-ms-02", [
        {
          userText: "do it",
          calls: [{ id: "ce1", args: { cmd: LONG }, error: true }],
          inputTokens: 100000,
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
      messages: longView("golden-g-ms-02", [
        {
          userText: "do it",
          calls: [{ id: "ce1", args: { cmd: LONG }, error: true }],
          inputTokens: 100000,
        },
        {
          userText: "again",
          calls: [{ id: "ce3", args: { cmd: "ok" }, error: true }],
          inputTokens: 100000,
        },
      ]),
    },
    {
      label: "protected-tool-skipped",
      messages: longView("golden-g-ms-02", [
        {
          userText: "do it",
          calls: [{ id: "ce1", args: { cmd: LONG }, error: true }],
          inputTokens: 100000,
        },
        {
          userText: "again",
          calls: [{ id: "ce4", args: { cmd: LONG }, error: true }],
          inputTokens: 100000,
        },
      ]),
      config: {
        ...PURGE_CONFIG,
        purgeErrors: {
          minMessages: 20,
          thresholdContext: 100000,
          protectedTools: ["bash"],
        },
      },
    },
  ],
};

/**
 * Build a view that grows by one tool turn per round, so every seeded
 * mark keeps its ordinal in later rounds.
 *
 * @param sessionID - Session id carried by the user messages.
 * @param turns - Number of tool turns.
 * @returns The message view.
 */
function growthView(sessionID: string, turns: number): ContextMessageEntry[] {
  const messages: ContextMessageEntry[] = [];
  for (let index = 0; index < turns; index++) {
    const id = `c${index * 2 + 1}`;
    messages.push(
      ...turnMessages(sessionID, {
        userText: `call ${id}`,
        calls: [{ id, args: { cmd: `echo ${id}` } }],
        inputTokens: 100000,
      }),
    );
  }
  return messages;
}

/**
 * G-MS-04 — batch release: threshold flush and view-change bypass.
 *
 * The seeded marks carry explicit token counts, so `releasedPercent: 5`
 * of the 100000-token prompt means 5000 pending tokens; the producers
 * are off (their sections are empty), so every mark is the fixture's.
 *
 * - `accumulate-below-threshold` / `accumulate-more`: pending totals of
 *   2400 and then 3400 stay below the threshold — no release, no notice.
 * - `reach-threshold-release`: a third mark brings the batch to exactly
 *   5000, so the gate opens and all three marks flush with one notice.
 * - `seed-pending-below-threshold`: a 100-token mark waits below the
 *   threshold while the effective marks keep pruning.
 * - `forced-flush-view-change`: the bypass flushes that mark even though
 *   the threshold is not met.
 * - `no-pending-no-notification`: nothing is pending, so the turn is
 *   silent while the effective marks re-apply.
 */
export const G_MS_04: Scenario = {
  id: "G-MS-04",
  sessionID: "golden-g-ms-04",
  config: {
    protectedMessages: 0,
    releasedPercent: 5,
    dedup: {},
    purgeErrors: {},
  },
  rounds: [
    {
      label: "accumulate-below-threshold",
      messages: growthView("golden-g-ms-04", 1),
      action: {
        kind: "add-mark",
        callID: "c1",
        tokens: 2400,
        effective: false,
        action: "tool-output",
      },
    },
    {
      label: "accumulate-more",
      messages: growthView("golden-g-ms-04", 2),
      action: {
        kind: "add-mark",
        callID: "c3",
        tokens: 1000,
        effective: false,
        action: "tool-output",
      },
    },
    {
      label: "reach-threshold-release",
      messages: growthView("golden-g-ms-04", 3),
      action: {
        kind: "add-mark",
        callID: "c5",
        tokens: 1600,
        effective: false,
        action: "tool-output",
      },
    },
    {
      label: "seed-pending-below-threshold",
      messages: growthView("golden-g-ms-04", 4),
      action: {
        kind: "add-mark",
        callID: "c7",
        tokens: 100,
        effective: false,
        action: "tool-output",
      },
    },
    {
      label: "forced-flush-view-change",
      messages: growthView("golden-g-ms-04", 5),
      action: { kind: "set-pending-view-change" },
    },
    {
      label: "no-pending-no-notification",
      messages: growthView("golden-g-ms-04", 6),
    },
  ],
};
