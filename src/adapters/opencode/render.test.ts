/**
 * Tests for the v1 render entry points (`render.ts`).
 *
 * Three layers:
 * 1. **Round render** — for a given v1 fixture, fold state, and release
 *    options, one pruning round produces the exact v1 array the transform
 *    hands back: release placeholders written into the addressed v1
 *    parts, dense line-number prefixes on the injectable regions,
 *    synthetic summary messages for folded blocks, and hidden messages
 *    left raw.  Fixtures mirror the release and fold scenario space: tool
 *    parts, reasoning, hidden messages, folded summary blocks, error-input
 *    marks, and defensive anchors.
 * 2. **v1 message shape** — the synthetic summary entry the adapter
 *    constructs satisfies the v1 schema, and the output array keeps every
 *    message complete.
 * 3. **Injection provenance** — line-number prefixes land only on
 *    `isInjectableRegion`-true regions (text-derived content and
 *    tool-output), never on thinking / tool-input / estimation-only
 *    content; hidden messages stay raw and occupy no line; summary items
 *    occupy a line with the prefix on the synthetic first line; injection
 *    is a pure prepend.
 *
 * The plan itself (numbering, line placement, summary text) is covered by
 * the core tests (`core/context/render-plan.test.ts`); these tests pair it
 * with the v1 message shape and in-place delivery.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fold } from "../../core/context/fold.js";
import type {
  Projection,
  RegionEdit,
  ViewItem,
} from "../../core/context/lens.js";
import {
  PRUNED_TOOL_ERROR_INPUT_REPLACEMENT,
  PRUNED_TOOL_OUTPUT_REPLACEMENT,
} from "../../core/context/message-parts.js";
import {
  computeEdits,
  type ReleaseOptions,
} from "../../core/context/release.js";
import { planViewRender } from "../../core/context/render-plan.js";
import { computeSpanHash } from "../../core/context/spanhash.js";
import { markKey, type SessionState } from "../../core/context/state.js";
import { numberView } from "../../core/context/view-refs.js";
import { isInjectableRegion } from "../../core/context/writable-regions.js";
import { makeState } from "../../testkits/context.js";
import { toolPart } from "../../testkits/opencode-messages.js";
import { history } from "./history.js";
import { applyEdits, materialize } from "./render.js";
import type { ContextMessageEntry } from "./types.js";

// ---------------------------------------------------------------------------
// v1 fixture helpers
// ---------------------------------------------------------------------------

/** Output long enough to reclaim tokens against the output placeholder. */
const LONG_OUTPUT = "x".repeat(500);

/** Build a v1 message entry. */
function entry(
  role: string,
  id: string,
  parts?: unknown[],
  ignored?: boolean,
): ContextMessageEntry {
  return {
    info: {
      role,
      id,
      ...(ignored ? { ignored: true } : {}),
    } as unknown as ContextMessageEntry["info"],
    parts: (parts ?? []) as unknown as ContextMessageEntry["parts"],
  };
}

/** Build a text part. */
function text(text: string): Record<string, unknown> {
  return { type: "text", text };
}

/** Build a reasoning part. */
function reasoning(text: string): Record<string, unknown> {
  return { type: "reasoning", text };
}

/**
 * Seed a lens mark for the given region.
 *
 * `regionIndex` is optional: pass undefined to seed a mark without a
 * region index.
 */
function seedMark(
  state: SessionState,
  ordinal: number,
  regionIndex: number | undefined,
  effective: boolean,
  tokens = 100,
): void {
  state.marks.set(markKey(ordinal, regionIndex), {
    anchorOrdinal: ordinal,
    ...(regionIndex !== undefined ? { regionIndex } : {}),
    content: "content snapshot",
    contentTokens: tokens,
    effective,
    markedAt: 1,
  });
}

/** Seed an active compression block over `[start, end)`. */
function seedBlock(
  state: SessionState,
  lens: Projection,
  id: number,
  start: number,
  end: number,
  title: string,
  summary: string,
): void {
  state.blocks.set(id, {
    start,
    end,
    title,
    summary,
    spanHash: computeSpanHash(lens, start, end),
    status: "active",
    compressedTokens: 100,
    summaryTokens: 10,
    createdAt: 1000,
  });
}

/**
 * Run one publish phase over a v1 array: number the view the way the
 * pipeline does, plan it, and materialize the plan in place.
 *
 * @param entries - The v1 messages array.
 * @param items - The folded view items, in view order.
 * @param state - The session state.
 * @returns The materialized array (the same reference).
 */
function materializeRound(
  entries: ContextMessageEntry[],
  items: ViewItem[],
  state: SessionState,
): ContextMessageEntry[] {
  const lens = history(entries).messages;
  const numbered = numberView(
    items,
    (ordinal) => lens[ordinal]?.hidden ?? true,
  );
  return materialize(entries, planViewRender(lens, items, numbered, state));
}

/**
 * Run one pruning round: fold the transcript, compute the release edits,
 * apply them, then materialize the view.
 *
 * @param buildEntries - Builds a fresh v1 fixture.
 * @param seed - Seeds blocks and marks on the state (projection for
 *   span hashes).
 * @param options - Release gate inputs.
 * @returns The rendered v1 messages array.
 */
function runRound(
  buildEntries: () => ContextMessageEntry[],
  seed: (state: SessionState, snapshot: Projection) => void,
  options: ReleaseOptions,
): ContextMessageEntry[] {
  const entries = buildEntries();
  const snapshot = history(entries);
  const state = makeState();
  seed(state, snapshot);
  const edits = computeEdits(state, snapshot.messages, options);
  applyEdits(entries, edits);
  const items = fold(snapshot, state).items;
  return materializeRound(entries, items, state);
}

/** Read a v1 part's text field, or undefined. */
function partText(entryToRead: ContextMessageEntry, index: number): unknown {
  return (entryToRead.parts?.[index] as { text?: string } | undefined)?.text;
}

/** Read a v1 tool part's state output, or undefined. */
function toolOutput(entryToRead: ContextMessageEntry, index: number): unknown {
  return (
    entryToRead.parts?.[index] as { state?: { output?: unknown } } | undefined
  )?.state?.output;
}

// ===========================================================================
// Round render output
// ===========================================================================

describe("round render", () => {
  it("plain transcript with tool parts, reasoning, and a hidden message", () => {
    const rendered = runRound(
      () => [
        entry("user", "m0", [text("开场问题")]),
        entry("assistant", "m1", [
          reasoning("内心推理"),
          toolPart("bash", "ls", LONG_OUTPUT),
          toolPart("read", "a.ts", LONG_OUTPUT),
        ]),
        entry("user", "m2", [text("隐藏注入报告")], true),
        entry("user", "m3", [
          { type: "step-start", text: "步骤开始" },
          text("普通文本"),
        ]),
        entry("assistant", "m4", [text("回答完毕")]),
      ],
      (state) => {
        // m1 regions: thinking(0), tool-input(1), tool-output(2),
        // tool-input(3), tool-output(4).
        seedMark(state, 1, 2, true, 100);
        seedMark(state, 1, 4, false, 200);
      },
      { promptTokens: 100_000, releasedPercent: 0, pendingViewChange: false },
    );

    assert.equal(partText(rendered[0], 0), "[m1] 开场问题");
    // Marked first tool output: placeholder + dense line prefix (the
    // tool-output region of m1 is the injection target).
    assert.equal(
      toolOutput(rendered[1], 1),
      `[m2] ${PRUNED_TOOL_OUTPUT_REPLACEMENT}`,
    );
    // Gate-released second tool output: plain placeholder (line taken by
    // the first output).
    assert.equal(toolOutput(rendered[1], 2), PRUNED_TOOL_OUTPUT_REPLACEMENT);
    assert.equal(partText(rendered[1], 0), "内心推理");
    // Hidden message: raw text, no prefix.
    assert.equal(partText(rendered[2], 0), "隐藏注入报告");
    // First m3 content region is step-start-derived (not injectable).
    assert.equal(partText(rendered[3], 0), "步骤开始");
    assert.equal(partText(rendered[3], 1), "[m3] 普通文本");
    assert.equal(partText(rendered[4], 0), "[m4] 回答完毕");
  });

  it("folded summary block with a pruned message outside the block", () => {
    const rendered = runRound(
      () => [
        entry("user", "u0", [text("开场问题")]),
        entry("assistant", "a1", [text("回答一")]),
        entry("user", "u2", [text("第二个问题")]),
        entry("assistant", "a3", [
          toolPart("bash", "ls", LONG_OUTPUT),
          text("回答二"),
        ]),
        entry("assistant", "a4", [text("回答三")]),
      ],
      (state, lens) => {
        seedBlock(state, lens, 1, 1, 3, "第一段", "摘要正文");
        // a3 regions: tool-input(0), tool-output(1), content(2).
        seedMark(state, 3, 1, true, 100);
      },
      { promptTokens: 100_000, releasedPercent: 5, pendingViewChange: false },
    );

    assert.equal(rendered.length, 4);
    assert.equal(partText(rendered[0], 0), "[m1] 开场问题");
    assert.equal(rendered[1].info.synthetic, true);
    assert.equal(
      partText(rendered[1], 0),
      "[m2] [Block b1 · 2 条] 第一段\n摘要正文",
    );
    assert.equal(
      toolOutput(rendered[2], 0),
      `[m3] ${PRUNED_TOOL_OUTPUT_REPLACEMENT}`,
    );
    assert.equal(partText(rendered[2], 1), "回答二");
    assert.equal(partText(rendered[3], 0), "[m4] 回答三");
  });

  it("error-input mark released by the gate", () => {
    const rendered = runRound(
      () => [
        entry("user", "u0", [text("问题")]),
        entry("assistant", "a1", [
          toolPart("bash", '"bad"', "boom", "error"),
          text("已失败"),
        ]),
      ],
      (state) => {
        // a1 regions: tool-input(0), tool-output(1), content(2).
        seedMark(state, 1, 0, false, 3000);
      },
      { promptTokens: 100_000, releasedPercent: 0, pendingViewChange: false },
    );

    const toolState = (
      rendered[1].parts?.[0] as { state?: { input: unknown; output: unknown } }
    ).state;
    assert.equal(toolState?.input, PRUNED_TOOL_ERROR_INPUT_REPLACEMENT);
    assert.equal(toolState?.output, "[m2] boom");
    assert.equal(partText(rendered[1], 1), "已失败");
  });

  it("defensive anchors are skipped — only the resolvable region changes", () => {
    const rendered = runRound(
      () => [
        entry("user", "m0", [text("开场问题")]),
        entry("assistant", "m1", [
          reasoning("内心推理"),
          toolPart("bash", "ls", LONG_OUTPUT),
        ]),
      ],
      (state) => {
        seedMark(state, 1, 2, true, 100); // valid
        seedMark(state, 9, 0, true, 100); // vanished message
        seedMark(state, 1, 9, false, 100); // out-of-range region
        seedMark(state, 0, undefined, false, 100); // no region index
      },
      { promptTokens: 100_000, releasedPercent: 0, pendingViewChange: false },
    );

    assert.equal(partText(rendered[0], 0), "[m1] 开场问题");
    assert.equal(partText(rendered[1], 0), "内心推理");
    assert.equal(
      toolOutput(rendered[1], 1),
      `[m2] ${PRUNED_TOOL_OUTPUT_REPLACEMENT}`,
    );
  });

  it("closed gate — only effective marks are written", () => {
    const rendered = runRound(
      () => [
        entry("user", "u0", [text("开场问题")]),
        entry("assistant", "a1", [toolPart("bash", "ls", LONG_OUTPUT)]),
        entry("assistant", "a2", [toolPart("bash", "pwd", LONG_OUTPUT)]),
      ],
      (state) => {
        seedMark(state, 1, 1, true, 100);
        seedMark(state, 2, 1, false, 200);
      },
      {
        promptTokens: 100_000,
        releasedPercent: undefined,
        pendingViewChange: false,
      },
    );

    assert.equal(
      toolOutput(rendered[1], 0),
      `[m2] ${PRUNED_TOOL_OUTPUT_REPLACEMENT}`,
    );
    assert.equal(toolOutput(rendered[2], 0), `[m3] ${LONG_OUTPUT}`);
  });
});

// ===========================================================================
// v1 message shape
// ===========================================================================

describe("summary message shape", () => {
  it("every output message keeps the v1 schema complete", () => {
    const msgs = [
      entry("user", "u0", [text("开场问题")]),
      entry("assistant", "a1", [
        reasoning("推理"),
        toolPart("bash", "ls", "o"),
      ]),
      entry("user", "u2", [text("第二个问题")]),
      entry("assistant", "a3", [text("回答")]),
    ];
    const lens = history(msgs);
    const state: SessionState = { blocks: new Map(), marks: new Map() };
    state.blocks.set(1, {
      start: 2,
      end: 4,
      title: "第一段",
      summary: "摘要正文",
      spanHash: computeSpanHash(lens, 2, 4),
      status: "active",
      compressedTokens: 100,
      summaryTokens: 10,
      createdAt: 1000,
    });
    const { items } = fold(lens, state);
    materializeRound(msgs, items, state);

    assert.equal(msgs.length, 3);
    for (const msg of msgs) {
      assert.equal(typeof msg.info.role, "string");
      assert.ok(msg.info.role.length > 0);
      assert.equal(typeof msg.info.id, "string");
      assert.ok(msg.info.id.length > 0);
      assert.ok(Array.isArray(msg.parts));
      for (const part of msg.parts ?? []) {
        assert.equal(typeof part.type, "string");
      }
    }
    // Ids stay distinct within the array (the synthetic summary carries
    // a positional placeholder id).
    assert.equal(new Set(msgs.map((msg) => msg.info.id)).size, msgs.length);
    // The block id is in the synthetic message id — the stable marker
    // host-side tooling reads to tell synthetic messages apart.
    assert.equal(msgs[2].info.synthetic, true);
    assert.equal(msgs[2].info.id, "zoo-fold-b1");
    // A single text part carries the whole planned summary text.
    assert.equal(msgs[2].parts?.length, 1);
    assert.deepEqual(msgs[2].parts?.[0], {
      type: "text",
      text: "[m3] [Block b1 · 2 条] 第一段\n摘要正文",
    });
  });
});

// ===========================================================================
// Injection: line-number prefixes land only on injectable regions
// ===========================================================================

describe("render injection", () => {
  /** messages with no blocks — every item is an original. */
  function noBlockFixture(): ContextMessageEntry[] {
    return [
      entry("user", "m0", [text("开场问题")]),
      entry("assistant", "m1", [
        reasoning("内心推理"),
        toolPart("bash", "ls", "out1"),
      ]),
      entry("user", "m2", [text("隐藏注入报告")], true),
      entry("user", "m3", [
        { type: "step-start", text: "步骤开始" },
        text("普通文本"),
      ]),
      entry("assistant", "m4", [text("回答完毕")]),
    ];
  }

  it("injects the dense prefix into text content and tool-output only", () => {
    const msgs = noBlockFixture();
    const lens = history(msgs);
    const state: SessionState = { blocks: new Map(), marks: new Map() };
    const { items } = fold(lens, state);
    materializeRound(msgs, items, state);

    // m0: text-derived content → line 1.
    assert.equal(
      (msgs[0].parts?.[0] as { text: string }).text,
      "[m1] 开场问题",
    );
    // m1: tool-output gets line 2; thinking and tool-input untouched.
    assert.equal((msgs[1].parts?.[0] as { text: string }).text, "内心推理");
    const toolState = (
      msgs[1].parts?.[1] as {
        state?: { input: string; output: string };
      }
    ).state;
    assert.equal(toolState?.input, "ls");
    assert.equal(toolState?.output, "[m2] out1");
    // m2: hidden → raw text, no prefix.
    assert.equal((msgs[2].parts?.[0] as { text: string }).text, "隐藏注入报告");
    // m3: the first content region (step-start-derived, not injectable)
    // stays raw; the text-derived content region receives line 3.
    assert.equal((msgs[3].parts?.[0] as { text: string }).text, "步骤开始");
    assert.equal(
      (msgs[3].parts?.[1] as { text: string }).text,
      "[m3] 普通文本",
    );
    // m4: line 4.
    assert.equal(
      (msgs[4].parts?.[0] as { text: string }).text,
      "[m4] 回答完毕",
    );
  });

  it("never injects into thinking or tool-input regions", () => {
    const msgs = [
      entry("assistant", "a0", [
        reasoning("think"),
        toolPart("read", "a.ts", "content"),
      ]),
    ];
    const snapshot = history(msgs);
    const lens = snapshot.messages;
    // Prove the adapter's provenance agrees with the injection output.
    assert.equal(isInjectableRegion(lens[0].regions[0]), false); // thinking
    assert.equal(isInjectableRegion(lens[0].regions[1]), false); // tool-input
    assert.equal(isInjectableRegion(lens[0].regions[2]), true); // tool-output

    const state: SessionState = { blocks: new Map(), marks: new Map() };
    const { items } = fold(snapshot, state);
    materializeRound(msgs, items, state);
    assert.equal((msgs[0].parts?.[0] as { text: string }).text, "think");
    const toolState = (
      msgs[0].parts?.[1] as {
        state?: { input: string; output: string };
      }
    ).state;
    assert.equal(toolState?.input, "a.ts");
    assert.equal(toolState?.output, "[m1] content");
  });

  it("numbers summary items and injects the prefix on the synthetic first line", () => {
    const msgs = [
      entry("user", "u0", [text("开场问题")]),
      entry("assistant", "a1", [text("回答一")]),
      entry("user", "u2", [text("第二个问题")]),
      entry("assistant", "a3", [text("回答二")]),
      entry("assistant", "a4", [text("回答三")]),
    ];
    const lens = history(msgs);
    const state: SessionState = { blocks: new Map(), marks: new Map() };
    state.blocks.set(1, {
      start: 1,
      end: 3,
      title: "第一段",
      summary: "摘要正文",
      spanHash: computeSpanHash(lens, 1, 3),
      status: "active",
      compressedTokens: 100,
      summaryTokens: 10,
      createdAt: 1000,
    });
    const { items } = fold(lens, state);
    materializeRound(msgs, items, state);

    assert.equal(msgs.length, 4);
    // Dense numbering: u0 → 1, summary → 2, a3 → 3, a4 → 4.
    assert.equal(
      (msgs[0].parts?.[0] as { text: string }).text,
      "[m1] 开场问题",
    );
    assert.equal(msgs[1].info.synthetic, true);
    assert.equal(
      (msgs[1].parts?.[0] as { text: string }).text,
      "[m2] [Block b1 · 2 条] 第一段\n摘要正文",
    );
    assert.equal((msgs[2].parts?.[0] as { text: string }).text, "[m3] 回答二");
    assert.equal((msgs[3].parts?.[0] as { text: string }).text, "[m4] 回答三");
  });

  it("injects as a pure prefix — an existing line-start marker is preserved verbatim", () => {
    const msgs = [entry("user", "m0", [text("[m3] marked text")])];
    const lens = history(msgs);
    const state: SessionState = { blocks: new Map(), marks: new Map() };
    const { items } = fold(lens, state);
    materializeRound(msgs, items, state);
    // No stripping: the region's own line-start marker stays verbatim
    // and the current round's prefix is prepended in front of it.
    assert.equal(
      (msgs[0].parts?.[0] as { text: string }).text,
      "[m1] [m3] marked text",
    );
  });

  it("a message with no injectable region keeps its raw text", () => {
    const msgs = [
      entry("assistant", "a0", [
        { type: "step-start", text: "步骤开始" },
        reasoning("think"),
      ]),
    ];
    const lens = history(msgs);
    const state: SessionState = { blocks: new Map(), marks: new Map() };
    const { items } = fold(lens, state);
    materializeRound(msgs, items, state);
    // The line is allocated (the item is visible) but no region qualifies.
    assert.equal((msgs[0].parts?.[0] as { text: string }).text, "步骤开始");
    assert.equal((msgs[0].parts?.[1] as { text: string }).text, "think");
  });
});

// ===========================================================================
// Behavior: the render entry points
// ===========================================================================

describe("render behavior", () => {
  it("applies a direct edit to the addressed v1 part and returns the array in place", () => {
    const entries = [
      entry("user", "u0", [text("开场")]),
      entry("assistant", "a1", [reasoning("旧推理")]),
    ];
    const snapshot = history(entries);
    const state = makeState();
    const edits: RegionEdit[] = [
      { messageOrdinal: 1, regionIndex: 0, text: "新推理" },
    ];
    applyEdits(entries, edits);
    const out = materializeRound(entries, fold(snapshot, state).items, state);
    assert.equal(out, entries, "same array reference returned");
    assert.equal(partText(entries[0], 0), "[m1] 开场");
    // The thinking region has no injection provenance — the edit text
    // survives the view render untouched.
    assert.equal(partText(entries[1], 0), "新推理");
  });

  it("applyEdits and materialize together equal one round", () => {
    const entries = [
      entry("user", "u0", [text("开场")]),
      entry("assistant", "a1", [
        reasoning("旧推理"),
        toolPart("bash", "ls", LONG_OUTPUT),
      ]),
    ];
    const state = makeState();
    seedMark(state, 1, 2, true, 100);
    const snapshot = history(entries);
    const edits = computeEdits(state, snapshot.messages, {
      promptTokens: 100_000,
      releasedPercent: 0,
      pendingViewChange: false,
    });
    const items = fold(snapshot, state).items;

    // Split path: apply the edits first, then materialize the view.
    applyEdits(entries, edits);
    const out = materializeRound(entries, items, state);
    assert.equal(out, entries, "same array reference returned");
    assert.equal(
      toolOutput(entries[1], 1),
      `[m2] ${PRUNED_TOOL_OUTPUT_REPLACEMENT}`,
    );
  });

  it("skips edits whose anchor cannot be resolved", () => {
    const entries = [entry("user", "u0", [text("开场")])];
    const snapshot = history(entries);
    const state = makeState();
    const edits: RegionEdit[] = [
      { messageOrdinal: 9, regionIndex: 0, text: "x" }, // vanished message
      { messageOrdinal: 0, regionIndex: 5, text: "y" }, // out-of-range region
      { messageOrdinal: 0, text: "z" }, // no region index
    ];
    applyEdits(entries, edits);
    materializeRound(entries, fold(snapshot, state).items, state);
    assert.equal(partText(entries[0], 0), "[m1] 开场");
  });

  it("materializes folded blocks as synthetic summary messages", () => {
    const entries = [
      entry("user", "u0", [text("开场问题")]),
      entry("assistant", "a1", [text("回答一")]),
      entry("user", "u2", [text("第二个问题")]),
      entry("assistant", "a3", [text("回答二")]),
      entry("assistant", "a4", [text("回答三")]),
    ];
    const snapshot = history(entries);
    const state = makeState();
    seedBlock(state, snapshot, 1, 1, 3, "第一段", "摘要正文");
    materializeRound(entries, fold(snapshot, state).items, state);

    assert.equal(entries.length, 4);
    assert.equal(entries[1].info.synthetic, true);
    assert.equal(
      partText(entries[1], 0),
      "[m2] [Block b1 · 2 条] 第一段\n摘要正文",
    );
    assert.equal(partText(entries[0], 0), "[m1] 开场问题");
    assert.equal(partText(entries[2], 0), "[m3] 回答二");
    assert.equal(partText(entries[3], 0), "[m4] 回答三");
  });
});
