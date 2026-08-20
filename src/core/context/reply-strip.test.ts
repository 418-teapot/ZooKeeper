/**
 * Tests for the outbound reply ref-stripping (`reply-strip.ts`).
 *
 * Covers the strict start-of-text rule: an exact `[mN] ` prefix (natural
 * integer, single trailing space) is removed repeatedly, while every
 * deviation — a missing trailing space, leading whitespace/newline, a
 * malformed form, or a mid-text occurrence — leaves the text unchanged.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { stripLineStartRefs } from "./reply-strip.js";

// ---------------------------------------------------------------------------
// Exact prefix stripping
// ---------------------------------------------------------------------------

describe("stripLineStartRefs", () => {
  it("strips an exact leading [mN] prefix", () => {
    assert.equal(stripLineStartRefs("[m3] hello world"), "hello world");
  });

  it("strips a leading prefix with a larger integer", () => {
    assert.equal(stripLineStartRefs("[m12] body"), "body");
  });

  it("strips stacked exact prefixes", () => {
    assert.equal(stripLineStartRefs("[m3] [m5] body"), "body");
  });

  it("strips three stacked exact prefixes", () => {
    assert.equal(stripLineStartRefs("[m1] [m2] [m3] hello"), "hello");
  });

  it("is idempotent on already-clean text", () => {
    const input = "plain reply text";
    assert.equal(stripLineStartRefs(stripLineStartRefs(input)), input);
  });

  // -------------------------------------------------------------------------
  // Unchanged cases — no fuzzy tolerance
  // -------------------------------------------------------------------------

  it("returns text without a prefix unchanged", () => {
    const input = "just a reply";
    assert.equal(stripLineStartRefs(input), input);
  });

  it("does not strip a prefix without the trailing space", () => {
    const input = "[m3]body";
    assert.equal(stripLineStartRefs(input), input);
  });

  it("does not strip a prefix with leading whitespace", () => {
    const input = "  [m3] body";
    assert.equal(stripLineStartRefs(input), input);
  });

  it("does not strip a prefix with a leading newline", () => {
    const input = "\n[m3] body";
    assert.equal(stripLineStartRefs(input), input);
  });

  it("does not strip a mid-text prefix", () => {
    const input = "see [m3] here";
    assert.equal(stripLineStartRefs(input), input);
  });

  it("does not strip a prefix in a later line", () => {
    const input = "first line\n[m3] body";
    assert.equal(stripLineStartRefs(input), input);
  });

  it("does not strip a malformed bracket form", () => {
    assert.equal(stripLineStartRefs("[m3]foo bar"), "[m3]foo bar");
    assert.equal(stripLineStartRefs("m3] body"), "m3] body");
    assert.equal(stripLineStartRefs("[m3 body"), "[m3 body");
  });

  it("returns an empty string unchanged", () => {
    assert.equal(stripLineStartRefs(""), "");
  });
});
