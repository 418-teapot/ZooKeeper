/**
 * Snapshot baseline, opencode lane — drives every opencode scenario and
 * compares the captured projection against its persisted snapshot.
 *
 * The runner loop and the snapshot comparison live in the host-neutral
 * `runner-core.ts`; this entry resolves the snapshot directory relative
 * to itself, enumerates the opencode scenarios and drives them with the
 * stateless opencode host.
 *
 * Set `ZOO_SNAPSHOT_UPDATE=1` (`bun run test:pipeline:update`) to
 * regenerate the snapshot files from current pipeline behaviour.
 *
 * @module
 */

import { afterAll, beforeEach, describe, test } from "bun:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { assertScenarioMatchesSnapshot } from "../runner-core.js";
import { createPipelineSandbox } from "../sandbox.js";
import { resetPipelineState } from "../teardown.js";
import { createV1PipelineHost } from "./host.js";
import { ALL_SCENARIOS } from "./scenarios/index.js";

/** Snapshot directory — resolved relative to this lane test file. */
const SNAPSHOT_DIR = join(dirname(fileURLToPath(import.meta.url)), "snapshots");

/** Whether snapshot regeneration is requested. */
const UPDATE = process.env.ZOO_SNAPSHOT_UPDATE === "1";

/** The lane's host seam (stateless — one instance serves all scenarios). */
const HOST = createV1PipelineHost();

/** Test-owned storage and log root for this suite. */
const SANDBOX = createPipelineSandbox("opencode-snapshots");

beforeEach(() => {
  resetPipelineState(SANDBOX);
});

afterAll(() => {
  SANDBOX.dispose();
});

describe("snapshot baseline (opencode)", () => {
  for (const scenario of ALL_SCENARIOS) {
    test(scenario.id, async () => {
      await assertScenarioMatchesSnapshot(scenario, HOST, SNAPSHOT_DIR, UPDATE);
    });
  }
});
