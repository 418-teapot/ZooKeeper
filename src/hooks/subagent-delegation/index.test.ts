/**
 * Tests for the subagent delegation judge (`src/hooks/subagent-delegation`).
 *
 * Tests `judgeDelegationTarget()` as a pure judge, covering the fail-closed
 * caller semantics (an unresolvable caller refuses rather than skipping the
 * allowlist), the allow boundary for a missing target (the `subagent_type`
 * argument was not a string), the allowlist decision for both mola and
 * beaver, and the assembly-time capability gate on the unit descriptor.
 * The tool-name filtering (only `subagent` calls are judged) is the gate
 * consumer's responsibility, not the judge's.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ModeProfile } from "../../core/config-types.js";
import type { Capabilities } from "../../core/ports/index.js";
import { composeForTest } from "../../testkits/compose.js";
import { judgeDelegationTarget, unit } from "./index.js";

// ---------------------------------------------------------------------------
// Missing caller — fail-closed (refuse)
// ---------------------------------------------------------------------------

describe("judgeDelegationTarget — missing caller", () => {
  it("refuses when the caller cannot be resolved", () => {
    const refusal = judgeDelegationTarget({
      caller: undefined,
      target: "beaver",
    });
    assert.ok(refusal !== null, "an unknown caller must be refused");
    assert.ok(refusal.reason.includes("无法确定调用者身份"));
  });

  it("refuses when the caller is an empty string", () => {
    const refusal = judgeDelegationTarget({ caller: "", target: "beaver" });
    assert.ok(refusal !== null, "an empty caller must be refused");
    assert.ok(refusal.reason.includes("无法确定调用者身份"));
  });

  it("still allows a resolvable caller to an allowlisted target", () => {
    assert.equal(
      judgeDelegationTarget({ caller: "beaver", target: "lynx" }),
      null,
    );
  });
});

// ---------------------------------------------------------------------------
// Missing target — skipped (allow), the format layer owns it
// ---------------------------------------------------------------------------

describe("judgeDelegationTarget — missing target", () => {
  it("allows when the target is missing from the request", () => {
    assert.equal(
      judgeDelegationTarget({ caller: "mola", target: undefined }),
      null,
    );
  });

  it("allows when the target is an empty string", () => {
    assert.equal(judgeDelegationTarget({ caller: "mola", target: "" }), null);
  });
});

// ---------------------------------------------------------------------------
// Assembly-time capability gate
// ---------------------------------------------------------------------------

/** Minimal capability bag without the caller-resolution port. */
const BASE_CAPS: Partial<Capabilities> = {
  limits: {},
  contextConfig: {},
  directory: "/tmp/zoo",
  resolveAgent: () => undefined,
};

/** A profile enabling only the subagent-delegation hook unit. */
const HOOK_PROFILE: ModeProfile = {
  name: "test",
  agents: [],
  skills: [],
  hooks: ["subagent-delegation"],
  tools: [],
  commands: [],
};

describe("subagent-delegation unit — capability gate", () => {
  it("skips the unit when the host cannot resolve a caller", () => {
    const result = composeForTest(HOOK_PROFILE, [unit], BASE_CAPS);
    assert.equal(result.gate, null);
    assert.deepEqual(result.report.skipped, [
      { name: "subagent-delegation", missing: ["resolveCallerAgent"] },
    ]);
  });

  it("composes the judge when the host provides the caller resolver", () => {
    const result = composeForTest(HOOK_PROFILE, [unit], {
      ...BASE_CAPS,
      resolveCallerAgent: async () => "beaver",
    });
    assert.deepEqual(result.report.skipped, []);
    assert.equal(result.gateNeedsCaller, true);
    const refusal = result.gate?.({ caller: "beaver", target: "kiwi" });
    assert.ok(refusal !== null && refusal !== undefined);
    assert.ok(refusal.reason.includes("not allowed"));
  });
});

// ---------------------------------------------------------------------------
// Mola — allowlisted targets
// ---------------------------------------------------------------------------

describe("judgeDelegationTarget — mola allowlisted", () => {
  it("allows mola to delegate to lynx", () => {
    assert.equal(
      judgeDelegationTarget({ caller: "mola", target: "lynx" }),
      null,
    );
  });

  it("allows mola to delegate to spider", () => {
    assert.equal(
      judgeDelegationTarget({ caller: "mola", target: "spider" }),
      null,
    );
  });
});

// ---------------------------------------------------------------------------
// Mola — blocked targets
// ---------------------------------------------------------------------------

describe("judgeDelegationTarget — mola blocked", () => {
  it("blocks mola delegating to beaver", () => {
    const refusal = judgeDelegationTarget({ caller: "mola", target: "beaver" });
    assert.ok(refusal !== null);
    assert.ok(refusal.reason.includes("mola can only delegate to lynx"));
    assert.ok(refusal.reason.includes("beaver"));
    assert.ok(refusal.reason.includes("not allowed"));
  });

  it("blocks mola delegating to eagle", () => {
    const refusal = judgeDelegationTarget({ caller: "mola", target: "eagle" });
    assert.ok(refusal !== null);
    assert.ok(refusal.reason.includes("eagle"));
  });

  it("blocks mola delegating to kiwi", () => {
    const refusal = judgeDelegationTarget({ caller: "mola", target: "kiwi" });
    assert.ok(refusal !== null);
    assert.ok(refusal.reason.includes("kiwi"));
  });

  it("refusal lists the allowed targets", () => {
    const refusal = judgeDelegationTarget({ caller: "mola", target: "beaver" });
    assert.ok(refusal !== null);
    assert.ok(refusal.reason.includes("Allowed targets:"));
    assert.ok(refusal.reason.includes("lynx"));
    assert.ok(refusal.reason.includes("spider"));
  });

  it("refusal includes caller-specific guidance", () => {
    const refusal = judgeDelegationTarget({ caller: "mola", target: "beaver" });
    assert.ok(refusal !== null);
    assert.ok(refusal.reason.includes("plan TODOs"));
    assert.ok(refusal.reason.includes("execution belongs to dolphin"));
  });
});

// ---------------------------------------------------------------------------
// Beaver — allowlisted targets
// ---------------------------------------------------------------------------

describe("judgeDelegationTarget — beaver allowlisted", () => {
  it("allows beaver to delegate to lynx", () => {
    assert.equal(
      judgeDelegationTarget({ caller: "beaver", target: "lynx" }),
      null,
    );
  });

  it("allows beaver to delegate to spider", () => {
    assert.equal(
      judgeDelegationTarget({ caller: "beaver", target: "spider" }),
      null,
    );
  });
});

// ---------------------------------------------------------------------------
// Beaver — blocked targets
// ---------------------------------------------------------------------------

describe("judgeDelegationTarget — beaver blocked", () => {
  it("blocks beaver delegating to dolphin", () => {
    const refusal = judgeDelegationTarget({
      caller: "beaver",
      target: "dolphin",
    });
    assert.ok(refusal !== null);
    assert.ok(refusal.reason.includes("beaver can only delegate to lynx"));
    assert.ok(refusal.reason.includes("dolphin"));
  });

  it("blocks beaver delegating to mola", () => {
    const refusal = judgeDelegationTarget({ caller: "beaver", target: "mola" });
    assert.ok(refusal !== null);
    assert.ok(refusal.reason.includes("mola"));
  });

  it("blocks beaver delegating to eagle", () => {
    const refusal = judgeDelegationTarget({
      caller: "beaver",
      target: "eagle",
    });
    assert.ok(refusal !== null);
    assert.ok(refusal.reason.includes("eagle"));
  });

  it("blocks beaver delegating to kiwi", () => {
    const refusal = judgeDelegationTarget({ caller: "beaver", target: "kiwi" });
    assert.ok(refusal !== null);
    assert.ok(refusal.reason.includes("kiwi"));
  });
});

// ---------------------------------------------------------------------------
// Unrestricted callers
// ---------------------------------------------------------------------------

describe("judgeDelegationTarget — dolphin unrestricted", () => {
  it("allows dolphin to delegate to beaver", () => {
    assert.equal(
      judgeDelegationTarget({ caller: "dolphin", target: "beaver" }),
      null,
    );
  });

  it("allows dolphin to delegate to eagle", () => {
    assert.equal(
      judgeDelegationTarget({ caller: "dolphin", target: "eagle" }),
      null,
    );
  });

  it("allows dolphin to delegate to lynx", () => {
    assert.equal(
      judgeDelegationTarget({ caller: "dolphin", target: "lynx" }),
      null,
    );
  });
});
