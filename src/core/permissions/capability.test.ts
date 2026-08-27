/**
 * Tests for `computeCapabilitySet` in `src/core/permissions/capability.ts`.
 *
 * Covers the fail-closed set-difference contract: a valid baseline minus
 * the denied tools, sorted and deduplicated; a missing or malformed
 * baseline yields an empty set; a malformed denied list denies nothing.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { computeCapabilitySet } from "./capability.js";

// ---------------------------------------------------------------------------
// computeCapabilitySet
// ---------------------------------------------------------------------------

describe("computeCapabilitySet", () => {
  it("returns the set difference of baseline minus denied tools", () => {
    assert.deepEqual(
      computeCapabilitySet({
        baseline: ["bash", "edit", "read", "webfetch"],
        deniedTools: ["webfetch", "edit"],
      }),
      ["bash", "read"],
    );
  });

  it("denied entries outside the baseline are ignored", () => {
    assert.deepEqual(
      computeCapabilitySet({
        baseline: ["bash", "read"],
        deniedTools: ["bash", "nonexistent"],
      }),
      ["read"],
    );
  });

  it("returns an empty array for a missing baseline", () => {
    assert.deepEqual(computeCapabilitySet({ deniedTools: ["bash"] }), []);
    assert.deepEqual(computeCapabilitySet({}), []);
  });

  it("returns an empty array for a non-array baseline", () => {
    assert.deepEqual(
      computeCapabilitySet({ baseline: "bash", deniedTools: ["bash"] }),
      [],
    );
    assert.deepEqual(computeCapabilitySet({ baseline: { bash: true } }), []);
    assert.deepEqual(computeCapabilitySet({ baseline: null }), []);
  });

  it("returns an empty array when the baseline contains non-strings", () => {
    assert.deepEqual(
      computeCapabilitySet({
        baseline: ["bash", 42],
        deniedTools: ["bash"],
      }),
      [],
    );
  });

  it("sorts and deduplicates the output deterministically", () => {
    const a = computeCapabilitySet({
      baseline: ["webfetch", "bash", "edit", "bash"],
      deniedTools: ["edit"],
    });
    const b = computeCapabilitySet({
      baseline: ["bash", "webfetch", "bash", "edit"],
      deniedTools: ["edit"],
    });
    assert.deepEqual(a, ["bash", "webfetch"]);
    assert.deepEqual(b, ["bash", "webfetch"]);
  });

  it("treats a malformed (non-array) denied list as no denies", () => {
    assert.deepEqual(
      computeCapabilitySet({
        baseline: ["bash", "read"],
        deniedTools: "webfetch",
      }),
      ["bash", "read"],
    );
    assert.deepEqual(
      computeCapabilitySet({
        baseline: ["bash", "read"],
        deniedTools: { webfetch: "deny" },
      }),
      ["bash", "read"],
    );
  });

  it("ignores non-string entries inside a valid denied array", () => {
    assert.deepEqual(
      computeCapabilitySet({
        baseline: ["bash", "read"],
        deniedTools: ["bash", 42, { tool: "read" }],
      }),
      ["read"],
    );
  });

  it("returns the full sorted baseline when nothing is denied", () => {
    assert.deepEqual(
      computeCapabilitySet({
        baseline: ["edit", "bash"],
        deniedTools: [],
      }),
      ["bash", "edit"],
    );
  });
});
