/**
 * Tests for the agent-identity infrastructure in `identity.ts`.
 *
 * Covers: default identity resolution (unset primary fails closed),
 * `setPrimary` + `getPrimary` round-trip, AsyncLocalStorage override of
 * `currentPrimary` within a `runWithIdentity` scope, fallback to
 * `currentPrimary` after the scope ends, concurrent `runWithIdentity`
 * executions seeing their own identity (true async interleaving), and the
 * `derivePrimaries` helper.
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  _resetForTesting,
  derivePrimaries,
  getPrimary,
  resolveIdentity,
  runWithIdentity,
  setPrimary,
} from "./identity.js";

// The module-level identity state is process-global and bun shares one
// isolate across every test file, so reset it between tests to keep the
// "unset" assertions deterministic regardless of other files seeding a
// primary.
afterEach(() => {
  _resetForTesting();
});

// ---------------------------------------------------------------------------
// Default identity resolution
// ---------------------------------------------------------------------------

describe("resolveIdentity — default state", () => {
  it("fails closed when no primary has ever been set", () => {
    // Other test files (bun shares one isolate across concurrently-run
    // files) may seed a primary, so reset deterministically before
    // asserting the unset behaviour rather than relying on pristine
    // module state.
    _resetForTesting();
    assert.equal(resolveIdentity(), undefined);
  });

  it("returns an undefined currentPrimary when unset", () => {
    _resetForTesting();
    assert.equal(getPrimary(), undefined);
  });
});

// ---------------------------------------------------------------------------
// setPrimary / getPrimary
// ---------------------------------------------------------------------------

describe("setPrimary / getPrimary", () => {
  it("round-trips the primary name", () => {
    setPrimary("alpha");
    assert.equal(getPrimary(), "alpha");
  });

  it("resolves a primary identity when set", () => {
    setPrimary("alpha");
    assert.deepEqual(resolveIdentity(), { kind: "primary", name: "alpha" });
  });

  it("getPrimary reflects a later set", () => {
    setPrimary("alpha");
    setPrimary("beta");
    assert.equal(getPrimary(), "beta");
    assert.deepEqual(resolveIdentity(), { kind: "primary", name: "beta" });
  });
});

// ---------------------------------------------------------------------------
// AsyncLocalStorage scope behavior
// ---------------------------------------------------------------------------

describe("runWithIdentity — scope behavior", () => {
  it("ALS store overrides currentPrimary inside the scope", () => {
    setPrimary("alpha");
    runWithIdentity({ kind: "subagent", name: "worker" }, () => {
      assert.deepEqual(resolveIdentity(), { kind: "subagent", name: "worker" });
    });
  });

  it("falls back to currentPrimary after the scope ends", () => {
    setPrimary("alpha");
    runWithIdentity({ kind: "subagent", name: "worker" }, () => {
      assert.deepEqual(resolveIdentity(), { kind: "subagent", name: "worker" });
    });
    assert.deepEqual(resolveIdentity(), { kind: "primary", name: "alpha" });
  });

  it("binds a primary identity through the scope too", () => {
    setPrimary("alpha");
    runWithIdentity({ kind: "primary", name: "bravo" }, () => {
      assert.deepEqual(resolveIdentity(), { kind: "primary", name: "bravo" });
    });
    assert.deepEqual(resolveIdentity(), { kind: "primary", name: "alpha" });
  });
});

// ---------------------------------------------------------------------------
// Concurrent AsyncLocalStorage isolation
// ---------------------------------------------------------------------------

describe("runWithIdentity — concurrent isolation", () => {
  it("two concurrent runs each see their own identity", async () => {
    setPrimary("alpha");

    /** Resolve the identity after a real async yield inside the scope. */
    const probe = async (expected: string): Promise<string> => {
      const first = resolveIdentity();
      await Promise.resolve();
      const afterYield = resolveIdentity();
      assert.equal(afterYield?.kind, "subagent");
      assert.equal(afterYield?.name, expected);
      assert.equal(first, afterYield);
      return expected;
    };

    const [left, right] = await Promise.all([
      runWithIdentity({ kind: "subagent", name: "left" }, () => probe("left")),
      runWithIdentity({ kind: "subagent", name: "right" }, () =>
        probe("right"),
      ),
    ]);

    assert.equal(left, "left");
    assert.equal(right, "right");

    // Outside both scopes resolution falls back to the primary.
    assert.deepEqual(resolveIdentity(), { kind: "primary", name: "alpha" });
  });

  it("nested scopes restore the outer identity on exit", async () => {
    setPrimary("alpha");
    await runWithIdentity({ kind: "subagent", name: "outer" }, async () => {
      assert.equal(resolveIdentity()?.name, "outer");
      await runWithIdentity({ kind: "subagent", name: "inner" }, async () => {
        assert.equal(resolveIdentity()?.name, "inner");
        await Promise.resolve();
        assert.equal(resolveIdentity()?.name, "inner");
      });
      assert.equal(resolveIdentity()?.name, "outer");
    });
    assert.equal(resolveIdentity()?.name, "alpha");
  });
});

// ---------------------------------------------------------------------------
// derivePrimaries
// ---------------------------------------------------------------------------

describe("derivePrimaries", () => {
  it("returns an empty set for an empty agents array", () => {
    assert.deepEqual(derivePrimaries([], {}), []);
  });

  it("returns an empty set when no agent is marked primary", () => {
    assert.deepEqual(
      derivePrimaries(["alpha", "beta"], {
        alpha: "subagent",
        beta: "subagent",
      }),
      [],
    );
  });

  it("keeps a single primary and drops subagents", () => {
    assert.deepEqual(
      derivePrimaries(["alpha", "beta", "gamma"], {
        alpha: "subagent",
        beta: "primary",
        gamma: "subagent",
      }),
      ["beta"],
    );
  });

  it("keeps multiple primaries in array order", () => {
    assert.deepEqual(
      derivePrimaries(["alpha", "beta", "gamma"], {
        alpha: "primary",
        beta: "subagent",
        gamma: "primary",
      }),
      ["alpha", "gamma"],
    );
  });

  it("treats agents missing from the modes map as non-primaries", () => {
    assert.deepEqual(
      derivePrimaries(["alpha", "beta", "gamma"], { beta: "primary" }),
      ["beta"],
    );
  });
});
