/**
 * Semantic contracts, opencode lane — the behaviours the scenario corpus
 * proves through its visible projection.
 *
 * Each test states one rule and names the scenario it drives; the
 * assertions themselves live in `../semantic-contracts.ts`.  This entry
 * only supplies the lane's scenarios, its host seam and the mark-restart
 * fixture.
 *
 * @module
 */

import { afterAll, beforeEach, describe, test } from "bun:test";
import type { ContextMessageEntry } from "../../../../src/adapters/opencode/types.js";
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
  expectReportExposesMarkAccounting,
  expectStaleBlockUnfolds,
  expectViewChangeReleasesNextTurn,
} from "../semantic-contracts.js";
import { resetPipelineState } from "../teardown.js";
import { createV1PipelineHost } from "./host.js";
import { msg, textPart, toolPart } from "./messages.js";
import { G_COMP_02 } from "./scenarios/compress.js";
import { G_DEC_02 } from "./scenarios/decompress.js";
import { G_FOLD_02, G_FOLD_03 } from "./scenarios/fold.js";
import { G_MS_01, G_MS_02, G_MS_04 } from "./scenarios/marks.js";
import { G_NUDGE_01 } from "./scenarios/nudgeRefs.js";
import { G_PERSIST_01, G_REPORT_01 } from "./scenarios/persistReport.js";
import { G_TOOL_01 } from "./scenarios/tools.js";

/** Session id of the mark-restart fixture. */
const MARK_RESTART_SID = "zoo-contract-mark-restart";

/** Test-owned storage and log root for this suite. */
const SANDBOX = createPipelineSandbox("opencode-contracts");

beforeEach(() => {
  resetPipelineState(SANDBOX);
});

afterAll(() => {
  SANDBOX.dispose();
});

describe("mark producers (opencode)", () => {
  test("the dedup gate opens at the context floor and applies its mark one turn later", async () => {
    await expectDedupGateTwoTurnEffect(G_MS_01, createV1PipelineHost());
  });

  test("an error-input mark applies on the next turn and never marks a completed call", async () => {
    await expectPurgeErrorsTwoTurnEffect(G_MS_02, createV1PipelineHost());
  });
});

describe("mark release timing (opencode)", () => {
  test("a batch flushes at the release threshold, and a below-threshold batch only through the view-change bypass", async () => {
    await expectBatchReleaseLifecycle(G_MS_04, createV1PipelineHost());
  });
});

describe("nudge watermark (opencode)", () => {
  test("the reminder fires once per growth interval and stays silent when frozen, ratcheted down, or gated off", async () => {
    await expectNudgeWatermark(G_NUDGE_01, createV1PipelineHost());
  });
});

describe("block lifecycle (opencode)", () => {
  test("a block that stops validating unfurls its messages", async () => {
    await expectStaleBlockUnfolds(G_FOLD_02, createV1PipelineHost());
  });

  test("a view change detected mid-turn releases marks only on the next turn", async () => {
    await expectViewChangeReleasesNextTurn(G_FOLD_03, createV1PipelineHost());
  });

  test("a rejected compress batch creates no block", async () => {
    await expectRangeRejectionsCreateNoBlock(G_COMP_02, createV1PipelineHost());
  });

  test("a disjoint compress batch lands one block per range", async () => {
    await expectDisjointBatchLandsOneBlockPerRange(
      G_COMP_02,
      createV1PipelineHost(),
    );
  });

  test("the decompress fill gate skips, rejects, then allows the same restore", async () => {
    await expectDecompressFillGate(G_DEC_02, createV1PipelineHost());
  });

  test("a block record survives a simulated crash and keeps folding", async () => {
    await expectBlockSurvivesRestart(G_PERSIST_01, createV1PipelineHost());
  });
});

describe("tool rejections (opencode)", () => {
  test("every rejected tool call reports a loud error and leaves the view unchanged", async () => {
    await expectRejectedToolCallsPreserveView(
      G_TOOL_01,
      createV1PipelineHost(),
    );
  });
});

describe("reclaim accounting (opencode)", () => {
  test("the /dcp context report counts the effective mark and the pending batch", async () => {
    await expectReportExposesMarkAccounting(
      G_REPORT_01,
      createV1PipelineHost(),
    );
  });
});

describe("mark persistence across a restart (opencode)", () => {
  test("a pending mark written before the crash is released after it", async () => {
    await expectPendingMarkSurvivesRestart(createV1PipelineHost(), {
      id: "CONTRACT-MARK-RESTART",
      sessionID: MARK_RESTART_SID,
      callID: "c1",
      view: markRestartView,
    });
  });
});

/** Output long enough to clear the zero-benefit gate (~125 tokens). */
const LONG = "x".repeat(500);

/**
 * Two-message view whose assistant reports usage, so `promptTokens`
 * opens the release gate while the 200-token mark stays under the
 * threshold.
 *
 * @returns A fresh message view.
 */
function markRestartView(): ContextMessageEntry[] {
  return [
    msg("user", "u0", [textPart("hello")], MARK_RESTART_SID),
    msg(
      "assistant",
      "a1",
      [toolPart("c1", LONG, { cmd: "echo hello" })],
      undefined,
      { input: 100000, output: 200 },
    ),
  ];
}
