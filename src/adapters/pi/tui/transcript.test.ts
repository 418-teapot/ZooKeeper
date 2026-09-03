/**
 * Tests for the pi transcript overlay (`src/adapters/pi/tui/transcript.ts`).
 *
 * The overlay is the pi TUI translation layer for the fleet widget's run
 * inspection: `openTranscriptOverlay` reads a sub-session's persisted JSONL
 * transcript (through the official `parseSessionEntries` /
 * `sessionEntryToContextMessages` parser) and opens a full-screen read-only
 * overlay via the pi `ui.custom` surface.  While the inspected run is live,
 * the overlay subscribes to the live-transcript bus
 * (`src/adapters/pi/live-transcript.ts`, fed by the subagent driver),
 * renders assistant partials incrementally as they stream, finalizes each
 * `message_end` record as it arrives, mounts live native tool components
 * from the `tool_execution_start` / `tool_execution_end` bookends, and
 * closes a dangling stream on `agent_end` — event-driven, no polling.  A
 * historical run (no `childSession`) renders the final file once.  Scroll
 * semantics: "follow the end when glued (appends and streaming updates
 * alike), keep the offset otherwise", with the `ctrl+o` tool expansion
 * carried across the append.
 *
 * Projection-free rendering: each pi record maps directly to pi's official
 * components — user text renders through `UserMessageComponent`,
 * assistant text + thinking through `AssistantMessageComponent`
 * (`hideThinkingBlock = false`, so thinking renders in full); a `toolCall`
 * paired with its `toolResult` renders through the native
 * `ToolExecutionComponent`; an unpaired `toolCall` falls back to a
 * `→ <name>` line plus its complete JSON arguments; an orphan `toolResult`
 * renders its full text verbatim through a `Text` component (never
 * markdown).  Records the official components cannot cover (non-message
 * entries, unrecognized roles) render nothing.  The body is mounted into
 * the official pi-tui `ScrollView`, which owns the scroll state; the
 * overlay windows the rendered body by `scrollTop` (overlays bypass pi's
 * layout clipping) and forwards `↑↓/jk`, `PageUp/PageDown`, `Home/End` to
 * `ScrollView.scrollBy` / `scrollTo`.
 *
 * The official message components render through the coding-agent module
 * theme singleton, so the theme is initialized from the package's built-in
 * dark theme at the top of this file (Bun runs each test file in its own
 * worker, so the initialization never leaks into other files).
 *
 * Test strategy mirrors the fleet widget tests: a fake TUI / theme stub and
 * a captured `done` callback assert the keyboard protocol and the
 * overlay-open wiring deterministically without a real pi TUI.  Live
 * appends are driven by emitting onto the real live-transcript bus (the
 * overlay subscribes through the same module-level registry the driver
 * emits into).
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { emitTranscriptEvent, resetTranscriptBus } from "../live-transcript.js";
import type { PiHistoryEntry } from "../subagent-scan.js";
import {
  computeViewportRows,
  createTranscriptOverlay,
  openTranscriptOverlay,
  type TranscriptOverlayDeps,
  type TranscriptThemeLike,
  type TranscriptTuiLike,
} from "./transcript.js";

// The official user / assistant message components render through the
// coding-agent module-level theme singleton; the built-in dark theme ships
// with the installed package and needs no configuration.
initTheme();

afterEach(() => {
  resetTranscriptBus();
});

/** A theme stub that wraps each colorized string in `<color>` tags. */
const THEME = {
  fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
  bold: (text: string) => `<b>${text}</b>`,
  italic: (text: string) => `<i>${text}</i>`,
  underline: (text: string) => `<u>${text}</u>`,
  strikethrough: (text: string) => `<s>${text}</s>`,
};

/** A stub TUI recording requestRender calls. */
const TUI = { requestRender: () => {} };

/** A fresh deps object with an optional explicit `done` callback. */
function depsOf(
  overrides: {
    entries?: PiHistoryEntry[];
    notice?: string;
    borderColorize?: (text: string) => string;
    tui?: TranscriptTuiLike;
    theme?: TranscriptThemeLike;
    childSession?: string;
    done?: (result: undefined) => void;
  } = {},
): TranscriptOverlayDeps {
  return {
    title: "beaver · 实现任务",
    entries: overrides.entries ?? [
      { type: "message", message: { role: "user", content: "u1" } },
      {
        type: "message",
        message: { role: "assistant", content: [{ type: "text", text: "a1" }] },
      },
    ],
    ...(overrides.notice !== undefined ? { notice: overrides.notice } : {}),
    ...(overrides.borderColorize !== undefined
      ? { borderColorize: overrides.borderColorize }
      : {}),
    ...(overrides.childSession !== undefined
      ? { childSession: overrides.childSession }
      : {}),
    tui: overrides.tui ?? TUI,
    theme: overrides.theme ?? THEME,
    done: overrides.done ?? (() => {}),
  };
}

/** Render an overlay's component tree to plain text lines. */
function renderComponent(component: unknown, width: number): string[] {
  return (component as { render(width: number): string[] }).render(width);
}

/** Drive one input through the overlay component. */
function sendInput(component: unknown, data: string): void {
  (component as { handleInput(data: string): void }).handleInput(data);
}

/** Strip the stub theme's `<color>` tags (their content is ANSI width-0 in
 * real pi, but the stub counts them as visible width). */
function stripTags(line: string): string {
  return line.replace(/<[^>]+>/g, "");
}

/** Strip ANSI color codes and OSC sequences from a rendered line. */
function stripAnsi(line: string): string {
  const ansi = new RegExp(`${esc("1b")}\\[[0-9;]*m`, "g");
  const osc = new RegExp(
    `${esc("1b")}\\][^${esc("07")}${esc("1b")}]*(?:${esc("07")}|${esc("1b")}\\\\)`,
    "g",
  );
  return line.replace(ansi, "").replace(osc, "");
}

/** A literal control character (avoiding raw escapes in regex literals). */
function esc(hex: string): string {
  return String.fromCharCode(parseInt(hex, 16));
}

/** A pi-shaped user message (the shape `message_end` carries). */
function userMessage(text: string): unknown {
  return { role: "user", content: [{ type: "text", text }] };
}

/** A pi-shaped assistant message. */
function assistantMessage(text: string, stopReason = "stop"): unknown {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    stopReason,
  };
}

describe("computeViewportRows — terminal-height derivation", () => {
  it("derives the viewport from the terminal row count minus fixed chrome rows", () => {
    assert.equal(computeViewportRows(30), 28);
    assert.equal(computeViewportRows(40), 38);
  });

  it("falls back to the default when the terminal height is unknown", () => {
    assert.equal(computeViewportRows(undefined), 12);
  });

  it("keeps a sane minimum so a tiny terminal still shows content", () => {
    assert.ok(computeViewportRows(6) >= 3, "minimum floor applies");
  });
});

describe("createTranscriptOverlay — rendering", () => {
  it("renders the title, the record content, and a hint", () => {
    const deps = depsOf();
    const component = createTranscriptOverlay(deps);
    const lines = renderComponent(component, 80);
    assert.ok(
      lines.some((l) => l.includes("实现任务")),
      lines.join(" | "),
    );
    assert.ok(
      lines.some((l) => l.includes("↑↓/jk scroll · esc/q close")),
      lines.join(" | "),
    );
    assert.ok(
      lines.some((l) => l.includes("u1")),
      lines.join(" | "),
    );
    assert.ok(
      lines.some((l) => l.includes("a1")),
      lines.join(" | "),
    );
  });

  it("colorizes the title line with the agent's configured color when provided", () => {
    const titleCalls: string[] = [];
    const borderColorize = (text: string): string => {
      titleCalls.push(text);
      return `<agent>${text}</agent>`;
    };
    const deps = depsOf({ borderColorize });
    const component = createTranscriptOverlay(deps);
    const lines = renderComponent(component, 80);
    // The whole title line is wrapped as one colorized unit in the agent
    // color; no border glyphs remain (the overlay is full-screen).
    const title = lines[0];
    assert.ok(title.startsWith("<agent>"), title);
    assert.ok(title.includes("实现任务"), title);
    assert.ok(
      !lines.some((l) => l.includes("╭") || l.includes("│")),
      lines.join(" | "),
    );
    assert.ok(
      !lines.some((l) => l.includes("<agent>↑↓/jk")),
      lines.join(" | "),
    );
    assert.ok(
      titleCalls.some((text) => text.includes("实现任务")),
      `the colorizer must wrap the title: ${JSON.stringify(titleCalls)}`,
    );
  });

  it("falls back to the fixed title color when no borderColorize is provided", () => {
    const fgCalls: Array<[string, string]> = [];
    const spyTheme: TranscriptThemeLike = {
      ...THEME,
      fg: (color, text) => {
        fgCalls.push([color, text]);
        return `<${color}>${text}</${color}>`;
      },
    };
    const deps = depsOf({ theme: spyTheme });
    const component = createTranscriptOverlay(deps);
    renderComponent(component, 80);
    const borderCalls = fgCalls.filter(([color]) => color === "border");
    assert.equal(
      borderCalls.length,
      1,
      `only the title line may use the border color: ${JSON.stringify(borderCalls)}`,
    );
    assert.ok(
      borderCalls[0]?.[1].includes("实现任务"),
      `the title line carries the title text: ${JSON.stringify(borderCalls)}`,
    );
  });

  it("sizes the body to the terminal-derived viewport and fills every screen row", () => {
    const deps = depsOf({
      tui: { requestRender: () => {}, terminal: { rows: 30 } },
      entries: Array.from({ length: 30 }, (_, i) => ({
        type: "message",
        message: { role: "user", content: `l${i}` },
      })),
    });
    const component = createTranscriptOverlay(deps);
    const lines = renderComponent(component, 80);
    // Full-screen: exactly termHeight rows (title + hint + 28 body rows).
    assert.equal(lines.length, 30, "the overlay fills the terminal height");
    const body = lines.filter((l) => /l\d/.test(stripTags(l)));
    // Each user message renders a 3-row box (pad / text / pad) through the
    // official component, so with the 28-row viewport 9 full boxes fit
    // (l0..l8 = 27 rows); l9's text row sits past the viewport.
    assert.ok(
      body.some((l) => l.includes("l0")) && body.some((l) => l.includes("l8")),
      body.join(" | "),
    );
    assert.ok(
      !body.some((l) => l.includes("l9")),
      "rows past the viewport are scrolled, not rendered",
    );
    // Every screen row is padded to the full width (no base bleed-through).
    // The raw line carries the stub theme's `<color>` tags as visible chars
    // (real pi's ANSI is width-0), so `visibleWidth` on the raw line must
    // reach the terminal width exactly.
    assert.ok(
      lines.every((l) => visibleWidth(l) === 80),
      lines.map((l) => `[${l}]`).join("\n"),
    );
  });

  it("renders exactly termHeight rows with every line at termWidth", () => {
    // Full-screen contract: row 0 / col 0 with 100% width and height, so
    // the overlay must emit exactly `terminal.rows` lines and each line
    // must span the full declared width — otherwise the base layer (chat +
    // widget) would show through and its diff repaints could flicker under
    // the overlay.
    const deps = depsOf({
      tui: { requestRender: () => {}, terminal: { rows: 24 } },
      entries: [
        { type: "message", message: { role: "user", content: "u1" } },
        {
          type: "message",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "a1" }],
          },
        },
      ],
    });
    const component = createTranscriptOverlay(deps);
    const lines = renderComponent(component, 100);
    assert.equal(
      lines.length,
      24,
      "the overlay must fill the terminal height (title + hint + 22 body rows)",
    );
    assert.ok(
      lines.every((l) => visibleWidth(l) === 100),
      lines.map((l) => `[${l}]`).join("\n"),
    );
    // No border glyphs: the full-screen surface has no frame, so there is
    // nothing to show through and nothing to colorize per-glyph.
    assert.ok(
      lines.every(
        (l) =>
          !l.includes("╭") &&
          !l.includes("╰") &&
          !l.includes("│") &&
          !l.includes("├") &&
          !l.includes("┤"),
      ),
      lines.join(" | "),
    );
    // Title is the first line, hint is the last line.
    assert.ok(lines[0].includes("实现任务"), lines[0]);
    assert.ok(
      lines[lines.length - 1].includes("↑↓/jk scroll · esc/q close"),
      lines[lines.length - 1],
    );
  });

  it("renders the notice line when one is provided", () => {
    const deps = depsOf({ entries: [], notice: "(transcript unavailable)" });
    const component = createTranscriptOverlay(deps);
    const lines = renderComponent(component, 80);
    assert.ok(
      lines.some((l) => l.includes("(transcript unavailable)")),
      lines.join(" | "),
    );
    assert.ok(
      lines.some((l) => l.includes("esc/q close")),
      lines.join(" | "),
    );
  });

  it("renders a single 'empty transcript' explanation for an empty record list", () => {
    const deps = depsOf({ entries: [] });
    const component = createTranscriptOverlay(deps);
    const lines = renderComponent(component, 80);
    const explanation = lines.filter((l) => l.includes("(empty transcript)"));
    assert.equal(
      explanation.length,
      1,
      `expected one explanation: ${lines.join(" | ")}`,
    );
  });

  it("renders the full record set: thinking, native toolCall, and toolResult", () => {
    const deps = depsOf({
      tui: { requestRender: () => {}, terminal: { rows: 40 } },
      entries: [
        { type: "message", message: { role: "user", content: "u" } },
        {
          type: "message",
          message: {
            role: "assistant",
            content: [
              { type: "thinking", thinking: "thinking text" },
              { type: "text", text: "assistant text" },
              {
                type: "toolCall",
                id: "c1",
                name: "bash",
                arguments: { command: "npm test", cwd: "/a/b" },
              },
            ],
          },
        },
        {
          type: "message",
          message: {
            role: "toolResult",
            toolCallId: "c1",
            toolName: "bash",
            content: [{ type: "text", text: "line1\nline2 with `backtick`" }],
            isError: false,
          },
        },
      ],
    });
    const component = createTranscriptOverlay(deps);
    const lines = renderComponent(component, 120).map(stripAnsi);
    assert.ok(
      lines.some((l) => l.includes("thinking text")),
      lines.join(" | "),
    );
    assert.ok(
      lines.some((l) => l.includes("assistant text")),
      lines.join(" | "),
    );
    // The paired toolCall + toolResult renders through pi's native component
    // (the tool's own shell: `$ <command>`), not the structured fallback.
    assert.ok(
      lines.some((l) => l.includes("$ npm test")),
      lines.join(" | "),
    );
    assert.ok(
      !lines.some((l) => l.includes("→ bash")),
      `paired tool calls must render natively: ${lines.join(" | ")}`,
    );
    // toolResult → the tool renderer's output (backticks literal).
    assert.ok(
      lines.some((l) => l.includes("line1")),
      lines.join(" | "),
    );
    assert.ok(
      lines.some((l) => l.includes("line2 with `backtick`")),
      "toolResult stays literal text, not markdown",
    );
  });

  it("falls back to `→ <name>` + JSON arguments for an unpaired toolCall", () => {
    // An interrupted call (no toolResult in the transcript) has no native
    // renderer; the fallback keeps the tool name and the complete arguments
    // visible.
    const deps = depsOf({
      entries: [
        {
          type: "message",
          message: {
            role: "assistant",
            content: [
              {
                type: "toolCall",
                id: "c9",
                name: "unknown_tool",
                arguments: { query: "zoo", limit: 5 },
              },
            ],
          },
        },
      ],
    });
    const component = createTranscriptOverlay(deps);
    const lines = renderComponent(component, 120).map(stripAnsi);
    assert.ok(
      lines.some((l) => l.includes("→ unknown_tool")),
      lines.join(" | "),
    );
    assert.ok(
      lines.some((l) => l.includes('"query"') && l.includes('"zoo"')),
      lines.join(" | "),
    );
    assert.ok(
      lines.some((l) => l.includes("limit")),
      lines.join(" | "),
    );
  });

  it("renders an orphan toolResult as verbatim text", () => {
    const deps = depsOf({
      entries: [
        {
          type: "message",
          message: {
            role: "toolResult",
            toolCallId: "orphan-1",
            toolName: "bash",
            content: [{ type: "text", text: "orphan `literal` text" }],
            isError: false,
          },
        },
      ],
    });
    const component = createTranscriptOverlay(deps);
    const lines = renderComponent(component, 120).map(stripAnsi);
    assert.ok(
      lines.some((l) => l.includes("orphan `literal` text")),
      lines.join(" | "),
    );
  });

  it("styles markdown record content through pi's official markdown theme", () => {
    // The official AssistantMessageComponent renders markdown through pi's
    // built-in `getMarkdownTheme()` (the module theme singleton), so a
    // heading resolves through the mdHeading color — never through the stub
    // theme's `fg` calls (the stub theme only colors the overlay chrome).
    const fgCalls: Array<[string, string]> = [];
    const spyTheme: TranscriptThemeLike = {
      fg: (color, text) => {
        fgCalls.push([color, text]);
        return `<${color}>${text}</${color}>`;
      },
      bold: (text) => `<b>${text}</b>`,
      italic: (text) => `<i>${text}</i>`,
      underline: (text) => `<u>${text}</u>`,
      strikethrough: (text) => `<s>${text}</s>`,
    };
    const deps = depsOf({
      theme: spyTheme,
      entries: [
        {
          type: "message",
          message: {
            role: "assistant",
            content: [
              { type: "text", text: "# secret heading\n**secret body**" },
            ],
          },
        },
      ],
    });
    const component = createTranscriptOverlay(deps);
    // Keep the raw lines: the ANSI assertion below needs the sequences.
    const lines = renderComponent(component, 80);
    // The official dark theme's mdHeading is #f0c674 (240,198,116) and the
    // heading prefix is the bold-underline `#` marker, so the heading text
    // carries that truecolor — proof the markdown goes through pi's
    // official `getMarkdownTheme()`, never the stub theme.
    const heading = lines.find((l) => l.includes("secret heading"));
    assert.ok(heading, lines.join(" | "));
    assert.ok(
      heading.includes("\x1b[38;2;240;198;116m") &&
        heading.includes("secret heading"),
      `heading must resolve through pi's mdHeading truecolor: ${JSON.stringify(heading)}`,
    );
    // The stub theme never sees the record markdown (it only colors the
    // overlay chrome), so no record text resolves through its fg tags.
    assert.ok(
      !fgCalls.some(([, text]) => text.includes("secret")),
      `record markdown must not resolve through the stub theme: ${JSON.stringify(fgCalls)}`,
    );
  });
});

describe("createTranscriptOverlay — ScrollView scrolling", () => {
  const longEntries = Array.from({ length: 25 }, (_, i) => ({
    type: "message",
    message: { role: "user", content: `line${i}` },
  }));

  it("scrolls down with ↓/j and up with ↑/k within bounds", () => {
    const deps = depsOf({
      tui: { requestRender: () => {}, terminal: { rows: 12 } },
      entries: longEntries,
    });
    const component = createTranscriptOverlay(deps);
    // At offset 0 with the 12-row viewport, only the first lines are visible.
    let lines = renderComponent(component, 80);
    assert.ok(
      lines.some((l) => l.includes("line0")),
      "starts at the top",
    );
    assert.ok(
      !lines.some((l) => l.includes("line24")),
      "bottom not yet visible",
    );
    // ↓ advances the window.
    sendInput(component, "\u001b[B");
    lines = renderComponent(component, 80);
    assert.ok(
      lines.some((l) => l.includes("line1")),
      "↓ must advance the scroll window",
    );
    // Each user message renders a 3-row box (pad / text / pad), so 25
    // messages occupy ~75 rows; scroll far enough to reach the bottom, then
    // ↑ back up.
    for (let i = 0; i < 200; i++) sendInput(component, "j");
    lines = renderComponent(component, 80);
    assert.ok(
      lines.some((l) => l.includes("line24")),
      "bottom reachable",
    );
    // One ↑ only steps one row — the last box's rows stay visible; several
    // presses move the window up past it.
    for (let i = 0; i < 6; i++) sendInput(component, "k");
    lines = renderComponent(component, 80);
    assert.ok(!lines.some((l) => l.includes("line24")), "↑ scrolls back up");
  });

  it("clamps scrolling at the boundaries", () => {
    const deps = depsOf({
      entries: [
        { type: "message", message: { role: "user", content: "only" } },
      ],
    });
    const component = createTranscriptOverlay(deps);
    sendInput(component, "j");
    sendInput(component, "\u001b[B");
    const lines = renderComponent(component, 80);
    assert.ok(
      lines.some((l) => l.includes("only")),
      "clamped render",
    );
  });

  it("exposes scrollTop advancement through the official ScrollView", () => {
    const deps = depsOf({
      tui: { requestRender: () => {}, terminal: { rows: 12 } },
      entries: longEntries,
    });
    const component = createTranscriptOverlay(deps);
    renderComponent(component, 80);
    const scrollView = (
      component as {
        scrollView?: { scrollTop: number };
      }
    ).scrollView;
    assert.ok(scrollView, "the official ScrollView must be mounted");
    assert.equal(scrollView.scrollTop, 0, "starts at the top");
    sendInput(component, "j");
    assert.equal(scrollView.scrollTop, 1, "j scrolls by one line");
    sendInput(component, "\u001b[6~"); // PageDown
    assert.ok(scrollView.scrollTop > 1, "PageDown scrolls by a page");
    sendInput(component, "\u001b[5~"); // PageUp
    assert.ok(scrollView.scrollTop < 12, "PageUp scrolls back up");
  });

  it("scrolls by one line per SGR mouse-wheel notch", () => {
    // SGR wheel reports (`ESC [ < button ; col ; row M`, bit 64 set, low
    // bits 0 = up / 1 = down — the codes terminals emit under ?1006h).
    const deps = depsOf({
      tui: { requestRender: () => {}, terminal: { rows: 12 } },
      entries: longEntries,
    });
    const component = createTranscriptOverlay(deps);
    renderComponent(component, 80);
    const scrollView = (component as { scrollView: { scrollTop: number } })
      .scrollView;
    assert.equal(scrollView.scrollTop, 0, "starts at the top");
    sendInput(component, "\u001b[<65;10;5M"); // wheel down
    assert.equal(scrollView.scrollTop, 1, "wheel down scrolls one line");
    sendInput(component, "\u001b[<65;10;5M");
    assert.equal(scrollView.scrollTop, 2, "a second notch steps again");
    sendInput(component, "\u001b[<64;10;5M"); // wheel up
    assert.equal(scrollView.scrollTop, 1, "wheel up scrolls back one line");
  });

  it("ignores non-wheel mouse reports without breaking key handling", () => {
    let doneCalls = 0;
    const deps = depsOf({
      tui: { requestRender: () => {}, terminal: { rows: 12 } },
      entries: longEntries,
      done: () => {
        doneCalls += 1;
      },
    });
    const component = createTranscriptOverlay(deps);
    renderComponent(component, 80);
    const scrollView = (component as { scrollView: { scrollTop: number } })
      .scrollView;
    // A left-button press (bit 64 clear), a horizontal wheel (direction
    // bits 2), and a button release (trailing `m`) are not vertical wheel
    // events — none may scroll, close, or swallow later keys.
    sendInput(component, "\u001b[<0;10;5M");
    sendInput(component, "\u001b[<66;10;5M");
    sendInput(component, "\u001b[<0;10;5m");
    assert.equal(scrollView.scrollTop, 0, "non-wheel reports must not scroll");
    assert.equal(doneCalls, 0, "non-wheel reports must not close");
    sendInput(component, "j");
    assert.equal(scrollView.scrollTop, 1, "j still scrolls afterwards");
    sendInput(component, "\u001b");
    assert.equal(doneCalls, 1, "esc still closes afterwards");
  });

  it("keeps scrolling semantics at full screen (terminal-sized rows, no base leak)", () => {
    // Full-screen regression: at a large terminal the overlay fills the
    // screen and the scroll window is `rows - chrome`; ↑↓/jk must still
    // walk the transcript and every rendered row must stay full-width (no
    // base content shows through while scrolling).
    const deps = depsOf({
      tui: { requestRender: () => {}, terminal: { rows: 24 } },
      entries: longEntries,
    });
    const component = createTranscriptOverlay(deps);
    let lines = renderComponent(component, 80);
    assert.equal(lines.length, 24, "fills the terminal height");
    assert.ok(
      lines.some((l) => l.includes("line0")),
      "starts at the top",
    );
    assert.ok(
      !lines.some((l) => l.includes("line24")),
      "bottom not yet visible",
    );
    // Scroll to the bottom: 25 messages ≈ 75 body rows vs the 22-row
    // viewport, so repeated ↓ reaches line24.
    for (let i = 0; i < 200; i++) sendInput(component, "j");
    lines = renderComponent(component, 80);
    assert.equal(lines.length, 24, "still fills the terminal height");
    assert.ok(
      lines.some((l) => l.includes("line24")),
      "bottom reachable at full screen",
    );
    assert.ok(!lines.some((l) => l.includes("line0")), "top scrolled out");
    // Every row stays padded to the full width while scrolling.
    assert.ok(
      lines.every((l) => visibleWidth(l) === 80),
      lines.map((l) => `[${l}]`).join("\n"),
    );
    // ↑ walks back up.
    for (let i = 0; i < 6; i++) sendInput(component, "k");
    lines = renderComponent(component, 80);
    assert.ok(!lines.some((l) => l.includes("line24")), "↑ scrolls back up");
  });
});

describe("createTranscriptOverlay — close protocol", () => {
  it("closes (calls done) on esc and q, and ignores other keys", () => {
    let doneCalls = 0;
    const deps = depsOf({
      done: () => {
        doneCalls += 1;
      },
    });
    const component = createTranscriptOverlay(deps) as {
      handleInput(data: string): void;
    };
    component.handleInput("x"); // ignored
    assert.equal(doneCalls, 0, "unmatched keys must not close");
    component.handleInput("\u001b");
    assert.equal(doneCalls, 1, "esc must close");
    component.handleInput("q");
    assert.equal(doneCalls, 2, "q must close");
  });
});

describe("createTranscriptOverlay — live event-driven appends", () => {
  it("appends a live message_end record to the body as it arrives", () => {
    const component = createTranscriptOverlay(
      depsOf({
        childSession: "child-1",
        entries: [{ type: "message", message: userMessage("first") }],
      }),
    );
    let lines = renderComponent(component, 120).map(stripTags);
    assert.ok(
      lines.some((l) => l.includes("first")),
      `initial history renders: ${lines.join(" | ")}`,
    );
    assert.ok(
      !lines.some((l) => l.includes("second")),
      "second not yet appended",
    );
    // A live message_end arrives on the bus — the record appends without
    // any polling or file re-read.
    emitTranscriptEvent("child-1", {
      type: "message_end",
      message: userMessage("second"),
    });
    lines = renderComponent(component, 120).map(stripTags);
    assert.ok(
      lines.some((l) => l.includes("second")),
      `the live message must render: ${lines.join(" | ")}`,
    );
  });

  it("pairs a live toolResult with a replayed toolCall through the native component", () => {
    // A run opened mid-flight: the file replay holds the assistant toolCall
    // (unpaired at replay time), then the live toolResult message arrives —
    // the rebuild must pair them through the native component.
    const component = createTranscriptOverlay(
      depsOf({
        childSession: "child-1",
        tui: { requestRender: () => {}, terminal: { rows: 40 } },
        entries: [
          {
            type: "message",
            message: {
              role: "assistant",
              content: [
                {
                  type: "toolCall",
                  id: "c1",
                  name: "bash",
                  arguments: { command: "npm test", cwd: "/a/b" },
                },
              ],
            },
          },
        ],
      }),
    );
    // At replay time the call is unpaired → the structured fallback.
    let lines = renderComponent(component, 120).map(stripAnsi);
    assert.ok(
      lines.some((l) => l.includes("→ bash")),
      `precondition: unpaired call renders the fallback: ${lines.join(" | ")}`,
    );
    emitTranscriptEvent("child-1", {
      type: "message_end",
      message: {
        role: "toolResult",
        toolCallId: "c1",
        toolName: "bash",
        content: [
          {
            type: "text",
            text: "line1\nline2\nline3\nline4\nline5\nline6\nline7\nline8",
          },
        ],
        isError: false,
      },
    });
    lines = renderComponent(component, 120).map(stripAnsi);
    assert.ok(
      lines.some((l) => l.includes("$ npm test")),
      `paired call must render natively: ${lines.join(" | ")}`,
    );
    assert.ok(
      !lines.some((l) => l.includes("→ bash")),
      `the fallback must be replaced by the native render: ${lines.join(" | ")}`,
    );
    assert.ok(
      lines.some((l) => l.includes("line8")),
      `the live result tail renders: ${lines.join(" | ")}`,
    );
  });

  it("does not duplicate a live event already in the replayed history", () => {
    // The driver forwards every message_end; a run opened mid-flight whose
    // file already holds the message would otherwise double-render.  The
    // fingerprint dedup must skip it.
    const component = createTranscriptOverlay(
      depsOf({
        childSession: "child-1",
        entries: [
          { type: "message", message: userMessage("u1") },
          { type: "message", message: assistantMessage("a1") },
        ],
      }),
    );
    const before = renderComponent(component, 120).map(stripTags);
    // The same messages re-arrive as live events (already persisted).
    emitTranscriptEvent("child-1", {
      type: "message_end",
      message: userMessage("u1"),
    });
    emitTranscriptEvent("child-1", {
      type: "message_end",
      message: assistantMessage("a1"),
    });
    const after = renderComponent(component, 120).map(stripTags);
    assert.equal(
      after.join("|"),
      before.join("|"),
      "replayed content must not duplicate",
    );
  });

  it("keeps a new live message distinct from the replayed history", () => {
    const component = createTranscriptOverlay(
      depsOf({
        childSession: "child-1",
        entries: [{ type: "message", message: userMessage("u1") }],
      }),
    );
    emitTranscriptEvent("child-1", {
      type: "message_end",
      message: userMessage("u2"),
    });
    const lines = renderComponent(component, 120).map(stripTags);
    assert.ok(
      lines.some((l) => l.includes("u1")) &&
        lines.some((l) => l.includes("u2")),
      `both records must render: ${lines.join(" | ")}`,
    );
  });

  it("sticks to the bottom when the view was following the end", () => {
    // Many records so the body outgrows the viewport; a tiny terminal
    // forces scrolling.  When glued to the end, a live append reveals the
    // new tail.
    const component = createTranscriptOverlay(
      depsOf({
        childSession: "child-1",
        tui: { requestRender: () => {}, terminal: { rows: 12 } },
        entries: Array.from({ length: 20 }, (_, i) => ({
          type: "message",
          message: userMessage(`row${i}`),
        })),
      }),
    );
    // First render syncs the ScrollView's layout (contentHeight), then
    // jump to the end: the last content becomes visible.
    renderComponent(component, 120);
    sendInput(component, "\u001bOF"); // End
    let lines = renderComponent(component, 120).map(stripTags);
    assert.ok(
      lines.some((l) => l.includes("row19")),
      `precondition: bottom visible at start: ${lines.join(" | ")}`,
    );
    // A live append must keep the view glued to the bottom (the new tail
    // becomes visible).
    emitTranscriptEvent("child-1", {
      type: "message_end",
      message: userMessage("row20"),
    });
    lines = renderComponent(component, 120).map(stripTags);
    assert.ok(
      lines.some((l) => l.includes("row20")),
      `following the end must reveal the new tail: ${lines.join(" | ")}`,
    );
  });

  it("keeps a non-bottom offset stable when content grows", () => {
    const component = createTranscriptOverlay(
      depsOf({
        childSession: "child-1",
        tui: { requestRender: () => {}, terminal: { rows: 12 } },
        entries: Array.from({ length: 20 }, (_, i) => ({
          type: "message",
          message: userMessage(`row${i}`),
        })),
      }),
    );
    // First render syncs the ScrollView's layout (contentHeight), then
    // scroll down a few lines, but not to the bottom.
    renderComponent(component, 120);
    for (let i = 0; i < 4; i++) sendInput(component, "j");
    const before = renderComponent(component, 120).map(stripTags);
    assert.ok(
      before.some((l) => l.includes("row1")),
      `precondition: mid scroll: ${before.join(" | ")}`,
    );
    const scrollTop = (component as { scrollView: { scrollTop: number } })
      .scrollView.scrollTop;
    assert.ok(scrollTop > 0, "the view is scrolled off the top");

    emitTranscriptEvent("child-1", {
      type: "message_end",
      message: userMessage("row20"),
    });
    const after = renderComponent(component, 120).map(stripTags);
    assert.ok(
      after.some((l) => l.includes("row1")),
      `the old offset content stays visible: ${after.join(" | ")}`,
    );
    assert.equal(
      (component as { scrollView: { scrollTop: number } }).scrollView.scrollTop,
      scrollTop,
      "the scroll offset must be preserved when not following the end",
    );
  });

  it("renders nothing from non-record events and messages of other roles", () => {
    const component = createTranscriptOverlay(
      depsOf({
        childSession: "child-1",
        entries: [{ type: "message", message: userMessage("u1") }],
      }),
    );
    const before = renderComponent(component, 120).map(stripTags);
    // Lifecycle events carry no finalized record: the streaming events with
    // payload-less messages are dropped at the bus boundary, `turn_end` is
    // dropped, and a bare `agent_end` only closes a stream that is not open
    // here — none may alter the body.
    emitTranscriptEvent("child-1", { type: "message_start", message: {} });
    emitTranscriptEvent("child-1", { type: "message_update", message: {} });
    emitTranscriptEvent("child-1", { type: "agent_end", messages: [] });
    emitTranscriptEvent("child-1", {
      type: "turn_end",
      message: {},
      toolResults: [],
    });
    // Non-render message roles.
    emitTranscriptEvent("child-1", {
      type: "message_end",
      message: { role: "custom", customType: "x", content: [] },
    });
    const after = renderComponent(component, 120).map(stripTags);
    assert.equal(
      after.join("|"),
      before.join("|"),
      "non-render events must not alter the body",
    );
  });

  it("appends every non-serializable live message (no empty-fingerprint collision)", () => {
    // A message whose JSON serialization fails (e.g. a circular reference)
    // fingerprints as "".  Two such messages must both append — deduping
    // them on the shared "" key would silently drop the second.
    const component = createTranscriptOverlay(
      depsOf({
        childSession: "child-1",
        entries: [],
      }),
    );
    const nonSerializable = (text: string): unknown => {
      const message = {
        role: "user",
        content: [{ type: "text", text }],
      };
      (message as Record<string, unknown>).self = message; // circular
      return message;
    };
    emitTranscriptEvent("child-1", {
      type: "message_end",
      message: nonSerializable("ns1"),
    });
    emitTranscriptEvent("child-1", {
      type: "message_end",
      message: nonSerializable("ns2"),
    });
    const lines = renderComponent(component, 120).map(stripTags);
    assert.ok(
      lines.some((l) => l.includes("ns1")) &&
        lines.some((l) => l.includes("ns2")),
      `both non-serializable messages must render: ${lines.join(" | ")}`,
    );
  });

  it("does not subscribe when no childSession is wired (historical run)", () => {
    // A historical / terminal run has no childSession → the overlay renders
    // the final file once; live bus emissions are ignored entirely.
    const component = createTranscriptOverlay(
      depsOf({
        entries: [{ type: "message", message: userMessage("u1") }],
      }),
    );
    const before = renderComponent(component, 120).map(stripTags);
    emitTranscriptEvent("child-1", {
      type: "message_end",
      message: userMessage("live-ignored"),
    });
    const after = renderComponent(component, 120).map(stripTags);
    assert.equal(
      after.join("|"),
      before.join("|"),
      "a historical overlay must stay static",
    );
    assert.ok(
      !after.some((l) => l.includes("live-ignored")),
      `the live message must not render: ${after.join(" | ")}`,
    );
  });

  it("drops the live subscription when the overlay closes", () => {
    const component = createTranscriptOverlay(
      depsOf({
        childSession: "child-1",
        entries: [{ type: "message", message: userMessage("u1") }],
      }),
    );
    sendInput(component, "\u001b"); // close
    emitTranscriptEvent("child-1", {
      type: "message_end",
      message: userMessage("after-close"),
    });
    const lines = renderComponent(component, 120).map(stripTags);
    assert.ok(
      !lines.some((l) => l.includes("after-close")),
      `post-close events must not render: ${lines.join(" | ")}`,
    );
  });

  it("drops the live subscription on dispose", () => {
    const component = createTranscriptOverlay(
      depsOf({
        childSession: "child-1",
        entries: [{ type: "message", message: userMessage("u1") }],
      }),
    ) as { dispose(): void };
    component.dispose();
    emitTranscriptEvent("child-1", {
      type: "message_end",
      message: userMessage("after-dispose"),
    });
    const lines = renderComponent(component, 120).map(stripTags);
    assert.ok(
      !lines.some((l) => l.includes("after-dispose")),
      `post-dispose events must not render: ${lines.join(" | ")}`,
    );
  });

  it("recovers from an 'unavailable' notice when live messages arrive (mid-flight open)", () => {
    // A run opened mid-flight before pi created the session file renders the
    // "(transcript unavailable)" notice; a live append proves the stream is
    // flowing and must replace the notice with the live content.
    const component = createTranscriptOverlay(
      depsOf({
        childSession: "child-1",
        notice: "(transcript unavailable)",
        entries: [],
      }),
    );
    let lines = renderComponent(component, 120).map(stripTags);
    assert.ok(
      lines.some((l) => l.includes("(transcript unavailable)")),
      `precondition: unavailable notice: ${lines.join(" | ")}`,
    );
    emitTranscriptEvent("child-1", {
      type: "message_end",
      message: userMessage("live first"),
    });
    lines = renderComponent(component, 120).map(stripTags);
    assert.ok(
      !lines.some((l) => l.includes("(transcript unavailable)")),
      `the notice must clear: ${lines.join(" | ")}`,
    );
    assert.ok(
      lines.some((l) => l.includes("live first")),
      `the live content must render: ${lines.join(" | ")}`,
    );
  });

  it("keeps the ctrl+o expanded state across a live append", () => {
    // A paired toolCall + toolResult through the native component: expand,
    // then a live append triggers a rebuild — the expanded state must
    // survive.
    const entries: PiHistoryEntry[] = [
      {
        type: "message",
        message: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "c1",
              name: "bash",
              arguments: { command: "npm test", cwd: "/a/b" },
            },
          ],
        },
      },
      {
        type: "message",
        message: {
          role: "toolResult",
          toolCallId: "c1",
          toolName: "bash",
          content: [
            {
              type: "text",
              text: "line1\nline2\nline3\nline4\nline5\nline6\nline7\nline8",
            },
          ],
          isError: false,
        },
      },
    ];
    const component = createTranscriptOverlay(
      depsOf({
        childSession: "child-1",
        tui: { requestRender: () => {}, terminal: { rows: 40 } },
        entries,
      }),
    );
    let lines = renderComponent(component, 100).map(stripAnsi);
    assert.ok(
      lines.some((l) => l.includes("earlier lines")),
      `precondition: collapsed fold hint: ${lines.join(" | ")}`,
    );
    // Expand, then a live append rebuilds the body — the expanded state
    // must not reset.
    sendInput(component, "\u000f");
    lines = renderComponent(component, 100).map(stripAnsi);
    assert.ok(
      lines.some((l) => l.includes("line1")),
      `precondition: expanded shows the head: ${lines.join(" | ")}`,
    );
    emitTranscriptEvent("child-1", {
      type: "message_end",
      message: assistantMessage("live tail"),
    });
    lines = renderComponent(component, 100).map(stripAnsi);
    assert.ok(
      lines.some((l) => l.includes("line1")),
      `expanded state must survive the append: ${lines.join(" | ")}`,
    );
    assert.ok(
      !lines.some((l) => l.includes("earlier lines")),
      `still expanded: no fold hint: ${lines.join(" | ")}`,
    );
    assert.ok(
      lines.some((l) => l.includes("live tail")),
      `the appended message must render: ${lines.join(" | ")}`,
    );
  });
});

describe("createTranscriptOverlay — token-level streaming", () => {
  /** A pi-shaped partial assistant message (mid-stream content). */
  const partialText = (text: string): unknown => ({
    role: "assistant",
    content: [{ type: "text", text }],
  });

  /** A pi-shaped streaming open (empty partial, as the provider start). */
  const assistantStart = (): unknown => ({
    role: "assistant",
    content: [],
  });

  /** Count rendered lines containing a token (ANSI stripped). */
  const countLines = (lines: string[], token: string): number =>
    lines.filter((l) => l.includes(token)).length;

  it("renders assistant text incrementally as updates arrive before message_end", () => {
    const component = createTranscriptOverlay(
      depsOf({
        childSession: "child-1",
        tui: { requestRender: () => {}, terminal: { rows: 24 } },
        entries: [{ type: "message", message: userMessage("u1") }],
      }),
    );
    emitTranscriptEvent("child-1", {
      type: "message_start",
      message: assistantStart(),
    });
    emitTranscriptEvent("child-1", {
      type: "message_update",
      message: partialText("alpha"),
    });
    let lines = renderComponent(component, 120).map(stripAnsi);
    assert.ok(
      lines.some((l) => l.includes("alpha")),
      `the first partial renders before message_end: ${lines.join(" | ")}`,
    );
    assert.ok(
      !lines.some((l) => l.includes("beta")),
      "not-yet-streamed text stays invisible",
    );
    // The stream grows: the same live surface shows the longer text.
    emitTranscriptEvent("child-1", {
      type: "message_update",
      message: partialText("alpha beta"),
    });
    lines = renderComponent(component, 120).map(stripAnsi);
    assert.ok(
      lines.some((l) => l.includes("beta")),
      `the grown partial renders: ${lines.join(" | ")}`,
    );
    // Finalization replaces the streaming surface with the record — exactly
    // one rendering of the text (a per-delta append would duplicate).
    emitTranscriptEvent("child-1", {
      type: "message_end",
      message: assistantMessage("alpha beta"),
    });
    lines = renderComponent(component, 120).map(stripAnsi);
    assert.equal(
      countLines(lines, "beta"),
      1,
      `finalize must not duplicate the streamed text: ${lines.join(" | ")}`,
    );
  });

  it("renders streamed thinking incrementally", () => {
    const component = createTranscriptOverlay(
      depsOf({
        childSession: "child-1",
        tui: { requestRender: () => {}, terminal: { rows: 24 } },
        entries: [{ type: "message", message: userMessage("u1") }],
      }),
    );
    emitTranscriptEvent("child-1", {
      type: "message_start",
      message: assistantStart(),
    });
    emitTranscriptEvent("child-1", {
      type: "message_update",
      message: {
        role: "assistant",
        content: [{ type: "thinking", thinking: "pondering" }],
      },
    });
    const lines = renderComponent(component, 120).map(stripAnsi);
    assert.ok(
      lines.some((l) => l.includes("pondering")),
      `thinking streams like text: ${lines.join(" | ")}`,
    );
  });

  it("renders deltas even when the overlay subscribed after message_start", () => {
    // A run opened mid-stream: the overlay never saw the `message_start`,
    // the first `message_update` must mount the streaming surface itself.
    const component = createTranscriptOverlay(
      depsOf({
        childSession: "child-1",
        tui: { requestRender: () => {}, terminal: { rows: 24 } },
        entries: [{ type: "message", message: userMessage("u1") }],
      }),
    );
    emitTranscriptEvent("child-1", {
      type: "message_update",
      message: partialText("late join tail"),
    });
    const lines = renderComponent(component, 120).map(stripAnsi);
    assert.ok(
      lines.some((l) => l.includes("late join tail")),
      `the first seen delta renders: ${lines.join(" | ")}`,
    );
  });

  it("finalizes a streamed message into the replay-path rendering", () => {
    // The finalized record must render identically to the same message
    // arriving through the initial file replay — the streaming surface is
    // discarded, the record path owns the final frame.
    const user = { type: "message", message: userMessage("u1") };
    const final = {
      type: "message",
      message: assistantMessage("streamed final text"),
    };
    const streamed = createTranscriptOverlay(
      depsOf({
        childSession: "child-stream",
        tui: { requestRender: () => {}, terminal: { rows: 24 } },
        entries: [user],
      }),
    );
    emitTranscriptEvent("child-stream", {
      type: "message_start",
      message: assistantStart(),
    });
    emitTranscriptEvent("child-stream", {
      type: "message_update",
      message: partialText("streamed"),
    });
    emitTranscriptEvent("child-stream", {
      type: "message_end",
      message: final.message,
    });
    const replayed = createTranscriptOverlay(
      depsOf({
        tui: { requestRender: () => {}, terminal: { rows: 24 } },
        entries: [user, final],
      }),
    );
    assert.equal(
      renderComponent(streamed, 120).join("|"),
      renderComponent(replayed, 120).join("|"),
      "the finalized rendering must equal the replay rendering",
    );
  });

  it("discards the streaming surface without duplicating when message_end matches replayed history", () => {
    // A run opened mid-flight replays a message that is still streaming;
    // the live `message_end` fingerprint-matches the replayed record, so
    // finalize appends nothing — the streaming surface must be removed.
    const component = createTranscriptOverlay(
      depsOf({
        childSession: "child-1",
        tui: { requestRender: () => {}, terminal: { rows: 24 } },
        entries: [{ type: "message", message: assistantMessage("dup check") }],
      }),
    );
    const before = renderComponent(component, 120);
    emitTranscriptEvent("child-1", {
      type: "message_start",
      message: assistantStart(),
    });
    emitTranscriptEvent("child-1", {
      type: "message_update",
      message: partialText("dup"),
    });
    emitTranscriptEvent("child-1", {
      type: "message_end",
      message: assistantMessage("dup check"),
    });
    const after = renderComponent(component, 120);
    assert.equal(
      after.join("|"),
      before.join("|"),
      `deduped finalize must leave no streaming residue: ${after
        .map(stripAnsi)
        .join(" | ")}`,
    );
  });

  it("keeps the end-glued view glued while streaming", () => {
    const component = createTranscriptOverlay(
      depsOf({
        childSession: "child-1",
        tui: { requestRender: () => {}, terminal: { rows: 12 } },
        entries: Array.from({ length: 20 }, (_, i) => ({
          type: "message",
          message: userMessage(`row${i}`),
        })),
      }),
    );
    renderComponent(component, 120);
    sendInput(component, "\u001bOF"); // End — glue the view to the tail.
    emitTranscriptEvent("child-1", {
      type: "message_start",
      message: assistantStart(),
    });
    emitTranscriptEvent("child-1", {
      type: "message_update",
      message: partialText("glue"),
    });
    emitTranscriptEvent("child-1", {
      type: "message_update",
      message: partialText("glue grows with every streamed delta"),
    });
    const lines = renderComponent(component, 120).map(stripAnsi);
    assert.ok(
      lines.some((l) => l.includes("delta")),
      `a glued view follows the streaming tail: ${lines.join(" | ")}`,
    );
  });

  it("preserves a non-glued offset while streaming", () => {
    const component = createTranscriptOverlay(
      depsOf({
        childSession: "child-1",
        tui: { requestRender: () => {}, terminal: { rows: 12 } },
        entries: Array.from({ length: 20 }, (_, i) => ({
          type: "message",
          message: userMessage(`row${i}`),
        })),
      }),
    );
    renderComponent(component, 120);
    for (let i = 0; i < 4; i++) sendInput(component, "j");
    const scrollTop = (component as { scrollView: { scrollTop: number } })
      .scrollView.scrollTop;
    assert.ok(scrollTop > 0, "the view is scrolled off the top");
    emitTranscriptEvent("child-1", {
      type: "message_start",
      message: assistantStart(),
    });
    for (const text of [
      "growing",
      "growing content",
      "growing content down here",
    ]) {
      emitTranscriptEvent("child-1", {
        type: "message_update",
        message: partialText(text),
      });
    }
    const after = renderComponent(component, 120).map(stripAnsi);
    assert.equal(
      (component as { scrollView: { scrollTop: number } }).scrollView.scrollTop,
      scrollTop,
      "streaming growth must not move a non-glued view",
    );
    assert.ok(
      after.some((l) => l.includes("row1")),
      `the old offset content stays visible: ${after.join(" | ")}`,
    );
  });

  it("drops everything mid-stream when the overlay closes", () => {
    let doneCalls = 0;
    const component = createTranscriptOverlay(
      depsOf({
        childSession: "child-1",
        tui: { requestRender: () => {}, terminal: { rows: 24 } },
        entries: [{ type: "message", message: userMessage("u1") }],
        done: () => {
          doneCalls += 1;
        },
      }),
    );
    emitTranscriptEvent("child-1", {
      type: "message_start",
      message: assistantStart(),
    });
    emitTranscriptEvent("child-1", {
      type: "message_update",
      message: partialText("mid stream"),
    });
    sendInput(component, "\u001b"); // close while the stream is open
    assert.equal(doneCalls, 1);
    // Post-close events (further deltas, the eventual finalize) are ignored:
    // the subscription is gone, nothing appends or throws.
    emitTranscriptEvent("child-1", {
      type: "message_update",
      message: partialText("closed tail"),
    });
    emitTranscriptEvent("child-1", {
      type: "message_end",
      message: assistantMessage("closed tail"),
    });
    const lines = renderComponent(component, 120).map(stripAnsi);
    assert.ok(
      !lines.some((l) => l.includes("closed tail")),
      `post-close events must not render: ${lines.join(" | ")}`,
    );
  });

  it("scrolls with the mouse wheel while a stream is live", () => {
    // Wheel bytes arriving mid-stream must scroll the view and must not
    // disturb the streaming surface (the stream keeps rendering afterwards).
    const component = createTranscriptOverlay(
      depsOf({
        childSession: "child-1",
        tui: { requestRender: () => {}, terminal: { rows: 12 } },
        entries: Array.from({ length: 20 }, (_, i) => ({
          type: "message",
          message: userMessage(`row${i}`),
        })),
      }),
    );
    renderComponent(component, 120);
    emitTranscriptEvent("child-1", {
      type: "message_start",
      message: assistantStart(),
    });
    emitTranscriptEvent("child-1", {
      type: "message_update",
      message: partialText("streaming while the user scrolls"),
    });
    const scrollView = (component as { scrollView: { scrollTop: number } })
      .scrollView;
    assert.equal(scrollView.scrollTop, 0, "a top-aligned view stays at top");
    sendInput(component, "\u001b[<65;10;5M"); // wheel down
    assert.equal(
      scrollView.scrollTop,
      1,
      "the wheel scrolls one line while streaming",
    );
    // A further delta must not move the wheel-scrolled (non-glued) view...
    emitTranscriptEvent("child-1", {
      type: "message_update",
      message: partialText("streaming while the user scrolls further along"),
    });
    assert.equal(
      scrollView.scrollTop,
      1,
      "a delta must not move the wheel-scrolled view",
    );
    // ...and the streaming tail is still there: jumping to the end shows it.
    sendInput(component, "\u001bOF"); // End — reach the streaming surface.
    const lines = renderComponent(component, 120).map(stripAnsi);
    assert.ok(
      lines.some((l) => l.includes("scrolls further along")),
      `the stream keeps rendering: ${lines.join(" | ")}`,
    );
  });
});

describe("createTranscriptOverlay — live tool activity", () => {
  /** A pi-shaped assistant message ending in a bash toolCall. */
  const assistantWithCall = (
    id: string,
    command: string,
    text = "running the suite",
  ): unknown => ({
    role: "assistant",
    content: [
      { type: "text", text },
      { type: "toolCall", id, name: "bash", arguments: { command } },
    ],
    stopReason: "tool_use",
  });

  /** A pi-shaped toolResult message for a bash call. */
  const toolResultMessage = (id: string, text: string): unknown => ({
    role: "toolResult",
    toolCallId: id,
    toolName: "bash",
    content: [{ type: "text", text }],
    isError: false,
  });

  /** Count rendered lines containing a token (ANSI stripped). */
  const countLines = (lines: string[], token: string): number =>
    lines.filter((l) => l.includes(token)).length;

  it("mounts a native tool component on tool_execution_start, visible before any message_end", () => {
    const component = createTranscriptOverlay(
      depsOf({
        childSession: "child-1",
        tui: { requestRender: () => {}, terminal: { rows: 40 } },
        entries: [{ type: "message", message: userMessage("u1") }],
      }),
    );
    let lines = renderComponent(component, 120).map(stripAnsi);
    assert.ok(
      !lines.some((l) => l.includes("$ npm test")),
      "no tool activity yet",
    );
    // The live bus delivers the tool_execution_start bookend (narrowed to
    // its host-neutral duck shape) — the overlay mounts the native pending
    // component immediately, before any message_end triggers a rebuild.
    emitTranscriptEvent("child-1", {
      type: "tool_execution_start",
      toolCallId: "c1",
      toolName: "bash",
      args: { command: "npm test" },
    });
    lines = renderComponent(component, 120).map(stripAnsi);
    assert.ok(
      lines.some((l) => l.includes("$ npm test")),
      `the live tool must render before any message_end: ${lines.join(" | ")}`,
    );
  });

  it("replaces an unpaired-call fallback with the live tool component", () => {
    // pi's real order: the assistant message_end (recording the toolCall)
    // precedes tool_execution_start.  The finalize rebuild renders the
    // unpaired call as the `→ bash` fallback; the live mount then removes
    // that fallback so the call is never rendered twice.
    const component = createTranscriptOverlay(
      depsOf({
        childSession: "child-1",
        tui: { requestRender: () => {}, terminal: { rows: 40 } },
        entries: [{ type: "message", message: userMessage("u1") }],
      }),
    );
    emitTranscriptEvent("child-1", {
      type: "message_end",
      message: assistantWithCall("c1", "npm test"),
    });
    let lines = renderComponent(component, 120).map(stripAnsi);
    assert.ok(
      lines.some((l) => l.includes("→ bash")),
      `precondition: unpaired call renders the fallback: ${lines.join(" | ")}`,
    );
    emitTranscriptEvent("child-1", {
      type: "tool_execution_start",
      toolCallId: "c1",
      toolName: "bash",
      args: { command: "npm test" },
    });
    lines = renderComponent(component, 120).map(stripAnsi);
    assert.equal(
      countLines(lines, "$ npm test"),
      1,
      `the live native shell renders: ${lines.join(" | ")}`,
    );
    assert.ok(
      !lines.some((l) => l.includes("→ bash")),
      `the fallback must be replaced, not stacked: ${lines.join(" | ")}`,
    );
  });

  it("updates the live tool component with the result on tool_execution_end", () => {
    const component = createTranscriptOverlay(
      depsOf({
        childSession: "child-1",
        tui: { requestRender: () => {}, terminal: { rows: 40 } },
        entries: [{ type: "message", message: userMessage("u1") }],
      }),
    );
    emitTranscriptEvent("child-1", {
      type: "tool_execution_start",
      toolCallId: "c1",
      toolName: "bash",
      args: { command: "npm test" },
    });
    // The tool finishes — pi emits tool_execution_end BEFORE the
    // toolResult-role message_end.  The result renders live from the
    // bookend, without waiting for the record finalize.
    emitTranscriptEvent("child-1", {
      type: "tool_execution_end",
      toolCallId: "c1",
      toolName: "bash",
      result: { content: [{ type: "text", text: "live result tail" }] },
      isError: false,
    });
    const lines = renderComponent(component, 120).map(stripAnsi);
    assert.ok(
      lines.some((l) => l.includes("live result tail")),
      `the result must render before the toolResult record: ${lines.join(" | ")}`,
    );
  });

  it("ignores a tool_execution_end whose component the rebuild already dropped", () => {
    const component = createTranscriptOverlay(
      depsOf({
        childSession: "child-1",
        tui: { requestRender: () => {}, terminal: { rows: 40 } },
        entries: [{ type: "message", message: userMessage("u1") }],
      }),
    );
    emitTranscriptEvent("child-1", {
      type: "tool_execution_end",
      toolCallId: "never-started",
      toolName: "bash",
      result: { content: [{ type: "text", text: "late output" }] },
      isError: false,
    });
    const lines = renderComponent(component, 120).map(stripAnsi);
    assert.ok(
      !lines.some((l) => l.includes("late output")),
      `an end without a mounted start is inert: ${lines.join(" | ")}`,
    );
  });

  it("drops the live component when its result enters the records, leaving no duplicate", () => {
    // Full pi ordering for one tool call: assistant finalize (fallback) →
    // start (live native replaces it) → end (live result) → toolResult
    // finalize (records pair the call natively — the live twin is dropped).
    const component = createTranscriptOverlay(
      depsOf({
        childSession: "child-1",
        tui: { requestRender: () => {}, terminal: { rows: 40 } },
        entries: [{ type: "message", message: userMessage("u1") }],
      }),
    );
    emitTranscriptEvent("child-1", {
      type: "message_end",
      message: assistantWithCall("c1", "npm test"),
    });
    emitTranscriptEvent("child-1", {
      type: "tool_execution_start",
      toolCallId: "c1",
      toolName: "bash",
      args: { command: "npm test" },
    });
    emitTranscriptEvent("child-1", {
      type: "tool_execution_end",
      toolCallId: "c1",
      toolName: "bash",
      result: { content: [{ type: "text", text: "suite passed" }] },
      isError: false,
    });
    emitTranscriptEvent("child-1", {
      type: "message_end",
      message: toolResultMessage("c1", "suite passed"),
    });
    const lines = renderComponent(component, 120).map(stripAnsi);
    assert.equal(
      countLines(lines, "$ npm test"),
      1,
      `exactly one native rendering after the rebuild: ${lines.join(" | ")}`,
    );
    assert.equal(
      countLines(lines, "suite passed"),
      1,
      `the result renders once: ${lines.join(" | ")}`,
    );
  });

  it("keeps a still-running tool visible across another tool's result rebuild", () => {
    // Parallel-mode order: both calls start, c1 finishes and its toolResult
    // record lands (rebuild) while c2 is still running — c2's live
    // component must survive the rebuild and stay a single rendering.
    const component = createTranscriptOverlay(
      depsOf({
        childSession: "child-1",
        tui: { requestRender: () => {}, terminal: { rows: 40 } },
        entries: [{ type: "message", message: userMessage("u1") }],
      }),
    );
    emitTranscriptEvent("child-1", {
      type: "message_end",
      message: {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "c1",
            name: "bash",
            arguments: { command: "cmd-one" },
          },
          {
            type: "toolCall",
            id: "c2",
            name: "bash",
            arguments: { command: "cmd-two" },
          },
        ],
        stopReason: "tool_use",
      },
    });
    emitTranscriptEvent("child-1", {
      type: "tool_execution_start",
      toolCallId: "c1",
      toolName: "bash",
      args: { command: "cmd-one" },
    });
    emitTranscriptEvent("child-1", {
      type: "tool_execution_start",
      toolCallId: "c2",
      toolName: "bash",
      args: { command: "cmd-two" },
    });
    let lines = renderComponent(component, 120).map(stripAnsi);
    assert.equal(countLines(lines, "$ cmd-one"), 1, lines.join(" | "));
    assert.equal(countLines(lines, "$ cmd-two"), 1, lines.join(" | "));
    emitTranscriptEvent("child-1", {
      type: "tool_execution_end",
      toolCallId: "c1",
      toolName: "bash",
      result: { content: [{ type: "text", text: "one done" }] },
      isError: false,
    });
    // c1's result is recorded → the rebuild pairs it natively; c2 is still
    // running and must stay visible exactly once (re-mounted at the tail).
    emitTranscriptEvent("child-1", {
      type: "message_end",
      message: toolResultMessage("c1", "one done"),
    });
    lines = renderComponent(component, 120).map(stripAnsi);
    assert.equal(
      countLines(lines, "$ cmd-one"),
      1,
      `recorded call renders once: ${lines.join(" | ")}`,
    );
    assert.equal(
      countLines(lines, "$ cmd-two"),
      1,
      `running call survives the rebuild: ${lines.join(" | ")}`,
    );
    // c2 finalizes too: everything comes from the records.
    emitTranscriptEvent("child-1", {
      type: "tool_execution_end",
      toolCallId: "c2",
      toolName: "bash",
      result: { content: [{ type: "text", text: "two done" }] },
      isError: false,
    });
    emitTranscriptEvent("child-1", {
      type: "message_end",
      message: toolResultMessage("c2", "two done"),
    });
    lines = renderComponent(component, 120).map(stripAnsi);
    assert.equal(countLines(lines, "$ cmd-one"), 1, lines.join(" | "));
    assert.equal(countLines(lines, "$ cmd-two"), 1, lines.join(" | "));
    assert.ok(
      !lines.some((l) => l.includes("→ bash")),
      `no fallback residue once both results are recorded: ${lines.join(" | ")}`,
    );
  });

  it("converges to the replay rendering after the tool cycle completes", () => {
    // The overlay's final static layout after the records cover the tool
    // call must be byte-identical to opening the same transcript as
    // historical replay — the live path is only a transient view.
    const assistant = assistantWithCall("c1", "npm test");
    const result = toolResultMessage("c1", "suite passed");
    const entries = [
      { type: "message", message: userMessage("u1") },
      { type: "message", message: assistant },
      { type: "message", message: result },
    ];
    const streamed = createTranscriptOverlay(
      depsOf({
        childSession: "child-stream-tools",
        tui: { requestRender: () => {}, terminal: { rows: 40 } },
        entries: [{ type: "message", message: userMessage("u1") }],
      }),
    );
    emitTranscriptEvent("child-stream-tools", {
      type: "message_start",
      message: { role: "assistant", content: [] },
    });
    emitTranscriptEvent("child-stream-tools", {
      type: "message_end",
      message: assistant,
    });
    emitTranscriptEvent("child-stream-tools", {
      type: "tool_execution_start",
      toolCallId: "c1",
      toolName: "bash",
      args: { command: "npm test" },
    });
    emitTranscriptEvent("child-stream-tools", {
      type: "tool_execution_end",
      toolCallId: "c1",
      toolName: "bash",
      result: { content: [{ type: "text", text: "suite passed" }] },
      isError: false,
    });
    emitTranscriptEvent("child-stream-tools", {
      type: "message_end",
      message: result,
    });
    const replayed = createTranscriptOverlay(
      depsOf({
        tui: { requestRender: () => {}, terminal: { rows: 40 } },
        entries,
      }),
    );
    assert.equal(
      renderComponent(streamed, 120).join("|"),
      renderComponent(replayed, 120).join("|"),
      "the post-rebuild live layout must equal the replay layout",
    );
  });

  it("agent_end drops a dangling streaming surface (aborted run)", () => {
    const component = createTranscriptOverlay(
      depsOf({
        childSession: "child-1",
        tui: { requestRender: () => {}, terminal: { rows: 40 } },
        entries: [{ type: "message", message: userMessage("u1") }],
      }),
    );
    const before = renderComponent(component, 120);
    emitTranscriptEvent("child-1", {
      type: "message_start",
      message: { role: "assistant", content: [] },
    });
    emitTranscriptEvent("child-1", {
      type: "message_update",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "frozen partial" }],
      },
    });
    let lines = renderComponent(component, 120).map(stripAnsi);
    assert.ok(
      lines.some((l) => l.includes("frozen partial")),
      `precondition: the partial streams: ${lines.join(" | ")}`,
    );
    // The run aborts before its final message_end — agent_end must drop
    // the frozen partial instead of leaving it on screen.
    emitTranscriptEvent("child-1", { type: "agent_end" });
    lines = renderComponent(component, 120);
    assert.ok(
      !lines.map(stripAnsi).some((l) => l.includes("frozen partial")),
      `the dangling surface must be gone: ${lines.map(stripAnsi).join(" | ")}`,
    );
    assert.equal(
      lines.join("|"),
      before.join("|"),
      "the render returns to the pre-stream state",
    );
  });

  it("carries the ctrl+o expansion onto live tool components", () => {
    const component = createTranscriptOverlay(
      depsOf({
        childSession: "child-1",
        tui: { requestRender: () => {}, terminal: { rows: 40 } },
        entries: [{ type: "message", message: userMessage("u1") }],
      }),
    );
    emitTranscriptEvent("child-1", {
      type: "tool_execution_start",
      toolCallId: "c1",
      toolName: "bash",
      args: { command: "npm test" },
    });
    // Expand while the live component is mounted (ctrl+o is only consumed
    // once a tool component exists in the body).
    sendInput(component, "\u000f");
    emitTranscriptEvent("child-1", {
      type: "tool_execution_end",
      toolCallId: "c1",
      toolName: "bash",
      result: {
        content: [
          {
            type: "text",
            text: "line1\nline2\nline3\nline4\nline5\nline6\nline7\nline8",
          },
        ],
      },
      isError: false,
    });
    const lines = renderComponent(component, 120).map(stripAnsi);
    assert.ok(
      lines.some((l) => l.includes("line1")),
      `the live component honours the expansion: ${lines.join(" | ")}`,
    );
    assert.ok(
      !lines.some((l) => l.includes("earlier lines")),
      `no fold hint while expanded: ${lines.join(" | ")}`,
    );
  });
});

describe("openTranscriptOverlay — open wiring", () => {
  it("returns false without a session path (no overlay possible)", () => {
    const opened = openTranscriptOverlay({
      sessionPath: "",
      title: "run",
      openOverlay: () => {
        throw new Error("must not be called");
      },
    });
    assert.equal(opened, false);
  });

  it("returns false without an openOverlay surface", () => {
    const opened = openTranscriptOverlay({
      sessionPath: "/tmp/run.jsonl",
      title: "run",
      openOverlay: undefined,
    });
    assert.equal(opened, false);
  });

  it("opens the overlay with an 'unavailable' notice when the file cannot be read", () => {
    let factory: unknown;
    const opened = openTranscriptOverlay({
      sessionPath: "/tmp/missing.jsonl",
      title: "run",
      readEntries: () => undefined, // unreadable file
      openOverlay: (factoryArg: unknown) => {
        factory = factoryArg;
        return Promise.resolve(undefined);
      },
    });
    assert.equal(opened, true, "an existing session path always opens");
    const component = (factory as (tui: unknown, theme: unknown) => unknown)(
      TUI,
      THEME,
    );
    const lines = renderComponent(component, 80);
    assert.ok(
      lines.some((l) => l.includes("(transcript unavailable)")),
      lines.join(" | "),
    );
  });

  it("opens the overlay rendering the full parsed transcript when readable", () => {
    let factory: unknown;
    const opened = openTranscriptOverlay({
      sessionPath: "/tmp/sessions/beaver-1.jsonl",
      title: "beaver · 实现任务",
      readEntries: () => [
        { type: "message", message: { role: "user", content: "u1" } },
        {
          type: "message",
          message: {
            role: "assistant",
            content: [
              {
                type: "toolCall",
                id: "c1",
                name: "bash",
                arguments: { command: "npm test" },
              },
              { type: "text", text: "a1" },
            ],
          },
        },
        {
          type: "message",
          message: {
            role: "toolResult",
            toolCallId: "c1",
            toolName: "bash",
            content: [{ type: "text", text: "result text" }],
            isError: false,
          },
        },
      ],
      openOverlay: (factoryArg: unknown) => {
        factory = factoryArg;
        return Promise.resolve(undefined);
      },
    });
    assert.equal(opened, true, "must open when the file is readable");
    assert.equal(typeof factory, "function", "a component factory is passed");
    const component = (factory as (tui: unknown, theme: unknown) => unknown)(
      TUI,
      THEME,
    );
    const lines = renderComponent(component, 120).map(stripAnsi);
    assert.ok(
      lines.some((l) => l.includes("u1")),
      lines.join(" | "),
    );
    // The paired toolCall + toolResult renders through the native shell
    // (`$ <command>`), not the structured `→ bash` fallback.
    assert.ok(
      lines.some((l) => l.includes("$ npm test")),
      lines.join(" | "),
    );
    assert.ok(!lines.some((l) => l.includes("→ bash")), lines.join(" | "));
    assert.ok(
      lines.some((l) => l.includes("a1")),
      lines.join(" | "),
    );
    assert.ok(
      lines.some((l) => l.includes("result text")),
      lines.join(" | "),
    );
  });

  it("wires a childSession so the overlay subscribes to the live bus", () => {
    let factory: unknown;
    const opened = openTranscriptOverlay({
      sessionPath: "/tmp/sessions/live.jsonl",
      title: "beaver · 实现任务",
      childSession: "child-live",
      readEntries: () => [
        { type: "message", message: { role: "user", content: "u1" } },
      ],
      openOverlay: (factoryArg: unknown) => {
        factory = factoryArg;
        return Promise.resolve(undefined);
      },
    });
    assert.equal(opened, true);
    const component = (factory as (tui: unknown, theme: unknown) => unknown)(
      TUI,
      THEME,
    );
    let lines = renderComponent(component, 120).map(stripTags);
    assert.ok(
      lines.some((l) => l.includes("u1")),
      `initial replay renders: ${lines.join(" | ")}`,
    );
    // Live events for the wired session flow in.
    emitTranscriptEvent("child-live", {
      type: "message_end",
      message: userMessage("live u2"),
    });
    lines = renderComponent(component, 120).map(stripTags);
    assert.ok(
      lines.some((l) => l.includes("live u2")),
      `the live message must render: ${lines.join(" | ")}`,
    );
  });

  it("parses the session file through the official parseSessionEntries", () => {
    // The default reader must go through pi's official `parseSessionEntries`
    // (message entries projected via `sessionEntryToContextMessages`), so a
    // raw JSONL transcript with a session header, user / assistant / tool
    // entries renders its messages.
    let factory: unknown;
    const opened = openTranscriptOverlay({
      sessionPath: "/tmp/sessions/official.jsonl",
      title: "beaver · 实现任务",
      readSessionFile: () =>
        [
          JSON.stringify({
            type: "session",
            version: 3,
            id: "ses-1",
            timestamp: "2026-08-31T00:00:00.000Z",
            cwd: "/tmp",
          }),
          JSON.stringify({
            type: "message",
            id: "m1",
            parentId: null,
            timestamp: "2026-08-31T00:00:00.000Z",
            message: { role: "user", content: "official u" },
          }),
          JSON.stringify({
            type: "message",
            id: "m2",
            parentId: null,
            timestamp: "2026-08-31T00:00:00.000Z",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "official a" }],
              stopReason: "end_turn",
            },
          }),
        ].join("\n"),
      openOverlay: (factoryArg: unknown) => {
        factory = factoryArg;
        return Promise.resolve(undefined);
      },
    });
    assert.equal(opened, true, "must open when the file is readable");
    const component = (factory as (tui: unknown, theme: unknown) => unknown)(
      TUI,
      THEME,
    );
    const lines = renderComponent(component, 120).map(stripAnsi);
    assert.ok(
      lines.some((l) => l.includes("official u")),
      lines.join(" | "),
    );
    assert.ok(
      lines.some((l) => l.includes("official a")),
      lines.join(" | "),
    );
  });
});
