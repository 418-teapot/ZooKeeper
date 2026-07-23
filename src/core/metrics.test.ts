/**
 * Tests for `src/core/metrics.ts`.
 *
 * Covers: findLastCompletedAssistant, estimateMessageHeuristic
 * (text + tool parts), cache hit rate, exact + heuristic total,
 * category breakdown, computeContextReport.
 *
 * This is the canonical test file for all measurement logic;
 * `src/hooks/context-metrics/index.test.ts` tests the barrel re-export
 * and `measureContext` logging contract.
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { _resetForTesting } from "../utils/logger.js";
import {
  type ContextMessageEntry,
  type ContextReport,
  type ContextTokenInfo,
  computeAssistantCacheRate,
  computeCacheTrend,
  computeContextReport,
  computeCumulativeCacheRate,
  computeTokenBreakdown,
  estimateMessageHeuristic,
  estimateTokenCount,
  findCompactionBoundary,
  findFirstCompletedAssistant,
  findLastCompletedAssistant,
  measureContext,
} from "./metrics.js";
import { PRUNED_TOOL_OUTPUT_REPLACEMENT } from "./pruning/types.js";

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
  tokens?: ContextTokenInfo,
  text?: string,
): ContextMessageEntry {
  const parts = text !== undefined ? [{ type: "text" as const, text }] : [];
  return { info: { role, id: "m1", tokens }, parts };
}

/**
 * Build a message entry that contains a tool part with state.input / state.output.
 */
function toolMsg(
  role: string,
  tokens: ContextTokenInfo | undefined,
  input: unknown,
  output: unknown,
  extraText?: string,
): ContextMessageEntry {
  const parts: Array<Record<string, unknown>> = [
    { type: "tool", tool: "bash", state: { input, output } },
  ];
  if (extraText !== undefined) {
    parts.push({ type: "text", text: extraText });
  }
  return {
    info: { role, id: "m1", tokens },
    parts: parts as unknown as ContextMessageEntry["parts"],
  };
}

/**
 * Assert that the category breakdown sums to total (within floating-point
 * tolerance).
 */
function assertCategoriesMatchTotal(report: ContextReport): void {
  const c = report.categories;
  const catSum = c.user + c.assistant + c.tool + c.system + c.misc;
  const diff = Math.abs(catSum - report.total);
  assert.ok(
    diff < 0.1,
    `category sum ${catSum} !== total ${report.total} (diff ${diff})`,
  );
}

// ---------------------------------------------------------------------------
// findLastCompletedAssistant
// ---------------------------------------------------------------------------

describe("findLastCompletedAssistant", () => {
  it("finds the last assistant with tokens.output > 0", () => {
    const msgs: ContextMessageEntry[] = [
      msg("user", undefined, "Hello"),
      msg("assistant", { input: 100, output: 50 }, "First"),
      msg("user", undefined, "Follow-up"),
      msg("assistant", { input: 200, output: 80 }, "Second"),
    ];
    const result = findLastCompletedAssistant(msgs);
    assert.equal(result.index, 3);
    assert.equal(result.exactTokens, 280);
    assert.ok(result.tokens !== null);
    assert.equal(result.tokens.input, 200);
    assert.equal(result.tokens.output, 80);
  });

  it("includes reasoning and cache in exactTokens", () => {
    const msgs: ContextMessageEntry[] = [
      msg("user", undefined, "Hi"),
      msg("assistant", {
        input: 500,
        output: 100,
        reasoning: 50,
        cache: { read: 200, write: 50 },
      }),
    ];
    const result = findLastCompletedAssistant(msgs);
    assert.equal(result.index, 1);
    assert.equal(result.exactTokens, 900); // 500+100+50+200+50
  });

  it("skips streaming assistant (tokens.output = 0)", () => {
    const msgs: ContextMessageEntry[] = [
      msg("user", undefined, "Hi"),
      msg("assistant", { input: 500, output: 0 }, "Still streaming"),
    ];
    const result = findLastCompletedAssistant(msgs);
    assert.equal(result.index, -1);
    assert.equal(result.exactTokens, 0);
    assert.equal(result.tokens, null);
  });

  it("returns index -1 when no assistant has tokens", () => {
    const msgs: ContextMessageEntry[] = [
      msg("user", undefined, "First"),
      msg("assistant", undefined, "No tokens"),
    ];
    const result = findLastCompletedAssistant(msgs);
    assert.equal(result.index, -1);
    assert.equal(result.exactTokens, 0);
  });

  it("returns index -1 for empty array", () => {
    const result = findLastCompletedAssistant([]);
    assert.equal(result.index, -1);
  });
});

// ---------------------------------------------------------------------------
// findFirstCompletedAssistant
// ---------------------------------------------------------------------------

describe("findFirstCompletedAssistant", () => {
  it("finds the first assistant with tokens.output > 0", () => {
    const msgs: ContextMessageEntry[] = [
      msg("user", undefined, "Hello"),
      msg("assistant", { input: 100, output: 50 }, "First"),
      msg("user", undefined, "Follow-up"),
      msg("assistant", { input: 200, output: 80 }, "Second"),
    ];
    const result = findFirstCompletedAssistant(msgs);
    assert.equal(result.index, 1);
    assert.equal(result.exactTokens, 150);
    assert.ok(result.tokens !== null);
    assert.equal(result.tokens.input, 100);
    assert.equal(result.tokens.output, 50);
  });

  it("returns index -1 when no assistant has tokens", () => {
    const msgs: ContextMessageEntry[] = [
      msg("user", undefined, "First"),
      msg("assistant", undefined, "No tokens"),
    ];
    const result = findFirstCompletedAssistant(msgs);
    assert.equal(result.index, -1);
  });

  it("returns index -1 for empty array", () => {
    const result = findFirstCompletedAssistant([]);
    assert.equal(result.index, -1);
  });

  it("skips streaming assistant (tokens.output = 0)", () => {
    const msgs: ContextMessageEntry[] = [
      msg("user", undefined, "Hi"),
      msg("assistant", { input: 500, output: 0 }, "Still streaming"),
    ];
    const result = findFirstCompletedAssistant(msgs);
    assert.equal(result.index, -1);
  });
});

// ---------------------------------------------------------------------------
// estimateMessageHeuristic — text-only (backward compatible)
// ---------------------------------------------------------------------------

describe("estimateMessageHeuristic (text parts)", () => {
  it("returns 0 for empty parts", () => {
    assert.equal(
      estimateMessageHeuristic({ info: { role: "user", id: "m1" }, parts: [] }),
      0,
    );
  });

  it("returns 0 for undefined parts", () => {
    assert.equal(
      estimateMessageHeuristic({ info: { role: "user", id: "m1" } }),
      0,
    );
  });

  it("computes Math.ceil(text.length / 4) for single part", () => {
    const entry: ContextMessageEntry = {
      info: { role: "user", id: "m1" },
      parts: [{ type: "text", text: "Hello World" }],
    };
    // "Hello World" = 11 chars → 11 / 4 = 2.75 → ceil = 3
    assert.equal(estimateMessageHeuristic(entry), 3);
  });

  it("sums across multiple parts", () => {
    const entry: ContextMessageEntry = {
      info: { role: "assistant", id: "a1" },
      parts: [
        { type: "text", text: "Short" }, // 5 chars → ceil(5/4) = 2
        { type: "text", text: "Longer text" }, // 11 chars → ceil(11/4) = 3
      ],
    };
    // Per-part: 2 + 3 = 5
    assert.equal(estimateMessageHeuristic(entry), 5);
  });

  it("ignores parts without text", () => {
    const entry: ContextMessageEntry = {
      info: { role: "user", id: "m1" },
      parts: [
        { type: "text", text: "ABC" }, // 3 / 4 → ceil = 1
        { type: "text" }, // no text → 0
      ],
    };
    assert.equal(estimateMessageHeuristic(entry), 1);
  });
});

// ---------------------------------------------------------------------------
// estimateMessageHeuristic — tool parts
// ---------------------------------------------------------------------------

describe("estimateMessageHeuristic (tool parts)", () => {
  it("counts tool parts via state.input + state.output", () => {
    const entry: ContextMessageEntry = {
      info: { role: "assistant", id: "a1" },
      parts: [
        {
          type: "tool",
          tool: "bash",
          state: { input: "ls -la", output: "total 42\n" },
        },
      ] as unknown as ContextMessageEntry["parts"],
    };
    // Per-part: "ls -la" ceil(6/4)=2 + "total 42\n" ceil(9/4)=3 = 5
    assert.equal(estimateMessageHeuristic(entry), 5);
  });

  it("counts text and tool parts together", () => {
    const entry: ContextMessageEntry = {
      info: { role: "assistant", id: "a1" },
      parts: [
        {
          type: "tool",
          tool: "bash",
          state: { input: "echo hi", output: "hi\n" },
        },
        { type: "text", text: "Done" },
      ] as unknown as ContextMessageEntry["parts"],
    };
    // Per-part: "echo hi" ceil(7/4)=2 + "hi\n" ceil(3/4)=1 + "Done" ceil(4/4)=1 = 4
    assert.equal(estimateMessageHeuristic(entry), 4);
  });

  it("handles tool part with object state", () => {
    const entry: ContextMessageEntry = {
      info: { role: "assistant", id: "a1" },
      parts: [
        {
          type: "tool",
          tool: "bash",
          state: { input: { cmd: "ls" }, output: { stdout: "file1\n" } },
        },
      ] as unknown as ContextMessageEntry["parts"],
    };
    // Per-part: input JSON '{"cmd":"ls"}' 11 chars → ceil(11/4)=3
    // output JSON '{"stdout":"file1\\n"}' 18 chars → ceil(18/4)=5
    // total = 3 + 5 = 8
    assert.equal(estimateMessageHeuristic(entry), 8);
  });

  it("ignores tool parts without state", () => {
    const entry: ContextMessageEntry = {
      info: { role: "assistant", id: "a1" },
      parts: [
        { type: "tool", tool: "bash" },
      ] as unknown as ContextMessageEntry["parts"],
    };
    assert.equal(estimateMessageHeuristic(entry), 0);
  });
});

// ---------------------------------------------------------------------------
// estimateMessageHeuristic — CJK-aware estimation
// ---------------------------------------------------------------------------

describe("estimateMessageHeuristic (CJK-aware)", () => {
  it("estimates pure CJK text at ~1.5 chars/token", () => {
    const entry8: ContextMessageEntry = {
      info: { role: "user", id: "m1" },
      parts: [{ type: "text", text: "你好世界今日天气" }], // 8 CJK → ceil(8/1.5) = 6
    };
    assert.equal(estimateMessageHeuristic(entry8), 6);

    // "你好世界今日天" = 7 CJK chars → ceil(7/1.5) = ceil(4.667) = 5
    const entry7: ContextMessageEntry = {
      info: { role: "user", id: "m1" },
      parts: [{ type: "text", text: "你好世界今日天" }],
    };
    assert.equal(estimateMessageHeuristic(entry7), 5);
  });

  it("estimates mixed CJK and ASCII text", () => {
    const entry: ContextMessageEntry = {
      info: { role: "user", id: "m1" },
      parts: [{ type: "text", text: "你好 world" }],
      // 2 CJK (你, 好) + 6 ASCII (space + "world")
      // ceil(2/1.5 + 6/4) = ceil(1.33 + 1.50) = ceil(2.83) = 3
    };
    assert.equal(estimateMessageHeuristic(entry), 3);
  });

  it("counts CJK punctuation and symbols as CJK", () => {
    // U+3000–U+303F: CJK Symbols & Punctuation
    const entryCjkPunct: ContextMessageEntry = {
      info: { role: "user", id: "m1" },
      parts: [{ type: "text", text: "，。" }], // 2 CJK → ceil(2/1.5) = 2
    };
    assert.equal(estimateMessageHeuristic(entryCjkPunct), 2);

    // U+FF00–U+FFEF: Fullwidth forms
    const entryFullwidth: ContextMessageEntry = {
      info: { role: "user", id: "m1" },
      parts: [{ type: "text", text: "ＡＢ" }], // 2 CJK → ceil(2/1.5) = 2
    };
    assert.equal(estimateMessageHeuristic(entryFullwidth), 2);
  });

  it("estimates tool part with CJK content", () => {
    const entry: ContextMessageEntry = {
      info: { role: "assistant", id: "a1" },
      parts: [
        {
          type: "tool",
          tool: "bash",
          state: { input: "echo 你好", output: "你好世界\n" },
        },
      ] as unknown as ContextMessageEntry["parts"],
    };
    // input: "echo 你好" → 5 ASCII + 2 CJK = ceil(5/4 + 2/1.5) = ceil(1.25 + 1.33) = ceil(2.58) = 3
    // output: "你好世界\n" → 1 ASCII + 4 CJK = ceil(1/4 + 4/1.5) = ceil(0.25 + 2.67) = ceil(2.92) = 3
    // total = 3 + 3 = 6
    assert.equal(estimateMessageHeuristic(entry), 6);
  });
});

// ---------------------------------------------------------------------------
// Cache hit rate (via computeContextReport)
// ---------------------------------------------------------------------------

describe("cache hit rate", () => {
  it("computes cache.read / (input + cache.read + cache.write)", () => {
    const msgs: ContextMessageEntry[] = [
      msg("user", undefined, "Hello"),
      msg("assistant", {
        input: 500,
        output: 100,
        cache: { read: 200, write: 50 },
      }),
    ];
    const report = computeContextReport(msgs);
    assert.ok(report.cacheHitRate !== null);
    assert.equal(Math.round(report.cacheHitRate * 1000), 267);
  });

  it("returns 0 when cache.read is zero (no cache data)", () => {
    const msgs: ContextMessageEntry[] = [
      msg("user", undefined, "Hello"),
      msg("assistant", { input: 500, output: 100 }),
    ];
    const report = computeContextReport(msgs);
    assert.equal(report.cacheHitRate, 0);
  });

  it("returns null when input + cache.read + cache.write is zero", () => {
    const msgs: ContextMessageEntry[] = [
      msg("user", undefined, "Hello"),
      msg("assistant", { input: 0, output: 50, cache: { read: 0, write: 0 } }),
    ];
    const report = computeContextReport(msgs);
    assert.equal(report.cacheHitRate, null);
  });

  it("returns 1.0 when all input tokens are from cache read", () => {
    const msgs: ContextMessageEntry[] = [
      msg("user", undefined, "Hello"),
      msg("assistant", {
        input: 0,
        output: 100,
        cache: { read: 500, write: 0 },
      }),
    ];
    const report = computeContextReport(msgs);
    assert.ok(report.cacheHitRate !== null);
    assert.equal(report.cacheHitRate, 1);
  });

  it("returns null when no completed assistant exists", () => {
    const msgs: ContextMessageEntry[] = [msg("user", undefined, "Hello")];
    const report = computeContextReport(msgs);
    assert.equal(report.cacheHitRate, null);
  });
});

// ---------------------------------------------------------------------------
// Exact + heuristic total
// ---------------------------------------------------------------------------

describe("exact + heuristic total", () => {
  it("sums API-reported tokens exactly when no messages follow", () => {
    const msgs: ContextMessageEntry[] = [
      msg("user", undefined, "Hello"),
      msg("assistant", {
        input: 500,
        output: 100,
        reasoning: 50,
        cache: { read: 200, write: 50 },
      }),
    ];
    const report = computeContextReport(msgs);
    assert.equal(report.exact, 900);
    assert.equal(report.heuristic, 0);
    assert.equal(report.total, 900);
  });

  it("adds heuristic for messages after the last completed assistant", () => {
    const msgs: ContextMessageEntry[] = [
      msg("user", undefined, "Hello"), // 5/4 → ceil = 2
      msg("assistant", { input: 800, output: 150 }, "Response"),
      msg("user", undefined, "Follow-up text here"), // 20/4 = 5
      msg("assistant", { output: 0 }, "Streaming…"), // 10/4 → ceil = 3
    ];
    const report = computeContextReport(msgs);
    assert.equal(report.exact, 950);
    assert.equal(report.heuristic, 8);
    assert.equal(report.total, 958);
  });

  it("uses pure heuristic when no completed assistant found", () => {
    const msgs: ContextMessageEntry[] = [
      msg("user", undefined, "First message"), // 14/4 → ceil = 4
    ];
    const report = computeContextReport(msgs);
    assert.equal(report.exact, 0);
    assert.equal(report.heuristic, 4);
    assert.equal(report.total, 4);
  });

  it("skips streaming assistant (tokens.output = 0)", () => {
    const msgs: ContextMessageEntry[] = [
      msg("user", undefined, "Hello"),
      msg("assistant", { input: 500, output: 0 }, "Still streaming"),
    ];
    const report = computeContextReport(msgs);
    assert.equal(report.exact, 0);
    assert.equal(report.heuristic, 6);
    assert.equal(report.total, 6);
  });

  it("returns zeros for empty messages array", () => {
    const report = computeContextReport([]);
    assert.equal(report.exact, 0);
    assert.equal(report.heuristic, 0);
    assert.equal(report.total, 0);
    assert.equal(report.messageCount, 0);
    assert.equal(report.cacheHitRate, null);
  });
});

// ---------------------------------------------------------------------------
// Category breakdown
// ---------------------------------------------------------------------------

describe("category breakdown", () => {
  it("distributes heuristic across user / assistant / tool / system / misc", () => {
    const msgs: ContextMessageEntry[] = [
      msg("user", undefined, "Hello"), // user: 2
      msg("assistant", { input: 500, output: 100 }, "Response text"), // asst: API exact 100
    ];
    const report = computeContextReport(msgs);
    assert.equal(report.categories.user, 2);
    assert.equal(report.categories.assistant, 100);
    assert.equal(report.categories.tool, 0);
    // system = first asst (input 500 + cache 0) − first user heuristic 2 = 498
    assert.equal(report.categories.system, 498);
    // misc = 600 − 2 − 100 − 0 − 498 = 0
    assert.equal(report.categories.misc, 0);
    assertCategoriesMatchTotal(report);
  });

  it("tool content in tool parts goes to tool category (not system/misc)", () => {
    const msgs: ContextMessageEntry[] = [
      msg("user", undefined, "List files"),
      toolMsg(
        "assistant",
        { input: 100, output: 50 },
        "ls -la",
        "file1\nfile2\n",
      ),
    ];
    const report = computeContextReport(msgs);
    // total = exact (150) + heuristic (0) = 150
    assert.equal(report.total, 150);
    // Raw category heuristics (no scaling): user=3, asst=50, tool=5,
    // sys=97.  catSum (155) exceeds total; misc = 0.
    assert.equal(report.categories.user, 3);
    assert.equal(report.categories.assistant, 50);
    assert.equal(report.categories.tool, 5);
    assert.equal(report.categories.system, 97);
    assert.equal(report.categories.misc, 0);
    assert.ok(
      report.categories.tool > 0,
      "tool category should be > 0 when tool parts exist",
    );
  });

  it("tool part with object state is counted correctly", () => {
    const msgs: ContextMessageEntry[] = [
      msg("user", undefined, "Hi"),
      toolMsg(
        "assistant",
        { input: 500, output: 100 },
        { cmd: "bash", args: ["ls"] },
        { exitCode: 0, stdout: "src\n" },
      ),
    ];
    const report = computeContextReport(msgs);
    // total = exact (600) + heuristic (0) = 600
    assert.equal(report.total, 600);
    // Raw category heuristics (no scaling): user=1, asst=100, tool=15,
    // sys=499.  catSum (615) exceeds total; misc = 0.
    assert.equal(report.categories.user, 1);
    assert.equal(report.categories.assistant, 100);
    assert.equal(report.categories.tool, 15);
    assert.equal(report.categories.system, 499);
    assert.equal(report.categories.misc, 0);
    assert.ok(
      report.categories.tool > 0,
      "tool category must include object state content",
    );
  });

  it("tool message with tool part populates tool category", () => {
    const msgs: ContextMessageEntry[] = [
      msg("user", undefined, "Run command"),
      msg("assistant", { input: 200, output: 60 }, "Let me check"),
      {
        info: { role: "tool", id: "t1" },
        parts: [
          {
            type: "tool",
            tool: "bash",
            state: { input: "echo hello", output: "hello\n" },
          },
        ] as any,
      },
    ];
    const report = computeContextReport(msgs);
    // Per-part ceil: ceil(10/4)=3 + ceil(6/4)=2 = 5 (was pooled ceil(16/4)=4)
    assert.equal(report.categories.tool, 5);
    assert.equal(report.categories.user, 3);
    // asst = 60 (API exact output)
    assert.equal(report.categories.assistant, 60);
    // system = first asst (input 200) − first user heuristic 3 = 197
    assert.equal(report.categories.system, 197);
    // total = exact (260) + heuristic for tool msg after last asst (5) = 265
    // misc = 265 − 3 − 60 − 5 − 197 = 0
    assert.equal(report.categories.misc, 0);
  });

  it("system role text is absorbed by misc (not tool or system)", () => {
    const msgs: ContextMessageEntry[] = [
      msg("system", undefined, "System prompt here"),
      msg("user", undefined, "Hello"),
      msg("assistant", { input: 200, output: 50 }, "OK"),
    ];
    const report = computeContextReport(msgs);
    assert.equal(report.categories.tool, 0);
    assert.equal(report.categories.user, 2);
    // asst = 50 (API exact output)
    assert.equal(report.categories.assistant, 50);
    // system = first asst (input 200) − sum of heuristic for all
    // non-ignored messages in [0, firstAsstIdx=2):
    //   system msg "System prompt here" = ceil(17/4)=5
    //   user msg "Hello" = ceil(5/4)=2
    // subtraction = 5 + 2 = 7, system = 200 − 7 = 193
    assert.equal(report.categories.system, 193);
    // misc = 250 − 2 − 50 − 0 − 193 = 5
    assert.equal(report.categories.misc, 5);
    assertCategoriesMatchTotal(report);
  });

  it("all-heuristic session has zero misc residual", () => {
    const msgs: ContextMessageEntry[] = [
      msg("user", undefined, "Hello"), // 2
      msg("assistant", undefined, "Hi"), // 1
    ];
    const report = computeContextReport(msgs);
    // No completed assistant → system = 0
    assert.equal(report.categories.system, 0);
    // misc = 3 − 2 − 1 − 0 − 0 = 0
    assert.equal(report.categories.misc, 0);
    assertCategoriesMatchTotal(report);
  });

  it("handles messages without parts gracefully", () => {
    const msgs: ContextMessageEntry[] = [
      msg("user", undefined, "Hello"),
      { info: { role: "assistant", id: "a1" } }, // no parts
    ];
    const report = computeContextReport(msgs);
    assert.equal(report.categories.user, 2);
    assert.equal(report.categories.assistant, 0);
    assert.equal(report.categories.system, 0);
    assert.equal(report.categories.misc, 0);
    assertCategoriesMatchTotal(report);
  });
});

// ---------------------------------------------------------------------------
// computeContextReport — prunedCallIDs skip
// ---------------------------------------------------------------------------

describe("computeContextReport with prunedCallIDs", () => {
  it("skips pruned tool parts in the tool category", () => {
    // Two tool messages: one pruned, one not.  The pruned one's tokens
    // must NOT appear in the tool category; the unpruned one's tokens
    // must still appear.
    const msgs: ContextMessageEntry[] = [
      msg("user", undefined, "Hi"), // user heuristic = 1
      // Tool call that will be pruned.
      {
        info: {
          role: "assistant",
          id: "a1",
          tokens: { input: 100, output: 50 },
        },
        parts: [
          {
            type: "tool",
            callID: "call-pruned",
            state: { input: "echo pruned", output: "pruned output\n" },
          },
        ],
      } as unknown as ContextMessageEntry,
      msg("user", undefined, "Again"), // user heuristic = 2
      // Tool call that will NOT be pruned.
      {
        info: {
          role: "assistant",
          id: "a2",
          tokens: { input: 80, output: 30 },
        },
        parts: [
          {
            type: "tool",
            callID: "call-kept",
            state: { input: "ls", output: "file1\nfile2\n" },
          },
        ],
      } as unknown as ContextMessageEntry,
    ];

    const prunedCallIDs = new Set(["call-pruned"]);
    const report = computeContextReport(msgs, prunedCallIDs);

    // Total = exact from last asst (80+30=110) + heuristic for msgs after (0) = 110
    assert.equal(report.total, 110);

    // Pruned tools contribute input + placeholder.  Raw tool = 27
    // (user=3, asst=80, sys=99).  catSum (209) exceeds total; no scaling.
    const placeholderTokens = estimateTokenCount(
      PRUNED_TOOL_OUTPUT_REPLACEMENT,
    );
    const prunedInputTokens = estimateTokenCount("echo pruned"); // 3
    const keptInputTokens = estimateTokenCount("ls"); // 1
    const keptOutputTokens = estimateTokenCount("file1\nfile2\n"); // 3
    const expectedTool =
      prunedInputTokens +
      placeholderTokens +
      keptInputTokens +
      keptOutputTokens; // 27
    assert.equal(report.categories.tool, expectedTool);
    assert.equal(report.categories.user, 3);
    assert.equal(report.categories.assistant, 80);
    assert.ok(report.categories.misc >= 0);
  });

  it("leaves tool category unchanged when prunedCallIDs is empty or undefined", () => {
    // When prunedCallIDs is not provided or empty, all tool parts are counted.
    const msgs: ContextMessageEntry[] = [
      msg("user", undefined, "Run"), // user heuristic = 1
      {
        info: { role: "tool", id: "t1" },
        parts: [
          {
            type: "tool",
            callID: "call-1",
            state: { input: "cmd", output: "result\n" },
          },
        ],
      } as unknown as ContextMessageEntry,
    ];

    // Without prunedCallIDs (undefined) — backward compatible.
    const reportDefault = computeContextReport(msgs);
    // tool: input "cmd" (3/4→1) + output "result\n" (7/4→2) = 3
    assert.ok(
      reportDefault.categories.tool > 0,
      "tool should be > 0 when no prunedCallIDs",
    );

    // With empty set — same behavior as undefined.
    const reportEmpty = computeContextReport(msgs, new Set());
    assert.equal(
      reportDefault.categories.tool,
      reportEmpty.categories.tool,
      "empty set should behave like undefined",
    );
  });

  it("supports both callID and callId field names", () => {
    // Verify that the `callId` field (lowercase d) is also recognized.
    const msgs: ContextMessageEntry[] = [
      msg("user", undefined, "Go"),
      {
        info: { role: "tool", id: "t1" },
        parts: [
          {
            type: "tool",
            callId: "call-lowercase",
            state: { input: "echo test", output: "test\n" },
          },
        ],
      } as unknown as ContextMessageEntry,
    ];

    // With prunedCallIDs containing the lowercase callId.
    // Pruned tools now contribute input + placeholder (not 0).
    const prunedCallIDs = new Set(["call-lowercase"]);
    const report = computeContextReport(msgs, prunedCallIDs);
    // Raw (no scaling): user "Go"=1, tool input "echo test"=3 +
    // placeholder=20 = 23, asst=0, sys=0, misc=0.  total=6.
    // catSum (24) exceeds total; no scaling.
    const expectedTool =
      estimateTokenCount("echo test") +
      estimateTokenCount(PRUNED_TOOL_OUTPUT_REPLACEMENT); // 23
    assert.equal(report.categories.tool, expectedTool);
  });

  it("total is unchanged when prunedCallIDs skips tool parts", () => {
    // The `total` (exact + heuristic) must not change when prunedCallIDs
    // is provided — only the category breakdown's tool row changes.
    // Pruned tools now contribute input + placeholder (which may be
    // larger than original output, so tool can increase after pruning).
    const msgs: ContextMessageEntry[] = [
      msg("user", undefined, "Hi"),
      {
        info: { role: "tool", id: "t1" },
        parts: [
          {
            type: "tool",
            callID: "call-1",
            state: { input: "cmd", output: "output\n" },
          },
        ],
      } as unknown as ContextMessageEntry,
    ];

    const reportNoPrune = computeContextReport(msgs);
    const reportPrune = computeContextReport(msgs, new Set(["call-1"]));

    assert.equal(
      reportNoPrune.total,
      reportPrune.total,
      "total must be the same with or without prunedCallIDs",
    );
    // Pruned tool contributes input + placeholder (not 0).
    assert.ok(
      reportPrune.categories.tool > 0,
      "pruned tool should contribute input + placeholder tokens",
    );
  });
});

// ---------------------------------------------------------------------------
// System prompt estimation (DCP-style)
// ---------------------------------------------------------------------------

describe("system prompt estimation", () => {
  it("computes system = first asst input + cache − first user heuristic", () => {
    // First assistant has input 1000, cache read 200, cache write 50.
    // First user message "Hi there" (8 chars) → ceil(8/4) = 2.
    // system = (1000 + 200 + 50) − 2 = 1248
    const msgs: ContextMessageEntry[] = [
      msg("user", undefined, "Hi there"),
      msg("assistant", {
        input: 1000,
        output: 200,
        cache: { read: 200, write: 50 },
      }),
    ];
    const report = computeContextReport(msgs);
    assert.equal(report.categories.system, 1248);
    assertCategoriesMatchTotal(report);
  });

  it("sets system to 0 when no completed assistant exists", () => {
    const msgs: ContextMessageEntry[] = [
      msg("user", undefined, "Hello"),
      msg("assistant", undefined, "Still thinking"),
    ];
    const report = computeContextReport(msgs);
    assert.equal(report.categories.system, 0);
    assertCategoriesMatchTotal(report);
  });

  it("estimates system from first asst input when no messages precede it", () => {
    // Only an assistant message — no messages before it to subtract.
    // system = firstAsstInput (500) − 0 = 500.
    const msgs: ContextMessageEntry[] = [
      msg("assistant", { input: 500, output: 100 }, "Direct response"),
    ];
    const report = computeContextReport(msgs);
    assert.equal(report.categories.system, 500);
    assertCategoriesMatchTotal(report);
  });

  it("clamps system to non-negative when heuristic exceeds asst input", () => {
    // First user message is very long; first asst input is small.
    // Category heuristic can overshoot total — that's expected for the
    // chars/4 estimator; only check that system clamps to 0.
    const msgs: ContextMessageEntry[] = [
      msg("user", undefined, "A".repeat(400)), // 400/4 = 100 tokens
      msg("assistant", { input: 50, output: 10 }, "OK"),
    ];
    const report = computeContextReport(msgs);
    assert.equal(report.categories.system, 0);
  });

  it("includes cache components in system estimate", () => {
    // system = (input 500 + cache.read 300 + cache.write 100) − user heuristic
    // user msg "Hello" → 5/4 → ceil = 2
    // system = 900 − 2 = 898
    const msgs: ContextMessageEntry[] = [
      msg("user", undefined, "Hello"),
      msg("assistant", {
        input: 500,
        output: 100,
        cache: { read: 300, write: 100 },
      }),
    ];
    const report = computeContextReport(msgs);
    assert.equal(report.categories.system, 898);
    assertCategoriesMatchTotal(report);
  });

  it("works with multiple assistant messages — uses first one", () => {
    const msgs: ContextMessageEntry[] = [
      msg("user", undefined, "Hi"),
      msg("assistant", { input: 300, output: 80 }, "First reply"),
      msg("user", undefined, "Next"),
      msg("assistant", { input: 500, output: 150 }, "Second reply"),
    ];
    const report = computeContextReport(msgs);
    // system = first asst (input 300) − first user heuristic "Hi" (2/4→1)
    // = 300 − 1 = 299
    assert.equal(report.categories.system, 299);
    assertCategoriesMatchTotal(report);
  });
});

// ---------------------------------------------------------------------------
// Compaction boundary — category breakdown after summary‑true message
// ---------------------------------------------------------------------------

/**
 * Build a message entry with summary=true (compaction boundary).
 */
function summaryMsg(text: string): ContextMessageEntry {
  return {
    info: { role: "assistant", id: "summary", summary: true },
    parts: [{ type: "text", text }],
  };
}

describe("compaction boundary", () => {
  it("finds the last summary message as the boundary", () => {
    const msgs: ContextMessageEntry[] = [
      msg("user", undefined, "Old Q"),
      msg("assistant", { input: 500, output: 100 }, "Old A"),
      summaryMsg("Compacted summary"),
      msg("user", undefined, "New Q"),
      msg("assistant", { input: 200, output: 50 }, "New A"),
    ];
    const idx = findCompactionBoundary(msgs);
    assert.equal(idx, 2);
  });

  it("returns -1 when no summary message exists", () => {
    const msgs: ContextMessageEntry[] = [
      msg("user", undefined, "Hello"),
      msg("assistant", { input: 100, output: 50 }, "Hi"),
    ];
    assert.equal(findCompactionBoundary(msgs), -1);
  });

  it("returns -1 for empty array", () => {
    assert.equal(findCompactionBoundary([]), -1);
  });

  it("categories only reflect messages at/after boundary", () => {
    // Pre-boundary history (should be excluded from categories):
    //   "Old long question" → 17 chars/4 → ceil = 5   (user)
    //   old asst: input 1000, output 200                (assistant)
    // Boundary:
    //   summary msg (role assistant, no tokens) — contributes
    //   heuristic fallback: "Previous conversation condensed"
    //   = 30 chars → ceil(30/4) = 8
    // Post-boundary current context:
    //   "New question" → 12 chars/4 → ceil = 3          (user)
    //   new asst: input 300, output 60                  (assistant)
    const msgs: ContextMessageEntry[] = [
      msg("user", undefined, "Old long question"),
      msg("assistant", { input: 1000, output: 200 }, "Old answer"),
      summaryMsg("Previous conversation condensed"),
      msg("user", undefined, "New question"),
      msg("assistant", { input: 300, output: 60 }, "New answer"),
    ];
    const report = computeContextReport(msgs);
    // total = last completed assistant (index 4): 300+60 = 360
    assert.equal(report.total, 360);
    // Raw categories (no scaling): user=3, asst=8(summary)+60=68, tool=0.
    // system = 300 − sum of heuristic for all non-ignored messages
    // in [boundaryIdx=2, firstAsstIdx=4):
    //   summary "Previous conversation condensed" = ceil(30/4)=8
    //   user "New question" = ceil(12/4)=3
    // subtraction = 8 + 3 = 11, system = 300 − 11 = 289
    assert.equal(report.categories.user, 3);
    assert.equal(report.categories.assistant, 68);
    assert.equal(report.categories.tool, 0);
    assert.equal(report.categories.system, 289);
    assert.equal(report.categories.misc, 0);
  });

  it("categories with overshoot show raw values without scaling after boundary", () => {
    // Post-boundary tool heuristic overshoots total → raw values, no scaling.
    const msgs: ContextMessageEntry[] = [
      msg("user", undefined, "Old message"),
      msg("assistant", { input: 2000, output: 500 }, "Old reply"),
      summaryMsg("Summary"),
      msg("user", undefined, "Run cmd"),
      toolMsg("assistant", { input: 150, output: 30 }, "ls", "file1\nfile2\n"),
    ];
    const report = computeContextReport(msgs);
    // total = last completed assistant (index 4): 150+30 = 180
    assert.equal(report.total, 180);
    // Boundary at index 2, catStartIdx = 2.
    // Raw categories (no scaling):
    //   user: "Run cmd" (7 chars) → ceil(7/4) = 2
    //   assistant: summary "Summary" heuristic ceil(7/4)=2 + API 30 = 32
    //   tool: "ls" (2/4→1) + "file1\nfile2\n" (12/4→3) = 4
    //   system: first completed asst after boundary (index 4: input 150)
    //           − sum of heuristic for all non-ignored msgs in
    //           [boundaryIdx=2, firstAsstIdx=4):
    //             summary "Summary" = ceil(7/4)=2
    //             user "Run cmd" = ceil(7/4)=2
    //           subtraction = 4, system = 150 − 4 = 146
    // catSum (184) exceeds total (180); misc = 0.
    assert.equal(report.categories.user, 2);
    assert.equal(report.categories.assistant, 32);
    assert.equal(report.categories.tool, 4);
    assert.equal(report.categories.system, 146);
    assert.equal(report.categories.misc, 0);
    // Each category / total ≤ 1 (no percentage exceeds 100%).
    for (const [key, val] of Object.entries(report.categories)) {
      const pct = report.total > 0 ? val / report.total : 0;
      assert.ok(pct <= 1 + 1e-9, `${key} percent ${pct} exceeds 100%`);
    }
  });

  it("returns to pre-boundary system estimation when no post-boundary assistant", () => {
    // No completed assistant after the boundary → system = 0.
    const msgs: ContextMessageEntry[] = [
      msg("user", undefined, "Old Q"),
      msg("assistant", { input: 500, output: 100 }, "Old A"),
      summaryMsg("Summary"),
      msg("user", undefined, "New Q"),
    ];
    const report = computeContextReport(msgs);
    // total = last completed assistant (index 1): 500+100 = 600
    // heuristic = summary msg + "New Q" = ceil(7/4)=2 + ceil(5/4)=2 = 4
    assert.equal(report.total, 604);
    // Categories after boundary (index 2):
    //   user: "New Q" → 2
    //   assistant: summary "Summary" heuristic → 2
    //   tool: 0
    //   system: 0 (no completed assistant after boundary)
    // Sum = 4 ≤ 604, no scaling. misc = 604 − 4 = 600.
    assert.equal(report.categories.user, 2);
    assert.equal(report.categories.system, 0);
    assert.equal(report.categories.misc, 600);
    assertCategoriesMatchTotal(report);
  });

  it("each category percentage is ≤ 100% in compaction scenario", () => {
    // Stress test: various message types after boundary.
    const msgs: ContextMessageEntry[] = [
      msg("user", undefined, "A".repeat(80)),
      msg("assistant", { input: 300, output: 60 }, "B".repeat(30)),
      summaryMsg("Summary"),
      msg("user", undefined, "C".repeat(20)),
      msg("assistant", { input: 100, output: 30 }, "D".repeat(10)),
    ];
    const report = computeContextReport(msgs);
    for (const [key, val] of Object.entries(report.categories)) {
      const pct = report.total > 0 ? val / report.total : 0;
      assert.ok(
        pct <= 1 + 1e-9,
        `${key} percent ${pct} exceeds 100% (val=${val}, total=${report.total})`,
      );
    }
  });

  it("skips compaction summary with large input tokens when scanning for first assistant", () => {
    // The summary message (compaction boundary) has large tokens.input
    // representing the entire pre-compaction history.  The scan must
    // skip this summary message so that the first assistant found is
    // the real post-boundary assistant, whose input is small.
    const msgs: ContextMessageEntry[] = [
      msg("user", undefined, "Old pre-compaction question"),
      msg(
        "assistant",
        { input: 8000, output: 1500 },
        "Old pre-compaction answer",
      ),
      // Compaction summary at the boundary — large tokens.input
      // reflects the full pre-compaction context fed to the summary LLM call.
      {
        info: {
          role: "assistant",
          id: "summary",
          summary: true,
          tokens: { input: 15000, output: 200 },
        },
        parts: [{ type: "text", text: "Summary of previous conversation" }],
      } as unknown as ContextMessageEntry,
      msg("user", undefined, "New question"),
      msg("assistant", { input: 300, output: 60 }, "New answer"),
    ];
    const report = computeContextReport(msgs);
    // total = last completed assistant (index 4): 300+60 = 360
    assert.equal(report.total, 360);
    // system = firstAsstInput (300) − sum of heuristic for all
    // non-ignored messages in [boundaryIdx=2, firstAsstIdx=4):
    //   summary text "Summary of previous conversation"
    //     (32 chars) → ceil(32/4) = 8
    //   user "New question" (11 chars) → ceil(11/4) = 3
    // subtraction = 11, system = 300 − 11 = 289
    assert.equal(
      report.categories.system,
      289,
      "system must use real assistant input, not summary's large input",
    );
    // System should be a reasonable small value, not the huge
    // pre-compaction history total.
    assert.ok(
      report.categories.system < 1000,
      "system (%d) should not include summary's large input tokens (15000)",
    );
    assert.ok(
      report.categories.system > 0,
      "system (%d) should be non-zero (not degraded to 0)",
    );
    // Note: not asserting assertCategoriesMatchTotal here because the
    // summary message carries real API-reported output (200) for the
    // summary generation call, which inflates the assistant category
    // beyond total — this is expected for this scenario.
  });

  it("no boundary — existing behavior unchanged", () => {
    // Regression: without any summary message, all messages contribute.
    const msgs: ContextMessageEntry[] = [
      msg("user", undefined, "First"),
      msg("assistant", { input: 100, output: 50 }, "Reply"),
    ];
    const report = computeContextReport(msgs);
    assert.equal(report.categories.user, 2);
    assert.equal(report.categories.assistant, 50);
    assert.equal(report.categories.system, 98);
    assert.equal(report.categories.misc, 0);
    assertCategoriesMatchTotal(report);
  });
});

// ---------------------------------------------------------------------------
// Dirty data — falsy elements / missing fields must never throw
// ---------------------------------------------------------------------------

describe("dirty data tolerance", () => {
  // ── findLastCompletedAssistant ────────────────────────────────────
  it("findLastCompletedAssistant skips null elements", () => {
    const msgs: ContextMessageEntry[] = [
      null as unknown as ContextMessageEntry,
      msg("user", undefined, "Hello"),
      undefined as unknown as ContextMessageEntry,
      msg("assistant", { input: 100, output: 50 }, "Response"),
      null as unknown as ContextMessageEntry,
    ];
    const result = findLastCompletedAssistant(msgs);
    assert.equal(result.index, 3);
    assert.equal(result.exactTokens, 150);
  });

  it("findLastCompletedAssistant skips entries without info", () => {
    const msgs: ContextMessageEntry[] = [
      {} as ContextMessageEntry,
      msg("assistant", { input: 200, output: 80 }, "OK"),
    ];
    const result = findLastCompletedAssistant(msgs);
    assert.equal(result.index, 1);
    assert.equal(result.exactTokens, 280);
  });

  it("findLastCompletedAssistant handles all-dirty array", () => {
    const msgs: ContextMessageEntry[] = [
      null as unknown as ContextMessageEntry,
      undefined as unknown as ContextMessageEntry,
    ];
    const result = findLastCompletedAssistant(msgs);
    assert.equal(result.index, -1);
    assert.equal(result.exactTokens, 0);
  });

  // ── estimateMessageHeuristic ──────────────────────────────────────
  it("estimateMessageHeuristic returns 0 for null message", () => {
    assert.equal(
      estimateMessageHeuristic(null as unknown as ContextMessageEntry),
      0,
    );
  });

  it("estimateMessageHeuristic returns 0 for undefined message", () => {
    assert.equal(
      estimateMessageHeuristic(undefined as unknown as ContextMessageEntry),
      0,
    );
  });

  it("estimateMessageHeuristic skips null parts elements", () => {
    const entry: ContextMessageEntry = {
      info: { role: "user", id: "m1" },
      parts: [
        { type: "text", text: "Hi" },
        null as unknown as ContextMessageEntry["parts"] extends (infer U)[]
          ? U
          : never,
        { type: "text", text: "there" },
      ] as ContextMessageEntry["parts"],
    };
    // Per-part: "Hi" ceil(2/4)=1 + "there" ceil(5/4)=2 = 3
    assert.equal(estimateMessageHeuristic(entry), 3);
  });

  // ── computeContextReport ──────────────────────────────────────────
  it("computeContextReport handles undefined elements", () => {
    const msgs: ContextMessageEntry[] = [
      undefined as unknown as ContextMessageEntry,
      msg("user", undefined, "Hello"),
      null as unknown as ContextMessageEntry,
      msg("assistant", { input: 500, output: 100 }, "Response"),
    ];
    const report = computeContextReport(msgs);
    // exact = 600, heuristic = 0
    assert.equal(report.exact, 600);
    assert.equal(report.total, 600);
    // user: "Hello" → 2
    // assistant: API exact output = 100
    assert.equal(report.categories.user, 2);
    assert.equal(report.categories.assistant, 100);
    assertCategoriesMatchTotal(report);
  });

  it("computeContextReport handles entries missing info", () => {
    const msgs: ContextMessageEntry[] = [
      { parts: [{ type: "text", text: "orphan" }] } as ContextMessageEntry,
      msg("user", undefined, "Hi"),
      msg("assistant", { input: 200, output: 60 }, "OK"),
    ];
    const report = computeContextReport(msgs);
    // exact = 260
    assert.equal(report.exact, 260);
    // user "Hi" → 1
    // assistant: API exact output = 60
    assert.equal(report.categories.user, 1);
    assert.equal(report.categories.assistant, 60);
    assertCategoriesMatchTotal(report);
  });

  it("computeContextReport handles parts array with null elements", () => {
    const msgs: ContextMessageEntry[] = [
      msg("user", undefined, "Hello"),
      {
        info: {
          role: "assistant",
          id: "a1",
          tokens: { input: 100, output: 50 },
        },
        parts: [
          { type: "text", text: "A" },
          null as unknown as ContextMessageEntry["parts"] extends (infer U)[]
            ? U
            : never,
          { type: "text", text: "B" },
        ] as ContextMessageEntry["parts"],
      },
    ];
    const report = computeContextReport(msgs);
    // exact = 150, heuristic = 0, total = 150
    // user "Hello" → 2, assistant: API exact output = 50
    assert.equal(report.categories.user, 2);
    assert.equal(report.categories.assistant, 50);
    assertCategoriesMatchTotal(report);
  });

  it("computeContextReport never throws on any input", () => {
    const cases: Array<ContextMessageEntry[] | undefined | null> = [
      [],
      [null as unknown as ContextMessageEntry],
      [undefined as unknown as ContextMessageEntry],
      [{} as ContextMessageEntry],
      [{ info: null } as unknown as ContextMessageEntry],
    ];
    for (const input of cases) {
      const report = computeContextReport(input ?? []);
      assert.ok(typeof report.total === "number");
      assert.ok(typeof report.exact === "number");
    }
  });

  // ── measureContext ────────────────────────────────────────────────
  it("measureContext handles dirty data without throwing", () => {
    const dirty: Array<ContextMessageEntry[] | undefined | null> = [
      [],
      [null as unknown as ContextMessageEntry],
      [undefined as unknown as ContextMessageEntry],
      [{} as ContextMessageEntry],
      [
        null as unknown as ContextMessageEntry,
        msg("assistant", { input: 10, output: 5 }, "x"),
      ],
    ];
    for (const msgs of dirty) {
      const result = measureContext({ messages: msgs ?? [] });
      assert.ok(typeof result.estimated_tokens === "number");
      assert.ok(typeof result.message_count === "number");
    }
  });
});

// ---------------------------------------------------------------------------
// Barrel export / shape
// ---------------------------------------------------------------------------

describe("barrel export", () => {
  it("exports findLastCompletedAssistant as a function", () => {
    assert.equal(typeof findLastCompletedAssistant, "function");
  });

  it("exports findFirstCompletedAssistant as a function", () => {
    assert.equal(typeof findFirstCompletedAssistant, "function");
  });

  it("exports estimateMessageHeuristic as a function", () => {
    assert.equal(typeof estimateMessageHeuristic, "function");
  });

  it("exports computeContextReport as a function", () => {
    assert.equal(typeof computeContextReport, "function");
  });

  it("exports measureContext as a function", () => {
    assert.equal(typeof measureContext, "function");
  });
});

describe("ContextReport shape", () => {
  it("has all required fields", () => {
    const report = computeContextReport([]);
    assert.ok("total" in report);
    assert.ok("exact" in report);
    assert.ok("heuristic" in report);
    assert.ok("messageCount" in report);
    assert.ok("cacheHitRate" in report);
    assert.ok("categories" in report);
    assert.ok("user" in report.categories);
    assert.ok("assistant" in report.categories);
    assert.ok("tool" in report.categories);
    assert.ok("system" in report.categories);
    assert.ok("misc" in report.categories);
  });
});

// ---------------------------------------------------------------------------
// computeCacheTrend
// ---------------------------------------------------------------------------

describe("computeCacheTrend", () => {
  it("returns up trend when the last assistant has a higher hit rate", () => {
    // previous: read 200 / (input 500 + read 200 + write 50) = 200/750 ≈ 0.2667
    // last:     read 300 / (input 300 + read 300 + write 50) = 300/650 ≈ 0.4615
    // trend: (0.4615 - 0.2667) * 100 ≈ +19.5 percentage points
    const msgs: ContextMessageEntry[] = [
      msg("user", undefined, "First"),
      msg(
        "assistant",
        { input: 500, output: 100, cache: { read: 200, write: 50 } },
        "Reply A",
      ),
      msg("user", undefined, "Follow-up"),
      msg(
        "assistant",
        { input: 300, output: 80, cache: { read: 300, write: 50 } },
        "Reply B",
      ),
    ];
    const result = computeCacheTrend(msgs);
    assert.ok(result.hasTrendData);
    assert.ok(result.trend !== null);
    assert.ok(result.trend > 0, `expected positive trend, got ${result.trend}`);
    assert.ok(
      result.trendLabel?.startsWith("↑"),
      `expected ↑ prefix, got ${result.trendLabel}`,
    );
    assert.ok(
      result.trendLabel?.endsWith("%"),
      `expected % suffix, got ${result.trendLabel}`,
    );
    // Approximately 15–25 percentage points
    assert.ok(
      result.trend > 15 && result.trend < 25,
      `trend ${result.trend} out of expected range`,
    );
  });

  it("returns down trend when the last assistant has a lower hit rate", () => {
    // previous: read 300 / (input 300 + read 300 + write 50) = 300/650 ≈ 0.4615
    // last:     read 200 / (input 500 + read 200 + write 50) = 200/750 ≈ 0.2667
    // trend: (0.2667 - 0.4615) * 100 ≈ -19.5 percentage points
    const msgs: ContextMessageEntry[] = [
      msg("user", undefined, "First"),
      msg(
        "assistant",
        { input: 300, output: 80, cache: { read: 300, write: 50 } },
        "Reply A",
      ),
      msg("user", undefined, "Follow-up"),
      msg(
        "assistant",
        { input: 500, output: 100, cache: { read: 200, write: 50 } },
        "Reply B",
      ),
    ];
    const result = computeCacheTrend(msgs);
    assert.ok(result.hasTrendData);
    assert.ok(result.trend !== null);
    assert.ok(result.trend < 0, `expected negative trend, got ${result.trend}`);
    assert.ok(
      result.trendLabel?.startsWith("↓"),
      `expected ↓ prefix, got ${result.trendLabel}`,
    );
    assert.ok(
      result.trendLabel?.endsWith("%"),
      `expected % suffix, got ${result.trendLabel}`,
    );
  });

  it("returns no trend data when only one assistant message exists", () => {
    const msgs: ContextMessageEntry[] = [
      msg("user", undefined, "Hello"),
      msg(
        "assistant",
        { input: 500, output: 100, cache: { read: 200 } },
        "Reply",
      ),
    ];
    const result = computeCacheTrend(msgs);
    assert.equal(result.hasTrendData, false);
    assert.equal(result.trend, null);
    assert.equal(result.trendLabel, null);
    assert.ok(result.lastRate !== null, "lastRate should still be available");
    assert.equal(result.previousRate, null);
  });

  it("returns no trend data when no assistant has valid token data", () => {
    const msgs: ContextMessageEntry[] = [
      msg("user", undefined, "Hello"),
      msg("assistant", undefined, "No tokens"),
      msg("user", undefined, "Again"),
      msg(
        "assistant",
        { input: 0, output: 0, cache: { read: 0, write: 0 } },
        "Zero tokens",
      ),
    ];
    const result = computeCacheTrend(msgs);
    assert.equal(result.hasTrendData, false);
    assert.equal(result.lastRate, null);
    assert.equal(result.previousRate, null);
  });

  it("returns dash label when trend is exactly zero", () => {
    // Both messages have identical cache rates
    const msgs: ContextMessageEntry[] = [
      msg("user", undefined, "First"),
      msg(
        "assistant",
        { input: 500, output: 100, cache: { read: 200, write: 50 } },
        "Reply A",
      ),
      msg("user", undefined, "Follow-up"),
      msg(
        "assistant",
        { input: 500, output: 100, cache: { read: 200, write: 50 } },
        "Reply B",
      ),
    ];
    const result = computeCacheTrend(msgs);
    assert.ok(result.hasTrendData);
    assert.equal(result.trend, 0);
    assert.equal(result.trendLabel, "-");
  });

  it("returns no trend data for empty messages array", () => {
    const result = computeCacheTrend([]);
    assert.equal(result.hasTrendData, false);
    assert.equal(result.lastRate, null);
    assert.equal(result.previousRate, null);
    assert.equal(result.trend, null);
    assert.equal(result.trendLabel, null);
  });

  it("skips assistants with zero denominator when computing trend", () => {
    // Zero-denominator assistant should be skipped
    const msgs: ContextMessageEntry[] = [
      msg("user", undefined, "First"),
      msg(
        "assistant",
        { input: 500, output: 100, cache: { read: 200, write: 50 } },
        "Reply A",
      ),
      msg("user", undefined, "Zero-denom"),
      msg(
        "assistant",
        { input: 0, output: 0, cache: { read: 0, write: 0 } },
        "Zero",
      ),
      msg("user", undefined, "Follow-up"),
      msg(
        "assistant",
        { input: 300, output: 80, cache: { read: 300, write: 50 } },
        "Reply B",
      ),
    ];
    const result = computeCacheTrend(msgs);
    assert.ok(result.hasTrendData);
    assert.ok(
      result.trendLabel !== null,
      "should have trend data despite zero-denom assistant interleaved",
    );
  });

  it("trend uses cache.write in denominator matching ZooKeeper convention", () => {
    // Same rate but one has write tokens — in reference convention they'd differ
    // Our convention: read / (input + read + write)
    const msgs: ContextMessageEntry[] = [
      msg("user", undefined, "First"),
      msg(
        "assistant",
        { input: 100, output: 50, cache: { read: 50, write: 0 } },
        "No write",
      ),
      msg("user", undefined, "Follow-up"),
      msg(
        "assistant",
        { input: 100, output: 50, cache: { read: 50, write: 50 } },
        "With write",
      ),
    ];
    const result = computeCacheTrend(msgs);
    assert.ok(result.hasTrendData);
    // No write: 50/(100+50+0)=0.333, With write: 50/(100+50+50)=0.25 → down
    assert.ok(
      (result.trend as number) < 0,
      "adding write tokens should decrease hit rate",
    );
  });

  it("ignores non-assistant messages even if they carry token data", () => {
    // A "tool" role message with tokens must not be counted as an assistant.
    const msgs: ContextMessageEntry[] = [
      msg("user", undefined, "Hello"),
      msg(
        "assistant",
        { input: 500, output: 100, cache: { read: 200, write: 50 } },
        "Reply A",
      ),
      msg("user", undefined, "Mid"),
      // Non-assistant with token data — should be ignored.
      {
        info: {
          role: "tool",
          id: "t1",
          tokens: { input: 999, output: 50, cache: { read: 500 } },
        },
        parts: [{ type: "text", text: "tool output" }],
      },
      msg("user", undefined, "Follow-up"),
      msg(
        "assistant",
        { input: 300, output: 80, cache: { read: 300, write: 50 } },
        "Reply B",
      ),
    ];
    const result = computeCacheTrend(msgs);
    assert.ok(result.hasTrendData);
    // If the tool message were counted, there would be 3 valid entries
    // and previousRate would be the tool's rate (500/1499 ≈ 0.334) instead
    // of Reply A's rate (200/750 ≈ 0.267).  Verify the actual trend
    // matches the assistants-only expectation.
    // Reply A: 200/750 ≈ 0.2667, Reply B: 300/650 ≈ 0.4615 → trend up
    assert.ok(
      (result.trend as number) > 0,
      "trend should be up (non-assistant ignored)",
    );
    assert.equal(
      result.lastRate,
      300 / (300 + 300 + 50),
      "last rate should be from Reply B",
    );
    assert.equal(
      result.previousRate,
      200 / (500 + 200 + 50),
      "previous rate should be from Reply A, not the tool message",
    );
  });
});

// ---------------------------------------------------------------------------
// computeCumulativeCacheRate
// ---------------------------------------------------------------------------

describe("computeCumulativeCacheRate", () => {
  it("sums across all assistant messages", () => {
    // msg1: input 500, read 200, write 50
    // msg2: input 300, read 100, write 20
    // total input=800, total read=300, total write=70
    // denominator: 800+300+70 = 1170
    // rate: 300 / 1170 ≈ 0.2564
    const msgs: ContextMessageEntry[] = [
      msg("user", undefined, "First"),
      msg("assistant", {
        input: 500,
        output: 100,
        cache: { read: 200, write: 50 },
      }),
      msg("user", undefined, "Second"),
      msg("assistant", {
        input: 300,
        output: 80,
        cache: { read: 100, write: 20 },
      }),
    ];
    const result = computeCumulativeCacheRate(msgs);
    assert.ok(result.cumulativeRate !== null);
    assert.equal(result.totalRead, 300);
    assert.equal(result.totalDenominator, 1170);
    assert.equal(Math.round(result.cumulativeRate * 1000), 256);
  });

  it("returns null when no assistant has tokens", () => {
    const msgs: ContextMessageEntry[] = [
      msg("user", undefined, "Hello"),
      msg("assistant", undefined, "No tokens"),
    ];
    const result = computeCumulativeCacheRate(msgs);
    assert.equal(result.cumulativeRate, null);
    assert.equal(result.totalRead, 0);
    assert.equal(result.totalDenominator, 0);
  });

  it("returns null when all tokens are zero", () => {
    const msgs: ContextMessageEntry[] = [
      msg("user", undefined, "Hi"),
      msg("assistant", { input: 0, output: 0, cache: { read: 0, write: 0 } }),
    ];
    const result = computeCumulativeCacheRate(msgs);
    assert.equal(result.cumulativeRate, null);
  });

  it("returns null for empty messages array", () => {
    const result = computeCumulativeCacheRate([]);
    assert.equal(result.cumulativeRate, null);
    assert.equal(result.totalRead, 0);
    assert.equal(result.totalDenominator, 0);
  });

  it("includes all assistants even if interleaved with non-token messages", () => {
    const msgs: ContextMessageEntry[] = [
      msg("user", undefined, "First"),
      msg("assistant", { input: 400, output: 80, cache: { read: 160 } }, "A"),
      msg("user", undefined, "Mid"),
      msg("assistant", undefined, "No tokens"),
      msg("user", undefined, "Another"),
      msg("assistant", { input: 200, output: 60, cache: { read: 80 } }, "B"),
    ];
    const result = computeCumulativeCacheRate(msgs);
    assert.ok(result.cumulativeRate !== null);
    // read: 160+80=240, input: 400+200=600
    // denominator = 600+240+0 = 840
    assert.equal(result.totalRead, 240);
    assert.equal(result.totalDenominator, 840);
  });

  it("follows ZooKeeper denominator convention including cache.write", () => {
    const msgs: ContextMessageEntry[] = [
      msg("user", undefined, "Hi"),
      msg("assistant", {
        input: 500,
        output: 100,
        cache: { read: 200, write: 50 },
      }),
      msg("user", undefined, "Again"),
      msg("assistant", {
        input: 300,
        output: 80,
        cache: { read: 100, write: 30 },
      }),
    ];
    const result = computeCumulativeCacheRate(msgs);
    assert.ok(result.cumulativeRate !== null);
    // input: 800, read: 300, write: 80
    // denominator: 800+300+80 = 1180
    // rate: 300/1180 ≈ 0.2542
    assert.equal(result.totalDenominator, 1180);
    assert.ok(result.cumulativeRate < 0.3, "write tokens reduce the rate");
  });
});

// ---------------------------------------------------------------------------
// computeTokenBreakdown
// ---------------------------------------------------------------------------

describe("computeTokenBreakdown", () => {
  it("sums cache.read, input, and output across assistant messages", () => {
    const msgs: ContextMessageEntry[] = [
      msg("user", undefined, "Hello"),
      msg("assistant", {
        input: 500,
        output: 100,
        cache: { read: 200 },
      }),
      msg("user", undefined, "Follow-up"),
      msg("assistant", {
        input: 300,
        output: 80,
        cache: { read: 100, write: 20 },
      }),
    ];
    const result = computeTokenBreakdown(msgs);
    // cacheRead: 200 + 100 = 300
    // input: 500 + 300 = 800
    // output: 100 + 80 = 180
    // total: 300 + 800 + 180 = 1280
    assert.equal(result.cacheRead, 300);
    assert.equal(result.input, 800);
    assert.equal(result.output, 180);
    assert.equal(result.total, 1280);
  });

  it("ignores non-assistant roles even if they carry token data", () => {
    const msgs: ContextMessageEntry[] = [
      msg("user", undefined, "Hello"),
      msg("assistant", { input: 400, output: 60, cache: { read: 150 } }),
      // Tool role with token data — should be ignored.
      {
        info: {
          role: "tool",
          id: "t1",
          tokens: { input: 999, output: 50, cache: { read: 500 } },
        },
        parts: [{ type: "text", text: "tool output" }],
      },
      msg("assistant", { input: 200, output: 40, cache: { read: 80 } }),
    ];
    const result = computeTokenBreakdown(msgs);
    // cacheRead: 150 + 80 = 230
    // input: 400 + 200 = 600
    // output: 60 + 40 = 100
    // total: 230 + 600 + 100 = 930
    assert.equal(result.cacheRead, 230);
    assert.equal(result.input, 600);
    assert.equal(result.output, 100);
    assert.equal(result.total, 930);
  });

  it("returns zeros when no assistant has tokens", () => {
    const msgs: ContextMessageEntry[] = [
      msg("user", undefined, "Hello"),
      msg("assistant", undefined, "No tokens"),
    ];
    const result = computeTokenBreakdown(msgs);
    assert.equal(result.cacheRead, 0);
    assert.equal(result.input, 0);
    assert.equal(result.output, 0);
    assert.equal(result.total, 0);
  });

  it("handles missing token fields gracefully", () => {
    const msgs: ContextMessageEntry[] = [
      msg("user", undefined, "Hi"),
      msg("assistant", { input: 100, output: 50 }),
    ];
    const result = computeTokenBreakdown(msgs);
    // cacheRead defaults to 0 when cache field is missing
    assert.equal(result.cacheRead, 0);
    assert.equal(result.input, 100);
    assert.equal(result.output, 50);
    assert.equal(result.total, 150);
  });

  it("handles zero token fields", () => {
    const msgs: ContextMessageEntry[] = [
      msg("user", undefined, "Hi"),
      msg("assistant", { input: 0, output: 0, cache: { read: 0 } }),
    ];
    const result = computeTokenBreakdown(msgs);
    assert.equal(result.cacheRead, 0);
    assert.equal(result.input, 0);
    assert.equal(result.output, 0);
    assert.equal(result.total, 0);
  });

  it("returns zeros for empty messages array", () => {
    const result = computeTokenBreakdown([]);
    assert.equal(result.cacheRead, 0);
    assert.equal(result.input, 0);
    assert.equal(result.output, 0);
    assert.equal(result.total, 0);
  });
});

describe("computeAssistantCacheRate", () => {
  it("computes correct rate including cache.write in denominator", () => {
    // rate = read / (input + read + write) = 200 / (500 + 200 + 50) = 200/750 ≈ 0.2667
    const entry = msg("assistant", {
      input: 500,
      output: 100,
      cache: { read: 200, write: 50 },
    });
    const result = computeAssistantCacheRate(entry);
    assert.ok(result !== null);
    assert.equal(Math.round(result * 10000), 2667);
  });

  it("returns null when tokens are missing", () => {
    const entry = msg("assistant", undefined);
    const result = computeAssistantCacheRate(entry);
    assert.equal(result, null);
  });

  it("returns null when all tokens are zero", () => {
    const entry = msg("assistant", {
      input: 0,
      output: 0,
      cache: { read: 0, write: 0 },
    });
    const result = computeAssistantCacheRate(entry);
    assert.equal(result, null);
  });
});

// ---------------------------------------------------------------------------
// Barrel export
// ---------------------------------------------------------------------------
