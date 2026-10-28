/**
 * Semantic contracts, pi lane — the behaviours the scenario corpus proves
 * through its visible projection.
 *
 * Each test states one rule and names the scenario it drives; the
 * assertions themselves live in `../semantic-contracts.ts`.  This entry
 * only supplies the lane's scenarios, its session-bound host seam and the
 * mark-restart fixture.
 *
 * @module
 */

import { afterAll, beforeEach, describe, test } from "bun:test";
import type { PiAgentMessage } from "../../../../src/adapters/pi/types.js";
import { createPipelineSandbox } from "../sandbox.js";
import {
  expectBatchReleaseLifecycle,
  expectBlockSurvivesRestart,
  expectDecompressFillGate,
  expectDedupGateTwoTurnEffect,
  expectDisjointBatchLandsOneBlockPerRange,
  expectNudgeWatermark,
  expectPendingMarkSurvivesRestart,
  expectPurgeErrorsTwoTurnEffect,
  expectRangeRejectionsCreateNoBlock,
  expectRejectedToolCallsPreserveView,
  expectStaleBlockUnfolds,
  expectViewChangeReleasesNextTurn,
} from "../semantic-contracts.js";
import { resetPipelineState } from "../teardown.js";
import { createPiPipelineHost } from "./host.js";
import {
  assistantMsg,
  textPart,
  toolCallPart,
  toolResultMsg,
  userMsg,
} from "./messages.js";
import { G_COMP_02 } from "./scenarios/compress.js";
import { G_DEC_02 } from "./scenarios/decompress.js";
import { G_FOLD_02, G_FOLD_03 } from "./scenarios/fold.js";
import { G_MS_01, G_MS_02, G_MS_04 } from "./scenarios/marks.js";
import { G_NUDGE_01 } from "./scenarios/nudgeRefs.js";
import { G_PERSIST_01 } from "./scenarios/persistReport.js";
import { G_TOOL_01 } from "./scenarios/tools.js";

/** Session id of the mark-restart fixture. */
const MARK_RESTART_SID = "zoo-contract-pi-mark-restart";

/** Test-owned storage and log root for this suite. */
const SANDBOX = createPipelineSandbox("pi-contracts");

beforeEach(() => {
  resetPipelineState(SANDBOX);
});

afterAll(() => {
  SANDBOX.dispose();
});

describe("mark producers (pi)", () => {
  test("the dedup gate opens at the context floor and applies its mark one turn later", async () => {
    await expectDedupGateTwoTurnEffect(
      G_MS_01,
      createPiPipelineHost(G_MS_01.sessionID),
    );
  });

  test("an error-input mark applies on the next turn and never marks a completed call", async () => {
    await expectPurgeErrorsTwoTurnEffect(
      G_MS_02,
      createPiPipelineHost(G_MS_02.sessionID),
    );
  });
});

describe("mark release timing (pi)", () => {
  test("a batch flushes at the release threshold, and a below-threshold batch only through the view-change bypass", async () => {
    await expectBatchReleaseLifecycle(
      G_MS_04,
      createPiPipelineHost(G_MS_04.sessionID),
    );
  });
});

describe("nudge watermark (pi)", () => {
  test("the reminder fires once per growth interval and stays silent when frozen, ratcheted down, or gated off", async () => {
    await expectNudgeWatermark(
      G_NUDGE_01,
      createPiPipelineHost(G_NUDGE_01.sessionID),
    );
  });
});

describe("block lifecycle (pi)", () => {
  test("a block that stops validating unfurls its messages", async () => {
    await expectStaleBlockUnfolds(
      G_FOLD_02,
      createPiPipelineHost(G_FOLD_02.sessionID),
    );
  });

  test("a view change detected mid-turn releases marks only on the next turn", async () => {
    await expectViewChangeReleasesNextTurn(
      G_FOLD_03,
      createPiPipelineHost(G_FOLD_03.sessionID),
    );
  });

  test("a rejected compress batch creates no block", async () => {
    await expectRangeRejectionsCreateNoBlock(
      G_COMP_02,
      createPiPipelineHost(G_COMP_02.sessionID),
    );
  });

  test("a disjoint compress batch lands one block per range", async () => {
    await expectDisjointBatchLandsOneBlockPerRange(
      G_COMP_02,
      createPiPipelineHost(G_COMP_02.sessionID),
    );
  });

  test("the decompress fill gate skips, rejects, then allows the same restore", async () => {
    await expectDecompressFillGate(
      G_DEC_02,
      createPiPipelineHost(G_DEC_02.sessionID),
    );
  });

  test("a block record survives a simulated crash and keeps folding", async () => {
    await expectBlockSurvivesRestart(
      G_PERSIST_01,
      createPiPipelineHost(G_PERSIST_01.sessionID),
    );
  });
});

describe("tool rejections (pi)", () => {
  test("every rejected tool call reports a loud error and leaves the view unchanged", async () => {
    await expectRejectedToolCallsPreserveView(
      G_TOOL_01,
      createPiPipelineHost(G_TOOL_01.sessionID),
    );
  });
});

describe("mark persistence across a restart (pi)", () => {
  test("a pending mark written before the crash is released after it", async () => {
    await expectPendingMarkSurvivesRestart(
      createPiPipelineHost(MARK_RESTART_SID),
      {
        id: "CONTRACT-PI-MARK-RESTART",
        sessionID: MARK_RESTART_SID,
        callID: "c1",
        view: markRestartView,
      },
    );
  });
});

/** Output long enough to clear the zero-benefit gate (~125 tokens). */
const LONG = "x".repeat(500);

/**
 * One tool pair whose assistant reports usage, so `promptTokens` opens the
 * release gate while the 200-token mark stays under the threshold.
 *
 * @returns A fresh pi message view.
 */
function markRestartView(): PiAgentMessage[] {
  return [
    userMsg("hello", { id: "u0" }),
    assistantMsg([toolCallPart("c1", "bash", { cmd: "echo hello" })], {
      id: "a1",
      usage: { input: 100000, output: 200 },
    }),
    toolResultMsg("c1", "bash", [textPart(LONG)], { id: "tr1" }),
  ];
}
