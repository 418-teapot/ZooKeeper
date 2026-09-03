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
import {
  finishRun,
  resetRegistry,
  type SubagentRun,
  startRun,
} from "../../../core/subagent/registry.js";
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
      setInterval: t.setIntervalFn,
      clearInterval: t.clearIntervalFn,
      now: t.nowFn,
    },
    t,
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
    // Each count splits into a separator, a colored dot, and an uncolored
    // number — only the bare dot is wrapped, so the literal `● 1 ● 1` is
    // broken up by the color tags that enclose just the dots.
    assert.ok(line.includes("<success>●</success> 1 <error>●</error> 1"), line);
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
      calls.some((c) => c.color === "error" && c.text === "●"),
      `error dot must be wrapped standalone: ${calls.map((c) => `${c.color}:${c.text}`).join(" | ")}`,
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
    assert.ok(line.includes("<success>●</success> 1 <error>●</error> 1"), line);
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
    assert.ok(lines[1].includes("select"), lines[1]);
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

  it("moves the selection with ↓/j and ↑/k and reflects it in ▸", () => {
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
    const selectedLines = lines.filter((l) => l.includes("▸"));
    assert.equal(
      selectedLines.length,
      1,
      `expected one selected row: ${lines}`,
    );
    assert.ok(selectedLines[0].includes("lynx"), selectedLines[0]);
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
    const selected = lines.find((l) => l.includes("▸"));
    assert.ok(selected, `selected row must be in view: ${lines}`);
    assert.ok(
      lines.some((l) => l.includes("more")),
      "window indicators must appear",
    );
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
