/**
 * Tests for the subagent transcript projections (`src/core/subagent/view.ts`).
 *
 * The view model is pure: it projects a run's append-only fact log
 * (`run-log.ts`) plus run metadata into the display lines of the pi TUI
 * card.  Every line carries a semantic hue (`running` / `success` /
 * `error` / `muted` / `accent`) that the pi adapter later maps to a
 * concrete theme color — core stays host-free.  This suite locks the
 * projection rules: the collapsed recency window vs full expanded
 * output, render-width truncation (never a baked-in character cap),
 * per-tool-kind one-line summaries, and counters derived from facts.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { SubagentRun } from "./registry.js";
import { createRunLog, type RunLog } from "./run-log.js";
import type { CardLine, CardMeta, CardOptions } from "./view.js";
import {
  deriveCounters,
  formatTokenCount,
  GLANCE_LINES,
  projectCard,
  renderFleetCollapsed,
  renderFleetRows,
  renderProgressTitle,
  renderTitle,
  SPINNER_FRAMES,
  summarizeToolCall,
} from "./view.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A running-run card metadata fixture. */
function runningMeta(overrides: Partial<CardMeta> = {}): CardMeta {
  return {
    agent: "beaver",
    status: "running",
    startedAt: 0,
    currentTool: "bash",
    ...overrides,
  };
}

/** A terminal-run card metadata fixture (done unless overridden). */
function terminalMeta(overrides: Partial<CardMeta> = {}): CardMeta {
  return {
    agent: "beaver",
    status: "done",
    startedAt: 0,
    endedAt: 0,
    ...overrides,
  };
}

/** The card projection options with the test defaults filled in. */
function cardOpts(overrides: Partial<CardOptions> = {}): CardOptions {
  return { width: 80, expanded: false, now: 0, ...overrides };
}

/** A log with `n` tool-start facts (bash echo 0..n-1), newest last. */
function toolStarts(log: RunLog, n: number): void {
  for (let i = 0; i < n; i++) {
    log.appendToolStart("bash", { command: `echo ${i}` }, i);
  }
}

/** A log with `n` assistant message facts ("line of message i"). */
function messageEnds(log: RunLog, n: number): void {
  for (let i = 0; i < n; i++) {
    log.appendMessage([{ type: "text", text: `msg ${i} body` }], undefined, i);
  }
}

/** Assert every line carries one of the documented semantic hues. */
function assertValidLines(lines: CardLine[]): void {
  const hues = new Set(["running", "success", "error", "muted", "accent"]);
  for (const line of lines) {
    assert.ok(hues.has(line.hue), `unknown hue ${line.hue}`);
    assert.ok(typeof line.text === "string" && line.text.length > 0);
  }
}

/** The tool-call (`→ ...`) line texts of a projected card. */
function toolTexts(lines: CardLine[]): string[] {
  return lines.filter((l) => l.text.startsWith("\u2192")).map((l) => l.text);
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
// projectCard — running body
// ---------------------------------------------------------------------------

describe("projectCard (running)", () => {
  it("renders the current tool, tool lines, output lines, and stats", () => {
    const log = createRunLog();
    log.appendToolStart("bash", { command: "npm run build" }, 0);
    log.appendMessage(
      [{ type: "text", text: "compiling the agent" }],
      undefined,
      1,
    );
    const lines = projectCard(log, runningMeta(), cardOpts());
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
    const toolLine = lines.find(
      (l) => l.hue === "accent" && !l.text.startsWith("→"),
    );
    assert.ok(toolLine, "expected an accent current-tool line");
    assert.equal(toolLine.text, "bash");

    // The tool-call summary line is projected from the tool-start fact.
    assert.deepEqual(toolTexts(lines), ["→ $ npm run build"]);

    // Recent output line (muted), derived from the message fact.
    const outputLine = lines.find(
      (l) => l.hue === "muted" && !l.text.startsWith("⟳"),
    );
    assert.ok(outputLine, "expected a muted output line");
    assert.ok(outputLine.text.includes("compiling the agent"));

    // Stats line carries turn / tool / elapsed — counters derived from facts.
    const stats = lines[lines.length - 1];
    assert.ok(stats.text.includes("1 turn"), `missing turns: ${stats.text}`);
    assert.ok(stats.text.includes("1 tool"), `missing tools: ${stats.text}`);
    assert.ok(
      !stats.text.includes("1 turns") && !stats.text.includes("1 tools"),
      `singular must be used for a count of 1: ${stats.text}`,
    );
  });

  it("renders tool-call summaries without duplicating the tool name", () => {
    const log = createRunLog();
    log.appendToolStart(
      "read",
      { file_path: "/home/u/x/src/core/slots.ts" },
      0,
    );
    log.appendToolStart("bash", { command: "npm run build" }, 1);
    const lines = projectCard(
      log,
      runningMeta({ currentTool: undefined }),
      cardOpts({ width: 200 }),
    );
    // The summary is self-contained (`read <path>` / `$ <cmd>`): the view
    // renders it verbatim after the arrow, never re-prefixing the name.
    assert.deepEqual(toolTexts(lines), [
      "→ read /home/u/x/src/core/slots.ts",
      "→ $ npm run build",
    ]);
    assert.ok(
      !toolTexts(lines).some((t) => t.includes("read read")),
      `duplicated tool name: ${toolTexts(lines).join(" | ")}`,
    );
  });

  it("collapsed shows only the last GLANCE_LINES tool and output entries, newest last", () => {
    const log = createRunLog();
    toolStarts(log, 10);
    messageEnds(log, 10);
    const lines = projectCard(
      log,
      runningMeta({ currentTool: undefined }),
      cardOpts({ width: 200 }),
    );
    const tools = toolTexts(lines);
    assert.equal(tools.length, GLANCE_LINES, "collapsed tool window");
    assert.deepEqual(tools, ["→ $ echo 7", "→ $ echo 8", "→ $ echo 9"]);
    const outputs = lines.filter(
      (l) => l.hue === "muted" && !l.text.startsWith("⟳"),
    );
    assert.equal(outputs.length, GLANCE_LINES, "collapsed output window");
    assert.deepEqual(
      outputs.map((l) => l.text),
      ["msg 7 body", "msg 8 body", "msg 9 body"],
    );
    // Newest last within each region.
    assert.equal(tools[tools.length - 1], "→ $ echo 9");
  });

  it("collapsed window size is overridable via opts.glanceLines", () => {
    const log = createRunLog();
    toolStarts(log, 10);
    const lines = projectCard(
      log,
      runningMeta({ currentTool: undefined }),
      cardOpts({ width: 200, glanceLines: 5 }),
    );
    assert.equal(toolTexts(lines).length, 5);
  });

  it("expanded shows every entry, not just the glance window", () => {
    const log = createRunLog();
    toolStarts(log, 40);
    messageEnds(log, 40);
    const lines = projectCard(
      log,
      runningMeta({ currentTool: undefined }),
      cardOpts({ width: 200, expanded: true }),
    );
    assert.equal(toolTexts(lines).length, 40, "expanded shows all tool lines");
    const outputs = lines.filter(
      (l) => l.hue === "muted" && !l.text.startsWith("⟳"),
    );
    assert.equal(outputs.length, 40, "expanded shows all output lines");
    assert.equal(lines[lines.length - 1].text.includes("40 turns"), true);
    assert.equal(lines[lines.length - 1].text.includes("40 tools"), true);
  });

  it("shows the (no output yet) placeholder when no message facts exist", () => {
    const log = createRunLog();
    log.appendToolStart("bash", { command: "true" }, 0);
    const lines = projectCard(log, runningMeta(), cardOpts());
    assert.ok(
      lines.some((l) => l.text === "(no output yet)"),
      lines.map((l) => l.text).join(" | "),
    );
  });

  it("caps tool-call lines to the render width, never a baked-in 60", () => {
    const log = createRunLog();
    const long = "x".repeat(500);
    log.appendToolStart("bash", { command: long }, 0);
    const narrow = projectCard(
      log,
      runningMeta({ currentTool: undefined }),
      cardOpts({ width: 40 }),
    );
    const [line] = toolTexts(narrow);
    assert.ok(line.startsWith("→ $ xxx"), line);
    assert.equal(line.length, 40, `width-clipped line: ${line.length}`);
    assert.ok(line.endsWith("…"), `missing ellipsis: ${line}`);
    // A wider render keeps more of the same fact — proof the cap is the
    // passed width, not a constant.
    const wide = projectCard(
      log,
      runningMeta({ currentTool: undefined }),
      cardOpts({ width: 120 }),
    );
    assert.equal(toolTexts(wide)[0].length, 120);
  });

  it("appends the token usage to the stats line when facts report it", () => {
    const log = createRunLog();
    for (let i = 0; i < 3; i++) {
      log.appendMessage(
        [{ type: "text", text: `t${i}` }],
        { totalTokens: 4115 },
        i,
      );
    }
    for (let i = 0; i < 5; i++)
      log.appendToolStart("bash", { command: "x" }, i);
    const lines = projectCard(
      log,
      runningMeta({ currentTool: undefined }),
      cardOpts(),
    );
    const stats = lines[lines.length - 1].text;
    // `3 turns · 5 tools · 12.3k tok · <elapsed>`
    assert.ok(stats.includes("12.3k tok"), `missing tokens: ${stats}`);
    assert.ok(
      stats.includes("3 turns · 5 tools · 12.3k tok"),
      `unexpected order: ${stats}`,
    );
  });

  it("omits the token segment from the stats line when absent", () => {
    const log = createRunLog();
    log.appendMessage([{ type: "text", text: "hi" }], undefined, 0);
    const lines = projectCard(log, runningMeta(), cardOpts());
    const stats = lines[lines.length - 1].text;
    assert.ok(!stats.includes("tok"), `unexpected tokens: ${stats}`);
  });

  it("keeps the running body independent of agent identity text", () => {
    const log = createRunLog();
    const lines = projectCard(log, runningMeta(), cardOpts());
    const texts = lines.map((l) => l.text);
    // The label is owned by the tool-call card title; the running body
    // never leaks it (and never renders a spinner title either).
    assert.ok(!texts.some((t) => t.includes("subagent(beaver)")));
    assert.ok(
      !texts.some((t) => t.includes("undefined")),
      `leaked undefined: ${texts.join(" | ")}`,
    );
  });
});

describe("formatTokenCount", () => {
  it("uses the thousand-abbreviation convention", () => {
    assert.equal(formatTokenCount(0), "0");
    assert.equal(formatTokenCount(999), "999");
    assert.equal(formatTokenCount(1000), "1.0k");
    assert.equal(formatTokenCount(12345), "12.3k");
    assert.equal(formatTokenCount(100000), "100.0k");
    assert.equal(formatTokenCount(1000000), "1000k");
  });
});

describe("deriveCounters", () => {
  it("counts turns from message facts and tools from tool-start facts", () => {
    const log = createRunLog();
    log.appendToolStart("bash", { command: "a" }, 0);
    log.appendToolEnd("bash", [{ type: "text", text: "ok" }], false, 1);
    log.appendMessage(
      [{ type: "text", text: "done" }],
      { input: 10, output: 5 },
      2,
    );
    assert.deepEqual(deriveCounters(log.facts()), {
      turnCount: 1,
      toolCallCount: 1,
      tokens: 15,
    });
  });

  it("prefers totalTokens over input+output and skips non-positive reports", () => {
    const log = createRunLog();
    log.appendMessage(
      [{ type: "text", text: "a" }],
      { totalTokens: 100, input: 1, output: 1 },
      0,
    );
    log.appendMessage(
      [{ type: "text", text: "b" }],
      { input: 0, output: 0 },
      1,
    );
    assert.equal(deriveCounters(log.facts()).tokens, 100);
  });

  it("keeps tokens undefined when no usage was ever reported", () => {
    const log = createRunLog();
    log.appendMessage([{ type: "text", text: "a" }], undefined, 0);
    assert.deepEqual(deriveCounters(log.facts()), {
      turnCount: 1,
      toolCallCount: 0,
    });
  });

  it("ignores user_message facts: the instruction is neither a turn nor a token report", () => {
    const log = createRunLog();
    log.appendUserMessage("the delegation prompt", 0);
    log.appendMessage([{ type: "text", text: "a" }], { totalTokens: 50 }, 1);
    log.appendUserMessage("steered mid-run", 2);
    assert.deepEqual(deriveCounters(log.facts()), {
      turnCount: 1,
      toolCallCount: 0,
      tokens: 50,
    });
  });
});

describe("user_message facts — never projected as agent output", () => {
  it("keeps the prompt out of the running card's output region", () => {
    const log = createRunLog();
    log.appendUserMessage("SUMMARY: the instruction", 0);
    log.appendMessage([{ type: "text", text: "real output" }], undefined, 1);
    const lines = projectCard(
      log,
      terminalMeta({ status: "running" }),
      cardOpts({ expanded: true }),
    );
    assert.ok(
      lines.some((line) => line.text.includes("real output")),
      "the assistant message still projects",
    );
    assert.equal(
      lines.filter((line) => line.text.includes("the instruction")).length,
      0,
      "the delegation prompt must not appear as agent output",
    );
  });

  it("keeps the last assistant message as the terminal card's final text when a later user fact exists", () => {
    // A run steered mid-flight ends with a user fact; the final-text scan
    // must walk past it to the assistant message rather than reporting "no
    // output" (or the instruction).
    const log = createRunLog();
    log.appendUserMessage("the delegation prompt", 0);
    log.appendMessage([{ type: "text", text: "the answer" }], undefined, 1);
    log.appendUserMessage("and now the tests", 2);
    const lines = projectCard(
      log,
      terminalMeta(),
      cardOpts({ expanded: true }),
    );
    assert.ok(
      lines.some((line) => line.text === "the answer"),
      `final text must be the assistant message, got: ${JSON.stringify(
        lines.map((l) => l.text),
      )}`,
    );
    assert.equal(
      lines.filter((line) => line.text === "(no output)").length,
      0,
      "a trailing user fact must not erase the final text",
    );
  });
});

describe("summarizeToolCall", () => {
  it("renders a bash call as `$ <command>` (ANSI-cleaned, whitespace-collapsed)", () => {
    assert.equal(
      summarizeToolCall("bash", { command: "[1mecho   hi[0m" }, 80),
      "$ echo hi",
    );
    assert.equal(summarizeToolCall("bash", {}, 80), "$ …");
  });

  it("renders read/write/edit as `<name> <path>` with $HOME collapsed to ~", () => {
    const home = process.env.HOME ?? "";
    assert.equal(
      summarizeToolCall("read", { file_path: `${home}/src/a.ts` }, 80),
      "read ~/src/a.ts",
    );
    assert.equal(
      summarizeToolCall("write", { path: "/tmp/out.txt" }, 80),
      "write /tmp/out.txt",
    );
    assert.equal(summarizeToolCall("edit", { file_path: home }, 80), "edit ~");
    assert.equal(summarizeToolCall("read", {}, 80), "read …");
  });

  it("renders other tools as `<name> <JSON args>`", () => {
    const summary = summarizeToolCall(
      "webfetch",
      { url: "https://example.com", method: "GET" },
      80,
    );
    assert.ok(summary.startsWith("webfetch "), `unexpected: ${summary}`);
    assert.ok(summary.includes('"url"'), `missing url: ${summary}`);
  });

  it("caps the summary to the passed width, not a fixed character cap", () => {
    const long = `echo ${"x".repeat(300)}`;
    const summary = summarizeToolCall("bash", { command: long }, 30);
    assert.equal(summary.length, 30, `width-capped summary: ${summary.length}`);
    assert.ok(summary.endsWith("…"), summary);
    // The same fact with a wider render keeps everything.
    assert.equal(
      summarizeToolCall("bash", { command: "ls -la" }, 30).length,
      8,
    );
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
    log: createRunLog(),
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
// projectCard — terminal states
// ---------------------------------------------------------------------------

describe("projectCard (terminal)", () => {
  /** A finished log: two tool calls, then a final assistant message. */
  function finishedLog(text = "all tests pass"): RunLog {
    const log = createRunLog();
    log.appendToolStart("bash", { command: "bun test" }, 0);
    log.appendToolEnd("bash", [{ type: "text", text: "pass" }], false, 1);
    log.appendMessage([{ type: "text", text }], { totalTokens: 500 }, 2);
    return log;
  }

  it("renders a success check and the final text summary", () => {
    const lines = projectCard(
      finishedLog(),
      terminalMeta(),
      cardOpts({ now: 0 }),
    );
    assertValidLines(lines);
    assert.ok(lines[0].text.startsWith("✓ subagent(beaver)"), lines[0].text);
    assert.equal(lines[0].hue, "success");
    // The terminal card shows no tool-call lines: the statistics badge
    // already summarizes the run's tools.
    assert.deepEqual(toolTexts(lines), []);
    const finalLine = lines[lines.length - 1];
    assert.equal(finalLine.text, "all tests pass");
    // Collapsed previews carry the render-boundary flag, not a cap.
    assert.equal(finalLine.truncateToWidth, true);
    assert.equal(finalLine.markdown, undefined);
  });

  it("carries the run statistics in the terminal title badge", () => {
    const lines = projectCard(
      finishedLog(),
      terminalMeta(),
      cardOpts({ now: 0 }),
    );
    // startedAt 0 means "unknown" -> the elapsed segment degrades to -:--.
    assert.ok(
      lines[0].text.includes("⟳ 1 turn · 1 tool · 500 tok · -:--"),
      lines[0].text,
    );
  });

  it("renders an error marker and the error reason", () => {
    const lines = projectCard(
      finishedLog("command failed"),
      terminalMeta({ status: "error", error: "exit 1" }),
      cardOpts(),
    );
    assert.ok(lines[0].text.startsWith("✗"), lines[0].text);
    assert.equal(lines[0].hue, "error");
    const errLine = lines.find((l) => l.hue === "error" && l !== lines[0]);
    assert.equal(errLine?.text, "exit 1");
    assert.equal(
      errLine?.truncateToWidth,
      true,
      "reason clips at render width",
    );
  });

  it("renders an aborted result distinctly from ok", () => {
    const lines = projectCard(
      finishedLog("partial work"),
      terminalMeta({ status: "aborted" }),
      cardOpts(),
    );
    assert.ok(lines[0].text.startsWith("⏹"), lines[0].text);
    assert.equal(lines[0].hue, "muted");
    assert.ok(!lines[0].text.startsWith("✓"));
  });

  it("expanded shows the final text in full as markdown, with no cap", () => {
    const long = "x".repeat(4000);
    const lines = projectCard(
      finishedLog(long),
      terminalMeta(),
      cardOpts({ expanded: true }),
    );
    const md = lines.find((l) => l.markdown === true);
    assert.ok(md, "expanded final text must flow through the markdown path");
    assert.equal(md.text.length, 4000, "expanded must not character-cap");
    assert.equal(md.truncateToWidth, undefined);
  });

  it("collapsed previews only the first non-empty line of the final text", () => {
    const text = "\n   \nfirst line\nsecond line\n";
    const lines = projectCard(finishedLog(text), terminalMeta(), cardOpts());
    const preview = lines[lines.length - 1];
    assert.equal(preview.text, "first line");
    assert.equal(preview.truncateToWidth, true);
    // The preview is not character-capped even past the old 60/80 marks:
    // clipping is the adapter's render-boundary job.
    const longWord = "y".repeat(500);
    const wide = projectCard(finishedLog(longWord), terminalMeta(), cardOpts());
    assert.equal(wide[wide.length - 1].text, longWord);
  });

  it("renders (no output) when the log holds no message facts", () => {
    const log = createRunLog();
    log.appendToolStart("bash", { command: "true" }, 0);
    const lines = projectCard(log, terminalMeta(), cardOpts());
    assert.ok(
      lines.some((l) => l.text === "(no output)"),
      lines.map((l) => l.text).join(" | "),
    );
  });

  it("joins multiple text parts of the final message", () => {
    const log = createRunLog();
    log.appendMessage(
      [
        { type: "thinking", thinking: "hm" },
        { type: "text", text: "part one\n" },
        { type: "text", text: "part two" },
      ],
      undefined,
      0,
    );
    const lines = projectCard(
      log,
      terminalMeta(),
      cardOpts({ expanded: true }),
    );
    assert.equal(lines[lines.length - 1].text, "part one\npart two");
  });
});

// ---------------------------------------------------------------------------
// Card children — projectCard nested run lines
// ---------------------------------------------------------------------------

describe("projectCard (running) — children", () => {
  it("appends nested run lines after the tool-call region when children exist", () => {
    const children = [
      fleetRun("c1", { agent: "lynx", label: "search", status: "done" }),
      fleetRun("c2", { agent: "spider", label: "fetch", status: "running" }),
    ];
    const log = createRunLog();
    log.appendToolStart("bash", { command: "true" }, 0);
    const lines = projectCard(log, runningMeta(), cardOpts({ children }));
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

  it("advances the running child spinner with the shared frame", () => {
    // Regression: the child glyph must follow the card's frame sequence so
    // a running nested child's spinner animates on each rebuild.
    const children = [
      fleetRun("c1", { agent: "lynx", label: "search", status: "running" }),
    ];
    const lines = projectCard(
      createRunLog(),
      runningMeta(),
      cardOpts({ children, frame: 3 }),
    );
    const childLines = lines.filter((l) => l.text.startsWith("├─"));
    assert.equal(
      childLines[0].text,
      `├─ ${SPINNER_FRAMES[3]} subagent(lynx) · search`,
      "running child spinner must use the shared frame, not frame 0",
    );
  });

  it("leaves the running card output identical when no children are passed", () => {
    const log = createRunLog();
    log.appendToolStart("bash", { command: "true" }, 0);
    const without = projectCard(log, runningMeta(), cardOpts());
    const withEmpty = projectCard(
      log,
      runningMeta(),
      cardOpts({ children: [] }),
    );
    assert.deepEqual(
      withEmpty.map((l) => l.text),
      without.map((l) => l.text),
      "an empty children list must not change the running card",
    );
  });
});

describe("projectCard (terminal) — children", () => {
  it("appends nested run lines and advances a running child spinner", () => {
    const children = [
      fleetRun("c1", { agent: "lynx", label: "search", status: "error" }),
      fleetRun("c2", { agent: "spider", label: "fetch", status: "running" }),
    ];
    const log = createRunLog();
    log.appendMessage([{ type: "text", text: "done" }], undefined, 0);
    const lines = projectCard(
      log,
      terminalMeta(),
      cardOpts({ children, frame: 7 }),
    );
    const childLines = lines.filter((l) => l.text.startsWith("├─"));
    assert.deepEqual(
      childLines.map((l) => l.text),
      [
        "├─ ● subagent(lynx) · search",
        `├─ ${SPINNER_FRAMES[7]} subagent(spider) · fetch`,
      ],
    );
    assert.equal(childLines[0].hue, "error");
  });

  it("leaves the terminal card output identical when no children are passed", () => {
    const log = createRunLog();
    log.appendMessage([{ type: "text", text: "done" }], undefined, 0);
    const without = projectCard(log, terminalMeta(), cardOpts());
    const withEmpty = projectCard(
      log,
      terminalMeta(),
      cardOpts({ children: [] }),
    );
    assert.deepEqual(
      withEmpty.map((l) => l.text),
      without.map((l) => l.text),
      "an empty children list must not change the terminal card",
    );
  });
});
