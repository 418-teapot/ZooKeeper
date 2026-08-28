/**
 * Tests for the subagent transcript view model (`src/core/subagent/view.ts`).
 *
 * The view model is pure: it takes a structured `SubagentProgress` snapshot
 * plus the delegation label and derives the display lines for the pi TUI
 * card.  Every line carries a semantic hue (`running` / `success` / `error`
 * / `muted` / `accent`) that the pi adapter later maps to a concrete theme
 * color — core stays host-free.  This suite locks the line *structure* and
 * *content* for the running (isPartial) and terminal (ok / error / aborted)
 * states, plus the collapsed vs expanded variants.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { SubagentProgress } from "./driver.js";
import {
  type CardLine,
  COLLAPSED_TOOL_CAP,
  EXPANDED_TOOL_CAP,
  formatTokenCount,
  renderProgressCard,
  renderProgressTitle,
  renderResultCard,
  renderTitle,
  SPINNER_FRAMES,
} from "./view.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A mid-run snapshot with one current tool and recent output. */
function runningSnapshot(
  overrides: Partial<SubagentProgress> = {},
): SubagentProgress {
  return {
    agent: "beaver",
    currentTool: "bash",
    output: "compiling the agent",
    toolCalls: [{ name: "bash", summary: "compiling" }],
    outputLines: ["compiling the agent"],
    turnCount: 1,
    toolCallCount: 1,
    startedAt: 0,
    done: false,
    ...overrides,
  };
}

/** A completed ok snapshot. */
function okSnapshot(
  overrides: Partial<SubagentProgress> = {},
): SubagentProgress {
  return {
    agent: "beaver",
    currentTool: undefined,
    output: "all tests pass",
    toolCalls: [
      { name: "bash", summary: "run tests" },
      { name: "edit", summary: "fix typo" },
    ],
    outputLines: ["all tests pass"],
    turnCount: 3,
    toolCallCount: 2,
    startedAt: 0,
    done: true,
    result: { kind: "ok", text: "all tests pass" },
    ...overrides,
  };
}

/** An errored snapshot. */
function errorSnapshot(): SubagentProgress {
  return {
    agent: "beaver",
    currentTool: "bash",
    output: "command failed",
    toolCalls: [{ name: "bash", summary: "run build" }],
    outputLines: ["command failed"],
    turnCount: 2,
    toolCallCount: 1,
    startedAt: 0,
    done: true,
    result: { kind: "error", text: "command failed", errorMessage: "exit 1" },
  };
}

/** Assert every line carries one of the documented semantic hues. */
function assertValidLines(lines: CardLine[]): void {
  const hues = new Set(["running", "success", "error", "muted", "accent"]);
  for (const line of lines) {
    assert.ok(hues.has(line.hue), `unknown hue ${line.hue}`);
    assert.ok(typeof line.text === "string" && line.text.length > 0);
  }
}

// ---------------------------------------------------------------------------
// SPINNER_FRAMES
// ---------------------------------------------------------------------------

describe("view — spinner frames", () => {
  it("exposes the canonical ten-frame braille spinner", () => {
    assert.deepEqual(SPINNER_FRAMES, [
      "⠋",
      "⠙",
      "⠹",
      "⠸",
      "⠼",
      "⠴",
      "⠦",
      "⠧",
      "⠇",
      "⠏",
    ]);
  });
});

// ---------------------------------------------------------------------------
// renderProgressCard (running / partial)
// ---------------------------------------------------------------------------

describe("renderProgressCard", () => {
  it("renders the spinner, task label, current tool, output, and stats", () => {
    const lines = renderProgressCard(runningSnapshot(), "实现功能");
    assertValidLines(lines);

    const texts = lines.map((l) => l.text);
    // The running card has no title line: the title is owned by the
    // tool-call card (`renderCall`), which the tool-execution component
    // stacks above this body.  A title here would duplicate it.
    const titleLine = texts.find((t) =>
      SPINNER_FRAMES.some((f) => t.startsWith(f)),
    );
    assert.ok(
      titleLine === undefined,
      `running card must not render a spinner title: ${texts.join(" | ")}`,
    );

    // Current tool line is present and accent-hued.
    const toolLine = lines.find((l) => l.hue === "accent");
    assert.ok(toolLine, "expected an accent current-tool line");
    assert.ok(toolLine.text.includes("bash"));

    // Recent output line (muted).
    const outputLine = lines.find((l) => l.hue === "muted");
    assert.ok(outputLine, "expected a muted output line");
    assert.ok(outputLine.text.includes("compiling the agent"));

    // Stats line carries turn / tool / elapsed.
    const stats = lines[lines.length - 1];
    assert.ok(stats.text.includes("1 turn"), `missing turns: ${stats.text}`);
    assert.ok(stats.text.includes("1 tool"), `missing tools: ${stats.text}`);
    assert.ok(
      !stats.text.includes("1 turns") && !stats.text.includes("1 tools"),
      `singular must be used for a count of 1: ${stats.text}`,
    );
  });

  it("renders tool-call lines without duplicating the tool name", () => {
    const snapshot = runningSnapshot({
      toolCalls: [
        {
          name: "read",
          summary: "read ~/Code/Agent/ZooKeeper/src/core/slots.ts",
        },
        { name: "bash", summary: "$ npm run build" },
      ],
    });
    const lines = renderProgressCard(snapshot, undefined);
    const toolLines = lines
      .filter((l) => l.hue === "accent" && l.text.startsWith("→"))
      .map((l) => l.text);
    // The summary is self-contained (`read <path>` / `$ <cmd>`): the view
    // renders it verbatim after the arrow, never re-prefixing the name.
    assert.deepEqual(toolLines, [
      "→ read ~/Code/Agent/ZooKeeper/src/core/slots.ts",
      "→ $ npm run build",
    ]);
    assert.ok(
      !toolLines.some((t) => t.includes("read read") || t.includes("bash $")),
      `duplicated tool name: ${toolLines.join(" | ")}`,
    );
  });

  it("keeps the running card body independent of the task description", () => {
    const lines = renderProgressCard(runningSnapshot(), undefined);
    const texts = lines.map((l) => l.text);
    // The label is owned by the tool-call card title; the running body
    // never leaks it (and never renders a spinner title either).
    assert.ok(!texts.some((t) => t.includes("subagent(beaver)")));
    assert.ok(
      !texts.some((t) => t.includes("undefined")),
      `leaked undefined: ${texts.join(" | ")}`,
    );
  });

  it("shows more recent tools and output lines when expanded", () => {
    const manyTools = Array.from({ length: 6 }, (_, i) => ({
      name: `tool${i}`,
      summary: `doing ${i}`,
    }));
    const manyOutput = Array.from({ length: 8 }, (_, i) => `output line ${i}`);
    const snapshot = runningSnapshot({
      currentTool: "tool5",
      toolCalls: manyTools,
      outputLines: manyOutput,
    });

    const collapsed = renderProgressCard(snapshot, undefined, false);
    const expanded = renderProgressCard(snapshot, undefined, true);

    const toolText = (lines: CardLine[]): string =>
      lines
        .filter((l) => l.hue === "accent" && l.text.startsWith("→"))
        .map((l) => l.text)
        .join("\n");
    const outputText = (lines: CardLine[]): string =>
      lines
        .filter((l) => l.hue === "muted")
        .map((l) => l.text)
        .join("\n");

    assert.ok(
      toolText(collapsed).split("\n").length <= COLLAPSED_TOOL_CAP,
      "collapsed must cap recent tools",
    );
    assert.ok(
      toolText(expanded).split("\n").length > COLLAPSED_TOOL_CAP,
      "expanded must show more recent tools",
    );
    assert.ok(
      outputText(expanded).length > outputText(collapsed).length,
      "expanded must show more recent output",
    );
    // Expanded never exceeds the documented tool cap.
    assert.ok(toolText(expanded).split("\n").length <= EXPANDED_TOOL_CAP);
  });

  it("appends the token usage to the stats line when present", () => {
    const snapshot = runningSnapshot({
      tokens: 12345,
      startedAt: 0,
      turnCount: 3,
      toolCallCount: 5,
    });
    const lines = renderProgressCard(snapshot, undefined, false, 0);
    const stats = lines[lines.length - 1].text;
    // `⟳ 3 turns · 5 tools · 12.3k tok · <elapsed>`
    assert.ok(stats.includes("12.3k tok"), `missing tokens: ${stats}`);
    assert.ok(
      stats.includes("3 turns · 5 tools · 12.3k tok"),
      `unexpected order: ${stats}`,
    );
  });

  it("formats the token count with the thousand-abbreviation convention", () => {
    assert.equal(formatTokenCount(0), "0");
    assert.equal(formatTokenCount(999), "999");
    assert.equal(formatTokenCount(1000), "1.0k");
    assert.equal(formatTokenCount(12345), "12.3k");
    assert.equal(formatTokenCount(100000), "100.0k");
    assert.equal(formatTokenCount(1000000), "1000k");
  });

  it("omits the token segment from the stats line when absent", () => {
    const snapshot = runningSnapshot({});
    const lines = renderProgressCard(snapshot, undefined, false, 0);
    const stats = lines[lines.length - 1].text;
    assert.ok(!stats.includes("tok"), `unexpected tokens: ${stats}`);
  });
});

// ---------------------------------------------------------------------------
// renderProgressTitle / renderTitle (the tool-call card's single title line)
// ---------------------------------------------------------------------------

describe("renderProgressTitle", () => {
  it("renders the running title with a frame-indexed spinner and task label", () => {
    const line = renderProgressTitle("beaver", "实现功能", 0);
    assert.ok(line.text.startsWith(SPINNER_FRAMES[0]), line.text);
    assert.ok(line.text.includes("subagent(beaver)"), line.text);
    assert.ok(line.text.includes("实现功能"), line.text);
    assert.equal(line.hue, "running");
  });

  it("renders the model id badge after the agent name when present", () => {
    const line = renderProgressTitle("lynx", "research", 0, "dummy-small");
    assert.ok(line.text.includes("subagent(lynx)"), line.text);
    assert.ok(line.text.includes("· dummy-small"), line.text);
    assert.ok(line.text.includes("research"), line.text);
    assert.equal(line.hue, "running");
  });

  it("omits the model badge when absent (defensive-only branch)", () => {
    const line = renderProgressTitle("lynx", "research", 0);
    assert.ok(line.text.includes("subagent(lynx)"), line.text);
    // Strict mode guarantees a configured model, so this branch is
    // unreachable in the real flow — the view model still renders
    // defensively when called without one.
    assert.ok(!line.text.includes("dummy-small"), line.text);
    assert.ok(line.text.includes("subagent(lynx) · research"), line.text);
  });

  it("advances the spinner frame with the shared frame sequence", () => {
    // Consecutive frames resolve to different spinner glyphs, so a card
    // rebuilt on each invalidation visibly animates.
    const f0 = renderProgressTitle("beaver", "实现功能", 0).text;
    const f1 = renderProgressTitle("beaver", "实现功能", 1).text;
    assert.notEqual(f0, f1, "consecutive frames must differ");
    assert.ok(f0.startsWith(SPINNER_FRAMES[0]), f0);
    assert.ok(f1.startsWith(SPINNER_FRAMES[1]), f1);
  });

  it("cycles through the ten frames and wraps back to the start", () => {
    const texts = SPINNER_FRAMES.map(
      (_f, i) => renderProgressTitle("beaver", "实现功能", i).text,
    );
    assert.deepEqual(
      texts.map((t) => t[0]),
      SPINNER_FRAMES,
      "frame sequence must cycle the canonical frames",
    );
    const wrapped = renderProgressTitle("beaver", "实现功能", 10).text;
    assert.ok(wrapped.startsWith(SPINNER_FRAMES[0]), wrapped);
  });

  it("defaults the label to empty and the agent to a placeholder", () => {
    const line = renderProgressTitle(undefined, undefined, 0);
    assert.ok(line.text.includes("…"), line.text);
    assert.ok(!line.text.includes("undefined"), line.text);
  });
});

describe("renderTitle", () => {
  it("renders the terminal title with the success marker and label", () => {
    const line = renderTitle("✓", "beaver", "实现功能");
    assert.ok(line.text.includes("✓"), line.text);
    assert.ok(line.text.includes("subagent(beaver)"), line.text);
    assert.ok(line.text.includes("实现功能"), line.text);
  });

  it("renders the model id badge when present", () => {
    const line = renderTitle("✓", "lynx", "research", "success", "dummy-small");
    assert.ok(line.text.includes("subagent(lynx)"), line.text);
    assert.ok(line.text.includes("· dummy-small"), line.text);
    assert.ok(line.text.includes("research"), line.text);
  });

  it("omits the model badge when absent (defensive-only branch)", () => {
    const line = renderTitle("✓", "lynx", "research");
    assert.ok(!line.text.includes("dummy-small"), line.text);
    assert.ok(line.text.includes("✓ subagent(lynx) · research"), line.text);
  });

  it("omits the label when absent", () => {
    const line = renderTitle("✓", "beaver", undefined);
    assert.ok(line.text.includes("✓ subagent(beaver)"), line.text);
    assert.ok(!line.text.includes("undefined"), line.text);
  });

  it("keeps the running card title line and terminal card title in sync", () => {
    // The running and terminal titles share the same structural layout so
    // the terminal renderResult title (which takes over from renderCall)
    // reads as the same line, just with a static marker.
    const run = renderProgressTitle("beaver", "实现功能", 0).text;
    const done = renderTitle("✓", "beaver", "实现功能").text;
    assert.ok(run.includes("subagent(beaver) · 实现功能"), run);
    assert.ok(done.includes("subagent(beaver) · 实现功能"), done);
  });
});

// ---------------------------------------------------------------------------
// renderResultCard (terminal states)
// ---------------------------------------------------------------------------

describe("renderResultCard", () => {
  it("renders a success check and the final text summary", () => {
    const lines = renderResultCard(okSnapshot(), "实现功能");
    assertValidLines(lines);

    const title = lines[0].text;
    assert.ok(title.includes("✓"), `missing success check: ${title}`);
    assert.ok(title.includes("subagent(beaver)"), `missing agent: ${title}`);
    const successLine = lines.find((l) => l.hue === "success");
    assert.ok(successLine, "expected a success-hued title line");
    assert.ok(
      lines.some((l) => l.text.includes("all tests pass")),
      "final summary text missing",
    );
  });

  it("renders no tool-call lines on the terminal card", () => {
    const lines = renderResultCard(okSnapshot(), "实现功能");
    const arrowLines = lines.filter((l) => l.text.startsWith("→"));
    assert.equal(
      arrowLines.length,
      0,
      `terminal card must not render tool-call lines: ${lines.map((l) => l.text).join(" | ")}`,
    );
  });

  it("carries the run statistics in the terminal title badge", () => {
    const lines = renderResultCard(okSnapshot(), "实现功能");
    const title = lines[0].text;
    // The terminal title mirrors the running title's badge layout, so the
    // run statistics (`N turns · M tools`, optional token total) survive
    // the transition from the running card's stats line.  Like the running
    // card's always-present stats line, the badge renders even for a
    // zero-count run.
    assert.ok(title.includes("3 turns"), `missing turns badge: ${title}`);
    assert.ok(title.includes("2 tools"), `missing tools badge: ${title}`);
    assert.ok(title.includes("⟳"), `missing stats marker: ${title}`);
  });

  it("includes the token total in the terminal title badge when present", () => {
    const lines = renderResultCard(okSnapshot({ tokens: 12345 }), "实现功能");
    const title = lines[0].text;
    assert.ok(title.includes("12.3k tok"), `missing token badge: ${title}`);
  });

  it("renders an error marker and the error reason", () => {
    const lines = renderResultCard(errorSnapshot(), "实现功能");
    assertValidLines(lines);

    const title = lines[0].text;
    assert.ok(title.includes("✗"), `missing error marker: ${title}`);
    assert.ok(
      lines.some((l) => l.hue === "error"),
      "expected an error line",
    );
    assert.ok(
      lines.some((l) => l.text.includes("exit 1")),
      "error reason text missing",
    );
  });

  it("renders an aborted result distinctly from ok", () => {
    const aborted: SubagentProgress = {
      ...okSnapshot(),
      result: { kind: "aborted", text: "stopped early" },
      done: true,
    };
    const lines = renderResultCard(aborted, undefined);
    assertValidLines(lines);
    assert.ok(
      lines[0].text.includes("⏹"),
      `missing aborted marker: ${lines[0].text}`,
    );
    assert.ok(
      lines.some((l) => l.text.includes("stopped early")),
      "aborted partial text missing",
    );
  });

  it("shows more final output when expanded", () => {
    const longText = "output ".repeat(40); // 280 chars — past the 120 collapsed cap
    const snapshot = okSnapshot({ result: { kind: "ok", text: longText } });
    const collapsed = renderResultCard(snapshot, undefined, false);
    const expanded = renderResultCard(snapshot, undefined, true);
    const outputText = (lines: CardLine[]): string =>
      lines
        .filter((l) => l.hue === "muted")
        .map((l) => l.text)
        .join("\n");
    assert.ok(
      outputText(expanded).length > outputText(collapsed).length,
      "expanded must show more final output",
    );
  });

  it("appends the session file path line when present", () => {
    const home = process.env.HOME;
    const snapshot = okSnapshot({
      sessionPath: `${home}/.pi/agent/sessions/x/s.jsonl`,
    });
    const lines = renderResultCard(snapshot, "实现功能");
    const sessionLine = lines.find((l) => l.text.startsWith("session: "));
    assert.ok(
      sessionLine,
      `missing session line: ${lines.map((l) => l.text).join(" | ")}`,
    );
    assert.ok(
      sessionLine.text.includes("~/.pi/agent/sessions/x/s.jsonl"),
      sessionLine.text,
    );
    assert.equal(sessionLine.hue, "muted");
  });

  it("omits the session line when absent", () => {
    const snapshot = okSnapshot({});
    const lines = renderResultCard(snapshot, "实现功能");
    assert.ok(!lines.some((l) => l.text.startsWith("session: ")));
  });

  it("carries the model badge on the terminal title", () => {
    const snapshot = okSnapshot({ model: "dummy-small" });
    const lines = renderResultCard(snapshot, "research");
    assert.ok(lines[0].text.includes("subagent(beaver)"), lines[0].text);
    assert.ok(lines[0].text.includes("· dummy-small"), lines[0].text);
  });

  it("omits the model badge on the terminal title when absent (defensive-only branch)", () => {
    const snapshot = okSnapshot({});
    const lines = renderResultCard(snapshot, "research");
    assert.ok(!lines[0].text.includes("dummy-small"), lines[0].text);
  });
});
