/**
 * Tests for the pure fold view (`fold.ts`).
 *
 * Covers the C1 fold-semantics checklist: basic folding (head block →
 * one summary + trailing originals, C1-01), adjacent and nested block
 * view layout, silent expansion of hash-invalidated blocks with
 * `viewChanged` / `expiredBlockIds` reporting (C1-05, C1-10, spanhash
 * linkage), inactive blocks never refolding (C1-08/C1-10 unfold
 * protection), the defensive overlapping-block merge branch (spec
 * Decision 5), empty-history and no-block pass-through (C1-05),
 * hidden-message visibility, exact ordinal correspondence between
 * original items and the transcript (C1-01), and fold purity (C1-08).
 * Fixtures are built through the lens testkit; block hashes come from
 * `computeSpanHash`.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fold } from "./fold.js";
import type { HostMessage } from "./lens.js";
import { makeAssistantMsg, makeMsg, setRegionText } from "./lens-testkit.js";
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
    spanHash: computeSpanHash(history, start, end),
    active: true,
    compressedTokens: 100,
    summaryTokens: 10,
    createdAt: 1000,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. Basic folding — C1-01
// ---------------------------------------------------------------------------

describe("basic fold", () => {
  it("a head block folds into one summary followed by trailing originals", () => {
    const history = makeTranscript(6);
    const state = makeState();
    state.blocks.set(1, makeBlock(history, 0, 3));
    const result = fold(history, state);
    assert.deepEqual(result.items, [
      { type: "summary", block: state.blocks.get(1) },
      { type: "original", ordinal: 3 },
      { type: "original", ordinal: 4 },
      { type: "original", ordinal: 5 },
    ]);
    assert.equal(result.viewChanged, false);
    assert.deepEqual(result.expiredBlockIds, []);
  });

  it("a mid-history block keeps both gap and trailing originals", () => {
    const history = makeTranscript(6);
    const state = makeState();
    state.blocks.set(1, makeBlock(history, 2, 4));
    const result = fold(history, state);
    assert.deepEqual(result.items, [
      { type: "original", ordinal: 0 },
      { type: "original", ordinal: 1 },
      { type: "summary", block: state.blocks.get(1) },
      { type: "original", ordinal: 4 },
      { type: "original", ordinal: 5 },
    ]);
    assert.equal(result.viewChanged, false);
    assert.deepEqual(result.expiredBlockIds, []);
  });

  it("a tail block folds while keeping the leading originals", () => {
    const history = makeTranscript(6);
    const state = makeState();
    state.blocks.set(1, makeBlock(history, 3, 6));
    const result = fold(history, state);
    assert.deepEqual(result.items, [
      { type: "original", ordinal: 0 },
      { type: "original", ordinal: 1 },
      { type: "original", ordinal: 2 },
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
    const result = fold(history, state);
    assert.deepEqual(result.items, [
      { type: "original", ordinal: 0 },
      { type: "summary", block: state.blocks.get(1) },
      { type: "summary", block: state.blocks.get(2) },
      { type: "original", ordinal: 5 },
      { type: "original", ordinal: 6 },
      { type: "original", ordinal: 7 },
    ]);
    assert.equal(result.viewChanged, false);
    assert.deepEqual(result.expiredBlockIds, []);
  });

  it("a nested block merges into the containing summary item", () => {
    const history = makeTranscript(8);
    const state = makeState();
    state.blocks.set(1, makeBlock(history, 1, 5));
    state.blocks.set(2, makeBlock(history, 2, 4)); // inside block 1
    const result = fold(history, state);
    assert.deepEqual(result.items, [
      { type: "original", ordinal: 0 },
      { type: "summary", block: state.blocks.get(1) },
      { type: "original", ordinal: 5 },
      { type: "original", ordinal: 6 },
      { type: "original", ordinal: 7 },
    ]);
    assert.equal(result.viewChanged, false);
    assert.deepEqual(result.expiredBlockIds, []);
  });
});

// ---------------------------------------------------------------------------
// 3. Hash-invalidated blocks silently expand — C1-05, C1-10, spanhash link
// ---------------------------------------------------------------------------

describe("hash-invalid blocks silently expand", () => {
  it("a content edit inside the span invalidates the block (spanhash link)", () => {
    const history = makeTranscript(6);
    const state = makeState();
    state.blocks.set(7, makeBlock(history, 1, 4));
    // Rewrite the content of the message at ordinal 2 — the block's span
    // no longer hashes to the stored value.
    setRegionText(history[2], 0, "edited question");
    const result = fold(history, state);
    assert.deepEqual(result.expiredBlockIds, [7]);
    assert.equal(result.viewChanged, true);
    // Silent expansion: no summary item and no tombstone hint; the edited
    // message reappears as a plain original item.
    assert.deepEqual(result.items, [
      { type: "original", ordinal: 0 },
      { type: "original", ordinal: 1 },
      { type: "original", ordinal: 2 },
      { type: "original", ordinal: 3 },
      { type: "original", ordinal: 4 },
      { type: "original", ordinal: 5 },
    ]);
  });

  it("a truncation cutting into the span expires the block (out of bounds)", () => {
    const history = makeTranscript(6);
    const state = makeState();
    state.blocks.set(7, makeBlock(history, 1, 4));
    const truncated = history.slice(0, 3); // block end 4 > length 3
    const result = fold(truncated, state);
    assert.deepEqual(result.expiredBlockIds, [7]);
    assert.equal(result.viewChanged, true);
    assert.deepEqual(result.items, [
      { type: "original", ordinal: 0 },
      { type: "original", ordinal: 1 },
      { type: "original", ordinal: 2 },
    ]);
  });

  it("only the invalid block expires; other valid blocks still fold", () => {
    const history = makeTranscript(6);
    const state = makeState();
    state.blocks.set(1, makeBlock(history, 1, 3));
    state.blocks.set(2, makeBlock(history, 4, 6, { spanHash: "deadbeef" }));
    const result = fold(history, state);
    assert.deepEqual(result.expiredBlockIds, [2]);
    assert.equal(result.viewChanged, true);
    assert.deepEqual(result.items, [
      { type: "original", ordinal: 0 },
      { type: "summary", block: state.blocks.get(1) },
      { type: "original", ordinal: 3 },
      { type: "original", ordinal: 4 },
      { type: "original", ordinal: 5 },
    ]);
  });
});

// ---------------------------------------------------------------------------
// 4. Inactive blocks never refold — C1-08 unfold protection
// ---------------------------------------------------------------------------

describe("inactive blocks never refold", () => {
  it("a deactivated block expands to originals and stays expanded", () => {
    const history = makeTranscript(6);
    const state = makeState();
    state.blocks.set(1, makeBlock(history, 1, 4));
    // While active, the block folds its interval into one summary.
    const before = fold(history, state);
    assert.equal(before.items.length, 4); // orig 0 + summary + orig 4 + orig 5
    assert.equal(before.items[1].type, "summary");

    // Deactivate — fold must not re-fold it (no other refold path exists).
    const block = state.blocks.get(1);
    assert.ok(block !== undefined);
    block.active = false;
    const result = fold(history, state);
    assert.deepEqual(result.items, [
      { type: "original", ordinal: 0 },
      { type: "original", ordinal: 1 },
      { type: "original", ordinal: 2 },
      { type: "original", ordinal: 3 },
      { type: "original", ordinal: 4 },
      { type: "original", ordinal: 5 },
    ]);
    // Inactive expansion changes the view but is not a validation failure.
    assert.equal(result.viewChanged, true);
    assert.deepEqual(result.expiredBlockIds, []);
    // The block object is untouched by fold.
    assert.equal(block.active, false);
    assert.equal(state.blocks.size, 1);
  });
});

// ---------------------------------------------------------------------------
// 5. Overlapping surviving blocks merge — spec Decision 5 defensive branch
// ---------------------------------------------------------------------------

describe("overlapping surviving blocks merge (defensive branch)", () => {
  it("two intersecting blocks fold into one summary over the union", () => {
    const history = makeTranscript(8);
    const state = makeState();
    state.blocks.set(1, makeBlock(history, 1, 4));
    state.blocks.set(2, makeBlock(history, 3, 6));
    const result = fold(history, state);
    // Union [1, 6) is covered by a single summary rendered from the
    // first-appearing block (id 1); ordinals 0, 6, 7 stay original.
    assert.deepEqual(result.items, [
      { type: "original", ordinal: 0 },
      { type: "summary", block: state.blocks.get(1) },
      { type: "original", ordinal: 6 },
      { type: "original", ordinal: 7 },
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
    const result = fold(history, state);
    assert.deepEqual(result.items, [
      { type: "original", ordinal: 0 },
      { type: "summary", block: state.blocks.get(1) },
      { type: "original", ordinal: 7 },
    ]);
  });

  it("a block extending past its container extends the merged union", () => {
    const history = makeTranscript(8);
    const state = makeState();
    state.blocks.set(1, makeBlock(history, 1, 5));
    state.blocks.set(2, makeBlock(history, 3, 6)); // overlaps and extends
    const result = fold(history, state);
    assert.deepEqual(result.items, [
      { type: "original", ordinal: 0 },
      { type: "summary", block: state.blocks.get(1) },
      { type: "original", ordinal: 6 },
      { type: "original", ordinal: 7 },
    ]);
  });
});

// ---------------------------------------------------------------------------
// 6. Empty history / no blocks pass through — C1-05
// ---------------------------------------------------------------------------

describe("empty history and no blocks pass through", () => {
  it("empty history with no blocks yields an empty view", () => {
    const result = fold([], makeState());
    assert.deepEqual(result.items, []);
    assert.equal(result.viewChanged, false);
    assert.deepEqual(result.expiredBlockIds, []);
  });

  it("messages with no blocks pass through as originals", () => {
    const history = makeTranscript(3);
    const result = fold(history, makeState());
    assert.deepEqual(result.items, [
      { type: "original", ordinal: 0 },
      { type: "original", ordinal: 1 },
      { type: "original", ordinal: 2 },
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
    const result = fold(history, makeState());
    assert.deepEqual(result.items, [
      { type: "original", ordinal: 0 },
      { type: "original", ordinal: 1 },
      { type: "original", ordinal: 2 },
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
    const result = fold(history, state);
    assert.deepEqual(result.items, [
      { type: "summary", block: state.blocks.get(1) },
    ]);
  });

  it("an empty history with a block expires the block (span out of bounds)", () => {
    const state = makeState();
    state.blocks.set(1, makeBlock([makeMsg("user", ["prompt"])], 0, 1));
    const result = fold([], state);
    assert.deepEqual(result.items, []);
    assert.equal(result.viewChanged, true);
    assert.deepEqual(result.expiredBlockIds, [1]);
  });
});

// ---------------------------------------------------------------------------
// 7. Ordinal correspondence — C1-01
// ---------------------------------------------------------------------------

describe("ordinal correspondence", () => {
  it("original items cover exactly the uncovered ordinals, in order", () => {
    const history = makeTranscript(8);
    const state = makeState();
    state.blocks.set(1, makeBlock(history, 1, 3));
    state.blocks.set(2, makeBlock(history, 5, 6));
    const result = fold(history, state);
    assert.deepEqual(result.items, [
      { type: "original", ordinal: 0 },
      { type: "summary", block: state.blocks.get(1) },
      { type: "original", ordinal: 3 },
      { type: "original", ordinal: 4 },
      { type: "summary", block: state.blocks.get(2) },
      { type: "original", ordinal: 6 },
      { type: "original", ordinal: 7 },
    ]);
    // The original ordinals are exactly the complement of the covered
    // ordinals {1, 2, 5} — each distinct and in bounds.
    const originals = result.items
      .filter(
        (item): item is { type: "original"; ordinal: number } =>
          item.type === "original",
      )
      .map((item) => item.ordinal);
    assert.deepEqual(originals, [0, 3, 4, 6, 7]);
    assert.equal(new Set(originals).size, originals.length);
    for (const ordinal of originals) {
      assert.ok(ordinal >= 0 && ordinal < history.length);
    }
  });
});

// ---------------------------------------------------------------------------
// 8. Purity — C1-08
// ---------------------------------------------------------------------------

describe("fold is pure", () => {
  it("returns a fresh items array on every call", () => {
    const history = makeTranscript(3);
    const first = fold(history, makeState());
    const second = fold(history, makeState());
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
    fold(history, state);
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
    const result = fold(history, state);
    assert.deepEqual(result.expiredBlockIds, [1]);
    // Deactivation is the caller's decision — fold only reports.
    assert.equal(state.blocks.get(1)?.active, true);
    assert.equal(state.blocks.size, 1);
  });
});
