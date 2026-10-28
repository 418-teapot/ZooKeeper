/**
 * Pipeline test teardown — reset the process-wide surfaces a scenario
 * drives.
 *
 * A scenario mutates process-wide state (the shared session-state
 * manager, its on-disk files, the model-limit registry, the logger
 * buffer).  Every test that runs a scenario starts from a clean slate
 * through this reset, and the sandbox root is the only place a suite may
 * persist anything.
 *
 * @module
 */

import { _resetForTesting as _resetModelLimitsForTesting } from "../../../src/core/context/model-limits.js";
import type { PipelineSandbox } from "./sandbox.js";

/**
 * Return the process-wide pipeline surfaces to a clean slate.
 *
 * Wipes the sandbox root and re-installs the shared state manager and the
 * logger on it, then clears the model-limit registry (in-memory only, so
 * it has no sandbox counterpart).
 *
 * @param sandbox - The suite's sandbox.
 */
export function resetPipelineState(sandbox: PipelineSandbox): void {
  _resetModelLimitsForTesting();
  sandbox.reset();
}
