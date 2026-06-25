/**
 * Direct unit tests for core/delegation.ts.
 *
 * Tests `isDelegationAllowed()` in isolation — focus on the allowlist logic:
 * restricted agents, unrestricted agents, unknown agents, and error message
 * content.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isDelegationAllowed } from "./delegation.js";

// ---------------------------------------------------------------------------
// Restricted agent (mola)
// ---------------------------------------------------------------------------

describe("isDelegationAllowed — mola (restricted)", () => {
  it("allows delegation to explore", () => {
    const result = isDelegationAllowed("mola", "explore");
    assert.equal(result.allowed, true);
    assert.equal(result.reason, undefined);
  });

  it("allows delegation to spider", () => {
    const result = isDelegationAllowed("mola", "spider");
    assert.equal(result.allowed, true);
    assert.equal(result.reason, undefined);
  });

  it("blocks delegation to general", () => {
    const result = isDelegationAllowed("mola", "general");
    assert.equal(result.allowed, false);
    assert.ok(result.reason?.includes("mola can only delegate to explore"));
    assert.ok(result.reason?.includes("general"));
  });

  it("blocks delegation to eagle", () => {
    const result = isDelegationAllowed("mola", "eagle");
    assert.equal(result.allowed, false);
    assert.ok(result.reason?.includes("eagle"));
  });

  it("blocks delegation to kiwi", () => {
    const result = isDelegationAllowed("mola", "kiwi");
    assert.equal(result.allowed, false);
    assert.ok(result.reason?.includes("kiwi"));
  });

  it("reason lists allowed targets", () => {
    const result = isDelegationAllowed("mola", "general");
    assert.ok(result.reason?.includes("Allowed targets:"));
    assert.ok(result.reason?.includes("explore"));
    assert.ok(result.reason?.includes("spider"));
  });

  it("reason includes fallback guidance for implementation work", () => {
    const result = isDelegationAllowed("mola", "general");
    assert.ok(result.reason?.includes("plan TODOs"));
    assert.ok(result.reason?.includes("execution belongs to build"));
  });
});

// ---------------------------------------------------------------------------
// Unrestricted agents
// ---------------------------------------------------------------------------

describe("isDelegationAllowed — unrestricted agents", () => {
  it("allows build to delegate to any subagent", () => {
    for (const target of ["general", "explore", "spider", "eagle", "kiwi"]) {
      const result = isDelegationAllowed("build", target);
      assert.equal(result.allowed, true, `build → ${target} should be allowed`);
      assert.equal(result.reason, undefined);
    }
  });

  it("allows unknown agent to delegate to any subagent", () => {
    const result = isDelegationAllowed("some-new-agent", "general");
    assert.equal(result.allowed, true);
    assert.equal(result.reason, undefined);
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("isDelegationAllowed — edge cases", () => {
  it("empty string caller is unrestricted", () => {
    const result = isDelegationAllowed("", "general");
    assert.equal(result.allowed, true);
  });

  it("empty string target is blocked for restricted agent", () => {
    const result = isDelegationAllowed("mola", "");
    assert.equal(result.allowed, false);
  });

  it("case-sensitive: 'Mola' is not recognized as restricted", () => {
    const result = isDelegationAllowed("Mola", "general");
    assert.equal(result.allowed, true);
  });
});
