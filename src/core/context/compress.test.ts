/**
 * Tests for the ordinal-based compression core (`compress.ts`).
 *
 * Covers the combined protection window (message-count and token-budget
 * dimensions), endpoint resolution via line refs (original / summary /
 * reversed-pair order error / actionable errors with the
 * covered-content hint), every validation gate with one positive and
 * one negative case each (protection zone, first user, overlap, swallow,
 * phantom), the apply-time gates (no-new-content, negative benefit),
 * block creation with spanHash self-validation, pending-mark token
 * accounting via `clearConsumedBlockRange`, and batch semantics
 * (three-range batch, same-snapshot validation, cross-range rules,
 * atomicity, maxRanges, title rules).
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
import type { HostMessage, Projection } from "./lens.js";
import { project } from "./lens.js";
import {
  makeAssistantMsg,
  makeMsg,
  makeToolResultMsg,
  projectMessages,
} from "./lens-testkit.js";
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
    spanHash: computeSpanHash(projectMessages(history), start, end),
    status: "active",
    compressedTokens: 100,
    summaryTokens: 10,
    createdAt: 1000,
    ...overrides,
  };
}

/** Number the folded view of a projection snapshot, skipping hidden messages. */
function numberedViewOf(
  snapshot: Projection,
  state: SessionState,
): NumberedItem[] {
  const { items } = fold(snapshot, state);
  return numberView(items, (ordinal) => snapshot.messages[ordinal].hidden);
}

/** Number the folded view of the state, skipping hidden messages. */
function numberedView(
  history: HostMessage[],
  state: SessionState,
): NumberedItem[] {
  return numberedViewOf(projectMessages(history), state);
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
  return compressRanges(projectMessages(history), items, state, options, [
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
// 2. resolveSpan — endpoint resolution gate
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
// 3. validateRange — protection-zone gate
// ---------------------------------------------------------------------------

describe("validateRange — protection-zone gate", () => {
  it("rejects a range reaching into the protected window", () => {
    const history = makeTranscript(10);
    const state = makeState();
    const result = validateRange(
      projectMessages(history),
      numberedView(history, state),
      state,
      OPTIONS,
      1,
      9,
    );
    assert.ok(result.error !== null);
    // The rejected span and the boundary to move are named in the model's
    // address space: ordinals 1..8 are m2..m9, the last compressible line
    // is m8, and the internal half-open interval never leaks.
    assert.ok(
      result.error.includes("包含受到保护的最近对话内容"),
      result.error,
    );
    assert.ok(result.error.includes("范围 m2 至 m9"), result.error);
    assert.ok(result.error.includes("（从 m9 开始）"), result.error);
    assert.ok(result.error.includes("请将终点改为 m8 或更早"), result.error);
    assert.ok(!result.error.includes("[1, 9)"), result.error);
  });

  it("accepts a range ending exactly at the boundary", () => {
    const history = makeTranscript(10);
    const state = makeState();
    const result = validateRange(
      projectMessages(history),
      numberedView(history, state),
      state,
      OPTIONS,
      1,
      8,
    );
    assert.equal(result.error, null);
  });
});

// ---------------------------------------------------------------------------
// 4. validateRange — first-user gate
// ---------------------------------------------------------------------------

describe("validateRange — first-user gate", () => {
  it("rejects a range containing the first user message", () => {
    const history = makeTranscript(10);
    const state = makeState();
    const result = validateRange(
      projectMessages(history),
      numberedView(history, state),
      state,
      OPTIONS,
      0,
      5,
    );
    assert.ok(result.error !== null);
    assert.ok(result.error.includes("第一条用户消息"));
    // The first user message (ordinal 0) is named by its line, not its ordinal.
    assert.ok(result.error.includes("（m1）"), result.error);
  });

  it("accepts a range strictly after the first user message", () => {
    const history = makeTranscript(10);
    const state = makeState();
    const result = validateRange(
      projectMessages(history),
      numberedView(history, state),
      state,
      OPTIONS,
      1,
      6,
    );
    assert.equal(result.error, null);
  });
});

// ---------------------------------------------------------------------------
// 5. validateRange — overlap gate
// ---------------------------------------------------------------------------

describe("validateRange — overlap gate", () => {
  it("rejects a partial overlap with an active block", () => {
    const history = makeTranscript(10);
    const state = makeState();
    state.blocks.set(1, makeBlock(history, 2, 6));
    const result = validateRange(
      projectMessages(history),
      numberedView(history, state),
      state,
      OPTIONS,
      4,
      8,
    );
    assert.ok(result.error !== null);
    assert.ok(result.error.includes("部分重叠"));
    assert.ok(result.error.includes("b1"));
    // Block 1 folds [2, 6) into summary line m3 — the boundary to align on,
    // and the rejected span [4, 8) is named by its own lines.
    assert.ok(result.error.includes("范围 m3 至 m5"), result.error);
    assert.ok(result.error.includes("摘要行 m3"), result.error);
    assert.ok(result.error.includes("请将范围扩展到完整覆盖 m3"), result.error);
  });

  it("accepts a range disjoint from every active block", () => {
    const history = makeTranscript(10);
    const state = makeState();
    state.blocks.set(1, makeBlock(history, 2, 6));
    const result = validateRange(
      projectMessages(history),
      numberedView(history, state),
      state,
      OPTIONS,
      6,
      8,
    );
    assert.equal(result.error, null);
  });
});

// ---------------------------------------------------------------------------
// 6. validateRange — swallow gate
// ---------------------------------------------------------------------------

describe("validateRange — swallow gate", () => {
  it("collects a fully-covered active block for consumption", () => {
    const history = makeTranscript(10);
    const state = makeState();
    state.blocks.set(1, makeBlock(history, 2, 6));
    const result = validateRange(
      projectMessages(history),
      numberedView(history, state),
      state,
      OPTIONS,
      2,
      8,
    );
    assert.equal(result.error, null);
    assert.deepEqual(
      result.swallowed.map((ref) => ref.id),
      [1],
    );
    assert.deepEqual(result.coveredInactive, []);
  });

  it("collects a fully-covered terminal block as an absorbed record", () => {
    const history = makeTranscript(10);
    const state = makeState();
    state.blocks.set(1, makeBlock(history, 2, 6, { status: "consumed" }));
    state.blocks.set(2, makeBlock(history, 6, 8, { status: "stale" }));
    const result = validateRange(
      projectMessages(history),
      numberedView(history, state),
      state,
      OPTIONS,
      2,
      8,
    );
    assert.equal(result.error, null);
    assert.deepEqual(result.swallowed, []);
    assert.deepEqual(
      result.coveredInactive.map((ref) => ref.id),
      [1, 2],
    );
  });

  it("ignores a partially-covered terminal block entirely", () => {
    const history = makeTranscript(10);
    const state = makeState();
    state.blocks.set(1, makeBlock(history, 2, 6, { status: "consumed" }));
    const result = validateRange(
      projectMessages(history),
      numberedView(history, state),
      state,
      OPTIONS,
      4,
      8,
    );
    assert.equal(result.error, null);
    assert.deepEqual(result.swallowed, []);
    assert.deepEqual(result.coveredInactive, []);
  });
});

// ---------------------------------------------------------------------------
// 7. validateRange — phantom gate
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
      projectMessages(history),
      numberedView(history, state),
      state,
      { protectedMessages: 0, protectedTokens: 0, thresholdTokens: 50 },
      1,
      5,
    );
    assert.ok(result.error !== null);
    assert.ok(result.error.includes("无法带来足够收益"));
    assert.ok(result.error.includes("50"));
    // The phantom span is reported as "范围 m2 至 m5", not as ordinal half-open.
    assert.ok(result.error.includes("范围 m2 至 m5"), result.error);
    assert.ok(result.error.includes("低于最小压缩规模"), result.error);
    assert.ok(!result.error.includes("[1, 5)"), result.error);
  });

  it("accepts a range at or above the threshold", () => {
    const history = makeTranscript(10);
    const state = makeState();
    const result = validateRange(
      projectMessages(history),
      numberedView(history, state),
      state,
      OPTIONS,
      1,
      3,
    );
    assert.equal(result.error, null);
  });
});

// ---------------------------------------------------------------------------
// 7b. validateRange — mid-pair gate (the invocation table)
// ---------------------------------------------------------------------------

/** A bare tool-input-only message (the pi toolCall shape). */
function makeToolInputMsg(input: string): HostMessage {
  return {
    role: "assistant",
    hidden: false,
    regions: [{ kind: "tool-input", get: () => input }],
  };
}

/**
 * Pi-shaped transcript: two tool pairs split across messages, plus a
 * trailing user and assistant.  Ordinals: 0 user, 1 call-1, 2 result-1,
 * 3 call-2, 4 result-2, 5 user, 6 assistant.
 *
 * With `linked` the invocation table pairs each call message with its
 * result message (the pi projection shape); without it the calls are
 * in flight (no output half) — the gate has no pairing to check and
 * must not fire.
 */
function makePairTranscript(linked: boolean): Projection {
  const messages = [
    makeMsg("user", ["开场问题"]),
    makeToolInputMsg('{"cmd":"ls"}'),
    makeToolResultMsg(`data 1 ${"x".repeat(40)}`),
    makeToolInputMsg('{"cmd":"find"}'),
    makeToolResultMsg(`data 2 ${"x".repeat(40)}`),
    makeMsg("user", ["最后一个问题"]),
    makeAssistantMsg({ text: "回答完毕" }),
  ];
  return project(messages, [
    {
      name: "bash",
      status: "completed",
      input: { ordinal: 1, regionIndex: 0 },
      ...(linked ? { output: { ordinal: 2, regionIndex: 0 } } : {}),
    },
    {
      name: "bash",
      status: "completed",
      input: { ordinal: 3, regionIndex: 0 },
      ...(linked ? { output: { ordinal: 4, regionIndex: 0 } } : {}),
    },
  ]);
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
    const transcript = makePairTranscript(true);
    const state = makeState();
    const result = validateRange(
      transcript,
      numberedViewOf(transcript, state),
      state,
      PAIR_OPTIONS,
      3,
      4,
    );
    assert.ok(result.error !== null);
    assert.ok(result.error.includes("在工具调用和对应结果之间截断"));
    // ordinal 4 (the linked result) is line m5 of this view.
    assert.ok(result.error.includes("（m5）"), result.error);
    assert.ok(result.error.includes("请将终点扩展到包含 m5"), result.error);
  });

  it("accepts a range extended to include the linked toolResult", () => {
    const transcript = makePairTranscript(true);
    const state = makeState();
    const result = validateRange(
      transcript,
      numberedViewOf(transcript, state),
      state,
      PAIR_OPTIONS,
      3,
      5,
    );
    assert.equal(result.error, null);
  });

  it("rejects a range starting after a toolCall whose call sits before the start", () => {
    const transcript = makePairTranscript(true);
    const state = makeState();
    // [2, 3) covers the result half (ordinal 2) of the first pair while
    // its call (ordinal 1) stays outside — the reverse of the direction
    // above, gated the same way.
    const result = validateRange(
      transcript,
      numberedViewOf(transcript, state),
      state,
      PAIR_OPTIONS,
      2,
      3,
    );
    assert.ok(result.error !== null);
    assert.ok(result.error.includes("在工具调用和对应结果之间截断"));
    // ordinal 1 (the orphaned call) is line m2 of this view.
    assert.ok(result.error.includes("（m2）"), result.error);
    assert.ok(result.error.includes("请将起点前移到包含 m2"), result.error);
  });

  it("accepts a range covering both halves of a pair (reverse direction)", () => {
    const transcript = makePairTranscript(true);
    const state = makeState();
    // [1, 3) covers call-1 (ordinal 1) together with its result
    // (ordinal 2) — the range the test above rejects once extended.
    const result = validateRange(
      transcript,
      numberedViewOf(transcript, state),
      state,
      PAIR_OPTIONS,
      1,
      3,
    );
    assert.equal(result.error, null);
  });

  it("never fires on unpaired result messages", () => {
    const transcript = makePairTranscript(false);
    const state = makeState();
    // Without the invocation table there is no pairing information at
    // all; a lone result message must not be rejected by this gate
    // (producers abstain from unpaired regions).
    const result = validateRange(
      transcript,
      numberedViewOf(transcript, state),
      state,
      PAIR_OPTIONS,
      2,
      3,
    );
    assert.equal(result.error, null);
  });

  it("never fires on in-flight calls (no linked output half)", () => {
    const transcript = makePairTranscript(false);
    const state = makeState();
    // The same ordinal range that triggers the mid-pair gate when the
    // pairing is present passes untouched while the call is still in
    // flight — the gate consumes only invocation output addresses.
    const result = validateRange(
      transcript,
      numberedViewOf(transcript, state),
      state,
      PAIR_OPTIONS,
      3,
      4,
    );
    assert.equal(result.error, null);
  });
});

describe("compressRanges — mid-pair gate batch semantics", () => {
  it("rejects the whole batch when any range cuts a pair, with zero state change", () => {
    const transcript = makePairTranscript(true);
    const state = makeState();
    const items = numberView(
      fold(transcript, state).items,
      (ordinal) => transcript.messages[ordinal].hidden,
    );
    const result = compressRanges(transcript, items, state, PAIR_OPTIONS, [
      // [3, 4) covers only the a2 toolCall half of the second pair; its
      // linked result (ordinal 4) sits outside → mid-pair rejection.
      { fromRef: "m4", toRef: "m4", title: "对半", summary: "摘要。" },
      // [1, 3) is a complete pair — valid on its own, but the batch is
      // atomic: the mid-pair range rejects the whole call.
      { fromRef: "m2", toRef: "m3", title: "整对", summary: "摘要。" },
    ]);
    assert.equal(result.created.length, 0);
    assert.equal(result.failed.length, 1);
    assert.ok(
      result.failed[0].error.includes("在工具调用和对应结果之间截断"),
      result.failed[0].error,
    );
    assert.equal(state.blocks.size, 0);
  });

  it("accepts paired ranges covering both halves of every call", () => {
    const transcript = makePairTranscript(true);
    const state = makeState();
    const items = numberView(
      fold(transcript, state).items,
      (ordinal) => transcript.messages[ordinal].hidden,
    );
    const result = compressRanges(transcript, items, state, PAIR_OPTIONS, [
      // [1, 3) covers call-1 (ordinal 1) with its result (ordinal 2).
      { fromRef: "m2", toRef: "m3", title: "整对一", summary: "摘要一。" },
      // [3, 5) covers call-2 (ordinal 3) with its result (ordinal 4).
      { fromRef: "m4", toRef: "m5", title: "整对二", summary: "摘要二。" },
    ]);
    assert.equal(result.created.length, 2);
    assert.equal(result.failed.length, 0);
  });
});

// ---------------------------------------------------------------------------
// 8. compressRanges — block creation with spanHash
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
    assert.equal(block.status, "active");
    assert.equal(
      block.spanHash,
      computeSpanHash(projectMessages(history), 1, 6),
    );
    assert.ok(validateBlock(projectMessages(history), block));
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
// 10. compressRanges — batch semantics
// ---------------------------------------------------------------------------

describe("compressRanges — batch semantics", () => {
  it("creates three blocks for three valid non-overlapping ranges in one pass", () => {
    const history = makeTranscript(12);
    const state = makeState();
    const items = numberedView(history, state);
    const result = compressRanges(
      projectMessages(history),
      items,
      state,
      OPTIONS,
      [
        { fromRef: "m2", toRef: "m3", title: "主题A", summary: "摘要A。" },
        { fromRef: "m4", toRef: "m7", title: "主题B", summary: "摘要B。" },
        { fromRef: "m8", toRef: "m9", title: "主题C", summary: "摘要C。" },
      ],
    );
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
      assert.ok(validateBlock(projectMessages(history), block));
    }
  });

  it("rejects a range that would consume an earlier range's block (same snapshot)", () => {
    const history = makeTranscript(10);
    const state = makeState();
    const items = numberedView(history, state);
    // Range 2 fully covers range 1's interval: validated against the
    // snapshot (no block exists yet), then rejected by the cross-range
    // same-call rule — zero state change proves atomicity.
    const result = compressRanges(
      projectMessages(history),
      items,
      state,
      OPTIONS,
      [
        { fromRef: "m2", toRef: "m4", title: "主题A", summary: "摘要A。" },
        { fromRef: "m2", toRef: "m8", title: "主题B", summary: "摘要B。" },
      ],
    );
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
    const result = compressRanges(
      projectMessages(history),
      items,
      state,
      OPTIONS,
      [
        { fromRef: "m2", toRef: "m4", title: "主题A", summary: "摘要A。" },
        { fromRef: "m8", toRef: "m10", title: "主题B", summary: "摘要B。" },
      ],
    );
    assert.deepEqual(result.created, []);
    assert.equal(result.failed.length, 1);
    assert.equal(result.failed[0].index, 2);
    assert.ok(
      result.failed[0].error.includes("包含受到保护的最近对话内容"),
      result.failed[0].error,
    );
    assert.equal(state.blocks.size, 0);
  });

  it("consumes a pre-existing block in one batch range alongside an independent range", () => {
    const history = makeTranscript(10);
    const state = makeState();
    const initial = numberedView(history, state);
    compressRange(history, initial, state, 2, 3, "第一段主题", "第一段摘要。");

    const items = numberedView(history, state);
    const result = compressRanges(
      projectMessages(history),
      items,
      state,
      OPTIONS,
      [
        // [1, 6) fully covers block 1 [2, 4) → consumed in the batch.
        { fromRef: "m2", toRef: "m5", title: "主题A", summary: "摘要A。" },
        { fromRef: "m6", toRef: "m7", title: "主题B", summary: "摘要B。" },
      ],
    );
    assert.deepEqual(result.failed, []);
    assert.equal(result.created.length, 2);
    assert.equal(state.blocks.get(1)?.status, "consumed");
    const b2 = state.blocks.get(2);
    assert.ok(b2 !== undefined);
    assert.deepEqual([b2.start, b2.end], [1, 6]);
    assert.ok(b2.summary.includes("--- b1: 第一段主题 ---"));
    const b3 = state.blocks.get(3);
    assert.ok(b3 !== undefined);
    assert.deepEqual([b3.start, b3.end], [6, 8]);
    assert.equal(b3.status, "active");
  });
});

// ---------------------------------------------------------------------------
// 11. compressRanges — maxRanges and title rules
// ---------------------------------------------------------------------------

describe("compressRanges — maxRanges and title rules", () => {
  it("rejects a call exceeding maxRanges with batch guidance", () => {
    const history = makeTranscript(10);
    const state = makeState();
    const items = numberedView(history, state);
    const result = compressRanges(
      projectMessages(history),
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
    const result = compressRanges(
      projectMessages(history),
      items,
      state,
      OPTIONS,
      [{ fromRef: "m2", toRef: "m3", title: "   ", summary: "s" }],
    );
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
    const result = compressRanges(
      projectMessages(history),
      items,
      state,
      OPTIONS,
      [{ fromRef: "m2", toRef: "m3", title: "a\nb", summary: "s" }],
    );
    assert.ok(result.failed[0]?.error.includes("控制字符"));
    assert.equal(state.blocks.size, 0);
  });

  it("rejects a title with three or more consecutive hyphens", () => {
    const history = makeTranscript(10);
    const state = makeState();
    const items = numberedView(history, state);
    const result = compressRanges(
      projectMessages(history),
      items,
      state,
      OPTIONS,
      [{ fromRef: "m2", toRef: "m3", title: "a---b", summary: "s" }],
    );
    assert.ok(result.failed[0]?.error.includes("连字符"));
    assert.equal(state.blocks.size, 0);
  });

  it("rejects a title over 80 characters", () => {
    const history = makeTranscript(10);
    const state = makeState();
    const items = numberedView(history, state);
    const result = compressRanges(
      projectMessages(history),
      items,
      state,
      OPTIONS,
      [{ fromRef: "m2", toRef: "m3", title: "x".repeat(81), summary: "s" }],
    );
    assert.ok(result.failed[0]?.error.includes("80 字符上限"));
    assert.equal(state.blocks.size, 0);
  });

  it("trims surrounding whitespace from a valid title", () => {
    const history = makeTranscript(10);
    const state = makeState();
    const items = numberedView(history, state);
    const result = compressRanges(
      projectMessages(history),
      items,
      state,
      OPTIONS,
      [{ fromRef: "m2", toRef: "m3", title: "  主题  ", summary: "s" }],
    );
    assert.deepEqual(result.failed, []);
    assert.equal(result.created[0].title, "主题");
  });
});

// ---------------------------------------------------------------------------
// 12. compressRanges — apply-time gates
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
    const result = compressRanges(
      projectMessages(history),
      items,
      state,
      OPTIONS,
      [
        {
          fromRef: `m${summaryLine}`,
          toRef: `m${summaryLine}`,
          title: "重复主题",
          summary: "重复摘要。",
        },
      ],
    );
    assert.deepEqual(result.created, []);
    assert.equal(result.failed.length, 1);
    assert.ok(result.failed[0].error.includes("没有带来新的可压缩内容"));
    assert.ok(!result.failed[0].error.includes("收益为负"));
    // Failure safety: the existing block is untouched.
    assert.equal(state.blocks.size, 1);
    assert.equal(state.blocks.get(1)?.status, "active");
  });

  it("rejects a negative benefit evaluated over the merged summary", () => {
    const history = makeTranscript(10);
    const state = makeState();
    const initial = numberedView(history, state);
    compressRange(history, initial, state, 2, 3, "第一段主题", "第一段摘要。");

    const items = numberedView(history, state);
    const result = compressRanges(
      projectMessages(history),
      items,
      state,
      OPTIONS,
      [
        {
          fromRef: "m2",
          toRef: "m5",
          title: "长主题",
          summary: "y".repeat(300),
        },
      ],
    );
    assert.deepEqual(result.created, []);
    assert.equal(result.failed.length, 1);
    assert.ok(result.failed[0].error.includes("收益为负"));
    assert.equal(state.blocks.size, 1);
    assert.equal(state.blocks.get(1)?.status, "active");
  });

  it("swallows a covered block and merges index lines without double counting", () => {
    const history = makeTranscript(10);
    const state = makeState();
    const initial = numberedView(history, state);
    compressRange(history, initial, state, 2, 3, "第一段主题", "第一段摘要。");
    const b1 = state.blocks.get(1);
    assert.ok(b1 !== undefined);

    const items = numberedView(history, state);
    const result = compressRanges(
      projectMessages(history),
      items,
      state,
      OPTIONS,
      [
        {
          fromRef: "m2",
          toRef: "m5",
          title: "第二段主题",
          summary: "第二段摘要。",
        },
      ],
    );
    assert.equal(result.failed.length, 0);
    const b2 = result.created[0];
    assert.deepEqual([b2.start, b2.end], [1, 6]);
    assert.ok(b2.summary.includes(SUPERSEDED_BLOCKS_LEAD_IN));
    assert.ok(b2.summary.includes("--- b1: 第一段主题 ---"));
    assert.ok(!b2.summary.includes("第一段摘要。"));
    assert.equal(state.blocks.get(1)?.status, "consumed");
    // Token no-double-count: the interval estimate minus the consumed block.
    let intervalTokens = 0;
    for (let i = 1; i < 6; i++) {
      intervalTokens += estimateMessageHeuristic(history[i]);
    }
    assert.equal(b2.compressedTokens, intervalTokens - b1.compressedTokens);
    assert.ok(validateBlock(projectMessages(history), b2));
  });

  it("nets an absorbed record whose content a consumed parent still folds", () => {
    const history = makeTranscript(16);
    const state = makeState();
    // Generation 1: b1 folds [2, 4).
    compressRange(
      history,
      numberedView(history, state),
      state,
      2,
      3,
      "第一段主题",
      "第一段摘要。",
    );
    const b1 = state.blocks.get(1);
    assert.ok(b1 !== undefined);
    // Generation 2: b2 folds [1, 6) and swallows b1 — b1's content stays
    // out of the view, folded inside b2's summary.
    const gen2 = compressRange(
      history,
      numberedView(history, state),
      state,
      1,
      5,
      "第二段主题",
      "第二段摘要。",
    );
    assert.equal(gen2.failed.length, 0);
    const b2 = state.blocks.get(2);
    assert.ok(b2 !== undefined);
    assert.equal(b1.status, "consumed");

    // Generation 3: b3 folds [1, 12) — it swallows b2 and re-covers the
    // consumed b1, whose tokens b2 deliberately left out.
    const thirdItems = numberedView(history, state);
    const summaryLine = summaryLineOf(thirdItems);
    assert.ok(summaryLine !== null);
    const toRef = ordinalLine(thirdItems, 11);
    assert.ok(toRef !== null);
    const gen3 = compressRanges(
      projectMessages(history),
      thirdItems,
      state,
      OPTIONS,
      [
        {
          fromRef: `m${summaryLine}`,
          toRef,
          title: "第三段主题",
          summary: "第三段摘要。",
        },
      ],
    );
    assert.equal(gen3.failed.length, 0);
    const b3 = gen3.created[0];
    assert.deepEqual([b3.start, b3.end], [1, 12]);
    assert.ok(b3.summary.includes("--- b1: 第一段主题 ---"));
    assert.ok(b3.summary.includes("--- b2: 第二段主题 ---"));

    let intervalTokens = 0;
    for (let i = 1; i < 12; i++) {
      intervalTokens += estimateMessageHeuristic(history[i]);
    }
    // Both absorbed records are netted: what remains is exactly the
    // freshly folded content (ordinals 6 through 11).
    assert.equal(
      b3.compressedTokens,
      intervalTokens - b2.compressedTokens - b1.compressedTokens,
    );
    let freshTokens = 0;
    for (let i = 6; i < 12; i++) {
      freshTokens += estimateMessageHeuristic(history[i]);
    }
    assert.equal(b3.compressedTokens, freshTokens);
  });

  it("does not net an absorbed record whose content is visible again", () => {
    const history = makeTranscript(10);
    const state = makeState();
    const initial = numberedView(history, state);
    compressRange(history, initial, state, 2, 3, "第一段主题", "第一段摘要。");
    const b1 = state.blocks.get(1);
    assert.ok(b1 !== undefined);
    // The block goes stale: no active block folds its interval any more,
    // so every message it covered is ordinary view content again.
    b1.status = "stale";

    const items = numberedView(history, state);
    const result = compressRanges(
      projectMessages(history),
      items,
      state,
      OPTIONS,
      [
        {
          fromRef: ordinalLine(items, 2) as string,
          toRef: ordinalLine(items, 3) as string,
          title: "重压缩主题",
          summary: "重压缩摘要。",
        },
      ],
    );

    // Re-folding visible content is real gain — the record is absorbed
    // for its index line but its tokens are NOT netted out.
    assert.equal(result.failed.length, 0);
    const b2 = result.created[0];
    assert.ok(b2.summary.includes("--- b1: 第一段主题 ---"));
    assert.equal(b2.compressedTokens, b1.compressedTokens);
    // The stale record survives alongside the new block.
    assert.equal(state.blocks.get(1)?.status, "stale");
    assert.equal(state.blocks.size, 2);
  });

  it("re-compresses a stale span under a fresh id, never reusing b1", () => {
    const history = makeTranscript(10);
    const state = makeState();
    compressRange(
      history,
      numberedView(history, state),
      state,
      2,
      3,
      "第一段",
      "第一段摘要。",
    );
    const b1 = state.blocks.get(1);
    assert.ok(b1 !== undefined);
    // The block loses its content guarantee and stays in the map.
    b1.status = "stale";

    const items = numberedView(history, state);
    const result = compressRanges(
      projectMessages(history),
      items,
      state,
      OPTIONS,
      [
        {
          fromRef: ordinalLine(items, 2) as string,
          toRef: ordinalLine(items, 3) as string,
          title: "重压缩",
          summary: "重压缩摘要。",
        },
      ],
    );

    assert.equal(result.failed.length, 0);
    const created = result.created[0];
    assert.equal(created.status, "active");
    // The new block lands under its own id; the stale record is untouched.
    assert.equal(state.blocks.get(2), created);
    assert.notEqual(state.blocks.get(1), created);
    assert.equal(state.blocks.size, 2);
    assert.equal(state.blocks.get(1)?.status, "stale");
    assert.equal(state.blocks.get(1)?.summary, "第一段摘要。");
    assert.equal(state.nextBlockId, 3);
  });

  it("does not net an absorbed record left visible by a restore", () => {
    const history = makeTranscript(10);
    const state = makeState();
    const initial = numberedView(history, state);
    compressRange(history, initial, state, 2, 3, "第一段主题", "第一段摘要。");
    const b1 = state.blocks.get(1);
    assert.ok(b1 !== undefined);
    // A restore consumes the block without any wider block folding its
    // interval — the content is back in the view.
    b1.status = "consumed";

    const items = numberedView(history, state);
    const result = compressRanges(
      projectMessages(history),
      items,
      state,
      OPTIONS,
      [
        {
          fromRef: ordinalLine(items, 2) as string,
          toRef: ordinalLine(items, 3) as string,
          title: "重压缩主题",
          summary: "重压缩摘要。",
        },
      ],
    );

    assert.equal(result.failed.length, 0);
    assert.equal(result.created[0].compressedTokens, b1.compressedTokens);
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
  const result = compressRanges(
    projectMessages(history),
    items,
    state,
    options,
    ranges,
  );
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
    assert.ok(
      result.error?.includes("包含受到保护的最近对话内容"),
      result.error,
    );
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
    assert.ok(result.error?.includes("无法带来足够收益"), result.error);
  });

  it("rejects a partial overlap with an active block (gate level)", () => {
    const history = makeTranscript(10);
    const state = makeState();
    const initial = numberedView(history, state);
    compressRange(history, initial, state, 2, 5, "第一段主题", "第一段摘要。");
    const newError = validateRange(
      projectMessages(history),
      numberedView(history, state),
      state,
      OPTIONS,
      4,
      8,
    ).error;
    assert.ok(newError !== null);
    assert.ok(newError.includes("部分重叠"));
    assert.ok(newError.includes("范围 m3 至 m5"), newError);
    assert.ok(newError.includes("摘要行 m3"), newError);
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
    assert.equal(consumed?.status, "consumed");
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
