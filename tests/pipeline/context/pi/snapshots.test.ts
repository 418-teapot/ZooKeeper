/**
 * Snapshot baseline, pi lane — drives every pi scenario and compares the
 * captured projection against its persisted snapshot.
 *
 * The runner loop and the snapshot comparison live in the host-neutral
 * `runner-core.ts`; this entry resolves the snapshot directory relative
 * to itself, enumerates the pi scenarios and drives them with a
 * session-bound pi host.  The two smoke tests below cover the lane seams
 * the scenarios do not: the production pi `context` entry over native pi
 * messages, the per-round ref injection, and the adapter's input purity.
 *
 * Set `ZOO_SNAPSHOT_UPDATE=1` (`bun run test:pipeline:update`) to
 * regenerate the snapshot files from current pipeline behaviour.
 *
 * @module
 */

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { PiAgentMessage } from "../../../../src/adapters/pi/types.js";
import { assertScenarioMatchesSnapshot } from "../runner-core.js";
import { createPipelineSandbox } from "../sandbox.js";
import { resetPipelineState } from "../teardown.js";
import { createPiPipelineHost } from "./host.js";
import {
  assistantMsg,
  textPart,
  toolCallPart,
  toolResultMsg,
  userMsg,
} from "./messages.js";
import { ALL_SCENARIOS } from "./scenarios/index.js";

/** Snapshot directory — resolved relative to this lane test file. */
const SNAPSHOT_DIR = join(dirname(fileURLToPath(import.meta.url)), "snapshots");

/** Whether snapshot regeneration is requested. */
const UPDATE = process.env.ZOO_SNAPSHOT_UPDATE === "1";

/** Test-owned storage and log root for this suite. */
const SANDBOX = createPipelineSandbox("pi-snapshots");

beforeEach(() => {
  resetPipelineState(SANDBOX);
});

afterAll(() => {
  SANDBOX.dispose();
});

describe("snapshot baseline (pi)", () => {
  for (const scenario of ALL_SCENARIOS) {
    test(scenario.id, async () => {
      await assertScenarioMatchesSnapshot(
        scenario,
        createPiPipelineHost(scenario.sessionID),
        SNAPSHOT_DIR,
        UPDATE,
      );
    });
  }
});

describe("pi lane smoke — production-entry transform", () => {
  test("runs a trivial round through runTransform with refs injected and input purity", async () => {
    const SID = "pi-smoke-transform";
    const host = createPiPipelineHost(SID);
    const msgs: PiAgentMessage[] = [
      userMsg("hello"),
      assistantMsg([toolCallPart("c1", "bash", { cmd: "ls" })], {
        usage: { input: 500, output: 100 },
      }),
      toolResultMsg("c1", "bash", [textPart("total 12")]),
      assistantMsg([textPart("done")], {
        usage: { input: 600, output: 80 },
      }),
    ];
    const snapshot = structuredClone(msgs);
    const originals = [...msgs];

    await host.runTransform(
      msgs,
      { protectedMessages: 0, dedup: {}, purgeErrors: {} },
      false,
      () => {},
    );

    const capture = host.captureView(msgs);

    // Ref injection is visible in the captured view: every visible
    // message carries its per-round `[mN] ` prefix.
    expect(capture[0]?.text).toMatch(/^\[m\d+\] /);
    expect(capture[2]?.toolParts[0]?.output).toMatch(/^\[m\d+\] total 12/);

    // The returned replacement array holds new objects…
    expect(msgs[0]).not.toBe(originals[0]);
    // …while the original message objects were never mutated.
    originals.forEach((original, i) => {
      expect(original).toEqual(snapshot[i]);
    });
  });

  test("no-ops cleanly on an empty message array", async () => {
    const host = createPiPipelineHost("pi-smoke-empty");
    const msgs: PiAgentMessage[] = [];
    await host.runTransform(
      msgs,
      { protectedMessages: 0, dedup: {}, purgeErrors: {} },
      false,
      () => {},
    );
    expect(host.captureView(msgs)).toEqual([]);
  });
});
