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
import type { SubagentRun } from "./registry.js";
import {
  type CardLine,
  COLLAPSED_TOOL_CAP,
  EXPANDED_TOOL_CAP,
  formatTokenCount,
  renderFleetCollapsed,
  renderFleetRows,
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
    // Regression: the aborted branch used to push a truncated reason line
    // AND the final-text block rendered the same `result.text` again, so the
    // transcript duplicated the aborted text.  The text must render exactly
    // once — the final-text block owns it, matching the ok branch.
    const textMatches = lines.filter((l) => l.text.includes("stopped early"));
    assert.equal(
      textMatches.length,
      1,
      `aborted text must render exactly once: ${lines.map((l) => l.text).join(" | ")}`,
    );
    assert.equal(textMatches[0].hue, "muted");
  });

  it("shows more final output when expanded", () => {
    const longText = ["line one", "line two", "line three", "line four"].join(
      "\n",
    );
    const snapshot = okSnapshot({ result: { kind: "ok", text: longText } });
    const collapsed = renderResultCard(snapshot, undefined, false);
    const expanded = renderResultCard(snapshot, undefined, true);
    const outputText = (lines: CardLine[]): string =>
      lines
        .filter((l) => l.hue === "muted")
        .map((l) => l.text)
        .join("\n");
    // Collapsed previews only the first non-empty line; expanded shows the
    // whole multi-line result.
    assert.ok(
      outputText(expanded).length > outputText(collapsed).length,
      "expanded must show more final output",
    );
  });

  it("shows the full final output when expanded past 400 chars", () => {
    // Regression: the expanded terminal card used to cap the final result at
    // 400 chars — a silent arbitrary cap with nowhere to see the rest (the
    // result card fully owns the pi result rendering).  Expanded must pass
    // the text through untruncated; collapsed previews only the first
    // non-empty line (width truncation is the adapter's render boundary, so
    // the view model applies no character cap and no ellipsis).
    const longText = "detail ".repeat(100); // 700 chars — well past the 400 cap
    const snapshot = okSnapshot({ result: { kind: "ok", text: longText } });
    const collapsed = renderResultCard(snapshot, undefined, false);
    const expanded = renderResultCard(snapshot, undefined, true);
    const finalTextLines = (lines: CardLine[]): string[] =>
      lines.filter((l) => l.hue === "muted").map((l) => l.text);
    const collapsedLines = finalTextLines(collapsed);
    const expandedLines = finalTextLines(expanded);
    // Expanded: the full 700-char text passes through untruncated (no
    // ellipsis marker, exact content).
    assert.ok(
      expandedLines.includes(longText),
      "expanded must contain the full untruncated result",
    );
    assert.ok(
      !expandedLines.some((t) => t.endsWith("…")),
      "expanded must not truncate",
    );
    // Collapsed: the first non-empty line of a single-line result is the
    // whole line (trailing whitespace trimmed, mirroring the pi-subagents
    // fold) — the view model never character-caps it (no 120 limit, no
    // ellipsis; the adapter truncates to the terminal width at render time).
    assert.ok(
      collapsedLines.some((t) => t === longText.trim()),
      "collapsed must pass the first non-empty line through untruncated in the view model",
    );
    assert.ok(
      !collapsedLines.some((t) => t.endsWith("…")),
      "collapsed must not add an ellipsis in the view model",
    );
  });

  it("collapsed previews only the first non-empty line of the final text", () => {
    const text = "\n\n**SUMMARY:** done\n\nDetails below";
    const snapshot = okSnapshot({ result: { kind: "ok", text } });
    const collapsed = renderResultCard(snapshot, undefined, false);
    const expanded = renderResultCard(snapshot, undefined, true);
    const finalTextLines = (lines: CardLine[]): string[] =>
      lines.filter((l) => l.hue === "muted").map((l) => l.text);
    // Collapsed previews the first non-empty line; expanded keeps the full
    // multi-line markdown result.
    assert.ok(
      finalTextLines(collapsed).some((t) => t === "**SUMMARY:** done"),
      `collapsed must preview the first non-empty line: ${finalTextLines(collapsed).join(" | ")}`,
    );
    assert.ok(
      finalTextLines(expanded).some((t) => t === text),
      "expanded must keep the full final text",
    );
    // The collapsed preview is flagged for render-boundary width truncation
    // (the view model never truncates); it is not markdown — plain preview,
    // matching pi-subagents' collapsed fold.
    const collapsedLine = collapsed.find((l) => l.hue === "muted");
    assert.ok(collapsedLine !== undefined, "expected a muted final line");
    assert.equal(
      collapsedLine.truncateToWidth,
      true,
      "collapsed preview must be flagged for adapter width truncation",
    );
    assert.notEqual(
      collapsedLine.markdown,
      true,
      "collapsed preview must not be markdown",
    );
  });

  it("skips leading blank and whitespace-only lines when collapsing", () => {
    const text = "\n   \n\t \n  the answer\nmore";
    const snapshot = okSnapshot({ result: { kind: "ok", text } });
    const collapsed = renderResultCard(snapshot, undefined, false);
    const finalTextLines = collapsed
      .filter((l) => l.hue === "muted")
      .map((l) => l.text);
    assert.ok(
      finalTextLines.some((t) => t === "the answer"),
      `leading blank lines must be skipped: ${finalTextLines.join(" | ")}`,
    );
  });

  it("never renders the session file path line on a terminal card", () => {
    const home = process.env.HOME;
    const snapshot = okSnapshot({
      sessionPath: `${home}/.pi/agent/sessions/x/s.jsonl`,
    });
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

// ---------------------------------------------------------------------------
// Fleet widget — renderFleetCollapsed
// ---------------------------------------------------------------------------

/** A minimal subagent run fixture for the fleet view tests. */
function fleetRun(
  id: string,
  overrides: Partial<SubagentRun> = {},
): SubagentRun {
  return {
    id,
    agent: "lynx",
    parentSession: "main",
    status: "done",
    startedAt: 0,
    ...overrides,
  };
}

describe("renderFleetCollapsed", () => {
  it("renders the primary, running spinner, and non-zero counts", () => {
    const line = renderFleetCollapsed(
      "dolphin",
      undefined,
      { running: 1, done: 2, failed: 1 },
      [{ agent: "lynx", label: "research", elapsedMs: 5000 }],
      0,
    );
    // The line's hue follows the dominant live status: running > error >
    // success > muted, so the single-line widget's color IS the status.
    assert.equal(line.hue, "running");
    assert.equal(
      line.text,
      `◆ dolphin · ${SPINNER_FRAMES[0]} lynx 0:05 · ● 2 ● 1`,
    );
  });

  it("lists every concurrently running run, not just the first", () => {
    const line = renderFleetCollapsed(
      "dolphin",
      undefined,
      { running: 2, done: 2, failed: 0 },
      [
        { agent: "beaver", elapsedMs: 83000 },
        { agent: "lynx", elapsedMs: 34000 },
      ],
      0,
    );
    // Both running runs appear in order, each as its own
    // ` · <spinner> <agent> <m:ss>` group.
    assert.equal(
      line.text,
      `◆ dolphin · ${SPINNER_FRAMES[0]} beaver 1:23 · ${SPINNER_FRAMES[0]} lynx 0:34 · ● 2`,
    );
    // Each running run yields three segments: an uncolored separator, a
    // colored spinner, and an uncolored agent + elapsed — so both spinners
    // carry the running hue while the agent names / durations / separators
    // stay default.
    assert.ok(line.segments !== undefined, "segments must be present");
    assert.deepEqual(
      line.segments.slice(1, 7).map((s) => s.hue),
      [undefined, "running", undefined, undefined, undefined, undefined],
    );
    assert.equal(line.segments[2].text, SPINNER_FRAMES[0]);
    assert.equal(line.segments[7].text, SPINNER_FRAMES[0]);
    // Each running group splits into five segments — ` · `, the spinner, a
    // space, the bare agent name (marked with its `agent` for the adapter to
    // colorize via the configured `[agent.<name>].color`), and the elapsed.
    assert.equal(line.segments[3].text, " ");
    assert.equal(line.segments[4].text, "beaver");
    assert.equal(line.segments[4].agent, "beaver");
    assert.equal(line.segments[5].text, " 1:23");
    assert.equal(line.segments[8].text, " ");
    assert.equal(line.segments[9].text, "lynx");
    assert.equal(line.segments[9].agent, "lynx");
    assert.equal(line.segments[10].text, " 0:34");
    // The flat `text` stays the segment concatenation (backward compatible).
    assert.equal(line.text, line.segments.map((s) => s.text).join(""));
  });

  it("colors the line by the dominant status when nothing runs", () => {
    const failed = renderFleetCollapsed("dolphin", undefined, {
      running: 0,
      done: 1,
      failed: 1,
    });
    assert.equal(failed.hue, "error");
    const allDone = renderFleetCollapsed("dolphin", undefined, {
      running: 0,
      done: 2,
      failed: 0,
    });
    assert.equal(allDone.hue, "success");
  });

  it("omits the spinner segment when nothing is running", () => {
    const line = renderFleetCollapsed("dolphin", undefined, {
      running: 0,
      done: 2,
      failed: 1,
    });
    assert.equal(line.text, "◆ dolphin · ● 2 ● 1");
  });

  it("omits the running label from the collapsed line (agent + elapsed only)", () => {
    const line = renderFleetCollapsed(
      "dolphin",
      undefined,
      { running: 1, done: 0, failed: 1 },
      [{ agent: "lynx", label: "research", elapsedMs: 5000 }],
      0,
    );
    // The collapsed one-liner stays compact: `<spinner> <agent> <elapsed>`.
    assert.equal(line.text, `◆ dolphin · ${SPINNER_FRAMES[0]} lynx 0:05 · ● 1`);
    assert.ok(!line.text.includes("research"), line.text);
  });

  it("omits a zero count", () => {
    const line = renderFleetCollapsed(
      "dolphin",
      undefined,
      { running: 1, done: 0, failed: 1 },
      [{ agent: "lynx", elapsedMs: 5000 }],
      0,
    );
    assert.equal(line.text, `◆ dolphin · ${SPINNER_FRAMES[0]} lynx 0:05 · ● 1`);
  });

  it("renders only the primary when there is no activity", () => {
    const line = renderFleetCollapsed("dolphin", undefined, {
      running: 0,
      done: 0,
      failed: 0,
    });
    assert.equal(line.text, "◆ dolphin");
  });

  it("uses the colorized primary when provided", () => {
    const colorized = "\u001b[38;2;255;0;0mdolphin\u001b[39m";
    const line = renderFleetCollapsed("dolphin", colorized, {
      running: 0,
      done: 1,
      failed: 0,
    });
    assert.ok(line.text.startsWith(`◆ ${colorized}`), line.text);
    assert.ok(!line.text.includes("· ●0"), line.text);
  });

  it("advances the spinner frame with the shared frame sequence", () => {
    const f0 = renderFleetCollapsed(
      "dolphin",
      undefined,
      { running: 1, done: 0, failed: 0 },
      [{ agent: "lynx", elapsedMs: 5000 }],
      0,
    ).text;
    const f1 = renderFleetCollapsed(
      "dolphin",
      undefined,
      { running: 1, done: 0, failed: 0 },
      [{ agent: "lynx", elapsedMs: 5000 }],
      1,
    ).text;
    assert.ok(f0.startsWith(`◆ dolphin · ${SPINNER_FRAMES[0]}`), f0);
    assert.ok(f1.startsWith(`◆ dolphin · ${SPINNER_FRAMES[1]}`), f1);
  });

  it("formats the running elapsed as MM:SS and degrades to -:-- when unknown", () => {
    const known = renderFleetCollapsed(
      "dolphin",
      undefined,
      { running: 1, done: 0, failed: 0 },
      [{ agent: "lynx", elapsedMs: 65000 }],
      0,
    );
    assert.ok(known.text.includes("lynx 1:05"), known.text);
    const unknown = renderFleetCollapsed(
      "dolphin",
      undefined,
      { running: 1, done: 0, failed: 0 },
      [{ agent: "lynx" }],
      0,
    );
    assert.ok(unknown.text.includes("lynx -:--"), unknown.text);
  });

  it("carries per-segment hues: primary undecorated, only the spinners/dots colored", () => {
    const colorized = "\u001b[38;2;255;0;0mdolphin\u001b[39m";
    const line = renderFleetCollapsed(
      "dolphin",
      colorized,
      { running: 1, done: 2, failed: 1 },
      [{ agent: "lynx", elapsedMs: 5000 }],
      0,
    );
    assert.ok(line.segments !== undefined, "segments must be present");
    assert.equal(line.segments.length, 12);
    // The primary segment is pre-colorized by the host and carries no hue.
    assert.equal(line.segments[0].hue, undefined);
    assert.equal(line.segments[0].text, `◆ ${colorized}`);
    // The running group splits into five segments — the ` · ` separator, the
    // bare spinner, a space, the bare agent name (marked with `agent` so the
    // adapter colorizes it with the configured `[agent.<name>].color`), and
    // the elapsed.  Only the spinner carries the running hue; the separator,
    // the agent name and the elapsed stay default.
    assert.equal(line.segments[1].hue, undefined);
    assert.equal(line.segments[1].text, " · ");
    assert.equal(line.segments[2].hue, "running");
    assert.equal(line.segments[2].text, SPINNER_FRAMES[0]);
    assert.equal(line.segments[3].hue, undefined);
    assert.equal(line.segments[3].text, " ");
    assert.equal(line.segments[4].hue, undefined);
    assert.equal(line.segments[4].text, "lynx");
    assert.equal(line.segments[4].agent, "lynx");
    assert.equal(line.segments[5].hue, undefined);
    assert.equal(line.segments[5].text, " 0:05");
    // Each done/failed count splits into three segments — the ` · `
    // separator, the dot, and the number.  Only the bare dot carries the
    // status hue; the separator and the number stay default.
    assert.equal(line.segments[6].hue, undefined);
    assert.equal(line.segments[6].text, " · ");
    assert.equal(line.segments[7].hue, "success");
    assert.equal(line.segments[7].text, "●");
    assert.equal(line.segments[8].hue, undefined);
    assert.equal(line.segments[8].text, " 2");
    // The second (failed) dot is separated by a single space — the leading
    // ` · ` already belongs to the first count.
    assert.equal(line.segments[9].hue, undefined);
    assert.equal(line.segments[9].text, " ");
    assert.equal(line.segments[10].hue, "error");
    assert.equal(line.segments[10].text, "●");
    assert.equal(line.segments[11].hue, undefined);
    assert.equal(line.segments[11].text, " 1");
    // The flat `text` stays the concatenation (backward compatible with the
    // card, which renders plain text).
    assert.equal(line.text, line.segments.map((s) => s.text).join(""));
  });

  it("keeps the segments aligned with the flat text for each collapsed form", () => {
    // No activity: just the undecorated primary.
    const idle = renderFleetCollapsed("dolphin", undefined, {
      running: 0,
      done: 0,
      failed: 0,
    });
    assert.deepEqual(
      idle.segments?.map((s) => s.hue),
      [undefined],
    );
    assert.equal(idle.text, "◆ dolphin");
    // Done only.
    const done = renderFleetCollapsed("dolphin", undefined, {
      running: 0,
      done: 2,
      failed: 0,
    });
    assert.deepEqual(
      done.segments?.map((s) => s.hue),
      [undefined, undefined, "success", undefined],
    );
    assert.equal(done.text, "◆ dolphin · ● 2");
    // Failed only.
    const failed = renderFleetCollapsed("dolphin", undefined, {
      running: 0,
      done: 0,
      failed: 1,
    });
    assert.deepEqual(
      failed.segments?.map((s) => s.hue),
      [undefined, undefined, "error", undefined],
    );
    assert.equal(failed.text, "◆ dolphin · ● 1");
  });
});

// ---------------------------------------------------------------------------
// Fleet widget — renderFleetRows
// ---------------------------------------------------------------------------

describe("renderFleetRows", () => {
  it("renders a spinner on running rows and ● on done rows, with hues", () => {
    const entries = [
      fleetRun("r1", { agent: "lynx", status: "running", startedAt: 1000 }),
      fleetRun("r2", { agent: "spider", status: "done", startedAt: 2000 }),
    ];
    const lines = renderFleetRows(entries, new Map(), undefined, 0, 5000);
    assert.equal(lines.length, 2);
    assert.equal(lines[0].hue, "running");
    assert.equal(lines[0].text, `  ${SPINNER_FRAMES[0]} lynx · 0:04`);
    assert.equal(lines[1].hue, "success");
    assert.equal(lines[1].text, "  ● spider · 0:03");
  });

  it("marks error and aborted rows with ● and the error hue", () => {
    const entries = [
      fleetRun("r1", { status: "error", startedAt: 1000 }),
      fleetRun("r2", { status: "aborted", startedAt: 2000 }),
    ];
    const lines = renderFleetRows(entries, new Map(), undefined, 0, 3000);
    assert.equal(lines[0].hue, "error");
    assert.equal(lines[1].hue, "error");
    assert.equal(lines[0].text, "  ● lynx · 0:02");
    assert.equal(lines[1].text, "  ● lynx · 0:01");
  });

  it("marks the selected row with ▸ and leaves the others a leading space", () => {
    const entries = [
      fleetRun("r1", { status: "done", startedAt: 1000 }),
      fleetRun("r2", { status: "done", startedAt: 2000 }),
    ];
    const lines = renderFleetRows(entries, new Map(), "r2", 0, 5000);
    assert.equal(lines[0].text, "  ● lynx · 0:04");
    assert.equal(lines[1].text, "▸ ● lynx · 0:03");
    assert.equal(lines[0].text[0], " ");
    assert.equal(lines[1].text[0], "▸");
  });

  it("renders the label between agent and duration when present", () => {
    const entries = [
      fleetRun("r1", {
        agent: "lynx",
        label: "research the api",
        status: "done",
        startedAt: 1000,
      }),
    ];
    const lines = renderFleetRows(entries, new Map(), undefined, 0, 5000);
    assert.equal(lines[0].text, "  ● lynx · research the api · 0:04");
  });

  it("indents nested children beneath their parent with ├─ and └─", () => {
    const entries = [
      fleetRun("p1", {
        agent: "beaver",
        label: "implement",
        status: "running",
        startedAt: 1000,
      }),
      fleetRun("p2", { agent: "mola", status: "done", startedAt: 4000 }),
    ];
    const children = new Map<string, SubagentRun[]>([
      [
        "p1",
        [
          fleetRun("c1", {
            agent: "lynx",
            label: "search",
            status: "done",
            startedAt: 2000,
          }),
          fleetRun("c2", {
            agent: "spider",
            label: "fetch",
            status: "running",
            startedAt: 3000,
          }),
        ],
      ],
    ]);
    const lines = renderFleetRows(entries, children, undefined, 0, 10000);
    assert.deepEqual(
      lines.map((l) => l.text),
      [
        `  ${SPINNER_FRAMES[0]} beaver · implement · 0:09`,
        "  ├─ ● lynx · search · 0:08",
        `  └─ ${SPINNER_FRAMES[0]} spider · fetch · 0:07`,
        "  ● mola · 0:06",
      ],
    );
    assert.equal(lines[2].hue, "running");
  });

  it("selects a nested child row with ▸", () => {
    const entries = [fleetRun("p1", { status: "running", startedAt: 1000 })];
    const children = new Map<string, SubagentRun[]>([
      ["p1", [fleetRun("c1", { status: "done", startedAt: 2000 })]],
    ]);
    const lines = renderFleetRows(entries, children, "c1", 0, 5000);
    assert.equal(lines[0].text[0], " ");
    assert.equal(lines[1].text[0], "▸");
  });

  it("renders no child lines when the map has no children", () => {
    const entries = [fleetRun("p1", { status: "done", startedAt: 1000 })];
    const lines = renderFleetRows(entries, new Map(), undefined, 0, 5000);
    assert.equal(lines.length, 1);
  });

  it("carries per-segment hues: marker/body undecorated, glyph status-hued", () => {
    const entries = [
      fleetRun("r1", { status: "running", startedAt: 1000 }),
      fleetRun("r2", { status: "done", startedAt: 2000 }),
    ];
    const lines = renderFleetRows(entries, new Map(), "r2", 0, 5000);
    // Running row: marker + prefix hue absent, spinner carries running.
    assert.equal(lines[0].segments?.length, 6);
    assert.equal(lines[0].segments?.[0].hue, undefined);
    assert.equal(lines[0].segments?.[0].text, " ");
    assert.equal(lines[0].segments?.[1].hue, undefined);
    assert.equal(lines[0].segments?.[1].text, " ");
    assert.equal(lines[0].segments?.[2].hue, "running");
    assert.ok(lines[0].segments?.[2].text.startsWith(SPINNER_FRAMES[0]));
    // The row body splits into the bare agent name (marked for the adapter
    // to colorize with the configured color) and the plain ` · label ·
    // duration` remainder.
    assert.equal(lines[0].segments?.[3].hue, undefined);
    assert.equal(lines[0].segments?.[3].text, " ");
    assert.equal(lines[0].segments?.[4].hue, undefined);
    assert.equal(lines[0].segments?.[4].text, "lynx");
    assert.equal(lines[0].segments?.[4].agent, "lynx");
    assert.equal(lines[0].segments?.[5].hue, undefined);
    assert.equal(lines[0].segments?.[5].text, " · 0:04");
    // Done row: ▸ marker hue absent, ● carries success, body plain.
    assert.equal(lines[1].segments?.[0].text, "▸");
    assert.equal(lines[1].segments?.[0].hue, undefined);
    assert.equal(lines[1].segments?.[1].hue, undefined);
    assert.equal(lines[1].segments?.[2].hue, "success");
    assert.equal(lines[1].segments?.[2].text, "●");
    assert.equal(lines[1].segments?.[3].text, " ");
    assert.equal(lines[1].segments?.[3].hue, undefined);
    assert.equal(lines[1].segments?.[4].text, "lynx");
    assert.equal(lines[1].segments?.[4].agent, "lynx");
    assert.equal(lines[1].segments?.[4].hue, undefined);
    assert.equal(lines[1].segments?.[5].hue, undefined);
    assert.equal(lines[1].segments?.[5].text, " · 0:03");
    // Flat text stays the segment concatenation.
    for (const line of lines) {
      assert.equal(
        line.text,
        (line.segments ?? []).map((s) => s.text).join(""),
      );
    }
  });

  it("marks error/aborted rows' ● with the error hue", () => {
    const entries = [
      fleetRun("r1", { status: "error", startedAt: 1000 }),
      fleetRun("r2", { status: "aborted", startedAt: 2000 }),
    ];
    const lines = renderFleetRows(entries, new Map(), undefined, 0, 3000);
    for (const line of lines) {
      assert.equal(line.segments?.[0].hue, undefined);
      assert.equal(line.segments?.[1].hue, undefined);
      assert.equal(line.segments?.[2].hue, "error");
      assert.equal(line.segments?.[2].text, "●");
      assert.equal(line.segments?.[3].hue, undefined);
      assert.equal(line.segments?.[4].agent, "lynx");
      assert.equal(line.segments?.[5].hue, undefined);
    }
  });

  it("freezes the duration of a terminal row at its endedAt, not now", () => {
    const entries = [
      fleetRun("r1", { status: "done", startedAt: 1000, endedAt: 6000 }),
      fleetRun("r2", { status: "error", startedAt: 2000, endedAt: 5000 }),
    ];
    // `now` is far in the future — a terminal row must not keep counting.
    const lines = renderFleetRows(entries, new Map(), undefined, 0, 1_000_000);
    assert.equal(lines[0].text, "  ● lynx · 0:05");
    assert.equal(lines[1].text, "  ● lynx · 0:03");
    // The flat text and the body segment agree.
    assert.ok(lines[0].text.includes("· 0:05"), lines[0].text);
    assert.ok(lines[1].text.includes("· 0:03"), lines[1].text);
  });

  it("omits the duration for an aborted run whose endedAt equals startedAt", () => {
    // Regression: a session-restored aborted run has `endedAt === startedAt`
    // (the interruption timestamp is unknown), which rendered a misleading
    // `0:00` that implied the run completed instantly.  The duration segment
    // must be omitted for such runs — the interruption time is simply
    // unknown — while the rest of the row stays intact.
    const entries = [
      fleetRun("r1", {
        status: "done",
        startedAt: 1000,
        endedAt: 6000,
      }),
      fleetRun("r2", {
        status: "aborted",
        startedAt: 2000,
        endedAt: 2000,
      }),
      fleetRun("r3", {
        status: "aborted",
        startedAt: 3000,
        endedAt: 9000,
      }),
    ];
    const lines = renderFleetRows(entries, new Map(), undefined, 0, 1_000_000);
    // Done row keeps its duration.
    assert.equal(lines[0].text, "  ● lynx · 0:05");
    // Aborted with unknown duration: no `· 0:00` and no trailing ` ·`.
    assert.equal(lines[1].text, "  ● lynx");
    // Aborted with a known duration still shows it.
    assert.equal(lines[2].text, "  ● lynx · 0:06");
    // The flat text and the body segment agree for the duration-less row.
    assert.ok(!lines[1].text.includes("0:00"), lines[1].text);
    assert.ok(!lines[1].text.includes(" · "), lines[1].text);
    assert.equal(
      lines[1].text,
      (lines[1].segments ?? []).map((s) => s.text).join(""),
    );
  });
});

// ---------------------------------------------------------------------------
// Card children — renderProgressCard / renderResultCard nested run lines
// ---------------------------------------------------------------------------

describe("renderProgressCard — children", () => {
  it("appends nested run lines after the tool-call region when children exist", () => {
    const children = [
      fleetRun("c1", {
        agent: "lynx",
        label: "search",
        status: "done",
        startedAt: 0,
      }),
      fleetRun("c2", {
        agent: "spider",
        label: "fetch",
        status: "running",
        startedAt: 0,
      }),
    ];
    const lines = renderProgressCard(
      runningSnapshot(),
      "实现功能",
      false,
      0,
      0,
      children,
    );
    const childLines = lines.filter((l) => l.text.startsWith("├─"));
    assert.deepEqual(
      childLines.map((l) => l.text),
      [
        "├─ ● subagent(lynx) · search",
        `├─ ${SPINNER_FRAMES[0]} subagent(spider) · fetch`,
      ],
    );
    // Running child carries the running hue; done child the success hue.
    assert.equal(childLines[0].hue, "success");
    assert.equal(childLines[1].hue, "running");
  });

  it("advances the running child spinner with the shared frameSeq", () => {
    const children = [
      fleetRun("c1", {
        agent: "lynx",
        label: "search",
        status: "running",
        startedAt: 0,
      }),
    ];
    // Regression: `fleetCardChildLines` hardcoded frame 0, so a running
    // nested child's spinner never animated even when the card was rebuilt
    // with an advancing frameSeq.  The card's frameSeq must flow through to
    // the child glyph.
    const lines = renderProgressCard(
      runningSnapshot(),
      "实现功能",
      false,
      0,
      3,
      children,
    );
    const childLines = lines.filter((l) => l.text.startsWith("├─"));
    assert.equal(
      childLines[0].text,
      `├─ ${SPINNER_FRAMES[3]} subagent(lynx) · search`,
      "running child spinner must use the shared frameSeq, not frame 0",
    );
  });

  it("leaves the running card output identical when no children are passed", () => {
    const without = renderProgressCard(runningSnapshot(), "实现功能");
    const withEmpty = renderProgressCard(
      runningSnapshot(),
      "实现功能",
      false,
      Date.now(),
      undefined,
      [],
    );
    assert.deepEqual(
      withEmpty.map((l) => l.text),
      without.map((l) => l.text),
      "an empty children list must not change the running card",
    );
  });
});

describe("renderResultCard — children", () => {
  it("appends nested run lines when children exist", () => {
    const children = [
      fleetRun("c1", {
        agent: "lynx",
        label: "search",
        status: "error",
        startedAt: 0,
      }),
    ];
    const lines = renderResultCard(okSnapshot(), "实现功能", false, children);
    const childLines = lines.filter((l) => l.text.startsWith("├─"));
    assert.deepEqual(
      childLines.map((l) => l.text),
      ["├─ ● subagent(lynx) · search"],
    );
    assert.equal(childLines[0].hue, "error");
  });

  it("advances a running child spinner with the result card frameSeq", () => {
    const children = [
      fleetRun("c1", {
        agent: "spider",
        label: "fetch",
        status: "running",
        startedAt: 0,
      }),
    ];
    // Regression: `fleetCardChildLines` hardcoded frame 0, so a running
    // nested child's spinner never animated.  The result card's frameSeq
    // must flow through to the child glyph.
    const lines = renderResultCard(
      okSnapshot(),
      "实现功能",
      false,
      children,
      7,
    );
    const childLines = lines.filter((l) => l.text.startsWith("├─"));
    assert.equal(
      childLines[0].text,
      `├─ ${SPINNER_FRAMES[7]} subagent(spider) · fetch`,
      "running child spinner must use the result card frameSeq, not frame 0",
    );
  });

  it("leaves the result card output identical when no children are passed", () => {
    const without = renderResultCard(okSnapshot(), "实现功能");
    const withEmpty = renderResultCard(okSnapshot(), "实现功能", false, []);
    assert.deepEqual(
      withEmpty.map((l) => l.text),
      without.map((l) => l.text),
      "an empty children list must not change the result card",
    );
  });
});
