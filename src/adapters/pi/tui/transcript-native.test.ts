/**
 * Tests for the transcript overlay's native tool rendering path.
 *
 * A separate file from `transcript.test.ts` on purpose: pi's native
 * `ToolExecutionComponent` renders through the module-level `theme` singleton
 * of `@earendil-works/pi-coding-agent`, which must be initialized with
 * `initTheme()` before construction.  Bun runs each test file in its own
 * worker process, so initializing the real theme here never leaks into the
 * fallback-path tests (`transcript.test.ts`), which must keep seeing an
 * uninitialized theme to exercise the structured fallback.
 *
 * The two scenarios the file covers (the pieces `transcript.test.ts` cannot,
 * because it never initializes the theme):
 *   - a paired tool_start + tool_end renders through the native component
 *     (the tool's own renderer, pi's exact shell: `$ <command>` for bash),
 *     not the structured `→ <name>` fallback;
 *   - `ctrl+o` (pi's `app.tools.expand` key) flips every native tool
 *     component between collapsed (bash fold preview + hint) and expanded
 *     (full output), and back.
 *
 * Assertions strip the real ANSI codes (the native renderers emit truecolor
 * sequences; the markdown records still go through the stub theme's
 * `<color>` tags, which are irrelevant to the tool-line assertions).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { createRunLog } from "../../../core/subagent/run-log.js";
import {
  createTranscriptOverlay,
  type TranscriptThemeLike,
} from "./transcript.js";

// pi's tool renderers need the module-level theme singleton; the built-in
// dark theme ships with the installed package and needs no configuration.
initTheme();

/** A theme stub for the markdown records (mirrors `transcript.test.ts`). */
const THEME: TranscriptThemeLike = {
  fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
  bold: (text: string) => `<b>${text}</b>`,
  italic: (text: string) => `<i>${text}</i>`,
  underline: (text: string) => `<u>${text}</u>`,
  strikethrough: (text: string) => `<s>${text}</s>`,
};

/** A stub TUI with a tall terminal so the whole body fits the viewport. */
const TUI = {
  requestRender: () => {},
  terminal: { rows: 40 },
};

/** Render an overlay's component tree to plain text lines. */
function renderComponent(component: unknown, width: number): string[] {
  return (component as { render(width: number): string[] }).render(width);
}

/** Drive one input through the overlay component. */
function sendInput(component: unknown, data: string): void {
  (component as { handleInput(data: string): void }).handleInput(data);
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

/** A bash tool call with 8 result lines (over bash's 5-line preview). */
function bashLog() {
  const log = createRunLog();
  log.appendToolStart("bash", { command: "npm test" }, 1, "c1");
  log.appendToolEnd(
    "bash",
    [
      {
        type: "text",
        text: "line1\nline2\nline3\nline4\nline5\nline6\nline7\nline8",
      },
    ],
    false,
    2,
    "c1",
  );
  return log;
}

/** Build the overlay over the bash facts. */
function bashOverlay(): unknown {
  return createTranscriptOverlay({
    title: "beaver · 实现任务",
    log: bashLog(),
    tui: TUI,
    theme: THEME,
    done: () => {},
  });
}

describe("createTranscriptOverlay — native tool rendering (theme initialized)", () => {
  it("renders a paired tool_start + tool_end through pi's native component", () => {
    const component = bashOverlay();
    const lines = renderComponent(component, 100).map(stripAnsi);

    // The native bash shell: `$ <command>` call line (pi's exact style).
    assert.ok(
      lines.some((l) => l.includes("$ npm test")),
      `native shell line expected: ${lines.join(" | ")}`,
    );
    // Not the structured fallback (`→ <name>` + JSON args code block).
    assert.ok(
      !lines.some((l) => l.includes("→ bash")),
      `structured fallback must not render: ${lines.join(" | ")}`,
    );
    // The result text renders through the tool's renderResult (collapsed
    // shows the preview tail; the last line is always visible).
    assert.ok(
      lines.some((l) => l.includes("line8")),
      `result tail must render: ${lines.join(" | ")}`,
    );
  });

  it("toggles every native tool component with ctrl+o (expand → collapse)", () => {
    const component = bashOverlay();
    let lines = renderComponent(component, 100).map(stripAnsi);

    // Collapsed: fold preview (bash truncates to its 5-line preview) —
    // "earlier lines" hint present, head lines folded away.
    assert.ok(
      lines.some((l) => l.includes("earlier lines")),
      `collapsed fold hint expected: ${lines.join(" | ")}`,
    );
    assert.ok(
      lines.some((l) => l.includes("line8")),
      lines.join(" | "),
    );
    assert.ok(
      !lines.some((l) => l.includes("line1")),
      `folded head must be hidden: ${lines.join(" | ")}`,
    );

    // ctrl+o (0x0f) → expanded: full output, fold hint gone.
    sendInput(component, "\u000f");
    lines = renderComponent(component, 100).map(stripAnsi);
    assert.ok(
      lines.some((l) => l.includes("line1")),
      `expanded must show the head: ${lines.join(" | ")}`,
    );
    assert.ok(
      lines.some((l) => l.includes("line8")),
      lines.join(" | "),
    );
    assert.ok(
      !lines.some((l) => l.includes("earlier lines")),
      `expanded fold hint must be gone: ${lines.join(" | ")}`,
    );

    // ctrl+o again → collapsed again.
    sendInput(component, "\u000f");
    lines = renderComponent(component, 100).map(stripAnsi);
    assert.ok(
      lines.some((l) => l.includes("earlier lines")),
      `second ctrl+o must collapse again: ${lines.join(" | ")}`,
    );
    assert.ok(
      !lines.some((l) => l.includes("line1")),
      `collapsed head hidden again: ${lines.join(" | ")}`,
    );
  });
});
