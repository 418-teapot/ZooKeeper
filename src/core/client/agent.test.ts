/**
 * Direct unit tests for core/client/agent.ts.
 *
 * Tests `getAgentName()` and `isDolphinAgent()` in isolation, covering all edge
 * cases: valid clients, null/undefined clients, missing methods, and thrown
 * errors. These complement the indirect coverage provided by hook adapter tests.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type Clientish, getAgentName, isDolphinAgent } from "./agent.js";

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

// ---------------------------------------------------------------------------
// isDolphinAgent
// ---------------------------------------------------------------------------

describe("isDolphinAgent", () => {
  it("returns true when agent is 'dolphin'", async () => {
    const client = mockClient("dolphin");
    const result = await isDolphinAgent(client, "s1");
    assert.equal(result, true);
  });

  it("returns false when agent is 'beaver'", async () => {
    const client = mockClient("beaver");
    const result = await isDolphinAgent(client, "s1");
    assert.equal(result, false);
  });

  it("returns false when agent is 'lynx'", async () => {
    const client = mockClient("lynx");
    const result = await isDolphinAgent(client, "s1");
    assert.equal(result, false);
  });

  it("returns false for null client", async () => {
    const result = await isDolphinAgent(null, "s1");
    assert.equal(result, false);
  });

  it("returns false for undefined client", async () => {
    const result = await isDolphinAgent(undefined, "s1");
    assert.equal(result, false);
  });

  it("returns false when getSession throws", async () => {
    const badClient: Clientish = {
      getSession: async () => {
        throw new Error("fail");
      },
    };
    const result = await isDolphinAgent(badClient, "s1");
    assert.equal(result, false);
  });

  it("returns false when agent is undefined", async () => {
    const client = mockClient(undefined);
    const result = await isDolphinAgent(client, "s1");
    assert.equal(result, false);
  });
});
