/**
 * Direct unit tests for core/agent.ts.
 *
 * Tests `getAgentName()` and `isBuildAgent()` in isolation, covering all edge
 * cases: valid clients, null/undefined clients, missing methods, and thrown
 * errors. These complement the indirect coverage provided by hook adapter tests.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type Clientish, getAgentName, isBuildAgent } from "./agent.js";

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
    const client = mockClient("build");
    const name = await getAgentName(client, "s1");
    assert.equal(name, "build");
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

// ---------------------------------------------------------------------------
// isBuildAgent
// ---------------------------------------------------------------------------

describe("isBuildAgent", () => {
  it("returns true when agent is 'build'", async () => {
    const client = mockClient("build");
    const result = await isBuildAgent(client, "s1");
    assert.equal(result, true);
  });

  it("returns false when agent is 'general'", async () => {
    const client = mockClient("general");
    const result = await isBuildAgent(client, "s1");
    assert.equal(result, false);
  });

  it("returns false when agent is 'explore'", async () => {
    const client = mockClient("explore");
    const result = await isBuildAgent(client, "s1");
    assert.equal(result, false);
  });

  it("returns false for null client", async () => {
    const result = await isBuildAgent(null, "s1");
    assert.equal(result, false);
  });

  it("returns false for undefined client", async () => {
    const result = await isBuildAgent(undefined, "s1");
    assert.equal(result, false);
  });

  it("returns false when getSession throws", async () => {
    const badClient: Clientish = {
      getSession: async () => {
        throw new Error("fail");
      },
    };
    const result = await isBuildAgent(badClient, "s1");
    assert.equal(result, false);
  });

  it("returns false when agent is undefined", async () => {
    const client = mockClient(undefined);
    const result = await isBuildAgent(client, "s1");
    assert.equal(result, false);
  });
});
