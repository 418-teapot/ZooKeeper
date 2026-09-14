/**
 * Tests for the transcript overlay's native tool rendering path.
 *
 * pi's native `ToolExecutionComponent` renders through the module-level
 * `theme` singleton of `@earendil-works/pi-coding-agent`, which must be
 * initialized with `initTheme()` before construction.  This file groups the
 * assertions on the exact native call card — its call line, its result fold
 * and the `ctrl+o` expansion — against that real theme.
 *
 * The scenarios the file covers:
 *   - a paired tool_start + tool_end renders through the native component
 *     (pi's generic call card: bold tool name + the result text) rather than
 *     the structured `→ <name>` fallback;
 *   - `ctrl+o` (pi's `app.tools.expand` key) flips every native tool
 *     component between collapsed (result folded at ten lines + hint) and
 *     expanded (full output), and back.
 *
 * Assertions strip the real ANSI codes (the native components emit truecolor
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

/** A bash tool call with 12 result lines (over the ten-line card fold). */
function bashLog() {
  const log = createRunLog();
  log.appendToolStart("bash", { command: "npm test" }, 1, "c1");
  log.appendToolEnd(
    "bash",
    [
      {
        type: "text",
        text: "line1\nline2\nline3\nline4\nline5\nline6\nline7\nline8\nline9\nline10\nline11\nline12",
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

    // The native generic call card renders the tool name...
    assert.ok(
      lines.some((l) => l.includes("bash")),
      `native call card expected: ${lines.join(" | ")}`,
    );
    // ...and its result text (collapsed: the first ten lines are shown).
    assert.ok(
      lines.some((l) => l.includes("line1")),
      `result head must render: ${lines.join(" | ")}`,
    );
    assert.ok(
      lines.some((l) => l.includes("line10")),
      `result head must render: ${lines.join(" | ")}`,
    );
    // Not the structured fallback (`→ <name>` + JSON args code block).
    assert.ok(
      !lines.some((l) => l.includes("→ bash")),
      `structured fallback must not render: ${lines.join(" | ")}`,
    );
  });

  it("toggles every native tool component with ctrl+o (expand → collapse)", () => {
    const component = bashOverlay();
    let lines = renderComponent(component, 100).map(stripAnsi);

    // Collapsed: the generic result card folds at ten lines — the fold hint
    // is present, the tail lines are hidden.
    assert.ok(
      lines.some((l) => l.includes("more lines")),
      `collapsed fold hint expected: ${lines.join(" | ")}`,
    );
    assert.ok(
      lines.some((l) => l.includes("line10")),
      lines.join(" | "),
    );
    assert.ok(
      !lines.some((l) => l.includes("line11")),
      `folded tail must be hidden: ${lines.join(" | ")}`,
    );

    // ctrl+o (0x0f) → expanded: full output, fold hint gone.
    sendInput(component, "\u000f");
    lines = renderComponent(component, 100).map(stripAnsi);
    assert.ok(
      lines.some((l) => l.includes("line11")),
      `expanded must show the tail: ${lines.join(" | ")}`,
    );
    assert.ok(
      lines.some((l) => l.includes("line12")),
      lines.join(" | "),
    );
    assert.ok(
      !lines.some((l) => l.includes("more lines")),
      `expanded fold hint must be gone: ${lines.join(" | ")}`,
    );

    // ctrl+o again → collapsed again.
    sendInput(component, "\u000f");
    lines = renderComponent(component, 100).map(stripAnsi);
    assert.ok(
      lines.some((l) => l.includes("more lines")),
      `second ctrl+o must collapse again: ${lines.join(" | ")}`,
    );
    assert.ok(
      !lines.some((l) => l.includes("line11")),
      `collapsed tail hidden again: ${lines.join(" | ")}`,
    );
  });
});
