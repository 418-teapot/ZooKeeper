/**
 * Tests for the ask-form dialog (`ask-dialog.ts`), driven headless.
 *
 * The dialog is exercised through its public component contract only —
 * `handleInput` key sequences in, `render(width)` lines and the `done`
 * outcome out — with a fake TUI, an identity theme (so text assertions
 * match literally), and injectable timers that let a test drive the
 * countdown expiry deterministically.
 *
 * Covered:
 *  - single-select answering (Enter commits, a single-question form closes);
 *  - multi-select toggle (Space) + confirm (Enter), and Enter with nothing
 *    selected being a no-op;
 *  - freeform answering (the embedded Editor's submit) and Esc handing the
 *    keyboard back to the list without declining;
 *  - the multi-question Esc semantics: answered preserved, every question
 *    the user was shown declined, the never-reached ones
 *    `unavailable("aborted")`;
 *  - countdown expiry, reset-on-keypress, and the ticked title;
 *  - external `abort()` / `dispose()`;
 *  - tab navigation, the Submit summary page, and submitting with gaps;
 *  - the recommended badge and the pre-positioned cursor;
 *  - render geometry: box borders at a constant visible width, the chip
 *    strip, the once-measured fixed height, and overflow scrolling;
 *  - the pure helpers (`rowsOf`, `initialCursor`, `pendingAnswer`,
 *    `buildResults`).
 *
 * @module
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { AskResult } from "../../../core/ask.js";
import {
  type AskDialogOutcome,
  type AskDialogQuestion,
  type AskDialogThemeLike,
  type AskDialogTimers,
  type AskDialogTuiLike,
  buildResults,
  createAskDialog,
  initialCursor,
  pendingAnswer,
  rowsOf,
} from "./ask-dialog.js";

// ---------------------------------------------------------------------------
// Key bytes (exactly the sequences pi-tui's matchesKey accepts)
// ---------------------------------------------------------------------------

const ESC = "\x1b";
const ENTER = "\r";
const SPACE = " ";
const UP = "\x1b[A";
const DOWN = "\x1b[B";
const RIGHT = "\x1b[C";
const LEFT = "\x1b[D";
const TAB = "\t";
const SHIFT_TAB = "\x1b[Z";

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

/** A TUI that counts render requests and reports a fixed geometry. */
function fakeTui(rows = 24): AskDialogTuiLike {
  return {
    requestRender() {},
    terminal: { rows, columns: 80 },
  };
}

/** An identity theme — no ANSI, so assertions match literal text. */
function fakeTheme(): AskDialogThemeLike {
  return {
    fg: (_color, text) => text,
    bold: (text) => text,
  };
}

/** The timer fake's inspection surface. */
interface FakeTimers {
  timers: AskDialogTimers;
  /** Live pending one-shots (the countdown expiry) — cleared ones are removed. */
  oneShots: { id: number; cb: () => void; at: number }[];
  /** Live pending intervals (the countdown tick). */
  ticks: { id: number; cb: () => void; at: number }[];
  /** Handles handed to clearTimeout / clearInterval. */
  cleared: unknown[];
  /** Move the fake clock forward, firing whatever became due. */
  advance(ms: number): void;
  /** Fire the earliest pending one-shot immediately. */
  fireTimeout(): void;
}

/** A virtual-clock timer surface (no wall time, no real scheduling). */
function fakeTimers(): FakeTimers {
  const oneShots: { id: number; cb: () => void; at: number }[] = [];
  const ticks: { id: number; cb: () => void; at: number }[] = [];
  const cleared: unknown[] = [];
  let nowMs = 0;
  let seq = 1;
  const drop = (
    list: { id: number }[],
    id: unknown,
  ): { id: number } | undefined => {
    const index = list.findIndex((entry) => entry.id === id);
    return index === -1 ? undefined : list.splice(index, 1)[0];
  };
  return {
    timers: {
      setTimeout(cb, ms) {
        const id = seq++;
        oneShots.push({ id, cb, at: nowMs + ms });
        return id;
      },
      clearTimeout(handle) {
        cleared.push(handle);
        drop(oneShots, handle);
      },
      setInterval(cb, ms) {
        const id = seq++;
        ticks.push({ id, cb, at: nowMs + ms });
        return id;
      },
      clearInterval(handle) {
        cleared.push(handle);
        drop(ticks, handle);
      },
      now: () => nowMs,
    },
    oneShots,
    ticks,
    cleared,
    advance(ms: number) {
      nowMs += ms;
      for (const entry of [...oneShots]) {
        if (entry.at <= nowMs && drop(oneShots, entry.id)) entry.cb();
      }
      for (const entry of [...ticks]) {
        if (entry.at <= nowMs) {
          entry.at = nowMs + 1000;
          entry.cb();
        }
      }
    },
    fireTimeout() {
      const entry = oneShots.shift();
      if (entry) entry.cb();
    },
  };
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/** A question with the core's normalization already applied. */
function q(
  question: string,
  options: string[],
  extra: {
    multiple?: boolean;
    allowFreeform?: boolean;
    recommended?: number;
  } = {},
): AskDialogQuestion {
  return {
    question,
    options: options.map((label) => ({ label })),
    multiple: extra.multiple ?? false,
    allowFreeform: extra.allowFreeform ?? true,
    ...(extra.recommended !== undefined
      ? { recommended: extra.recommended }
      : {}),
  };
}

interface Harness {
  /** Send one raw input chunk. */
  key(data: string): void;
  /** Send each character of `text` as its own input chunk. */
  type(text: string): void;
  /** Render at a width and join the lines. */
  text(width?: number): string;
  /** Render at a width and return the lines. */
  lines(width?: number): string[];
  /** The outcome handed to `done` (undefined while the form is open). */
  outcome(): AskDialogOutcome | undefined;
  /** Close the form from outside (the host's abort path). */
  abort(): void;
  timers: FakeTimers;
}

/** Mount a dialog headless with a fake TUI / theme / timers. */
function mount(
  questions: AskDialogQuestion[],
  opts: { timeoutSeconds?: number; rows?: number } = {},
): Harness {
  const timers = fakeTimers();
  let settled: AskDialogOutcome | undefined;
  const dialog = createAskDialog({
    questions,
    tui: fakeTui(opts.rows ?? 24),
    theme: fakeTheme(),
    timers: timers.timers,
    done: (outcome) => {
      settled = outcome;
    },
    ...(opts.timeoutSeconds !== undefined
      ? { timeoutSeconds: opts.timeoutSeconds }
      : {}),
  });
  return {
    key: (data) => dialog.component.handleInput(data),
    type: (text) => {
      for (const ch of text) dialog.component.handleInput(ch);
    },
    text: (width = 60) => dialog.component.render(width).join("\n"),
    lines: (width = 60) => dialog.component.render(width),
    outcome: () => settled,
    abort: () => dialog.abort(),
    timers,
  };
}

/** The answered result (a readable shorthand for the assertions). */
function answered(answer: string[], wasCustom = false): AskResult {
  return { status: "answered", answer, wasCustom };
}

const DECLINED: AskResult = { status: "declined" };
const ABORTED: AskResult = { status: "unavailable", reason: "aborted" };
const TIMED_OUT: AskResult = { status: "unavailable", reason: "timeout" };

/** Smallest panel the dialog will ever build (chrome + minimum body). */
const MIN_PANEL_ROWS_FOR_TEST = 8;

// ---------------------------------------------------------------------------
// Single-select
// ---------------------------------------------------------------------------

describe("ask dialog — single-select", () => {
  it("Enter on an option closes a single-question form with the answer", () => {
    const h = mount([q("Which DB?", ["SQLite", "Postgres"])]);
    assert.equal(h.outcome(), undefined);
    h.key(ENTER);
    assert.deepEqual(h.outcome(), {
      results: [answered(["SQLite"])],
      closure: "submit",
    });
  });

  it("the arrow keys move the cursor and the answer follows it", () => {
    const h = mount([q("Which DB?", ["SQLite", "Postgres"])]);
    h.key(DOWN);
    h.key(ENTER);
    assert.deepEqual(h.outcome()?.results, [answered(["Postgres"])]);
  });

  it("the cursor clamps at the last row (the freeform row)", () => {
    const h = mount([q("Which DB?", ["A", "B"])]);
    h.key(DOWN);
    h.key(DOWN);
    h.key(DOWN);
    h.key(ENTER);
    // The cursor sits on "Type something.": Enter opens the editor instead
    // of answering, so the form is still open with no result.
    assert.equal(h.outcome(), undefined);
    assert.match(h.text(), /Your answer:/);
  });

  it("the answered option keeps the filled radio glyph when revisited", () => {
    const h = mount([q("Which?", ["A", "B"]), q("And?", ["C"])]);
    h.key(ENTER); // answer Q1, advance to Q2
    h.key(SHIFT_TAB); // revisit Q1
    assert.match(h.text(), /◉ A/);
    assert.match(h.text(), /○ B/);
  });
});

// ---------------------------------------------------------------------------
// Multi-select
// ---------------------------------------------------------------------------

describe("ask dialog — multi-select", () => {
  it("Space toggles rows, Enter confirms in option order", () => {
    const h = mount([
      q("Pick fruits", ["Apple", "Banana", "Cherry"], { multiple: true }),
    ]);
    h.key(DOWN); // Banana
    h.key(SPACE);
    h.key(DOWN); // Cherry
    h.key(SPACE);
    h.key(UP);
    h.key(SPACE); // un-toggle Banana
    h.key(DOWN);
    h.key(ENTER);
    assert.deepEqual(h.outcome()?.results, [answered(["Cherry"])]);
  });

  it("Enter with nothing selected is a no-op", () => {
    const h = mount([
      q("Pick fruits", ["Apple", "Banana"], { multiple: true }),
    ]);
    h.key(ENTER);
    assert.equal(h.outcome(), undefined);
  });

  it("checked rows render checkboxes, unchecked rows the empty one", () => {
    const h = mount([q("Pick", ["Apple", "Banana"], { multiple: true })]);
    assert.match(h.text(), /☐ Apple/);
    h.key(SPACE);
    assert.match(h.text(), /☑ Apple/);
    assert.match(h.text(), /☐ Banana/);
  });

  it("single-select rows use radio glyphs, never checkboxes", () => {
    const h = mount([q("Pick", ["Apple"])]);
    assert.match(h.text(), /○ Apple/);
    assert.doesNotMatch(h.text(), /[☐☑]/);
  });
});

// ---------------------------------------------------------------------------
// Freeform
// ---------------------------------------------------------------------------

describe("ask dialog — freeform", () => {
  it("the freeform row is last and opens the embedded editor", () => {
    const h = mount([q("Which?", ["A", "B"])]);
    h.key(DOWN);
    h.key(DOWN);
    assert.match(h.text(), /> ○ Type something\./);
    h.key(ENTER);
    assert.match(h.text(), /Type something\. \[edit]/);
    assert.match(h.text(), /Your answer:/);
  });

  it("the freeform input stays inside the window on a clipped page", () => {
    const many = q(
      "Long question?",
      Array.from({ length: 30 }, (_unused, i) => `Option ${i}`),
    );
    const h = mount([many], { rows: 20 });
    for (let i = 0; i < 30; i++) h.key(DOWN); // walk to the freeform row
    h.key(ENTER);
    h.type("typed answer");
    const view = h.text(60);
    assert.match(view, /Your answer:/);
    assert.match(view, /typed answer/);
    h.key(ENTER);
    assert.deepEqual(h.outcome()?.results, [answered(["typed answer"], true)]);
  });

  it("typing then Enter submits the custom answer", () => {
    const h = mount([q("Which?", ["A"])]);
    h.key(DOWN);
    h.key(ENTER);
    h.type("sqlite it is");
    h.key(ENTER);
    assert.deepEqual(h.outcome()?.results, [answered(["sqlite it is"], true)]);
  });

  it("a question with no candidates goes straight to freeform", () => {
    const h = mount([q("What went wrong?", [])]);
    h.key(ENTER); // the only row is the freeform row
    h.type("the tests failed");
    h.key(ENTER);
    assert.deepEqual(h.outcome()?.results, [
      answered(["the tests failed"], true),
    ]);
  });

  it("Esc inside the editor returns to the list without declining", () => {
    const h = mount([q("Which?", ["A"])]);
    h.key(DOWN);
    h.key(ENTER);
    h.type("draft");
    h.key(ESC);
    assert.equal(h.outcome(), undefined);
    assert.doesNotMatch(h.text(), /Your answer:/);
    // Back on the list the draft is gone, and a real answer still works.
    h.key(UP);
    h.key(ENTER);
    assert.deepEqual(h.outcome()?.results, [answered(["A"])]);
  });

  it("a second Esc from the list declines", () => {
    const h = mount([q("Which?", ["A"])]);
    h.key(DOWN);
    h.key(ENTER);
    h.key(ESC);
    h.key(ESC);
    assert.deepEqual(h.outcome()?.results, [DECLINED]);
  });

  it("a blank submit keeps the user in the editor", () => {
    const h = mount([q("Which?", ["A"])]);
    h.key(DOWN);
    h.key(ENTER);
    h.key(SPACE);
    h.key(ENTER);
    assert.equal(h.outcome(), undefined);
    assert.match(h.text(), /Your answer:/);
  });
});

// ---------------------------------------------------------------------------
// Multi-question navigation
// ---------------------------------------------------------------------------

describe("ask dialog — multi-question form", () => {
  const three = (): AskDialogQuestion[] => [
    q("One?", ["A1", "B1"]),
    q("Two?", ["A2", "B2"]),
    q("Three?", ["A3", "B3"]),
  ];

  it("answering advances to the next question, then to the Submit page", () => {
    const h = mount(three());
    h.key(ENTER);
    assert.match(h.text(), /Two\?/);
    h.key(ENTER);
    assert.match(h.text(), /Three\?/);
    h.key(ENTER);
    assert.match(h.text(), /Review/);
    h.key(ENTER);
    assert.deepEqual(h.outcome()?.results, [
      answered(["A1"]),
      answered(["A2"]),
      answered(["A3"]),
    ]);
  });

  it("Tab / Right move forward and Enter on the summary submits", () => {
    const h = mount(three());
    h.key(TAB);
    assert.match(h.text(), /Two\?/);
    h.key(RIGHT);
    h.key(RIGHT);
    assert.match(h.text(), /Review/);
    h.key(ENTER);
    assert.deepEqual(h.outcome()?.results, [DECLINED, DECLINED, DECLINED]);
  });

  it("Shift+Tab / Left move backward with wrap-around", () => {
    const h = mount(three());
    h.key(SHIFT_TAB);
    assert.match(h.text(), /Review/);
    h.key(LEFT);
    assert.match(h.text(), /Three\?/);
  });

  it("the Submit summary lists answers and warns about the gaps", () => {
    const h = mount(three());
    h.key(ENTER); // Q1 = A1
    h.key(TAB); // skip Q2, land on Q3
    h.key(ENTER); // Q3 = A3
    assert.match(h.text(), /Review/);
    const view = h.text();
    assert.match(view, /Q1: A1/);
    assert.match(view, /Q2: declined/);
    assert.match(view, /Q3: A3/);
    assert.match(view, /1 question\(s\) unanswered/);
    h.key(ENTER);
    assert.deepEqual(h.outcome()?.results, [
      answered(["A1"]),
      DECLINED,
      answered(["A3"]),
    ]);
  });

  it("a committed answer survives revisiting the page and toggling", () => {
    const h = mount(three());
    h.key(ENTER); // Q1 = A1
    h.key(SHIFT_TAB); // back to Q1
    h.key(DOWN); // cursor on B1
    h.key(ENTER); // re-commit Q1 = B1
    h.key(ENTER); // Q2 = A2
    h.key(ENTER); // Q3 = A3
    h.key(ENTER); // submit
    assert.deepEqual(h.outcome()?.results, [
      answered(["B1"]),
      answered(["A2"]),
      answered(["A3"]),
    ]);
  });

  it("the footer hint switches with the active mode", () => {
    const h = mount([
      q("Pick", ["A", "B"], { multiple: true }),
      q("And?", ["C"]),
    ]);
    assert.match(h.text(), /Space toggle/);
    h.key(TAB); // Q2 — single-select
    assert.match(h.text(), /Enter select/);
    h.key(TAB); // Submit page
    assert.match(h.text(), /Enter submit/);
    h.key(TAB); // wrap to Q1, then open the freeform editor
    h.key(DOWN);
    h.key(DOWN);
    h.key(ENTER);
    assert.match(h.text(), /Esc back/);
  });
});

// ---------------------------------------------------------------------------
// Closing slots: Esc / timeout / abort
// ---------------------------------------------------------------------------

describe("ask dialog — closing slots", () => {
  it("Esc keeps answers, declines the active question, aborts the rest", () => {
    const h = mount([
      q("One?", ["A1"]),
      q("Two?", ["A2"]),
      q("Three?", ["A3"]),
    ]);
    h.key(ENTER); // Q1 answered, active = Q2
    h.key(ESC);
    assert.deepEqual(h.outcome()?.results, [
      answered(["A1"]),
      DECLINED,
      ABORTED,
    ]);
    assert.equal(h.outcome()?.closure, "cancel");
  });

  it("Esc declines the questions paged onto and aborts the unseen ones", () => {
    const h = mount([
      q("One?", ["A1"]),
      q("Two?", ["A2"]),
      q("Three?", ["A3"]),
    ]);
    h.key(TAB); // Q2 is shown (unanswered), Q3 never is
    h.key(ESC);
    assert.deepEqual(h.outcome()?.results, [DECLINED, DECLINED, ABORTED]);
    assert.equal(h.outcome()?.closure, "cancel");
  });

  it("Esc without any paging declines only the first question", () => {
    const h = mount([
      q("One?", ["A1"]),
      q("Two?", ["A2"]),
      q("Three?", ["A3"]),
    ]);
    h.key(ESC);
    assert.deepEqual(h.outcome()?.results, [DECLINED, ABORTED, ABORTED]);
  });

  it("Esc from the Submit page declines every question the user saw", () => {
    const h = mount([q("One?", ["A1"]), q("Two?", ["A2"])]);
    h.key(TAB); // Q2
    h.key(TAB); // the Submit page — seeing it is not seeing a question
    h.key(ESC);
    assert.deepEqual(h.outcome()?.results, [DECLINED, DECLINED]);
    assert.equal(h.outcome()?.closure, "cancel");
  });

  it("the timeout still aborts every unanswered question, seen or not", () => {
    const h = mount([q("One?", ["A1"]), q("Two?", ["A2"])], {
      timeoutSeconds: 5,
    });
    h.key(TAB); // Q2 shown, unanswered
    h.timers.fireTimeout();
    assert.deepEqual(h.outcome()?.results, [TIMED_OUT, TIMED_OUT]);
    assert.equal(h.outcome()?.closure, "timeout");
  });

  it("timeout keeps answers and marks every unanswered question timed out", () => {
    const h = mount([q("One?", ["A1"]), q("Two?", ["A2"])], {
      timeoutSeconds: 5,
    });
    h.key(ENTER); // Q1 answered, active = Q2
    h.timers.fireTimeout();
    assert.deepEqual(h.outcome()?.results, [answered(["A1"]), TIMED_OUT]);
    assert.equal(h.outcome()?.closure, "timeout");
  });

  it("any keypress restarts the countdown", () => {
    const h = mount([q("One?", ["A1"]), q("Two?", ["A2"])], {
      timeoutSeconds: 5,
    });
    const clearedBefore = h.timers.cleared.length;
    h.key(DOWN);
    assert.ok(
      h.timers.cleared.length > clearedBefore,
      "the pending expiry was cleared by the keypress",
    );
    h.timers.advance(4000);
    assert.equal(h.outcome(), undefined, "4s on a freshly reset 5s timer");
    h.timers.advance(2000);
    assert.equal(h.outcome()?.closure, "timeout");
  });

  it("abort() keeps answers, aborts the rest, and is idempotent", () => {
    const h = mount([q("One?", ["A1"]), q("Two?", ["A2"])]);
    h.key(ENTER);
    h.abort();
    const first = h.outcome();
    assert.deepEqual(first?.results, [answered(["A1"]), ABORTED]);
    h.key(ENTER);
    h.abort();
    assert.equal(h.outcome(), first);
  });

  it("dispose() stops the timers and ignores later input", () => {
    const timers = fakeTimers();
    let settled: AskDialogOutcome | undefined;
    const dialog = createAskDialog({
      questions: [q("One?", ["A1"])],
      tui: fakeTui(),
      theme: fakeTheme(),
      timers: timers.timers,
      timeoutSeconds: 5,
      done: (outcome) => {
        settled = outcome;
      },
    });
    const clearedBefore = timers.cleared.length;
    dialog.component.dispose();
    assert.ok(timers.cleared.length > clearedBefore);
    dialog.component.handleInput(ENTER);
    assert.equal(settled, undefined);
  });
});

// ---------------------------------------------------------------------------
// Recommended option
// ---------------------------------------------------------------------------

describe("ask dialog — recommended option", () => {
  it("the cursor starts on the recommended option and it carries a badge", () => {
    const h = mount([q("Which?", ["A", "B", "C"], { recommended: 1 })]);
    assert.match(h.text(), /> ○ B \(Recommended\)/);
    h.key(ENTER);
    assert.deepEqual(h.outcome()?.results, [answered(["B"])]);
  });

  it("the badge never leaks into the answer", () => {
    const h = mount([q("Which?", ["A"], { recommended: 0 })]);
    h.key(ENTER);
    assert.deepEqual(h.outcome()?.results, [answered(["A"])]);
  });

  it("an out-of-range recommendation clamps to the last option", () => {
    const h = mount([q("Which?", ["A", "B"], { recommended: 9 })]);
    h.key(ENTER);
    assert.deepEqual(h.outcome()?.results, [answered(["B"])]);
  });

  it("initialCursor defaults to the first row without a recommendation", () => {
    assert.equal(initialCursor(q("x", ["A", "B"])), 0);
    assert.equal(initialCursor(q("x", [], { recommended: 3 })), 0);
    assert.equal(initialCursor(q("x", ["A", "B"], { recommended: 1 })), 1);
  });
});

// ---------------------------------------------------------------------------
// Rendering / geometry
// ---------------------------------------------------------------------------

describe("ask dialog — rendering", () => {
  it("the panel draws a titled box with a footer hint", () => {
    const h = mount([q("Which?", ["A"])]);
    const lines = h.lines(60);
    assert.ok(lines[0].startsWith("╭─ Ask "), lines[0]);
    assert.ok(lines[0].endsWith("╮"), lines[0]);
    assert.ok(lines[lines.length - 1].startsWith("╰"));
    assert.ok(lines[lines.length - 1].endsWith("╯"));
    assert.match(lines.join("\n"), /Esc decline/);
  });

  it("every line has exactly the requested visible width", () => {
    const h = mount([q("Which?", ["A", "B", "C"])]);
    for (const line of h.lines(44)) {
      assert.equal(visibleWidth(line), 44, JSON.stringify(line));
    }
  });

  it("multi-question forms draw a chip strip with one chip per question", () => {
    const h = mount([q("One?", ["A"]), q("Two?", ["B"])]);
    const chips = h.lines(60)[1];
    assert.match(chips, /\[ Q1 ○ ]/);
    assert.match(chips, /Q2 ○/);
    assert.match(chips, /Submit \?/);
    h.key(ENTER); // answer Q1 -> chip becomes filled
    h.key(TAB); // back to Q1? no: forward to Q2
    assert.match(h.lines(60)[1], /●/);
  });

  it("a single-question form draws no chip strip", () => {
    const h = mount([q("One?", ["A"])]);
    assert.doesNotMatch(h.lines(60)[1], /Submit/);
    assert.match(h.lines(60)[1], /One\?/);
  });

  it("the countdown lives in the title and ticks down", () => {
    const h = mount([q("One?", ["A"])], { timeoutSeconds: 9 });
    assert.match(h.text(), /Ask \(9s\)/);
    h.timers.advance(1000);
    assert.match(h.text(), /Ask \(8s\)/);
  });

  it("no timeout means a plain title and no timer at all", () => {
    const h = mount([q("One?", ["A"])]);
    assert.match(h.text(), /╭─ Ask ─/);
    assert.equal(h.timers.oneShots.length, 0);
    assert.equal(h.timers.ticks.length, 0);
  });

  it("the panel height is measured once and never changes afterwards", () => {
    const h = mount([q("Short?", ["A"]), q("Long?", ["B", "C", "D"])]);
    const before = h.lines(60).length;
    h.key(TAB);
    assert.equal(h.lines(60).length, before);
    h.key(DOWN);
    h.key(DOWN);
    assert.equal(h.lines(60).length, before);
    // The box is never resized per tab, and it stays inside the clamp.
    assert.ok(before >= MIN_PANEL_ROWS_FOR_TEST, `before=${before}`);
    assert.ok(before <= Math.floor(24 * 0.7), `before=${before}`);
  });

  it("the panel clamps to the terminal-height fraction and scrolls", () => {
    const many = q(
      "Long question?",
      Array.from({ length: 30 }, (_unused, i) => `Option ${i}`),
    );
    const h = mount([many], { rows: 20 });
    assert.ok(h.lines(60).length <= Math.floor(20 * 0.7));
    assert.doesNotMatch(h.text(60), /Option 29/);
    for (let i = 0; i < 29; i++) h.key(DOWN);
    assert.match(h.text(60), /Option 29/);
    // Content is clipped on both sides of the window now.
    assert.match(h.text(60), /↕\s*│$/m);
  });

  it("long question and description text wrap inside the box", () => {
    const h = mount([
      {
        question: `W${"ord ".repeat(30)}?`,
        options: [{ label: "A", description: `d${"esc ".repeat(30)}` }],
        multiple: false,
        allowFreeform: true,
      },
    ]);
    for (const line of h.lines(50)) {
      assert.equal(visibleWidth(line), 50, JSON.stringify(line));
    }
  });
});

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe("ask dialog — pure helpers", () => {
  it("rowsOf appends the freeform row only when allowed", () => {
    assert.deepEqual(
      rowsOf(q("x", ["A"])).map((r) => r.kind),
      ["option", "other"],
    );
    assert.deepEqual(
      rowsOf(q("x", ["A"], { allowFreeform: false })).map((r) => r.kind),
      ["option"],
    );
    assert.deepEqual(
      rowsOf(q("x", [])).map((r) => r.kind),
      ["other"],
    );
  });

  it("pendingAnswer prefers option picks over a custom answer", () => {
    const question = q("x", ["A", "B"]);
    assert.equal(pendingAnswer(question, { selected: new Set() }), undefined);
    assert.deepEqual(
      pendingAnswer(question, { selected: new Set(["B"]) }),
      answered(["B"]),
    );
    assert.deepEqual(
      pendingAnswer(question, { selected: new Set(), custom: "typed" }),
      answered(["typed"], true),
    );
    assert.deepEqual(
      pendingAnswer(question, { selected: new Set(["A"]), custom: "typed" }),
      answered(["A"]),
    );
  });

  it("buildResults preserves committed slots and maps the closure", () => {
    const committed: (AskResult | undefined)[] = [
      answered(["A"]),
      undefined,
      undefined,
    ];
    assert.deepEqual(buildResults(committed, new Set([0, 1]), "cancel"), [
      answered(["A"]),
      DECLINED,
      ABORTED,
    ]);
    // A question the user was never shown is a system-side loss, not a
    // refusal, even when the form closes on Esc.
    assert.deepEqual(buildResults(committed, new Set([0]), "cancel"), [
      answered(["A"]),
      ABORTED,
      ABORTED,
    ]);
    assert.deepEqual(buildResults(committed, new Set(), "timeout"), [
      answered(["A"]),
      TIMED_OUT,
      TIMED_OUT,
    ]);
    assert.deepEqual(buildResults(committed, new Set([0, 1, 2]), "abort"), [
      answered(["A"]),
      ABORTED,
      ABORTED,
    ]);
    assert.deepEqual(buildResults(committed, new Set(), "submit"), [
      answered(["A"]),
      DECLINED,
      DECLINED,
    ]);
  });
});
