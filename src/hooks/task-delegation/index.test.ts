/**
 * Tests for the task delegation judge (`src/hooks/task-delegation`).
 *
 * Tests `judgeDelegationTarget()` as a pure judge, covering the skip
 * boundary semantics (a missing caller — unresolvable session agent —
 * or a missing target — the `subagent_type` argument was not a string —
 * allows) and the allowlist decision for both mola and beaver.  The
 * tool-name filtering (only `subagent` calls are judged) is the gate
 * consumer's responsibility, not the judge's.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { judgeDelegationTarget } from "./index.js";

// ---------------------------------------------------------------------------
// Missing caller / target — skipped (allow)
// ---------------------------------------------------------------------------

describe("judgeDelegationTarget — missing context", () => {
  it("allows when the caller cannot be resolved", () => {
    assert.equal(
      judgeDelegationTarget({ caller: undefined, target: "beaver" }),
      null,
    );
  });

  it("allows when the caller is an empty string", () => {
    assert.equal(judgeDelegationTarget({ caller: "", target: "beaver" }), null);
  });

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
