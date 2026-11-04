/**
 * Tests for the per-session model context-limit registry.
 *
 * Boundary: `createModelLimitRegistry` (the registry instance the context
 * runtime composes).  Covers: set/get round-trip, unknown-session reads,
 * invalid-input rejection, overwrite semantics, single-session clearing,
 * and the isolation of two instances.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createModelLimitRegistry } from "./model-limits.js";

describe("model-limit registry", () => {
  it("stores and retrieves a captured model limit", () => {
    const registry = createModelLimitRegistry();
    registry.set("sess-1", 200000, "gpt-test");
    assert.deepEqual(registry.get("sess-1"), {
      context: 200000,
      modelId: "gpt-test",
    });
  });

  it("returns undefined for unknown sessions", () => {
    const registry = createModelLimitRegistry();
    assert.equal(registry.get("nope"), undefined);
  });

  it("ignores missing session IDs and non-finite limits", () => {
    const registry = createModelLimitRegistry();
    registry.set("", 200000, "gpt-test");
    registry.set("sess-2", Number.NaN, "gpt-test");
    registry.set("sess-3", Number.POSITIVE_INFINITY, "gpt-test");
    assert.equal(registry.get(""), undefined);
    assert.equal(registry.get("sess-2"), undefined);
    assert.equal(registry.get("sess-3"), undefined);
  });

  it("overwrites on repeat set for the same session", () => {
    const registry = createModelLimitRegistry();
    registry.set("sess-4", 200000, "gpt-test");
    registry.set("sess-4", 1000000, "gpt-big");
    assert.deepEqual(registry.get("sess-4"), {
      context: 1000000,
      modelId: "gpt-big",
    });
  });

  it("clear removes a single session", () => {
    const registry = createModelLimitRegistry();
    registry.set("sess-5", 200000, "gpt-test");
    registry.set("sess-6", 200000, "gpt-test");
    registry.clear("sess-5");
    assert.equal(registry.get("sess-5"), undefined);
    assert.deepEqual(registry.get("sess-6"), {
      context: 200000,
      modelId: "gpt-test",
    });
  });

  it("keeps two registries independent", () => {
    const first = createModelLimitRegistry();
    const second = createModelLimitRegistry();
    first.set("sess-7", 200000, "gpt-test");
    assert.equal(second.get("sess-7"), undefined);
    assert.ok(first.get("sess-7"));
  });
});
