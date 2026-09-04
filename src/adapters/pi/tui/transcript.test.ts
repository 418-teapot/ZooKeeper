/**
 * Tests for the transcript overlay — the pure RunLog projection.
 *
 * Covers the overlay component's contract:
 *   - viewport rows derived from the terminal height (chrome excluded);
 *   - the full-screen render: title line + scrolled body window + hint line,
 *     every line padded to the full width (no base-layer bleed-through);
 *   - fact projection: message_end through pi's native assistant component,
 *     tool pairs through the native ToolExecutionComponent (bash's exact
 *     `$ <command>` shell), unbuildable tools through the structured
 *     fallback (accent `→ <name>` + JSON fenced args), pending tool_starts
 *     rendered as running, orphan tool_ends appended as verbatim result
 *     text;
 *   - keyboard scrolling (line / page / start / end), clamping, and the
 *     ctrl+o tool-expansion toggle;
 *   - the SGR mouse wheel (fullscreen-mode bytes) stepping one line per
 *     notch;
 *   - live updates through the log's single subscription (`log.subscribe`):
 *     components grow at the tail, the
 *     end-follow scroll semantics, fallback blocks updated when their tool
 *     result arrives;
 *   - the esc/q close protocol and dispose (subscription dropped).
 *
 * The official message/tool components render through the coding-agent
 * module-level `theme` singleton; `initTheme()` is called here so the real
 * components construct (pi initializes the same singleton at startup).
 * The overlay's own chrome still colors through the stub theme's `fg` so
 * title/hint assertions stay exact.
 *
 * @module
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import {
  createRunLog,
  type MessagePart,
  type RunLog,
} from "../../../core/subagent/run-log.js";
import { factsFromContextMessages } from "../hydrate.js";
import {
  computeViewportRows,
  createTranscriptOverlay,
  openTranscriptOverlay,
  stripControlSequences,
  TRANSCRIPT_UNAVAILABLE_NOTICE,
  TRANSCRIPT_VIEWPORT_FALLBACK,
  type TranscriptOverlayDeps,
} from "./transcript.js";

initTheme();

/** A text content part (the shape a partial delivery carries). */
function text(t: string): MessagePart {
  return { type: "text", text: t };
}

/** A thinking content part. */
function thinking(t: string): MessagePart {
  return { type: "thinking", thinking: t };
}

// SGR sequence matcher (the colors / italics pi's theme emits).  The ESC byte
// is spelled at runtime so no control character enters a regex literal — the
// same convention the overlay's mouse-report matcher follows.
const SGR_SEQUENCE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

/** Strip ANSI SGR sequences from a rendered line. */
function plain(line: string): string {
  return line.replace(SGR_SEQUENCE, "");
}

/** The SGR sequences a rendered line carries (its styling signature). */
function styles(line: string): string {
  return (line.match(SGR_SEQUENCE) ?? []).join("");
}

/** A minimal theme stub matching `MarkdownThemeSource`'s method shape. */
const THEME = {
  fg: (style: string, text: string) => `<${style}>${text}</${style}>`,
  bg: (style: string, text: string) => `[${style}]${text}[/${style}]`,
  bold: (text: string) => text,
  italic: (text: string) => text,
  underline: (text: string) => text,
  strikethrough: (text: string) => text,
};

/** A stub TUI with a tall terminal so the whole body fits the viewport. */
const TUI = {
  requestRender: () => {},
  terminal: { rows: 40 },
};

/** An overlay component that can be rendered, driven, and disposed. */
interface OverlayComponent {
  render(width: number): string[];
  handleInput(data: string): void;
  dispose(): void;
  invalidate(): void;
  scrollView: { scrollTop: number; viewportHeight: number };
}

/** Build an overlay over a fresh log pre-filled with the given facts. */
function overlay(
  overrides: Partial<TranscriptOverlayDeps> = {},
  log?: RunLog,
): { component: OverlayComponent; log: RunLog; closed: () => number } {
  const runLog = log ?? createRunLog();
  let closes = 0;
  const deps: TranscriptOverlayDeps = {
    title: "beaver · 实现任务",
    log: runLog,
    tui: TUI,
    theme: THEME,
    done: () => {
      closes += 1;
    },
    ...overrides,
  };
  const component = createTranscriptOverlay(
    deps,
  ) as unknown as OverlayComponent;
  return {
    component,
    log: runLog,
    closed: () => closes,
  };
}

/** Render an overlay's component tree to plain text lines. */
function render(component: OverlayComponent, width: number): string[] {
  return component.render(width);
}

/** Press a key through the overlay component's input handler. */
function press(component: OverlayComponent, data: string): void {
  component.handleInput(data);
}

/** A control-character sequence helper (ESC + body; avoids raw escapes). */
function key(body: string): string {
  return String.fromCharCode(27) + body;
}

describe("computeViewportRows", () => {
  it("derives the body budget from the terminal rows (chrome excluded)", () => {
    // Full-screen overlay: rows - (title + hint).
    assert.equal(computeViewportRows(30), 28);
    assert.equal(computeViewportRows(40), 38);
  });

  it("floors at the minimum usable viewport", () => {
    assert.equal(computeViewportRows(2), 3);
    assert.equal(computeViewportRows(5), 3);
    assert.equal(computeViewportRows(10), 8);
  });

  it("falls back when the row count is unknown", () => {
    assert.equal(computeViewportRows(undefined), TRANSCRIPT_VIEWPORT_FALLBACK);
    assert.equal(computeViewportRows(0), TRANSCRIPT_VIEWPORT_FALLBACK);
    assert.equal(computeViewportRows(-3), TRANSCRIPT_VIEWPORT_FALLBACK);
  });

  it("uses the fallback constant as the unknown-height budget", () => {
    assert.equal(TRANSCRIPT_VIEWPORT_FALLBACK, 12);
  });
});

describe("createTranscriptOverlay — render", () => {
  it("renders the title line and the close hint", () => {
    const { component } = overlay();
    const lines = render(component, 60);
    assert.ok(
      lines.some((l) => l.includes("beaver")),
      lines.join("\n"),
    );
    assert.ok(
      lines.some((l) => l.includes("esc/q close")),
      lines.join("\n"),
    );
  });

  it("colors the title line through borderColorize when supplied", () => {
    const { component } = overlay({
      borderColorize: (text) => `[tc]${text}[/tc]`,
    });
    const lines = render(component, 60);
    const title = lines[0];
    assert.ok(title.includes("[tc]"), title);
    assert.ok(
      !lines.some((l) => l.includes("<border>")),
      "the colorizer replaces the border-colored title",
    );
  });

  it("colorizes the default title with the theme border color", () => {
    const { component } = overlay();
    const lines = render(component, 60);
    assert.ok(lines[0].includes("<border>"), lines[0]);
  });

  it("covers the full screen: every line padded to the render width", () => {
    // The overlay spans the whole terminal; base content must not bleed
    // through at line ends, so every row spans the full width.
    const { component } = overlay({ title: "t" });
    const lines = render(component, 70);
    assert.ok(lines.length > 0);
    for (const line of lines) {
      // The stub theme wraps colors in tags; the padding spaces after the
      // visible content keep every line at least the full width.
      const visible = line.replace(/<\/?[a-z]+>/g, "");
      assert.ok(
        visible.length >= 70 || line.trim().length > 0,
        `line must span the width: ${JSON.stringify(line)}`,
      );
    }
  });

  it("renders exactly the terminal height (chrome + viewport rows)", () => {
    const { component } = overlay({ title: "t" });
    // TUI.terminal.rows = 40 → 2 chrome rows + 38 viewport rows.
    const lines = render(component, 70);
    assert.equal(lines.length, 40);
  });

  it("renders an empty transcript line when the log has no facts", () => {
    const { component } = overlay();
    const lines = render(component, 60);
    assert.ok(
      lines.some((l) => l.includes("(empty transcript)")),
      lines.join("\n"),
    );
  });

  it("renders a supplied emptyNotice in place of the empty-transcript line", () => {
    // The pi entry point uses this for a restored run whose session file
    // cannot be read: the overlay still explains itself instead of lying
    // about an empty transcript.
    const { component } = overlay({
      emptyNotice: TRANSCRIPT_UNAVAILABLE_NOTICE,
    });
    const lines = render(component, 60);
    assert.ok(
      lines.some((l) => l.includes(TRANSCRIPT_UNAVAILABLE_NOTICE)),
      lines.join(" | "),
    );
    assert.ok(
      !lines.some((l) => l.includes("(empty transcript)")),
      lines.join(" | "),
    );
  });

  it("drops the notice as soon as a fact projects", () => {
    const { component, log } = overlay({
      emptyNotice: TRANSCRIPT_UNAVAILABLE_NOTICE,
    });
    log.appendMessage([{ type: "text", text: "late fact" }]);
    const lines = render(component, 60);
    assert.ok(
      lines.some((l) => l.includes("late fact")),
      lines.join(" | "),
    );
    assert.ok(
      !lines.some((l) => l.includes(TRANSCRIPT_UNAVAILABLE_NOTICE)),
      lines.join(" | "),
    );
  });

  it("projects message_end facts through pi's native assistant component", () => {
    const log = createRunLog();
    log.appendMessage([{ type: "text", text: "hello world" }]);
    const { component } = overlay({}, log);
    const lines = render(component, 60);
    assert.ok(
      lines.some((l) => l.includes("hello world")),
      lines.join("\n"),
    );
  });

  it("projects the delegation prompt as the first body component", () => {
    // The regression this guards: the overlay used to replay the
    // sub-session's JSONL (whose first record is the user message), and the
    // RunLog projection dropped it, so the delegated prompt showed nowhere.
    const log = createRunLog();
    log.appendUserMessage("SUMMARY: fix the bug", 1);
    log.appendMessage([{ type: "text", text: "the answer" }], undefined, 2);
    const { component } = overlay({}, log);
    const lines = render(component, 60);
    const promptAt = lines.findIndex((l) => l.includes("fix the bug"));
    const answerAt = lines.findIndex((l) => l.includes("the answer"));
    assert.ok(promptAt >= 0, `the prompt must render: ${lines.join(" | ")}`);
    assert.ok(answerAt >= 0, "the assistant message still renders");
    assert.ok(
      promptAt < answerAt,
      `the prompt must head the transcript (prompt row ${promptAt}, answer row ${answerAt}): ${lines.join(" | ")}`,
    );
  });

  it("renders nothing for a blank user-message fact", () => {
    const log = createRunLog();
    log.appendUserMessage("   ", 1);
    const { component } = overlay({}, log);
    const lines = render(component, 60);
    assert.ok(
      lines.some((l) => l.includes("(empty transcript)")),
      `a blank instruction must not produce an empty box: ${lines.join(" | ")}`,
    );
  });

  it("projects a hydrated log identically to the live log it mirrors", () => {
    // The overlay must not care where the facts came from: the same run
    // rebuilt from the persisted sub-session renders the prompt exactly as
    // the in-memory stream does.  `live` is shaped the way the driver shapes
    // it (prompt fact at the send point, one message_end per assistant
    // message — including the tool-calling one — plus the tool bookends);
    // `hydrated` is the same run rebuilt from its persisted messages.
    const prompt = "SUMMARY: do the work\n\nACCEPTANCE: it passes";
    const live = createRunLog();
    live.appendUserMessage(prompt, 1);
    live.appendMessage([{ type: "text", text: "working" }], undefined, 2);
    live.appendMessage([{ type: "text", text: "listing" }], undefined, 3);
    live.appendToolStart("bash", { command: "ls" }, 3, "c1");
    live.appendToolEnd(
      "bash",
      [{ type: "text", text: "a.txt" }],
      false,
      4,
      "c1",
    );

    const hydrated = createRunLog();
    for (const fact of factsFromContextMessages([
      { role: "user", content: prompt, timestamp: 1 },
      {
        role: "assistant",
        content: [{ type: "text", text: "working" }],
        timestamp: 2,
      },
      {
        role: "assistant",
        content: [
          { type: "text", text: "listing" },
          {
            type: "toolCall",
            id: "c1",
            name: "bash",
            arguments: { command: "ls" },
          },
        ],
        timestamp: 3,
      },
      {
        role: "toolResult",
        toolCallId: "c1",
        toolName: "bash",
        content: [{ type: "text", text: "a.txt" }],
        isError: false,
        timestamp: 4,
      },
    ])) {
      hydrated.append(fact);
    }

    assert.deepEqual(
      hydrated.facts().map((fact) => fact.type),
      live.facts().map((fact) => fact.type),
      "the hydrated stream must carry the same fact kinds in the same order",
    );

    const liveLines = render(overlay({}, live).component, 70);
    const hydratedLines = render(overlay({}, hydrated).component, 70);
    assert.ok(
      liveLines.some((l) => l.includes("do the work")),
      `live must show the prompt: ${liveLines.join(" | ")}`,
    );
    assert.ok(
      hydratedLines.some((l) => l.includes("do the work")),
      `hydrated must show the prompt: ${hydratedLines.join(" | ")}`,
    );
    assert.deepEqual(
      hydratedLines,
      liveLines,
      "a hydrated run must render identically to the live run it mirrors",
    );
  });
});

describe("createTranscriptOverlay — tool projection", () => {
  it("renders a paired tool_start/tool_end through pi's native component", () => {
    const log = createRunLog();
    log.appendToolStart("bash", { command: "npm test" }, 1, "c1");
    log.appendToolEnd(
      "bash",
      [{ type: "text", text: "all tests pass" }],
      false,
      2,
      "c1",
    );
    const { component } = overlay({}, log);
    const lines = render(component, 100);
    // The native bash shell renders the command line...
    assert.ok(
      lines.some((l) => l.includes("npm test")),
      lines.join(" | "),
    );
    // ...and the result through the tool's own renderer.
    assert.ok(
      lines.some((l) => l.includes("all tests pass")),
      lines.join(" | "),
    );
    // Not the structured fallback.
    assert.ok(!lines.some((l) => l.includes("→ bash")), lines.join(" | "));
  });

  it("renders a tool_start without its end as running", () => {
    const log = createRunLog();
    log.appendToolStart("bash", { command: "sleep 30" }, 1, "c1");
    const { component } = overlay({}, log);
    const lines = render(component, 100);
    assert.ok(
      lines.some((l) => l.includes("sleep 30")),
      `the running call shell must render: ${lines.join(" | ")}`,
    );
  });

  it("feeds a late tool_end into the mounted running component", () => {
    const log = createRunLog();
    log.appendToolStart("bash", { command: "echo hi" }, 1, "c1");
    const { component } = overlay({}, log);
    let lines = render(component, 100);
    assert.ok(!lines.some((l) => l.includes("hi output")), lines.join(" | "));
    log.appendToolEnd(
      "bash",
      [{ type: "text", text: "hi output" }],
      false,
      2,
      "c1",
    );
    lines = render(component, 100);
    assert.ok(
      lines.some((l) => l.includes("hi output")),
      `the result must fold into the native component: ${lines.join(" | ")}`,
    );
  });

  it("falls back to the structured block for an unbuildable tool", () => {
    const log = createRunLog();
    log.appendToolStart("made_up_tool", { knob: "up" }, 1, "c1");
    const { component } = overlay({}, log);
    const lines = render(component, 100);
    assert.ok(
      lines.some((l) => l.includes("→ made_up_tool")),
      `fallback call line expected: ${lines.join(" | ")}`,
    );
    assert.ok(
      lines.some((l) => l.includes("knob")),
      `fallback args block expected: ${lines.join(" | ")}`,
    );
  });

  it("appends the result text below a fallback-rendered start", () => {
    const log = createRunLog();
    log.appendToolStart("made_up_tool", { knob: "up" }, 1, "c1");
    log.appendToolEnd(
      "made_up_tool",
      [{ type: "text", text: "fallback result" }],
      false,
      2,
      "c1",
    );
    const { component } = overlay({}, log);
    const lines = render(component, 100);
    const call = lines.findIndex((l) => l.includes("→ made_up_tool"));
    const result = lines.findIndex((l) => l.includes("fallback result"));
    assert.ok(call >= 0, lines.join(" | "));
    assert.ok(
      result > call,
      `result must follow the call: ${lines.join(" | ")}`,
    );
  });
  it("renders an orphan tool_end (no start) as verbatim result text", () => {
    const log = createRunLog();
    log.appendToolEnd(
      "bash",
      [{ type: "text", text: "orphan-out" }],
      false,
      1000,
      "never-started",
    );
    const { component } = overlay({}, log);
    const lines = render(component, 60);
    assert.ok(
      lines.some((l) => l.includes("orphan-out")),
      lines.join("\n"),
    );
    // The orphan never renders the arrow fallback (no call was observed).
    assert.ok(!lines.some((l) => l.includes("→")), lines.join("\n"));
  });

  it("skips an orphan tool_end whose result carries no text", () => {
    const log = createRunLog();
    log.appendToolEnd("bash", [], false, 1000, "gone");
    const { component } = overlay({}, log);
    const lines = render(component, 60);
    assert.ok(
      lines.every((l) => !l.includes("bash")),
      lines.join("\n"),
    );
  });

  it("pairs id-less facts by tool name in FIFO order", () => {
    const log = createRunLog();
    log.appendToolStart("made_up_tool", { n: 1 }, 1000);
    log.appendToolStart("made_up_tool", { n: 2 }, 1001);
    log.appendToolEnd(
      "made_up_tool",
      [{ type: "text", text: "first-out" }],
      false,
      1002,
    );
    log.appendToolEnd(
      "made_up_tool",
      [{ type: "text", text: "second-out" }],
      false,
      1003,
    );
    const { component } = overlay({}, log);
    const lines = render(component, 60);
    assert.ok(
      lines.some((l) => l.includes("first-out")),
      lines.join("\n"),
    );
    assert.ok(
      lines.some((l) => l.includes("second-out")),
      lines.join("\n"),
    );
    const arrowLines = lines.filter((l) => l.includes("made_up_tool"));
    assert.equal(arrowLines.length, 2, "both starts render, no duplicates");
  });

  it("renders an orphan tool_end without its terminal control sequences", () => {
    // The fallback path prints text the plugin never produced: a custom tool
    // can return escape and control bytes, which must not reach the terminal
    // (the card's no-ANSI contract applies to everything the overlay draws).
    const log = createRunLog();
    log.appendToolEnd(
      "bash",
      [
        {
          type: "text",
          text: "\u001b]0;evil-title\u0007BEFORE\u001b[31mRED\u001b[0m\u0007AFTER\nsecond line",
        },
      ],
      false,
      1000,
      "orphan-control",
    );
    const { component } = overlay({}, log);
    const lines = render(component, 60);
    assert.ok(
      lines.some((l) => l.includes("BEFORERED")),
      `visible text must survive stripped: ${JSON.stringify(lines.join(" | "))}`,
    );
    assert.ok(
      lines.some((l) => l.includes("AFTER")),
      lines.join(" | "),
    );
    assert.ok(
      lines.some((l) => l.includes("second line")),
      "the newline must still split the lines",
    );
    assert.ok(
      !lines.some((l) => l.includes("\u001b") || l.includes("\u0007")),
      `no control byte may reach the render: ${JSON.stringify(lines.join(" | "))}`,
    );
    assert.ok(
      !lines.some((l) => l.includes("evil-title")),
      "the OSC payload must be dropped with the sequence",
    );
  });
});

describe("stripControlSequences", () => {
  it("leaves a plain string untouched", () => {
    const plain = "total 8\ndrwxr-xr-x 2 root root 4096 Aug  1 12:00 .\n";
    assert.equal(stripControlSequences(plain), plain);
  });

  it("drops CSI sequences and keeps their payload-free text", () => {
    assert.equal(
      stripControlSequences("\u001b[1;31merror\u001b[0m: gone"),
      "error: gone",
    );
  });

  it("drops OSC and APC sequences including their hyperlinks", () => {
    assert.equal(
      stripControlSequences(
        "\u001b]8;;https://example.com\u0007link\u001b]8;;\u0007",
      ),
      "link",
    );
    assert.equal(
      stripControlSequences("\u001b]0;window title\u0007body"),
      "body",
    );
    assert.equal(stripControlSequences("\u001b_foo\u001b\\body"), "body");
  });

  it("keeps tab and newline while dropping the other control bytes", () => {
    // NUL / BEL / vertical tab / backspace / ESC and the C1 range are all
    // non-printing or terminal-driving; tab and line feed are ordinary text.
    assert.equal(
      stripControlSequences("a\u0000b\u0007c\u0008d\u000be\u001bf\u008dg"),
      "abcdefg",
    );
    assert.equal(stripControlSequences("x\ty\nz"), "x\ty\nz");
    // A CRLF payload keeps its line break and loses the carriage return.
    assert.equal(stripControlSequences("line1\r\nline2"), "line1\nline2");
  });

  it("drops a lone escape byte that opens no sequence", () => {
    assert.equal(stripControlSequences("esc\u001balone"), "escalone");
  });

  it("keeps wide characters and other non-ASCII text", () => {
    assert.equal(stripControlSequences("中文 ✓ ‑"), "中文 ✓ ‑");
  });
});

describe("createTranscriptOverlay — scrolling", () => {
  /** A log whose body surely exceeds the 38-row viewport (100 messages). */
  function longLog(): RunLog {
    const log = createRunLog();
    for (let i = 0; i < 100; i++) {
      log.appendMessage([{ type: "text", text: `row-${String(i)}` }]);
    }
    return log;
  }

  it("opens at the bottom of the transcript", () => {
    // Restored runs are static: the interesting content is the tail, so the
    // first render must show the last line, not row 0.
    const { component } = overlay({}, longLog());
    const lines = render(component, 60);
    assert.ok(
      lines.some((l) => l.includes("row-99")),
      `the tail must be on screen at open: ${lines.join(" | ")}`,
    );
    assert.ok(
      !lines.some((l) => l.includes("row-0")),
      "the head must be off-screen at open",
    );
  });

  it("scrolls up with the arrow key (k works too)", () => {
    const { component } = overlay({}, longLog());
    let lines = render(component, 60);
    assert.ok(lines.some((l) => l.includes("row-99")));
    // Each message spans two body rows (an OSC-133 marker row + content),
    // so two line steps scroll the last message off the bottom.
    press(component, key("[A"));
    press(component, key("[A"));
    lines = render(component, 60);
    assert.ok(
      !lines.some((l) => l.includes("row-99")),
      "row-99 scrolled off the bottom",
    );
    press(component, "k");
    lines = render(component, 60);
    assert.ok(
      lines.some((l) => l.includes("row-96")),
      lines.join(" | "),
    );
  });

  it("scrolling back down to the tail re-pins the view (j works too)", () => {
    const log = longLog();
    const { component } = overlay({}, log);
    render(component, 60);
    press(component, key("[A"));
    press(component, key("[A")); // up off the tail — the pin breaks
    press(component, key("[B"));
    press(component, "j"); // back down onto it — the pin re-engages
    log.appendMessage([{ type: "text", text: "fresh tail" }]);
    const lines = render(component, 60);
    assert.ok(
      lines.some((l) => l.includes("fresh tail")),
      lines.join(" | "),
    );
  });

  it("clamps at the tail (no over-scroll past the last line)", () => {
    const { component } = overlay({}, longLog());
    render(component, 60);
    const at = component.scrollView.scrollTop;
    press(component, key("[B")); // down
    press(component, "j");
    assert.equal(component.scrollView.scrollTop, at, "already at the tail");
    const lines = render(component, 60);
    assert.ok(
      lines.some((l) => l.includes("row-99")),
      lines.join(" | "),
    );
  });

  it("jumps to the start / end with Home / End", () => {
    const { component } = overlay({}, longLog());
    render(component, 60); // the first render sets the ScrollView viewport
    press(component, key("[H")); // Home
    let lines = render(component, 60);
    assert.ok(
      lines.some((l) => l.includes("row-0")),
      lines.join(" | "),
    );
    assert.ok(!lines.some((l) => l.includes("row-99")));
    press(component, key("OF")); // End
    lines = render(component, 60);
    assert.ok(
      lines.some((l) => l.includes("row-99")),
      lines.join(" | "),
    );
  });

  it("page keys step a viewport-minus-overlap page", () => {
    const { component } = overlay({}, longLog());
    render(component, 60); // the first render sets the ScrollView viewport
    press(component, key("[H")); // Home — pages are measured from the start.
    render(component, 60);
    press(component, key("[6~")); // PageDown
    const lines = render(component, 60);
    // Viewport = 38 body rows; a page steps 38 - 4 = 34 lines.
    assert.ok(
      lines.some((l) => l.includes("row-34")),
      `expected row-34 on screen: ${lines.join(" | ")}`,
    );
    press(component, key("[5~")); // PageUp
    const back = render(component, 60);
    assert.ok(
      back.some((l) => l.includes("row-0")),
      back.join(" | "),
    );
  });

  it("a shrinking body does not silently re-pin a line-anchored view", () => {
    // The anchor model's payoff: where the view looks is intent, not
    // geometry.  When an in-place change (here the retirement of a streaming
    // partial) shrinks the body under a line anchor, the window clamps to the
    // last reachable row — but the clamp never turns the line anchor into a
    // tail follow, so content that grows past the anchored row again finds
    // the view still holding its line.
    const log = createRunLog();
    for (let i = 0; i < 100; i++) {
      log.appendMessage([{ type: "text", text: `old-${String(i)}` }]);
    }
    const { component } = overlay({}, log);
    render(component, 60);
    const tail = component.scrollView.scrollTop;
    assert.ok(tail > 0, "the transcript must be scrollable");

    // A streaming tail grows the body and the tail anchor follows it.
    const streamed = Array.from(
      { length: 40 },
      (_, i) => `stream-${String(i)}`,
    ).join("\n");
    log.setPartial([text(streamed)]);
    render(component, 60);
    const grown = component.scrollView.scrollTop;
    assert.ok(grown > tail, "a pinned view follows the streaming growth");

    // One line off the tail anchors the view to a body line.
    press(component, key("[A"));
    const anchored = component.scrollView.scrollTop;
    assert.equal(anchored, grown - 1);

    // Retiring the partial shrinks the body under the anchor: the window
    // clamps onto the end by geometry, nothing more.
    log.setPartial([]);
    render(component, 60);
    assert.equal(
      component.scrollView.scrollTop,
      tail,
      "the clamped view sits at the end by geometry",
    );

    // Grow the body well past the anchored row.  A silent re-pin would chase
    // this tail; the line anchor reclaims its row and leaves the newest
    // content below the fold.
    const appended = 2 * (grown - tail + 1);
    for (let i = 0; i < appended; i++) {
      log.appendMessage([{ type: "text", text: `late-${String(i)}` }]);
    }
    const lines = render(component, 60);
    assert.equal(
      component.scrollView.scrollTop,
      anchored,
      "the line anchor holds its row instead of following the tail",
    );
    assert.ok(
      !lines.some((l) => l.includes(`late-${String(appended - 1)}`)),
      "the new tail stays off-screen",
    );
  });

  it("a live append while unpinned keeps its offset", () => {
    const log = longLog();
    const { component } = overlay({}, log);
    render(component, 60);
    press(component, key("[H")); // Home — unpin.
    const before = component.scrollView.scrollTop;
    assert.equal(before, 0);
    log.appendMessage([{ type: "text", text: "appended below" }]);
    assert.equal(
      component.scrollView.scrollTop,
      before,
      "an unpinned view keeps its offset",
    );
    const lines = render(component, 60);
    assert.ok(
      !lines.some((l) => l.includes("appended below")),
      "the new tail is not forced into view",
    );
  });
});

describe("createTranscriptOverlay — live appends", () => {
  it("projects a user_message fact appended after open", () => {
    // The driver appends the prompt the moment it sends it, which is before
    // the overlay can open; a later steered input therefore arrives live and
    // must reach the body through the same projection.
    const { component, log } = overlay();
    log.appendMessage([{ type: "text", text: "first answer" }]);
    log.appendUserMessage("and now add tests", 2);
    const lines = render(component, 60);
    assert.ok(
      lines.some((l) => l.includes("first answer")),
      lines.join(" | "),
    );
    assert.ok(
      lines.some((l) => l.includes("and now add tests")),
      `a live user_message fact must project: ${lines.join(" | ")}`,
    );
  });

  it("projects a fact appended after open", () => {
    const { component, log } = overlay();
    let lines = render(component, 60);
    assert.ok(
      lines.some((l) => l.includes("(empty transcript)")),
      lines.join(" | "),
    );
    log.appendMessage([{ type: "text", text: "arrived live" }]);
    lines = render(component, 60);
    assert.ok(
      lines.some((l) => l.includes("arrived live")),
      lines.join(" | "),
    );
    assert.ok(
      !lines.some((l) => l.includes("(empty transcript)")),
      lines.join(" | "),
    );
  });

  it("survives a repaint that throws mid-projection", () => {
    // Regression guard for the listener-isolation contract: the overlay's
    // projection runs synchronously inside the driver's append (pi dispatches
    // host events without protecting subscriber code), so a throw anywhere in
    // it must not escape into the child session's event flow or poison the
    // facts that follow.
    let repaints = 0;
    const tui = {
      requestRender: () => {
        repaints += 1;
        if (repaints === 1) throw new Error("paint boom");
      },
      terminal: { rows: 40 },
    };
    const { component, log } = overlay({ tui });
    assert.doesNotThrow(() =>
      log.appendMessage([{ type: "text", text: "first fact" }]),
    );
    log.appendMessage([{ type: "text", text: "second fact" }]);
    const lines = render(component, 60);
    assert.ok(
      lines.some((l) => l.includes("first fact")),
      `the throwing append must still project: ${lines.join(" | ")}`,
    );
    assert.ok(
      lines.some((l) => l.includes("second fact")),
      `later appends must keep projecting: ${lines.join(" | ")}`,
    );
  });

  it("mounts a live tool_start as running and folds its end in place", () => {
    const { component, log } = overlay();
    log.appendToolStart("bash", { command: "ls -la" }, 1, "live-1");
    let lines = render(component, 100);
    assert.ok(
      lines.some((l) => l.includes("ls -la")),
      lines.join(" | "),
    );
    log.appendToolEnd(
      "bash",
      [{ type: "text", text: "total 3" }],
      false,
      2,
      "live-1",
    );
    lines = render(component, 100);
    assert.ok(
      lines.some((l) => l.includes("total 3")),
      lines.join(" | "),
    );
    // The update happened in place: one shell line, not a duplicated block.
    const shells = lines.filter((l) => l.includes("ls -la"));
    assert.equal(shells.length, 1, lines.join(" | "));
  });

  it("opens at the bottom and stays pinned as live facts append", () => {
    // The live-run case: no `End` press — the view opens glued to the tail
    // and every appended fact keeps the newest content on screen.
    const log = createRunLog();
    for (let i = 0; i < 100; i++) {
      log.appendMessage([{ type: "text", text: `old-${String(i)}` }]);
    }
    const { component } = overlay({}, log);
    assert.ok(
      render(component, 60).some((l) => l.includes("old-99")),
      "the run tail is on screen at open",
    );
    log.appendMessage([{ type: "text", text: "fresh tail" }]);
    const lines = render(component, 60);
    assert.ok(
      lines.some((l) => l.includes("fresh tail")),
      `a pinned view follows the tail: ${lines.join(" | ")}`,
    );
    assert.ok(!lines.some((l) => l.includes("old-0")), lines.join(" | "));
  });

  it("keeps the pin for facts appended before the first render", () => {
    // Height and row counts are only known inside render(width): an append
    // that lands between open and the first render must still end up with
    // the newest content on screen.
    const log = createRunLog();
    for (let i = 0; i < 100; i++) {
      log.appendMessage([{ type: "text", text: `old-${String(i)}` }]);
    }
    const { component } = overlay({}, log);
    log.appendMessage([{ type: "text", text: "appended before render" }]);
    const lines = render(component, 60);
    assert.ok(
      lines.some((l) => l.includes("appended before render")),
      lines.join(" | "),
    );
  });

  it("keeps an end-glued view glued when a fact appends", () => {
    const log = createRunLog();
    for (let i = 0; i < 100; i++) {
      log.appendMessage([{ type: "text", text: `old-${String(i)}` }]);
    }
    const { component } = overlay({}, log);
    render(component, 60);
    press(component, key("[H")); // Home — unpin.
    press(component, key("OF")); // End — glue the view to the tail.
    log.appendMessage([{ type: "text", text: "fresh tail" }]);
    const lines = render(component, 60);
    assert.ok(
      lines.some((l) => l.includes("fresh tail")),
      `the end-glued view follows the tail: ${lines.join(" | ")}`,
    );
    assert.ok(!lines.some((l) => l.includes("old-0")), lines.join(" | "));
  });

  it("preserves a mid-scroll offset when a fact appends", () => {
    const log = createRunLog();
    for (let i = 0; i < 100; i++) {
      log.appendMessage([{ type: "text", text: `old-${String(i)}` }]);
    }
    const { component } = overlay({}, log);
    render(component, 60);
    for (let i = 0; i < 5; i++) press(component, key("[A")); // up 5 from the tail
    const before = component.scrollView.scrollTop;
    log.appendMessage([{ type: "text", text: "appended below" }]);
    assert.equal(component.scrollView.scrollTop, before, "offset preserved");
    assert.ok(
      !render(component, 60).some((l) => l.includes("appended below")),
      "the appended tail stays off-screen while unpinned",
    );
  });

  it("carries the ctrl+o expansion across live appends", () => {
    const { component, log } = overlay();
    log.appendToolStart("bash", { command: "first" }, 1, "t1");
    render(component, 100);
    press(component, String.fromCharCode(15)); // ctrl+o — expand
    log.appendToolStart("bash", { command: "second" }, 2, "t2");
    const lines = render(component, 100);
    // Both tool components exist; the fresh one inherits the expanded flag.
    assert.ok(
      lines.some((l) => l.includes("first")),
      lines.join(" | "),
    );
    assert.ok(
      lines.some((l) => l.includes("second")),
      lines.join(" | "),
    );
    assert.equal(component.scrollView.constructor.name, "ScrollView");
  });
});

describe("createTranscriptOverlay — mouse wheel + close", () => {
  /** A log long enough to need scrolling (one line per message). */
  function wheelLog(): RunLog {
    const log = createRunLog();
    for (let i = 0; i < 100; i++) {
      log.appendMessage([{ type: "text", text: `wheel-row-${String(i)}` }]);
    }
    return log;
  }

  it("SGR wheel reports step one line per notch (fullscreen bytes)", () => {
    const { component } = overlay({}, wheelLog());
    render(component, 60);
    // The view opens pinned to the tail, so the down direction clamps there
    // and the up direction steps back from it.
    const tail = component.scrollView.scrollTop;
    assert.ok(tail > 0, "a long transcript must be scrollable");
    press(component, key("[<65;10;5M")); // wheel down — already at the tail
    assert.equal(component.scrollView.scrollTop, tail);
    press(component, key("[<64;10;5M")); // wheel up
    assert.equal(component.scrollView.scrollTop, tail - 1);
    press(component, key("[<64;10;5M"));
    assert.equal(component.scrollView.scrollTop, tail - 2);
    press(component, key("[<65;10;5M")); // wheel down
    assert.equal(component.scrollView.scrollTop, tail - 1);
  });

  it("ignores non-wheel mouse reports and key releases", () => {
    const { component } = overlay({}, wheelLog());
    render(component, 60);
    const tail = component.scrollView.scrollTop;
    assert.ok(tail > 0);
    press(component, key("[<0;10;5M")); // left-button press — ignored
    press(component, key("[<66;10;5M")); // horizontal wheel — ignored
    press(component, key("[<0;10;5m")); // release — ignored
    assert.equal(component.scrollView.scrollTop, tail);
  });

  it("esc closes through the done callback and drops the subscription", () => {
    const { component, log, closed } = overlay();
    press(component, key(""));
    assert.equal(closed(), 1);
    // After close the subscription is gone: appends must not touch the body.
    log.appendMessage([{ type: "text", text: "after close" }]);
    const lines = render(component, 60);
    assert.ok(!lines.some((l) => l.includes("after close")), lines.join(" | "));
  });

  it("q closes as well; dispose is idempotent after close", () => {
    const { component, closed } = overlay();
    press(component, "q");
    assert.equal(closed(), 1);
    component.dispose();
    assert.equal(closed(), 1, "dispose never calls done again");
  });

  it("dispose without close still drops the subscription", () => {
    const { component, log } = overlay();
    component.dispose();
    log.appendMessage([{ type: "text", text: "post dispose" }]);
    const lines = render(component, 60);
    assert.ok(
      !lines.some((l) => l.includes("post dispose")),
      lines.join(" | "),
    );
  });
});

describe("openTranscriptOverlay", () => {
  it("opens the overlay through the openOverlay surface", () => {
    const log = createRunLog();
    log.appendMessage([{ type: "text", text: "wired" }]);
    let received: unknown;
    const opened = openTranscriptOverlay({
      log,
      title: "lynx · 检索",
      openOverlay: (factory) => {
        received = factory;
      },
    });
    assert.equal(opened, true);
    assert.equal(typeof received, "function");
    const component = (
      received as (
        tui: unknown,
        theme: unknown,
        kb: unknown,
        done: (r: undefined) => void,
      ) => { render(width: number): string[] }
    )(TUI, THEME, undefined, () => {});
    const lines = component.render(60);
    assert.ok(
      lines.some((l) => l.includes("lynx")),
      lines.join(" | "),
    );
    assert.ok(
      lines.some((l) => l.includes("wired")),
      lines.join(" | "),
    );
  });

  it("forwards emptyNotice to the opened component", () => {
    let received: unknown;
    const opened = openTranscriptOverlay({
      log: createRunLog(),
      title: "t",
      emptyNotice: TRANSCRIPT_UNAVAILABLE_NOTICE,
      openOverlay: (factory) => {
        received = factory;
      },
    });
    assert.equal(opened, true);
    const component = (
      received as (
        tui: unknown,
        theme: unknown,
        kb: unknown,
        done: (r: undefined) => void,
      ) => { render(width: number): string[] }
    )(TUI, THEME, undefined, () => {});
    const lines = component.render(60);
    assert.ok(
      lines.some((l) => l.includes(TRANSCRIPT_UNAVAILABLE_NOTICE)),
      lines.join(" | "),
    );
  });

  it("returns false when the log is absent", () => {
    assert.equal(
      openTranscriptOverlay({
        log: undefined,
        title: "t",
        openOverlay: () => undefined,
      }),
      false,
    );
  });

  it("returns false when the host exposes no overlay surface", () => {
    assert.equal(
      openTranscriptOverlay({ log: createRunLog(), title: "t" }),
      false,
    );
    assert.equal(
      openTranscriptOverlay({
        log: createRunLog(),
        title: "t",
        openOverlay: undefined,
      }),
      false,
    );
  });
});

// ---------------------------------------------------------------------------
// Streaming partials
// ---------------------------------------------------------------------------

describe("createTranscriptOverlay — streaming partials", () => {
  /** Count the rendered lines carrying a substring. */
  const hits = (lines: string[], needle: string): number =>
    lines.filter((l) => l.includes(needle)).length;

  it("renders a streamed partial as the trailing message, updated in place", () => {
    // The behaviour the fact-projection refactor lost: an in-flight
    // assistant message shows up token by token instead of all at once when
    // its `message_end` fact lands.
    const { component, log } = overlay();
    log.setPartial([text("alpha")]);
    let lines = render(component, 60);
    assert.ok(
      lines.some((l) => l.includes("alpha")),
      `a partial must stream live: ${lines.join(" | ")}`,
    );
    assert.ok(
      !lines.some((l) => l.includes("(empty transcript)")),
      "the live text replaces the empty-log notice",
    );
    log.setPartial([text("alpha beta")]);
    lines = render(component, 60);
    assert.ok(
      lines.some((l) => l.includes("alpha beta")),
      lines.join(" | "),
    );
    assert.equal(
      hits(lines, "alpha"),
      1,
      `the surface updates in place, never mounts a second copy: ${lines.join(" | ")}`,
    );
  });

  it("replaces the streaming surface with the finalized component on message_end", () => {
    const { component, log } = overlay();
    log.setPartial([text("alpha beta")]);
    render(component, 60);
    log.appendMessage([{ type: "text", text: "alpha beta" }], undefined, 5);
    const lines = render(component, 60);
    assert.equal(
      hits(lines, "alpha"),
      1,
      `the live surface must not outlive the fact: ${lines.join(" | ")}`,
    );
    assert.deepEqual(log.partial(), []);
  });

  it("streams thinking with the styling the finalized fact gets", () => {
    // The reason a partial delivery carries content parts: a reasoning
    // stream has to show up live, styled as thinking — the overlay owns no
    // styling of its own, it hands the parts to the same native component
    // the finalized fact renders through.
    const { component, log } = overlay();
    log.setPartial([thinking("pondering")]);
    const streamed = render(component, 60).find((l) =>
      plain(l).includes("pondering"),
    );
    assert.ok(streamed !== undefined, "the thinking stream must be visible");
    const thinkingStyle = styles(streamed);
    assert.notEqual(thinkingStyle, "", "thinking must not print bare");

    // It is specifically thinking styling: the same word streamed as text
    // renders without it, and renders WITH it once finalized as a fact.
    const textLog = createRunLog();
    textLog.setPartial([text("pondering")]);
    const textLine = overlay({}, textLog)
      .component.render(60)
      .find((l) => plain(l).includes("pondering"));
    assert.notEqual(
      styles(textLine as string),
      thinkingStyle,
      "a thinking part must not render as assistant text",
    );
    const factLog = createRunLog();
    factLog.appendMessage([thinking("pondering")], undefined, 1);
    const factLine = overlay({}, factLog)
      .component.render(60)
      .find((l) => plain(l).includes("pondering"));
    assert.equal(
      thinkingStyle,
      styles(factLine as string),
      "the streamed thinking and the finalized thinking read identically",
    );
  });

  it("streams mixed text and thinking in order", () => {
    const { component, log } = overlay();
    log.setPartial([thinking("first the reasoning"), text("then the answer")]);
    const lines = render(component, 60);
    const body = lines.map(plain).join("\n");
    assert.ok(body.includes("first the reasoning"), body);
    assert.ok(body.includes("then the answer"), body);
    assert.ok(
      body.indexOf("first the reasoning") < body.indexOf("then the answer"),
      "the interleaving order of the parts survives to the render",
    );
  });

  it("replaces the streaming thinking surface on message_end", () => {
    // The finalize hand-off: the live surface retires as the fact lands, so
    // the reasoning never shows twice.
    const { component, log } = overlay();
    log.setPartial([thinking("pondering")]);
    render(component, 60);
    log.appendMessage([thinking("pondering")], undefined, 5);
    const lines = render(component, 60);
    assert.equal(
      lines.filter((l) => plain(l).includes("pondering")).length,
      1,
      `the live surface must not outlive the fact: ${lines.map(plain).join(" | ")}`,
    );
    assert.deepEqual(log.partial(), []);
  });

  it("replaces the streaming surface when any other fact finalizes the tail", () => {
    // A streamed message that turns into a tool call appends a tool_start
    // without a message_end of its own; the append still retires the
    // partial, so no half-message lingers above the tool block.
    const { component, log } = overlay();
    log.setPartial([text("let me run")]);
    render(component, 60);
    log.appendToolStart("bash", { command: "ls" }, 6, "t1");
    const lines = render(component, 60);
    assert.equal(hits(lines, "let me run"), 0, lines.join(" | "));
    assert.ok(
      lines.some((l) => l.includes("ls")),
      lines.join(" | "),
    );
  });

  it("mounts a partial that is already streaming when the overlay opens", () => {
    // Enter-inspect during a run: the log carries the accumulated text, so
    // the overlay must show it without waiting for the next delta.
    const log = createRunLog();
    log.appendMessage([{ type: "text", text: "earlier answer" }], undefined, 1);
    log.setPartial([text("working on it")]);
    const { component } = overlay({}, log);
    const lines = render(component, 60);
    assert.ok(
      lines.some((l) => l.includes("earlier answer")),
      lines.join(" | "),
    );
    assert.ok(
      lines.some((l) => l.includes("working on it")),
      lines.join(" | "),
    );
  });

  it("drops the streaming surface when the partial is retired", () => {
    // The abort path: the driver sends its end-of-stream marker, and the
    // live surface has to go with it.
    const { component, log } = overlay();
    log.setPartial([text("half a thought")]);
    render(component, 60);
    log.setPartial([]);
    const lines = render(component, 60);
    assert.equal(hits(lines, "half a thought"), 0, lines.join(" | "));
    assert.ok(
      lines.some((l) => l.includes("(empty transcript)")),
      "the body returns to the empty-log state",
    );
  });

  it("takes exactly one subscription and no fact-only shortcut", () => {
    // The subscription shape, locked: the overlay wires itself to the run's
    // data stream once and derives both the streaming surface and the fact
    // projections from that one ordered feed — it must never reach for the
    // `onFact` convenience and re-add the streaming surface somewhere else.
    const log = createRunLog();
    const called: string[] = [];
    let subscriptions = 0;
    const spy = new Proxy(log, {
      get(target, prop) {
        const value = Reflect.get(target, prop) as unknown;
        if (prop === "subscribe") {
          return (listener: Parameters<RunLog["subscribe"]>[0]) => {
            subscriptions += 1;
            return target.subscribe(listener);
          };
        }
        if (typeof value === "function" && typeof prop === "string") {
          called.push(prop);
          return value.bind(target);
        }
        return value;
      },
    });
    const { component } = overlay({}, spy);
    log.setPartial([text("streaming")]);
    log.appendMessage([{ type: "text", text: "streaming" }], undefined, 1);
    assert.equal(
      subscriptions,
      1,
      "the overlay subscribes to the stream exactly once",
    );
    assert.deepEqual(
      called.filter((name) => name === "onFact"),
      [],
      `the stream subscription must be the only wiring: ${called.join(", ")}`,
    );
    const lines = render(component, 60);
    assert.equal(
      hits(lines, "streaming"),
      1,
      "the one subscription drives both the retirement and the fact",
    );
  });

  it("keeps the view pinned across the retire-and-fact events", () => {
    // The append delivers two events (retire, then fact) and changes the
    // body twice.  What a render must never show is the state in between:
    // the finalized message present exactly once, at the tail the pinned
    // view follows.
    const log = createRunLog();
    for (let i = 0; i < 40; i++) {
      log.appendMessage(
        [{ type: "text", text: `fact-${String(i)}` }],
        undefined,
        i,
      );
    }
    const { component } = overlay({}, log);
    render(component, 60);
    log.setPartial([text("a streamed answer\nwith a second line")]);
    render(component, 60);
    log.appendMessage(
      [{ type: "text", text: "a streamed answer\nwith a second line" }],
      undefined,
      100,
    );
    const lines = render(component, 60);
    assert.equal(hits(lines, "a streamed answer"), 1, lines.join(" | "));
    assert.ok(
      lines.some((l) => l.includes("with a second line")),
      `the pinned view shows the new tail: ${lines.join(" | ")}`,
    );
  });

  it("keeps the tail pinned while the partial grows", () => {
    // Row-windowing interaction: the streaming surface changes the body
    // height, so a following view must re-pin to the new tail every delta.
    const log = createRunLog();
    for (let i = 0; i < 100; i++) {
      log.appendMessage(
        [{ type: "text", text: `old-${String(i)}` }],
        undefined,
        i,
      );
    }
    const { component } = overlay({}, log);
    assert.ok(
      render(component, 60).some((l) => l.includes("old-99")),
      "opens at the tail",
    );
    log.setPartial([text("streaming tail")]);
    assert.ok(
      render(component, 60).some((l) => l.includes("streaming tail")),
      "a pinned view follows the streaming text",
    );
    const pinned = component.scrollView.scrollTop;
    log.setPartial([text("streaming tail\nand more lines below it")]);
    assert.ok(
      component.scrollView.scrollTop >= pinned,
      "growing content keeps the view at the tail",
    );
    assert.ok(
      !render(component, 60).some((l) => l.includes("old-0")),
      "the head stays scrolled off",
    );
  });

  it("leaves an unpinned view undisturbed while streaming", () => {
    const log = createRunLog();
    for (let i = 0; i < 100; i++) {
      log.appendMessage(
        [{ type: "text", text: `old-${String(i)}` }],
        undefined,
        i,
      );
    }
    const { component } = overlay({}, log);
    render(component, 60);
    press(component, key("[H")); // Home — unpin.
    const before = component.scrollView.scrollTop;
    assert.equal(before, 0);
    log.setPartial([text("streaming below")]);
    assert.equal(
      component.scrollView.scrollTop,
      before,
      "streaming must not drag an unread view to the tail",
    );
    assert.ok(
      !render(component, 60).some((l) => l.includes("streaming below")),
      "the streamed tail stays off-screen while unpinned",
    );
  });

  it("stops rendering partials once disposed", () => {
    const { component, log } = overlay();
    log.setPartial([text("first delta")]);
    render(component, 60);
    component.dispose();
    assert.doesNotThrow(() => log.setPartial([text("second delta")]));
    assert.equal(
      hits(render(component, 60), "second delta"),
      0,
      "the single stream subscription is dropped on dispose",
    );
  });
});
