/**
 * Tests for the task delegation validation hook adapter.
 *
 * Tests `validateDelegationTarget()` with mock clients, covering all
 * exit paths: non-delegation tools, missing session/agent/subagent, allowlisted
 * and blocked delegations for both mola and build.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Clientish } from "../../core/client/agent.js";
import { validateDelegationTarget } from "./index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a mock client that returns the given agent for any session. */
function mockClient(agent?: string): Clientish {
  return {
    getSession: async () => ({ agent }),
  };
}

/** Thin wrapper: call validateDelegationTarget and capture any thrown error. */
async function tryValidate(
  client: Clientish | null,
  tool: string,
  sessionID: string | undefined,
  args?: Record<string, unknown>,
): Promise<Error | null> {
  try {
    await validateDelegationTarget(client, { tool, sessionID }, { args });
    return null;
  } catch (err) {
    return err as Error;
  }
}

// ---------------------------------------------------------------------------
// Non-delegation tools — skipped
// ---------------------------------------------------------------------------

describe("validateDelegationTarget — non-delegation tools", () => {
  it("skips grep without throwing", async () => {
    const client = mockClient("mola");
    const err = await tryValidate(client, "grep", "s1", {
      subagent_type: "beaver",
    });
    assert.equal(err, null);
  });

  it("skips edit without throwing", async () => {
    const client = mockClient("mola");
    const err = await tryValidate(client, "edit", "s1", {
      subagent_type: "beaver",
    });
    assert.equal(err, null);
  });
});

// ---------------------------------------------------------------------------
// Missing session / agent / subagent — skipped
// ---------------------------------------------------------------------------

describe("validateDelegationTarget — missing context", () => {
  it("skips when sessionID is undefined", async () => {
    const client = mockClient("mola");
    const err = await tryValidate(client, "subagent", undefined, {
      subagent_type: "beaver",
    });
    assert.equal(err, null);
  });

  it("skips when agent cannot be resolved (null client)", async () => {
    const err = await tryValidate(null, "subagent", "s1", {
      subagent_type: "beaver",
    });
    assert.equal(err, null);
  });

  it("skips when subagent_type is missing from args", async () => {
    const client = mockClient("mola");
    const err = await tryValidate(client, "subagent", "s1", { prompt: "..." });
    assert.equal(err, null);
  });

  it("skips when subagent_type is not a string", async () => {
    const client = mockClient("mola");
    const err = await tryValidate(client, "subagent", "s1", {
      subagent_type: 123,
    });
    assert.equal(err, null);
  });
});

// ---------------------------------------------------------------------------
// Mola — allowlisted targets
// ---------------------------------------------------------------------------

describe("validateDelegationTarget — mola allowlisted", () => {
  it("allows mola to delegate to lynx", async () => {
    const client = mockClient("mola");
    const err = await tryValidate(client, "subagent", "s1", {
      subagent_type: "lynx",
    });
    assert.equal(err, null);
  });

  it("allows mola to delegate to spider", async () => {
    const client = mockClient("mola");
    const err = await tryValidate(client, "subagent", "s1", {
      subagent_type: "spider",
    });
    assert.equal(err, null);
  });
});

// ---------------------------------------------------------------------------
// Mola — blocked targets
// ---------------------------------------------------------------------------

describe("validateDelegationTarget — mola blocked", () => {
  it("blocks mola delegating to beaver", async () => {
    const client = mockClient("mola");
    const err = await tryValidate(client, "subagent", "s1", {
      subagent_type: "beaver",
    });
    assert.ok(err instanceof Error);
    assert.ok(err.message.includes("mola can only delegate to lynx"));
    assert.ok(err.message.includes("beaver"));
    assert.ok(err.message.includes("not allowed"));
  });

  it("blocks mola delegating to eagle", async () => {
    const client = mockClient("mola");
    const err = await tryValidate(client, "subagent", "s1", {
      subagent_type: "eagle",
    });
    assert.ok(err instanceof Error);
    assert.ok(err.message.includes("eagle"));
  });

  it("blocks mola delegating to kiwi", async () => {
    const client = mockClient("mola");
    const err = await tryValidate(client, "subagent", "s1", {
      subagent_type: "kiwi",
    });
    assert.ok(err instanceof Error);
    assert.ok(err.message.includes("kiwi"));
  });

  it("error message includes allowed targets list", async () => {
    const client = mockClient("mola");
    const err = await tryValidate(client, "subagent", "s1", {
      subagent_type: "beaver",
    });
    assert.ok(err instanceof Error);
    assert.ok(err.message.includes("Allowed targets:"));
    assert.ok(err.message.includes("lynx"));
    assert.ok(err.message.includes("spider"));
  });

  it("error message includes fallback guidance", async () => {
    const client = mockClient("mola");
    const err = await tryValidate(client, "subagent", "s1", {
      subagent_type: "beaver",
    });
    assert.ok(err instanceof Error);
    assert.ok(err.message.includes("plan TODOs"));
    assert.ok(err.message.includes("execution belongs to dolphin"));
  });
});

// ---------------------------------------------------------------------------
// Beaver — allowlisted targets
// ---------------------------------------------------------------------------

describe("validateDelegationTarget — beaver allowlisted", () => {
  it("allows beaver to delegate to lynx", async () => {
    const client = mockClient("beaver");
    const err = await tryValidate(client, "subagent", "s1", {
      subagent_type: "lynx",
    });
    assert.equal(err, null);
  });

  it("allows beaver to delegate to spider", async () => {
    const client = mockClient("beaver");
    const err = await tryValidate(client, "subagent", "s1", {
      subagent_type: "spider",
    });
    assert.equal(err, null);
  });
});

// ---------------------------------------------------------------------------
// Beaver — blocked targets
// ---------------------------------------------------------------------------

describe("validateDelegationTarget — beaver blocked", () => {
  it("blocks beaver delegating to dolphin", async () => {
    const client = mockClient("beaver");
    const err = await tryValidate(client, "subagent", "s1", {
      subagent_type: "dolphin",
    });
    assert.ok(err instanceof Error);
    assert.ok(err.message.includes("beaver can only delegate to lynx"));
    assert.ok(err.message.includes("dolphin"));
  });

  it("blocks beaver delegating to mola", async () => {
    const client = mockClient("beaver");
    const err = await tryValidate(client, "subagent", "s1", {
      subagent_type: "mola",
    });
    assert.ok(err instanceof Error);
    assert.ok(err.message.includes("mola"));
  });

  it("blocks beaver delegating to eagle", async () => {
    const client = mockClient("beaver");
    const err = await tryValidate(client, "subagent", "s1", {
      subagent_type: "eagle",
    });
    assert.ok(err instanceof Error);
    assert.ok(err.message.includes("eagle"));
  });

  it("blocks beaver delegating to kiwi", async () => {
    const client = mockClient("beaver");
    const err = await tryValidate(client, "subagent", "s1", {
      subagent_type: "kiwi",
    });
    assert.ok(err instanceof Error);
    assert.ok(err.message.includes("kiwi"));
  });
});

// ---------------------------------------------------------------------------
// Build — unrestricted
// ---------------------------------------------------------------------------

describe("validateDelegationTarget — dolphin unrestricted", () => {
  it("allows dolphin to delegate to beaver", async () => {
    const client = mockClient("dolphin");
    const err = await tryValidate(client, "subagent", "s1", {
      subagent_type: "beaver",
    });
    assert.equal(err, null);
  });

  it("allows dolphin to delegate to eagle", async () => {
    const client = mockClient("dolphin");
    const err = await tryValidate(client, "subagent", "s1", {
      subagent_type: "eagle",
    });
    assert.equal(err, null);
  });

  it("allows dolphin to delegate to lynx", async () => {
    const client = mockClient("dolphin");
    const err = await tryValidate(client, "subagent", "s1", {
      subagent_type: "lynx",
    });
    assert.equal(err, null);
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("validateDelegationTarget — edge cases", () => {
  it("skips when getSession throws", async () => {
    const badClient: Clientish = {
      getSession: async () => {
        throw new Error("fail");
      },
    };
    const err = await tryValidate(badClient, "subagent", "s1", {
      subagent_type: "beaver",
    });
    assert.equal(err, null);
  });

  it("skips when agent is undefined (session exists, no agent field)", async () => {
    const client = mockClient(undefined);
    const err = await tryValidate(client, "subagent", "s1", {
      subagent_type: "beaver",
    });
    assert.equal(err, null);
  });
});
