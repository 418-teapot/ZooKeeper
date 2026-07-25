/**
 * Tests for `src/core/context-report.ts` — pure format layer.
 *
 * Covers: formatTokens, formatPercent, progressBar, formatContextReport
 * output.  Computation logic is tested in `src/core/metrics.test.ts`.
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { _resetForTesting } from "../utils/logger.js";
import {
  formatContextReport,
  formatPercent,
  formatTokens,
  progressBar,
} from "./context-report.js";
import type { ContextMessageEntry } from "./metrics.js";
import { computeContextReport } from "./metrics.js";

// ---------------------------------------------------------------------------
// Logger cleanup
// ---------------------------------------------------------------------------

afterEach(() => {
  _resetForTesting();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal message entry with role, optional tokens, and text.
 */
function msg(
  role: string,
  tokens?: {
    input?: number;
    output?: number;
    reasoning?: number;
    cache?: { read?: number; write?: number };
  },
  text?: string,
): ContextMessageEntry {
  const parts = text !== undefined ? [{ type: "text" as const, text }] : [];
  return { info: { role, id: "m1", tokens }, parts };
}

/**
 * Build a message with a tool part.
 */
function toolMsg(
  role: string,
  tokens: Record<string, unknown> | undefined,
  input: unknown,
  output: unknown,
): ContextMessageEntry {
  return {
    info: { role, id: "m1", tokens: tokens as any },
    parts: [
      { type: "tool", tool: "bash", state: { input, output } },
    ] as unknown as ContextMessageEntry["parts"],
  };
}

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
// formatContextReport output — uses computeContextReport from metrics
// ---------------------------------------------------------------------------

describe("formatContextReport output", () => {
  it("includes cache hit rate when available", () => {
    const msgs: ContextMessageEntry[] = [
      msg("user", undefined, "Hello"),
      msg("assistant", {
        input: 500,
        output: 100,
        cache: { read: 200, write: 50 },
      }),
    ];
    const report = computeContextReport(msgs);
    const output = formatContextReport(report);
    assert.ok(output.includes("缓存"));
    assert.ok(output.includes("26.7%"));
    assert.ok(output.includes("基于最近一次 LLM 调用"));
  });

  it("shows em dash for unavailable cache", () => {
    const msgs: ContextMessageEntry[] = [msg("user", undefined, "Hello")];
    const report = computeContextReport(msgs);
    const output = formatContextReport(report);
    assert.ok(output.includes("缓存"));
    assert.ok(output.includes("—"));
    assert.ok(output.includes("无最近 LLM 调用数据"));
  });

  it("shows all-zero state for empty messages", () => {
    const report = computeContextReport([]);
    const output = formatContextReport(report);
    assert.ok(output.includes("0 tokens"));
    assert.ok(output.includes("0 条"));
  });

  it("omits category breakdown section", () => {
    const msgs: ContextMessageEntry[] = [
      msg("user", undefined, "Hello"),
      msg("assistant", { input: 100, output: 50 }, "Response"),
    ];
    const report = computeContextReport(msgs);
    const output = formatContextReport(report);
    assert.ok(!output.includes("分类占比"));
    assert.ok(
      !output.includes("user "),
      "should not contain category label 'user'",
    );
    assert.ok(
      !output.includes("asst "),
      "should not contain category label 'asst'",
    );
    assert.ok(
      !output.includes("tool "),
      "should not contain category label 'tool'",
    );
    assert.ok(
      !output.includes("sys "),
      "should not contain category label 'sys'",
    );
    assert.ok(
      !output.includes("misc "),
      "should not contain category label 'misc'",
    );
    assert.ok(!output.includes("注：sys"));
    assert.ok(!output.includes("总计"));
  });

  it("omits progress bar characters from report output", () => {
    const msgs: ContextMessageEntry[] = [
      msg("user", undefined, "Hello"),
      msg("assistant", { input: 100, output: 50 }, "Response"),
    ];
    const report = computeContextReport(msgs);
    const output = formatContextReport(report);
    assert.ok(!output.includes("█"));
    assert.ok(!output.includes("░"));
  });

  it("shows total usage line", () => {
    const msgs: ContextMessageEntry[] = [
      msg("user", undefined, "User msg"),
      msg("assistant", { input: 1000, output: 200 }, "Assistant"),
      msg("user", undefined, "Follow up question here"),
    ];
    const report = computeContextReport(msgs);
    const output = formatContextReport(report);
    assert.ok(output.includes("用量  ~"));
    // No detailed exact/heuristic breakdown row remains.
    assert.ok(!output.includes("精确    "));
  });

  it("every line is ≤ 60 characters wide", () => {
    const msgs: ContextMessageEntry[] = [
      msg("user", undefined, "Hello"),
      msg("assistant", {
        input: 5000,
        output: 1000,
        reasoning: 200,
        cache: { read: 3000, write: 500 },
      }),
      msg("user", undefined, "More text for context that goes on a bit longer"),
      toolMsg("assistant", undefined, "ls -la", "file1\nfile2\nfile3\n"),
    ];
    const report = computeContextReport(msgs);
    const output = formatContextReport(report);
    for (const line of output.split("\n")) {
      assert.ok(
        line.length <= 60,
        `line exceeds 60 chars (${line.length}): "${line}"`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// formatContextReport — reclaim line (pruned + dedup released)
// ---------------------------------------------------------------------------

describe("formatContextReport with reclaim", () => {
  it("renders reclaim line when prunedTokens > 0", () => {
    const msgs: ContextMessageEntry[] = [
      msg("user", undefined, "Hello"),
      msg("assistant", { input: 500, output: 100 }, "Response"),
    ];
    const report = computeContextReport(msgs);
    const output = formatContextReport(report, { prunedTokens: 12345 });
    assert.ok(output.includes("回收"), "expected reclaim line");
    assert.ok(
      output.includes("12.3K"),
      "expected formatted token value (12.3K for 12345)",
    );
    assert.ok(
      output.includes("累计回收"),
      "expected '累计回收' in reclaim line",
    );
  });

  it("does NOT render reclaim line when prunedTokens = 0", () => {
    const msgs: ContextMessageEntry[] = [
      msg("user", undefined, "Hello"),
      msg("assistant", { input: 500, output: 100 }, "Response"),
    ];
    const report = computeContextReport(msgs);
    const output = formatContextReport(report, { prunedTokens: 0 });
    assert.ok(
      !output.includes("回收"),
      "should NOT include reclaim line when total = 0",
    );
  });

  it("does NOT render reclaim line when both fields are omitted", () => {
    const msgs: ContextMessageEntry[] = [
      msg("user", undefined, "Hello"),
      msg("assistant", { input: 500, output: 100 }, "Response"),
    ];
    const report = computeContextReport(msgs);
    const output = formatContextReport(report);
    assert.ok(
      !output.includes("回收"),
      "should NOT include reclaim line when fields are omitted",
    );
  });

  it("renders reclaim line from prunedTokens", () => {
    const msgs: ContextMessageEntry[] = [
      msg("user", undefined, "Hello"),
      msg("assistant", { input: 500, output: 100 }, "Response"),
    ];
    const report = computeContextReport(msgs);
    const output = formatContextReport(report, { prunedTokens: 13000 });
    assert.ok(output.includes("回收"), "expected reclaim line");
    assert.ok(
      output.includes("13.0K"),
      "expected formatted total (13.0K for 13000)",
    );
    assert.ok(
      output.includes("累计回收"),
      "expected '累计回收' in reclaim line",
    );
    // Should NOT contain "剪枝" or "去重" labels
    assert.ok(!output.includes("剪枝"), "should not contain '剪枝' label");
    assert.ok(!output.includes("去重"), "should not contain '去重' label");
  });
});

// ---------------------------------------------------------------------------
// Barrel export
// ---------------------------------------------------------------------------

describe("barrel export", () => {
  it("exports formatContextReport as a function", () => {
    assert.equal(typeof formatContextReport, "function");
  });

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

// ---------------------------------------------------------------------------
// formatContextReport — pending / released reclaim info
// ---------------------------------------------------------------------------

describe("formatContextReport with pending/released reclaim", () => {
  it("shows pending info when pendingCount > 0 (no reclaimed total)", () => {
    const msgs: ContextMessageEntry[] = [
      msg("user", undefined, "Hello"),
      msg("assistant", { input: 500, output: 100 }, "Response"),
    ];
    const report = computeContextReport(msgs);
    const output = formatContextReport(report, {
      pendingCount: 3,
      pendingTokens: 1500,
    });
    assert.ok(output.includes("回收"), "expected reclaim line");
    assert.ok(output.includes("待生效"), 'expected "待生效" in reclaim line');
    assert.ok(
      output.includes("3 个标记"),
      "expected pending count in reclaim line",
    );
    assert.ok(
      output.includes("1.5K"),
      "expected formatted token value in pending info",
    );
    assert.ok(output.includes("约"), 'expected "约" in pending info');
  });

  it("shows reclaimed total when prunedTokens > 0", () => {
    const msgs: ContextMessageEntry[] = [
      msg("user", undefined, "Hello"),
      msg("assistant", { input: 500, output: 100 }, "Response"),
    ];
    const report = computeContextReport(msgs);
    const output = formatContextReport(report, {
      prunedTokens: 5000,
    });
    assert.ok(output.includes("回收"), "expected reclaim line");
    assert.ok(output.includes("5.0K"), "expected formatted token value");
    assert.ok(
      output.includes("累计回收"),
      'expected "累计回收" in reclaim line',
    );
    assert.ok(!output.includes("待生效"), "should not include pending info");
  });

  it("appends pending info after reclaimed total when both present", () => {
    const msgs: ContextMessageEntry[] = [
      msg("user", undefined, "Hello"),
      msg("assistant", { input: 500, output: 100 }, "Response"),
    ];
    const report = computeContextReport(msgs);
    const output = formatContextReport(report, {
      prunedTokens: 10000,
      pendingCount: 2,
      pendingTokens: 800,
    });
    assert.ok(output.includes("回收"), "expected reclaim line");
    assert.ok(
      output.includes("10.0K"),
      "expected formatted reclaimed total (10.0K for 10000)",
    );
    assert.ok(
      output.includes("累计回收"),
      'expected "累计回收" in reclaim line',
    );
    assert.ok(output.includes("待生效 2 个标记"), "expected pending info");
    assert.ok(
      output.includes("，"),
      "expected separator between reclaimed total and pending info",
    );
  });

  it("does NOT show reclaim line when all fields are absent or zero", () => {
    const msgs: ContextMessageEntry[] = [
      msg("user", undefined, "Hello"),
      msg("assistant", { input: 500, output: 100 }, "Response"),
    ];
    const report = computeContextReport(msgs);
    const output = formatContextReport(report, {
      prunedTokens: 0,
      pendingCount: 0,
      pendingTokens: 0,
    });
    assert.ok(
      !output.includes("回收"),
      "should NOT include reclaim line when all zero",
    );
  });
});
