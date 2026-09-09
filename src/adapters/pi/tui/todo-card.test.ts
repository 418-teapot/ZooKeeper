/**
 * Tests for the pi todo transcript card (`todo-card.ts`).
 *
 * Boundary: the card's two pi-facing entry points (`renderCall` /
 * `renderResult`) observed at their rendered component output
 * (`component.render(width)` strings), plus the deps-shaped wrapper
 * (`buildTodoCardRenderer`).  The snapshot payload is handed in exactly
 * the shape `serializeSnapshot` persists (`{ op, phases }`), and the
 * expected lines are independent literals of the documented view-model
 * formats (glyphs from `STATUS_PRESENTATION`, the `▾ A  1/2` header, the
 * `+N more` overflow row), asserted against the projection the card
 * delegates to.  The fake theme wraps colors as `<style>…</style>` and
 * strikethrough as `~…~` so per-row hues and the completed-row crossing
 * are observable; `stripTags` normalizes for layout-only assertions.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { TodoPhase } from "../../../core/todo/types.js";
import {
  buildTodoCardRenderer,
  renderCall,
  renderResult,
} from "./todo-card.js";

/**
 * A `Component`-shaped object: anything with `render(width): string[]`.
 */
interface Renderable {
  render(width: number): string[];
}

/** Fake theme: fg wraps with the color name, strikethrough with `~`. */
const THEME = {
  fg: (style: string, text: string) => `<${style}>${text}</${style}>`,
  bg: (style: string, text: string) => `[${style}]${text}[/${style}]`,
  bold: (text: string) => text,
  italic: (text: string) => text,
  underline: (text: string) => text,
  strikethrough: (text: string) => `~${text}~`,
};

/** Render a component tree at width 80, keeping the fake-theme tags. */
function renderRaw(component: unknown, width = 80): string[] {
  const c = component as Renderable;
  return c.render(width).filter((l) => l.trim().length > 0);
}

/** Render a component tree at width 80 and strip the test theme tags. */
function renderComponent(component: unknown, width = 80): string[] {
  return renderRaw(component, width).map(stripTags);
}

function stripTags(s: string): string {
  return s
    .replace(/\[\/?[a-z0-9]+\]/g, "")
    .replace(/<\/?[a-z0-9]+>/g, "")
    .replace(/~/g, "");
}

/** The persisted snapshot shape, exactly as `serializeSnapshot` writes. */
function snapshot(op: string, phases: TodoPhase[]): unknown {
  return { op, phases };
}

/** A plain-text pi result (the shape the bridge returns). */
function textResult(
  text: string,
  details?: unknown,
): { content: Array<{ type: string; text: string }>; details?: unknown } {
  return {
    content: [{ type: "text", text }],
    ...(details === undefined ? {} : { details }),
  };
}

describe("pi todo card renderCall", () => {
  it("shows the op label and the targeted task", () => {
    const lines = renderComponent(
      renderCall({ op: "start", entries: [{ task: "实现登录中间件" }] }),
    );
    assert.equal(lines.length, 1, lines.join(" | "));
    assert.ok(
      lines[0].includes("todo(开始)") && lines[0].includes("实现登录中间件"),
      lines[0],
    );
  });

  it("lists init phase names from the canonical list payload", () => {
    const lines = renderComponent(
      renderCall({
        op: "init",
        entries: [
          {
            list: [
              { phase: "环境搭建", items: ["a", "b"] },
              { phase: "核心实现", items: ["c"] },
            ],
          },
        ],
      }),
    );
    assert.ok(
      lines[0].includes("todo(初始化)") &&
        lines[0].includes("环境搭建") &&
        lines[0].includes("核心实现"),
      lines.join(" | "),
    );
  });

  it("caps the target list and counts the rest", () => {
    const lines = renderComponent(
      renderCall({
        op: "done",
        entries: [{ tasks: ["t1", "t2", "t3", "t4", "t5"] }],
      }),
    );
    assert.ok(
      lines[0].includes("t1") &&
        lines[0].includes("t3") &&
        !lines[0].includes("t4") &&
        lines[0].includes("+2"),
      lines.join(" | "),
    );
  });

  it("renders just the label for view and unknown ops", () => {
    const view = renderComponent(renderCall({ op: "view" }));
    assert.equal(view[0], "todo(查看)", view.join(" | "));
    const weird = renderComponent(renderCall({ op: "explode" }));
    assert.ok(weird[0].includes("todo(explode)"), weird.join(" | "));
  });

  it("degrades without throwing on malformed args", () => {
    for (const args of [
      {},
      { op: 42 },
      { op: "init", entries: "oops" },
      { op: "init", entries: [null, 7, { list: "x" }] },
    ]) {
      const lines = renderComponent(renderCall(args));
      assert.equal(
        lines.length,
        1,
        `one title line for ${JSON.stringify(args)}`,
      );
    }
  });
});

describe("pi todo card renderResult — snapshot rows", () => {
  it("renders the pending row with the waiting glyph and dim hue", () => {
    const phases: TodoPhase[] = [
      { name: "A", tasks: [{ content: "t1", status: "pending" }] },
    ];
    const raw = renderRaw(
      renderResult(textResult("x", snapshot("init", phases)), {}, THEME),
    );
    assert.ok(
      raw.some((l) => l.includes("<dim>○ t1</dim>")),
      raw.join(" | "),
    );
  });

  it("renders the in-progress row with the spinner frame and warning hue", () => {
    const phases: TodoPhase[] = [
      {
        name: "A",
        tasks: [
          { content: "t1", status: "in_progress" },
          { content: "t2", status: "pending" },
        ],
      },
    ];
    const raw = renderRaw(
      renderResult(textResult("x", snapshot("start", phases)), {}, THEME, {
        state: { frame: 3 },
      }),
    );
    assert.ok(
      raw.some((l) => l.includes("<warning>⠸ t1</warning>")),
      `frame 3 of the shared braille spinner expected: ${raw.join(" | ")}`,
    );
  });

  it("renders the completed lead row struck through with the success hue", () => {
    const phases: TodoPhase[] = [
      {
        name: "A",
        tasks: [
          { content: "c1", status: "completed" },
          { content: "p1", status: "pending" },
        ],
      },
    ];
    const raw = renderRaw(
      renderResult(textResult("x", snapshot("done", phases)), {}, THEME),
    );
    assert.ok(
      raw.some((l) => l.includes("<success>● ~c1~</success>")),
      `colored struck-through success row expected: ${raw.join(" | ")}`,
    );
  });

  it("renders the abandoned lead row with the cancelled square and dim hue", () => {
    const phases: TodoPhase[] = [
      {
        name: "A",
        tasks: [
          { content: "c1", status: "completed" },
          { content: "a1", status: "abandoned" },
          { content: "p1", status: "pending" },
        ],
      },
    ];
    const raw = renderRaw(
      renderResult(textResult("x", snapshot("drop", phases)), {}, THEME),
    );
    assert.ok(
      raw.some((l) => l.includes("<dim>■ a1</dim>")),
      raw.join(" | "),
    );
  });

  it("renders the blocked row with the static dot, warning hue and note", () => {
    const phases: TodoPhase[] = [
      {
        name: "A",
        tasks: [
          { content: "b1", status: "blocked", blocker: "等用户确认" },
          { content: "p1", status: "pending" },
        ],
      },
    ];
    const raw = renderRaw(
      renderResult(textResult("x", snapshot("block", phases)), {}, THEME),
    );
    assert.ok(
      raw.some((l) => l.includes("<warning>● b1 — 等用户确认</warning>")),
      raw.join(" | "),
    );
  });

  it("leads with the summary line and prints the active header", () => {
    const phases: TodoPhase[] = [
      { name: "A", tasks: [{ content: "t1", status: "in_progress" }] },
    ];
    const lines = renderComponent(
      renderResult(textResult("x", snapshot("start", phases)), {}, THEME),
    );
    assert.ok(lines[0].includes("0/1 done — t1"), lines.join(" | "));
    assert.ok(
      lines.some((l) => l.includes("▾ A  0/1")),
      lines.join(" | "),
    );
  });

  it("omits the summary line when expanded", () => {
    const phases: TodoPhase[] = [
      { name: "A", tasks: [{ content: "t1", status: "pending" }] },
    ];
    const lines = renderComponent(
      renderResult(
        textResult("x", snapshot("init", phases)),
        { expanded: true },
        THEME,
      ),
    );
    assert.ok(!lines.some((l) => l.includes("done —")), lines.join(" | "));
    assert.ok(
      lines.some((l) => l.includes("○ t1")),
      lines.join(" | "),
    );
  });

  it("collapses long plans into a +N overflow row within the budget", () => {
    const tasks = Array.from({ length: 10 }, (_, i) => ({
      content: `t${i + 1}`,
      status: "pending" as const,
    }));
    const phases: TodoPhase[] = [{ name: "A", tasks }];
    const lines = renderComponent(
      renderResult(textResult("x", snapshot("init", phases)), {}, THEME),
    );
    // summary + header + 3 rows + overflow = 6 lines, budget never blown.
    assert.equal(lines.length, 6, lines.join(" | "));
    assert.ok(
      lines.some((l) => l.includes("+7 more")),
      lines.join(" | "),
    );
  });

  it("expands long plans into the wide budget with its own +N row", () => {
    const tasks = Array.from({ length: 20 }, (_, i) => ({
      content: `t${i + 1}`,
      status: "pending" as const,
    }));
    const phases: TodoPhase[] = [{ name: "A", tasks }];
    const lines = renderComponent(
      renderResult(
        textResult("x", snapshot("init", phases)),
        { expanded: true },
        THEME,
      ),
    );
    // header + 14 rows + overflow = 16 lines (the expanded budget).
    assert.equal(lines.length, 16, lines.join(" | "));
    assert.ok(
      lines.some((l) => l.includes("+6 more")),
      lines.join(" | "),
    );
  });

  it("renders the summary line for an empty plan (never blank)", () => {
    for (const options of [{}, { expanded: true }]) {
      const lines = renderComponent(
        renderResult(textResult("x", snapshot("rm", [])), options, THEME),
      );
      assert.equal(lines.length, 1, lines.join(" | "));
      assert.ok(lines[0].includes("0/0 done"), lines.join(" | "));
    }
  });
});

describe("pi todo card renderResult — plain-text fallback", () => {
  it("renders the result text when details is absent (view / failed call)", () => {
    const lines = renderComponent(
      renderResult(textResult("Remaining items: none."), {}, THEME),
    );
    assert.ok(
      lines.some((l) => l.includes("Remaining items: none.")),
      lines.join(" | "),
    );
    assert.ok(
      !lines.some((l) => l.includes("done")),
      `no card rows expected: ${lines.join(" | ")}`,
    );
  });

  it("never throws on malformed details", () => {
    const junk: unknown[] = [
      "oops",
      42,
      [],
      {},
      { op: "init" },
      { op: 1, phases: [] },
      { op: "init", phases: "nope" },
      { op: "init", phases: [{ name: 1, tasks: [] }] },
      { op: "init", phases: [{ name: "A", tasks: [{ content: "c" }] }] },
      {
        op: "init",
        phases: [
          { name: "A", tasks: [{ content: "c", status: "teleported" }] },
        ],
      },
    ];
    for (const details of junk) {
      const lines = renderComponent(
        renderResult(textResult("fallback text", details), {}, THEME),
      );
      assert.ok(
        lines.some((l) => l.includes("fallback text")),
        `junk details=${JSON.stringify(details)} must fall back, got: ${lines.join(" | ")}`,
      );
    }
  });

  it("keeps rows uncolored when the theme carries no fg", () => {
    const phases: TodoPhase[] = [
      { name: "A", tasks: [{ content: "t1", status: "pending" }] },
    ];
    const raw = renderRaw(
      renderResult(textResult("x", snapshot("init", phases)), {}, {
        bold: (t: string) => t,
      } as never),
    );
    assert.ok(
      raw.some((l) => l.includes("○ t1")),
      raw.join(" | "),
    );
    assert.ok(
      !raw.some((l) => l.includes("<")),
      `no color tags without a usable theme: ${raw.join(" | ")}`,
    );
  });
});

describe("pi buildTodoCardRenderer (deps port shape)", () => {
  it("exposes renderCall / renderResult and delegates through them", () => {
    const renderer = buildTodoCardRenderer();
    assert.equal(typeof renderer.renderCall, "function");
    assert.equal(typeof renderer.renderResult, "function");

    const call = renderer.renderCall(
      { op: "append", entries: [{ phase: "收尾", items: ["x"] }] },
      THEME,
      {},
    ) as Renderable;
    assert.ok(
      call
        .render(80)
        .some((l) => l.includes("todo(追加)") && l.includes("收尾")),
    );

    const phases: TodoPhase[] = [
      { name: "A", tasks: [{ content: "t1", status: "pending" }] },
    ];
    const result = renderer.renderResult(
      textResult("x", snapshot("init", phases)),
      undefined,
      THEME,
      undefined,
    ) as Renderable;
    assert.ok(
      result.render(80).some((l) => l.includes("○ t1")),
      l0(result.render(80)),
    );
  });

  it("tolerates empty invocation surfaces (undefined args / theme)", () => {
    const renderer = buildTodoCardRenderer();
    const call = renderer.renderCall(undefined, undefined) as Renderable;
    assert.ok(call.render(80).length >= 1);
    const result = renderer.renderResult(
      undefined,
      undefined,
      undefined,
      undefined,
    ) as Renderable;
    assert.deepEqual(
      result.render(80).filter((l) => l.trim() !== ""),
      [],
    );
  });
});

/** Join rendered lines for assertion messages. */
function l0(lines: string[]): string {
  return lines.join(" | ");
}
