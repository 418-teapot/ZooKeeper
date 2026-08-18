/**
 * Golden baseline tests — drive the new-core context-pruning pipeline
 * through all 19 scenarios and compare each capture against its
 * persisted snapshot (after normalisation).
 *
 * Set `ZOO_GOLDEN_UPDATE=1` to regenerate the snapshot files from
 * current pipeline behaviour (e.g. when an intentionally accepted
 * behaviour change lands).
 *
 * Teardown mirrors the new-core cleanup surface: the shared session-
 * state manager is dropped so cross-test state never leaks, persisted
 * state files are deleted through the manager's store, the model-limit
 * registry is reset, and the file-based logger buffer is cleared.
 *
 * @module
 */

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { _resetForTesting as _resetModelLimitsForTesting } from "../../../src/core/context/model-limits.js";
import {
  _resetContextStateManagerForTesting,
  getContextStateManager,
} from "../../../src/core/context/runtime.js";
import { _resetForTesting as _resetLoggerForTesting } from "../../../src/utils/logger.js";
import { compareSnapshots } from "../framework/compare.js";
import { runScenario } from "./runner.js";
import { ALL_SCENARIOS } from "./scenarios/index.js";
import type { ScenarioCapture } from "./types.js";

// ---------------------------------------------------------------------------
// Snapshot persistence
// ---------------------------------------------------------------------------

const SNAPSHOT_DIR = join(dirname(fileURLToPath(import.meta.url)), "snapshots");

/** Snapshot file path for a scenario id. */
function snapshotPath(scenarioId: string): string {
  return join(SNAPSHOT_DIR, `${scenarioId}.json`);
}

/** Whether snapshot regeneration is requested. */
const UPDATE = process.env.ZOO_GOLDEN_UPDATE === "1";

/**
 * Persist a scenario capture to its snapshot file.
 *
 * @param capture - The captured scenario output.
 */
function writeSnapshot(capture: ScenarioCapture): void {
  mkdirSync(SNAPSHOT_DIR, { recursive: true });
  writeFileSync(
    snapshotPath(capture.scenario),
    `${JSON.stringify(capture, null, 2)}\n`,
    "utf8",
  );
}

// ---------------------------------------------------------------------------
// Teardown
// ---------------------------------------------------------------------------

/** Session ids used by the golden scenarios (for persisted-file cleanup). */
const SCENARIO_SESSION_IDS = ALL_SCENARIOS.map((s) => s.sessionID);

afterEach(() => {
  _resetLoggerForTesting();
  _resetModelLimitsForTesting();
  // Drop the shared manager so a fresh store is built on next access —
  // mirrors the golden teardown's request to wipe process-wide state.
  const manager = getContextStateManager();
  for (const sid of SCENARIO_SESSION_IDS) {
    manager.store.delete(sid);
  }
  _resetContextStateManagerForTesting();
});

// ---------------------------------------------------------------------------
// Baseline
// ---------------------------------------------------------------------------

describe("golden baseline", () => {
  for (const scenario of ALL_SCENARIOS) {
    test(scenario.id, async () => {
      const capture = await runScenario(scenario);

      if (UPDATE) {
        writeSnapshot(capture);
        // The snapshot was just regenerated from this run — trivially equal.
        expect(true).toBe(true);
        return;
      }

      const path = snapshotPath(scenario.id);
      expect(existsSync(path), `missing snapshot ${path}`).toBe(true);
      const expected = JSON.parse(
        readFileSync(path, "utf8"),
      ) as ScenarioCapture;
      const diffs = compareSnapshots(capture, expected);
      expect(
        diffs,
        `scenario ${scenario.id} diverged from baseline:\n${diffs.join("\n")}`,
      ).toEqual([]);
    });
  }
});
