/**
 * Tests for `src/core/context/context-report.ts` -- pure format helpers.
 *
 * Covers: formatTokens, formatPercent, progressBar.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatPercent, formatTokens, progressBar } from "./context-report.js";

// ---------------------------------------------------------------------------
// formatTokens helper
// ---------------------------------------------------------------------------

describe("formatTokens", () => {
  it("returns 0 for zero", () => {
    assert.equal(formatTokens(0), "0");
  });

  it("returns bare number below 1000", () => {
    assert.equal(formatTokens(500), "500");
    assert.equal(formatTokens(999), "999");
  });

  it("formats thousands as X.XK", () => {
    assert.equal(formatTokens(1000), "1.0K");
    assert.equal(formatTokens(45200), "45.2K");
    assert.equal(formatTokens(123456), "123.5K");
  });

  it("formats 1M+ as integer K", () => {
    assert.equal(formatTokens(1000000), "1000K");
    assert.equal(formatTokens(2000000), "2000K");
  });
});

// ---------------------------------------------------------------------------
// formatPercent helper
// ---------------------------------------------------------------------------

describe("formatPercent", () => {
  it("returns 0% for zero", () => {
    assert.equal(formatPercent(0), "0%");
  });

  it("returns 100% for 1", () => {
    assert.equal(formatPercent(1), "100%");
  });

  it("formats one decimal place", () => {
    assert.equal(formatPercent(0.2667), "26.7%");
    assert.equal(formatPercent(0.5), "50.0%");
  });
});

// ---------------------------------------------------------------------------
// progressBar helper
// ---------------------------------------------------------------------------

describe("progressBar", () => {
  it("returns all filled for ratio 1", () => {
    assert.equal(progressBar(1), "██████████");
  });

  it("returns all empty for ratio 0", () => {
    assert.equal(progressBar(0), "░░░░░░░░░░");
  });

  it("returns half filled for ratio 0.5", () => {
    assert.equal(progressBar(0.5), "█████░░░░░");
  });

  it("clamps ratio to [0, 1]", () => {
    assert.equal(progressBar(-0.5), "░░░░░░░░░░");
    assert.equal(progressBar(1.5), "██████████");
  });

  it("uses custom width when provided", () => {
    assert.equal(progressBar(1, 5), "█████");
    assert.equal(progressBar(0, 5), "░░░░░");
    assert.equal(progressBar(0.5, 8), "████░░░░");
  });

  it("defaults to width 10 when omitted", () => {
    assert.equal(progressBar(1), "██████████");
    assert.equal(progressBar(0), "░░░░░░░░░░");
  });
});

// ---------------------------------------------------------------------------
// barrel export
// ---------------------------------------------------------------------------

describe("barrel export", () => {
  it("exports formatTokens as a function", () => {
    assert.equal(typeof formatTokens, "function");
  });

  it("exports progressBar as a function", () => {
    assert.equal(typeof progressBar, "function");
  });

  it("exports formatPercent as a function", () => {
    assert.equal(typeof formatPercent, "function");
  });
});
