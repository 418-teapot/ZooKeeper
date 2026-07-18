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
  computeContextReport,
  estimateMessageHeuristic,
  findFirstCompletedAssistant,
  findLastCompletedAssistant,
  measureContext,
} from "./metrics.js";

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
 * Assert that the category breakdown sums to total exactly.
 */
function assertCategoriesMatchTotal(report: ContextReport): void {
  const c = report.categories;
  const catSum = c.user + c.assistant + c.tool + c.system + c.misc;
  assert.equal(
    catSum,
    report.total,
    `category sum ${catSum} !== total ${report.total}`,
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
    assert.equal(report.categories.user, 3);
    assert.equal(report.categories.tool, 5);
    // asst = 50 (API exact output)
    assert.equal(report.categories.assistant, 50);
    // system = first asst (input 100) − first user heuristic 3 = 97
    assert.equal(report.categories.system, 97);
    // total = 150; categories sum 3+50+5+97+0 = 155 > 150.
    // Categories can overshoot total when tool heuristic (5) overlaps
    // with the API-reported input; misc clamps to 0.
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
    assert.equal(report.categories.tool, 15);
    assert.equal(report.categories.user, 1);
    // asst = 100 (API exact output)
    assert.equal(report.categories.assistant, 100);
    // system = first asst (input 500) − first user heuristic 1 = 499
    assert.equal(report.categories.system, 499);
    // total = 600; categories sum 1+100+15+499+0 = 615 > 600.
    // Tool heuristic overlaps with API-reported input; misc clamps to 0.
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
    // system = first asst (input 200) − first user heuristic 2 = 198
    assert.equal(report.categories.system, 198);
    // misc = 250 − 2 − 50 − 0 − 198 = 0
    assert.equal(report.categories.misc, 0);
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

  it("sets system to 0 when no user message exists", () => {
    const msgs: ContextMessageEntry[] = [
      msg("assistant", { input: 500, output: 100 }, "Direct response"),
    ];
    const report = computeContextReport(msgs);
    assert.equal(report.categories.system, 0);
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
