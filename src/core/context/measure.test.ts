/**
 * Tests for the lens-based context measurement module (`measure.ts`).
 *
 * Covers: the CJK-aware token estimator, per-message and whole-session
 * heuristic measurement, usage-exact precedence, hidden-message skipping,
 * thinking inclusion, the pruned-output adjustment, and net reclaim.
 *
 * The v1-shape parsing counterparts (parts arrays, nested cache token
 * reports) are the adapter's responsibility and are tested in the
 * OpenCode adapter's `history.test.ts` and `types.test.ts`; this
 * module only tests the core functions with `HostMessage` inputs.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { HostMessage, TextRegion } from "./lens.js";
import { makeAssistantMsg, makeMsg, makeToolMsg } from "./lens-testkit.js";
import {
  estimateMessageHeuristic,
  estimateTokenCount,
  findLastCompletedAssistant,
  measureMessages,
  netReclaimTokens,
} from "./measure.js";
import { PRUNED_TOOL_OUTPUT_REPLACEMENT } from "./message-parts.js";

// ---------------------------------------------------------------------------
// Per-message heuristic
// ---------------------------------------------------------------------------

describe("estimateMessageHeuristic (lens)", () => {
  it("pure ASCII text", () => {
    const lens = makeMsg("user", ["Hello World"]);
    assert.equal(estimateMessageHeuristic(lens), 3); // ceil(11/4)
  });

  it("CJK mixed text (ideographs, punctuation, fullwidth)", () => {
    const lens = makeMsg("user", ["你好 world", "，。ＡＢ"]);
    // "你好 world": 2 CJK + 6 ASCII → ceil(2/1.5 + 6/4) = ceil(2.83) = 3
    // "，。ＡＢ": 4 CJK → ceil(4/1.5) = ceil(2.67) = 3
    assert.equal(estimateMessageHeuristic(lens), 6);
  });

  it("thinking region", () => {
    const lens = makeAssistantMsg({ thinking: "reasoning trace" });
    assert.equal(estimateMessageHeuristic(lens), 4); // ceil(15/4)
  });

  it("tool input/output with object input JSON serialization", () => {
    const lens = makeToolMsg("bash", '{"cmd":"ls"}', '{"stdout":"file1\\n"}');
    // input JSON '{"cmd":"ls"}' → ceil(12/4) = 3
    // output JSON '{"stdout":"file1\\n"}' → ceil(20/4) = 5
    assert.equal(estimateMessageHeuristic(lens), 8);
  });

  it("dirty message: empty regions / null regions", () => {
    const lensEmpty = makeMsg("user", []);
    assert.equal(estimateMessageHeuristic(lensEmpty), 0);

    const lensDirty: HostMessage = {
      role: "user",
      hidden: false,
      regions: [
        null as unknown as TextRegion,
        makeMsg("user", ["Hi"]).regions[0],
      ],
    };
    assert.equal(estimateMessageHeuristic(lensDirty), 1); // ceil(2/4)
  });
});

// ---------------------------------------------------------------------------
// estimateTokenCount — plain-string estimator
// ---------------------------------------------------------------------------

describe("estimateTokenCount", () => {
  it("estimates nullish, empty, JSON, and CJK values", () => {
    assert.equal(estimateTokenCount(null), 0);
    assert.equal(estimateTokenCount(undefined), 0);
    assert.equal(estimateTokenCount(""), 0);
    // independent literals
    assert.equal(estimateTokenCount({ foo: "bar" }), 4); // '{"foo":"bar"}' → ceil(13/4)
    assert.equal(estimateTokenCount("你好世界今日天气"), 6); // ceil(8/1.5)
  });
});

// ---------------------------------------------------------------------------
// Whole-session measurement
// ---------------------------------------------------------------------------

describe("measureMessages", () => {
  it("usage-exact precedence: exact from the last completed assistant", () => {
    const lensMessages = [
      makeMsg("user", ["Hello"]),
      makeMsg("assistant", ["Response"], {
        usage: {
          input: 500,
          output: 100,
          reasoning: 50,
          cacheRead: 200,
          cacheWrite: 50,
        },
      }),
      makeMsg("user", ["Follow-up text here"]),
    ];
    const measured = measureMessages(lensMessages);
    assert.equal(measured.exact, 900); // 500+100+50+200+50
    assert.equal(measured.heuristic, 5); // ceil(19/4)
    assert.equal(measured.total, 905);
    assert.equal(measured.messageCount, 3);
  });

  it("hidden messages are skipped like the adapter's ignored messages", () => {
    const lensMessages = [
      makeMsg("user", ["Hello"]),
      makeMsg("assistant", ["Response"], {
        usage: { input: 500, output: 100 },
      }),
      makeMsg("user", ["Ignored /dcp context report"], { hidden: true }),
      makeMsg("user", ["Normal follow-up"]),
    ];
    const measured = measureMessages(lensMessages);
    assert.equal(measured.exact, 600);
    assert.equal(measured.heuristic, 4); // ceil(16/4)
    assert.equal(measured.total, 604);
    assert.equal(measured.messageCount, 3);
  });

  it("empty transcript yields zeros", () => {
    const measured = measureMessages([]);
    assert.deepEqual(measured, {
      exact: 0,
      heuristic: 0,
      total: 0,
      messageCount: 0,
    });
  });

  it("nullish transcript input yields zeros", () => {
    assert.deepEqual(measureMessages(undefined), {
      exact: 0,
      heuristic: 0,
      total: 0,
      messageCount: 0,
    });
    assert.deepEqual(measureMessages(null), {
      exact: 0,
      heuristic: 0,
      total: 0,
      messageCount: 0,
    });
  });

  it("dirty transcript: null entries are skipped defensively", () => {
    const lensMessages = [
      null as unknown as HostMessage,
      makeMsg("user", ["Hi"]),
      undefined as unknown as HostMessage,
      makeMsg("assistant", ["OK"], { usage: { input: 100, output: 50 } }),
      null as unknown as HostMessage,
    ];
    const measured = measureMessages(lensMessages);
    assert.equal(measured.exact, 150);
    assert.equal(measured.heuristic, 0);
    assert.equal(measured.total, 150);
    assert.equal(measured.messageCount, 5);
  });
});

// ---------------------------------------------------------------------------
// findLastCompletedAssistant
// ---------------------------------------------------------------------------

describe("findLastCompletedAssistant", () => {
  it("finds the last assistant with usage.output > 0 and sums all five fields", () => {
    const messages = [
      makeMsg("user", ["Hello"]),
      makeMsg("assistant", ["First"], { usage: { input: 100, output: 50 } }),
      makeMsg("user", ["Follow-up"]),
      makeMsg("assistant", ["Second"], {
        usage: {
          input: 200,
          output: 80,
          reasoning: 10,
          cacheRead: 5,
          cacheWrite: 5,
        },
      }),
    ];
    const result = findLastCompletedAssistant(messages);
    assert.equal(result.index, 3);
    assert.equal(result.exactTokens, 300); // 200+80+10+5+5
  });

  it("returns -1 when no completed assistant exists", () => {
    assert.equal(findLastCompletedAssistant([]).index, -1);
    assert.equal(
      findLastCompletedAssistant([makeMsg("user", ["Hi"])]).index,
      -1,
    );
    assert.equal(
      findLastCompletedAssistant([
        makeMsg("assistant", ["Streaming"], { usage: { output: 0 } }),
      ]).index,
      -1,
    );
    assert.equal(
      findLastCompletedAssistant([makeMsg("assistant", ["No tokens"])]).index,
      -1,
    );
  });
});

// ---------------------------------------------------------------------------
// Standalone behavior
// ---------------------------------------------------------------------------

describe("usage-exact precedence", () => {
  it("skips a streaming assistant (usage.output = 0) and estimates heuristically", () => {
    const messages = [
      makeMsg("user", ["Hello"]),
      makeMsg("assistant", ["Still streaming"], {
        usage: { input: 500, output: 0 },
      }),
    ];
    const measured = measureMessages(messages);
    assert.equal(measured.exact, 0);
    // "Hello" ceil(5/4) = 2 + "Still streaming" ceil(15/4) = 4
    assert.equal(measured.heuristic, 6);
    assert.equal(measured.total, 6);
  });
});

describe("hidden messages", () => {
  it("contribute 0 to the heuristic and are skipped", () => {
    assert.equal(
      estimateMessageHeuristic(makeMsg("user", ["Hello"], { hidden: true })),
      0,
    );
    assert.equal(
      estimateMessageHeuristic(makeAssistantMsg({ text: "x", hidden: true })),
      0,
    );
  });
});

describe("thinking regions", () => {
  it("are counted by the heuristic", () => {
    const msg = makeAssistantMsg({
      text: "hi",
      thinking: "reasoning trace",
      toolCalls: [{ name: "bash", input: "cmd", output: "out" }],
    });
    // "hi" 1 + thinking 4 + "cmd" 1 + "out" 1 = 7
    assert.equal(estimateMessageHeuristic(msg), 7);
  });
});

describe("pruned tool-output adjustment", () => {
  it("pruned tool-output regions contribute input + placeholder", () => {
    const msg = makeToolMsg("bash", "echo pruned", "pruned output\n");
    const pruned = estimateMessageHeuristic(
      msg,
      (r) => r.kind === "tool-output",
    );
    // input ceil(11/4) = 3 + placeholder (77 chars) → 20
    assert.equal(pruned, 23);
    // without the predicate the output text is counted instead
    assert.equal(estimateMessageHeuristic(msg), 7); // 3 + ceil(14/4) = 4
  });

  it("the predicate only affects tool-output regions", () => {
    const msg = makeAssistantMsg({
      text: "hi",
      thinking: "th",
      toolCalls: [{ name: "bash", input: "cmd", output: "out" }],
    });
    // The predicate matches both tool regions (shared tool metadata), but
    // only the tool-output region is replaced by the placeholder estimate.
    const pruned = estimateMessageHeuristic(
      msg,
      (r) => r.tool?.name === "bash",
    );
    // "hi" 1 + "th" 1 + input "cmd" 1 + placeholder 20 = 23
    assert.equal(pruned, 23);
  });
});

describe("netReclaimTokens", () => {
  it("returns positive when content exceeds the placeholder", () => {
    // 200 ASCII chars → ceil(200/4) = 50; placeholder → 20
    assert.equal(
      netReclaimTokens("x".repeat(200), PRUNED_TOOL_OUTPUT_REPLACEMENT),
      30,
    );
  });

  it("clamps to 0 when the content is shorter than the placeholder", () => {
    assert.equal(netReclaimTokens("short", PRUNED_TOOL_OUTPUT_REPLACEMENT), 0);
    assert.equal(netReclaimTokens("", PRUNED_TOOL_OUTPUT_REPLACEMENT), 0);
  });

  it("treats nullish content as 0 tokens", () => {
    assert.equal(netReclaimTokens(null, PRUNED_TOOL_OUTPUT_REPLACEMENT), 0);
    assert.equal(
      netReclaimTokens(undefined, PRUNED_TOOL_OUTPUT_REPLACEMENT),
      0,
    );
  });

  it("estimates non-string content via JSON serialization", () => {
    // '{"content":"xxx…200…"}' → 214 chars → ceil(214/4) = 54; placeholder → 20
    assert.equal(
      netReclaimTokens(
        { content: "x".repeat(200) },
        PRUNED_TOOL_OUTPUT_REPLACEMENT,
      ),
      34,
    );
  });
});
