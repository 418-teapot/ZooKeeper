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
  it("allows delegation to lynx", () => {
    const result = isDelegationAllowed("mola", "lynx");
    assert.equal(result.allowed, true);
    assert.equal(result.reason, undefined);
  });

  it("allows delegation to spider", () => {
    const result = isDelegationAllowed("mola", "spider");
    assert.equal(result.allowed, true);
    assert.equal(result.reason, undefined);
  });

  it("blocks delegation to beaver", () => {
    const result = isDelegationAllowed("mola", "beaver");
    assert.equal(result.allowed, false);
    assert.ok(result.reason?.includes("mola can only delegate to lynx"));
    assert.ok(result.reason?.includes("beaver"));
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
    const result = isDelegationAllowed("mola", "beaver");
    assert.ok(result.reason?.includes("Allowed targets:"));
    assert.ok(result.reason?.includes("lynx"));
    assert.ok(result.reason?.includes("spider"));
  });

  it("reason includes fallback guidance for implementation work", () => {
    const result = isDelegationAllowed("mola", "beaver");
    assert.ok(result.reason?.includes("plan TODOs"));
    assert.ok(result.reason?.includes("execution belongs to dolphin"));
  });
});

// ---------------------------------------------------------------------------
// Restricted agent (beaver)
// ---------------------------------------------------------------------------

describe("isDelegationAllowed — beaver (restricted)", () => {
  it("allows delegation to lynx", () => {
    const result = isDelegationAllowed("beaver", "lynx");
    assert.equal(result.allowed, true);
    assert.equal(result.reason, undefined);
  });

  it("allows delegation to spider", () => {
    const result = isDelegationAllowed("beaver", "spider");
    assert.equal(result.allowed, true);
    assert.equal(result.reason, undefined);
  });

  it("blocks delegation to dolphin", () => {
    const result = isDelegationAllowed("beaver", "dolphin");
    assert.equal(result.allowed, false);
    assert.ok(result.reason?.includes("beaver can only delegate to lynx"));
    assert.ok(result.reason?.includes("dolphin"));
  });

  it("blocks delegation to mola", () => {
    const result = isDelegationAllowed("beaver", "mola");
    assert.equal(result.allowed, false);
    assert.ok(result.reason?.includes("mola"));
  });

  it("blocks delegation to eagle", () => {
    const result = isDelegationAllowed("beaver", "eagle");
    assert.equal(result.allowed, false);
    assert.ok(result.reason?.includes("eagle"));
  });

  it("blocks delegation to kiwi", () => {
    const result = isDelegationAllowed("beaver", "kiwi");
    assert.equal(result.allowed, false);
    assert.ok(result.reason?.includes("kiwi"));
  });

  it("reason lists allowed targets as 'lynx and spider'", () => {
    const result = isDelegationAllowed("beaver", "dolphin");
    assert.ok(result.reason?.includes("Allowed targets:"));
    assert.ok(result.reason?.includes("lynx"));
    assert.ok(result.reason?.includes("spider"));
  });

  it("reason includes beaver-executor-appropriate guidance mentioning orchestrator", () => {
    const result = isDelegationAllowed("beaver", "dolphin");
    assert.ok(result.reason?.includes("orchestrator"));
    assert.ok(
      result.reason?.includes(
        "surface the gap to your orchestrator rather than delegating to another agent",
      ),
    );
  });
});

// ---------------------------------------------------------------------------
// Unrestricted agents
// ---------------------------------------------------------------------------

describe("isDelegationAllowed — unrestricted agents", () => {
  it("allows dolphin to delegate to any subagent", () => {
    for (const target of ["beaver", "lynx", "spider", "eagle", "kiwi"]) {
      const result = isDelegationAllowed("dolphin", target);
      assert.equal(
        result.allowed,
        true,
        `dolphin → ${target} should be allowed`,
      );
      assert.equal(result.reason, undefined);
    }
  });

  it("allows unknown agent to delegate to any subagent", () => {
    const result = isDelegationAllowed("some-new-agent", "beaver");
    assert.equal(result.allowed, true);
    assert.equal(result.reason, undefined);
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("isDelegationAllowed — edge cases", () => {
  it("empty string caller is unrestricted", () => {
    const result = isDelegationAllowed("", "beaver");
    assert.equal(result.allowed, true);
  });

  it("empty string target is blocked for restricted agent", () => {
    const result = isDelegationAllowed("mola", "");
    assert.equal(result.allowed, false);
  });

  it("case-sensitive: 'Mola' is not recognized as restricted", () => {
    const result = isDelegationAllowed("Mola", "beaver");
    assert.equal(result.allowed, true);
  });
});
