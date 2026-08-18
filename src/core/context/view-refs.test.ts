/**
 * Tests for the view-as-address-space render layer (`view-refs.ts`).
 *
 * Covers the P1.7 acceptance contract: dense per-round numbering (original
 * and summary items alike), the summary label format with title-less
 * degradation, endpoint resolution (original → unit interval, summary →
 * whole block, reversed-range swap), actionable out-of-view errors, swallowed
 * blocks occupying no line, and restart-free reproducibility (no persistence
 * reconciliation).  The three-branch injection placement and the
 * strip→inject round cycle live in `apply-view.test.ts` against the v1
 * adapter (`applyView` owns the actual injection now).  Hidden messages
 * (spec Decision 3 / checklist C7-02) stay visible in the view but occupy
 * no line number and receive no prefix, so the visible numbering stays
 * dense.  Fixtures are built through the lens testkit; the swallowed-block
 * view comes from `fold`.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fold } from "./fold.js";
import type { HostMessage, ViewItem } from "./lens.js";
import { makeAssistantMsg, makeMsg } from "./lens-testkit.js";
import { computeSpanHash } from "./spanhash.js";
import type { Block, SessionState } from "./state.js";
import {
  formatSummaryLabel,
  numberView,
  refPrefix,
  resolveEndpoint,
  resolveRange,
} from "./view-refs.js";

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

/** A view in which no message is hidden. */
const noneHidden = (): boolean => false;

// ---------------------------------------------------------------------------
// 1. Dense per-round numbering — ①
// ---------------------------------------------------------------------------

describe("numberView — dense per-round numbering", () => {
  it("numbers original items 1..N", () => {
    const items: ViewItem[] = [
      { type: "original", ordinal: 0 },
      { type: "original", ordinal: 1 },
      { type: "original", ordinal: 2 },
    ];
    assert.deepEqual(
      numberView(items, noneHidden).map((n) => n.n),
      [1, 2, 3],
    );
  });

  it("keeps numbering dense across summary items", () => {
    const items: ViewItem[] = [
      { type: "original", ordinal: 0 },
      {
        type: "summary",
        block: { start: 1, end: 4, title: "t", summary: "s" },
      },
      { type: "original", ordinal: 4 },
    ];
    const numbered = numberView(items, noneHidden);
    assert.deepEqual(
      numbered.map((x) => x.n),
      [1, 2, 3],
    );
    assert.equal(numbered[1].item.type, "summary");
  });

  it("produces an empty numbering for an empty view", () => {
    assert.deepEqual(numberView([], noneHidden), []);
  });
});

// ---------------------------------------------------------------------------
// refPrefix — marker + space, no zero padding
// ---------------------------------------------------------------------------

describe("refPrefix", () => {
  it("is a marker plus a trailing space with no zero padding", () => {
    assert.equal(refPrefix(1), "[m1] ");
    assert.equal(refPrefix(9), "[m9] ");
    assert.equal(refPrefix(10), "[m10] ");
    assert.equal(refPrefix(123), "[m123] ");
  });
});

// ---------------------------------------------------------------------------
// 2. Summary label format — ②
// ---------------------------------------------------------------------------

describe("formatSummaryLabel", () => {
  it("renders the block header with the covered message count", () => {
    assert.equal(
      formatSummaryLabel({
        id: 1,
        start: 1,
        end: 4,
        title: "notes",
        summary: "s",
      }),
      "[Block b1 · 3 条] notes",
    );
  });

  it("degrades to the bare header when the title is missing", () => {
    assert.equal(
      formatSummaryLabel({ id: 2, start: 0, end: 5, summary: "s" }),
      "[Block b2 · 5 条]",
    );
  });

  it("degrades on an empty-string title as well", () => {
    assert.equal(
      formatSummaryLabel({ id: 3, start: 2, end: 4, title: "", summary: "s" }),
      "[Block b3 · 2 条]",
    );
  });

  it("shows the count, never the interval line numbers", () => {
    const label = formatSummaryLabel({
      id: 4,
      start: 7,
      end: 10,
      title: "t",
      summary: "s",
    });
    assert.equal(label, "[Block b4 · 3 条] t");
    assert.ok(!label.includes("m7"));
    assert.ok(!label.includes("m10"));
  });
});

// ---------------------------------------------------------------------------
// 3. Endpoint resolution — ③
// ---------------------------------------------------------------------------

describe("resolveEndpoint", () => {
  const items = numberView(
    [
      { type: "original", ordinal: 0 },
      {
        type: "summary",
        block: { start: 1, end: 4, title: "t", summary: "s" },
      },
      { type: "original", ordinal: 4 },
      { type: "original", ordinal: 5 },
    ],
    noneHidden,
  );

  it("accepts both the bare and the bracketed spelling", () => {
    assert.deepEqual(resolveEndpoint("m1", items), { start: 0, end: 1 });
    assert.deepEqual(resolveEndpoint("[m1]", items), { start: 0, end: 1 });
    assert.deepEqual(resolveEndpoint("m2", items), { start: 1, end: 4 });
    assert.deepEqual(resolveEndpoint("[m2]", items), { start: 1, end: 4 });
  });

  it("maps an original item to its unit ordinal interval", () => {
    assert.deepEqual(resolveEndpoint("m3", items), { start: 4, end: 5 });
    assert.deepEqual(resolveEndpoint("m4", items), { start: 5, end: 6 });
  });

  it("maps a summary item to the whole block interval", () => {
    assert.deepEqual(resolveEndpoint("m2", items), { start: 1, end: 4 });
  });
});

describe("resolveRange", () => {
  const items = numberView(
    [
      { type: "original", ordinal: 0 },
      { type: "original", ordinal: 1 },
      {
        type: "summary",
        block: { start: 2, end: 5, title: "t", summary: "s" },
      },
      { type: "original", ordinal: 5 },
      { type: "original", ordinal: 6 },
    ],
    noneHidden,
  );

  it("unions a forward range", () => {
    assert.deepEqual(resolveRange("m1", "m3", items), { start: 0, end: 5 });
  });

  it("rejects a reversed range with an order error naming both refs", () => {
    const result = resolveRange("m5", "m1", items);
    assert.ok("error" in result);
    assert.ok(result.error.includes("顺序颠倒"));
    assert.ok(result.error.includes("m5"));
    assert.ok(result.error.includes("m1"));
    // The forward order resolves to the union interval.
    assert.deepEqual(resolveRange("m1", "m5", items), { start: 0, end: 7 });
  });

  it("covers the whole block when the right endpoint lands on a summary", () => {
    assert.deepEqual(resolveRange("m2", "m3", items), { start: 1, end: 5 });
    assert.deepEqual(resolveRange("m3", "m3", items), { start: 2, end: 5 });
  });

  it("resolves a single original item to its unit interval", () => {
    assert.deepEqual(resolveRange("m4", "m4", items), { start: 5, end: 6 });
  });
});

// ---------------------------------------------------------------------------
// 4. Actionable errors — ④
// ---------------------------------------------------------------------------

describe("actionable errors", () => {
  const items = numberView(
    [
      { type: "original", ordinal: 0 },
      { type: "summary", block: { start: 1, end: 4, summary: "s" } },
      { type: "original", ordinal: 4 },
      { type: "original", ordinal: 5 },
    ],
    noneHidden,
  );

  it("names the valid range for an out-of-view line number", () => {
    const result = resolveEndpoint("m9", items);
    assert.ok("error" in result);
    assert.ok(result.error.includes("当轮视图共 4 行，有效 m1..m4"));
  });

  it("errors on a non-mN ref and identifies the expected format", () => {
    for (const bad of ["abc", "3", "m3]", "[m3", "[3]", "m"]) {
      const result = resolveEndpoint(bad, items);
      assert.ok("error" in result, `expected an error for "${bad}"`);
      assert.ok(result.error.includes("mN"));
      assert.ok(result.error.includes("[mN]"));
    }
  });

  it("reports the failing endpoint of a range", () => {
    const result = resolveRange("m1", "m9", items);
    assert.ok("error" in result);
    assert.ok(result.error.includes("当轮视图共 4 行，有效 m1..m4"));
  });

  it("handles an empty view", () => {
    const result = resolveEndpoint("m1", []);
    assert.ok("error" in result);
    assert.ok(result.error.includes("当轮视图共 0 行"));
  });
});

// ---------------------------------------------------------------------------
// 5. Swallowed blocks occupy no line — ⑤
// ---------------------------------------------------------------------------

describe("swallowed blocks occupy no line", () => {
  it("a view without a summary item for the swallowed block numbers densely", () => {
    // A swallowing block consumed another block: only the outer block's
    // summary item is in the view, so the swallowed block has no line
    // number and the numbering stays dense over what is rendered.
    const items: ViewItem[] = [
      { type: "original", ordinal: 0 },
      {
        type: "summary",
        block: { start: 1, end: 5, title: "outer", summary: "s" },
      },
      { type: "original", ordinal: 5 },
    ];
    const numbered = numberView(items, noneHidden);
    assert.deepEqual(
      numbered.map((x) => x.n),
      [1, 2, 3],
    );
    assert.deepEqual(resolveEndpoint("m2", numbered), { start: 1, end: 5 });
  });

  it("fold merges overlapping blocks so only one summary line exists", () => {
    const history = makeTranscript(7);
    const state = makeState();
    state.blocks.set(1, makeBlock(history, 1, 3));
    state.blocks.set(2, makeBlock(history, 2, 5));
    const { items } = fold(history, state);
    // One summary item for the union; the swallowed block's summary item
    // is absent, so the numbering has no gap.
    assert.equal(items.filter((item) => item.type === "summary").length, 1);
    assert.deepEqual(
      items.map((item) => (item.type === "original" ? item.ordinal : "s")),
      [0, "s", 5, 6],
    );
    assert.deepEqual(
      numberView(items, noneHidden).map((x) => x.n),
      [1, 2, 3, 4],
    );
  });
});

// ---------------------------------------------------------------------------
// 6. Restart reproducibility — ⑥
// ---------------------------------------------------------------------------

describe("restart reproducibility (stateless numbering)", () => {
  it("independent numberView calls on the same view agree", () => {
    const items: ViewItem[] = [
      { type: "original", ordinal: 0 },
      { type: "summary", block: { start: 1, end: 3, summary: "s" } },
      { type: "original", ordinal: 3 },
      { type: "original", ordinal: 4 },
    ];
    // Two "rounds" re-derive identical numbers with no reconciliation:
    // the numbering is a pure function of the view, which is all a
    // restart needs.
    assert.deepEqual(
      numberView(items, noneHidden),
      numberView(items, noneHidden),
    );
    assert.deepEqual(
      numberView(items, noneHidden).map((x) => x.n),
      [1, 2, 3, 4],
    );
  });
});

// ---------------------------------------------------------------------------
// 7. Hidden messages occupy no line — spec Decision 3 / checklist C7-02
// ---------------------------------------------------------------------------

describe("hidden messages occupy no line", () => {
  it("skips hidden originals so the visible numbering stays dense", () => {
    const items: ViewItem[] = [
      { type: "original", ordinal: 0 },
      { type: "original", ordinal: 1 }, // hidden — occupies no line
      { type: "original", ordinal: 2 },
    ];
    const numbered = numberView(items, (ordinal) => ordinal === 1);
    assert.deepEqual(
      numbered.map((x) => x.n),
      [1, 2],
    );
    assert.deepEqual(
      numbered.map((x) => (x.item.type === "original" ? x.item.ordinal : -1)),
      [0, 2],
    );
  });

  it("keeps summary items numbered regardless of hidden coverage in the block", () => {
    const items: ViewItem[] = [
      { type: "original", ordinal: 0 },
      { type: "summary", block: { start: 1, end: 3, summary: "s" } },
      { type: "original", ordinal: 3 },
    ];
    const numbered = numberView(
      items,
      (ordinal) => ordinal === 1 || ordinal === 2,
    );
    assert.deepEqual(
      numbered.map((x) => x.n),
      [1, 2, 3],
    );
    assert.equal(numbered[1].item.type, "summary");
  });

  it("reports the visible range when a ref would have landed on a hidden item", () => {
    const items = numberView(
      [
        { type: "original", ordinal: 0 },
        { type: "original", ordinal: 1 }, // hidden — occupies no line
        { type: "original", ordinal: 2 },
      ],
      (ordinal) => ordinal === 1,
    );
    // The dense numbering is m1..m2; a ref beyond it hits the existing
    // out-of-view error — no hidden-specific error path is needed.
    const result = resolveEndpoint("m3", items);
    assert.ok("error" in result);
    assert.ok(result.error.includes("当轮视图共 2 行，有效 m1..m2"));
  });
});
