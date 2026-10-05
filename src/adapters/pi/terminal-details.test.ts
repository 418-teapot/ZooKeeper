/**
 * Tests for the terminal tool result's `details` payload
 * (`terminal-details.ts`).
 *
 * The payload carries the run's fact pointer (its sub-session file path)
 * plus the terminal outcome once the run has one, and the write-back merge
 * never lets a contribution displace the bridge's own keys.
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  finishRun,
  resetRegistry,
  startRun,
  updateRun,
} from "../../core/subagent/registry.js";
import {
  mergeTerminalToolDetails,
  terminalToolDetails,
} from "./terminal-details.js";

afterEach(() => {
  resetRegistry();
});

describe("terminal tool details", () => {
  it("terminal details carry only the run's sub-session path pointer", () => {
    // The bridge forwards no structured progress any more: pi never
    // persists a partial's `details`, so the terminal result carries only
    // the fact pointer that lets a view re-hydrate the run after a restart
    // — the sub-session file path the driver reported mid-run, looked up by
    // run id (the pi tool-call id) in the run registry.  A run that has not
    // reached a terminal state yet contributes no `outcome`.
    startRun({ id: "call-pointer", agent: "beaver", parentSession: "sess-1" });
    updateRun("call-pointer", {
      sessionPath: "/home/u/.pi/agent/sessions/x/s.jsonl",
    });
    assert.deepEqual(
      terminalToolDetails("call-pointer"),
      { sessionPath: "/home/u/.pi/agent/sessions/x/s.jsonl" },
      "details must carry the session path pointer and nothing else",
    );
  });

  it("terminal details stay empty without a run or a path", () => {
    // A tool with no registry run (compress / decompress) and a run that
    // never reported a path (a host that does not persist sessions) both
    // contribute an empty details object.
    assert.deepEqual(terminalToolDetails("call-unknown"), {});
    assert.deepEqual(terminalToolDetails(undefined), {});
    assert.deepEqual(terminalToolDetails(42), {});
    startRun({ id: "call-no-path", agent: "beaver", parentSession: "s" });
    assert.deepEqual(terminalToolDetails("call-no-path"), {});
  });

  it("the bridge's own keys win a details collision", () => {
    // A contribution may not displace the run's fact pointer by writing a
    // details record that carries the same key: the write-back slot is
    // merged INTO the bridge's own details, never over them.
    startRun({ id: "call-clash", agent: "beaver", parentSession: "sess-1" });
    updateRun("call-clash", { sessionPath: "/real/run.jsonl" });
    assert.deepEqual(
      mergeTerminalToolDetails("call-clash", {
        sessionPath: "/forged/path",
        questions: [],
      }),
      { sessionPath: "/real/run.jsonl", questions: [] },
    );
    // Nothing written back, or a payload that is not a record, adds no keys.
    assert.deepEqual(mergeTerminalToolDetails("call-clash", undefined), {
      sessionPath: "/real/run.jsonl",
    });
    assert.deepEqual(mergeTerminalToolDetails("call-unknown", "nope"), {});
  });

  it("terminal details carry the run's terminal outcome", () => {
    // A run that has reached a terminal state persists its outcome next
    // to the session pointer: the restored-render path needs the real
    // lifecycle status to color the title's dot (an aborted run must not
    // fall back to the bare isError binary, which reads as done).
    startRun({
      id: "call-aborted",
      agent: "beaver",
      parentSession: "sess-1",
      sessionPath: "/home/u/.pi/agent/sessions/x/a.jsonl",
    });
    finishRun("call-aborted", { status: "aborted" });
    assert.deepEqual(terminalToolDetails("call-aborted"), {
      sessionPath: "/home/u/.pi/agent/sessions/x/a.jsonl",
      outcome: "aborted",
    });
  });

  it("terminal details omit outcome while the run is still running", () => {
    // A running run's details carry the pointer only: the outcome field
    // appears exclusively on terminal statuses (done / error / aborted).
    startRun({
      id: "call-live",
      agent: "beaver",
      parentSession: "sess-1",
      sessionPath: "/home/u/.pi/agent/sessions/x/l.jsonl",
    });
    assert.deepEqual(terminalToolDetails("call-live"), {
      sessionPath: "/home/u/.pi/agent/sessions/x/l.jsonl",
    });
  });
});
