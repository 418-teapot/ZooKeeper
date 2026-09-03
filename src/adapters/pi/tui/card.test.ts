/**
 * Tests for the pi TUI transcript card (`src/adapters/pi/tui/card.ts`).
 *
 * The card renderer is the only pi-facing translation layer: given a
 * structured progress `details` payload it produces a pi-tui Component tree
 * whose rendered text matches the view-model layout.  These tests assert
 * (1) rendering never throws for the partial and terminal states, (2) the
 * rendered text content matches the agreed visual contract (spinner +
 * current tool + recent output + stats for a running partial; ✓/✗/⏹
 * markers for terminal states), and (3) every rendered line fits the target
 * width — measured with pi's own `visibleWidth` — so multi-line blocks, CJK
 * wide characters, and ANSI escapes are wrapped/truncated and pi's
 * `doRender` width guard never fires.
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  type Component,
  Container,
  visibleWidth,
} from "@earendil-works/pi-tui";
import type { SubagentProgress } from "../../../core/subagent/driver.js";
import {
  finishRun,
  resetRegistry,
  startRun,
  updateRun,
} from "../../../core/subagent/registry.js";
import type { CardLine } from "../../../core/subagent/view.js";
import {
  addLine,
  buildSubagentCardRenderer,
  type PiThemeLike,
} from "./card.js";
import { fullMarkdownTheme, hueToPiColor } from "./theme.js";

// The run registry is process-global (bun shares one isolate), so reset it
// between tests to keep the card's nested-children lookups deterministic.
afterEach(() => {
  resetRegistry();
});

/** A theme stub that wraps each colorized string in `<color>` tags. */
const theme: PiThemeLike = {
  fg: (color, text) => `<${color}>${text}</${color}>`,
  bold: (text) => `<b>${text}</b>`,
  italic: (text) => `<i>${text}</i>`,
  underline: (text) => `<u>${text}</u>`,
  strikethrough: (text) => `<s>${text}</s>`,
};

/** Render a component tree to plain lines, stripping color tags. */
function renderLines(component: unknown): string[] {
  const c = component as Component;
  return c.render(80).map((line) => line.replace(/<[^>]+>/g, "").trimEnd());
}

/** Assert every rendered line fits `width` by its visible width. */
function assertFitsWidth(lines: string[], width: number): void {
  for (const line of lines) {
    assert.ok(
      visibleWidth(line) <= width,
      `line exceeds width ${width}: (visible=${visibleWidth(line)}) ${JSON.stringify(line)}`,
    );
  }
}

/** A running partial progress payload. */
function partialDetails(): SubagentProgress {
  return {
    agent: "beaver",
    currentTool: "bash",
    output: "编译子代理",
    toolCalls: [{ name: "bash", summary: "running build" }],
    outputLines: ["编译子代理"],
    turnCount: 1,
    toolCallCount: 1,
    startedAt: Date.now() - 65000,
    done: false,
  };
}

describe("hueToPiColor", () => {
  it("maps every semantic hue to the agreed pi color", () => {
    assert.equal(hueToPiColor("running"), "warning");
    assert.equal(hueToPiColor("success"), "success");
    assert.equal(hueToPiColor("error"), "error");
    assert.equal(hueToPiColor("muted"), "dim");
    assert.equal(hueToPiColor("accent"), "accent");
  });
});

describe("card renderer — partial (running)", () => {
  it("produces a component tree with current tool, output, and stats — no title", () => {
    const { renderResult } = buildSubagentCardRenderer();
    const component = renderResult(
      { details: partialDetails() },
      { isPartial: true, expanded: false },
      theme,
      { state: {}, args: { agent: "beaver", description: "实现功能" } },
    );

    const lines = renderLines(component);
    assert.ok(lines.length >= 3, `expected ≥3 lines, got ${lines.length}`);
    // The running card must NOT render a title: it is stacked below the
    // `renderCall` card, which owns the static spinner title.  A title here
    // would duplicate it.
    const titleLine = lines.find((l) => /^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] subagent\(/.test(l));
    assert.ok(
      titleLine === undefined,
      `running card must not render a title: ${lines.join(" | ")}`,
    );
    // Current tool line.
    assert.ok(
      lines.some((l) => l.includes("bash")),
      "current tool missing",
    );
    // Tool-call lines render the self-contained summary after the arrow,
    // never re-prefixing the tool name.
    assert.ok(
      lines.some((l) => l.includes("→ running build")),
      `tool-call line missing: ${lines.join(" | ")}`,
    );
    assert.ok(
      !lines.some((l) => l.includes("→ bash running build")),
      `duplicated tool name: ${lines.join(" | ")}`,
    );
    // Recent output.
    assert.ok(
      lines.some((l) => l.includes("编译子代理")),
      "recent output missing",
    );
    // Stats line.
    assert.ok(
      lines.some((l) => l.includes("1 turn") && l.includes("1 tool")),
      "stats line missing",
    );
    assert.ok(
      !lines.some((l) => l.includes("1 turns") || l.includes("1 tools")),
      "stats line must use the singular for a count of 1",
    );
  });

  it("starts a spinner interval that invalidates the context while partial", () => {
    const { renderResult } = buildSubagentCardRenderer();
    let invalidations = 0;
    const state: Record<string, unknown> = {};
    renderResult(
      { details: partialDetails() },
      { isPartial: true, expanded: false },
      theme,
      {
        state,
        args: { agent: "beaver", description: "实现功能" },
        invalidate: () => {
          invalidations += 1;
        },
      },
    );

    // The running render starts (idempotently) a ~100ms timer; awaiting a
    // short real interval drives the invalidation (the timer is unref'd, so
    // it never blocks process exit).
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        const timer = state.spinnerTimer as
          | ReturnType<typeof setInterval>
          | undefined;
        assert.ok(timer !== undefined, "spinner timer must be started");
        clearInterval(timer);
        assert.ok(invalidations >= 1, "invalidate must be driven by the timer");
        resolve();
      }, 250);
    });
  });

  it("clears the spinner interval on a terminal render", () => {
    const { renderResult } = buildSubagentCardRenderer();
    const state: Record<string, unknown> = {};
    const terminalDetails = {
      agent: "beaver",
      output: "done",
      done: true,
      result: { kind: "ok", text: "all tests pass" },
    };
    // Start the timer with a partial render.
    renderResult(
      { details: partialDetails() },
      { isPartial: true, expanded: false },
      theme,
      {
        state,
        args: { agent: "beaver", description: "实现功能" },
        invalidate: () => {},
      },
    );
    assert.ok(
      state.spinnerTimer !== undefined,
      "spinner timer must be started on partial",
    );
    // Terminal render clears it.
    renderResult(
      { details: terminalDetails },
      { isPartial: false, expanded: false },
      theme,
      { state, args: { agent: "beaver", description: "实现功能" } },
    );
    assert.equal(
      state.spinnerTimer,
      undefined,
      "spinner timer must be cleared on terminal render",
    );
  });

  it("isolates timers per render-context state across concurrent cards", () => {
    const { renderResult } = buildSubagentCardRenderer();
    const stateA: Record<string, unknown> = {};
    const stateB: Record<string, unknown> = {};
    const terminalDetails = {
      agent: "beaver",
      output: "done",
      done: true,
      result: { kind: "ok", text: "done" },
    };
    const invalidate = (): void => {};
    // Two concurrent subagent cards: each owns its own renderer state.
    renderResult(
      { details: partialDetails() },
      { isPartial: true, expanded: false },
      theme,
      {
        state: stateA,
        args: { agent: "beaver", description: "A" },
        invalidate,
      },
    );
    renderResult(
      { details: partialDetails() },
      { isPartial: true, expanded: false },
      theme,
      {
        state: stateB,
        args: { agent: "beaver", description: "B" },
        invalidate,
      },
    );
    assert.ok(
      stateA.spinnerTimer !== undefined,
      "card A timer must be started",
    );
    assert.ok(
      stateB.spinnerTimer !== undefined,
      "card B timer must be started",
    );
    assert.notEqual(
      stateA.spinnerTimer,
      stateB.spinnerTimer,
      "timers must be distinct per render context",
    );
    // Clearing card A must not affect card B.
    renderResult(
      { details: terminalDetails },
      { isPartial: false, expanded: false },
      theme,
      { state: stateA, args: { agent: "beaver", description: "A" } },
    );
    assert.equal(
      stateA.spinnerTimer,
      undefined,
      "card A timer must be cleared",
    );
    assert.ok(
      stateB.spinnerTimer !== undefined,
      "card B timer must survive card A's clear",
    );
    // Cleanup card B.
    renderResult(
      { details: terminalDetails },
      { isPartial: false, expanded: false },
      theme,
      { state: stateB, args: { agent: "beaver", description: "B" } },
    );
    assert.equal(stateB.spinnerTimer, undefined);
  });
});

describe("card renderer — terminal states", () => {
  it("renders a success card with the ✓ marker and final summary", () => {
    const { renderResult } = buildSubagentCardRenderer();
    const component = renderResult(
      {
        details: {
          agent: "beaver",
          output: "done",
          done: true,
          result: { kind: "ok", text: "all tests pass" },
        } as SubagentProgress,
      },
      { isPartial: false, expanded: false },
      theme,
      { state: {} },
    );
    const lines = renderLines(component);
    assert.ok(lines[0].includes("✓ subagent(beaver)"), lines[0]);
    assert.ok(lines.some((l) => l.includes("all tests pass")));
  });

  it("renders an error card with the ✗ marker and reason", () => {
    const { renderResult } = buildSubagentCardRenderer();
    const component = renderResult(
      {
        details: {
          agent: "beaver",
          output: "failed",
          done: true,
          result: {
            kind: "error",
            text: "failed",
            errorMessage: "exit 1",
          },
        } as SubagentProgress,
      },
      { isPartial: false, expanded: false },
      theme,
      { state: {} },
    );
    const lines = renderLines(component);
    assert.ok(lines[0].includes("✗ subagent(beaver)"), lines[0]);
    assert.ok(lines.some((l) => l.includes("exit 1")));
  });

  it("renders an aborted card with the ⏹ marker", () => {
    const { renderResult } = buildSubagentCardRenderer();
    const component = renderResult(
      {
        details: {
          agent: "beaver",
          output: "stopped",
          done: true,
          result: { kind: "aborted", text: "stopped early" },
        } as SubagentProgress,
      },
      { isPartial: false, expanded: false },
      theme,
      { state: {} },
    );
    const lines = renderLines(component);
    assert.ok(lines[0].includes("⏹ subagent(beaver)"), lines[0]);
    assert.ok(lines.some((l) => l.includes("stopped early")));
  });

  it("shows more final output when expanded", () => {
    const { renderResult } = buildSubagentCardRenderer();
    const longText = ["line one", "line two", "line three", "line four"].join(
      "\n",
    );
    const collapsed = renderLines(
      renderResult(
        {
          details: {
            ...partialDetails(),
            result: { kind: "ok", text: longText },
          },
        },
        { isPartial: false, expanded: false },
        theme,
        { state: {} },
      ),
    );
    const expanded = renderLines(
      renderResult(
        {
          details: {
            ...partialDetails(),
            result: { kind: "ok", text: longText },
          },
        },
        { isPartial: false, expanded: true },
        theme,
        { state: {} },
      ),
    );
    assert.ok(
      expanded.join("\n").length > collapsed.join("\n").length,
      "expanded must show more final output",
    );
  });

  it("renders no tool-call lines on a terminal card", () => {
    const { renderResult } = buildSubagentCardRenderer();
    const component = renderResult(
      {
        details: {
          agent: "beaver",
          output: "done",
          done: true,
          toolCalls: [{ name: "bash", summary: "$ npm run build" }],
          result: { kind: "ok", text: "done" },
        } as SubagentProgress,
      },
      { isPartial: false, expanded: false },
      theme,
      { state: {} },
    );
    const lines = renderLines(component);
    assert.ok(
      !lines.some((l) => l.includes("→")),
      `terminal card must not render tool-call lines: ${lines.join(" | ")}`,
    );
  });

  it("renders the model id badge on the terminal title", () => {
    const { renderResult } = buildSubagentCardRenderer();
    const component = renderResult(
      {
        details: {
          agent: "lynx",
          output: "done",
          done: true,
          model: "dummy-small",
          result: { kind: "ok", text: "done" },
        } as SubagentProgress,
      },
      { isPartial: false, expanded: false },
      theme,
      { state: {} },
    );
    const lines = renderLines(component);
    assert.ok(lines[0].includes("✓ subagent(lynx)"), lines[0]);
    assert.ok(lines[0].includes("· dummy-small"), lines[0]);
  });

  it("omits the model badge on the terminal title when absent (defensive-only branch)", () => {
    const { renderResult } = buildSubagentCardRenderer();
    const component = renderResult(
      {
        details: {
          agent: "lynx",
          output: "done",
          done: true,
          result: { kind: "ok", text: "done" },
        } as SubagentProgress,
      },
      { isPartial: false, expanded: false },
      theme,
      { state: {} },
    );
    const lines = renderLines(component);
    assert.ok(lines[0].includes("✓ subagent(lynx)"), lines[0]);
    assert.ok(!lines[0].includes("dummy-small"), lines[0]);
  });

  it("never renders the session file path line on a terminal card", () => {
    const { renderResult } = buildSubagentCardRenderer();
    const component = renderResult(
      {
        details: {
          agent: "beaver",
          output: "done",
          done: true,
          sessionPath: "/home/u/.pi/agent/sessions/x/s.jsonl",
          result: { kind: "ok", text: "done" },
        } as SubagentProgress,
      },
      { isPartial: false, expanded: false },
      theme,
      { state: {} },
    );
    const lines = renderLines(component);
    assert.ok(!lines.some((l) => l.startsWith("session: ")));
  });

  it("renders the full final output through the Markdown component when expanded", () => {
    const { renderResult } = buildSubagentCardRenderer();
    const component = renderResult(
      {
        details: {
          agent: "beaver",
          output: "done",
          done: true,
          result: {
            kind: "ok",
            text: "**bold summary**\n\n- item one\n- item two",
          },
        } as SubagentProgress,
      },
      { isPartial: false, expanded: true },
      theme,
      { state: {} },
    );
    const lines = renderLines(component);
    // Markdown structure is rendered on the expanded path: the `**` markers
    // are resolved into a rendered bold word (no literal asterisks), and
    // list items land on their own bulleted lines.
    assert.ok(
      lines.some((l) => l.includes("bold summary")),
      "bold text content missing",
    );
    assert.ok(
      !lines.some((l) => l.includes("**")),
      `literal bold markers must be resolved by Markdown: ${lines.join(" | ")}`,
    );
    assert.ok(
      lines.some((l) => l.includes("item one")) &&
        lines.some((l) => l.includes("item two")),
      "list items missing",
    );
    assertFitsWidth(lines, 80);
  });

  it("collapsed truncates the preview to the render width with an ellipsis", () => {
    const { renderResult } = buildSubagentCardRenderer();
    const longLine = `line ${"x".repeat(200)}`; // well past the 80-col viewport
    const component = renderResult(
      {
        details: {
          agent: "beaver",
          output: "done",
          done: true,
          result: { kind: "ok", text: longLine },
        } as SubagentProgress,
      },
      { isPartial: false, expanded: false },
      theme,
      { state: {} },
    );
    const lines = renderLines(component);
    // The collapsed preview is width-truncated: every rendered line fits the
    // viewport and the preview carries the width-truncation ellipsis
    // (pi's `truncateToWidth` default `...`).
    assertFitsWidth(lines, 80);
    const previewLine = lines.find((l) => l.includes("line"));
    assert.ok(previewLine !== undefined, "preview line missing");
    assert.ok(
      previewLine.endsWith("..."),
      `collapsed preview must be truncated with the width ellipsis: ${previewLine}`,
    );
    assert.ok(
      previewLine.trimEnd().length < longLine.length,
      "overlong content must not survive the width truncation",
    );
  });

  it("collapsed previews the first non-empty line as plain text", () => {
    const { renderResult } = buildSubagentCardRenderer();
    const text = "\n\n**bold summary**\n\n- item one\n- item two";
    const collapsed = renderLines(
      renderResult(
        {
          details: {
            agent: "beaver",
            output: "done",
            done: true,
            result: { kind: "ok", text },
          } as SubagentProgress,
        },
        { isPartial: false, expanded: false },
        theme,
        { state: {} },
      ),
    );
    const expanded = renderLines(
      renderResult(
        {
          details: {
            agent: "beaver",
            output: "done",
            done: true,
            result: { kind: "ok", text },
          } as SubagentProgress,
        },
        { isPartial: false, expanded: true },
        theme,
        { state: {} },
      ),
    );
    // Collapsed: the first non-empty line, rendered as plain text — the
    // `**` markers stay literal (the preview is a single-line fold, not a
    // markdown render).
    assert.ok(
      collapsed.some((l) => l.includes("**bold summary**")),
      `collapsed must preview the raw first line: ${collapsed.join(" | ")}`,
    );
    assert.ok(
      collapsed.some((l) => l.includes("**")),
      "collapsed preview must keep markdown markers literal",
    );
    // Expanded: markdown is resolved (no literal asterisks) and both list
    // items render.
    assert.ok(
      expanded.some((l) => l.includes("bold summary")),
      "expanded bold content missing",
    );
    assert.ok(
      !expanded.some((l) => l.includes("**")),
      `expanded must resolve markdown markers: ${expanded.join(" | ")}`,
    );
    assert.ok(
      expanded.some((l) => l.includes("item one")) &&
        expanded.some((l) => l.includes("item two")),
      "expanded list items missing",
    );
    assertFitsWidth(collapsed, 80);
    assertFitsWidth(expanded, 80);
  });

  it("keeps the running card output as plain text (no markdown resolution)", () => {
    const { renderResult } = buildSubagentCardRenderer();
    const component = renderResult(
      { details: { ...partialDetails(), outputLines: ["**raw** bold"] } },
      { isPartial: true, expanded: false },
      theme,
      { state: {}, args: { agent: "beaver", description: "实现功能" } },
    );
    const lines = renderLines(component);
    // Running output stays literal — markdown resolution is terminal-only.
    assert.ok(
      lines.some((l) => l.includes("**raw** bold")),
      "running output must stay literal",
    );
  });
});

describe("card renderer — fallback", () => {
  it("falls back to the text content when details is missing", () => {
    const { renderResult } = buildSubagentCardRenderer();
    const component = renderResult(
      { content: [{ type: "text", text: "plain fallback" }] },
      { isPartial: false, expanded: false },
      theme,
      { state: {} },
    );
    const lines = renderLines(component);
    assert.ok(lines.some((l) => l.includes("plain fallback")));
  });

  it("renders without throwing for an empty result", () => {
    const { renderResult } = buildSubagentCardRenderer();
    assert.doesNotThrow(() => {
      const component = renderResult(
        {},
        { isPartial: false, expanded: false },
        theme,
        { state: {} },
      );
      renderLines(component);
    });
  });
});

describe("card renderer — renderCall", () => {
  it("renders the title only (no prompt preview)", () => {
    const { renderCall } = buildSubagentCardRenderer();
    const component = renderCall(
      { agent: "beaver", description: "实现功能", prompt: "do the work" },
      theme,
      { state: { frame: 0 }, isPartial: true },
    );
    const lines = renderLines(component);
    assert.equal(
      lines.length,
      1,
      `expected exactly one line: ${lines.join("|")}`,
    );
    assert.ok(lines[0].includes("subagent(beaver)"));
    assert.ok(lines[0].includes("实现功能"));
    // The prompt preview is dropped — the description already labels the
    // task, and a raw preview would read as noise.
    assert.ok(
      !lines.some((l) => l.includes("do the work")),
      "prompt preview must not be rendered",
    );
  });

  it("renders the model id badge on the running title when shared state carries it", () => {
    const { renderCall, renderResult } = buildSubagentCardRenderer();
    const state: Record<string, unknown> = {};
    // The running renderResult first publishes the resolved model onto the
    // shared renderer state (the same state the stacked renderCall reads).
    renderResult(
      { details: { ...partialDetails(), model: "dummy-small" } },
      { isPartial: true, expanded: false },
      theme,
      { state, args: { agent: "beaver", description: "实现功能" } },
    );
    const lines = renderLines(
      renderCall({ agent: "beaver", description: "实现功能" }, theme, {
        state: { frame: 0, model: state.model },
        isPartial: true,
      }),
    );
    assert.ok(lines[0].includes("subagent(beaver)"), lines[0]);
    assert.ok(lines[0].includes("· dummy-small"), lines[0]);
  });

  it("omits the model badge on the running title when no model was resolved (defensive-only branch)", () => {
    const { renderCall } = buildSubagentCardRenderer();
    const lines = renderLines(
      renderCall({ agent: "beaver", description: "实现功能" }, theme, {
        state: { frame: 0 },
        isPartial: true,
      }),
    );
    assert.ok(lines[0].includes("subagent(beaver)"), lines[0]);
    assert.ok(!lines[0].includes("dummy-small"), lines[0]);
  });

  it("advances the spinner frame with the shared renderer state", () => {
    const { renderCall } = buildSubagentCardRenderer();
    const frameA = renderLines(
      renderCall({ agent: "beaver", description: "实现功能" }, theme, {
        state: { frame: 1 },
        isPartial: true,
      }),
    )[0];
    const frameB = renderLines(
      renderCall({ agent: "beaver", description: "实现功能" }, theme, {
        state: { frame: 2 },
        isPartial: true,
      }),
    )[0];
    // Consecutive shared frames resolve to different spinner glyphs, so a
    // title rebuilt on each invalidate visibly animates.
    assert.notEqual(frameA, frameB, "consecutive frames must differ");
    assert.ok(/^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] /.test(frameA), frameA);
    assert.ok(/^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] /.test(frameB), frameB);
  });

  it("renders an empty container on a terminal render (isPartial false)", () => {
    const { renderCall } = buildSubagentCardRenderer();
    const component = renderCall(
      { agent: "beaver", description: "实现功能" },
      theme,
      { state: { frame: 7 }, isPartial: false },
    );
    const lines = renderLines(component);
    assert.equal(lines.length, 0, `expected no lines: ${lines.join("|")}`);
  });

  it("keeps the terminal renderCall empty so only the renderResult title shows", () => {
    const { renderCall, renderResult } = buildSubagentCardRenderer();
    // Terminal render: the stacked renderCall yields (empty), and the
    // terminal renderResult owns the single `✓` title.
    const callLines = renderLines(
      renderCall({ agent: "beaver", description: "实现功能" }, theme, {
        state: { frame: 7 },
        isPartial: false,
      }),
    );
    const resultLines = renderLines(
      renderResult(
        {
          details: {
            agent: "beaver",
            output: "done",
            done: true,
            result: { kind: "ok", text: "all tests pass" },
          },
        },
        { isPartial: false, expanded: false },
        theme,
        { state: { frame: 7 } },
      ),
    );
    const all = [...callLines, ...resultLines];
    const titles = all.filter((l) => l.includes("subagent(beaver)"));
    assert.equal(
      titles.length,
      1,
      `exactly one title must remain at terminal: ${all.join(" | ")}`,
    );
    assert.ok(titles[0].includes("✓"), titles[0]);
    assert.ok(
      !titles[0].startsWith("⠋"),
      `running spinner must not survive the terminal state: ${titles[0]}`,
    );
  });
});

describe("card renderer — stacked title appears once", () => {
  it("renders the subagent title exactly once when renderCall + running renderResult stack", () => {
    const { renderCall, renderResult } = buildSubagentCardRenderer();
    // The tool-execution component stacks the renderCall card with the
    // running renderResult card (updateDisplay adds both, never replaces).
    const callLines = renderLines(
      renderCall(
        { agent: "beaver", description: "实现功能", prompt: "do it" },
        theme,
        { state: { frame: 0 }, isPartial: true },
      ),
    );
    const bodyLines = renderLines(
      renderResult(
        { details: partialDetails() },
        { isPartial: true, expanded: false },
        theme,
        { state: {}, args: { agent: "beaver", description: "实现功能" } },
      ),
    );
    const all = [...callLines, ...bodyLines];
    const titleMatches = all.filter((l) =>
      /^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] subagent\(beaver\)/.test(l),
    );
    assert.equal(
      titleMatches.length,
      1,
      `title must appear once: ${all.join(" | ")}`,
    );
  });
});

describe("card renderer — visible width bounds", () => {
  const width = 80;

  it("wraps a multi-line output block into separate bounded lines", () => {
    const { renderResult } = buildSubagentCardRenderer();
    const block = [
      "**SUMMARY:** 修复超宽行渲染导致 pi 崩溃的 bug。",
      "",
      "**CONTEXT:** 真实 pi 会话中崩溃。",
      "",
      "**ACCEPTANCE:** 上述验证全过。",
    ].join("\n");
    const component = renderResult(
      { details: { ...partialDetails(), outputLines: [block] } },
      { isPartial: true, expanded: false },
      theme,
      { state: {}, args: { agent: "beaver", description: "修复 bug" } },
    );
    const lines = renderLines(component);
    assertFitsWidth(lines, width);
    // The inner newlines are honored: each logical line becomes its own
    // rendered line (plus the title/current-tool/stats framing).
    assert.ok(
      lines.some((l) => l.includes("SUMMARY")),
      "SUMMARY line lost",
    );
    assert.ok(
      lines.some((l) => l.includes("ACCEPTANCE")),
      "ACCEPTANCE line lost",
    );
  });

  it("wraps a line of 60 CJK characters so every line fits", () => {
    const { renderResult } = buildSubagentCardRenderer();
    const cjk = "汉".repeat(60); // 120 columns wide — must be wrapped/truncated
    const component = renderResult(
      { details: { ...partialDetails(), outputLines: [cjk] } },
      { isPartial: true, expanded: false },
      theme,
      { state: {}, args: { agent: "beaver", description: "实现功能" } },
    );
    const lines = renderLines(component);
    assertFitsWidth(lines, width);
    // The truncated/wrapped content is still visible.
    assert.ok(
      lines.some((l) => l.includes("汉")),
      "CJK content lost",
    );
  });

  it("renders ANSI-escaped input without exceeding the width", () => {
    const { renderResult } = buildSubagentCardRenderer();
    const ansi = `\u001b[1;31m**bold red summary**\u001b[0m ${"汉".repeat(40)}`;
    const component = renderResult(
      { details: { ...partialDetails(), outputLines: [ansi] } },
      { isPartial: true, expanded: false },
      theme,
      { state: {}, args: { agent: "beaver", description: "实现功能" } },
    );
    const lines = renderLines(component);
    assertFitsWidth(lines, width);
    // ANSI escapes are zero-width and their color payload is preserved.
    assert.ok(
      lines.some((l) => l.includes("\u001b[1;31m")),
      "ANSI sequence must be preserved, not dropped",
    );
  });
});

describe("card renderer — plain text output", () => {
  const width = 80;

  it("emits no ANSI escape sequences", () => {
    const { renderResult } = buildSubagentCardRenderer();
    const component = renderResult(
      { details: { ...partialDetails(), outputLines: ["输出内容"] } },
      { isPartial: true, expanded: false },
      theme,
      { state: {}, args: { agent: "beaver", description: "实现功能" } },
    );
    const c = component as Component;
    const all = c.render(width).join("\n");
    assert.ok(
      !all.includes("\u001b["),
      "card output must contain no ANSI escapes",
    );
    assertFitsWidth(c.render(width), width);
  });

  it("renders a terminal result card with no ANSI escapes and bounded width", () => {
    const { renderResult } = buildSubagentCardRenderer();
    const component = renderResult(
      {
        details: {
          agent: "beaver",
          output: "done",
          done: true,
          result: { kind: "ok", text: "汉".repeat(50) },
        } as SubagentProgress,
      },
      { isPartial: false, expanded: false },
      theme,
      { state: {} },
    );
    const c = component as Component;
    const lines = c.render(width);
    assert.ok(!lines.join("\n").includes("\u001b["));
    assertFitsWidth(lines, width);
    assert.ok(lines.some((l) => l.includes("汉")));
  });

  it("renders a renderCall card with no ANSI escapes and bounded width", () => {
    const { renderCall } = buildSubagentCardRenderer();
    const component = renderCall(
      { agent: "beaver", description: "实现功能", prompt: "汉".repeat(50) },
      theme,
      { state: { frame: 0 }, isPartial: true },
    );
    const c = component as Component;
    const lines = c.render(width);
    assert.ok(!lines.join("\n").includes("\u001b["));
    assertFitsWidth(lines, width);
  });
});

describe("card renderer — segmented lines", () => {
  it("renders a line with segments as its concatenated plain text", () => {
    const container = new Container();
    // A fleet-style line: a pre-colorized primary segment (no hue) plus a
    // status-hued dot.  The card is uncolored by design, so it must render
    // the flat `text` verbatim — never wrapping, trimming, or stripping the
    // segments (the embedded ANSI and any hue metadata ride inside `text`).
    const line: CardLine = {
      text: "◆ \u001b[38;2;255;0;0mdolphin\u001b[39m · ●1",
      hue: "success",
      segments: [
        { text: "◆ \u001b[38;2;255;0;0mdolphin\u001b[39m" },
        { text: " · ●1", hue: "success" },
      ],
    };
    addLine(container, line, fullMarkdownTheme(theme));
    const lines = (container as Component).render(80);
    assert.ok(
      lines.some((l) => l.trimEnd() === line.text),
      `segmented lines must render as their flat concatenated text: ${JSON.stringify(lines)}`,
    );
    // The card never emits color wrappers for non-markdown lines: the
    // segments' hues are a widget-only concern, and no `theme.fg` markup
    // appears in the output.
    assert.ok(
      !lines.some((l) => l.includes("<success>") || l.includes("<error>")),
    );
  });
});

describe("card renderer — nested run children", () => {
  it("appends this run's nested children when details carries its run id", () => {
    // Seed a parent run and its child (the child's parentSession is the
    // parent's childSession, per the registry's tree invariant).
    startRun({
      id: "call-p",
      agent: "beaver",
      parentSession: "main",
      startedAt: 1000,
    });
    updateRun("call-p", { childSession: "child-ses-1" });
    startRun({
      id: "call-c",
      agent: "lynx",
      parentSession: "child-ses-1",
      label: "search",
      startedAt: 2000,
    });
    finishRun("call-c", { status: "done" });

    const { renderResult } = buildSubagentCardRenderer();
    const component = renderResult(
      {
        details: {
          agent: "beaver",
          runId: "call-p",
          output: "done",
          done: true,
          result: { kind: "ok", text: "done" },
        } as SubagentProgress,
      },
      { isPartial: false, expanded: false },
      theme,
      { state: {} },
    );
    const lines = renderLines(component);
    // The child renders as an indented nested line below the card region.
    assert.ok(
      lines.some((l) => l.includes("├─") && l.includes("subagent(lynx)")),
      `nested child line missing: ${lines.join(" | ")}`,
    );
    assert.ok(
      lines.some((l) => l.includes("search")),
      "child label missing",
    );
  });

  it("renders no nested lines when the run id is absent or unknown", () => {
    const { renderResult } = buildSubagentCardRenderer();
    const component = renderResult(
      {
        details: {
          agent: "beaver",
          output: "done",
          done: true,
          result: { kind: "ok", text: "done" },
        } as SubagentProgress,
      },
      { isPartial: false, expanded: false },
      theme,
      { state: {} },
    );
    const lines = renderLines(component);
    assert.ok(
      !lines.some((l) => l.includes("├─")),
      `no nested lines expected: ${lines.join(" | ")}`,
    );
  });

  it("appends a running child with the spinner on a terminal parent card", () => {
    startRun({
      id: "call-p",
      agent: "beaver",
      parentSession: "main",
      startedAt: 1000,
    });
    updateRun("call-p", { childSession: "child-ses-1" });
    // The child is still running (no finishRun).
    startRun({
      id: "call-c",
      agent: "spider",
      parentSession: "child-ses-1",
      startedAt: 2000,
    });

    const { renderResult } = buildSubagentCardRenderer();
    const component = renderResult(
      {
        details: {
          agent: "beaver",
          runId: "call-p",
          output: "done",
          done: true,
          result: { kind: "ok", text: "done" },
        } as SubagentProgress,
      },
      { isPartial: false, expanded: false },
      theme,
      { state: {} },
    );
    const lines = renderLines(component);
    assert.ok(
      lines.some((l) => l.includes("├─") && l.includes("subagent(spider)")),
      `running child line missing: ${lines.join(" | ")}`,
    );
  });
});
