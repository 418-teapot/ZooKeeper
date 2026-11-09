/**
 * Tests for the pi process owner (`process.ts`).
 *
 * pi replays the extension factory on every reload and loads every
 * sub-session extension in the same process, so one owner must answer every
 * call until the process ends: the reload keeps the session identities, the
 * run records and the pending switch operations.  Two owners share nothing.
 *
 * Boundary: `piProcessState()` and `_resetPiProcessStateForTesting()`, the
 * single process-wide seam the tests and the entry go through.
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  _resetPiProcessStateForTesting,
  createPiProcessState,
  piProcessState,
} from "./process.js";

afterEach(() => {
  _resetPiProcessStateForTesting();
});

describe("pi process owner — one owner per process", () => {
  it("answers every load of one process with the same owner", () => {
    const first = piProcessState();
    first.sessionAgents.bind("s1", "mola");
    first.runs.start({ id: "r1", agent: "lynx", parentSession: "s1" });
    first.switchOps.begin("s1");
    first.switchOps.stash({ activeTools: ["edit"] });

    const reloaded = piProcessState();

    assert.equal(reloaded, first, "a reload keeps the process owner");
    assert.equal(reloaded.sessionAgents.resolve("s1"), "mola");
    assert.equal(reloaded.runs.get("r1")?.agent, "lynx");
    // The replacement's own start claims the trim the old runtime queued.
    reloaded.switchOps.claim("s2", { reason: "new", parentSession: "s1" });
    assert.deepEqual(reloaded.switchOps.drain("s2"), ["edit"]);
  });

  it("drops the process owner on the test reset", () => {
    const first = piProcessState();
    first.sessionAgents.bind("s1", "mola");

    _resetPiProcessStateForTesting();

    assert.notEqual(piProcessState(), first);
    assert.equal(piProcessState().sessionAgents.resolve("s1"), undefined);
  });

  it("isolates two owners' stores and switch slots", () => {
    const first = createPiProcessState();
    const second = createPiProcessState();
    first.sessionAgents.bind("s1", "mola");
    first.runs.start({ id: "r1", agent: "lynx", parentSession: "s1" });
    first.switchOps.begin("s1");
    first.switchOps.stash({ activeTools: ["edit"] });

    assert.equal(second.sessionAgents.resolve("s1"), undefined);
    assert.equal(second.runs.get("r1"), undefined);
    second.switchOps.claim("s2", { reason: "new", parentSession: "s1" });
    assert.equal(
      second.switchOps.drain("s2"),
      undefined,
      "a pending trim never crosses over",
    );
  });
});
