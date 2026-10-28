/**
 * Semantic contracts — named assertions over the externally observable
 * projection of a scenario round (`view`, `toolResult`, `toolError`,
 * `notifications`).
 *
 * The snapshots pin the exact projection of every round; the checks here
 * state the rule behind a projection, so a failure names a user-visible
 * behaviour instead of an implementation field.  Round labels and
 * expected values stay at the call site (each lane's
 * `contracts.test.ts`), this module only carries the shared reading
 * helpers and the per-scenario-family checks both lanes drive.
 *
 * @module
 */

import { expect } from "bun:test";
import { runScenario } from "./runner-core.js";
import type {
  PipelineHost,
  RoundCapture,
  Scenario,
  ScenarioCapture,
} from "./types.js";

/** Folded-block header: `[Block b4 · 7 条] 第四段`. */
const FOLD_HEADER_RE = /\[Block (b\d+) · (\d+) 条\] ?(.*)/;

/** Superseded-block index line: `--- b3: 长摘要 ---`. */
const SUPERSEDED_RE = /^--- (b\d+): (.+?) ---$/gm;

/** Marker prefix of the injected context-pressure reminder. */
const NUDGE_MARKER = "<internal-reminder>";

/** One compression block as the view renders it. */
export interface FoldedBlock {
  /** Persistent block id from the header. */
  id: string;
  /** Covered message count from the header. */
  covered: number;
  /** One-line topic label after the header. */
  title: string;
  /** Ids of the superseded blocks the summary lists below itself. */
  superseded: string[];
}

/**
 * Read one captured round by label.
 *
 * @param capture - The scenario capture.
 * @param label - The round label.
 * @returns The captured round.
 */
export function roundByLabel(
  capture: ScenarioCapture,
  label: string,
): RoundCapture {
  const round = capture.rounds.find((r) => r.label === label);
  if (round === undefined) {
    const known = capture.rounds.map((r) => r.label).join(", ");
    throw new Error(
      `scenario ${capture.scenario} has no round "${label}" (known: ${known})`,
    );
  }
  return round;
}

/**
 * Read the compression blocks a round's view renders.
 *
 * The synthetic summary message is the folded block's whole external
 * surface: its header carries the id, the covered-message count and the
 * topic label, and its body lists the superseded blocks it absorbed.
 *
 * @param round - The captured round.
 * @returns The rendered blocks, in view order.
 */
export function foldedBlocks(round: RoundCapture): FoldedBlock[] {
  const blocks: FoldedBlock[] = [];
  for (const message of round.view) {
    const text = message.text ?? "";
    const header = FOLD_HEADER_RE.exec(text);
    if (header === null) continue;
    const superseded: string[] = [];
    for (const line of text.matchAll(SUPERSEDED_RE)) {
      const id = line[1];
      if (id !== undefined) superseded.push(id);
    }
    blocks.push({
      id: header[1] ?? "",
      covered: Number(header[2] ?? 0),
      title: (header[3] ?? "").trim(),
      superseded,
    });
  }
  return blocks;
}

/**
 * Read the message indexes whose tool output reads back a prune
 * placeholder.
 *
 * @param round - The captured round.
 * @returns The affected message indexes, in view order.
 */
export function prunedOutputs(round: RoundCapture): number[] {
  return round.view.flatMap((message, index) =>
    message.toolParts.some((part) => part.pruned) ? [index] : [],
  );
}

/**
 * Read the message indexes whose tool input reads back a prune
 * placeholder (the failed-call variant).
 *
 * @param round - The captured round.
 * @returns The affected message indexes, in view order.
 */
export function prunedInputs(round: RoundCapture): number[] {
  return round.view.flatMap((message, index) =>
    message.toolParts.some((part) => part.inputPruned) ? [index] : [],
  );
}

/**
 * Read the context-pressure reminders a round's view carries.
 *
 * @param round - The captured round.
 * @returns The reminder texts, in view order (empty when the reminder
 *   stayed silent).
 */
export function nudgeTexts(round: RoundCapture): string[] {
  return round.view.flatMap((message) =>
    (message.text ?? "").includes(NUDGE_MARKER) ? [message.text ?? ""] : [],
  );
}

/**
 * Assert the dedup gate, the two-turn mark lifecycle and the exclusion
 * rules.
 *
 * The gate is open when the measured total clears the configured
 * `thresholdContext` fraction and the view clears `minMessages`; a mark
 * the producer writes is pending, so it shows up as a placeholder one
 * turn later.
 *
 * @param scenario - The lane's G-MS-01 scenario.
 * @param host - The lane's host seam.
 */
export async function expectDedupGateTwoTurnEffect<M>(
  scenario: Scenario<M>,
  host: PipelineHost<M>,
): Promise<void> {
  const capture = await runScenario(scenario, host);

  const closed = roundByLabel(capture, "gate-closed-below-threshold");
  expect(
    prunedOutputs(closed),
    "below the context threshold the gate stays closed",
  ).toEqual([]);
  expect(closed.notifications, "a closed gate announces nothing").toEqual([]);

  const protectedRound = roundByLabel(capture, "protected-window-skips");
  expect(
    prunedOutputs(protectedRound),
    "the protection window keeps the duplicates unmarked",
  ).toEqual([]);
  expect(
    protectedRound.notifications,
    "a protected duplicate announces nothing",
  ).toEqual([]);

  const created = roundByLabel(capture, "gate-open-marks-created-not-applied");
  expect(
    prunedOutputs(created),
    "a mark created this turn is not applied this turn",
  ).toEqual([]);
  expect(
    created.notifications,
    "creating a mark is not a release, so nothing is announced",
  ).toEqual([]);

  const applied = roundByLabel(capture, "applies-next-turn");
  expect(
    prunedOutputs(applied).length,
    "the older duplicate is pruned on the next turn",
  ).toBe(1);
  expect(
    applied.notifications.length,
    "the release announces the flip exactly once",
  ).toBe(1);
  expect(
    applied.notifications[0],
    "the release notice names the folded call",
  ).toContain("已折叠 1 个工具调用");

  const zeroBenefit = roundByLabel(capture, "zero-benefit-short-output");
  expect(
    prunedOutputs(zeroBenefit).length,
    "short duplicates add no mark: only the effective one prunes",
  ).toBe(1);
  expect(
    zeroBenefit.notifications,
    "a zero-benefit duplicate announces nothing",
  ).toEqual([]);

  const idempotent = roundByLabel(capture, "idempotent-rerun-no-new-marks");
  expect(
    prunedOutputs(idempotent).length,
    "an already-claimed position is not marked twice",
  ).toBe(1);
  expect(
    idempotent.notifications,
    "no mark was created by the skipped rounds",
  ).toEqual([]);
}

/**
 * Assert the two-turn lifecycle of a failed-call input mark and its
 * exclusion rules.
 *
 * The mark replaces the failed call's input, never its output, and only
 * after the turn that created it.
 *
 * @param scenario - The lane's G-MS-02 scenario.
 * @param host - The lane's host seam.
 */
export async function expectPurgeErrorsTwoTurnEffect<M>(
  scenario: Scenario<M>,
  host: PipelineHost<M>,
): Promise<void> {
  const capture = await runScenario(scenario, host);

  const seeded = roundByLabel(capture, "marks-error-input-pending-released");
  expect(
    prunedInputs(seeded),
    "the failed call's input is not replaced in the turn it is marked",
  ).toEqual([]);

  const applied = roundByLabel(capture, "applies-next-turn");
  expect(
    prunedInputs(applied).length,
    "the released mark replaces the failed call's input next turn",
  ).toBe(1);
  expect(
    prunedOutputs(applied),
    "the error-input mark never touches the call's output",
  ).toEqual([]);

  for (const label of [
    "completed-parts-ignored",
    "zero-benefit-short-input",
    "protected-tool-skipped",
  ]) {
    const round = roundByLabel(capture, label);
    expect(
      prunedInputs(round).length,
      `${label}: only the earlier effective mark stays applied`,
    ).toBe(1);
  }
}

/**
 * Assert that pending marks flush both on the release threshold and on
 * the view-change bypass.
 *
 * @param scenario - The lane's G-MS-04 scenario.
 * @param host - The lane's host seam.
 */
export async function expectBatchReleaseLifecycle<M>(
  scenario: Scenario<M>,
  host: PipelineHost<M>,
): Promise<void> {
  const capture = await runScenario(scenario, host);

  for (const label of ["accumulate-below-threshold", "accumulate-more"]) {
    const round = roundByLabel(capture, label);
    expect(
      prunedOutputs(round),
      `${label}: a batch below the threshold stays pending`,
    ).toEqual([]);
    expect(
      round.notifications,
      `${label}: a withheld batch announces nothing`,
    ).toEqual([]);
  }

  const threshold = roundByLabel(capture, "reach-threshold-release");
  expect(
    prunedOutputs(threshold).length,
    "reaching the threshold releases the whole batch in that turn",
  ).toBe(3);
  expect(
    threshold.notifications.length,
    "the threshold release announces the batch once",
  ).toBe(1);
  expect(
    threshold.notifications[0],
    "the notice reports the batch size and the reclaimed tokens",
  ).toContain("已折叠 3 个工具调用，约回收 5.0K tokens");

  const waiting = roundByLabel(capture, "seed-pending-below-threshold");
  expect(
    prunedOutputs(waiting).length,
    "the effective marks keep pruning while the new mark waits",
  ).toBe(3);
  expect(
    waiting.notifications,
    "a pending mark below the threshold announces nothing",
  ).toEqual([]);

  const bypassed = roundByLabel(capture, "forced-flush-view-change");
  expect(
    prunedOutputs(bypassed).length,
    "the view-change bypass releases the pending mark below the threshold",
  ).toBe(4);
  expect(
    bypassed.notifications.length,
    "the bypassed release announces the batch once",
  ).toBe(1);
  expect(
    bypassed.notifications[0],
    "the notice reports the bypassed mark and its tokens",
  ).toContain("已折叠 1 个工具调用，约回收 100 tokens");

  const steady = roundByLabel(capture, "no-pending-no-notification");
  expect(
    prunedOutputs(steady).length,
    "effective marks re-apply on a steady turn",
  ).toBe(4);
  expect(
    steady.notifications,
    "a turn with nothing pending announces nothing",
  ).toEqual([]);
}

/**
 * Assert the nudge watermark's trigger and silence branches.
 *
 * The watermark is one anchor that ratchets down with a shrinking
 * context and holds flat while it is frozen; a reminder fires only when
 * the token level sits past a band entry and the distance from the
 * anchor exceeds the band's interval.  The injected reminder is the whole
 * external surface of that decision, so silence and firing are both
 * observable.
 *
 * @param scenario - The lane's G-NUDGE-01 scenario.
 * @param host - The lane's host seam.
 */
export async function expectNudgeWatermark<M>(
  scenario: Scenario<M>,
  host: PipelineHost<M>,
): Promise<void> {
  const capture = await runScenario(scenario, host);

  const silent = [
    "set-limit-baseline-silent",
    "frozen-silent",
    "ratchet-down-silent",
    "gate-closed-no-compress-tool",
    "gate-closed-no-nudge-config",
  ];
  for (const label of silent) {
    expect(
      nudgeTexts(roundByLabel(capture, label)),
      `${label}: the reminder must stay silent`,
    ).toEqual([]);
  }

  const firing: Array<[string, string]> = [
    ["gentle-trigger", "CONTEXT GROWING"],
    ["re-trigger-after-ratchet", "CONTEXT GROWING"],
    ["urgent-trigger", "CONTEXT LIMIT"],
  ];
  for (const [label, level] of firing) {
    const nudges = nudgeTexts(roundByLabel(capture, label));
    expect(nudges.length, `${label}: one reminder is injected`).toBe(1);
    expect(nudges[0], `${label}: the reminder names the level`).toContain(
      level,
    );
  }
}

/**
 * Assert that a block which stops validating restores its messages.
 *
 * Each stale block drops out of the folded view and the covered messages
 * reappear — the external trace of a record surviving in its terminal
 * status while nothing folds.
 *
 * @param scenario - The lane's G-FOLD-02 scenario.
 * @param host - The lane's host seam.
 */
export async function expectStaleBlockUnfolds<M>(
  scenario: Scenario<M>,
  host: PipelineHost<M>,
): Promise<void> {
  const capture = await runScenario(scenario, host);

  const first = foldedBlocks(roundByLabel(capture, "create-b1"));
  expect(
    first.map((b) => b.id),
    "b1 folds its own interval",
  ).toEqual(["b1"]);

  expect(
    foldedBlocks(roundByLabel(capture, "create-b2")).map((b) => b.id),
    "b2 folds alongside b1",
  ).toEqual(["b1", "b2"]);

  expect(
    foldedBlocks(roundByLabel(capture, "deactivate-b1")).map((b) => b.id),
    "a stale block unfurls and the other keeps folding",
  ).toEqual(["b2"]);

  expect(
    foldedBlocks(roundByLabel(capture, "deactivate-b2-view-restored")),
    "with every block stale the view is the original message list",
  ).toEqual([]);
}

/**
 * Assert that a view change detected mid-turn releases marks on the next
 * turn.
 *
 * The detecting turn arms the one-shot view-change flag during its fold
 * phase, after its release phase already ran — so it writes no
 * placeholder and announces nothing.  The following turn consumes the
 * flag, flushes every pending mark and announces the batch; the turn
 * after that re-applies the now-effective marks silently.
 *
 * @param scenario - The lane's G-FOLD-03 scenario.
 * @param host - The lane's host seam.
 */
export async function expectViewChangeReleasesNextTurn<M>(
  scenario: Scenario<M>,
  host: PipelineHost<M>,
): Promise<void> {
  const capture = await runScenario(scenario, host);

  const seeded = roundByLabel(capture, "seed-pending-mark-two");
  expect(
    seeded.notifications,
    "seeding a pending mark raises no release notice",
  ).toEqual([]);

  const reverted = roundByLabel(
    capture,
    "revert-anchor-deleted-deactivate-flush",
  );
  expect(
    foldedBlocks(reverted),
    "the block whose anchor vanished stops folding",
  ).toEqual([]);
  expect(
    prunedOutputs(reverted),
    "the armed flush waits for the next turn (tool output untouched)",
  ).toEqual([]);
  expect(
    prunedInputs(reverted),
    "the armed flush waits for the next turn (tool input untouched)",
  ).toEqual([]);
  expect(
    reverted.notifications,
    "the detecting turn announces nothing",
  ).toEqual([]);

  const released = roundByLabel(capture, "next-turn-release-applied");
  expect(
    prunedOutputs(released).length,
    "the next turn writes both pending placeholders",
  ).toBe(2);
  expect(
    released.notifications.length,
    "the next turn announces the flushed batch once",
  ).toBe(1);
  expect(
    released.notifications[0],
    "the notice reports the whole flushed batch",
  ).toContain("已折叠 2 个工具调用，约回收 300 tokens");
  expect(foldedBlocks(released), "the stale block never folds again").toEqual(
    [],
  );

  const steady = roundByLabel(capture, "effective-marks-reapply");
  expect(
    prunedOutputs(steady).length,
    "the effective marks re-apply on the following turn",
  ).toBe(2);
  expect(
    steady.notifications,
    "re-applying effective marks announces nothing",
  ).toEqual([]);
}

/**
 * Assert that a rejected compress batch leaves no block behind.
 *
 * Every validation rejection reports the failing range and creates
 * nothing, so the block map never gains an entry — the external trace of
 * the "会话状态未改动" promise.
 *
 * @param scenario - The lane's G-COMP-02 scenario.
 * @param host - The lane's host seam.
 */
export async function expectRangeRejectionsCreateNoBlock<M>(
  scenario: Scenario<M>,
  host: PipelineHost<M>,
): Promise<void> {
  const capture = await runScenario(scenario, host);

  for (const label of [
    "reject-cross-range-overlap",
    "reject-same-call-consumption",
    "reject-indexed-range-failure",
    "reject-reversed-order",
    "reject-batch-range-overlap",
  ]) {
    const round = roundByLabel(capture, label);
    expect(
      round.toolError,
      `${label}: the rejection is reported loudly`,
    ).not.toBeNull();
    expect(
      foldedBlocks(round),
      `${label}: a rejected batch creates no block`,
    ).toEqual([]);
  }
}

/**
 * Assert that a disjoint batch lands one block per range.
 *
 * Each range of the accepted batch folds on the same turn, so the view
 * carries both summaries with their own titles and the notice counts
 * both ranges.
 *
 * @param scenario - The lane's G-COMP-02 scenario.
 * @param host - The lane's host seam.
 */
export async function expectDisjointBatchLandsOneBlockPerRange<M>(
  scenario: Scenario<M>,
  host: PipelineHost<M>,
): Promise<void> {
  const capture = await runScenario(scenario, host);

  const success = roundByLabel(capture, "batch-two-ranges-success");
  expect(success.toolError, "a disjoint batch is accepted").toBeNull();
  expect(success.toolResult, "the result reports both ranges").toContain(
    "已压缩 2 个范围",
  );

  const blocks = foldedBlocks(success);
  expect(
    blocks.map((b) => b.id),
    "each range lands its own block",
  ).toEqual(["b1", "b2"]);
  expect(
    blocks.map((b) => b.title),
    "each block carries its own range title",
  ).toEqual(["主题一", "主题二"]);
}

/**
 * Assert the decompress `maxFillPercent` gate's three states.
 *
 * With no model limit the gate is skipped and the block is restored; at a
 * 20000-token limit the same restore is rejected and the block keeps
 * folding; at 500000 tokens it is allowed.  The block id never moves, so
 * a rejected restore also consumes no id.
 *
 * @param scenario - The lane's G-DEC-02 scenario.
 * @param host - The lane's host seam.
 */
export async function expectDecompressFillGate<M>(
  scenario: Scenario<M>,
  host: PipelineHost<M>,
): Promise<void> {
  const capture = await runScenario(scenario, host);

  const skipped = roundByLabel(capture, "restore-no-model-limit-skipped");
  expect(skipped.toolError, "an unknown model limit skips the gate").toBeNull();
  expect(skipped.toolResult, "the block is restored").toContain(
    "已恢复压缩块 b1",
  );
  expect(foldedBlocks(skipped), "the restored block stops folding").toEqual([]);

  const rejected = roundByLabel(capture, "restore-rejected-at-limit");
  expect(
    rejected.toolError,
    "a restore past the fill gate is rejected loudly",
  ).not.toBeNull();
  expect(
    foldedBlocks(rejected).map((b) => b.id),
    "the rejected restore leaves the block folding",
  ).toEqual(["b2"]);

  const allowed = roundByLabel(capture, "restore-allowed-at-limit");
  expect(
    allowed.toolError,
    "the same restore passes once the limit is raised",
  ).toBeNull();
  expect(
    allowed.toolResult,
    "the block is restored under its own id",
  ).toContain("已恢复压缩块 b2");
  expect(
    foldedBlocks(allowed),
    "the allowed restore unfurls the block",
  ).toEqual([]);
}

/**
 * Assert that a block record survives a simulated process crash.
 *
 * The block written before the crash keeps folding afterwards with the
 * same id, span and title — the on-disk state is reloaded rather than
 * rebuilt.
 *
 * @param scenario - The lane's G-PERSIST-01 scenario.
 * @param host - The lane's host seam.
 */
export async function expectBlockSurvivesRestart<M>(
  scenario: Scenario<M>,
  host: PipelineHost<M>,
): Promise<void> {
  const capture = await runScenario(scenario, host);

  const before = foldedBlocks(
    roundByLabel(capture, "create-mark-and-block-persist"),
  );
  expect(
    before.map((b) => b.id),
    "the block is created before the crash",
  ).toEqual(["b1"]);
  expect(
    foldedBlocks(roundByLabel(capture, "restart-continues")),
    "the reloaded block folds identically after the crash",
  ).toEqual(before);
  expect(
    foldedBlocks(roundByLabel(capture, "second-turn-after-restart")),
    "the reloaded block keeps folding on the next turn",
  ).toEqual(before);
}

/**
 * Assert that rejected tool calls change nothing observable.
 *
 * Every argument-validation and configuration rejection reports a loud
 * error and leaves the folded view exactly as the previous turn left it.
 *
 * @param scenario - The lane's G-TOOL-01 scenario.
 * @param host - The lane's host seam.
 */
export async function expectRejectedToolCallsPreserveView<M>(
  scenario: Scenario<M>,
  host: PipelineHost<M>,
): Promise<void> {
  const capture = await runScenario(scenario, host);

  const created = roundByLabel(capture, "compress-single-range");
  expect(
    foldedBlocks(created).map((b) => b.id),
    "the happy path lands b1 so the rejections have something to preserve",
  ).toEqual(["b1"]);

  for (const label of [
    "compress-batch-two-ranges",
    "compress-max-ranges-overflow",
    "compress-args-not-object",
    "compress-empty-ranges",
    "compress-empty-title",
    "compress-hyphen-title",
    "compress-non-string-field",
    "decompress-missing-session-id",
    "compress-config-section-missing",
    "decompress-config-section-missing",
  ]) {
    const index = capture.rounds.findIndex((r) => r.label === label);
    const round = roundByLabel(capture, label);
    expect(
      round.toolError,
      `${label}: the rejection is reported loudly`,
    ).not.toBeNull();
    expect(
      foldedBlocks(round),
      `${label}: the folded view is unchanged from the previous turn`,
    ).toEqual(foldedBlocks(capture.rounds[index - 1] as RoundCapture));
  }
}

/**
 * Assert that the `/dcp context` report exposes the reclaim accounting.
 *
 * The report is the read side of the mark bookkeeping — the effective
 * mark's reclaimed tokens accumulate into the block's total, and the
 * pending mark shows up as an unreleased batch.  Only the opencode lane
 * drives this check: the pi lane wires no command seam.
 *
 * @param scenario - The opencode lane's G-REPORT-01 scenario.
 * @param host - The opencode lane host seam.
 */
export async function expectReportExposesMarkAccounting<M>(
  scenario: Scenario<M>,
  host: PipelineHost<M>,
): Promise<void> {
  const capture = await runScenario(scenario, host);

  const empty = roundByLabel(capture, "dcp-context-no-reclaim");
  expect(
    empty.notifications.join("\n"),
    "a session with no block and no mark reports no reclaim section",
  ).not.toContain("回收");

  const report = roundByLabel(
    capture,
    "dcp-context-with-reclaim",
  ).notifications.join("\n");
  expect(report, "the active block is counted").toContain("1 个压缩块");
  expect(
    report,
    "the effective mark's tokens accumulate into the block's total",
  ).toContain("累计剪枝 ~300");
  expect(
    report,
    "the pending mark is reported as an unreleased batch",
  ).toContain("待生效 ~500（1 个剪枝标记）");
}

/**
 * A restart fixture: a session, a mark target and the view replayed
 * before and after the simulated crash.
 */
export interface RestartMarkCase<M> {
  /** Scenario id (recorded in the capture). */
  id: string;
  /** Session id, unique against the snapshot corpus. */
  sessionID: string;
  /** Call id whose tool output the pending mark anchors to. */
  callID: string;
  /** The view replayed before and after the simulated crash. */
  view: () => M[];
}

/**
 * Assert that a pending mark survives a simulated process crash.
 *
 * The mark is seeded below the release threshold, so only the
 * pending-view-change bypass can flush it.  A reloaded state that lost
 * the mark would write nothing, so the post-restart placeholder is the
 * external proof of persistence.
 *
 * @param host - The lane's host seam.
 * @param testCase - The lane's session, mark target and view fixture.
 */
export async function expectPendingMarkSurvivesRestart<M>(
  host: PipelineHost<M>,
  testCase: RestartMarkCase<M>,
): Promise<void> {
  const scenario: Scenario<M> = {
    id: testCase.id,
    sessionID: testCase.sessionID,
    // The 5000-token threshold (5 % of the 100000-token prompt) stays
    // above the 200-token mark, so only the bypass can release it.
    config: {
      protectedMessages: 0,
      releasedPercent: 5,
      dedup: {},
      purgeErrors: {},
    },
    rounds: [
      {
        label: "seed-pending-mark",
        messages: testCase.view(),
        action: {
          kind: "add-mark",
          callID: testCase.callID,
          tokens: 200,
          effective: false,
          action: "tool-output",
        },
      },
      {
        label: "simulated-crash",
        messages: testCase.view(),
        action: { kind: "restart" },
      },
      {
        label: "flush-after-restart",
        messages: testCase.view(),
        action: { kind: "set-pending-view-change" },
      },
    ],
  };

  const capture = await runScenario(scenario, host);

  expect(
    prunedOutputs(roundByLabel(capture, "seed-pending-mark")),
    "the seeded mark is pending, so nothing is pruned yet",
  ).toEqual([]);
  expect(
    prunedOutputs(roundByLabel(capture, "simulated-crash")),
    "the reloaded mark is still pending: no bypass, no release",
  ).toEqual([]);

  const flushed = roundByLabel(capture, "flush-after-restart");
  expect(
    prunedOutputs(flushed).length,
    "the persisted mark is released after the crash and writes its placeholder",
  ).toBe(1);
  expect(
    flushed.notifications[0],
    "the release notice proves the mark survived the crash",
  ).toContain("已折叠 1 个工具调用");
}
