/**
 * Tests for `src/core/context/context-report.ts` -- pure format layer.
 *
 * Covers: formatTokens, formatPercent, progressBar, formatContextReport
 * output.  The `ContextReport` input is constructed directly as literals —
 * computation logic (v1 message parsing, category breakdown) is the
 * adapter's responsibility and is tested in the OpenCode adapter's
 * `types.test.ts`.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ContextReport } from "./context-report.js";
import {
  formatContextReport,
  formatPercent,
  formatTokens,
  progressBar,
} from "./context-report.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a report literal with the minimum required fields.
 *
 * `cacheHitRate` drives the cache line; `total` / `messageCount` drive
 * the usage and message lines.
 */
function report(
  total: number,
  messageCount: number,
  cacheHitRate: number | null,
): ContextReport {
  return {
    total,
    exact: 0,
    heuristic: total,
    messageCount,
    cacheHitRate,
    categories: { user: 0, assistant: 0, tool: 0, system: 0 },
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
// formatContextReport output
// ---------------------------------------------------------------------------

describe("formatContextReport output", () => {
  it("includes cache hit rate when available", () => {
    const output = formatContextReport(report(905, 2, 0.267));
    assert.ok(output.includes("缓存"));
    assert.ok(output.includes("26.7%"));
    // No parenthetical note.
    assert.ok(!output.includes("（"));
  });

  it("shows em dash for unavailable cache", () => {
    const output = formatContextReport(report(5, 1, null));
    assert.ok(output.includes("缓存"));
    assert.ok(output.includes("—"));
    // No parenthetical explanation.
    assert.ok(!output.includes("（"));
  });

  it("shows all-zero state for an empty report", () => {
    const output = formatContextReport(report(0, 0, null));
    assert.ok(output.includes("0 tokens"));
    assert.ok(output.includes("0 条"));
  });

  it("omits category breakdown section", () => {
    const output = formatContextReport(report(150, 2, null));
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
    const output = formatContextReport(report(150, 2, null));
    assert.ok(!output.includes("█"));
    assert.ok(!output.includes("░"));
  });

  it("shows total usage line", () => {
    const output = formatContextReport(report(1212, 3, null));
    assert.ok(output.includes("用量    ~"));
    // No detailed exact/heuristic breakdown row remains.
    assert.ok(!output.includes("精确    "));
  });

  it("every line is <= 60 characters wide", () => {
    const output = formatContextReport(report(50000, 8, 0.61));
    for (const line of output.split("\n")) {
      assert.ok(
        line.length <= 60,
        `line exceeds 60 chars (${line.length}): "${line}"`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// formatContextReport -- reclaim section
// ---------------------------------------------------------------------------

describe("formatContextReport with reclaim", () => {
  it("renders reclaim section when prunedTokens > 0", () => {
    const output = formatContextReport(report(600, 2, null), {
      prunedTokens: 12345,
    });
    assert.ok(output.includes("回收"), "expected reclaim section");
    assert.ok(output.includes("已生效"), "expected 已生效 in reclaim section");
    assert.ok(
      output.includes("12.3K"),
      "expected formatted token value (12.3K for 12345)",
    );
    assert.ok(
      output.includes("累计剪枝"),
      "expected 累计剪枝 in reclaim section",
    );
  });

  it("does NOT render reclaim section when prunedTokens = 0", () => {
    const output = formatContextReport(report(600, 2, null), {
      prunedTokens: 0,
    });
    assert.ok(
      !output.includes("回收"),
      "should NOT include reclaim section when total = 0",
    );
  });

  it("does NOT render reclaim section when both fields are omitted", () => {
    const output = formatContextReport(report(600, 2, null));
    assert.ok(
      !output.includes("回收"),
      "should NOT include reclaim section when fields are omitted",
    );
  });

  it("renders reclaim section from prunedTokens with cumulative-prune parenthetical", () => {
    const output = formatContextReport(report(600, 2, null), {
      prunedTokens: 13000,
    });
    assert.ok(output.includes("回收"), "expected reclaim section");
    assert.ok(output.includes("已生效"), "expected 已生效");
    assert.ok(output.includes("13.0K"), "expected formatted total");
    assert.ok(
      output.includes("累计剪枝"),
      "expected 累计剪枝 in parenthetical",
    );
    // Should NOT contain old labels.
    assert.ok(!output.includes("剪枝标记"), "should not contain 剪枝标记");
    // No separate 压缩块 line.
    assert.ok(
      !output.includes("压缩块："),
      "should not contain old block line",
    );
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
// formatContextReport -- pending / released reclaim info
// ---------------------------------------------------------------------------

describe("formatContextReport with pending/released reclaim", () => {
  it("shows pending line when pendingCount > 0 (no reclaimed total)", () => {
    const output = formatContextReport(report(600, 2, null), {
      pendingCount: 3,
      pendingTokens: 1500,
    });
    assert.ok(output.includes("回收"), "expected reclaim section");
    assert.ok(output.includes("待生效"), 'expected "待生效"');
    assert.ok(
      output.includes("3 个剪枝标记"),
      "expected pending count in reclaim section",
    );
    assert.ok(
      output.includes("1.5K"),
      "expected formatted token value in pending info",
    );
    // 已生效 shows 0 when only pending exists.
    assert.ok(
      output.includes("已生效"),
      "expected 已生效 line even when total is 0",
    );
  });

  it("shows reclaimed total when prunedTokens > 0", () => {
    const output = formatContextReport(report(600, 2, null), {
      prunedTokens: 5000,
    });
    assert.ok(output.includes("回收"), "expected reclaim section");
    assert.ok(output.includes("已生效"), "expected 已生效");
    assert.ok(output.includes("5.0K"), "expected formatted token value");
    assert.ok(
      output.includes("累计剪枝"),
      'expected "累计剪枝" in reclaim section',
    );
    assert.ok(!output.includes("待生效"), "should not include pending info");
  });

  it("shows both 已生效 and 待生效 lines when both present", () => {
    const output = formatContextReport(report(600, 2, null), {
      prunedTokens: 10000,
      pendingCount: 2,
      pendingTokens: 800,
    });
    assert.ok(output.includes("回收"), "expected reclaim section");
    assert.ok(output.includes("已生效"), "expected 已生效 in reclaim section");
    assert.ok(output.includes("待生效"), "expected 待生效 in reclaim section");
    assert.ok(
      output.includes("10.0K"),
      "expected formatted 已生效 total (10.0K for 10000)",
    );
    assert.ok(
      output.includes("800"),
      "expected pending tokens value (800 < 1000, bare number)",
    );
    assert.ok(
      output.includes("2 个剪枝标记"),
      "expected pending count in pending line",
    );
    // Two lines under 回收: first is 已生效, second is 待生效 with indent.
    const lines = output.split("\n");
    // 已生效 line starts with 回收, 待生效 is continuation (no 回收 prefix)
    assert.ok(
      lines.some((l) => l.startsWith("回收")),
      "line should start with 回收",
    );
  });

  it("shows active blocks in 已生效 parenthetical when state has active blocks", () => {
    const output = formatContextReport(report(600, 2, null), {
      state: {
        blocks: new Map([
          [
            1,
            {
              start: 0,
              end: 4,
              active: true,
              spanHash: "deadbeef",
              summary: "block summary",
              title: "test",
              compressedTokens: 10000,
              summaryTokens: 500,
              createdAt: Date.now(),
            },
          ],
        ]),
        marks: new Map(),
      },
    });
    // No separate block line; block info lives in 已生效 parenthetical.
    assert.ok(
      !output.includes("压缩块："),
      "should not contain old block line",
    );
    assert.ok(output.includes("已生效"), "expected 已生效 line");
    // Net reclaimed = 10000 - 500 = 9500 -> 9.5K
    assert.ok(
      output.includes("9.5K"),
      `expected "9.5K" in output, got: ${output}`,
    );
    // Parenthetical: "1 个压缩块，折叠 4 条"
    assert.ok(
      output.includes("1 个压缩块"),
      `expected "1 个压缩块" in output, got: ${output}`,
    );
    assert.ok(
      output.includes("折叠 4 条"),
      `expected "折叠 4 条" in output, got: ${output}`,
    );
  });

  it("hides block parenthetical when state has 0 active blocks", () => {
    const output = formatContextReport(report(600, 2, null), {
      state: {
        blocks: new Map([
          [
            1,
            {
              start: 0,
              end: 1,
              active: false,
              spanHash: "deadbeef",
              summary: "block summary",
              title: "test",
              compressedTokens: 1000,
              summaryTokens: 100,
              createdAt: Date.now(),
            },
          ],
        ]),
        marks: new Map(),
      },
    });
    // No reclaim section when all totals are zero.
    assert.ok(
      !output.includes("回收"),
      "should NOT contain reclaim section when no active blocks and no prunedTokens",
    );
  });

  it("hides block parenthetical when state is omitted", () => {
    const output = formatContextReport(report(600, 2, null));
    assert.ok(
      !output.includes("压缩块"),
      "should NOT contain block info when state is omitted",
    );
  });

  it("does NOT show reclaim section when all fields are absent or zero", () => {
    const output = formatContextReport(report(600, 2, null), {
      prunedTokens: 0,
      pendingCount: 0,
      pendingTokens: 0,
    });
    assert.ok(
      !output.includes("回收"),
      "should NOT include reclaim section when all zero",
    );
  });
});

// ---------------------------------------------------------------------------
// formatContextReport -- dual-scope message count
// ---------------------------------------------------------------------------

describe("formatContextReport dual-scope message count", () => {
  it("shows single-count form when folded = storage", () => {
    const output = formatContextReport(report(600, 2, null), {
      foldedMessageCount: 2,
      storageMessageCount: 2,
    });
    assert.ok(output.includes("消息    "));
    assert.ok(output.includes("2 条"));
    assert.ok(!output.includes("模型可见"));
    assert.ok(!output.includes("存储"));
  });

  it("shows dual-scope form when folded differs from storage", () => {
    const output = formatContextReport(report(600, 2, null), {
      foldedMessageCount: 2,
      storageMessageCount: 5,
    });
    assert.ok(output.includes("模型可见 2 条"));
    assert.ok(output.includes("存储 5 条"));
  });

  it("falls back to single-count when opts omit message counts", () => {
    const output = formatContextReport(report(600, 2, null));
    assert.ok(output.includes("消息    "));
    assert.ok(output.includes("2 条"));
    assert.ok(!output.includes("模型可见"));
  });
});

// ---------------------------------------------------------------------------
// No trailing spaces
// ---------------------------------------------------------------------------

describe("no trailing spaces", () => {
  it("every line has no trailing whitespace", () => {
    const output = formatContextReport(report(50000, 8, 0.61), {
      prunedTokens: 12345,
      pendingCount: 2,
      pendingTokens: 500,
    });
    for (const line of output.split("\n")) {
      assert.equal(
        line,
        line.trimEnd(),
        `line has trailing whitespace: "${line}"`,
      );
    }
  });
});
