/**
 * Tests for the shared plain-record guard (`src/core/records.ts`).
 *
 * The guard is the single definition every persisted-payload parser uses, so
 * the boundary under test is the exported predicate itself: what counts as a
 * spreadable / indexable plain record and what does not.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isRecord } from "./records.js";

describe("isRecord", () => {
  it("accepts plain objects", () => {
    assert.equal(isRecord({}), true);
    assert.equal(isRecord({ a: 1 }), true);
    assert.equal(isRecord(Object.create(null)), true);
  });

  it("rejects null, arrays, and primitives", () => {
    assert.equal(isRecord(null), false);
    assert.equal(isRecord(undefined), false);
    assert.equal(isRecord([]), false);
    assert.equal(isRecord([{ a: 1 }]), false);
    assert.equal(isRecord("text"), false);
    assert.equal(isRecord(0), false);
    assert.equal(isRecord(Number.NaN), false);
    assert.equal(isRecord(true), false);
  });
});
