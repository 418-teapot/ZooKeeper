/**
 * Tests for the process state (`process-state.ts`).
 *
 * The process state is the one state owner of an OS process: the session →
 * agent bindings and the subagent run records.  Two configuration
 * generations of the same host process share one owner, so a reload keeps
 * both, and two owners never see each other's state.
 *
 * Boundary: `createProcessState()` and the two stores it owns, because the
 * sharing rule is what a reload depends on.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createProcessState } from "./process-state.js";
import { createSessionAgentResource } from "./session/agent.js";

describe("process state — one owner per process", () => {
  it("keeps a session binding and a run record on the owner", () => {
    const process = createProcessState();

    process.sessionAgents.bind("s1", "dolphin");
    process.runs.start({ id: "r1", agent: "lynx", parentSession: "s1" });

    assert.equal(process.sessionAgents.resolve("s1"), "dolphin");
    assert.equal(process.runs.get("r1")?.agent, "lynx");
    assert.deepEqual(
      process.runs.topLevel("s1").map((run) => run.id),
      ["r1"],
    );
  });

  it("isolates two owners", () => {
    const first = createProcessState();
    const second = createProcessState();

    first.sessionAgents.bind("s1", "dolphin");
    first.runs.start({ id: "r1", agent: "lynx", parentSession: "s1" });

    assert.equal(second.sessionAgents.resolve("s1"), undefined);
    assert.equal(second.runs.get("r1"), undefined);
    assert.deepEqual(second.runs.topLevel("s1"), []);
  });

  it("delivers a run change only to the owner's own subscribers", () => {
    const first = createProcessState();
    const second = createProcessState();
    const seen: string[] = [];
    first.runs.subscribe((change) => seen.push(`first:${change.runId}`));
    second.runs.subscribe((change) => seen.push(`second:${change.runId}`));

    first.runs.start({ id: "r1", agent: "lynx", parentSession: "s1" });

    assert.deepEqual(seen, ["first:r1"]);
  });

  it("drops a session binding through the owner's session resource", async () => {
    const process = createProcessState();
    process.sessionAgents.bind("s1", "dolphin");

    await createSessionAgentResource(process.sessionAgents).delete("s1");

    assert.equal(process.sessionAgents.resolve("s1"), undefined);
  });
});
