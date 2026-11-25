/**
 * Tests for the `/view` page formatter (`view-page.ts`).
 *
 * Boundary: `formatViewPage` — it turns one round's preview (its folded
 * view items, its numbering, its render plan, the pre-render lens and the
 * projection of the rendered conversation) into the page's complete logical
 * lines.  Expected lines are hand-computed literals, so they pin the field
 * order, the separators, the page-wide column widths and the token
 * accounting.
 *
 * The render plan is part of every fixture: it is the only evidence of
 * which message received a `[mN] ` line ref, so the page must read the
 * injected ref from it instead of pattern-matching every region.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type {
  HostMessage,
  Invocation,
  RegionKind,
  RenderEntry,
  Role,
  TextRegion,
  ViewItem,
} from "./lens.js";
import { project } from "./lens.js";
import type { RoundPreview } from "./pipeline.js";
import { formatViewPage } from "./view-page.js";
import type { NumberedItem } from "./view-refs.js";
import {
  createWritableRegion,
  type RegionProvenance,
} from "./writable-regions.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** The provenance a host adapter records for each fixture region kind. */
const PROVENANCE: Record<RegionKind, RegionProvenance> = {
  content: "text",
  thinking: "thinking",
  "tool-input": "tool",
  "tool-output": "tool",
};

/** One region over fixed text, with the provenance an adapter records. */
function region(kind: RegionKind, text: string): TextRegion {
  return createWritableRegion(
    kind,
    () => text,
    () => {},
    PROVENANCE[kind],
  );
}

/** One lens message over the given regions. */
function message(
  role: Role,
  regions: TextRegion[],
  hidden = false,
): HostMessage {
  return { role, hidden, regions };
}

/**
 * Assemble a round preview from its parts.
 *
 * @param lens - The pre-render transcript (token accounting, roles).
 * @param rendered - The transcript the transform sends (text, invocations).
 * @param items - The folded view items.
 * @param plan - The render plan the transform applied to `rendered`.
 * @param invocations - The rendered invocation table.
 * @returns The preview.
 */
function preview(
  lens: HostMessage[],
  rendered: HostMessage[],
  items: ViewItem[],
  plan: RenderEntry[],
  invocations: Invocation[] = [],
): RoundPreview {
  const numbered: NumberedItem[] = [];
  const hidden = new Set<number>();
  lens.forEach((entry, ordinal) => {
    if (entry.hidden) hidden.add(ordinal);
  });
  for (const item of items) {
    if (item.type === "summary") {
      numbered.push({ n: numbered.length + 1, item });
      continue;
    }
    let unitHidden = true;
    for (let ordinal = item.start; ordinal < item.end; ordinal++) {
      if (!hidden.has(ordinal)) unitHidden = false;
    }
    if (unitHidden) continue;
    numbered.push({ n: numbered.length + 1, item });
  }
  return {
    lens,
    rendered: project(rendered, invocations),
    items,
    numbered,
    plan,
  };
}

/** An original view item over `[start, end)`. */
function original(start: number, end: number): ViewItem {
  return { type: "original", start, end };
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

describe("formatViewPage — rows", () => {
  /** A transcript whose second unit is a long-thinking tool call. */
  function toolTurn(): RoundPreview {
    const thinking = "思考".repeat(40);
    const lens = [
      message("user", [region("content", "看一下目录")]),
      message("assistant", [
        region("thinking", thinking),
        region("content", "我来执行"),
        region("tool-input", '{"command":"ls"}'),
      ]),
      message("toolResult", [region("tool-output", "file1")]),
    ];
    const rendered = [
      message("user", [region("content", "[m1] 看一下目录")]),
      message("assistant", [
        region("thinking", thinking),
        region("content", "[m2] 我来执行"),
        region("tool-input", '{"command":"ls"}'),
      ]),
      message("toolResult", [region("tool-output", "file1")]),
    ];
    const invocations: Invocation[] = [
      {
        name: "bash",
        status: "completed",
        input: { ordinal: 1, regionIndex: 2 },
        output: { ordinal: 2, regionIndex: 0 },
      },
    ];
    return preview(
      lens,
      rendered,
      [original(0, 1), original(1, 3)],
      [
        { kind: "source", ordinal: 0, line: 1 },
        { kind: "source", ordinal: 1, line: 2 },
        { kind: "source", ordinal: 2 },
      ],
      invocations,
    );
  }

  it("renders one aligned line per mN with the tool name, arguments and result", () => {
    assert.deepEqual(formatViewPage(toolTurn()), [
      " 4 tokens  user:      │ [m1] 看一下目录",
      '63 tokens  assistant: │ [m2] 我来执行 [tool bash] {"command":"ls"} [result] file1',
    ]);
  });

  it("keeps a long thinking block out of the preview while content exists", () => {
    const [first, second] = formatViewPage(toolTurn());

    assert.equal(first?.includes("思考"), false);
    assert.equal(second?.includes("思考"), false);
  });

  it("falls back to the thinking text when the unit carries nothing else", () => {
    const page = formatViewPage(
      preview(
        [message("assistant", [region("thinking", "只有思考")])],
        [message("assistant", [region("thinking", "只有思考")])],
        [original(0, 1)],
        [{ kind: "source", ordinal: 0 }],
      ),
    );

    assert.deepEqual(page, ["3 tokens  assistant: │ [m1] 只有思考"]);
  });

  it("shows a folded block's rendered summary text with its mN", () => {
    const block = { start: 1, end: 3, title: "标题", summary: "正文" };
    const summaryText = "[m2] [Block b1 · 2 条] 标题\n正文";
    const page = formatViewPage(
      preview(
        [
          message("user", [region("content", "第一条消息")]),
          message("assistant", [region("content", "旧内容一")]),
          message("assistant", [region("content", "旧内容二")]),
        ],
        [
          message("user", [region("content", "[m1] 第一条消息")]),
          message("user", [region("content", summaryText)]),
        ],
        [original(0, 1), { type: "summary", block }],
        [
          { kind: "source", ordinal: 0, line: 1 },
          { kind: "summary", text: summaryText, id: 1 },
        ],
      ),
    );

    assert.deepEqual(page, [
      "4 tokens  user:    │ [m1] 第一条消息",
      "8 tokens  summary: │ [m2] [Block b1 · 2 条] 标题 正文",
    ]);
    assert.equal(
      page[1]?.split("[m2] ").length,
      2,
      "the summary's injected ref is dropped exactly once",
    );
  });

  it("keeps the token, role, separator and ref columns aligned across m9/m10", () => {
    const long = "x".repeat(4000);
    const items = [original(0, 1), original(1, 2)];
    const rendered = [
      message("user", [region("content", "[m9] 第一条消息")]),
      message("assistant", [region("content", `[m10] ${long}`)]),
    ];
    const page = formatViewPage({
      lens: [
        message("user", [region("content", "第一条消息")]),
        message("assistant", [region("content", long)]),
      ],
      rendered: project(rendered, []),
      items,
      numbered: [
        { n: 9, item: items[0] as ViewItem },
        { n: 10, item: items[1] as ViewItem },
      ],
      plan: [
        { kind: "source", ordinal: 0, line: 9 },
        { kind: "source", ordinal: 1, line: 10 },
      ],
    });

    assert.deepEqual(page, [
      "   4 tokens  user:      │ [m9]  第一条消息",
      `1000 tokens  assistant: │ [m10] ${long}`,
    ]);
    assert.equal(
      page[0]?.indexOf("│"),
      page[1]?.indexOf("│"),
      "every separator sits in one column",
    );
    assert.equal(
      page[0]?.indexOf("第一条消息"),
      page[1]?.indexOf("x"),
      "every body starts in one column",
    );
  });

  it("collapses whitespace runs and marks an empty preview", () => {
    const page = formatViewPage(
      preview(
        [
          message("user", [region("content", "  第一行\n\n第二行\t尾巴  ")]),
          message("assistant", [region("content", "")]),
        ],
        [
          message("user", [
            region("content", "[m1]   第一行\n\n第二行\t尾巴  "),
          ]),
          message("assistant", [region("content", "[m2] ")]),
        ],
        [original(0, 1), original(1, 2)],
        [
          { kind: "source", ordinal: 0, line: 1 },
          { kind: "source", ordinal: 1, line: 2 },
        ],
      ),
    );

    assert.deepEqual(page, [
      "8 tokens  user:      │ [m1] 第一行 第二行 尾巴",
      "0 tokens  assistant: │ [m2] （无内容）",
    ]);
  });

  it("skips hidden messages in the preview and the token sum", () => {
    const page = formatViewPage(
      preview(
        [
          message("user", [region("content", "可见")]),
          message("user", [region("content", "隐藏")], true),
          message("assistant", [region("content", "后续")]),
        ],
        [
          message("user", [region("content", "[m1] 可见")]),
          message("user", [region("content", "隐藏")], true),
          message("assistant", [region("content", "后续")]),
        ],
        [original(0, 3)],
        [
          { kind: "source", ordinal: 0, line: 1 },
          { kind: "source", ordinal: 1 },
          { kind: "source", ordinal: 2 },
        ],
      ),
    );

    assert.deepEqual(page, ["4 tokens  user: │ [m1] 可见 后续"]);
  });

  it("shows an appended transform message without inventing a line number", () => {
    const page = formatViewPage(
      preview(
        [message("user", [region("content", "第一条消息")])],
        [
          message("user", [region("content", "[m1] 第一条消息")]),
          message("user", [region("content", "上下文渐满：已用 65%")]),
        ],
        [original(0, 1)],
        [{ kind: "source", ordinal: 0, line: 1 }],
      ),
    );

    assert.deepEqual(page, [
      "4 tokens  user: │ [m1] 第一条消息",
      "7 tokens  user: │      上下文渐满：已用 65%",
    ]);
    assert.equal(page[1]?.includes("m2"), false, "no ref is invented");
  });

  it("keeps a line ref the transform never injected", () => {
    const page = formatViewPage(
      preview(
        [
          message("assistant", [region("content", "我来执行")]),
          message("toolResult", [
            region("tool-output", "[m7] original output"),
          ]),
        ],
        [
          message("assistant", [region("content", "[m1] 我来执行")]),
          message("toolResult", [
            region("tool-output", "[m7] original output"),
          ]),
        ],
        [original(0, 2)],
        [
          { kind: "source", ordinal: 0, line: 1 },
          { kind: "source", ordinal: 1 },
        ],
      ),
    );

    assert.equal(page.length, 1);
    assert.ok(
      page[0]?.endsWith("│ [m1] 我来执行 [result] [m7] original output"),
    );
  });

  it("keeps the thinking text's own line ref", () => {
    const page = formatViewPage(
      preview(
        [message("assistant", [region("thinking", "[m7] 回忆")])],
        [message("assistant", [region("thinking", "[m7] 回忆")])],
        [original(0, 1)],
        [{ kind: "source", ordinal: 0 }],
      ),
    );

    assert.ok(page[0]?.endsWith("│ [m1] [m7] 回忆"));
  });

  it("keeps the appended message's own line ref", () => {
    const page = formatViewPage(
      preview(
        [message("user", [region("content", "第一条消息")])],
        [
          message("user", [region("content", "[m1] 第一条消息")]),
          message("user", [region("content", "[m7] 上下文渐满")]),
        ],
        [original(0, 1)],
        [{ kind: "source", ordinal: 0, line: 1 }],
      ),
    );

    assert.ok(page[1]?.endsWith("[m7] 上下文渐满"));
  });

  it("drops only the ref the transform injected", () => {
    const page = formatViewPage(
      preview(
        [message("user", [region("content", "[m7] 原文")])],
        [message("user", [region("content", "[m1] [m7] 原文")])],
        [original(0, 1)],
        [{ kind: "source", ordinal: 0, line: 1 }],
      ),
    );

    assert.equal(page.length, 1);
    assert.ok(page[0]?.endsWith("│ [m1] [m7] 原文"));
    assert.equal(
      page[0]?.split("[m1] ").length,
      2,
      "the injected ref is dropped exactly once",
    );
  });
});

// ---------------------------------------------------------------------------
// Fail-closed pages
// ---------------------------------------------------------------------------

describe("formatViewPage — missing round", () => {
  it("reports a hint when the session holds no message to preview", () => {
    assert.deepEqual(formatViewPage(undefined), [
      "当前会话还没有可显示的消息。",
    ]);
  });

  it("reports a hint when the round has no visible line", () => {
    assert.deepEqual(formatViewPage(preview([], [], [], [])), [
      "当轮上下文视图没有可显示的行。",
    ]);
  });
});
