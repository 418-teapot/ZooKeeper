/**
 * Tests for the orchestrator agent-name invariant (`orchestrator.ts`).
 *
 * The constant documents a system invariant — the orchestrator session is
 * always driven by the dolphin agent.  These tests pin it to the specification
 * literal and cross-check it against the dolphin agent descriptor, so renaming
 * the agent without updating the constant cannot silently drift.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { unit } from "../agents/dolphin.js";
import { ORCHESTRATOR_AGENT_NAME } from "./orchestrator.js";
import type { ActiveSet, Deps } from "./slots.js";

/** Minimal deps for unit descriptor instantiation. */
const DEPS: Deps = {
  limits: {},
  contextConfig: {},
  client: {},
  directory: "",
  resolveAgent: () => undefined,
};

/** An empty active set: the descriptor still yields the orchestrator agent. */
const ACTIVE_SET: ActiveSet = {
  agents: new Set(),
  skills: new Set(),
  hooks: new Set(),
  tools: new Set(),
  commands: new Set(),
};

describe("ORCHESTRATOR_AGENT_NAME", () => {
  it("is the dolphin agent per the system invariant", () => {
    assert.equal(ORCHESTRATOR_AGENT_NAME, "dolphin");
  });

  it("matches the dolphin agent descriptor's declared name", () => {
    assert.equal(ORCHESTRATOR_AGENT_NAME, unit.name);
  });

  it("names every session the dolphin descriptor contributes", () => {
    const contribution = unit.create(DEPS, ACTIVE_SET);
    const names = contribution.agents.map((agent) => agent.name);
    assert.deepEqual(names, [ORCHESTRATOR_AGENT_NAME]);
  });
});
