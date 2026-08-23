/**
 * Golden baseline tests (opencode lane) — drive the new-core
 * context-pruning pipeline through all 19 scenarios and compare each
 * capture against its persisted snapshot (after normalisation).
 *
 * The runner loop and the snapshot comparison live in the host-neutral
 * `runner-core.ts`; this entry resolves the snapshot directory relative
 * to itself, enumerates the v1 scenarios, and keeps the teardown that
 * mirrors the new-core cleanup surface: the shared session-state
 * manager is dropped so cross-test state never leaks, persisted state
 * files are deleted through the manager's store, the model-limit
 * registry is reset, and the file-based logger buffer is cleared.
 *
 * Set `ZOO_GOLDEN_UPDATE=1` to regenerate the snapshot files from
 * current pipeline behaviour (e.g. when an intentionally accepted
 * behaviour change lands).
 *
 * @module
 */

import { afterEach, describe, test } from "bun:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { _resetForTesting as _resetModelLimitsForTesting } from "../../../../src/core/context/model-limits.js";
import {
  _resetContextStateManagerForTesting,
  getContextStateManager,
} from "../../../../src/core/context/runtime.js";
import { _resetForTesting as _resetLoggerForTesting } from "../../../../src/utils/logger.js";
import { assertScenarioMatchesSnapshot } from "../runner-core.js";
import { createV1GoldenHost } from "./host.js";
import { ALL_SCENARIOS } from "./scenarios/index.js";

// ---------------------------------------------------------------------------
// Snapshot persistence
// ---------------------------------------------------------------------------

/** Snapshot directory — resolved relative to this lane test file. */
const SNAPSHOT_DIR = join(dirname(fileURLToPath(import.meta.url)), "snapshots");

/** Whether snapshot regeneration is requested. */
const UPDATE = process.env.ZOO_GOLDEN_UPDATE === "1";

/** The lane's host seam (stateless — one instance serves all scenarios). */
const HOST = createV1GoldenHost();

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

describe("golden baseline (opencode)", () => {
  for (const scenario of ALL_SCENARIOS) {
    test(scenario.id, async () => {
      await assertScenarioMatchesSnapshot(
        scenario,
        HOST,
        SNAPSHOT_DIR,
        UPDATE,
      );
    });
  }
});
