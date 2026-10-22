/**
 * Tests for the retained pure display helpers of the OpenCode TUI.
 *
 * The subagent state machine this module used to own now lives in the core
 * run registry (see `src/adapters/opencode/subagent-source.ts` and its
 * suite), so only the panel-level display helpers are covered here.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { formatDuration } from "./subagent.js";

// ---------------------------------------------------------------------------
// formatDuration
// ---------------------------------------------------------------------------

describe("formatDuration", () => {
  it("formats seconds (< 60)", () => {
    assert.equal(formatDuration(12_000), "12s");
  });

  it("formats 0 seconds", () => {
    assert.equal(formatDuration(0), "0s");
  });

  it("formats minutes and seconds (≥ 60)", () => {
    assert.equal(formatDuration(125_000), "2m05s");
  });

  it("zero-pads seconds in minute format", () => {
    assert.equal(formatDuration(60_000), "1m00s");
  });

  it("formats exact minute boundary", () => {
    assert.equal(formatDuration(60_000), "1m00s");
  });

  it("formats multiple minutes with seconds", () => {
    assert.equal(formatDuration(5 * 60_000 + 7_000), "5m07s");
  });

  it('returns "—" for negative values', () => {
    assert.equal(formatDuration(-1), "—");
  });

  it('returns "—" for NaN', () => {
    assert.equal(formatDuration(NaN), "—");
  });

  it('returns "—" for Infinity', () => {
    assert.equal(formatDuration(Infinity), "—");
  });
});
