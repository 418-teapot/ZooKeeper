/**
 * Tests for the pi subagent transcript card (`card.ts`).
 *
 * Boundary: the card's two pi-facing entry points (`renderCall` /
 * `renderResult`) observed at their rendered component output
 * (`component.render(width)` strings).  This is the pi-facing translation
 * surface: everything below it (registry, fact log, projection) is
 * exercised through the component tree exactly the way the real host
 * drives it — via tool-call-id context, partial/terminal options, and
 * shared renderer state — and no card-internal function is reached into.
 *
 * The expected line texts are independent literals of the documented
 * view-model formats (e.g. `→ $ ls -la`, `✓ subagent(lynx)`, `⟳ 1 turn ·
 * 2 tools`), asserted against the projection the card delegates to.
 */
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  finishRun,
  getRun,
  resetRegistry,
  startRun,
  updateRun,
} from "../../../core/subagent/registry.js";
import { resetHydration, waitForHydration } from "../hydrate.js";
import { type PiRenderContextLike, renderCall, renderResult } from "./card.js";
import { hueToPiColor } from "./theme.js";

/**
 * A `Component`-shaped object: anything with `render(width): string[]`.
 */
interface Renderable {
  render(width: number): string[];
}

const THEME = {
  fg: (style: string, text: string) => `<${style}>${text}</${style}>`,
  bg: (style: string, text: string) => `[${style}]${text}[/${style}]`,
  bold: (text: string) => text,
  italic: (text: string) => text,
  underline: (text: string) => text,
  strikethrough: (text: string) => text,
};

/** Render a component tree at width 80 and strip the test theme tags. */
function renderComponent(component: unknown, width: number): string[] {
  const c = component as Renderable;
  return c.render(width).map(stripTags);
}

function stripTags(s: string): string {
  return s.replace(/\[\/?[a-z0-9]+\]/g, "").replace(/<\/?[a-z0-9]+>/g, "");
}

function streamed(text: string): {
  content: { type: string; text: string }[];
} {
  return { content: [{ type: "text", text }] };
}

/** A text render context carrying a stable tool-call id. */
function toolContext(
  toolCallId: string,
  extra?: Partial<PiRenderContextLike>,
): PiRenderContextLike {
  return { toolCallId, state: {}, ...extra };
}

afterEach(() => {
  resetRegistry();
  resetHydration();
});

describe("pi hueToPiColor", () => {
  it("maps success / error / muted to pi's status colors", () => {
    assert.equal(hueToPiColor("success"), "success");
    assert.equal(hueToPiColor("error"), "error");
    assert.equal(hueToPiColor("muted"), "dim");
  });

  it("maps running to the warning color and accent to accent", () => {
    assert.equal(hueToPiColor("running"), "warning");
    assert.equal(hueToPiColor("accent"), "accent");
  });
});

describe("pi renderCall", () => {
  it("renders one title line while partial (running title)", () => {
    const container = renderCall(
      { agent: "beaver", description: "编写单元测试" },
      { isPartial: true },
    );
    const lines = renderComponent(container, 80);
    assert.equal(
      lines.filter((l) => l.includes("subagent(")).length,
      1,
      `running renderCall must render exactly one title, got: ${lines.join(" | ")}`,
    );
  });

  it("yields the title on the terminal render (empty output)", () => {
    const container = renderCall(
      { agent: "beaver", description: "编写单元测试" },
      { isPartial: false },
    );
    const lines = renderComponent(container, 80);
    assert.equal(
      lines.filter((l) => l.includes("subagent(")).length,
      0,
      `terminal renderCall must render no title, got: ${lines.join(" | ")}`,
    );
  });

  it("animates the spinner glyph across rebuilds (frame from shared state)", () => {
    const state: { frame?: number } = {};
    const glyphs: string[] = [];
    for (let i = 0; i < 3; i++) {
      const container = renderCall(
        { agent: "mola", description: "计划" },
        { isPartial: true, state },
      );
      const line = renderComponent(container, 80)[0] ?? "";
      glyphs.push(line.trim().charAt(0));
      state.frame = (state.frame ?? 0) + 1;
    }
    assert.ok(
      new Set(glyphs).size > 1,
      `spinner glyph must change across frames, got: ${JSON.stringify(glyphs)}`,
    );
  });

  it("renders the model badge from the registry run when known", () => {
    startRun({ id: "tc-model", agent: "beaver", parentSession: "main-1" });
    updateRun("tc-model", { model: "openai/gpt-codex" });
    const container = renderCall(
      { agent: "beaver", description: "写测试" },
      toolContext("tc-model", { isPartial: true }),
    );
    const lines = renderComponent(container, 80);
    assert.ok(
      lines.some(
        (l) =>
          l.includes("subagent(beaver)") &&
          l.includes("写测试") &&
          l.includes("gpt-codex"),
      ),
      lines.join(" | "),
    );
  });

  it("omits the model segment when the run has resolved no model", () => {
    startRun({ id: "tc-nomodel", agent: "beaver", parentSession: "main-1" });
    const container = renderCall(
      { agent: "beaver", description: "写测试" },
      toolContext("tc-nomodel", { isPartial: true }),
    );
    const lines = renderComponent(container, 80);
    assert.ok(
      lines.some((l) => l.includes("subagent(beaver)") && l.includes("写测试")),
      `agent + description must render: ${lines.join(" | ")}`,
    );
    assert.ok(
      !lines.some((l) => l.includes("model")),
      `no model segment when unresolved: ${lines.join(" | ")}`,
    );
  });
});

describe("pi renderResult — structured projection from the run log", () => {
  it("running body projects current tool, tool calls, outputs and stats — never a title", () => {
    const run = startRun({
      id: "tc-live",
      agent: "beaver",
      parentSession: "main-1",
      label: "实现",
      startedAt: 1_700_000_000_000,
    });
    run.log.appendToolStart("bash", { command: "ls -la" }, 1);
    run.log.appendToolEnd("bash", [{ type: "text", text: "ok" }], false, 2);
    run.log.appendMessage([{ type: "text", text: "working on it" }]);
    updateRun("tc-live", { currentTool: "edit" });

    const component = renderResult(
      streamed("one-line progress text"),
      { isPartial: true },
      THEME,
      toolContext("tc-live"),
    );
    const lines = renderComponent(component, 80);
    const body = lines.filter((l) => l.length > 0);
    assert.ok(
      body.some((l) => l.includes("edit")),
      `current tool line expected: ${body.join(" | ")}`,
    );
    assert.ok(
      body.some((l) => l.includes("→ $ ls -la")),
      `summarized tool call expected: ${body.join(" | ")}`,
    );
    assert.ok(
      body.some((l) => l.includes("working on it")),
      `assistant output expected: ${body.join(" | ")}`,
    );
    assert.ok(
      body.some((l) => l.includes("⟳ 1 turn · 1 tool")),
      `stats line expected: ${body.join(" | ")}`,
    );
    assert.equal(
      body.filter((l) => l.includes("subagent(")).length,
      0,
      `running body must not render a title: ${body.join(" | ")}`,
    );
    assert.ok(
      !body.some((l) => l.includes("one-line progress text")),
      `streamed progress text must not leak once the log drives the card: ${body.join(" | ")}`,
    );
  });

  it("collapsed windows each region to GLANCE_LINES, expanded shows all", () => {
    const run = startRun({
      id: "tc-window",
      agent: "beaver",
      parentSession: "main-1",
    });
    for (let i = 1; i <= 5; i++) {
      run.log.appendToolStart("bash", { command: `cmd${i}` }, i);
    }
    const collapsed = renderComponent(
      renderResult(
        streamed(""),
        { isPartial: true },
        THEME,
        toolContext("tc-window"),
      ),
      80,
    ).filter((l) => l.includes("→"));
    assert.equal(collapsed.length, 3, `collapsed: ${collapsed.join(" | ")}`);
    // The recency window keeps the LAST three calls (independent literals).
    assert.ok(collapsed.some((l) => l.includes("$ cmd3")));
    assert.ok(collapsed.some((l) => l.includes("$ cmd4")));
    assert.ok(collapsed.some((l) => l.includes("$ cmd5")));
    assert.ok(!collapsed.some((l) => l.includes("$ cmd1")));

    const expanded = renderComponent(
      renderResult(
        streamed(""),
        { isPartial: true, expanded: true },
        THEME,
        toolContext("tc-window"),
      ),
      80,
    ).filter((l) => l.includes("→"));
    assert.equal(expanded.length, 5, `expanded: ${expanded.join(" | ")}`);
    assert.ok(expanded.some((l) => l.includes("$ cmd1")));
  });

  it("renders terminal state ✓ with stats badge and preview of the final text", () => {
    const run = startRun({
      id: "tc-done",
      agent: "lynx",
      parentSession: "main-1",
      startedAt: 1000,
    });
    run.log.appendMessage([{ type: "text", text: "line one\nline two" }]);
    finishRun("tc-done", { status: "done", endedAt: 2000 });

    const lines = renderComponent(
      renderResult(
        streamed(""),
        { isPartial: false },
        THEME,
        toolContext("tc-done"),
      ),
      80,
    ).filter((l) => l.length > 0);
    assert.ok(
      lines.some(
        (l) =>
          l.startsWith("✓ subagent(lynx)") && l.includes("⟳ 1 turn · 0 tools"),
      ),
      `terminal title with stats expected: ${lines.join(" | ")}`,
    );
    // Collapsed previews the FIRST non-empty line of the final message.
    assert.ok(lines.some((l) => l.includes("line one")));
    assert.ok(
      !lines.some((l) => l.includes("line two")),
      `collapsed must preview a single line: ${lines.join(" | ")}`,
    );
  });

  it("expanded terminal renders the full final text through markdown", () => {
    const run = startRun({
      id: "tc-exp",
      agent: "lynx",
      parentSession: "main-1",
    });
    run.log.appendMessage([
      { type: "text", text: "# heading\n\nbody paragraph" },
    ]);
    finishRun("tc-exp", { status: "done" });
    const lines = renderComponent(
      renderResult(
        streamed(""),
        { isPartial: false, expanded: true },
        THEME,
        toolContext("tc-exp"),
      ),
      80,
    );
    assert.ok(lines.some((l) => l.includes("heading")));
    assert.ok(lines.some((l) => l.includes("body paragraph")));
  });

  it("terminal error state renders ✗ with the failure reason", () => {
    const run = startRun({
      id: "tc-err",
      agent: "beaver",
      parentSession: "main-1",
    });
    run.log.appendMessage([{ type: "text", text: "partial work" }]);
    finishRun("tc-err", { status: "error", error: "provider exploded" });
    const lines = renderComponent(
      renderResult(
        streamed("delivered error text"),
        { isPartial: false },
        THEME,
        toolContext("tc-err"),
      ),
      80,
    );
    assert.ok(
      lines.some((l) => l.startsWith("✗ subagent(beaver)")),
      lines.join(" | "),
    );
    assert.ok(
      lines.some((l) => l.includes("provider exploded")),
      lines.join(" | "),
    );
  });

  it("terminal aborted state renders ⏹", () => {
    startRun({
      id: "tc-abort",
      agent: "beaver",
      parentSession: "main-1",
    });
    finishRun("tc-abort", { status: "aborted" });
    const lines = renderComponent(
      renderResult(
        streamed(""),
        { isPartial: false },
        THEME,
        toolContext("tc-abort"),
      ),
      80,
    );
    assert.ok(
      lines.some((l) => l.startsWith("⏹ subagent(beaver)")),
      lines.join(" | "),
    );
  });

  it("terminal title carries the resolved model badge", () => {
    const run = startRun({
      id: "tc-tmodel",
      agent: "beaver",
      parentSession: "main-1",
    });
    updateRun("tc-tmodel", { model: "anthropic/claude-opus" });
    run.log.appendMessage([{ type: "text", text: "done" }]);
    finishRun("tc-tmodel", { status: "done" });
    const lines = renderComponent(
      renderResult(
        streamed(""),
        { isPartial: false },
        THEME,
        toolContext("tc-tmodel"),
      ),
      80,
    );
    assert.ok(
      lines.some(
        (l) => l.startsWith("✓ subagent(beaver)") && l.includes("claude-opus"),
      ),
      lines.join(" | "),
    );
  });

  it("renders nested children one level deep via childrenOf", () => {
    startRun({
      id: "tc-parent",
      agent: "beaver",
      parentSession: "main-1",
      childSession: "child-1",
    });
    startRun({ id: "tc-child", agent: "lynx", parentSession: "child-1" });
    const lines = renderComponent(
      renderResult(
        streamed(""),
        { isPartial: true },
        THEME,
        toolContext("tc-parent"),
      ),
      80,
    );
    assert.ok(
      lines.some((l) => l.includes("lynx") && /[├└]/.test(l)),
      `nested child row expected: ${lines.join(" | ")}`,
    );
  });

  it("stops the spinner timer once the registry run is terminal", () => {
    startRun({ id: "tc-stop", agent: "beaver", parentSession: "main-1" });
    finishRun("tc-stop", { status: "done" });
    let invalidations = 0;
    const state: Record<string, unknown> = {};
    renderResult(
      streamed(""),
      { isPartial: true },
      THEME,
      toolContext("tc-stop", {
        state,
        invalidate: () => {
          invalidations += 1;
        },
      }),
    );
    const timer = state.spinnerTimer as { hasRef?: () => boolean } | undefined;
    assert.equal(
      timer,
      undefined,
      "no animation timer may run while the run is terminal even if a late " +
        "partial render arrives",
    );
    assert.equal(invalidations, 0);
  });

  it("upgrades a scanner-rebuilt empty run with the hydrated log", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zoo-card-"));
    const sessionPath = join(dir, "child.jsonl");
    await writeFile(
      sessionPath,
      [
        JSON.stringify({
          type: "session",
          version: 3,
          id: "ses-scan",
          timestamp: "2026-08-31T00:00:00.000Z",
          cwd: "/tmp",
        }),
        JSON.stringify({
          type: "message",
          id: "m1",
          parentId: null,
          timestamp: "2026-08-31T00:00:00.000Z",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "restored scanner answer" }],
            timestamp: 5000,
          },
        }),
      ].join("\n"),
      "utf-8",
    );
    // The history scanner rebuilt the run (terminal, real lifecycle) but
    // never filled its fact log.
    startRun({
      id: "tc-scanned",
      agent: "spider",
      parentSession: "main-1",
      startedAt: 1000,
    });
    finishRun("tc-scanned", { status: "done", endedAt: 6000 });
    const context = toolContext("tc-scanned");
    const result = {
      content: [{ type: "text", text: "delivered" }],
      details: { sessionPath },
    };
    // First paint: placeholder (log empty, hydration not settled).
    const first = renderComponent(
      renderResult(result, { isPartial: false }, THEME, context),
      80,
    );
    assert.ok(
      first.some((l) => l.includes("restoring")),
      `placeholder expected: ${first.join(" | ")}`,
    );
    await waitForHydration("tc-scanned");
    const second = renderComponent(
      renderResult(result, { isPartial: false }, THEME, context),
      80,
    ).filter((l) => l.length > 0);
    assert.ok(
      second.some(
        (l) => l.startsWith("✓ subagent(spider)") && l.includes("0:05"),
      ),
      `run meta (real lifecycle) + hydrated body expected: ${second.join(" | ")}`,
    );
    assert.ok(
      second.some((l) => l.includes("restored scanner answer")),
      second.join(" | "),
    );
  });

  it("falls back to the streamed text when no run exists yet (startup race)", () => {
    const lines = renderComponent(
      renderResult(
        streamed("streamed progress line"),
        { isPartial: true },
        THEME,
        toolContext("tc-unknown"),
      ),
      80,
    );
    assert.ok(
      lines.some((l) => l.includes("streamed progress line")),
      lines.join(" | "),
    );
  });

  it("terminal fallback: no run, no sessionPath → delivered text renders", () => {
    const lines = renderComponent(
      renderResult(
        streamed("delivered result text"),
        { isPartial: false },
        THEME,
        toolContext("tc-gone"),
      ),
      80,
    );
    assert.ok(
      lines.some((l) => l.includes("delivered result text")),
      lines.join(" | "),
    );
  });

  it("hydrates a restored terminal render from the sub-session file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zoo-card-"));
    const sessionPath = join(dir, "child.jsonl");
    await writeFile(
      sessionPath,
      [
        JSON.stringify({
          type: "session",
          version: 3,
          id: "ses-child",
          timestamp: "2026-08-31T00:00:00.000Z",
          cwd: "/tmp",
        }),
        JSON.stringify({
          type: "message",
          id: "m1",
          parentId: null,
          timestamp: "2026-08-31T00:00:00.000Z",
          message: {
            role: "assistant",
            content: [
              { type: "text", text: "reading file" },
              {
                type: "toolCall",
                id: "inner-1",
                name: "read",
                arguments: { file_path: "/tmp/x" },
              },
            ],
            model: "kimi-k2",
            usage: { input: 8, output: 3, totalTokens: 11 },
            timestamp: 1000,
          },
        }),
        JSON.stringify({
          type: "message",
          id: "m2",
          parentId: null,
          timestamp: "2026-08-31T00:00:00.000Z",
          message: {
            role: "toolResult",
            toolCallId: "inner-1",
            toolName: "read",
            content: [{ type: "text", text: "contents" }],
            isError: false,
            timestamp: 1100,
          },
        }),
        JSON.stringify({
          type: "message",
          id: "m3",
          parentId: null,
          timestamp: "2026-08-31T00:00:00.000Z",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "the restored final answer" }],
            model: "kimi-k2",
            usage: { input: 2, output: 1, totalTokens: 3 },
            timestamp: 1200,
          },
        }),
      ].join("\n"),
      "utf-8",
    );

    const context = toolContext("tc-restored", {
      args: { agent: "lynx", description: "查资料" },
    });
    let invalidations = 0;
    context.invalidate = () => {
      invalidations += 1;
    };
    const result = {
      content: [{ type: "text", text: "delivered" }],
      details: { sessionPath },
    };

    // First paint: placeholder while the session file parses asynchronously.
    const first = renderComponent(
      renderResult(result, { isPartial: false }, THEME, context),
      80,
    );
    assert.ok(
      first.some((l) => l.includes("restoring")),
      `placeholder expected, got: ${first.join(" | ")}`,
    );

    // Once hydration settles, the card projects the rebuilt log: the
    // terminal title, the tool-call history, and the final answer — and
    // the renderer was asked to repaint.
    await waitForHydration("tc-restored");
    assert.ok(invalidations >= 1, "hydration must invalidate the card");
    const second = renderComponent(
      renderResult(result, { isPartial: false }, THEME, context),
      80,
    ).filter((l) => l.length > 0);
    assert.ok(
      second.some((l) => l.startsWith("✓ subagent(lynx)")),
      `terminal title from restored facts expected: ${second.join(" | ")}`,
    );
    assert.ok(
      second.some((l) => l.includes("the restored final answer")),
      second.join(" | "),
    );
    assert.ok(
      second.some((l) => l.includes("⟳ 2 turns · 1 tool · 14 tok")),
      `restored counters (turns/tools/tokens) expected: ${second.join(" | ")}`,
    );
    assert.equal(
      getRun("tc-restored"),
      undefined,
      "hydration must not register the restored run into the registry",
    );
  });
});
