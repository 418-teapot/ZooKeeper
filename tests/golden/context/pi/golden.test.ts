/**
 * Golden baseline tests (pi lane) — drive the new-core context-pruning
 * pipeline through the pi-lane scenarios and compare each capture
 * against its persisted snapshot (after normalisation).
 *
 * The runner loop and the snapshot comparison live in the host-neutral
 * `runner-core.ts`; this entry resolves the snapshot directory relative
 * to itself, enumerates the pi scenarios, drives them with a
 * session-bound pi host, and keeps the same teardown surface as the
 * opencode lane (shared state manager dropped, persisted files deleted,
 * model-limit registry and logger buffer reset).
 *
 * The smoke tests below prove the lane end-to-end at the seam level:
 * the production pi `context` entry (`buildPiContextHandler` via
 * `composeProfile`) runs over native pi messages, the captured view
 * carries the per-round injected refs, and the pi adapter's purity is
 * preserved — the transform returns a fresh replacement array and never
 * mutates the input message objects.
 *
 * Set `ZOO_GOLDEN_UPDATE=1` to regenerate the snapshot files from
 * current pipeline behaviour (e.g. when an intentionally accepted
 * behaviour change lands).
 *
 * @module
 */

import { afterEach, describe, expect, test } from "bun:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { PiAgentMessage } from "../../../../src/adapters/pi/types.js";
import { _resetForTesting as _resetModelLimitsForTesting } from "../../../../src/core/context/model-limits.js";
import {
  _resetContextStateManagerForTesting,
  getContextStateManager,
} from "../../../../src/core/context/runtime.js";
import { _resetForTesting as _resetLoggerForTesting } from "../../../../src/utils/logger.js";
import { assertScenarioMatchesSnapshot } from "../runner-core.js";
import { createPiGoldenHost } from "./host.js";
import {
  assistantMsg,
  textPart,
  toolCallPart,
  toolResultMsg,
  userMsg,
} from "./messages.js";
import { ALL_SCENARIOS } from "./scenarios/index.js";

// ---------------------------------------------------------------------------
// Snapshot persistence
// ---------------------------------------------------------------------------

/** Snapshot directory — resolved relative to this lane test file. */
const SNAPSHOT_DIR = join(dirname(fileURLToPath(import.meta.url)), "snapshots");

/** Whether snapshot regeneration is requested. */
const UPDATE = process.env.ZOO_GOLDEN_UPDATE === "1";

// ---------------------------------------------------------------------------
// Teardown
// ---------------------------------------------------------------------------

/** Session ids used by the golden scenarios (for persisted-file cleanup). */
const SCENARIO_SESSION_IDS = ALL_SCENARIOS.map((s) => s.sessionID);

/** Session ids used by the smoke tests below. */
const SMOKE_SESSION_IDS = ["pi-smoke-transform", "pi-smoke-empty"];

afterEach(() => {
  _resetLoggerForTesting();
  _resetModelLimitsForTesting();
  // Drop the shared manager so a fresh store is built on next access —
  // mirrors the golden teardown's request to wipe process-wide state.
  const manager = getContextStateManager();
  for (const sid of [...SCENARIO_SESSION_IDS, ...SMOKE_SESSION_IDS]) {
    manager.store.delete(sid);
  }
  _resetContextStateManagerForTesting();
});

// ---------------------------------------------------------------------------
// Baseline
// ---------------------------------------------------------------------------

describe("golden baseline (pi)", () => {
  for (const scenario of ALL_SCENARIOS) {
    test(scenario.id, async () => {
      await assertScenarioMatchesSnapshot(
        scenario,
        createPiGoldenHost(scenario.sessionID),
        SNAPSHOT_DIR,
        UPDATE,
      );
    });
  }
});

// ---------------------------------------------------------------------------
// Lane smoke tests
// ---------------------------------------------------------------------------

describe("pi lane smoke — production-entry transform", () => {
  test("runs a trivial round through runTransform with refs injected and input purity", async () => {
    const SID = "pi-smoke-transform";
    const host = createPiGoldenHost(SID);
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

    // Ref injection is visible in the captured view (production render
    // path: every visible message carries its per-round `[mN] ` prefix).
    expect(capture[0]?.text).toMatch(/^\[m\d+\] /);
    expect(capture[2]?.toolParts[0]?.output).toMatch(/^\[m\d+\] total 12/);

    // Purity: the pi adapter returns a fresh replacement array, so the
    // round's view now holds new objects…
    expect(msgs[0]).not.toBe(originals[0]);
    // …while the ORIGINAL message objects were never mutated by the
    // transform (deep-equal to their pre-transform selves).
    originals.forEach((original, i) => {
      expect(original).toEqual(snapshot[i]);
    });
  });

  test("no-ops cleanly on an empty message array", async () => {
    const host = createPiGoldenHost("pi-smoke-empty");
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
