/**
 * Tests for the orchestrator agent-name invariant (`orchestrator.ts`).
 *
 * The constant documents a system invariant — the orchestrator session is
 * always driven by the dolphin agent.  This test pins it to the
 * specification literal; the descriptor cross-check lives in
 * `dolphin.test.ts` (an agent unit may import core, never the reverse), so
 * renaming the agent without updating the constant cannot silently drift.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ORCHESTRATOR_AGENT_NAME } from "./orchestrator.js";

describe("ORCHESTRATOR_AGENT_NAME", () => {
  it("is the dolphin agent per the system invariant", () => {
    assert.equal(ORCHESTRATOR_AGENT_NAME, "dolphin");
  });
});
