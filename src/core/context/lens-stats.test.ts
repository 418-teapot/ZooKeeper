/**
 * Tests for the lens-based sidebar statistics (`lens-stats.ts`).
 *
 * Boundary chosen: the three exported aggregates over a lens transcript
 * (`computeTokenBreakdown`, `computeCacheTrend`, `computeCumulativeCacheRate`).
 * Expected values are hand-computed literals from the API-usage
 * definition, independent of the code's own arithmetic.  Covered edges:
 * no assistant message, assistant without usage, a single assistant,
 * zero cache denominators, and non-assistant roles carrying usage.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { makeAssistantMsg, makeMsg } from "../../testkits/context.js";
import {
  computeCacheTrend,
  computeCumulativeCacheRate,
  computeTokenBreakdown,
} from "./lens-stats.js";

// ---------------------------------------------------------------------------
// computeTokenBreakdown
// ---------------------------------------------------------------------------

describe("computeTokenBreakdown (lens)", () => {
  it("sums cacheRead, input, and output across assistant messages", () => {
    // assistant 1: read 200, input 500, output 100
    // assistant 2: read 100, input 300, output 80
    const messages = [
      makeMsg("user", ["Hello"]),
      makeAssistantMsg({ usage: { input: 500, output: 100, cacheRead: 200 } }),
      makeMsg("user", ["Follow-up"]),
      makeAssistantMsg({
        usage: { input: 300, output: 80, cacheRead: 100, cacheWrite: 20 },
      }),
    ];
    const result = computeTokenBreakdown(messages);
    assert.deepEqual(result, {
      cacheRead: 300,
      input: 800,
      output: 180,
      total: 1280,
    });
  });

  it("ignores non-assistant roles even when they carry usage", () => {
    const messages = [
      makeAssistantMsg({ usage: { input: 400, output: 60, cacheRead: 150 } }),
      makeMsg("user", ["tool output"], {
        usage: { input: 999, output: 50, cacheRead: 500 },
      }),
      makeAssistantMsg({ usage: { input: 200, output: 40, cacheRead: 80 } }),
    ];
    const result = computeTokenBreakdown(messages);
    assert.deepEqual(result, {
      cacheRead: 230,
      input: 600,
      output: 100,
      total: 930,
    });
  });

  it("returns zeros when no assistant carries usage", () => {
    const messages = [
      makeMsg("user", ["Hello"]),
      makeAssistantMsg({ text: "no usage" }),
    ];
    assert.deepEqual(computeTokenBreakdown(messages), {
      cacheRead: 0,
      input: 0,
      output: 0,
      total: 0,
    });
  });

  it("treats missing fields as zero", () => {
    const messages = [
      makeMsg("user", ["Hi"]),
      makeAssistantMsg({ usage: { input: 100, output: 50 } }),
    ];
    assert.deepEqual(computeTokenBreakdown(messages), {
      cacheRead: 0,
      input: 100,
      output: 50,
      total: 150,
    });
  });

  it("returns zeros for an empty transcript", () => {
    assert.deepEqual(computeTokenBreakdown([]), {
      cacheRead: 0,
      input: 0,
      output: 0,
      total: 0,
    });
  });
});

// ---------------------------------------------------------------------------
// computeCacheTrend
// ---------------------------------------------------------------------------

describe("computeCacheTrend (lens)", () => {
  it("reports an up trend and a rounded label", () => {
    // previous: 200 / (500 + 200 + 50) = 200/750
    // last:     300 / (300 + 300 + 50) = 300/650
    // delta:    (300/650 − 200/750) × 100 ≈ 19.487 percentage points
    const messages = [
      makeMsg("user", ["First"]),
      makeAssistantMsg({
        text: "Reply A",
        usage: { input: 500, output: 100, cacheRead: 200, cacheWrite: 50 },
      }),
      makeMsg("user", ["Follow-up"]),
      makeAssistantMsg({
        text: "Reply B",
        usage: { input: 300, output: 80, cacheRead: 300, cacheWrite: 50 },
      }),
    ];
    const result = computeCacheTrend(messages);
    assert.equal(result.hasTrendData, true);
    assert.equal(result.lastRate, 300 / 650);
    assert.equal(result.previousRate, 200 / 750);
    assert.equal(Math.round((result.trend as number) * 1e6) / 1e6, 19.487179);
    assert.equal(result.trendLabel, "↑19.5%");
  });

  it("reports a down trend", () => {
    const messages = [
      makeAssistantMsg({
        usage: { input: 300, output: 80, cacheRead: 300, cacheWrite: 50 },
      }),
      makeAssistantMsg({
        usage: { input: 500, output: 100, cacheRead: 200, cacheWrite: 50 },
      }),
    ];
    const result = computeCacheTrend(messages);
    assert.equal(result.hasTrendData, true);
    assert.equal(result.trendLabel, "↓19.5%");
  });

  it("has no trend data with a single assistant but keeps lastRate", () => {
    const messages = [
      makeMsg("user", ["Hello"]),
      makeAssistantMsg({ usage: { input: 500, cacheRead: 200 } }),
    ];
    const result = computeCacheTrend(messages);
    assert.equal(result.hasTrendData, false);
    assert.equal(result.lastRate, 200 / 700);
    assert.equal(result.previousRate, null);
    assert.equal(result.trend, null);
    assert.equal(result.trendLabel, null);
  });

  it("has no trend data when no assistant has positive usage", () => {
    const messages = [
      makeMsg("user", ["Hello"]),
      makeAssistantMsg({ text: "no usage" }),
      makeMsg("user", ["Again"]),
      makeAssistantMsg({
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      }),
    ];
    const result = computeCacheTrend(messages);
    assert.equal(result.hasTrendData, false);
    assert.equal(result.lastRate, null);
    assert.equal(result.previousRate, null);
  });

  it("emits the dash label when the rate is unchanged", () => {
    const usage = { input: 500, output: 100, cacheRead: 200, cacheWrite: 50 };
    const messages = [
      makeAssistantMsg({ usage }),
      makeMsg("user", ["Follow-up"]),
      makeAssistantMsg({ usage }),
    ];
    const result = computeCacheTrend(messages);
    assert.equal(result.hasTrendData, true);
    assert.equal(result.trend, 0);
    assert.equal(result.trendLabel, "-");
  });

  it("skips zero-denominator assistants when finding the last two", () => {
    const messages = [
      makeAssistantMsg({
        usage: { input: 500, cacheRead: 200, cacheWrite: 50 },
      }),
      makeAssistantMsg({ usage: { input: 0, cacheRead: 0, cacheWrite: 0 } }),
      makeAssistantMsg({
        usage: { input: 300, cacheRead: 300, cacheWrite: 50 },
      }),
    ];
    const result = computeCacheTrend(messages);
    assert.equal(result.hasTrendData, true);
    assert.equal(result.lastRate, 300 / 650);
    assert.equal(result.previousRate, 200 / 750);
  });

  it("has no trend data for an empty transcript", () => {
    const result = computeCacheTrend([]);
    assert.deepEqual(result, {
      lastRate: null,
      previousRate: null,
      trend: null,
      hasTrendData: false,
      trendLabel: null,
    });
  });
});

// ---------------------------------------------------------------------------
// computeCumulativeCacheRate
// ---------------------------------------------------------------------------

describe("computeCumulativeCacheRate (lens)", () => {
  it("sums across all assistant messages", () => {
    // input 500+300=800, read 200+100=300, write 50+20=70
    // denominator 1170, rate 300/1170 ≈ 0.2564
    const messages = [
      makeMsg("user", ["First"]),
      makeAssistantMsg({
        usage: { input: 500, output: 100, cacheRead: 200, cacheWrite: 50 },
      }),
      makeMsg("user", ["Second"]),
      makeAssistantMsg({
        usage: { input: 300, output: 80, cacheRead: 100, cacheWrite: 20 },
      }),
    ];
    const result = computeCumulativeCacheRate(messages);
    assert.equal(result.totalRead, 300);
    assert.equal(result.totalDenominator, 1170);
    assert.equal(Math.round((result.cumulativeRate as number) * 1000), 256);
  });

  it("returns null when no assistant carries usage", () => {
    const messages = [
      makeMsg("user", ["Hello"]),
      makeAssistantMsg({ text: "no usage" }),
    ];
    const result = computeCumulativeCacheRate(messages);
    assert.equal(result.cumulativeRate, null);
    assert.equal(result.totalRead, 0);
    assert.equal(result.totalDenominator, 0);
  });

  it("returns null when all usage is zero", () => {
    const messages = [
      makeAssistantMsg({
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      }),
    ];
    assert.equal(computeCumulativeCacheRate(messages).cumulativeRate, null);
  });

  it("returns null for an empty transcript", () => {
    const result = computeCumulativeCacheRate([]);
    assert.equal(result.cumulativeRate, null);
    assert.equal(result.totalRead, 0);
    assert.equal(result.totalDenominator, 0);
  });
});
