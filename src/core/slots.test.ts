/**
 * Tests for `makeHookContributions` in `src/core/slots.ts`.
 *
 * Covers the default-empty slot set and partial overrides.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { makeHookContributions } from "./slots.js";

describe("makeHookContributions", () => {
  it("defaults every hook slot to an empty array", () => {
    const contributions = makeHookContributions();

    assert.equal(contributions.kind, "hook");
    assert.deepEqual(contributions.afterExec, []);
    assert.deepEqual(contributions.transform, []);
    assert.deepEqual(contributions.textComplete, []);
    assert.deepEqual(contributions.toolDefinition, []);
    assert.deepEqual(contributions.delegation, []);
    assert.deepEqual(contributions.onSettled, []);
  });

  it("applies the named slot and keeps omitted slots empty", () => {
    const handler = { name: "x", handle: async () => {} };
    const contributions = makeHookContributions({ afterExec: [handler] });

    assert.deepEqual(contributions.afterExec, [handler]);
    assert.deepEqual(contributions.transform, []);
    assert.deepEqual(contributions.textComplete, []);
    assert.deepEqual(contributions.toolDefinition, []);
    assert.deepEqual(contributions.delegation, []);
    assert.deepEqual(contributions.onSettled, []);
  });
});
