/**
 * Direct unit tests for core/client/agent.ts.
 *
 * Tests `getAgentName()` in isolation, covering all edge cases: valid clients,
 * null/undefined clients, missing methods, and thrown errors. These complement
 * the indirect coverage provided by hook adapter tests.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type Clientish, getAgentName } from "./agent.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a mock client that returns the given agent for any session.
 */
function mockClient(agent?: string): Clientish {
  return {
    getSession: async () => ({ agent }),
  };
}

// ---------------------------------------------------------------------------
// getAgentName
// ---------------------------------------------------------------------------

describe("getAgentName", () => {
  it("returns the agent name when client returns one", async () => {
    const client = mockClient("dolphin");
    const name = await getAgentName(client, "s1");
    assert.equal(name, "dolphin");
  });

  it("returns undefined when session has no agent field", async () => {
    const client = mockClient(undefined);
    const name = await getAgentName(client, "s1");
    assert.equal(name, undefined);
  });

  it("returns undefined for null client", async () => {
    const name = await getAgentName(null, "s1");
    assert.equal(name, undefined);
  });

  it("returns undefined for undefined client", async () => {
    const name = await getAgentName(undefined, "s1");
    assert.equal(name, undefined);
  });

  it("returns undefined when client lacks getSession", async () => {
    const client = {} as Clientish;
    const name = await getAgentName(client, "s1");
    assert.equal(name, undefined);
  });

  it("returns undefined when getSession throws", async () => {
    const badClient: Clientish = {
      getSession: async () => {
        throw new Error("fail");
      },
    };
    const name = await getAgentName(badClient, "s1");
    assert.equal(name, undefined);
  });
});
