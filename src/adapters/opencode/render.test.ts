/**
 * Tests for the v1 render entry points (`render.ts`).
 *
 * Two layers:
 * 1. **Round render** — for a given v1 fixture, fold state, and release
 *    options, `render(entries, items, edits, state)` produces the exact
 *    v1 array the pruning round materializes: release placeholders
 *    written into the addressed v1 parts, dense line-number prefixes on
 *    the injectable regions, synthetic summary messages for folded
 *    blocks, and hidden messages left raw.  Fixtures mirror the release
 *    and fold scenario space: tool parts, reasoning, hidden messages,
 *    folded summary blocks, error-input marks, and defensive anchors.
 * 2. **Behavior** — the two steps (`applyEdits` + `renderView`) and the
 *    combined `render` mutate the input array in place and return it,
 *    apply each edit to the addressed v1 part, skip unresolvable
 *    anchors, and materialize folded blocks through the session block
 *    map.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fold } from "../../core/context/fold.js";
import type { HostMessage, RegionEdit } from "../../core/context/lens.js";
import {
  PRUNED_TOOL_ERROR_INPUT_REPLACEMENT,
  PRUNED_TOOL_OUTPUT_REPLACEMENT,
} from "../../core/context/message-parts.js";
import {
  computeEdits,
  type ReleaseOptions,
} from "../../core/context/release.js";
import { computeSpanHash } from "../../core/context/spanhash.js";
import { markKey, type SessionState } from "../../core/context/state.js";
import { history } from "./history.js";
import { applyEdits, render, renderView } from "./render.js";
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

/** Build a tool part with string input/output. */
function toolPart(
  tool: string,
  input: string,
  output: string,
  status?: string,
): Record<string, unknown> {
  return {
    type: "tool",
    tool,
    state: {
      input,
      output,
      ...(status ? { status } : {}),
    },
  };
}

/** A fresh empty lens session state. */
function makeNewState(): SessionState {
  return { blocks: new Map(), marks: new Map() };
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
  lens: HostMessage[],
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
    active: true,
    compressedTokens: 100,
    summaryTokens: 10,
    createdAt: 1000,
  });
}

/**
 * Run one pruning round: fold the transcript, compute the release edits,
 * then render the view with those edits applied.
 *
 * @param buildEntries - Builds a fresh v1 fixture.
 * @param seed - Seeds blocks and marks on the state (lens for hashes).
 * @param options - Release gate inputs.
 * @returns The rendered v1 messages array.
 */
function runRound(
  buildEntries: () => ContextMessageEntry[],
  seed: (state: SessionState, lens: HostMessage[]) => void,
  options: ReleaseOptions,
): ContextMessageEntry[] {
  const entries = buildEntries();
  const lens = history(entries);
  const state = makeNewState();
  seed(state, lens);
  const edits = computeEdits(state, lens, options);
  const items = fold(lens, state).items;
  return render(entries, items, edits, state);
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
// Behavior: the render entry points
// ===========================================================================

describe("render behavior", () => {
  it("applies a direct edit to the addressed v1 part and returns the array in place", () => {
    const entries = [
      entry("user", "u0", [text("开场")]),
      entry("assistant", "a1", [reasoning("旧推理")]),
    ];
    const lens = history(entries);
    const state = makeNewState();
    const edits: RegionEdit[] = [
      { messageOrdinal: 1, regionIndex: 0, text: "新推理" },
    ];
    const out = render(entries, fold(lens, state).items, edits, state);
    assert.equal(out, entries, "same array reference returned");
    assert.equal(partText(entries[0], 0), "[m1] 开场");
    // The thinking region has no injection provenance — the edit text
    // survives the view render untouched.
    assert.equal(partText(entries[1], 0), "新推理");
  });

  it("applyEdits and renderView together equal render", () => {
    const entries = [
      entry("user", "u0", [text("开场")]),
      entry("assistant", "a1", [
        reasoning("旧推理"),
        toolPart("bash", "ls", LONG_OUTPUT),
      ]),
    ];
    const state = makeNewState();
    seedMark(state, 1, 2, true, 100);
    const lens = history(entries);
    const edits = computeEdits(state, lens, {
      promptTokens: 100_000,
      releasedPercent: 0,
      pendingViewChange: false,
    });
    const items = fold(lens, state).items;

    // Split path: apply the edits first, then render the view.
    applyEdits(entries, edits);
    const out = renderView(entries, items, state);
    assert.equal(out, entries, "same array reference returned");
    assert.equal(
      toolOutput(entries[1], 1),
      `[m2] ${PRUNED_TOOL_OUTPUT_REPLACEMENT}`,
    );
  });

  it("skips edits whose anchor cannot be resolved", () => {
    const entries = [entry("user", "u0", [text("开场")])];
    const lens = history(entries);
    const state = makeNewState();
    const edits: RegionEdit[] = [
      { messageOrdinal: 9, regionIndex: 0, text: "x" }, // vanished message
      { messageOrdinal: 0, regionIndex: 5, text: "y" }, // out-of-range region
      { messageOrdinal: 0, text: "z" }, // no region index
    ];
    render(entries, fold(lens, state).items, edits, state);
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
    const lens = history(entries);
    const state = makeNewState();
    seedBlock(state, lens, 1, 1, 3, "第一段", "摘要正文");
    render(entries, fold(lens, state).items, [], state);

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
