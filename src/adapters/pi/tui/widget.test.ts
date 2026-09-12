/**
 * Tests for the pi `zoo` fleet widget (`src/adapters/pi/tui/widget.ts`).
 *
 * The widget is the component factory registered above the editor: it tracks
 * the active primary plus the current session's subagent runs (from the core
 * run registry) and drives the collapsed one-liner / expanded scrolling list,
 * the keyboard state machine, and the spinner/clock timer.
 *
 * Test strategy: the widget is pure component logic with injectable timers
 * and a fake clock, so every timer behaviour (start / advance / clear on
 * dispose / no dangling handles) is asserted deterministically without real
 * wall-clock waits.  The registry is process-global and reset between tests.
 *
 * Coverage:
 *   - collapsed line's three forms (no activity / running / counts).
 *   - expanded keyboard state machine (↓ expand / ↑↓ jk move / esc collapse /
 *     ↑-at-top collapse / enter on a selected run / editor-focus guard).
 *   - window-follow behaviour (a deep selection stays in view as the window
 *     slides).
 *   - timer lifecycle (started while running/expanded, cleared when idle
 *     collapsed, disposed without a dangling handle).
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { SPINNER_FRAMES } from "../../../core/display.js";
import {
  finishRun,
  resetRegistry,
  type SubagentRun,
  startRun,
} from "../../../core/subagent/registry.js";
import type { TodoPhase } from "../../../core/todo/types.js";
import { createFleetWidget, FLEET_MAX_LINES } from "./widget.js";

afterEach(() => {
  resetRegistry();
});

/**
 * A fake interval/clock pair so timer behaviour is asserted without real
 * timers.  `advance(ms)` fires each due interval once per period and moves
 * the fake clock forward.
 */
function fakeTimer() {
  let now = 0;
  let nextId = 1;
  const intervals = new Map<
    number,
    { period: number; due: number; fn: () => void }
  >();
  const setIntervalFn = (
    fn: () => void,
    period: number,
  ): ReturnType<typeof setInterval> => {
    const id = nextId++;
    intervals.set(id, { period, due: now + period, fn });
    return { id, unref: () => {} } as unknown as ReturnType<typeof setInterval>;
  };
  const clearIntervalFn = (handle: unknown): void => {
    const id = (handle as { id?: number } | undefined)?.id;
    if (id !== undefined) intervals.delete(id);
  };
  const advance = (ms: number): void => {
    const target = now + ms;
    let fired = true;
    while (fired) {
      fired = false;
      for (const entry of [...intervals.values()]) {
        if (entry.due <= target) {
          entry.due += entry.period;
          entry.fn();
          fired = true;
        }
      }
    }
    now = target;
  };
  const nowFn = (): number => now;
  const activeCount = (): number => intervals.size;
  return { setIntervalFn, clearIntervalFn, nowFn, advance, activeCount };
}

/** A theme stub that wraps each colorized string in `<color>` tags. */
const THEME = {
  fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
  bg: (color: string, text: string) => `<${color}>${text}</${color}>`,
};

/** A focusable fake TUI (defaults to an empty focused editor). */
function tuiOf(overrides: { focused?: unknown } = {}): {
  tui: { requestRender: () => void; focusedComponent: unknown };
} {
  const focused = overrides.focused ?? {
    render: () => [],
    invalidate: () => {},
    handleInput: () => {},
    getText: () => "",
    setText: () => {},
  };
  return {
    tui: {
      requestRender: () => {},
      focusedComponent: focused,
    },
  };
}

/** Register a top-level run under the current session (with a session path). */
function seedRun(id: string, startedAt: number, agent = "lynx"): void {
  startRun({
    id,
    agent,
    parentSession: "main",
    startedAt,
    sessionPath: `/tmp/sessions/${id}.jsonl`,
  });
}

/** Default deps overridable per test. */
function depsOf(
  overrides: {
    getPrimary?: () => string | undefined;
    getSessionId?: () => string | undefined;
    getEditorText?: () => string;
    enterRun?: (run: SubagentRun) => boolean | undefined;
    getTodoPhases?: () => readonly TodoPhase[];
    t?: ReturnType<typeof fakeTimer>;
  } = {},
) {
  const t = overrides.t ?? fakeTimer();
  return {
    deps: {
      getPrimary: overrides.getPrimary ?? (() => "dolphin"),
      colorizeAgent: (name: string) => `<c>${name}</c>`,
      getSessionId: overrides.getSessionId ?? (() => "main"),
      getEditorText: overrides.getEditorText ?? (() => ""),
      ...(overrides.enterRun !== undefined
        ? { enterRun: overrides.enterRun }
        : {}),
      ...(overrides.getTodoPhases !== undefined
        ? { getTodoPhases: overrides.getTodoPhases }
        : {}),
      setInterval: t.setIntervalFn,
      clearInterval: t.clearIntervalFn,
      now: t.nowFn,
    },
    t,
  };
}

/** A phase whose tasks are all pending (for the dual-column tests). */
function pendingPhase(name: string, contents: readonly string[]): TodoPhase {
  return {
    name,
    tasks: contents.map((content) => ({ content, status: "pending" as const })),
  };
}

// ---------------------------------------------------------------------------
// Collapsed rendering
// ---------------------------------------------------------------------------

describe("fleet widget — collapsed line", () => {
  it("renders only the primary with no activity", () => {
    const { deps } = depsOf();
    const w = createFleetWidget(deps);
    w.attach(tuiOf().tui, THEME);
    // The primary segment carries no hue (it is pre-colorized by the host),
    // so it is emitted verbatim — never wrapped in the muted hue.
    assert.deepEqual(w.render(80), ["◆ <c>dolphin</c>"]);
    w.dispose();
  });

  it("renders the running spinner + elapsed segment while a run is active", () => {
    const { deps, t } = depsOf();
    seedRun("r0", 0);
    const w = createFleetWidget(deps);
    w.attach(tuiOf().tui, THEME);
    t.advance(5000);
    const line = w.render(80)[0];
    // The running segment shows the spinner + agent + elapsed, wrapped in the
    // running (warning) hue; the primary stays unwrapped.  The agent name is
    // colorized by colorizeAgent (the `<c>` stub wraps the whole name).
    assert.ok(line.includes("<c>dolphin</c>"), line);
    assert.ok(line.includes("<warning>"), line);
    assert.ok(line.includes("<c>lynx</c> 0:05"), line);
    // The running segment is wrapped on its own: the closing `</warning>`
    // lands after the elapsed, and no dim wrap ever encloses the primary.
    assert.ok(line.includes("</warning>"), line);
    assert.ok(!line.includes("</dim>"), line);
    w.dispose();
  });

  it("lists every concurrently running run with only the spinners colored", () => {
    const { deps, t } = depsOf();
    seedRun("r0", 0, "beaver");
    seedRun("r1", 49000, "lynx");
    seedRun("r2", 49000, "spider");
    finishRun("r2", { status: "done" });
    const w = createFleetWidget(deps);
    w.attach(tuiOf().tui, THEME);
    t.advance(83000);
    // Both running runs appear in top-level order (beaver then lynx); the
    // done count follows after.
    const line = w.render(200)[0];
    assert.ok(line.includes("<c>beaver</c> 1:23"), line);
    assert.ok(line.includes("<c>lynx</c> 0:34"), line);
    assert.ok(line.includes("<success>●</success> 1"), line);
    // Only the two spinners are wrapped in the warning hue — the agent names,
    // durations, and separators stay uncolored.
    const count = line.split("<warning>").length - 1;
    assert.equal(count, 2, `expected exactly two colored spinners: ${line}`);
    assert.ok(!line.includes("<warning>beaver"), line);
    assert.ok(!line.includes("<warning>lynx"), line);
    assert.ok(!line.includes(" 1:23</warning>"), line);
    w.dispose();
  });

  it("colorizes each running run's agent name with its configured color", () => {
    const { deps, t } = depsOf();
    // beaver and lynx carry configured colors; spider has none (the default
    // stub colorizeAgent still wraps every name for visibility).
    seedRun("r0", 0, "beaver");
    seedRun("r1", 49000, "lynx");
    const w = createFleetWidget(deps);
    w.attach(tuiOf().tui, THEME);
    t.advance(83000);
    const line = w.render(200)[0];
    // Each running agent name is wrapped by colorizeAgent (the `<c>` stub
    // wraps the whole name), leaving the spinner hue and the elapsed plain.
    assert.ok(line.includes("<c>beaver</c> 1:23"), line);
    assert.ok(line.includes("<c>lynx</c> 0:34"), line);
    w.dispose();
  });

  it("leaves running agent names plain when no color is configured", () => {
    const { deps, t } = depsOf();
    deps.colorizeAgent = (name: string) => name; // unconfigured → plain
    seedRun("r0", 0, "beaver");
    const w = createFleetWidget(deps);
    w.attach(tuiOf().tui, THEME);
    t.advance(5000);
    const line = w.render(80)[0];
    // The agent name falls back to its default (no ANSI / no wrap tags).
    assert.ok(line.includes("beaver 0:05"), line);
    assert.ok(!line.includes("<c>beaver</c>"), line);
    w.dispose();
  });

  it("counts a nested running run inside a done parent in the collapsed line", () => {
    // A finished top-level run whose nested delegation (one level deep) is
    // still running must drive the collapsed running segment: the collapsed
    // line counts and lists the NESTED run's agent + elapsed, not just the
    // top-level runners.
    const { deps, t } = depsOf();
    seedRun("parent", 0, "beaver");
    finishRun("parent", { status: "done", childSession: "child-ses-1" });
    startRun({
      id: "nested",
      agent: "lynx",
      parentSession: "child-ses-1",
      startedAt: 2000,
    });
    const w = createFleetWidget(deps);
    w.attach(tuiOf().tui, THEME);
    t.advance(5000);
    const line = w.render(200)[0];
    // The nested running lynx appears with its own spinner segment + elapsed,
    // its agent name colorized by colorizeAgent.
    assert.ok(line.includes("<c>dolphin</c>"), line);
    assert.ok(line.includes("<warning>"), line);
    assert.ok(line.includes("<c>lynx</c> 0:03"), line);
    // The collapsed running hue is driven by the nested run's presence.
    assert.ok(line.includes("</warning>"), line);
    w.dispose();
  });

  it("counts a third-generation running run in the collapsed line", () => {
    // A running run two levels below a finished top-level run must still
    // drive the collapsed spinner segment and its count.
    const { deps, t } = depsOf();
    seedRun("parent", 0, "beaver");
    finishRun("parent", { status: "done", childSession: "child-a" });
    startRun({
      id: "mid",
      agent: "mola",
      parentSession: "child-a",
      startedAt: 1000,
    });
    finishRun("mid", { status: "done", childSession: "child-b" });
    startRun({
      id: "deep",
      agent: "lynx",
      parentSession: "child-b",
      startedAt: 2000,
    });
    const w = createFleetWidget(deps);
    w.attach(tuiOf().tui, THEME);
    t.advance(5000);
    const line = w.render(200)[0];
    // The deep running lynx appears with its own spinner segment + elapsed.
    assert.ok(line.includes("<warning>"), line);
    assert.ok(line.includes("<c>lynx</c> 0:03"), line);
    w.dispose();
  });

  it("renders the done and failed dots with zero-count omission", () => {
    const { deps, t } = depsOf();
    // r0 finishes done, r1 finishes error, r2 stays running.
    seedRun("r0", 0);
    seedRun("r1", 1000);
    seedRun("r2", 2000);
    finishRun("r0", { status: "done" });
    finishRun("r1", { status: "error", error: "boom" });
    const w = createFleetWidget(deps);
    w.attach(tuiOf().tui, THEME);
    t.advance(3000);
    // Render wide: the `<color>` stub tags count as visible width (the real
    // pi theme emits zero-width ANSI), so a narrow width would truncate the
    // line before the trailing dots.
    const line = w.render(200)[0];
    // Each count splits into a separator, a colored status symbol, and an
    // uncolored number — only the bare symbol is wrapped, so the literal
    // `● 1 ■ 1` is broken up by the color tags that enclose just the
    // symbols (the failed count renders the canonical error square).
    assert.ok(line.includes("<success>●</success> 1 <error>■</error> 1"), line);
    // The separator before the first dot (` · `) and between the dots (` `)
    // must never be wrapped into a status color.
    assert.ok(
      !line.includes("<success> · ") && !line.includes(" · </success>"),
      line,
    );
    assert.ok(!line.includes("<error> ") && !line.includes(" </error>"), line);
    assert.ok(!line.includes("●0"), "a zero count must be omitted");
    w.dispose();
  });

  it("colors each segment independently so embedded ANSI is not washed out", () => {
    // The colorizer stub records every `theme.fg` invocation so we can prove
    // the segments are wrapped individually — the pre-colorized primary (with
    // its own embedded ANSI reset `\x1b[39m`) must never be wrapped together
    // with the trailing dots (which would reset their color mid-line).
    const calls: Array<{ color: string; text: string }> = [];
    const spyTheme = {
      fg: (color: string, text: string) => {
        calls.push({ color, text });
        return `<${color}>${text}</${color}>`;
      },
    };
    const { deps, t } = depsOf();
    deps.colorizeAgent = (name: string) =>
      `\u001b[38;2;255;0;0m${name}\u001b[39m`;
    seedRun("r0", 0);
    seedRun("r1", 1000);
    finishRun("r0", { status: "done" });
    finishRun("r1", { status: "error", error: "boom" });
    const w = createFleetWidget(deps);
    w.attach(tuiOf().tui, spyTheme);
    t.advance(1000);
    // Render wide: the spy theme's `<color>` tags count as visible width (the
    // real pi theme emits zero-width ANSI), so a narrow width would truncate
    // the trailing dots out of the rendered line.
    const line = w.render(200)[0];

    // The primary (embedded-ANSI) segment is never passed to theme.fg.
    assert.ok(
      !calls.some((c) => c.text.includes("\u001b[")),
      `embedded ANSI must not be wrapped: ${calls.map((c) => c.text).join(" | ")}`,
    );
    // The done and failed dots are wrapped with their own success/error
    // colors (each colored segment is one colorized call); the separators
    // (` · ` / ` `) and the numbers are uncolored segments emitted verbatim.
    assert.ok(
      calls.some((c) => c.color === "success" && c.text === "●"),
      `success dot must be wrapped standalone: ${calls.map((c) => `${c.color}:${c.text}`).join(" | ")}`,
    );
    assert.ok(
      calls.some((c) => c.color === "error" && c.text === "■"),
      `error square must be wrapped standalone: ${calls.map((c) => `${c.color}:${c.text}`).join(" | ")}`,
    );
    // No separator or number may be passed to theme.fg: the dots are the
    // only colorized pieces of the count segments.
    assert.ok(
      !calls.some(
        (c) =>
          (c.color === "success" || c.color === "error") &&
          (c.text === " · " || c.text === " " || /^\s*\d/.test(c.text)),
      ),
      `only the bare dots may be colorized: ${calls.map((c) => `${c.color}:${c.text}`).join(" | ")}`,
    );
    // The rendered line keeps the dots visibly colored (not reset by the
    // primary's ANSI reset sequence).
    assert.ok(line.includes("\u001b[38;2;255;0;0mdolphin\u001b[39m"), line);
    assert.ok(line.includes("<success>●</success> 1 <error>■</error> 1"), line);
    w.dispose();
  });
});

// ---------------------------------------------------------------------------
// Expanded rendering
// ---------------------------------------------------------------------------

describe("fleet widget — expanded agent colorization", () => {
  it("colorizes the agent name of each expanded row (top-level and nested)", () => {
    const { deps, t } = depsOf();
    seedRun("r0", 1000, "beaver");
    seedRun("r1", 2000, "lynx");
    const w = createFleetWidget(deps);
    w.attach(tuiOf().tui, THEME);
    w.handleKey("\u001b[B"); // expand
    t.advance(3000);
    const lines = w.render(200);
    // Each row's agent name is wrapped by colorizeAgent; the glyph hue and
    // the label/duration stay uncolored (elapsed = now - startedAt).
    assert.ok(
      lines.some((l) => l.includes("<c>beaver</c> · 0:02")),
      lines.join("\n"),
    );
    assert.ok(
      lines.some((l) => l.includes("<c>lynx</c> · 0:01")),
      lines.join("\n"),
    );
    // The glyph is still status-hued (running spinner / success dot).
    assert.ok(
      lines.some((l) => l.includes("<warning>")),
      lines.join("\n"),
    );
    w.dispose();
  });

  it("colorizes a nested child row's agent name", () => {
    const { deps, t } = depsOf();
    seedRun("parent", 0, "beaver");
    finishRun("parent", { status: "done", childSession: "child-ses-1" });
    startRun({
      id: "nested",
      agent: "lynx",
      parentSession: "child-ses-1",
      startedAt: 2000,
    });
    const w = createFleetWidget(deps);
    w.attach(tuiOf().tui, THEME);
    w.handleKey("\u001b[B"); // expand
    t.advance(5000);
    const lines = w.render(200);
    // The nested child row's agent name is colorized too; the glyph stays
    // status-hued and the duration stays plain.  The exact spinner frame is
    // timer-driven, so only the colorized name + duration are asserted.
    assert.ok(
      lines.some((l) => /└─ .+<c>lynx<\/c> · 0:03/.test(l)),
      lines.join("\n"),
    );
    w.dispose();
  });

  it("leaves expanded row agent names plain when no color is configured", () => {
    const { deps } = depsOf();
    deps.colorizeAgent = (name: string) => name; // unconfigured → plain
    seedRun("r0", 0, "beaver");
    const w = createFleetWidget(deps);
    w.attach(tuiOf().tui, THEME);
    w.handleKey("\u001b[B"); // expand
    const lines = w.render(80);
    assert.ok(
      lines.some((l) => l.includes("beaver")),
      lines.join("\n"),
    );
    assert.ok(!lines.some((l) => l.includes("<c>")), lines.join("\n"));
    w.dispose();
  });
});

// ---------------------------------------------------------------------------
// Keyboard state machine
// ---------------------------------------------------------------------------

describe("fleet widget — keyboard state machine", () => {
  it("expands on ↓ with an empty focused editor and consumes the key", () => {
    const { deps } = depsOf();
    const w = createFleetWidget(deps);
    w.attach(tuiOf().tui, THEME);
    seedRun("r0", 0);
    const result = w.handleKey("\u001b[B");
    assert.deepEqual(result, { consume: true });
    const lines = w.render(80);
    assert.ok(lines.length > 1, "expanded must render more than one line");
    assert.ok(lines[0].includes("dolphin"), lines[0]);
    // Width 80 is the narrow stacked layout, so the hint is the compact
    // key list rather than the wide-mode verbs.
    assert.ok(lines[1].includes("↑↓/jk"), lines[1]);
    w.dispose();
  });

  it("does not expand when the editor has text", () => {
    const { deps } = depsOf({ getEditorText: () => "typing" });
    const w = createFleetWidget(deps);
    w.attach(tuiOf().tui, THEME);
    const result = w.handleKey("\u001b[B");
    assert.equal(result, undefined, "must not consume the key while typing");
    assert.equal(w.render(80).length, 1, "stays collapsed");
    w.dispose();
  });

  it("collapses on esc, and ↑ at the very top collapses", () => {
    const { deps } = depsOf();
    const w = createFleetWidget(deps);
    w.attach(tuiOf().tui, THEME);
    seedRun("r0", 0);
    w.handleKey("\u001b[B");
    assert.ok(w.render(80).length > 1);
    w.handleKey("\u001b");
    assert.equal(w.render(80).length, 1);

    // Re-expand, then ↑ at the top (the first roster entry is selected)
    // collapses again.
    w.handleKey("\u001b[B");
    const up = w.handleKey("\u001b[A");
    assert.deepEqual(up, { consume: true });
    assert.equal(w.render(80).length, 1);
    w.dispose();
  });

  it("renders the ↓/j / ↑/k selection as a background-banded row", () => {
    const { deps } = depsOf();
    const w = createFleetWidget(deps);
    w.attach(tuiOf().tui, THEME);
    seedRun("r0", 0);
    seedRun("r1", 1000);
    seedRun("r2", 2000);
    w.handleKey("\u001b[B"); // expand, selects r0
    w.handleKey("j"); // r1
    w.handleKey("\u001b[B"); // r2
    w.handleKey("k"); // back to r1
    const lines = w.render(80);
    // Selection is presentation only: exactly one row carries the
    // `selectedBg` background band (the theme's `bg` in tests), and no
    // marker text is emitted.
    const selectedLines = lines.filter((l) => l.includes("<selectedBg>"));
    assert.equal(
      selectedLines.length,
      1,
      `expected one selected row: ${lines}`,
    );
    assert.ok(selectedLines[0].includes("lynx"), selectedLines[0]);
    // The band must wrap the whole row, with per-segment fg colors intact
    // inside it (no reverse-video cell swaps).
    assert.ok(selectedLines[0].includes("</selectedBg>"), selectedLines[0]);
    const chevron = "\u25b8"; // the fold glyph — must never appear as a marker
    assert.ok(!lines.some((l) => l.includes(chevron)), lines.join("\n"));
    w.dispose();
  });

  it("falls back to raw ANSI background when the theme has no bg", () => {
    const { deps } = depsOf();
    const w = createFleetWidget(deps);
    // A minimal theme without `bg` — the widget must still highlight the
    // selected row with the raw ANSI band (256-color gray 239) approximating
    // pi's default dark theme `selectedBg: #3a3a4a`.
    w.attach(tuiOf().tui, { fg: THEME.fg });
    seedRun("r0", 0);
    seedRun("r1", 1000);
    w.handleKey("\u001b[B"); // expand, selects r0
    const lines = w.render(80);
    const selectedLines = lines.filter((l) => l.includes("\x1b[48;5;239m"));
    assert.equal(
      selectedLines.length,
      1,
      `expected one ANSI-highlighted row: ${lines}`,
    );
    assert.ok(selectedLines[0].includes("\x1b[49m"), selectedLines[0]);
    w.dispose();
  });

  it("calls enterRun with the selected run on enter", () => {
    let entered: { id: string } | undefined;
    const { deps } = depsOf({
      enterRun: (run) => {
        entered = run;
      },
    });
    const w = createFleetWidget(deps);
    w.attach(tuiOf().tui, THEME);
    seedRun("r0", 0);
    seedRun("r1", 1000);
    w.handleKey("\u001b[B"); // r0
    w.handleKey("j"); // r1
    w.handleKey("\r");
    assert.ok(entered, "enterRun must fire on enter");
    assert.equal(entered?.id, "r1");
    w.dispose();
  });

  it("does not swallow enter when no enterRun action is provided", () => {
    // pi's widget factory has no command context, so `enterRun` is absent:
    // enter must fall through to the editor instead of being consumed (the
    // expanded list only steals enter when an overlay can be opened).
    const { deps } = depsOf(); // no enterRun
    const w = createFleetWidget(deps);
    w.attach(tuiOf().tui, THEME);
    seedRun("r0", 0);
    w.handleKey("\u001b[B"); // expand
    const result = w.handleKey("\r");
    assert.equal(
      result,
      undefined,
      "enter must not be consumed without enterRun",
    );
    w.dispose();
  });

  it("does not swallow enter when no run is selected", () => {
    // An expanded widget over an empty roster has no selected run, so enter
    // has nothing to inspect and must not be consumed.
    let entered = 0;
    const { deps } = depsOf({
      enterRun: () => {
        entered += 1;
      },
    });
    const w = createFleetWidget(deps);
    w.attach(tuiOf().tui, THEME);
    w.handleKey("\u001b[B"); // expand over an empty roster
    const result = w.handleKey("\r");
    assert.equal(result, undefined, "enter must not be consumed without a run");
    assert.equal(entered, 0, "enterRun must not fire");
    w.dispose();
  });

  it("does not swallow enter when the selected run has no sessionPath", () => {
    // A run whose session file could not be located has no `sessionPath` —
    // the host's `enterRun` reports that no overlay opened (false), so
    // enter must fall through to the editor instead of being consumed.
    let entered = 0;
    const { deps } = depsOf({
      enterRun: (run) => {
        entered += 1;
        return run.sessionPath !== undefined;
      },
    });
    const w = createFleetWidget(deps);
    w.attach(tuiOf().tui, THEME);
    // A run recorded WITHOUT a sessionPath (locateSessionFile miss).
    startRun({ id: "no-path", agent: "lynx", parentSession: "main" });
    w.handleKey("\u001b[B"); // expand, selects no-path
    const result = w.handleKey("\r");
    assert.equal(
      result,
      undefined,
      "enter must not be consumed without a sessionPath",
    );
    assert.equal(
      entered,
      1,
      "enterRun must be consulted to decide whether to open an overlay",
    );
    w.dispose();
  });

  it("ignores keys when the editor loses focus and collapses when expanded", () => {
    const { deps } = depsOf();
    const w = createFleetWidget(deps);
    w.attach(tuiOf().tui, THEME);
    seedRun("r0", 0);
    w.handleKey("\u001b[B");
    assert.ok(w.render(80).length > 1);
    // Focus leaves the editor → any key is ignored and the widget collapses.
    w.attach(tuiOf({ focused: undefined }).tui, THEME);
    const result = w.handleKey("x");
    assert.equal(result, undefined);
    assert.equal(w.render(80).length, 1);
    w.dispose();
  });
});

// ---------------------------------------------------------------------------
// Collapse control surface
// ---------------------------------------------------------------------------

describe("fleet widget — collapse control surface", () => {
  it("collapses an expanded widget back to the single stable line", () => {
    const { deps } = depsOf();
    const w = createFleetWidget(deps);
    w.attach(tuiOf().tui, THEME);
    seedRun("r0", 0);
    w.handleKey("\u001b[B"); // expand
    assert.ok(w.render(80).length > 1);
    w.collapse();
    assert.equal(w.render(80).length, 1);
    w.dispose();
  });

  it("is idempotent — repeated collapse on an already-collapsed widget has no effect", () => {
    const { deps, t } = depsOf();
    const w = createFleetWidget(deps);
    w.attach(tuiOf().tui, THEME);
    seedRun("r0", 0);
    // Collapse while already collapsed: no throw, the line stays one, and the
    // timer keeps running only because a run is active (collapse itself never
    // starts or clears the idle timer).
    w.collapse();
    w.collapse();
    assert.equal(w.render(80).length, 1);
    w.dispose();
    assert.equal(t.activeCount(), 0, "dispose must clear the timer");
  });

  it("clears the timer when collapsing an expanded idle widget", () => {
    const { deps, t } = depsOf();
    const w = createFleetWidget(deps);
    w.attach(tuiOf().tui, THEME);
    w.handleKey("\u001b[B"); // expand with nothing running
    assert.equal(t.activeCount(), 1, "expanded keeps the timer alive");
    w.collapse();
    assert.equal(
      t.activeCount(),
      0,
      "collapse must clear the timer when nothing runs",
    );
    w.dispose();
  });

  it("leaves the widget collapsed so ↓ can re-expand afterwards", () => {
    const { deps } = depsOf();
    const w = createFleetWidget(deps);
    w.attach(tuiOf().tui, THEME);
    seedRun("r0", 0);
    w.handleKey("\u001b[B"); // expand
    w.collapse();
    assert.equal(w.render(80).length, 1);
    // The normal ↓ path still re-expands after a control-surface collapse.
    const result = w.handleKey("\u001b[B");
    assert.deepEqual(result, { consume: true });
    assert.ok(w.render(80).length > 1);
    w.dispose();
  });
});

// ---------------------------------------------------------------------------
// Window following
// ---------------------------------------------------------------------------

describe("fleet widget — window following", () => {
  it("keeps a deep selection in view as the window slides", () => {
    const { deps } = depsOf();
    const w = createFleetWidget(deps);
    w.attach(tuiOf().tui, THEME);
    // 10 top-level runs so the 7-row window must slide.
    for (let i = 0; i < 10; i++) seedRun(`r${i}`, i * 1000);
    w.handleKey("\u001b[B"); // r0
    // Move down to r8 — the window must follow it into view.
    for (let i = 0; i < 8; i++) w.handleKey("j");
    const lines = w.render(80);
    const selected = lines.find((l) => l.includes("<selectedBg>"));
    assert.ok(selected, `selected row must be in view: ${lines}`);
    assert.ok(
      lines.some((l) => l.includes("more")),
      "window indicators must appear",
    );
    w.dispose();
  });

  it("moves the selection into a grandchild row across every generation", () => {
    const { deps } = depsOf();
    seedRun("r0", 0, "beaver");
    finishRun("r0", { status: "done", childSession: "child-a" });
    startRun({
      id: "c0",
      agent: "mola",
      parentSession: "child-a",
      startedAt: 1000,
    });
    finishRun("c0", { status: "done", childSession: "child-b" });
    startRun({
      id: "g0",
      agent: "lynx",
      parentSession: "child-b",
      startedAt: 2000,
    });
    const w = createFleetWidget(deps);
    w.attach(tuiOf().tui, THEME);
    w.handleKey("\u001b[B"); // expand, selects r0
    w.handleKey("j"); // c0
    w.handleKey("j"); // g0 — only reachable if the roster walks the whole tree
    const lines = w.render(200);
    const banded = lines.filter((l) => l.includes("<selectedBg>"));
    assert.equal(banded.length, 1, lines.join("\n"));
    assert.ok(banded[0].includes("<c>lynx</c>"), banded[0]);
    w.dispose();
  });

  it("never drops the ↓ indicator when nested children overflow the budget", () => {
    const { deps } = depsOf();
    const w = createFleetWidget(deps);
    w.attach(tuiOf().tui, THEME);
    // 10 top-level runs so the 7-row window slides with both ↑ and ↓
    // indicators visible; a nested child on several tops doubles their rows,
    // so the assembled expanded view overflows the ~10-line budget.  The
    // trailing ↓ indicator (the line a naive tail-slice would cut) must
    // survive.
    for (let i = 0; i < 10; i++) seedRun(`r${i}`, i * 1000);
    for (const parent of ["r2", "r5", "r8"]) {
      startRun({
        id: `c-${parent}`,
        agent: "lynx",
        parentSession: `child-${parent}`,
        startedAt: 1000,
      });
      finishRun(parent, { status: "done", childSession: `child-${parent}` });
    }
    w.handleKey("\u001b[B"); // expand, selects r0
    w.handleKey("j"); // r1
    w.handleKey("j"); // r2 → both ↑ and ↓ indicators visible
    const lines = w.render(80);
    assert.ok(
      lines.length <= FLEET_MAX_LINES,
      `lines=${lines.length} exceeds the ${FLEET_MAX_LINES}-line budget`,
    );
    assert.ok(
      lines.some((l) => l.includes("↓ ")),
      `↓ indicator must survive the budget trim: ${lines}`,
    );
    assert.ok(
      lines.some((l) => l.includes("↑ ")),
      `↑ indicator must survive the budget trim: ${lines}`,
    );
    w.dispose();
  });
});

// ---------------------------------------------------------------------------
// Timer lifecycle
// ---------------------------------------------------------------------------

describe("fleet widget — timer lifecycle", () => {
  it("starts the timer while a run is active and advances the line", () => {
    const { deps, t } = depsOf();
    seedRun("r0", 0);
    const w = createFleetWidget(deps);
    w.attach(tuiOf().tui, THEME);
    assert.equal(t.activeCount(), 1, "timer must run while a run is active");
    const before = w.render(80)[0];
    t.advance(450);
    const after = w.render(80)[0];
    assert.notEqual(before, after, "the running line must animate");
    w.dispose();
  });

  it("keeps the timer while expanded even with nothing running", () => {
    const { deps, t } = depsOf();
    const w = createFleetWidget(deps);
    w.attach(tuiOf().tui, THEME);
    assert.equal(t.activeCount(), 0);
    w.handleKey("\u001b[B");
    assert.equal(t.activeCount(), 1, "expanded keeps the timer alive");
    w.dispose();
  });

  it("clears the timer when collapsing with nothing running", () => {
    const { deps, t } = depsOf();
    const w = createFleetWidget(deps);
    w.attach(tuiOf().tui, THEME);
    w.handleKey("\u001b[B");
    assert.equal(t.activeCount(), 1);
    w.handleKey("\u001b");
    assert.equal(
      t.activeCount(),
      0,
      "timer must clear on collapse with no runs",
    );
    w.dispose();
  });

  it("clears the timer once every run reaches a terminal state", () => {
    const { deps, t } = depsOf();
    seedRun("r0", 0);
    seedRun("r1", 1000);
    const w = createFleetWidget(deps);
    w.attach(tuiOf().tui, THEME);
    assert.equal(t.activeCount(), 1, "timer runs while a run is active");
    // A `refresh()` after both finish must detect the idle fleet and stop the
    // spinner/clock — the finished widget must not keep animating.
    finishRun("r0", { status: "done" });
    finishRun("r1", { status: "error", error: "boom" });
    w.refresh();
    assert.equal(t.activeCount(), 0, "timer must clear once the fleet is idle");
    w.dispose();
  });

  it("dispose clears the timer and leaves no dangling handle", () => {
    const { deps, t } = depsOf();
    seedRun("r0", 0);
    const w = createFleetWidget(deps);
    w.attach(tuiOf().tui, THEME);
    assert.equal(t.activeCount(), 1);
    w.dispose();
    assert.equal(t.activeCount(), 0, "dispose must clear the timer");
  });
});

// ---------------------------------------------------------------------------
// Dual-column: collapsed summary
// ---------------------------------------------------------------------------

describe("fleet widget — dual-column collapsed summary", () => {
  it("joins the fleet and todo summaries with a separator", () => {
    const { deps } = depsOf({
      getTodoPhases: () => [pendingPhase("A", ["t1", "t2"])],
    });
    const w = createFleetWidget(deps);
    w.attach(tuiOf().tui, THEME);
    const lines = w.render(80);

    assert.equal(lines.length, 1);
    assert.ok(lines[0].includes("<c>dolphin</c>"), lines[0]);
    assert.ok(lines[0].includes("│"), lines[0]);
    assert.ok(lines[0].includes("0/2 done"), lines[0]);
    w.dispose();
  });

  it("is byte-identical to the single fleet line when the todo list is empty", () => {
    const { deps } = depsOf({ getTodoPhases: () => [] });
    const w = createFleetWidget(deps);
    w.attach(tuiOf().tui, THEME);

    assert.deepEqual(w.render(80), ["◆ <c>dolphin</c>"]);
    w.dispose();
  });

  it("returns no lines when neither column has content", () => {
    const { deps } = depsOf({
      getPrimary: () => undefined,
      getTodoPhases: () => [],
    });
    const w = createFleetWidget(deps);
    w.attach(tuiOf().tui, THEME);

    assert.deepEqual(w.render(80), []);
    w.dispose();
  });
});

// ---------------------------------------------------------------------------
// Dual-column: focus routing
// ---------------------------------------------------------------------------

describe("fleet widget — dual-column focus routing", () => {
  it("toggles the focused column on tab and consumes the key", () => {
    const { deps } = depsOf({
      getTodoPhases: () => [pendingPhase("A", ["t1"])],
    });
    const w = createFleetWidget(deps);
    w.attach(tuiOf().tui, THEME);
    seedRun("r0", 0);
    w.handleKey("\u001b[B"); // expand

    assert.deepEqual(w.handleKey("\t"), { consume: true });
    // The todo column now bands its selection (its first projected row).
    const focused = w.render(80);
    assert.ok(
      focused.some((l) => l.includes("<selectedBg>") && l.includes("▾ A")),
      focused.join("\n"),
    );
    w.dispose();
  });

  it("bands only the focused column's selected row", () => {
    const { deps } = depsOf({
      getTodoPhases: () => [pendingPhase("A", ["t1"])],
    });
    const w = createFleetWidget(deps);
    w.attach(tuiOf().tui, THEME);
    seedRun("r0", 0, "lynx");
    w.handleKey("\u001b[B"); // expand, the fleet column owns focus

    const fleetFocus = w.render(80).filter((l) => l.includes("<selectedBg>"));
    assert.equal(
      fleetFocus.length,
      1,
      `fleet focus must band exactly one row: ${fleetFocus.join("\n")}`,
    );
    assert.ok(fleetFocus[0].includes("lynx"), fleetFocus[0]);

    w.handleKey("\t"); // focus the todo column
    const todoFocus = w.render(80).filter((l) => l.includes("<selectedBg>"));
    assert.equal(
      todoFocus.length,
      1,
      `todo focus must band exactly one row: ${todoFocus.join("\n")}`,
    );
    assert.ok(todoFocus[0].includes("▾ A"), todoFocus[0]);
    assert.ok(!todoFocus[0].includes("lynx"), todoFocus[0]);

    w.handleKey("\t"); // back to the fleet column
    const backToFleet = w.render(80).filter((l) => l.includes("<selectedBg>"));
    assert.equal(
      backToFleet.length,
      1,
      `fleet focus must band exactly one row again: ${backToFleet.join("\n")}`,
    );
    assert.ok(backToFleet[0].includes("lynx"), backToFleet[0]);
    w.dispose();
  });

  it("consumes tab as a no-op on the fleet column when the todo list is empty", () => {
    const { deps } = depsOf({ getTodoPhases: () => [] });
    const w = createFleetWidget(deps);
    w.attach(tuiOf().tui, THEME);
    seedRun("r0", 0, "lynx");
    w.handleKey("\u001b[B"); // expand, the fleet column owns focus

    assert.deepEqual(w.handleKey("\t"), { consume: true });
    const banded = w.render(120).filter((l) => l.includes("<selectedBg>"));
    assert.equal(
      banded.length,
      1,
      `focus must stay on the fleet band: ${banded.join("\n")}`,
    );
    assert.ok(banded[0].includes("lynx"), banded[0]);
    w.dispose();
  });

  it("does not move focus to a hidden fleet column on tab (todo-only)", () => {
    const { deps } = depsOf({
      getPrimary: () => undefined,
      getTodoPhases: () => [pendingPhase("A", ["t1"])],
    });
    const w = createFleetWidget(deps);
    w.attach(tuiOf().tui, THEME);
    w.handleKey("\u001b[B"); // expand
    assert.deepEqual(w.handleKey("\t"), { consume: true }); // focus todo
    let banded = w.render(80).filter((l) => l.includes("<selectedBg>"));
    assert.ok(
      banded.some((l) => l.includes("\u25be A")),
      banded.join("\n"),
    );

    // The fleet column is hidden (no primary, no runs): tab stays on todo.
    assert.deepEqual(w.handleKey("\t"), { consume: true });
    banded = w.render(80).filter((l) => l.includes("<selectedBg>"));
    assert.equal(banded.length, 1, banded.join("\n"));
    assert.ok(banded[0].includes("\u25be A"), banded[0]);
    w.dispose();
  });

  it("moves the todo selection with j while the fleet selection stays put", () => {
    let entered: string | undefined;
    const { deps } = depsOf({
      getTodoPhases: () => [pendingPhase("A", ["t1", "t2", "t3"])],
      enterRun: (run) => {
        entered = run.id;
      },
    });
    const w = createFleetWidget(deps);
    w.attach(tuiOf().tui, THEME);
    seedRun("r0", 0, "beaver");
    seedRun("r1", 1000, "lynx");
    w.handleKey("\u001b[B"); // expand, fleet selects r0
    w.handleKey("\t"); // focus todo
    w.handleKey("j"); // todo selection 0 → 1 (the first task)

    const lines = w.render(80);
    assert.ok(
      lines.some((l) => l.includes("<selectedBg>") && l.includes("t1")),
      lines.join("\n"),
    );
    assert.ok(
      !lines.some((l) => l.includes("<selectedBg>") && l.includes("t2")),
      lines.join("\n"),
    );
    // Back on the fleet column, enter still inspects the first roster run.
    w.handleKey("\t");
    assert.deepEqual(w.handleKey("\r"), { consume: true });
    assert.equal(
      entered,
      "r0",
      "todo navigation must not move fleet selection",
    );
    w.dispose();
  });

  it("does not trigger the fleet action on enter while the todo column is focused", () => {
    let calls = 0;
    const { deps } = depsOf({
      getTodoPhases: () => [pendingPhase("A", ["t1"])],
      enterRun: () => {
        calls += 1;
      },
    });
    const w = createFleetWidget(deps);
    w.attach(tuiOf().tui, THEME);
    seedRun("r0", 0);
    w.handleKey("\u001b[B");
    w.handleKey("\t");

    assert.deepEqual(w.handleKey("\r"), { consume: true });
    assert.equal(calls, 0, "todo enter must not trigger the fleet action");
    assert.ok(w.render(80).length > 1, "todo enter must not collapse");
    w.dispose();
  });

  it("expands and collapses a settled phase header on enter", () => {
    const phases: TodoPhase[] = [
      {
        name: "Done",
        tasks: [
          { content: "t1", status: "completed" },
          { content: "t2", status: "completed" },
        ],
      },
      pendingPhase("Open", ["p1"]),
    ];
    const { deps } = depsOf({ getTodoPhases: () => phases });
    const w = createFleetWidget(deps);
    w.attach(tuiOf().tui, THEME);
    w.handleKey("\u001b[B"); // expand
    w.handleKey("\t"); // focus the todo column (first header selected)

    // Collapsed by default: the settled tasks are hidden.
    const before = w.render(80);
    assert.ok(!before.some((l) => l.includes("t1")), before.join("\n"));

    // Enter on the settled header expands its struck rows.
    assert.deepEqual(w.handleKey("\r"), { consume: true });
    const expanded = w.render(80);
    assert.ok(
      expanded.some((l) => l.includes("t1")),
      expanded.join("\n"),
    );
    assert.ok(
      expanded.some((l) => l.includes("t2")),
      expanded.join("\n"),
    );

    // A second enter on the same header collapses it again.
    assert.deepEqual(w.handleKey("\r"), { consume: true });
    const collapsed = w.render(80);
    assert.ok(!collapsed.some((l) => l.includes("t1")), collapsed.join("\n"));
    assert.ok(
      collapsed.some((l) => l.includes("Done")),
      collapsed.join("\n"),
    );
    w.dispose();
  });

  it("collapses and re-expands an open phase header on enter", () => {
    const phases: TodoPhase[] = [pendingPhase("A", ["t1", "t2"])];
    const { deps } = depsOf({ getTodoPhases: () => phases });
    const w = createFleetWidget(deps);
    w.attach(tuiOf().tui, THEME);
    w.handleKey("\u001b[B"); // expand
    w.handleKey("\t"); // focus the todo column (open header selected)

    // Open phases enumerate by default.
    assert.ok(
      w.render(80).some((l) => l.includes("t1")),
      "open phase must enumerate by default",
    );

    // Enter folds the open phase to its header.
    assert.deepEqual(w.handleKey("\r"), { consume: true });
    const folded = w.render(80);
    assert.ok(!folded.some((l) => l.includes("t1")), folded.join("\n"));
    assert.ok(
      folded.some((l) => l.includes("A")),
      folded.join("\n"),
    );

    // A second enter re-expands it.
    assert.deepEqual(w.handleKey("\r"), { consume: true });
    assert.ok(
      w.render(80).some((l) => l.includes("t1")),
      "second enter must re-expand the open phase",
    );
    w.dispose();
  });

  it("consumes enter on a task row as a no-op", () => {
    const phases: TodoPhase[] = [pendingPhase("A", ["t1", "t2"])];
    const { deps } = depsOf({ getTodoPhases: () => phases });
    const w = createFleetWidget(deps);
    w.attach(tuiOf().tui, THEME);
    w.handleKey("\u001b[B"); // expand
    w.handleKey("\t"); // focus the todo column (header selected)
    w.handleKey("j"); // move onto the t1 task row
    const before = w.render(80);
    assert.deepEqual(w.handleKey("\r"), { consume: true });
    assert.deepEqual(w.render(80), before, "enter on a task row is a no-op");
    w.dispose();
  });

  it("resets the settled-phase expansion on collapse", () => {
    const phases: TodoPhase[] = [
      { name: "Done", tasks: [{ content: "t1", status: "completed" }] },
    ];
    const { deps } = depsOf({ getTodoPhases: () => phases });
    const w = createFleetWidget(deps);
    w.attach(tuiOf().tui, THEME);
    w.handleKey("\u001b[B"); // expand
    w.handleKey("\t"); // focus the todo column
    w.handleKey("\r"); // expand Done
    assert.ok(
      w.render(80).some((l) => l.includes("t1")),
      "expansion should be visible",
    );
    w.collapse();
    w.handleKey("\u001b[B"); // re-expand (fleet column by default)
    w.handleKey("\t"); // focus the todo column again
    assert.ok(
      !w.render(80).some((l) => l.includes("t1")),
      "collapse must reset the settled-phase expansion",
    );
    w.dispose();
  });

  it("resets an open-phase fold override on collapse", () => {
    const phases: TodoPhase[] = [pendingPhase("A", ["t1", "t2"])];
    const { deps } = depsOf({ getTodoPhases: () => phases });
    const w = createFleetWidget(deps);
    w.attach(tuiOf().tui, THEME);
    w.handleKey("\u001b[B"); // expand
    w.handleKey("\t"); // focus the todo column
    w.handleKey("\r"); // fold the open phase
    assert.ok(
      !w.render(80).some((l) => l.includes("t1")),
      "open phase should be folded",
    );
    w.collapse();
    w.handleKey("\u001b[B"); // re-expand (fleet column by default)
    w.handleKey("\t"); // focus the todo column again
    assert.ok(
      w.render(80).some((l) => l.includes("t1")),
      "collapse must reset the fold override to the status default",
    );
    w.dispose();
  });

  it("collapses on up at the first todo row", () => {
    const { deps } = depsOf({
      getTodoPhases: () => [pendingPhase("A", ["t1", "t2"])],
    });
    const w = createFleetWidget(deps);
    w.attach(tuiOf().tui, THEME);
    seedRun("r0", 0);
    w.handleKey("\u001b[B");
    w.handleKey("\t");

    assert.deepEqual(w.handleKey("\u001b[A"), { consume: true });
    assert.equal(w.render(80).length, 1, "collapsed to the summary line");
    w.dispose();
  });

  it("focuses the visible todo column on expand when the fleet is empty", () => {
    // Production guards registration on a primary existing, but the
    // widget contract is self-consistent: expanding a todo-only state must
    // hand the navigation keys to the column that actually renders.
    const { deps } = depsOf({
      getPrimary: () => undefined,
      getTodoPhases: () => [pendingPhase("A", ["t1", "t2"])],
    });
    const w = createFleetWidget(deps);
    w.attach(tuiOf().tui, THEME);
    w.handleKey("\u001b[B"); // expand — no fleet, todo owns focus

    const banded = w.render(80).filter((l) => l.includes("<selectedBg>"));
    assert.equal(banded.length, 1, banded.join("\n"));
    assert.ok(banded[0].includes("\u25be A"), banded[0]);
    w.dispose();
  });

  it("clamps a stale todo selection before moving on up/down", () => {
    // Select a deep row, then shrink the plan under the cursor.  The stale
    // index must not swallow the next keypress on an invisible row.
    let phases: TodoPhase[] = [
      pendingPhase("A", ["t1", "t2", "t3", "t4", "t5", "t6"]),
    ];
    const { deps } = depsOf({ getTodoPhases: () => phases });
    const w = createFleetWidget(deps);
    w.attach(tuiOf().tui, THEME);
    seedRun("r0", 0, "lynx");
    w.handleKey("\u001b[B"); // expand (fleet focus)
    w.handleKey("\t"); // focus todo, header selected (index 0)
    for (let i = 0; i < 5; i++) w.handleKey("j"); // index 5 (t5)

    // The plan shrinks to three rows (header + t1 + t2).
    phases = [pendingPhase("A", ["t1", "t2"])];

    // Without the pre-move clamp the up move would land on 4 and render
    // would clamp it back to the last row (no visible movement); it must
    // now move to t1.
    w.handleKey("k");
    const banded = w.render(80).filter((l) => l.includes("<selectedBg>"));
    assert.equal(banded.length, 1, banded.join("\n"));
    assert.ok(banded[0].includes("t1"), banded[0]);
    assert.ok(!banded[0].includes("t2"), banded[0]);
    w.dispose();
  });

  it("preserves a settled-phase expansion and clamps selection across a refresh", () => {
    const completed = (content: string) => ({
      content,
      status: "completed" as const,
    });
    let phases: TodoPhase[] = [
      { name: "Done", tasks: [completed("t1"), completed("t2")] },
      pendingPhase("Open", ["p1", "p2", "p3", "p4"]),
    ];
    const { deps } = depsOf({ getTodoPhases: () => phases });
    const w = createFleetWidget(deps);
    w.attach(tuiOf().tui, THEME);
    seedRun("r0", 0, "lynx");
    w.handleKey("\u001b[B"); // expand (fleet focus)
    w.handleKey("\t"); // focus todo, Done header selected
    w.handleKey("\r"); // expand the settled Done phase
    assert.ok(
      w.render(80).some((l) => l.includes("t1")),
      "Done must expand",
    );

    // Select the last projected row (p4 at index 7).
    for (let i = 0; i < 7; i++) w.handleKey("j");

    // A data refresh hands back a new, shorter phases array.  The settled
    // phase's expansion lives in a name set (not the array), so it survives
    // the swap, and the stale selection clamps to the new range on render.
    phases = [
      { name: "Done", tasks: [completed("t1")] },
      pendingPhase("Open", ["p1"]),
    ];
    const lines = w.render(80);
    assert.ok(
      lines.some((l) => l.includes("t1")),
      `expansion must survive a refresh: ${lines.join("\n")}`,
    );
    const banded = lines.filter((l) => l.includes("<selectedBg>"));
    assert.equal(banded.length, 1, banded.join("\n"));
    assert.ok(
      banded[0].includes("p1"),
      `clamped to the last row: ${banded[0]}`,
    );
    w.dispose();
  });

  it("resets the focus to the fleet on collapse", () => {
    const { deps } = depsOf({
      getTodoPhases: () => [pendingPhase("A", ["t1", "t2"])],
    });
    const w = createFleetWidget(deps);
    w.attach(tuiOf().tui, THEME);
    seedRun("r0", 0, "beaver");
    seedRun("r1", 1000, "lynx");
    w.handleKey("\u001b[B");
    w.handleKey("\t"); // focus the todo column
    w.handleKey("\u001b"); // collapse resets the focus
    assert.equal(w.render(80).length, 1);

    w.handleKey("\u001b[B"); // re-expand on the fleet column
    w.handleKey("j"); // fleet selection moves to r1
    const band = w.render(80).find((l) => l.includes("<selectedBg>"));
    assert.ok(band?.includes("lynx"), w.render(80).join("\n"));

    w.handleKey("\u001b"); // collapse
    assert.equal(w.handleKey("\t"), undefined, "tab is inert while collapsed");
    w.dispose();
  });
});

// ---------------------------------------------------------------------------
// Dual-column: layout
// ---------------------------------------------------------------------------

describe("fleet widget — dual-column layout", () => {
  it("renders a full-width header above the joined columns on a wide terminal", () => {
    const { deps } = depsOf({
      getTodoPhases: () => [pendingPhase("A", ["t1", "t2", "t3"])],
    });
    const w = createFleetWidget(deps);
    w.attach(tuiOf().tui, THEME);
    seedRun("r0", 0);
    w.handleKey("\u001b[B");

    const width = 120;
    const lines = w.render(width);
    assert.ok(lines.length > 2, lines.join("\n"));
    // The shared header spans the whole width as the first two rows, with no
    // column separator bleeding into it.
    for (const line of lines.slice(0, 2)) {
      assert.equal(visibleWidth(line), width, line);
      assert.ok(!line.includes("│"), line);
    }
    assert.ok(lines[0].includes("<c>dolphin</c>"), lines[0]);
    assert.ok(lines[1].includes("select"), lines[1]);
    // Every column body row below the header carries the separator and
    // fills the full width.
    for (const line of lines.slice(2)) {
      assert.equal(visibleWidth(line), width, line);
      assert.ok(line.includes("│"), line);
    }
    w.dispose();
  });

  it("mentions tab in the hint only when the todo column is present", () => {
    const dual = createFleetWidget(
      depsOf({
        getTodoPhases: () => [pendingPhase("A", ["t1"])],
        enterRun: () => false,
      }).deps,
    );
    const single = createFleetWidget(depsOf().deps);
    dual.attach(tuiOf().tui, THEME);
    single.attach(tuiOf().tui, THEME);
    seedRun("r0", 0);
    dual.handleKey("\u001b[B");
    single.handleKey("\u001b[B");

    const dualLines = dual.render(120);
    assert.ok(
      dualLines.some((l) => l.includes("tab switch")),
      dualLines.join("\n"),
    );
    assert.ok(
      !single.render(120).some((l) => l.includes("tab switch")),
      single.render(120).join("\n"),
    );
    dual.dispose();
    single.dispose();
  });

  it("stacks the fleet above the todo list on a narrow terminal", () => {
    const { deps } = depsOf({
      getTodoPhases: () => [pendingPhase("A", ["t1", "t2"])],
    });
    const w = createFleetWidget(deps);
    w.attach(tuiOf().tui, THEME);
    seedRun("r0", 0);
    w.handleKey("\u001b[B");

    const lines = w.render(80);
    const fleetIndex = lines.findIndex((l) => l.includes("<c>lynx</c>"));
    const todoIndex = lines.findIndex((l) => l.includes("t1"));
    // The shared header renders first (title then hint), above the fleet body
    // and the todo body.
    assert.ok(lines[0].includes("<c>dolphin</c>"), lines[0]);
    assert.ok(lines[1].includes("↑↓/jk"), lines[1]);
    assert.ok(fleetIndex >= 2, lines.join("\n"));
    assert.ok(todoIndex > fleetIndex, lines.join("\n"));
    assert.ok(
      !lines.some((l) => l.includes("│")),
      "stacked layout draws no column separator",
    );
    assert.ok(
      lines.length <= FLEET_MAX_LINES,
      `stacked layout must stay within the ${FLEET_MAX_LINES}-line budget`,
    );
    w.dispose();
  });

  it("shares one left edge for every narrow-mode row", () => {
    const { deps } = depsOf({
      getTodoPhases: () => [pendingPhase("A", ["t1", "t2"])],
    });
    const w = createFleetWidget(deps);
    w.attach(tuiOf().tui, THEME);
    for (let i = 0; i < 10; i++) seedRun(`r${i}`, i * 1000);
    w.handleKey("\u001b[B");
    w.handleKey("j"); // r1
    w.handleKey("j"); // r2 — both fleet indicators in view

    const lines = w.render(80);
    // Title, hint, fleet rows, the ↑/↓ indicators, and the stacked todo rows
    // all begin at column 0 — no row carries the legacy two-space indent.
    for (const line of lines) {
      assert.ok(
        !line.startsWith(" "),
        `row must be flush-left: ${JSON.stringify(line)}`,
      );
    }
    assert.ok(
      lines.some((l) => l.includes("↑ ")),
      lines.join("\n"),
    );
    assert.ok(
      lines.some((l) => l.includes("↓ ")),
      lines.join("\n"),
    );
    assert.ok(
      lines.some((l) => l.includes("t1")),
      lines.join("\n"),
    );
    w.dispose();
  });

  it("keeps both wide columns flush to their own left edge", () => {
    const { deps } = depsOf({
      getTodoPhases: () => [pendingPhase("A", ["t1", "t2"])],
    });
    const w = createFleetWidget(deps);
    w.attach(tuiOf().tui, THEME);
    // Three runs give the left column the same height as the right column,
    // so every joined row carries content on both sides.
    seedRun("r0", 0);
    seedRun("r1", 1000);
    seedRun("r2", 2000);
    w.handleKey("\u001b[B");

    const lines = w.render(120);
    // The full-width header is flush-left too.
    assert.ok(!lines[0].startsWith(" "), JSON.stringify(lines[0]));
    assert.ok(!lines[1].startsWith(" "), JSON.stringify(lines[1]));
    for (const line of lines.slice(2)) {
      const at = line.indexOf(" │ ");
      assert.ok(at > 0, line);
      assert.notEqual(
        line[0],
        " ",
        `left column content must be flush: ${JSON.stringify(line)}`,
      );
      const right = line.slice(at + 3);
      assert.notEqual(
        right[0],
        " ",
        `right column content must be flush: ${JSON.stringify(line)}`,
      );
    }
    w.dispose();
  });

  it("uses the compact hint in narrow mode and respects its conditionals", () => {
    const withTodo = createFleetWidget(
      depsOf({
        getTodoPhases: () => [pendingPhase("A", ["t1"])],
        enterRun: () => false,
      }).deps,
    );
    const withoutTodo = createFleetWidget(
      depsOf({ enterRun: () => false }).deps,
    );
    const withoutEnter = createFleetWidget(
      depsOf({ getTodoPhases: () => [pendingPhase("A", ["t1"])] }).deps,
    );
    seedRun("r0", 0);
    for (const w of [withTodo, withoutTodo, withoutEnter]) {
      w.attach(tuiOf().tui, THEME);
      w.handleKey("\u001b[B");
    }

    // Narrow: compact segments, each conditional respected.
    assert.ok(
      withTodo.render(80)[1].includes("↑↓/jk · tab · enter · esc"),
      withTodo.render(80)[1],
    );
    const narrowNoTodo = withoutTodo.render(80)[1];
    assert.ok(!narrowNoTodo.includes("tab"), narrowNoTodo);
    assert.ok(narrowNoTodo.includes("↑↓/jk · enter · esc"), narrowNoTodo);
    const narrowNoEnter = withoutEnter.render(80)[1];
    assert.ok(!narrowNoEnter.includes("enter"), narrowNoEnter);
    assert.ok(narrowNoEnter.includes("↑↓/jk · tab · esc"), narrowNoEnter);

    // Wide: the full hint text is unchanged.
    assert.ok(
      withTodo
        .render(120)[1]
        .includes("↑↓/jk select · tab switch · enter inspect · esc back"),
      withTodo.render(120)[1],
    );
    for (const w of [withTodo, withoutTodo, withoutEnter]) w.dispose();
  });

  it("treats a task-less phase shell as no todo column", () => {
    // A plan whose phases hold no tasks projects zero rows, so it must be
    // indistinguishable from the no-todo single-column widget: hidden from
    // the collapsed line, from the ` · tab switch` hint, and from `tab`
    // routing (focusing it would move the band onto nothing).
    const { deps } = depsOf({
      getTodoPhases: () => [{ name: "Empty", tasks: [] }],
    });
    const { deps: plainDeps } = depsOf();
    seedRun("r0", 0, "lynx");
    const w = createFleetWidget(deps);
    const plain = createFleetWidget(plainDeps);
    w.attach(tuiOf().tui, THEME);
    plain.attach(tuiOf().tui, THEME);

    // Collapsed: byte-identical to the plain single-column widget.
    assert.deepEqual(w.render(120), plain.render(120));

    w.handleKey("\u001b[B");
    plain.handleKey("\u001b[B");
    const lines = w.render(120);
    assert.deepEqual(lines, plain.render(120));
    assert.ok(!lines.some((l) => l.includes("tab switch")), lines.join("\n"));
    assert.ok(!lines.some((l) => l.includes("\u2502")), lines.join("\n"));

    // `tab` stays on the fleet column: the todo column is not focusable.
    assert.deepEqual(w.handleKey("\t"), { consume: true });
    const banded = w.render(120).filter((l) => l.includes("<selectedBg>"));
    assert.equal(banded.length, 1, banded.join("\n"));
    assert.ok(banded[0].includes("lynx"), banded[0]);
    w.dispose();
    plain.dispose();
  });

  it("renders the fleet column alone when the todo list is empty (wide)", () => {
    const { deps } = depsOf({ getTodoPhases: () => [] });
    const { deps: plainDeps } = depsOf();
    seedRun("r0", 0, "lynx");
    const w = createFleetWidget(deps);
    const plain = createFleetWidget(plainDeps);
    w.attach(tuiOf().tui, THEME);
    plain.attach(tuiOf().tui, THEME);
    w.handleKey("\u001b[B");
    plain.handleKey("\u001b[B");

    const lines = w.render(120);
    assert.ok(!lines.some((l) => l.includes("\u2502")), lines.join("\n"));
    assert.ok(!lines.some((l) => l.includes("\u5f85\u529e")), lines.join("\n"));
    // Byte-identical to the pre-dual-column widget (no todo source wired).
    assert.deepEqual(lines, plain.render(120));
    w.dispose();
    plain.dispose();
  });

  it("renders the fleet column alone when the todo list is empty (narrow)", () => {
    const { deps } = depsOf({ getTodoPhases: () => [] });
    const { deps: plainDeps } = depsOf();
    seedRun("r0", 0, "lynx");
    const w = createFleetWidget(deps);
    const plain = createFleetWidget(plainDeps);
    w.attach(tuiOf().tui, THEME);
    plain.attach(tuiOf().tui, THEME);
    w.handleKey("\u001b[B");
    plain.handleKey("\u001b[B");

    const lines = w.render(80);
    assert.ok(!lines.some((l) => l.includes("\u2502")), lines.join("\n"));
    assert.ok(!lines.some((l) => l.includes("\u5f85\u529e")), lines.join("\n"));
    assert.deepEqual(lines, plain.render(80));
    w.dispose();
    plain.dispose();
  });

  it("keeps the stacked overflow within the budget with both indicators", () => {
    const { deps } = depsOf({
      getTodoPhases: () => [
        pendingPhase(
          "A",
          Array.from({ length: 12 }, (_, i) => `t${i + 1}`),
        ),
      ],
    });
    const w = createFleetWidget(deps);
    w.attach(tuiOf().tui, THEME);
    for (let i = 0; i < 10; i++) seedRun(`r${i}`, i * 1000);
    for (const parent of ["r2", "r5", "r8"]) {
      startRun({
        id: `c-${parent}`,
        agent: "lynx",
        parentSession: `child-${parent}`,
        startedAt: 1000,
      });
      finishRun(parent, { status: "done", childSession: `child-${parent}` });
    }
    w.handleKey("\u001b[B"); // expand, selects r0
    w.handleKey("j"); // r1
    w.handleKey("j"); // r2 → both ↑ and ↓ indicators visible

    const lines = w.render(80);
    assert.ok(
      lines.length <= FLEET_MAX_LINES,
      `lines=${lines.length} exceeds the ${FLEET_MAX_LINES}-line budget`,
    );
    assert.ok(
      lines.some((l) => l.includes("↑ ")),
      `↑ indicator must survive: ${lines.join("\n")}`,
    );
    assert.ok(
      lines.some((l) => l.includes("↓ ")),
      `↓ indicator must survive: ${lines.join("\n")}`,
    );
    w.dispose();
  });

  it("renders an 8-row todo plan fully in wide mode (body budget)", () => {
    const { deps } = depsOf({
      getTodoPhases: () => [
        pendingPhase(
          "A",
          Array.from({ length: 7 }, (_, i) => `t${i + 1}`),
        ),
      ],
    });
    const w = createFleetWidget(deps);
    w.attach(tuiOf().tui, THEME);
    seedRun("r0", 0, "lynx");
    w.handleKey("\u001b[B");

    // header + 7 tasks = 8 projected rows; the wide body budget is
    // FLEET_MAX_LINES - header = 8, so every row renders with no overflow.
    const lines = w.render(120);
    assert.equal(lines.length, FLEET_MAX_LINES, lines.join("\n"));
    for (let i = 1; i <= 7; i++) {
      assert.ok(
        lines.some((l) => l.includes(`t${i}`)),
        lines.join("\n"),
      );
    }
    assert.ok(!lines.some((l) => l.includes("more")), lines.join("\n"));
    w.dispose();
  });

  it("renders a 10-row todo-only plan fully (whole budget)", () => {
    const { deps } = depsOf({
      getPrimary: () => undefined,
      getTodoPhases: () => [
        pendingPhase(
          "A",
          Array.from({ length: 9 }, (_, i) => `t${i + 1}`),
        ),
      ],
    });
    const w = createFleetWidget(deps);
    w.attach(tuiOf().tui, THEME);
    w.handleKey("\u001b[B");

    // No fleet column and no header: the todo column owns the whole
    // FLEET_MAX_LINES budget (header + 9 tasks = 10 projected rows).
    const lines = w.render(120);
    assert.equal(lines.length, FLEET_MAX_LINES, lines.join("\n"));
    for (let i = 1; i <= 9; i++) {
      assert.ok(
        lines.some((l) => l.includes(`t${i}`)),
        lines.join("\n"),
      );
    }
    assert.ok(!lines.some((l) => l.includes("more")), lines.join("\n"));
    w.dispose();
  });
});

// ---------------------------------------------------------------------------
// Dual-column: todo spinner clock
// ---------------------------------------------------------------------------

describe("fleet widget — todo spinner clock", () => {
  it("keeps the timer running for an in-progress todo and animates its glyph", () => {
    const phases: TodoPhase[] = [
      {
        name: "A",
        tasks: [
          { content: "w1", status: "in_progress" },
          { content: "p1", status: "pending" },
        ],
      },
    ];
    const { deps, t } = depsOf({ getTodoPhases: () => phases });
    const w = createFleetWidget(deps);
    w.attach(tuiOf().tui, THEME);
    // The collapsed todo summary has no animated element, so an in-progress
    // task alone must not keep the shared clock alive.
    assert.equal(
      t.activeCount(),
      0,
      "collapsed with only an in-progress todo runs no timer",
    );

    w.handleKey("\u001b[B"); // expand
    assert.equal(t.activeCount(), 1, "the expanded todo spinner runs");
    assert.ok(
      w.render(80).some((l) => l.includes(SPINNER_FRAMES[0])),
      w.render(80).join("\n"),
    );
    t.advance(150);
    assert.ok(
      w.render(80).some((l) => l.includes(SPINNER_FRAMES[1])),
      w.render(80).join("\n"),
    );
    w.dispose();
  });
});
