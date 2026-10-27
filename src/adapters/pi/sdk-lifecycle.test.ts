/**
 * Tests for the pi SDK session lifecycle bridge (`sdk-lifecycle.ts`).
 *
 * The bridge is the only path from the SDK driver's explicit teardown to
 * the extension's lifecycle kernel: an associated session stops through
 * its owner, an unassociated one is an explicit no-op, and a stop must
 * never drop the association a newer extension registered for the same id.
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { CleanupReport } from "../../core/lifecycle/index.js";
import { _getBufferForTesting, _resetForTesting } from "../../utils/logger.js";
import {
  associatePiSdkSession,
  releasePiSdkSession,
  releasePiSdkSessions,
  resetPiSdkLifecycleBridge,
  SDK_STOP_REASON,
  stopPiSdkSession,
} from "./sdk-lifecycle.js";

afterEach(() => {
  resetPiSdkLifecycleBridge();
  _resetForTesting();
});

/** A stopper recording the reasons it was called with. */
function recordingStopper(
  calls: string[],
  report: CleanupReport = { errors: [] },
) {
  return async (reason: string): Promise<CleanupReport> => {
    calls.push(reason);
    return report;
  };
}

describe("pi SDK session lifecycle bridge", () => {
  it("stops the associated scope with the SDK reason", async () => {
    const calls: string[] = [];
    const owner = {};
    associatePiSdkSession("child-1", owner, recordingStopper(calls));

    const report = await stopPiSdkSession("child-1");

    assert.deepEqual(calls, [SDK_STOP_REASON]);
    assert.deepEqual(report, { errors: [] });

    // The association is gone: a second stop is the no-op path.
    await stopPiSdkSession("child-1");
    assert.deepEqual(calls, [SDK_STOP_REASON]);
  });

  it("does nothing for a session no extension associated", async () => {
    const calls: string[] = [];
    associatePiSdkSession("child-1", {}, recordingStopper(calls));

    const reports = await Promise.all([
      stopPiSdkSession("other"),
      stopPiSdkSession(undefined),
      stopPiSdkSession(null),
      stopPiSdkSession(""),
      stopPiSdkSession("   "),
    ]);

    assert.deepEqual(calls, []);
    for (const report of reports) assert.deepEqual(report, { errors: [] });
  });

  it("returns the owner's cleanup failures instead of swallowing them", async () => {
    const failure = {
      scope: "session" as const,
      sessionID: "child-1",
      service: "worker",
      error: new Error("boom"),
    };
    associatePiSdkSession("child-1", {}, async () => ({ errors: [failure] }));

    const report = await stopPiSdkSession("child-1");

    assert.deepEqual(report.errors, [failure]);
    // The failure must also be observable in the log, never swallowed.
    const logged = _getBufferForTesting().filter(
      (entry) => entry.event === "cleanup_failed",
    );
    assert.equal(logged.length, 1);
    assert.equal(logged[0]?.sessionId, "child-1");
    assert.equal(logged[0]?.service, "worker");
  });

  it("reports a throwing stopper as a bridge failure", async () => {
    associatePiSdkSession("child-1", {}, async () => {
      throw new Error("stop exploded");
    });

    const report = await stopPiSdkSession("child-1");

    assert.equal(report.errors.length, 1);
    assert.equal(report.errors[0]?.service, "pi-sdk-lifecycle-bridge");
    assert.equal(report.errors[0]?.sessionID, "child-1");
    assert.match(String(report.errors[0]?.error), /stop exploded/);
  });

  it("stops only the association a replaced extension still owned", async () => {
    const first: string[] = [];
    const second: string[] = [];
    const owner1 = {};
    const owner2 = {};
    associatePiSdkSession("child-1", owner1, recordingStopper(first));
    // A replacement extension takes the same session id over.
    associatePiSdkSession("child-1", owner2, recordingStopper(second));

    // The stale owner cannot release the new association.
    assert.equal(releasePiSdkSession("child-1", owner1), false);
    await stopPiSdkSession("child-1");

    assert.deepEqual(first, []);
    assert.deepEqual(second, [SDK_STOP_REASON]);
  });

  it("keeps an association a stop's own scope re-registered", async () => {
    const calls: string[] = [];
    const owner = {};
    const next = {};
    associatePiSdkSession("child-1", owner, async (reason) => {
      calls.push(`stop:${reason}`);
      // A replacement extension binds the same id while the old scope is
      // still being torn down.
      associatePiSdkSession("child-1", next, recordingStopper(calls));
      return { errors: [] };
    });

    await stopPiSdkSession("child-1");
    await stopPiSdkSession("child-1");

    assert.deepEqual(calls, [`stop:${SDK_STOP_REASON}`, SDK_STOP_REASON]);
  });

  it("releases every association of one extension only", async () => {
    const calls: string[] = [];
    const owner = {};
    const other = {};
    associatePiSdkSession("a", owner, recordingStopper(calls));
    associatePiSdkSession("b", owner, recordingStopper(calls));
    associatePiSdkSession("c", other, recordingStopper(calls));

    assert.equal(releasePiSdkSessions(owner), 2);
    await stopPiSdkSession("a");
    await stopPiSdkSession("b");
    assert.deepEqual(calls, []);
    await stopPiSdkSession("c");
    assert.deepEqual(calls, [SDK_STOP_REASON]);
  });

  it("ignores blank session ids when associating", () => {
    const calls: string[] = [];
    assert.equal(associatePiSdkSession("", {}, recordingStopper(calls)), false);
    assert.equal(
      associatePiSdkSession(undefined, {}, recordingStopper(calls)),
      false,
    );
  });
});
