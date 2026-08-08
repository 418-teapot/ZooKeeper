/**
 * Tests for the per-session model context-limit registry.
 *
 * Covers: set/get round-trip, unknown-session reads, invalid-input
 * rejection, overwrite semantics, single-session clearing, and the
 * testing reset.
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  _resetForTesting,
  clearModelLimit,
  getModelLimit,
  setModelLimit,
} from "./model-limits.js";

afterEach(() => {
  _resetForTesting();
});

describe("model-limits registry", () => {
  it("stores and retrieves a captured model limit", () => {
    setModelLimit("sess-1", 200000, "gpt-test");
    assert.deepEqual(getModelLimit("sess-1"), {
      context: 200000,
      modelId: "gpt-test",
    });
  });

  it("returns undefined for unknown sessions", () => {
    assert.equal(getModelLimit("nope"), undefined);
  });

  it("ignores missing session IDs and non-finite limits", () => {
    setModelLimit("", 200000, "gpt-test");
    setModelLimit("sess-2", Number.NaN, "gpt-test");
    setModelLimit("sess-3", Number.POSITIVE_INFINITY, "gpt-test");
    assert.equal(getModelLimit(""), undefined);
    assert.equal(getModelLimit("sess-2"), undefined);
    assert.equal(getModelLimit("sess-3"), undefined);
  });

  it("overwrites on repeat set for the same session", () => {
    setModelLimit("sess-4", 200000, "gpt-test");
    setModelLimit("sess-4", 1000000, "gpt-big");
    assert.deepEqual(getModelLimit("sess-4"), {
      context: 1000000,
      modelId: "gpt-big",
    });
  });

  it("clearModelLimit removes a single session", () => {
    setModelLimit("sess-5", 200000, "gpt-test");
    setModelLimit("sess-6", 200000, "gpt-test");
    clearModelLimit("sess-5");
    assert.equal(getModelLimit("sess-5"), undefined);
    assert.deepEqual(getModelLimit("sess-6"), {
      context: 200000,
      modelId: "gpt-test",
    });
  });

  it("_resetForTesting clears all entries", () => {
    setModelLimit("sess-7", 200000, "gpt-test");
    _resetForTesting();
    assert.equal(getModelLimit("sess-7"), undefined);
  });
});
