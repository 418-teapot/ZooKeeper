/**
 * Tests for the shared runtime start protocol (`src/core/runtime.ts`).
 *
 * The boundary is the start itself: the owner is created before any
 * fallible step, then prepare runs, then publish.  Every real host entry
 * (pi main, pi subagent, OpenCode main) starts through this protocol, so
 * this suite pins the guarantees they inherit: the fixed order, the close
 * handle of a successful start, and a failed start that closes the runtime
 * it created while rethrowing its own error.
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { _getBufferForTesting, _resetForTesting } from "../utils/logger.js";
import type { CleanupReport } from "./lifecycle/index.js";
import { MAIN_ORIGIN, originAgent, startRuntime } from "./runtime.js";

afterEach(() => {
  _resetForTesting();
});

/** The cleanup failures a report carries, in order. */
function reportOf(...errors: unknown[]): CleanupReport {
  return {
    errors: errors.map((error, index) => ({
      scope: "extension" as const,
      service: `service-${index}`,
      error,
    })),
  };
}

/** A runtime owner whose phases record into `calls`. */
function recordingRuntime(
  calls: string[],
  options: {
    failPrepare?: boolean;
    failPublish?: boolean;
    cleanup?: () => Promise<CleanupReport>;
  } = {},
) {
  return {
    publisher: {
      async prepare() {
        calls.push("prepare");
        if (options.failPrepare === true) throw new Error("prepare failed");
        return { value: 7 };
      },
      publish(prepared: { value: number }) {
        calls.push(`publish:${prepared.value}`);
        if (options.failPublish === true) throw new Error("publish failed");
        return `published:${prepared.value}`;
      },
    },
    stop() {
      calls.push("stop");
      return options.cleanup?.() ?? Promise.resolve(reportOf());
    },
  };
}

describe("originAgent", () => {
  it("answers the delegated agent of a subagent origin only", () => {
    assert.equal(originAgent(MAIN_ORIGIN), undefined);
    assert.equal(originAgent({ kind: "subagent", agent: "lynx" }), "lynx");
  });
});

describe("startRuntime", () => {
  it("creates the owner, then prepares and publishes in that order", async () => {
    const calls: string[] = [];

    const handle = await startRuntime({
      scope: { generation: 1 },
      origin: MAIN_ORIGIN,
      createRuntime: ({ scope, origin }) => {
        calls.push(`create:${scope.generation}:${origin.kind}`);
        return recordingRuntime(calls);
      },
    });

    assert.deepEqual(calls, ["create:1:main", "prepare", "publish:7"]);
    assert.equal(handle.origin, MAIN_ORIGIN);
    assert.equal(handle.publication, "published:7");
    assert.equal(typeof handle.stop, "function");
  });

  it("carries the subagent origin and its agent into the handle", async () => {
    const calls: string[] = [];
    const origin = { kind: "subagent", agent: "beaver" } as const;

    const handle = await startRuntime({
      scope: {},
      origin,
      createRuntime: () => recordingRuntime(calls),
    });

    assert.deepEqual(handle.origin, { kind: "subagent", agent: "beaver" });
    assert.equal(handle.origin, origin, "the handle keeps the origin it ran");
  });

  it("closes the runtime once when prepare fails, then rethrows", async () => {
    const calls: string[] = [];

    await assert.rejects(
      startRuntime({
        scope: {},
        origin: MAIN_ORIGIN,
        createRuntime: () => recordingRuntime(calls, { failPrepare: true }),
      }),
      /prepare failed/,
    );

    assert.deepEqual(calls, ["prepare", "stop"], "publish must not run");
  });

  it("closes the runtime once when publish fails, then rethrows", async () => {
    const calls: string[] = [];

    await assert.rejects(
      startRuntime({
        scope: {},
        origin: MAIN_ORIGIN,
        createRuntime: () => recordingRuntime(calls, { failPublish: true }),
      }),
      /publish failed/,
    );

    assert.deepEqual(calls, ["prepare", "publish:7", "stop"]);
  });

  it("keeps the start error primary when the cleanup throws", async () => {
    const calls: string[] = [];

    await assert.rejects(
      startRuntime({
        scope: {},
        origin: MAIN_ORIGIN,
        createRuntime: () =>
          recordingRuntime(calls, {
            failPublish: true,
            cleanup: () => Promise.reject(new Error("stop failed")),
          }),
      }),
      /publish failed/,
    );

    assert.deepEqual(calls, ["prepare", "publish:7", "stop"]);
    const failures = _getBufferForTesting().filter(
      (entry) => entry.event === "cleanup_failed",
    );
    assert.equal(failures.length, 1, "the cleanup error stays observable");
    assert.equal(failures[0].error, "Error: stop failed");
  });

  it("keeps the start error primary when the cleanup reports failures", async () => {
    const calls: string[] = [];

    await assert.rejects(
      startRuntime({
        scope: {},
        origin: MAIN_ORIGIN,
        createRuntime: () =>
          recordingRuntime(calls, {
            failPrepare: true,
            cleanup: () =>
              Promise.resolve(reportOf(new Error("dispose failed"))),
          }),
      }),
      /prepare failed/,
    );

    const failures = _getBufferForTesting().filter(
      (entry) => entry.event === "cleanup_failed",
    );
    assert.deepEqual(
      failures.map((entry) => [entry.scope, entry.service, entry.error]),
      [["extension", "service-0", "Error: dispose failed"]],
    );
  });

  it("does not close a runtime that started", async () => {
    const calls: string[] = [];

    await startRuntime({
      scope: {},
      origin: MAIN_ORIGIN,
      createRuntime: () => recordingRuntime(calls),
    });

    assert.deepEqual(calls, ["prepare", "publish:7"]);
  });
});
