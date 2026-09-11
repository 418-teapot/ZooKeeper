/**
 * Tests for the decompress core (`decompress.ts`).
 *
 * Covers: loud Chinese errors for invalid `b<N>` formats and
 * nonexistent blocks (the not-found error lists the currently available
 * block numbers), restore vs recall resolution with idempotent recall,
 * the restore context-limit gate three states — allowed at/below the
 * threshold (boundary passes), rejected above with delta + fill-rate
 * guidance, skipped when the model limit or the fill ceiling is
 * unset/zero — applyDecompress semantics (active flip, restore data
 * accounting, missing-block and duplicate-restore rejection, no
 * transcript mutation, next-round view expansion via fold), the stale
 * status (record kept readable, restore refused with guidance, recall
 * labelled), and recall summary truncation.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  applyDecompress,
  evaluateGate,
  recallOutput,
  resolveTarget,
  truncateRecallSummary,
} from "./decompress.js";
import { fold } from "./fold.js";
import type { HostMessage } from "./lens.js";
import { makeAssistantMsg, makeMsg, projectMessages } from "./lens-testkit.js";
import { computeSpanHash } from "./spanhash.js";
import {
  type Block,
  hasActiveOverlap,
  RECALL_MAX_CHARS,
  type SessionState,
} from "./state.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A fresh empty session state (new Block model). */
function makeState(): SessionState {
  return { blocks: new Map(), marks: new Map() };
}

/** Alternating user/assistant messages, enough for multi-block spans. */
function makeTranscript(count: number): HostMessage[] {
  const msgs: HostMessage[] = [];
  for (let i = 0; i < count; i++) {
    msgs.push(
      i % 2 === 0
        ? makeMsg("user", [`prompt ${i}`])
        : makeAssistantMsg({ text: `reply ${i}` }),
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
    compressedTokens: 1000,
    summaryTokens: 60,
    createdAt: 1000,
    ...overrides,
  };
}

// ===========================================================================
// resolveTarget
// ===========================================================================

describe("resolveTarget", () => {
  it("throws a loud Chinese format error for invalid ids", () => {
    const state = makeState();
    for (const bad of ["1", "3", "b0", "b-1", "bx", "", "b"]) {
      assert.throws(
        () => resolveTarget(state, bad),
        (err: unknown) =>
          err instanceof Error &&
          /格式非法/.test(err.message) &&
          /\[Block bN · K 条\]/.test(err.message) &&
          /--- bN/.test(err.message),
      );
    }
  });

  it("throws a loud Chinese not-found error listing the available block numbers", () => {
    const history = makeTranscript(8);
    const state = makeState();
    state.blocks.set(1, makeBlock(history, 1, 3));
    state.blocks.set(2, makeBlock(history, 3, 5));
    assert.throws(
      () => resolveTarget(state, "b99"),
      (err: unknown) =>
        err instanceof Error &&
        /不存在/.test(err.message) &&
        /b1、b2/.test(err.message) &&
        /请勿凭记忆编造编号/.test(err.message),
    );
  });

  it("throws a distinct not-found error when no block exists at all", () => {
    const state = makeState();
    assert.throws(
      () => resolveTarget(state, "b1"),
      (err: unknown) =>
        err instanceof Error &&
        /不存在/.test(err.message) &&
        /没有已创建的压缩块/.test(err.message),
    );
  });

  it("resolves an active block to kind restore with its numeric id", () => {
    const history = makeTranscript(6);
    const state = makeState();
    state.blocks.set(3, makeBlock(history, 0, 3));
    const result = resolveTarget(state, "b3");
    assert.equal(result.kind, "restore");
    assert.equal(result.blockId, 3);
    assert.equal(result.block, state.blocks.get(3));
  });

  it("resolves a consumed block to kind recall (the restore is refused)", () => {
    const history = makeTranscript(6);
    const state = makeState();
    state.blocks.set(1, makeBlock(history, 1, 4, { status: "consumed" }));
    const result = resolveTarget(state, "b1");
    assert.equal(result.kind, "recall");
    assert.equal(result.blockId, 1);
    assert.equal(result.block, state.blocks.get(1));
  });

  it("recall is idempotent — repeated resolution of the same terminal block never errors", () => {
    const history = makeTranscript(6);
    const state = makeState();
    state.blocks.set(1, makeBlock(history, 1, 4, { status: "consumed" }));
    const r1 = resolveTarget(state, "b1");
    const r2 = resolveTarget(state, "b1");
    assert.equal(r1.kind, "recall");
    assert.equal(r2.kind, "recall");
    assert.equal(r1.block.summary, "summary [1, 4)");
    assert.equal(r2.block.summary, "summary [1, 4)");
  });
});

// ===========================================================================
// evaluateGate
// ===========================================================================

describe("evaluateGate", () => {
  it("allows when the estimated after equals the threshold (boundary passes)", () => {
    const history = makeTranscript(6);
    const block = makeBlock(history, 0, 3, {
      compressedTokens: 1000,
      summaryTokens: 500,
    });
    // after = 0 + (1000 - 500) = 500; threshold = 1000 * 50 / 100 = 500.
    assert.deepEqual(evaluateGate(0, block, 1, 1000, 50), { allowed: true });
  });

  it("allows when the estimated after stays below the threshold", () => {
    const history = makeTranscript(6);
    const block = makeBlock(history, 0, 3, {
      compressedTokens: 400,
      summaryTokens: 200,
    });
    // after = 0 + 200 = 200 < threshold 500.
    assert.deepEqual(evaluateGate(0, block, 1, 1000, 50), { allowed: true });
  });

  it("rejects when the estimated after exceeds the threshold, with delta, fill rates, and guidance", () => {
    const history = makeTranscript(6);
    const block = makeBlock(history, 0, 3, {
      compressedTokens: 1000,
      summaryTokens: 500,
    });
    // after = 100 + 500 = 600 > threshold 500; fill 10% → 60%.
    const result = evaluateGate(100, block, 1, 1000, 50);
    assert.equal(result.allowed, false);
    assert.ok(result.reason.includes("600"));
    assert.ok(result.reason.includes("500"));
    assert.ok(result.reason.includes("100"));
    assert.ok(result.reason.includes("10%"));
    assert.ok(result.reason.includes("60%"));
    assert.ok(/超过/.test(result.reason));
    assert.ok(/回胀/.test(result.reason));
    assert.ok(/腾出空间/.test(result.reason));
  });

  it("skips the gate when the context limit is missing (allowed)", () => {
    const history = makeTranscript(6);
    const block = makeBlock(history, 0, 3, {
      compressedTokens: 999999,
      summaryTokens: 0,
    });
    assert.deepEqual(evaluateGate(100000, block, 1, undefined, 50), {
      allowed: true,
    });
  });

  it("skips the gate when maxFillPercent is unset (allowed)", () => {
    const history = makeTranscript(6);
    const block = makeBlock(history, 0, 3, {
      compressedTokens: 999999,
      summaryTokens: 0,
    });
    assert.deepEqual(evaluateGate(100000, block, 1, 1000, undefined), {
      allowed: true,
    });
  });

  it("skips the gate when maxFillPercent is zero (allowed)", () => {
    const history = makeTranscript(6);
    const block = makeBlock(history, 0, 3, {
      compressedTokens: 999999,
      summaryTokens: 0,
    });
    assert.deepEqual(evaluateGate(100000, block, 1, 1000, 0), {
      allowed: true,
    });
  });
});

// ===========================================================================
// applyDecompress
// ===========================================================================

describe("applyDecompress", () => {
  it("moves an active block to consumed and returns the restore data accounting", () => {
    const history = makeTranscript(8);
    const state = makeState();
    state.blocks.set(
      1,
      makeBlock(history, 1, 4, {
        summary: "该段的摘要正文",
        compressedTokens: 20000,
        summaryTokens: 500,
      }),
    );
    const result = applyDecompress(state, 1, history);

    assert.equal(state.blocks.get(1)?.status, "consumed");
    assert.deepEqual(result, {
      blockId: 1,
      summary: "该段的摘要正文",
      start: 1,
      end: 4,
      messageCount: 3,
      restoredTokens: 19500,
      compressedTokens: 20000,
      summaryTokens: 500,
    });
  });

  it("counts only the covered messages actually present in the transcript", () => {
    const history = makeTranscript(3);
    const state = makeState();
    // Block span [1, 5) — the transcript was truncated to 3 messages, so
    // only ordinals 1..2 still exist (the span hash is not consulted by
    // applyDecompress and is deliberately stale).
    state.blocks.set(1, {
      start: 1,
      end: 5,
      spanHash: "deadbeef",
      summary: "truncated span",
      status: "active",
      compressedTokens: 1000,
      summaryTokens: 60,
      createdAt: 1000,
    });
    const result = applyDecompress(state, 1, history);
    assert.equal(result.messageCount, 2);
    assert.equal(state.blocks.get(1)?.status, "consumed");
  });

  it("throws the loud not-found error for a missing block id", () => {
    const state = makeState();
    assert.throws(
      () => applyDecompress(state, 9, []),
      (err: unknown) =>
        err instanceof Error &&
        /不存在/.test(err.message) &&
        /没有已创建的压缩块/.test(err.message),
    );
  });

  it("refuses a duplicate restore of an already-consumed block", () => {
    const history = makeTranscript(6);
    const state = makeState();
    state.blocks.set(1, makeBlock(history, 1, 4, { status: "consumed" }));
    assert.throws(
      () => applyDecompress(state, 1, history),
      (err: unknown) =>
        err instanceof Error &&
        /已不能恢复原文/.test(err.message) &&
        /本次不会恢复原文/.test(err.message),
    );
    // The refusal changes nothing — the record keeps its status.
    assert.equal(state.blocks.get(1)?.status, "consumed");
  });

  it("never mutates the transcript — view expansion is fold's job", () => {
    const history = makeTranscript(6);
    const state = makeState();
    state.blocks.set(1, makeBlock(history, 1, 4));
    const before = history.map((msg) =>
      msg.regions.map((region) => region.get()),
    );
    applyDecompress(state, 1, history);
    assert.deepEqual(
      history.map((msg) => msg.regions.map((region) => region.get())),
      before,
    );
  });

  it("unfolds the interval on the next fold round (two-round view effect)", () => {
    const history = makeTranscript(6);
    const state = makeState();
    state.blocks.set(1, makeBlock(history, 1, 4));
    // While active, the block folds its interval into one summary item.
    const folded = fold(projectMessages(history), state);
    assert.equal(folded.items[1].type, "summary");

    applyDecompress(state, 1, history);
    const unfolded = fold(projectMessages(history), state);
    assert.deepEqual(unfolded.items, [
      { type: "original", ordinal: 0 },
      { type: "original", ordinal: 1 },
      { type: "original", ordinal: 2 },
      { type: "original", ordinal: 3 },
      { type: "original", ordinal: 4 },
      { type: "original", ordinal: 5 },
    ]);
  });
});

// ===========================================================================
// Stale blocks — readable but no longer restorable
// ===========================================================================

describe("stale blocks", () => {
  it("stay addressable and resolve to recall", () => {
    const history = makeTranscript(6);
    const state = makeState();
    state.blocks.set(1, makeBlock(history, 1, 4, { status: "stale" }));

    const result = resolveTarget(state, "b1");

    assert.equal(result.kind, "recall");
    assert.equal(result.blockId, 1);
  });

  it("keep their title and summary readable after invalidation", () => {
    const history = makeTranscript(6);
    const state = makeState();
    state.blocks.set(
      1,
      makeBlock(history, 1, 4, {
        status: "stale",
        title: "失效段主题",
        summary: "要点一：区间已不再指向原内容。",
      }),
    );

    const result = resolveTarget(state, "b1");

    assert.equal(result.block.title, "失效段主题");
    assert.equal(result.block.summary, "要点一：区间已不再指向原内容。");
  });

  it("are refused a restore with guidance that the original is gone", () => {
    const history = makeTranscript(6);
    const state = makeState();
    state.blocks.set(1, makeBlock(history, 1, 4, { status: "stale" }));

    assert.throws(
      () => applyDecompress(state, 1, history),
      (err: unknown) =>
        err instanceof Error &&
        /已失效，无法恢复/.test(err.message) &&
        /原文无法取回/.test(err.message) &&
        /只能读取仍保存的摘要/.test(err.message),
    );
    // The refusal changes nothing — the record keeps its status.
    assert.equal(state.blocks.get(1)?.status, "stale");
  });

  it("are listed by the not-found error like any other retained block", () => {
    const history = makeTranscript(6);
    const state = makeState();
    state.blocks.set(1, makeBlock(history, 1, 4, { status: "stale" }));

    assert.throws(
      () => resolveTarget(state, "b9"),
      (err: unknown) =>
        err instanceof Error && /共有 1 个压缩块：b1/.test(err.message),
    );
  });

  it("are still counted as covering nothing in the overlap check", () => {
    const history = makeTranscript(6);
    const state = makeState();
    state.blocks.set(1, makeBlock(history, 1, 4, { status: "stale" }));

    // A stale block folds no interval, so a new block may cover it.
    assert.equal(hasActiveOverlap(state, 2, 3), false);
  });
});

// ===========================================================================
// recallOutput
// ===========================================================================

describe("recallOutput", () => {
  it("frames a consumed recall as read-only with the summary body", () => {
    const history = makeTranscript(6);
    const block = makeBlock(history, 1, 4, {
      status: "consumed",
      summary: "普通摘要正文",
    });

    const output = recallOutput(block, 7);

    assert.ok(output.includes("b7"), output);
    // The framing must rule out the "the original text is back" reading.
    assert.ok(output.includes("未恢复原文"), output);
    assert.ok(output.endsWith("普通摘要正文"), output);
    assert.ok(!output.includes("[1, 4)"), output);
  });

  it("frames an active block's recall the same read-only way", () => {
    const history = makeTranscript(6);
    const block = makeBlock(history, 1, 4, { summary: "活跃摘要正文" });

    const output = recallOutput(block, 2);

    assert.ok(output.includes("未恢复原文"), output);
    assert.ok(output.endsWith("活跃摘要正文"), output);
  });

  it("labels a stale recall as all that survives of the interval", () => {
    const history = makeTranscript(6);
    const block = makeBlock(history, 1, 4, {
      status: "stale",
      summary: "仅存的摘要",
    });

    const output = recallOutput(block, 1);

    assert.ok(
      output.startsWith("【只读召回 · 未恢复原文】压缩块 b1 已失效"),
      output,
    );
    assert.ok(output.includes("原文不可能再被恢复"), output);
    assert.ok(output.endsWith("仅存的摘要"), output);
  });

  it("truncates an over-cap stale summary under the note", () => {
    const history = makeTranscript(6);
    const block = makeBlock(history, 1, 4, {
      status: "stale",
      summary: "z".repeat(RECALL_MAX_CHARS + 10),
    });

    const output = recallOutput(block, 1);

    assert.ok(
      output.includes("[摘要过长已截断：省略 10 字符，省略部分无法取回]"),
      output,
    );
    // The truncation note stays inside the body, below the status note.
    assert.ok(output.startsWith("【只读召回 · 未恢复原文】"), output);
  });
});

// ===========================================================================
// truncateRecallSummary
// ===========================================================================

describe("truncateRecallSummary", () => {
  it("truncates an over-cap summary with a Chinese tail note", () => {
    const long = "x".repeat(RECALL_MAX_CHARS + 500);
    const result = truncateRecallSummary(long);
    assert.equal(
      result,
      `${"x".repeat(RECALL_MAX_CHARS)}\n[摘要过长已截断：省略 500 字符，省略部分无法取回]`,
    );
  });

  it("returns an exactly-cap summary untouched", () => {
    const exact = "y".repeat(RECALL_MAX_CHARS);
    assert.equal(truncateRecallSummary(exact), exact);
  });

  it("returns an under-cap summary untouched", () => {
    const short = "短摘要";
    assert.equal(truncateRecallSummary(short), short);
  });
});
