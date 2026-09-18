/**
 * Tests for the pure fold view (`fold.ts`).
 *
 * Covers: basic folding (head block → one summary + trailing
 * originals), adjacent and nested block view layout, silent expansion of
 * hash-invalidated blocks with `viewChanged` / `expiredBlockIds`
 * reporting (spanhash linkage), terminal blocks (consumed / stale) never
 * refolding (unfold protection), the defensive overlapping-block merge
 * branch, empty-history and no-block pass-through, hidden-message
 * visibility, unit-granular folding (call/result units; a block whose
 * boundary falls inside a unit does not fold), and fold purity.
 * Fixtures are built through the lens testkit; block hashes come from
 * `computeSpanHash`.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fold } from "./fold.js";
import type { HostMessage } from "./lens.js";
import {
  makeAssistantMsg,
  makeMsg,
  makeToolResultMsg,
  projectMessages,
  setRegionText,
} from "./lens-testkit.js";
import { computeSpanHash } from "./spanhash.js";
import type { Block, SessionState } from "./state.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A fresh empty session state. */
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
    compressedTokens: 100,
    summaryTokens: 10,
    createdAt: 1000,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. Basic folding
// ---------------------------------------------------------------------------

describe("basic fold", () => {
  it("a head block folds into one summary followed by trailing originals", () => {
    const history = makeTranscript(6);
    const state = makeState();
    state.blocks.set(1, makeBlock(history, 0, 3));
    const result = fold(projectMessages(history), state);
    assert.deepEqual(result.items, [
      { type: "summary", block: state.blocks.get(1) },
      { type: "original", start: 3, end: 4 },
      { type: "original", start: 4, end: 5 },
      { type: "original", start: 5, end: 6 },
    ]);
    assert.equal(result.viewChanged, false);
    assert.deepEqual(result.expiredBlockIds, []);
  });

  it("a mid-history block keeps both gap and trailing originals", () => {
    const history = makeTranscript(6);
    const state = makeState();
    state.blocks.set(1, makeBlock(history, 2, 4));
    const result = fold(projectMessages(history), state);
    assert.deepEqual(result.items, [
      { type: "original", start: 0, end: 1 },
      { type: "original", start: 1, end: 2 },
      { type: "summary", block: state.blocks.get(1) },
      { type: "original", start: 4, end: 5 },
      { type: "original", start: 5, end: 6 },
    ]);
    assert.equal(result.viewChanged, false);
    assert.deepEqual(result.expiredBlockIds, []);
  });

  it("a tail block folds while keeping the leading originals", () => {
    const history = makeTranscript(6);
    const state = makeState();
    state.blocks.set(1, makeBlock(history, 3, 6));
    const result = fold(projectMessages(history), state);
    assert.deepEqual(result.items, [
      { type: "original", start: 0, end: 1 },
      { type: "original", start: 1, end: 2 },
      { type: "original", start: 2, end: 3 },
      { type: "summary", block: state.blocks.get(1) },
    ]);
    assert.equal(result.viewChanged, false);
    assert.deepEqual(result.expiredBlockIds, []);
  });
});

// ---------------------------------------------------------------------------
// 2. Adjacent and nested block views
// ---------------------------------------------------------------------------

describe("adjacent and nested block views", () => {
  it("adjacent (touching) blocks each keep their own summary item", () => {
    const history = makeTranscript(8);
    const state = makeState();
    state.blocks.set(1, makeBlock(history, 1, 3));
    state.blocks.set(2, makeBlock(history, 3, 5));
    const result = fold(projectMessages(history), state);
    assert.deepEqual(result.items, [
      { type: "original", start: 0, end: 1 },
      { type: "summary", block: state.blocks.get(1) },
      { type: "summary", block: state.blocks.get(2) },
      { type: "original", start: 5, end: 6 },
      { type: "original", start: 6, end: 7 },
      { type: "original", start: 7, end: 8 },
    ]);
    assert.equal(result.viewChanged, false);
    assert.deepEqual(result.expiredBlockIds, []);
  });

  it("a nested block merges into the containing summary item", () => {
    const history = makeTranscript(8);
    const state = makeState();
    state.blocks.set(1, makeBlock(history, 1, 5));
    state.blocks.set(2, makeBlock(history, 2, 4)); // inside block 1
    const result = fold(projectMessages(history), state);
    assert.deepEqual(result.items, [
      { type: "original", start: 0, end: 1 },
      { type: "summary", block: state.blocks.get(1) },
      { type: "original", start: 5, end: 6 },
      { type: "original", start: 6, end: 7 },
      { type: "original", start: 7, end: 8 },
    ]);
    assert.equal(result.viewChanged, false);
    assert.deepEqual(result.expiredBlockIds, []);
  });
});

// ---------------------------------------------------------------------------
// 3. Hash-invalidated blocks silently expand — spanhash link
// ---------------------------------------------------------------------------

describe("hash-invalid blocks silently expand", () => {
  it("a content edit inside the span invalidates the block (spanhash link)", () => {
    const history = makeTranscript(6);
    const state = makeState();
    state.blocks.set(7, makeBlock(history, 1, 4));
    // Rewrite the content of the message at ordinal 2 — the block's span
    // no longer hashes to the stored value.
    setRegionText(history[2], 0, "edited question");
    const result = fold(projectMessages(history), state);
    assert.deepEqual(result.expiredBlockIds, [7]);
    assert.equal(result.viewChanged, true);
    // Silent expansion: no summary item and no tombstone hint; the edited
    // message reappears as a plain original item.
    assert.deepEqual(result.items, [
      { type: "original", start: 0, end: 1 },
      { type: "original", start: 1, end: 2 },
      { type: "original", start: 2, end: 3 },
      { type: "original", start: 3, end: 4 },
      { type: "original", start: 4, end: 5 },
      { type: "original", start: 5, end: 6 },
    ]);
  });

  it("a truncation cutting into the span expires the block (out of bounds)", () => {
    const history = makeTranscript(6);
    const state = makeState();
    state.blocks.set(7, makeBlock(history, 1, 4));
    const truncated = history.slice(0, 3); // block end 4 > length 3
    const result = fold(projectMessages(truncated), state);
    assert.deepEqual(result.expiredBlockIds, [7]);
    assert.equal(result.viewChanged, true);
    assert.deepEqual(result.items, [
      { type: "original", start: 0, end: 1 },
      { type: "original", start: 1, end: 2 },
      { type: "original", start: 2, end: 3 },
    ]);
  });

  it("only the invalid block expires; other valid blocks still fold", () => {
    const history = makeTranscript(6);
    const state = makeState();
    state.blocks.set(1, makeBlock(history, 1, 3));
    state.blocks.set(2, makeBlock(history, 4, 6, { spanHash: "deadbeef" }));
    const result = fold(projectMessages(history), state);
    assert.deepEqual(result.expiredBlockIds, [2]);
    assert.equal(result.viewChanged, true);
    assert.deepEqual(result.items, [
      { type: "original", start: 0, end: 1 },
      { type: "summary", block: state.blocks.get(1) },
      { type: "original", start: 3, end: 4 },
      { type: "original", start: 4, end: 5 },
      { type: "original", start: 5, end: 6 },
    ]);
  });
});

// ---------------------------------------------------------------------------
// 4. Terminal blocks never refold (unfold protection)
// ---------------------------------------------------------------------------

describe("terminal blocks never refold", () => {
  it("a consumed block expands to originals and stays expanded", () => {
    const history = makeTranscript(6);
    const state = makeState();
    state.blocks.set(1, makeBlock(history, 1, 4));
    // While active, the block folds its interval into one summary.
    const before = fold(projectMessages(history), state);
    assert.equal(before.items.length, 4); // orig 0 + summary + orig 4 + orig 5
    assert.equal(before.items[1].type, "summary");

    // Consume it — fold must not re-fold it (no other refold path exists).
    const block = state.blocks.get(1);
    assert.ok(block !== undefined);
    block.status = "consumed";
    const result = fold(projectMessages(history), state);
    assert.deepEqual(result.items, [
      { type: "original", start: 0, end: 1 },
      { type: "original", start: 1, end: 2 },
      { type: "original", start: 2, end: 3 },
      { type: "original", start: 3, end: 4 },
      { type: "original", start: 4, end: 5 },
      { type: "original", start: 5, end: 6 },
    ]);
    // A block that already stopped folding is steady state, not a change
    // this round made — and it is never reported as expired.
    assert.equal(result.viewChanged, false);
    assert.deepEqual(result.expiredBlockIds, []);
    // The block object is untouched by fold.
    assert.equal(block.status, "consumed");
    assert.equal(state.blocks.size, 1);
  });

  it("a stale block expands, is not re-validated, and never re-expires", () => {
    const history = makeTranscript(6);
    const state = makeState();
    // The stored hash addresses content that is no longer there.
    state.blocks.set(
      1,
      makeBlock(history, 1, 4, { status: "stale", spanHash: "deadbeef" }),
    );

    const result = fold(projectMessages(history), state);

    // Reporting no expiry proves the span was never re-hashed: a stale
    // block is a terminal status, not a pending re-check.
    assert.deepEqual(result.expiredBlockIds, []);
    assert.equal(result.viewChanged, false);
    assert.equal(result.items.length, 6);
    assert.ok(result.items.every((item) => item.type === "original"));
  });

  it("a stale block alongside active blocks leaves them folding", () => {
    const history = makeTranscript(8);
    const state = makeState();
    state.blocks.set(1, makeBlock(history, 1, 3, { status: "stale" }));
    state.blocks.set(2, makeBlock(history, 4, 7));

    const result = fold(projectMessages(history), state);

    assert.deepEqual(result.expiredBlockIds, []);
    assert.equal(result.viewChanged, false);
    assert.deepEqual(result.items, [
      { type: "original", start: 0, end: 1 },
      { type: "original", start: 1, end: 2 },
      { type: "original", start: 2, end: 3 },
      { type: "original", start: 3, end: 4 },
      { type: "summary", block: state.blocks.get(2) },
      { type: "original", start: 7, end: 8 },
    ]);
  });
});

// ---------------------------------------------------------------------------
// 5. Overlapping surviving blocks merge — defensive branch
// ---------------------------------------------------------------------------

describe("overlapping surviving blocks merge (defensive branch)", () => {
  it("two intersecting blocks fold into one summary over the union", () => {
    const history = makeTranscript(8);
    const state = makeState();
    state.blocks.set(1, makeBlock(history, 1, 4));
    state.blocks.set(2, makeBlock(history, 3, 6));
    const result = fold(projectMessages(history), state);
    // Union [1, 6) is covered by a single summary rendered from the
    // first-appearing block (id 1); ordinals 0, 6, 7 stay original.
    assert.deepEqual(result.items, [
      { type: "original", start: 0, end: 1 },
      { type: "summary", block: state.blocks.get(1) },
      { type: "original", start: 6, end: 7 },
      { type: "original", start: 7, end: 8 },
    ]);
    assert.equal(result.viewChanged, false);
    assert.deepEqual(result.expiredBlockIds, []);
  });

  it("three overlapping blocks collapse into one item", () => {
    const history = makeTranscript(8);
    const state = makeState();
    state.blocks.set(1, makeBlock(history, 1, 4));
    state.blocks.set(2, makeBlock(history, 3, 5));
    state.blocks.set(3, makeBlock(history, 4, 7));
    const result = fold(projectMessages(history), state);
    assert.deepEqual(result.items, [
      { type: "original", start: 0, end: 1 },
      { type: "summary", block: state.blocks.get(1) },
      { type: "original", start: 7, end: 8 },
    ]);
  });

  it("a block extending past its container extends the merged union", () => {
    const history = makeTranscript(8);
    const state = makeState();
    state.blocks.set(1, makeBlock(history, 1, 5));
    state.blocks.set(2, makeBlock(history, 3, 6)); // overlaps and extends
    const result = fold(projectMessages(history), state);
    assert.deepEqual(result.items, [
      { type: "original", start: 0, end: 1 },
      { type: "summary", block: state.blocks.get(1) },
      { type: "original", start: 6, end: 7 },
      { type: "original", start: 7, end: 8 },
    ]);
  });
});

// ---------------------------------------------------------------------------
// 6. Empty history / no blocks pass through
// ---------------------------------------------------------------------------

describe("empty history and no blocks pass through", () => {
  it("empty history with no blocks yields an empty view", () => {
    const result = fold(projectMessages([]), makeState());
    assert.deepEqual(result.items, []);
    assert.equal(result.viewChanged, false);
    assert.deepEqual(result.expiredBlockIds, []);
  });

  it("messages with no blocks pass through as originals", () => {
    const history = makeTranscript(3);
    const result = fold(projectMessages(history), makeState());
    assert.deepEqual(result.items, [
      { type: "original", start: 0, end: 1 },
      { type: "original", start: 1, end: 2 },
      { type: "original", start: 2, end: 3 },
    ]);
    assert.equal(result.viewChanged, false);
    assert.deepEqual(result.expiredBlockIds, []);
  });

  it("hidden messages appear as originals (fold does no hidden filtering)", () => {
    const history = [
      makeMsg("user", ["prompt"]),
      makeMsg("assistant", ["hidden reply"], { hidden: true }),
      makeMsg("user", ["next"]),
    ];
    const result = fold(projectMessages(history), makeState());
    assert.deepEqual(result.items, [
      { type: "original", start: 0, end: 1 },
      { type: "original", start: 1, end: 2 },
      { type: "original", start: 2, end: 3 },
    ]);
  });

  it("a hidden message inside a block span is folded with it", () => {
    const history = [
      makeMsg("user", ["prompt"]),
      makeMsg("assistant", ["hidden"], { hidden: true }),
      makeMsg("user", ["next"]),
    ];
    const state = makeState();
    state.blocks.set(1, makeBlock(history, 0, 3));
    const result = fold(projectMessages(history), state);
    assert.deepEqual(result.items, [
      { type: "summary", block: state.blocks.get(1) },
    ]);
  });

  it("an empty history with a block expires the block (span out of bounds)", () => {
    const state = makeState();
    state.blocks.set(1, makeBlock([makeMsg("user", ["prompt"])], 0, 1));
    const result = fold(projectMessages([]), state);
    assert.deepEqual(result.items, []);
    assert.equal(result.viewChanged, true);
    assert.deepEqual(result.expiredBlockIds, [1]);
  });
});

// ---------------------------------------------------------------------------
// 7. Unit correspondence
// ---------------------------------------------------------------------------

describe("unit correspondence", () => {
  it("original items cover exactly the uncovered units, in order", () => {
    const history = makeTranscript(8);
    const state = makeState();
    state.blocks.set(1, makeBlock(history, 1, 3));
    state.blocks.set(2, makeBlock(history, 5, 6));
    const result = fold(projectMessages(history), state);
    assert.deepEqual(result.items, [
      { type: "original", start: 0, end: 1 },
      { type: "summary", block: state.blocks.get(1) },
      { type: "original", start: 3, end: 4 },
      { type: "original", start: 4, end: 5 },
      { type: "summary", block: state.blocks.get(2) },
      { type: "original", start: 6, end: 7 },
      { type: "original", start: 7, end: 8 },
    ]);
    // With no invocations every unit is a single message: the original
    // intervals are the complement of the covered ordinals {1, 2, 5} —
    // each a one-message interval, in bounds.
    const originals = result.items
      .filter(
        (item): item is { type: "original"; start: number; end: number } =>
          item.type === "original",
      )
      .map((item) => [item.start, item.end]);
    assert.deepEqual(originals, [
      [0, 1],
      [3, 4],
      [4, 5],
      [6, 7],
      [7, 8],
    ]);
    for (const [start, end] of originals) {
      assert.equal(end - start, 1);
      assert.ok(start >= 0 && end <= history.length);
    }
  });
});

// ---------------------------------------------------------------------------
// 8. Unit folding
// ---------------------------------------------------------------------------

/**
 * A transcript whose middle unit is a two-call batch: assistant message 1
 * issues two calls whose results land in messages 2 and 3.
 */
function batchTranscript(): HostMessage[] {
  return [
    makeMsg("user", ["q"]),
    makeAssistantMsg({
      toolCalls: [
        { name: "bash", input: "a", output: "ra", outputRef: { ordinal: 2 } },
        { name: "read", input: "b", output: "rb", outputRef: { ordinal: 3 } },
      ],
    }),
    makeToolResultMsg("ra"),
    makeToolResultMsg("rb"),
    makeMsg("user", ["next"]),
  ];
}

describe("unit folding", () => {
  it("keeps a parallel call batch as one original unit", () => {
    const history = batchTranscript();
    const result = fold(projectMessages(history), makeState());
    assert.deepEqual(result.items, [
      { type: "original", start: 0, end: 1 },
      { type: "original", start: 1, end: 4 },
      { type: "original", start: 4, end: 5 },
    ]);
  });

  it("folds a block that covers a whole call/result unit", () => {
    const history = batchTranscript();
    const state = makeState();
    state.blocks.set(1, makeBlock(history, 1, 4));
    const result = fold(projectMessages(history), state);
    assert.deepEqual(result.items, [
      { type: "original", start: 0, end: 1 },
      { type: "summary", block: state.blocks.get(1) },
      { type: "original", start: 4, end: 5 },
    ]);
  });

  it("does not fold a block whose boundary falls inside a unit", () => {
    // A block whose end sits mid unit has no seam-aligned interval; fold
    // leaves it to the silent expansion path and the units stay whole.
    const history = batchTranscript();
    const state = makeState();
    state.blocks.set(1, makeBlock(history, 0, 2));
    const result = fold(projectMessages(history), state);
    assert.deepEqual(result.items, [
      { type: "original", start: 0, end: 1 },
      { type: "original", start: 1, end: 4 },
      { type: "original", start: 4, end: 5 },
    ]);
    // An off-seam block is neither expired nor a view change: it is not
    // a hash failure, it just cannot fold.
    assert.equal(result.viewChanged, false);
    assert.deepEqual(result.expiredBlockIds, []);
  });

  it("an off-seam block does not block a later seam-aligned block", () => {
    // The off-seam block is dropped before the walk, so the aligned block
    // after its interval still folds.
    const history = batchTranscript();
    const state = makeState();
    state.blocks.set(1, makeBlock(history, 0, 2));
    state.blocks.set(2, makeBlock(history, 4, 5));
    const result = fold(projectMessages(history), state);
    assert.deepEqual(result.items, [
      { type: "original", start: 0, end: 1 },
      { type: "original", start: 1, end: 4 },
      { type: "summary", block: state.blocks.get(2) },
    ]);
    assert.equal(result.viewChanged, false);
    assert.deepEqual(result.expiredBlockIds, []);
  });
});

// ---------------------------------------------------------------------------
// 9. Purity
// ---------------------------------------------------------------------------

describe("fold is pure", () => {
  it("returns a fresh items array on every call", () => {
    const history = makeTranscript(3);
    const first = fold(projectMessages(history), makeState());
    const second = fold(projectMessages(history), makeState());
    assert.notEqual(first.items, second.items);
    assert.notEqual(first.items, history);
  });

  it("never mutates the history or the block state", () => {
    const history = makeTranscript(6);
    const state = makeState();
    state.blocks.set(1, makeBlock(history, 1, 4));
    const historyBefore = history.map((msg) =>
      msg.regions.map((region) => region.get()),
    );
    const stored = state.blocks.get(1);
    assert.ok(stored !== undefined);
    const blockBefore = { ...stored };
    fold(projectMessages(history), state);
    assert.deepEqual(
      history.map((msg) => msg.regions.map((region) => region.get())),
      historyBefore,
    );
    assert.deepEqual(state.blocks.get(1), blockBefore);
    assert.equal(state.blocks.size, 1);
    assert.equal(state.marks.size, 0);
  });

  it("an invalid block is reported but not mutated or removed", () => {
    const history = makeTranscript(6);
    const state = makeState();
    state.blocks.set(1, makeBlock(history, 1, 4));
    setRegionText(history[2], 0, "edited");
    const result = fold(projectMessages(history), state);
    assert.deepEqual(result.expiredBlockIds, [1]);
    // The status transition is the caller's decision — fold only reports.
    assert.equal(state.blocks.get(1)?.status, "active");
    assert.equal(state.blocks.size, 1);
  });
});
