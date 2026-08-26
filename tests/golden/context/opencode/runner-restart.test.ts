/**
 * Regression test for the golden runner's `case "restart"` branch.
 *
 * The simulated "restart" stands for a process crash: in-memory state
 * is gone, on-disk state survives, the next `.get(sid)` reloads from
 * disk.  The previous implementation incorrectly called
 * `manager.store.delete(sid)` along with the cache reset — the disk
 * file was wiped, the round-trip was broken, and the G-PERSIST-01
 * scenario captured an empty post-restart state because the round-1
 * save had been deleted before round 3 could reload it.
 *
 * This test drives a minimal 3-round scenario (create block →
 * restart → transform) through the public `runScenario` pipeline and
 * asserts the on-disk state survives the restart.  The session id is
 * isolated from `SCENARIO_SESSION_IDS` so the test can run alongside
 * the baseline suite without disk contention.
 *
 * @module
 */

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  _resetContextStateManagerForTesting,
  getContextStateManager,
} from "../../../../src/core/context/runtime.js";
import { runScenario } from "../runner-core.js";
import { createV1GoldenHost } from "./host.js";
import { msg, textPart, toolPart } from "./messages.js";
import type { Scenario } from "./types.js";

/** Session id isolated from the golden scenario corpus. */
const TEST_SID = "zoo-test-restart-roundtrip";

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
    dedup: { thresholdContext: 100000 },
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

afterEach(() => {
  // Wipe the on-disk state the test wrote and drop the singleton so
  // the next test starts from a clean slate.
  const manager = getContextStateManager();
  manager.store.delete(TEST_SID);
  _resetContextStateManagerForTesting();
});

describe("golden runner restart round-trip", () => {
  test("a simulated crash preserves the on-disk state so the next round reloads it", async () => {
    await runScenario(SCENARIO, createV1GoldenHost());

    const manager = getContextStateManager();
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

    // The critical assertion: the round-1 block must survive the
    // simulated crash.  The buggy runner's restart branch called
    // `manager.store.delete(sid)`, which wiped the on-disk file;
    // round 3 then saved the (empty) cache state, so the persisted
    // blocks map is empty here.  After the fix, the file survives
    // and the persisted blocks map carries the round-1 entry.
    const blockEntries = Object.values(persisted.blocks);
    expect(blockEntries.length).toBeGreaterThan(0);

    const [firstBlock] = blockEntries;
    expect(firstBlock?.title).toBe("survivor");
    expect(firstBlock?.summary).toBe("should survive restart");
  });
});
