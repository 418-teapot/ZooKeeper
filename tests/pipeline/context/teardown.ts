/**
 * Pipeline test teardown — reset the process-wide surfaces a scenario
 * drives.
 *
 * A scenario mutates its plugin instance's context records, their
 * on-disk files, and the logger buffer.  Every test that runs a scenario
 * starts from a clean slate through this reset, and the sandbox root is
 * the only place a suite may persist anything.
 *
 * @module
 */

import type { PipelineSandbox } from "./sandbox.js";

/**
 * Return the process-wide pipeline surfaces to a clean slate.
 *
 * Wipes the sandbox root and re-installs the instance runtime and the
 * logger on it, so the next scenario starts from an empty store.
 *
 * @param sandbox - The suite's sandbox.
 */
export function resetPipelineState(sandbox: PipelineSandbox): void {
  sandbox.reset();
}
