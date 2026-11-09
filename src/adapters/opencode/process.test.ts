/**
 * Tests for the OpenCode process owner (`process.ts`).
 *
 * The OpenCode server plugin and the TUI panel are two entries of one
 * process: the plugin writes the session → agent bindings and the subagent
 * run records, and the panel renders them.  One owner must answer both, and
 * two owners must share nothing.
 *
 * Boundary: `openCodeProcessState()` and `_resetOpenCodeProcessStateForTesting()`,
 * the single process-wide seam the entries go through.
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { createProcessState } from "../../core/process-state.js";
import {
  _resetOpenCodeProcessStateForTesting,
  openCodeProcessState,
} from "./process.js";

afterEach(() => {
  _resetOpenCodeProcessStateForTesting();
});

describe("OpenCode process owner — one owner per process", () => {
  it("answers the plugin and the panel with the same owner", () => {
    const plugin = openCodeProcessState();
    plugin.sessionAgents.bind("s1", "mola");
    plugin.runs.start({ id: "part_1", agent: "lynx", parentSession: "s1" });

    const panel = openCodeProcessState();

    assert.equal(panel, plugin, "both entries read one owner");
    assert.equal(panel.sessionAgents.resolve("s1"), "mola");
    assert.deepEqual(
      panel.runs.topLevel("s1").map((run) => run.id),
      ["part_1"],
    );
  });

  it("drops the process owner on the test reset", () => {
    const first = openCodeProcessState();
    first.sessionAgents.bind("s1", "mola");

    _resetOpenCodeProcessStateForTesting();

    assert.notEqual(openCodeProcessState(), first);
    assert.equal(openCodeProcessState().sessionAgents.resolve("s1"), undefined);
  });

  it("isolates an injected owner from the process-wide one", () => {
    const shared = openCodeProcessState();
    const injected = createProcessState();
    shared.sessionAgents.bind("s1", "mola");

    assert.equal(injected.sessionAgents.resolve("s1"), undefined);
    assert.deepEqual(injected.runs.topLevel("s1"), []);
  });
});
