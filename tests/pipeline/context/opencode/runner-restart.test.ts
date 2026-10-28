/**
 * Regression test for the runner's `case "restart"` branch.
 *
 * The simulated restart stands for a process crash: in-memory state is
 * gone, on-disk state must survive and the next `.get(sid)` must reload
 * it.  The test drives a three-round scenario (create block → restart →
 * transform) through `runScenario` and asserts the persisted state still
 * carries the block.  The session id is isolated from the scenario corpus
 * so the test never contends for a snapshot session file.
 *
 * @module
 */

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getContextStateManager } from "../../../../src/core/context/runtime.js";
import { runScenario } from "../runner-core.js";
import { createPipelineSandbox } from "../sandbox.js";
import { resetPipelineState } from "../teardown.js";
import { createV1PipelineHost } from "./host.js";
import { msg, textPart, toolPart } from "./messages.js";
import type { Scenario } from "./types.js";

/** Session id isolated from the scenario corpus. */
const TEST_SID = "zoo-test-restart-roundtrip";

/** Test-owned storage root the restart round-trip writes into. */
const SANDBOX = createPipelineSandbox("opencode-restart");

/** Output long enough to clear the zero-benefit gate (~125 tokens). */
const LONG = "x".repeat(500);

/** Build a deterministic message view for the test scenario. */
function view() {
  return [
    msg("user", "u0", [textPart("hello")], TEST_SID),
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
    msg("user", "u2", [textPart("again")], TEST_SID),
    msg("assistant", "a2", [toolPart("c3", LONG, { cmd: "echo x" })]),
  ];
}

/** A 3-round scenario mirroring G-PERSIST-01 with a unique session id. */
const SCENARIO: Scenario = {
  id: "TEST-RESTART-ROUNDTRIP",
  sessionID: TEST_SID,
  config: {
    protectedMessages: 0,
    releasedPercent: 0,
    dedup: { minMessages: 20, thresholdContext: 100000 },
    purgeErrors: {},
  },
  rounds: [
    {
      label: "create-block",
      messages: view(),
      action: {
        kind: "create-block",
        plan: {
          anchorMessageId: "u2",
          messageIds: ["u2"],
          summary: "should survive restart",
          title: "survivor",
          compressedTokens: 500,
          summaryTokens: 80,
        },
      },
    },
    {
      label: "simulated-crash",
      messages: view(),
      action: { kind: "restart" },
    },
    {
      label: "after-restart",
      messages: view(),
    },
  ],
};

beforeEach(() => {
  resetPipelineState(SANDBOX);
});

afterAll(() => {
  SANDBOX.dispose();
});

describe("runner restart round-trip", () => {
  test("a simulated crash preserves the on-disk state so the next round reloads it", async () => {
    await runScenario(SCENARIO, createV1PipelineHost());

    const manager = getContextStateManager();
    // The persisted file must live in the suite's own sandbox, never in a
    // shared storage directory.
    expect(manager.store.dir).toBe(join(SANDBOX.root, "storage"));
    const filePath = join(manager.store.dir, `${TEST_SID}.json`);

    // The transform in round 3 always persists the (post-transform)
    // state to disk, so the file exists regardless of whether the
    // restart branch preserved the round-1 save.
    expect(existsSync(filePath)).toBe(true);

    const persisted = JSON.parse(readFileSync(filePath, "utf8")) as {
      schema: number;
      blocks: Record<string, { title?: string; summary: string }>;
      marks: Record<string, unknown>;
    };
    expect(persisted.schema).toBe(2);

    // The block written before the crash must survive it: a restart
    // branch that also dropped the on-disk file would leave the
    // persisted block map empty here.
    const blockEntries = Object.values(persisted.blocks);
    expect(blockEntries.length).toBeGreaterThan(0);

    const [firstBlock] = blockEntries;
    expect(firstBlock?.title).toBe("survivor");
    expect(firstBlock?.summary).toBe("should survive restart");
  });
});
