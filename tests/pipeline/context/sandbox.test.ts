/**
 * Unit tests for the pipeline test sandbox — the test-owned root that
 * every pipeline suite installs before driving a scenario.
 *
 * A sandbox owns one temporary directory holding the session-state store
 * and the log shards of the suite that installs it.  These tests pin the
 * properties the suites rely on: the shared store and the logger resolve
 * inside the root, a reset wipes the previous test's files, and disposal
 * leaves no root behind for a late log flush to rebuild.
 *
 * @module
 */

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getContextStateManager } from "../../../src/core/context/runtime.js";
import type { SessionState } from "../../../src/core/context/state.js";
import { _flushForTesting, log } from "../../../src/utils/logger.js";
import { createPipelineSandbox } from "./sandbox.js";
import { resetPipelineState } from "./teardown.js";

/** The sandbox these tests drive. */
const SANDBOX = createPipelineSandbox("sandbox-unit");

afterEach(() => {
  resetPipelineState(SANDBOX);
});

afterAll(() => {
  SANDBOX.dispose();
});

/** An empty session state (the shape `store.save` accepts). */
function emptyState(): SessionState {
  return { blocks: new Map(), marks: new Map() };
}

describe("pipeline sandbox", () => {
  test("binds the shared state store to the sandbox root", () => {
    resetPipelineState(SANDBOX);

    const store = getContextStateManager().store;
    expect(store.dir).toBe(join(SANDBOX.root, "storage"));
    expect(SANDBOX.root.startsWith(tmpdir())).toBe(true);
  });

  test("persists inside the root and wipes it on the next reset", () => {
    resetPipelineState(SANDBOX);
    const store = getContextStateManager().store;
    store.save("sandbox-session", emptyState());
    const filePath = join(store.dir, "sandbox-session.json");
    expect(existsSync(filePath)).toBe(true);

    resetPipelineState(SANDBOX);
    expect(existsSync(filePath)).toBe(false);
  });

  test("flushes log shards inside the root", () => {
    resetPipelineState(SANDBOX);
    log.info({ hook: "sandbox", event: "flush", sessionId: "sandbox-log" });
    _flushForTesting();

    expect(readdirSync(join(SANDBOX.root, "log")).length).toBeGreaterThan(0);
  });

  test("stays removed after dispose while a log entry is buffered", async () => {
    const other = createPipelineSandbox("sandbox-unit-dispose");
    resetPipelineState(other);
    log.info({
      hook: "sandbox",
      event: "pending",
      sessionId: "sandbox-pending",
    });

    other.dispose();
    expect(existsSync(other.root)).toBe(false);

    // One flush tick of the logger's 500ms timer; a live timer writing the
    // buffered entry would recreate the root the dispose just removed.
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(existsSync(other.root)).toBe(false);
  });

  test("gives every sandbox a distinct root and removes it on dispose", () => {
    const other = createPipelineSandbox("sandbox-unit-other");
    try {
      expect(other.root).not.toBe(SANDBOX.root);
      expect(existsSync(other.root)).toBe(true);

      other.dispose();
      expect(existsSync(other.root)).toBe(false);
    } finally {
      other.dispose();
    }
  });
});
