/**
 * Tests for the ordinal-based compression core (`compress.ts`).
 *
 * Covers the P1.10 acceptance contract: the combined protection window
 * (message-count and token-budget dimensions), endpoint resolution via
 * line refs (original / summary / reversed-swap / actionable errors with
 * the covered-content hint), every validation gate with one positive and
 * one negative case each (protection zone, first user, overlap, swallow,
 * phantom), the apply-time gates (no-new-content, negative benefit),
 * block creation with spanHash self-validation, pending-mark token
 * accounting via `clearConsumedBlockRange`, batch semantics (three-range
 * batch, same-snapshot validation, cross-range rules, atomicity,
 * maxRanges, title rules), and end-to-end gate-decision pins over the
 * same ordinal inputs once compared against the legacy implementation.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  type CompressOptions,
  type CompressRangeInput,
  compressRanges,
  computeProtectedStartOrdinal,
  resolveSpan,
  SUPERSEDED_BLOCKS_LEAD_IN,
  validateRange,
} from "./compress.js";
import { fold } from "./fold.js";
import type { HostMessage, TextRegion, ToolOutputRef } from "./lens.js";
import { makeAssistantMsg, makeMsg } from "./lens-testkit.js";
import { estimateMessageHeuristic } from "./measure.js";
import { computeSpanHash, validateBlock } from "./spanhash.js";
import type { Block, Mark, SessionState } from "./state.js";
import { markKey } from "./state.js";
import type { NumberedItem } from "./view-refs.js";
import { numberView } from "./view-refs.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A fresh empty session state. */
function makeState(): SessionState {
  return { blocks: new Map(), marks: new Map() };
}

/** A mark fixture; defaults to a pending mark over a tool-output region. */
function makeMark(overrides: Partial<Mark> = {}): Mark {
  return {
    anchorOrdinal: 0,
    content: "tool output",
    contentTokens: 50,
    effective: false,
    markedAt: 2000,
    ...overrides,
  };
}

/**
 * Alternating user/assistant text messages.
 *
 * User messages ("prompt N " + 60 chars) estimate to 18 heuristic tokens,
 * assistant ones ("reply N " + 60 chars) to 17.  A 10-message transcript
 * has its last non-hidden user at ordinal 8.
 */
function makeTranscript(count: number): HostMessage[] {
  const msgs: HostMessage[] = [];
  for (let i = 0; i < count; i++) {
    msgs.push(
      i % 2 === 0
        ? makeMsg("user", [`prompt ${i} ${"x".repeat(60)}`])
        : makeAssistantMsg({ text: `reply ${i} ${"x".repeat(60)}` }),
    );
  }
  return msgs;
}

/** An active block over `[start, end)` with the current span hash. */
function makeBlock(
  history: HostMessage[],
  start: number,
  end: number,
  overrides: Partial<Block> = {},
): Block {
  return {
    start,
    end,
    summary: `summary [${start}, ${end})`,
    spanHash: computeSpanHash(history, start, end),
    active: true,
    compressedTokens: 100,
    summaryTokens: 10,
    createdAt: 1000,
    ...overrides,
  };
}

/** Number the folded view of the state, skipping hidden messages. */
function numberedView(
  history: HostMessage[],
  state: SessionState,
): NumberedItem[] {
  const { items } = fold(history, state);
  return numberView(items, (ordinal) => history[ordinal].hidden);
}

/** Line ref of the visible original item at the ordinal, or null. */
function ordinalLine(items: NumberedItem[], ordinal: number): string | null {
  const entry = items.find(
    (item) => item.item.type === "original" && item.item.ordinal === ordinal,
  );
  return entry === undefined ? null : `m${entry.n}`;
}

/** Line number of the first summary item, or null when none exists. */
function summaryLineOf(items: NumberedItem[]): number | null {
  const entry = items.find((item) => item.item.type === "summary");
  return entry === undefined ? null : entry.n;
}

/**
 * Compress the inclusive ordinal interval `[fromOrdinal, toOrdinal]`.
 *
 * Both ordinals must be visible in the current view (never covered by an
 * active block).
 */
function compressRange(
  history: HostMessage[],
  items: NumberedItem[],
  state: SessionState,
  fromOrdinal: number,
  toOrdinal: number,
  title: string,
  summary: string,
  options: CompressOptions = OPTIONS,
) {
  const fromRef = ordinalLine(items, fromOrdinal);
  const toRef = ordinalLine(items, toOrdinal);
  assert.ok(fromRef !== null, `ordinal ${fromOrdinal} must be visible`);
  assert.ok(toRef !== null, `ordinal ${toOrdinal} must be visible`);
  return compressRanges(history, items, state, options, [
    { fromRef, toRef, title, summary },
  ]);
}

/**
 * Gate config for the standard transcript: protection boundary 8 with a
 * 10-message history, phantom threshold well below a 4-message segment.
 */
const OPTIONS: CompressOptions = {
  protectedMessages: 2,
  protectedTokens: 30,
  thresholdTokens: 20,
};

// ---------------------------------------------------------------------------
// 1. Protection window — message-count and token-budget dimensions
// ---------------------------------------------------------------------------

describe("computeProtectedStartOrdinal", () => {
  it("counts back protectedMessages non-hidden messages", () => {
    const history = makeTranscript(6);
    assert.equal(computeProtectedStartOrdinal(history, 2, 0), 4);
  });

  it("accumulates protectedTokens from the end", () => {
    // ~10 tokens per message; a 16-token budget covers the last two.
    const history = [
      makeMsg("user", ["x".repeat(40)]),
      makeAssistantMsg({ text: "x".repeat(40) }),
      makeMsg("user", ["x".repeat(40)]),
      makeAssistantMsg({ text: "x".repeat(40) }),
    ];
    assert.equal(computeProtectedStartOrdinal(history, 0, 16), 2);
  });

  it("skips hidden messages in the message-count window", () => {
    const history = [
      makeMsg("user", ["x".repeat(40)]),
      makeAssistantMsg({ text: "x".repeat(40) }),
      makeMsg("user", ["x".repeat(40)]),
      makeAssistantMsg({ text: "x".repeat(40) }),
      makeMsg("user", ["injected report"], { hidden: true }),
      makeMsg("user", ["injected report"], { hidden: true }),
    ];
    assert.equal(computeProtectedStartOrdinal(history, 2, 0), 2);
  });

  it("skips hidden messages in the token window", () => {
    const history = [
      makeMsg("user", ["x".repeat(40)]),
      makeAssistantMsg({ text: "x".repeat(40) }),
      makeMsg("user", ["x".repeat(40)]),
      makeAssistantMsg({ text: "x".repeat(40) }),
      makeMsg("user", ["x".repeat(100)], { hidden: true }),
      makeMsg("user", ["x".repeat(100)], { hidden: true }),
    ];
    assert.equal(computeProtectedStartOrdinal(history, 0, 16), 2);
  });

  it("unions both windows at the earlier boundary", () => {
    const history = [
      makeMsg("user", ["x".repeat(40)]),
      makeAssistantMsg({ text: "x".repeat(40) }),
      makeMsg("user", ["x".repeat(40)]),
      makeAssistantMsg({ text: "x".repeat(40) }),
    ];
    // Count window starts at 3 (1 message), token window at 2 → union 2.
    assert.equal(computeProtectedStartOrdinal(history, 1, 16), 2);
  });

  it("returns history.length when both windows are disabled", () => {
    const history = makeTranscript(4);
    assert.equal(computeProtectedStartOrdinal(history, 0, 0), 4);
  });

  it("returns 0 when the budget covers the whole session", () => {
    const history = [makeMsg("user", ["hi"]), makeAssistantMsg({ text: "yo" })];
    assert.equal(computeProtectedStartOrdinal(history, 10, 1_000_000), 0);
  });
});

// ---------------------------------------------------------------------------
// 2. resolveSpan — endpoint resolution gate (C7-07 / C2-10)
// ---------------------------------------------------------------------------

describe("resolveSpan — endpoint resolution", () => {
  it("resolves original line refs to ordinal intervals", () => {
    const history = makeTranscript(6);
    const state = makeState();
    const items = numberedView(history, state);
    assert.deepEqual(resolveSpan(items, state, "m2", "m5"), {
      start: 1,
      end: 5,
    });
  });

  it("rejects a reversed pair of refs with an order error", () => {
    const history = makeTranscript(6);
    const state = makeState();
    const items = numberedView(history, state);
    const result = resolveSpan(items, state, "m5", "m2");
    assert.ok("error" in result);
    assert.ok(result.error.includes("顺序颠倒"));
    assert.ok(result.error.includes("m5"));
    assert.ok(result.error.includes("m2"));
    // The forward order resolves to the union interval.
    assert.deepEqual(resolveSpan(items, state, "m2", "m5"), {
      start: 1,
      end: 5,
    });
  });

  it("covers the whole block when an endpoint lands on a summary item", () => {
    const history = makeTranscript(8);
    const state = makeState();
    state.blocks.set(1, makeBlock(history, 2, 6));
    const items = numberedView(history, state);
    const summaryLine = summaryLineOf(items);
    assert.ok(summaryLine !== null);
    assert.deepEqual(resolveSpan(items, state, "m2", `m${summaryLine}`), {
      start: 1,
      end: 6,
    });
  });

  it("rejects a ref that is not an mN form", () => {
    const history = makeTranscript(4);
    const state = makeState();
    const items = numberedView(history, state);
    const result = resolveSpan(items, state, "abc", "m2");
    assert.ok("error" in result);
    assert.ok(result.error.includes("mN"));
    assert.ok(result.error.includes("[mN]"));
  });

  it("enriches an out-of-view error with the block id and decompress option", () => {
    const history = makeTranscript(6);
    const state = makeState();
    state.blocks.set(1, makeBlock(history, 2, 3));
    const items = numberedView(history, state);
    const result = resolveSpan(items, state, "m9", "m2");
    assert.ok("error" in result);
    assert.ok(result.error.includes("b1"));
    assert.ok(result.error.includes("decompress"));
    assert.ok(result.error.includes("不存在"));
  });

  it("keeps the plain out-of-view error when no active block exists", () => {
    const history = makeTranscript(4);
    const state = makeState();
    const items = numberedView(history, state);
    const result = resolveSpan(items, state, "m9", "m2");
    assert.ok("error" in result);
    assert.ok(result.error.includes("行号 m9 不存在"));
    assert.ok(!result.error.includes("decompress"));
  });
});

// ---------------------------------------------------------------------------
// 3. validateRange — protection-zone gate (C2-02)
// ---------------------------------------------------------------------------

describe("validateRange — protection-zone gate", () => {
  it("rejects a range reaching into the protected window", () => {
    const history = makeTranscript(10);
    const state = makeState();
    const result = validateRange(history, state, OPTIONS, 1, 9);
    assert.ok(result.error !== null);
    assert.ok(result.error.includes("保护区域"));
    assert.ok(result.error.includes("边界 8"));
  });

  it("accepts a range ending exactly at the boundary", () => {
    const history = makeTranscript(10);
    const state = makeState();
    const result = validateRange(history, state, OPTIONS, 1, 8);
    assert.equal(result.error, null);
  });
});

// ---------------------------------------------------------------------------
// 4. validateRange — first-user gate (C2-03)
// ---------------------------------------------------------------------------

describe("validateRange — first-user gate", () => {
  it("rejects a range containing the first user message", () => {
    const history = makeTranscript(10);
    const state = makeState();
    const result = validateRange(history, state, OPTIONS, 0, 5);
    assert.ok(result.error !== null);
    assert.ok(result.error.includes("第一条用户消息"));
  });

  it("accepts a range strictly after the first user message", () => {
    const history = makeTranscript(10);
    const state = makeState();
    const result = validateRange(history, state, OPTIONS, 1, 6);
    assert.equal(result.error, null);
  });
});

// ---------------------------------------------------------------------------
// 5. validateRange — overlap gate (C2-04)
// ---------------------------------------------------------------------------

describe("validateRange — overlap gate", () => {
  it("rejects a partial overlap with an active block", () => {
    const history = makeTranscript(10);
    const state = makeState();
    state.blocks.set(1, makeBlock(history, 2, 6));
    const result = validateRange(history, state, OPTIONS, 4, 8);
    assert.ok(result.error !== null);
    assert.ok(result.error.includes("部分重叠"));
    assert.ok(result.error.includes("b1"));
  });

  it("accepts a range disjoint from every active block", () => {
    const history = makeTranscript(10);
    const state = makeState();
    state.blocks.set(1, makeBlock(history, 2, 6));
    const result = validateRange(history, state, OPTIONS, 6, 8);
    assert.equal(result.error, null);
  });
});

// ---------------------------------------------------------------------------
// 6. validateRange — swallow gate (C1-11 / C2-07 / C2-08 / C2-09)
// ---------------------------------------------------------------------------

describe("validateRange — swallow gate", () => {
  it("collects a fully-covered active block for consumption", () => {
    const history = makeTranscript(10);
    const state = makeState();
    state.blocks.set(1, makeBlock(history, 2, 6));
    const result = validateRange(history, state, OPTIONS, 2, 8);
    assert.equal(result.error, null);
    assert.deepEqual(
      result.swallowed.map((ref) => ref.id),
      [1],
    );
    assert.deepEqual(result.coveredInactive, []);
  });

  it("collects a fully-covered inactive block for token netting", () => {
    const history = makeTranscript(10);
    const state = makeState();
    state.blocks.set(1, makeBlock(history, 2, 6, { active: false }));
    const result = validateRange(history, state, OPTIONS, 2, 8);
    assert.equal(result.error, null);
    assert.deepEqual(result.swallowed, []);
    assert.deepEqual(
      result.coveredInactive.map((ref) => ref.id),
      [1],
    );
  });

  it("ignores a partially-covered inactive block entirely", () => {
    const history = makeTranscript(10);
    const state = makeState();
    state.blocks.set(1, makeBlock(history, 2, 6, { active: false }));
    const result = validateRange(history, state, OPTIONS, 4, 8);
    assert.equal(result.error, null);
    assert.deepEqual(result.swallowed, []);
    assert.deepEqual(result.coveredInactive, []);
  });
});

// ---------------------------------------------------------------------------
// 7. validateRange — phantom gate (C2-05)
// ---------------------------------------------------------------------------

describe("validateRange — phantom gate", () => {
  it("rejects a range below the threshold", () => {
    const history = [
      makeMsg("user", ["开场"]),
      makeAssistantMsg({ text: "好的" }),
      makeMsg("user", ["继续"]),
      makeAssistantMsg({ text: "收到" }),
      makeMsg("user", ["明白"]),
      makeAssistantMsg({ text: "完成" }),
      makeMsg("user", ["最后问题"]),
      makeAssistantMsg({ text: "回复完毕" }),
    ];
    const state = makeState();
    const result = validateRange(
      history,
      state,
      { protectedMessages: 0, protectedTokens: 0, thresholdTokens: 50 },
      1,
      5,
    );
    assert.ok(result.error !== null);
    assert.ok(result.error.includes("收益过低"));
    assert.ok(result.error.includes("50"));
  });

  it("accepts a range at or above the threshold", () => {
    const history = makeTranscript(10);
    const state = makeState();
    const result = validateRange(history, state, OPTIONS, 1, 3);
    assert.equal(result.error, null);
  });
});

// ---------------------------------------------------------------------------
// 7b. validateRange — mid-pair gate (ToolMeta.output linkage)
// ---------------------------------------------------------------------------

/**
 * Build a pi-shaped tool-input region whose call links its result in a
 * SEPARATE message — the pi lens maps a toolCall block and its
 * toolResult message to two lens messages, and the tool-input region's
 * metadata carries the positional address of the linked tool-output
 * region (`ToolMeta.output`).
 */
function makeToolInputRegion(
  input: string,
  outputRef: ToolOutputRef | undefined,
  name = "bash",
): TextRegion {
  return {
    kind: "tool-input",
    get: () => input,
    tool: {
      name,
      status: "completed",
      ...(outputRef === undefined ? {} : { output: outputRef }),
    },
  };
}

/** A pi-shaped tool-result message (the sibling of a tool-input). */
function makePiToolResultMsg(output: string, name = "bash"): HostMessage {
  return {
    role: "toolResult",
    hidden: false,
    regions: [
      {
        kind: "tool-output",
        get: () => output,
        tool: { name, status: "completed" },
      },
    ],
  };
}

/**
 * Pi-shaped transcript: two tool pairs split across messages, plus a
 * trailing user and assistant.  Ordinals: 0 user, 1 call-1, 2 result-1,
 * 3 call-2, 4 result-2, 5 user, 6 assistant.
 *
 * With `linkOutput` the tool-input regions carry the positional address
 * of their linked result (the pi lens shape); without it they carry no
 * output metadata — the v1 metadata shape, where both halves of a call
 * live in one message and `ToolMeta.output` is never set.
 */
function makePairTranscript(linkOutput: boolean): HostMessage[] {
  const output = (ordinal: number): ToolOutputRef | undefined =>
    linkOutput ? { ordinal, regionIndex: 0 } : undefined;
  return [
    makeMsg("user", ["开场问题"]),
    {
      role: "assistant",
      hidden: false,
      regions: [makeToolInputRegion('{"cmd":"ls"}', output(2))],
    },
    makePiToolResultMsg(`data 1 ${"x".repeat(40)}`),
    {
      role: "assistant",
      hidden: false,
      regions: [makeToolInputRegion('{"cmd":"find"}', output(4))],
    },
    makePiToolResultMsg(`data 2 ${"x".repeat(40)}`),
    makeMsg("user", ["最后一个问题"]),
    makeAssistantMsg({ text: "回答完毕" }),
  ];
}

/**
 * Gate options for the pair-transcript tests: no protection window and
 * no phantom threshold, so the mid-pair gate is the only gate that can
 * reject the small fixture ranges.
 */
const PAIR_OPTIONS: CompressOptions = {
  protectedMessages: 0,
  protectedTokens: 0,
  thresholdTokens: 0,
};

describe("validateRange — mid-pair gate", () => {
  it("rejects a range ending right after a toolCall whose result sits outside", () => {
    const history = makePairTranscript(true);
    const state = makeState();
    const result = validateRange(history, state, PAIR_OPTIONS, 3, 4);
    assert.ok(result.error !== null);
    assert.ok(result.error.includes("工具调用对中间截断"));
    assert.ok(result.error.includes("序数 4"));
  });

  it("accepts a range extended to include the linked toolResult", () => {
    const history = makePairTranscript(true);
    const state = makeState();
    const result = validateRange(history, state, PAIR_OPTIONS, 3, 5);
    assert.equal(result.error, null);
  });

  it("never fires on v1-shaped input (no output metadata)", () => {
    const history = makePairTranscript(false);
    const state = makeState();
    // The same ordinal range that triggers the mid-pair gate when the
    // output linkage is present passes untouched on the v1 metadata
    // shape — the gate consumes only ToolMeta.output.
    const result = validateRange(history, state, PAIR_OPTIONS, 3, 4);
    assert.equal(result.error, null);
  });
});

describe("compressRanges — mid-pair gate batch semantics", () => {
  it("rejects the whole batch when any range cuts a pair, with zero state change", () => {
    const history = makePairTranscript(true);
    const state = makeState();
    const items = numberedView(history, state);
    const result = compressRanges(history, items, state, PAIR_OPTIONS, [
      // [3, 4) covers only the a2 toolCall half of the second pair; its
      // linked result (ordinal 4) sits outside → mid-pair rejection.
      { fromRef: "m4", toRef: "m4", title: "对半", summary: "摘要。" },
      // [1, 3) is a complete pair — valid on its own, but the batch is
      // atomic: the mid-pair range rejects the whole call.
      { fromRef: "m2", toRef: "m3", title: "整对", summary: "摘要。" },
    ]);
    assert.deepEqual(result.created, []);
    assert.equal(result.failed.length, 1);
    assert.equal(result.failed[0].index, 1);
    assert.ok(result.failed[0].error.includes("工具调用对中间截断"));
    assert.equal(state.blocks.size, 0);
    assert.equal(state.marks.size, 0);
  });

  it("accepts a full-pair range end to end", () => {
    const history = makePairTranscript(true);
    const state = makeState();
    const items = numberedView(history, state);
    const result = compressRange(
      history,
      items,
      state,
      1,
      4,
      "双对",
      "摘要。",
      PAIR_OPTIONS,
    );
    assert.deepEqual(result.failed, []);
    assert.equal(result.created.length, 1);
    assert.deepEqual([result.created[0].start, result.created[0].end], [1, 5]);
  });
});

// ---------------------------------------------------------------------------
// 8. compressRanges — block creation with spanHash (C2-13)
// ---------------------------------------------------------------------------

describe("compressRanges — block creation", () => {
  it("creates a block with complete fields and a self-validating spanHash", () => {
    const history = makeTranscript(10);
    const state = makeState();
    const items = numberedView(history, state);
    const result = compressRange(
      history,
      items,
      state,
      1,
      5,
      "执行主题",
      "摘要。",
    );
    assert.deepEqual(result.failed, []);
    assert.equal(result.error, undefined);
    assert.equal(result.created.length, 1);
    const block = result.created[0];
    assert.equal(block.start, 1);
    assert.equal(block.end, 6);
    assert.equal(block.title, "执行主题");
    assert.equal(block.active, true);
    assert.equal(block.spanHash, computeSpanHash(history, 1, 6));
    assert.ok(validateBlock(history, block));
    assert.equal(typeof block.createdAt, "number");
    assert.ok(block.compressedTokens > block.summaryTokens);
    // No consumed blocks → the summary is the model text alone.
    assert.equal(block.summary, "摘要。");
    assert.equal(state.blocks.size, 1);
    assert.equal(state.blocks.get(1), block);
  });
});

// ---------------------------------------------------------------------------
// 9. compressRanges — pending-mark accounting (clearConsumedBlockRange)
// ---------------------------------------------------------------------------

describe("compressRanges — pending-mark accounting", () => {
  it("adds swallowed pending-mark tokens and removes the marks", () => {
    const history = makeTranscript(10);
    const state = makeState();
    state.marks.set(
      markKey(3),
      makeMark({ anchorOrdinal: 3, contentTokens: 30 }),
    );
    state.marks.set(
      markKey(4, 0),
      makeMark({ anchorOrdinal: 4, regionIndex: 0, contentTokens: 20 }),
    );
    // Effective marks inside the range are never swallowed.
    state.marks.set(
      markKey(2),
      makeMark({ anchorOrdinal: 2, contentTokens: 99, effective: true }),
    );
    const items = numberedView(history, state);
    const result = compressRange(history, items, state, 1, 5, "主题", "摘要。");

    assert.equal(result.swallowedMarks, 2);
    let expected = 30 + 20;
    for (let i = 1; i < 6; i++) {
      expected += estimateMessageHeuristic(history[i]);
    }
    assert.equal(result.created[0].compressedTokens, expected);
    assert.equal(state.marks.has(markKey(3)), false);
    assert.equal(state.marks.has(markKey(4, 0)), false);
    assert.equal(state.marks.get(markKey(2))?.effective, true);
  });
});

// ---------------------------------------------------------------------------
// 10. compressRanges — batch semantics (C2-11 / C2-12)
// ---------------------------------------------------------------------------

describe("compressRanges — batch semantics", () => {
  it("creates three blocks for three valid non-overlapping ranges in one pass", () => {
    const history = makeTranscript(12);
    const state = makeState();
    const items = numberedView(history, state);
    const result = compressRanges(history, items, state, OPTIONS, [
      { fromRef: "m2", toRef: "m3", title: "主题A", summary: "摘要A。" },
      { fromRef: "m4", toRef: "m7", title: "主题B", summary: "摘要B。" },
      { fromRef: "m8", toRef: "m9", title: "主题C", summary: "摘要C。" },
    ]);
    assert.deepEqual(result.failed, []);
    assert.equal(result.created.length, 3);
    assert.deepEqual(
      result.created.map((b) => [b.start, b.end]),
      [
        [1, 3],
        [3, 7],
        [7, 9],
      ],
    );
    assert.equal(state.blocks.size, 3);
    assert.equal(state.blocks.get(1)?.title, "主题A");
    assert.equal(state.blocks.get(2)?.title, "主题B");
    assert.equal(state.blocks.get(3)?.title, "主题C");
    for (const block of state.blocks.values()) {
      assert.ok(validateBlock(history, block));
    }
  });

  it("rejects a range that would consume an earlier range's block (same snapshot)", () => {
    const history = makeTranscript(10);
    const state = makeState();
    const items = numberedView(history, state);
    // Range 2 fully covers range 1's interval: validated against the
    // snapshot (no block exists yet), then rejected by the cross-range
    // same-call rule — zero state change proves atomicity.
    const result = compressRanges(history, items, state, OPTIONS, [
      { fromRef: "m2", toRef: "m4", title: "主题A", summary: "摘要A。" },
      { fromRef: "m2", toRef: "m8", title: "主题B", summary: "摘要B。" },
    ]);
    assert.deepEqual(result.created, []);
    assert.equal(result.failed.length, 1);
    assert.equal(result.failed[0].index, 2);
    assert.ok(result.failed[0].error.includes("消费"));
    assert.equal(state.blocks.size, 0);
  });

  it("rejects the whole batch when any range fails a gate, naming the range", () => {
    const history = makeTranscript(10);
    const state = makeState();
    const items = numberedView(history, state);
    const result = compressRanges(history, items, state, OPTIONS, [
      { fromRef: "m2", toRef: "m4", title: "主题A", summary: "摘要A。" },
      { fromRef: "m8", toRef: "m10", title: "主题B", summary: "摘要B。" },
    ]);
    assert.deepEqual(result.created, []);
    assert.equal(result.failed.length, 1);
    assert.equal(result.failed[0].index, 2);
    assert.ok(result.failed[0].error.includes("保护区域"));
    assert.equal(state.blocks.size, 0);
  });

  it("consumes a pre-existing block in one batch range alongside an independent range", () => {
    const history = makeTranscript(10);
    const state = makeState();
    const initial = numberedView(history, state);
    compressRange(history, initial, state, 2, 3, "第一段主题", "第一段摘要。");

    const items = numberedView(history, state);
    const result = compressRanges(history, items, state, OPTIONS, [
      // [1, 6) fully covers block 1 [2, 4) → consumed in the batch.
      { fromRef: "m2", toRef: "m5", title: "主题A", summary: "摘要A。" },
      { fromRef: "m6", toRef: "m7", title: "主题B", summary: "摘要B。" },
    ]);
    assert.deepEqual(result.failed, []);
    assert.equal(result.created.length, 2);
    assert.equal(state.blocks.get(1)?.active, false);
    const b2 = state.blocks.get(2);
    assert.ok(b2 !== undefined);
    assert.deepEqual([b2.start, b2.end], [1, 6]);
    assert.ok(b2.summary.includes("--- b1: 第一段主题 ---"));
    const b3 = state.blocks.get(3);
    assert.ok(b3 !== undefined);
    assert.deepEqual([b3.start, b3.end], [6, 8]);
    assert.equal(b3.active, true);
  });
});

// ---------------------------------------------------------------------------
// 11. compressRanges — maxRanges and title rules (C2-14)
// ---------------------------------------------------------------------------

describe("compressRanges — maxRanges and title rules", () => {
  it("rejects a call exceeding maxRanges with batch guidance", () => {
    const history = makeTranscript(10);
    const state = makeState();
    const items = numberedView(history, state);
    const result = compressRanges(
      history,
      items,
      state,
      { ...OPTIONS, maxRanges: 1 },
      [
        { fromRef: "m2", toRef: "m3", title: "A", summary: "s" },
        { fromRef: "m4", toRef: "m5", title: "B", summary: "s" },
      ],
    );
    assert.deepEqual(result.created, []);
    assert.ok(result.error !== undefined);
    assert.ok(result.error.includes("分批"));
    assert.ok(result.error.includes("1 个"));
    assert.equal(state.blocks.size, 0);
  });

  it("rejects an empty title with range-indexed guidance", () => {
    const history = makeTranscript(10);
    const state = makeState();
    const items = numberedView(history, state);
    const result = compressRanges(history, items, state, OPTIONS, [
      { fromRef: "m2", toRef: "m3", title: "   ", summary: "s" },
    ]);
    assert.deepEqual(result.created, []);
    assert.equal(result.failed.length, 1);
    assert.equal(result.failed[0].index, 1);
    assert.ok(result.failed[0].error.includes("title 不能为空"));
    assert.equal(state.blocks.size, 0);
  });

  it("rejects a title containing control characters", () => {
    const history = makeTranscript(10);
    const state = makeState();
    const items = numberedView(history, state);
    const result = compressRanges(history, items, state, OPTIONS, [
      { fromRef: "m2", toRef: "m3", title: "a\nb", summary: "s" },
    ]);
    assert.ok(result.failed[0]?.error.includes("控制字符"));
    assert.equal(state.blocks.size, 0);
  });

  it("rejects a title with three or more consecutive hyphens", () => {
    const history = makeTranscript(10);
    const state = makeState();
    const items = numberedView(history, state);
    const result = compressRanges(history, items, state, OPTIONS, [
      { fromRef: "m2", toRef: "m3", title: "a---b", summary: "s" },
    ]);
    assert.ok(result.failed[0]?.error.includes("连字符"));
    assert.equal(state.blocks.size, 0);
  });

  it("rejects a title over 80 characters", () => {
    const history = makeTranscript(10);
    const state = makeState();
    const items = numberedView(history, state);
    const result = compressRanges(history, items, state, OPTIONS, [
      { fromRef: "m2", toRef: "m3", title: "x".repeat(81), summary: "s" },
    ]);
    assert.ok(result.failed[0]?.error.includes("80 字符上限"));
    assert.equal(state.blocks.size, 0);
  });

  it("trims surrounding whitespace from a valid title", () => {
    const history = makeTranscript(10);
    const state = makeState();
    const items = numberedView(history, state);
    const result = compressRanges(history, items, state, OPTIONS, [
      { fromRef: "m2", toRef: "m3", title: "  主题  ", summary: "s" },
    ]);
    assert.deepEqual(result.failed, []);
    assert.equal(result.created[0].title, "主题");
  });
});

// ---------------------------------------------------------------------------
// 12. compressRanges — apply-time gates (C2-06 / C2-05)
// ---------------------------------------------------------------------------

describe("compressRanges — apply-time gates", () => {
  it("fires the dedicated no-new-content error for a range equal to a block span", () => {
    const history = makeTranscript(10);
    const state = makeState();
    const initial = numberedView(history, state);
    compressRange(history, initial, state, 2, 3, "第一段主题", "第一段摘要。");

    const items = numberedView(history, state);
    const summaryLine = summaryLineOf(items);
    assert.ok(summaryLine !== null);
    const result = compressRanges(history, items, state, OPTIONS, [
      {
        fromRef: `m${summaryLine}`,
        toRef: `m${summaryLine}`,
        title: "重复主题",
        summary: "重复摘要。",
      },
    ]);
    assert.deepEqual(result.created, []);
    assert.equal(result.failed.length, 1);
    assert.ok(result.failed[0].error.includes("没有带来新的可压缩内容"));
    assert.ok(!result.failed[0].error.includes("收益为负"));
    // Failure safety: the existing block is untouched.
    assert.equal(state.blocks.size, 1);
    assert.equal(state.blocks.get(1)?.active, true);
  });

  it("rejects a negative benefit evaluated over the merged summary", () => {
    const history = makeTranscript(10);
    const state = makeState();
    const initial = numberedView(history, state);
    compressRange(history, initial, state, 2, 3, "第一段主题", "第一段摘要。");

    const items = numberedView(history, state);
    const result = compressRanges(history, items, state, OPTIONS, [
      { fromRef: "m2", toRef: "m5", title: "长主题", summary: "y".repeat(300) },
    ]);
    assert.deepEqual(result.created, []);
    assert.equal(result.failed.length, 1);
    assert.ok(result.failed[0].error.includes("收益为负"));
    assert.equal(state.blocks.size, 1);
    assert.equal(state.blocks.get(1)?.active, true);
  });

  it("swallows a covered block and merges index lines without double counting", () => {
    const history = makeTranscript(10);
    const state = makeState();
    const initial = numberedView(history, state);
    compressRange(history, initial, state, 2, 3, "第一段主题", "第一段摘要。");
    const b1 = state.blocks.get(1);
    assert.ok(b1 !== undefined);

    const items = numberedView(history, state);
    const result = compressRanges(history, items, state, OPTIONS, [
      {
        fromRef: "m2",
        toRef: "m5",
        title: "第二段主题",
        summary: "第二段摘要。",
      },
    ]);
    assert.equal(result.failed.length, 0);
    const b2 = result.created[0];
    assert.deepEqual([b2.start, b2.end], [1, 6]);
    assert.ok(b2.summary.includes(SUPERSEDED_BLOCKS_LEAD_IN));
    assert.ok(b2.summary.includes("--- b1: 第一段主题 ---"));
    assert.ok(!b2.summary.includes("第一段摘要。"));
    assert.equal(state.blocks.get(1)?.active, false);
    // Token no-double-count: the interval estimate minus the consumed block.
    let intervalTokens = 0;
    for (let i = 1; i < 6; i++) {
      intervalTokens += estimateMessageHeuristic(history[i]);
    }
    assert.equal(b2.compressedTokens, intervalTokens - b1.compressedTokens);
    assert.ok(validateBlock(history, b2));
  });

  it("nets out a fully-covered inactive block and keeps its index line", () => {
    const history = makeTranscript(10);
    const state = makeState();
    const initial = numberedView(history, state);
    compressRange(history, initial, state, 2, 3, "第一段主题", "第一段摘要。");
    const b1 = state.blocks.get(1);
    assert.ok(b1 !== undefined);
    // Deactivate without consumption: its content becomes ordinary again
    // (the fold shows every message, no summary item) and the tokens must
    // be netted out of any re-covering block.
    b1.active = false;

    const items = numberedView(history, state);
    const result = compressRanges(history, items, state, OPTIONS, [
      {
        fromRef: "m2",
        toRef: "m6",
        title: "第二段主题",
        summary: "第二段摘要。",
      },
    ]);
    assert.equal(result.failed.length, 0);
    const b2 = result.created[0];
    assert.ok(b2.summary.includes("--- b1: 第一段主题 ---"));
    assert.equal(state.blocks.get(1)?.active, false);
    let intervalTokens = 0;
    for (let i = 1; i < 6; i++) {
      intervalTokens += estimateMessageHeuristic(history[i]);
    }
    assert.equal(b2.compressedTokens, intervalTokens - b1.compressedTokens);
  });
});

// ---------------------------------------------------------------------------
// 13. End-to-end gate-decision pins
// ---------------------------------------------------------------------------

/**
 * Drive the batch pipeline over a transcript and capture success or the
 * first failure text.
 */
function runNewBatch(
  history: HostMessage[],
  state: SessionState,
  ranges: CompressRangeInput[],
  options: CompressOptions = OPTIONS,
): { ok: boolean; error?: string; count?: number } {
  const items = numberedView(history, state);
  const result = compressRanges(history, items, state, options, ranges);
  if (result.error !== undefined) return { ok: false, error: result.error };
  if (result.failed.length > 0)
    return { ok: false, error: result.failed[0].error };
  return { ok: true, count: result.created.length };
}

describe("end-to-end gate decisions", () => {
  it("accepts a valid plain range", () => {
    const result = runNewBatch(makeTranscript(10), makeState(), [
      { fromRef: "m2", toRef: "m6", title: "主题", summary: "摘要。" },
    ]);
    assert.equal(result.ok, true);
    assert.equal(result.count, 1);
  });

  it("rejects a range reaching into the protection zone", () => {
    const result = runNewBatch(makeTranscript(10), makeState(), [
      { fromRef: "m2", toRef: "m9", title: "主题", summary: "摘要。" },
    ]);
    assert.equal(result.ok, false);
    assert.ok(result.error?.includes("保护区域"));
  });

  it("rejects a range containing the first user message", () => {
    const result = runNewBatch(makeTranscript(10), makeState(), [
      { fromRef: "m1", toRef: "m5", title: "主题", summary: "摘要。" },
    ]);
    assert.equal(result.ok, false);
    assert.ok(result.error?.includes("第一条用户消息"));
  });

  it("rejects a phantom range below the threshold", () => {
    const short = [
      "开场",
      "好的",
      "继续",
      "收到",
      "明白",
      "完成",
      "最后问题",
      "回复完毕",
    ];
    const newHistory: HostMessage[] = short.map((text, i) =>
      i % 2 === 0 ? makeMsg("user", [text]) : makeAssistantMsg({ text }),
    );
    const phantomOptions: CompressOptions = {
      protectedMessages: 0,
      protectedTokens: 0,
      thresholdTokens: 50,
    };
    const result = runNewBatch(
      newHistory,
      makeState(),
      [{ fromRef: "m2", toRef: "m5", title: "主题", summary: "摘要。" }],
      phantomOptions,
    );
    assert.equal(result.ok, false);
    assert.ok(result.error?.includes("收益过低"));
  });

  it("rejects a partial overlap with an active block (gate level)", () => {
    const history = makeTranscript(10);
    const state = makeState();
    const initial = numberedView(history, state);
    compressRange(history, initial, state, 2, 5, "第一段主题", "第一段摘要。");
    const newError = validateRange(history, state, OPTIONS, 4, 8).error;
    assert.ok(newError !== null);
    assert.ok(newError.includes("部分重叠"));
  });

  it("swallows a fully-covered block in a later batch range", () => {
    const history = makeTranscript(10);
    const state = makeState();
    const initial = numberedView(history, state);
    compressRange(history, initial, state, 2, 3, "第一段主题", "第一段摘要。");
    const result = runNewBatch(history, state, [
      { fromRef: "m2", toRef: "m6", title: "主题B", summary: "摘要B。" },
    ]);
    const consumed = state.blocks.get(1);
    assert.equal(result.ok, true);
    assert.equal(result.count, 1);
    assert.equal(consumed?.active, false);
  });

  it("rejects a range equal to a block span (no-new-content)", () => {
    const history = makeTranscript(10);
    const state = makeState();
    const initial = numberedView(history, state);
    compressRange(history, initial, state, 2, 3, "第一段主题", "第一段摘要。");
    const items = numberedView(history, state);
    const summaryLine = summaryLineOf(items);
    assert.ok(summaryLine !== null);
    const result = runNewBatch(history, state, [
      {
        fromRef: `m${summaryLine}`,
        toRef: `m${summaryLine}`,
        title: "重复主题",
        summary: "重复摘要。",
      },
    ]);
    assert.equal(result.ok, false);
    assert.ok(result.error?.includes("没有带来新的可压缩内容"));
  });

  it("rejects a negative benefit evaluated over the merged summary", () => {
    const history = makeTranscript(10);
    const state = makeState();
    const initial = numberedView(history, state);
    compressRange(history, initial, state, 2, 3, "第一段主题", "第一段摘要。");
    const result = runNewBatch(history, state, [
      { fromRef: "m2", toRef: "m6", title: "长主题", summary: "y".repeat(300) },
    ]);
    assert.equal(result.ok, false);
    assert.ok(result.error?.includes("收益为负"));
  });

  it("rejects a reversed range pair with an order error", () => {
    const result = runNewBatch(makeTranscript(10), makeState(), [
      { fromRef: "m6", toRef: "m2", title: "主题", summary: "摘要。" },
    ]);
    // Reversed refs are addresses, not sequence numbers: the order is
    // rejected and the model is guided to pick the earlier ref first.
    assert.equal(result.ok, false);
    assert.ok(result.error?.includes("顺序颠倒"));
  });
});
