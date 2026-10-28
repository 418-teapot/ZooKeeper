/**
 * Pipeline test sandbox — the test-owned root a suite installs on the
 * process-wide persistence seams.
 *
 * The scenario runner drives the real shared session-state manager and
 * the real logger, whose defaults resolve into the developer's home
 * directory (`~/.zoo/storage`, `~/.zoo/log`).  A sandbox binds both to one
 * freshly created temporary directory per suite, so a test run reads and
 * writes nothing outside its own root.
 *
 * @module
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _resetContextStateManagerForTesting } from "../../../src/core/context/runtime.js";
import {
  createStateStore,
  type StateStore,
} from "../../../src/core/context/store.js";
import {
  _flushForTesting,
  _resetForTesting as _resetLoggerForTesting,
  initLogger,
} from "../../../src/utils/logger.js";

/** Host name the sandboxed logger reports. */
const SANDBOX_HOST = "pipeline-test";

/**
 * Remove a sandbox root, ignoring a root that is already gone.
 *
 * @param root - Absolute path of the root to remove.
 */
function removeRoot(root: string): void {
  rmSync(root, { recursive: true, force: true });
}

/**
 * A test-owned storage and log root plus the seams bound to it.
 */
export interface PipelineSandbox {
  /** Absolute path of the sandbox root. */
  readonly root: string;
  /** Session-state store bound to `<root>/storage`. */
  readonly store: StateStore;
  /**
   * Wipe the root and install it on the shared state manager and the
   * logger, so the next test starts from an empty sandbox.
   */
  reset(): void;
  /**
   * Remove the root from disk.  Idempotent.
   */
  dispose(): void;
}

/**
 * Create a sandbox with a unique root under the system temp directory.
 *
 * @param label - Short suite label, part of the root's directory name.
 * @returns The sandbox, not yet installed until `reset()` runs.
 */
export function createPipelineSandbox(label: string): PipelineSandbox {
  const root = mkdtempSync(join(tmpdir(), `zoo-pipeline-${label}-`));

  const store = createStateStore(join(root, "storage"));
  const logDir = join(root, "log");

  return {
    root,
    store,
    reset(): void {
      removeRoot(root);
      mkdirSync(root, { recursive: true });
      _resetLoggerForTesting();
      initLogger(SANDBOX_HOST, { logDir });
      _resetContextStateManagerForTesting(store);
    },
    dispose(): void {
      // The logger's flush timer outlives a disposed root and would
      // recreate the directory it writes into, so close the writer before
      // the root is removed.
      if (existsSync(root)) _flushForTesting();
      _resetLoggerForTesting();
      removeRoot(root);
    },
  };
}
