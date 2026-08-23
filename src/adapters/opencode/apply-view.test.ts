/**
 * Tests for the v1 synthetic summary builder (`materializeSummary`) and
 * the view-render injection semantics (`render.ts`).
 *
 * Two layers:
 *
 * 1. **Shape** — `materializeSummary` output satisfies the v1 schema:
 *    `info.role` / `info.id` / `info.synthetic` and a single text part.
 * 2. **Injection provenance** — `render` line-number prefixes land only
 *    on `isInjectableRegion`-true regions (text-derived content and
 *    tool-output), never on thinking / tool-input / estimation-only
 *    content; hidden messages stay raw and occupy no line; summary
 *    items occupy a line with the prefix on the synthetic first line;
 *    injection is a pure prepend — a line-start marker already present
 *    in the region text is preserved verbatim.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fold } from "../../core/context/fold.js";
import { computeSpanHash } from "../../core/context/spanhash.js";
import type { SessionState } from "../../core/context/state.js";
import { materializeSummary } from "./apply-view.js";
import { history, isInjectableRegion } from "./history.js";
import { render } from "./render.js";
import type { ContextMessageEntry } from "./types.js";

// ---------------------------------------------------------------------------
// v1 fixture helpers
// ---------------------------------------------------------------------------

/**
 * Build a v1 message entry.
 */
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

// ---------------------------------------------------------------------------
// Shape: materializeSummary
// ---------------------------------------------------------------------------

describe("materializeSummary shape", () => {
  it("emits the v1 synthetic-message shape with the rendered label", () => {
    const msg = materializeSummary(
      { start: 1, end: 3, title: "标题", summary: "正文", id: 2 },
      4,
    );
    assert.equal(msg.info.role, "user");
    assert.equal(msg.info.synthetic, true);
    assert.equal(msg.info.id, "zoo-fold-b2");
    assert.equal(msg.parts?.length, 1);
    assert.deepEqual(msg.parts?.[0], {
      type: "text",
      text: "[m4] [Block b2 · 2 条] 标题\n正文",
    });
  });

  it("renders without the line prefix when no line number is given", () => {
    const msg = materializeSummary({
      start: 1,
      end: 3,
      title: "标题",
      summary: "正文",
      id: 2,
    });
    assert.equal(msg.parts?.[0].text, "[Block b2 · 2 条] 标题\n正文");
  });

  it("omits the title segment when the block has no title", () => {
    const msg = materializeSummary({
      start: 1,
      end: 3,
      summary: "正文",
      id: 2,
    });
    assert.equal(msg.parts?.[0].text, "[Block b2 · 2 条]\n正文");
  });

  it("renders the label alone when the summary body is empty", () => {
    const msg = materializeSummary({
      start: 0,
      end: 2,
      title: "空块",
      summary: "",
      id: 3,
    });
    assert.equal(msg.parts?.[0].text, "[Block b3 · 2 条] 空块");
  });

  it("renders without the bN segment when the block id is missing (defensive)", () => {
    const msg = materializeSummary({
      start: 1,
      end: 3,
      title: "标题",
      summary: "正文",
    });
    assert.equal(msg.info.id, "zoo-fold-b0");
    assert.equal(msg.parts?.[0].text, "[Block 2 条] 标题\n正文");
  });
});

// ---------------------------------------------------------------------------
// Shape: render output keeps the v1 schema complete
// ---------------------------------------------------------------------------

describe("render shape", () => {
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
      active: true,
      compressedTokens: 100,
      summaryTokens: 10,
      createdAt: 1000,
    });
    const { items } = fold(lens, state);
    render(msgs, items, [], state);

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
    // The synthetic message carries the marker flag (items: orig0,
    // orig1, summary).
    assert.equal(msgs[2].info.synthetic, true);
  });
});

// ---------------------------------------------------------------------------
// Injection: line-number prefixes land only on injectable regions
// ---------------------------------------------------------------------------

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
    render(msgs, items, [], state);

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
    const lens = history(msgs);
    // Prove the adapter's provenance agrees with the injection output.
    assert.equal(isInjectableRegion(lens[0].regions[0]), false); // thinking
    assert.equal(isInjectableRegion(lens[0].regions[1]), false); // tool-input
    assert.equal(isInjectableRegion(lens[0].regions[2]), true); // tool-output

    const state: SessionState = { blocks: new Map(), marks: new Map() };
    const { items } = fold(lens, state);
    render(msgs, items, [], state);
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
      active: true,
      compressedTokens: 100,
      summaryTokens: 10,
      createdAt: 1000,
    });
    const { items } = fold(lens, state);
    render(msgs, items, [], state);

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
    render(msgs, items, [], state);
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
    render(msgs, items, [], state);
    // The line is allocated (the item is visible) but no region qualifies.
    assert.equal((msgs[0].parts?.[0] as { text: string }).text, "步骤开始");
    assert.equal((msgs[0].parts?.[1] as { text: string }).text, "think");
  });
});
