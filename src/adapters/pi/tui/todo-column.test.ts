/**
 * Tests for the pi dual-column todo column renderer (`todo-column.ts`).
 *
 * Boundary: the two pi-facing renderers observed at their returned strings.
 * The row semantics are the core view model's single projection (`todoLines`)
 * and `collapsedSummaryLine`; these tests assert the column's own
 * responsibilities — hue colorization,
 * spinner-frame substitution, completed-row strike styling, the focused-row
 * background band, the `+N more` cap, the empty-plan placeholder, and width
 * truncation measured with pi-tui's `visibleWidth`.  `maxRows` is an explicit
 * input here (the column owns no height opinion), so every expanded call
 * passes the test budget below.
 *
 * The fake theme wraps colors as `<color>…</color>`, the background band as
 * `<selectedBg>…</selectedBg>`, and strikethrough as `~…~`, matching the
 * conventions the fleet widget and todo card tests use.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { SPINNER_FRAMES } from "../../../core/display.js";
import type { TodoPhase } from "../../../core/todo/types.js";
import {
  renderTodoCollapsed,
  renderTodoColumn,
  type TodoColumnThemeLike,
} from "./todo-column.js";

/** Fake theme: fg/bg wrap with the color name, strikethrough with `~`. */
const THEME: TodoColumnThemeLike = {
  fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
  bg: (color: string, text: string) => `<${color}>${text}</${color}>`,
  strikethrough: (text: string) => `~${text}~`,
};

/** The expanded column's row budget the tests exercise. */
const BUDGET = 7;

/** The empty-plan placeholder text the column emits. */
const PLACEHOLDER = "待办 —";

/** A phase holding the given task contents, all pending. */
function pendingPhase(name: string, contents: readonly string[]): TodoPhase {
  return {
    name,
    tasks: contents.map((content) => ({ content, status: "pending" as const })),
  };
}

describe("renderTodoColumn — empty plan", () => {
  it("renders a single muted 待办 — placeholder row", () => {
    const rows = renderTodoColumn([], {
      width: 40,
      frame: 0,
      focused: false,
      theme: THEME,
      maxRows: BUDGET,
    });

    assert.equal(rows.length, 1);
    assert.ok(
      rows[0].includes(`<dim>${PLACEHOLDER}</dim>`),
      `muted placeholder expected: ${rows[0]}`,
    );
  });
});

describe("renderTodoColumn — expanded rows", () => {
  it("caps at the budget with a +N more overflow row last", () => {
    const phases: TodoPhase[] = [
      pendingPhase(
        "A",
        Array.from({ length: 10 }, (_, i) => `t${i + 1}`),
      ),
    ];
    // header + 10 tasks = 11 projected rows; budget 7 keeps 6 + overflow.
    const rows = renderTodoColumn(phases, {
      width: 40,
      frame: 0,
      focused: false,
      theme: THEME,
      maxRows: BUDGET,
    });

    assert.equal(rows.length, 7);
    assert.ok(
      rows[6].includes("+5 more"),
      `overflow row expected last: ${rows.join(" | ")}`,
    );
    assert.ok(
      rows.slice(0, 6).every((row) => !row.includes("more")),
      `only the last row overflows: ${rows.join(" | ")}`,
    );
  });

  it("keeps the blocked row's embedded blocker note", () => {
    const phases: TodoPhase[] = [
      {
        name: "A",
        tasks: [
          { content: "b1", status: "blocked", blocker: "等用户确认" },
          { content: "p1", status: "pending" },
        ],
      },
    ];
    const rows = renderTodoColumn(phases, {
      width: 40,
      frame: 0,
      focused: false,
      theme: THEME,
      maxRows: BUDGET,
    });

    assert.ok(
      rows.some((row) => row.includes("<warning>● b1 — 等用户确认</warning>")),
      `blocked note expected: ${rows.join(" | ")}`,
    );
  });

  it("strikes a completed row inside its success hue", () => {
    const phases: TodoPhase[] = [
      {
        name: "A",
        tasks: [
          { content: "c1", status: "completed" },
          { content: "p1", status: "pending" },
        ],
      },
    ];
    const rows = renderTodoColumn(phases, {
      width: 40,
      frame: 0,
      focused: false,
      theme: THEME,
      maxRows: BUDGET,
    });

    assert.ok(
      rows.some((row) => row.includes("<success>● ~c1~</success>")),
      `struck-through success row expected: ${rows.join(" | ")}`,
    );
  });

  it("collapses a settled phase to its header by default", () => {
    const phases: TodoPhase[] = [
      {
        name: "Done",
        tasks: [
          { content: "t1", status: "completed" },
          { content: "t2", status: "completed" },
          { content: "t3", status: "completed" },
        ],
      },
    ];
    const rows = renderTodoColumn(phases, {
      width: 40,
      frame: 0,
      focused: false,
      theme: THEME,
      maxRows: BUDGET,
    });

    // Header only: settled tasks stay hidden until the phase is expanded.
    assert.equal(rows.length, 1, rows.join(" | "));
    assert.ok(rows[0].includes("Done"), rows.join(" | "));
    assert.ok(!rows[0].includes("t1"), rows.join(" | "));
  });

  it("renders a settled phase's struck tasks when foldOverrides expands it", () => {
    const phases: TodoPhase[] = [
      {
        name: "Done",
        tasks: [
          { content: "t1", status: "completed" },
          { content: "t2", status: "completed" },
          { content: "t3", status: "completed" },
        ],
      },
    ];
    const rows = renderTodoColumn(phases, {
      width: 40,
      frame: 0,
      focused: false,
      theme: THEME,
      maxRows: BUDGET,
      foldOverrides: new Map([["Done", true]]),
    });

    // header + three struck task rows (fits the 7-row budget).
    assert.equal(rows.length, 4, rows.join(" | "));
    assert.ok(rows[0].includes("Done"), rows.join(" | "));
    for (const id of ["t1", "t2", "t3"]) {
      assert.ok(
        rows.some((row) => row.includes(`<success>● ~${id}~</success>`)),
        `struck ${id} expected: ${rows.join(" | ")}`,
      );
    }
  });

  it("collapses an open phase to its header when foldOverrides folds it", () => {
    const phases: TodoPhase[] = [
      {
        name: "Busy",
        tasks: [
          { content: "t1", status: "in_progress" },
          { content: "t2", status: "pending" },
        ],
      },
    ];
    const rows = renderTodoColumn(phases, {
      width: 40,
      frame: 0,
      focused: false,
      theme: THEME,
      maxRows: BUDGET,
      foldOverrides: new Map([["Busy", false]]),
    });

    // Header only, carrying the collapsed fold glyph.
    assert.equal(rows.length, 1, rows.join(" | "));
    assert.ok(rows[0].includes("Busy"), rows.join(" | "));
    assert.ok(rows[0].includes("\u25b8"), rows.join(" | "));
    assert.ok(!rows[0].includes("t1"), rows.join(" | "));
  });

  it("changes an in-progress row's glyph with the frame", () => {
    const phases: TodoPhase[] = [
      {
        name: "A",
        tasks: [
          { content: "w1", status: "in_progress" },
          { content: "p1", status: "pending" },
        ],
      },
    ];
    const at = (frame: number): string[] =>
      renderTodoColumn(phases, {
        width: 40,
        frame,
        focused: false,
        theme: THEME,
        maxRows: BUDGET,
      });

    const first = at(0)[1];
    const next = at(1)[1];
    assert.notEqual(first, next);
    assert.ok(
      first.includes(SPINNER_FRAMES[0]),
      `frame 0 glyph expected: ${first}`,
    );
    assert.ok(
      next.includes(SPINNER_FRAMES[1]),
      `frame 1 glyph expected: ${next}`,
    );
  });

  it("bands the first row's background when focused", () => {
    const phases: TodoPhase[] = [pendingPhase("A", ["t1"])];
    const rows = renderTodoColumn(phases, {
      width: 60,
      frame: 0,
      focused: true,
      theme: THEME,
      maxRows: BUDGET,
    });

    assert.ok(
      rows[0].startsWith("<selectedBg>"),
      `focused first row expected a bg band: ${rows[0]}`,
    );
    assert.ok(
      !rows[1].includes("selectedBg"),
      `only the first row is banded: ${rows[1]}`,
    );
  });

  it("truncates every row to the column width", () => {
    const phases: TodoPhase[] = [
      {
        name: "VeryLongPhaseNameExceedingWidth",
        tasks: [
          {
            content: "a very long task content that overflows",
            status: "pending",
          },
        ],
      },
    ];
    const width = 12;
    const rows = renderTodoColumn(phases, {
      width,
      frame: 0,
      focused: false,
      theme: THEME,
      maxRows: BUDGET,
    });

    for (const row of rows) {
      assert.ok(
        visibleWidth(row) <= width,
        `row within ${width} columns: ${row}`,
      );
    }
  });
});

describe("renderTodoCollapsed — summary segment", () => {
  it("carries the done/total counts for a plan", () => {
    const phases: TodoPhase[] = [
      {
        name: "A",
        tasks: [
          { content: "c1", status: "completed" },
          { content: "p1", status: "pending" },
        ],
      },
    ];
    const line = renderTodoCollapsed(phases, { theme: THEME });

    assert.ok(line.includes("1/2 done"), `counts expected: ${line}`);
  });

  it("renders the muted 待办 — placeholder for an empty plan", () => {
    const line = renderTodoCollapsed([], { theme: THEME });

    assert.ok(
      line.includes(`<dim>${PLACEHOLDER}</dim>`),
      `muted placeholder expected: ${line}`,
    );
  });

  it("truncates to the given width", () => {
    const phases: TodoPhase[] = [
      {
        name: "A",
        tasks: [
          { content: "c1", status: "completed" },
          { content: "a very long current task name", status: "pending" },
        ],
      },
    ];
    const width = 14;
    const line = renderTodoCollapsed(phases, { theme: THEME, width });

    assert.ok(
      visibleWidth(line) <= width,
      `segment within ${width} columns: ${line}`,
    );
  });
});

describe("renderTodoColumn — scrolling selection", () => {
  /** A phase with the given number of pending tasks. */
  function manyTasks(count: number): TodoPhase[] {
    return [
      pendingPhase(
        "A",
        Array.from({ length: count }, (_, i) => `t${i + 1}`),
      ),
    ];
  }

  it("windows around the selected row and bands it when focused", () => {
    const phases = manyTasks(12);
    const rows = renderTodoColumn(phases, {
      width: 40,
      frame: 0,
      focused: true,
      theme: THEME,
      selectedIndex: 8,
      maxRows: 7,
    });

    assert.ok(rows.length <= 7, `within budget: ${rows.length}`);
    // The selection stays visible and carries the band.
    const banded = rows.find((row) => row.startsWith("<selectedBg>"));
    assert.ok(banded, rows.join(" | "));
    assert.ok(banded.includes("t8"), banded);
  });

  it("windows expanded settled rows so the band reaches the last task", () => {
    const phases: TodoPhase[] = [
      {
        name: "Done",
        tasks: [
          { content: "t1", status: "completed" },
          { content: "t2", status: "completed" },
          { content: "t3", status: "completed" },
        ],
      },
    ];
    const rows = renderTodoColumn(phases, {
      width: 40,
      frame: 0,
      focused: true,
      theme: THEME,
      selectedIndex: 3,
      maxRows: 7,
      foldOverrides: new Map([["Done", true]]),
    });

    // The selection sees the same expanded rows the render path emits, so
    // the band can land on the last enumerated closed task.
    assert.equal(rows.length, 4, rows.join(" | "));
    const banded = rows.find((row) => row.startsWith("<selectedBg>"));
    assert.ok(banded, rows.join(" | "));
    assert.ok(banded.includes("t3"), banded);
  });

  it("windows a settled plan collapsed to its header", () => {
    const tasks = Array.from({ length: 10 }, (_, i) => ({
      content: `t${i + 1}`,
      status: "completed" as const,
    }));
    const phases: TodoPhase[] = [{ name: "Done", tasks }];
    const rows = renderTodoColumn(phases, {
      width: 40,
      frame: 0,
      focused: false,
      theme: THEME,
      selectedIndex: 5,
      maxRows: 7,
    });

    // A settled phase collapses to one header row, so the clamped selection
    // can never land on a hidden closed row.
    assert.equal(rows.length, 1, rows.join(" | "));
    assert.ok(rows[0].includes("Done"), rows.join(" | "));
  });

  it("makes hidden rows discoverable with ↑/↓ indicators", () => {
    const rows = renderTodoColumn(manyTasks(12), {
      width: 40,
      frame: 0,
      focused: false,
      theme: THEME,
      selectedIndex: 5,
      maxRows: 5,
    });

    assert.ok(
      rows[0].includes("↑") && rows[0].includes("more"),
      `leading ↑ indicator expected: ${rows.join(" | ")}`,
    );
    assert.ok(
      rows[rows.length - 1].includes("↓") &&
        rows[rows.length - 1].includes("more"),
      `trailing ↓ indicator expected: ${rows.join(" | ")}`,
    );
    assert.ok(rows.length <= 5, `within budget: ${rows.length}`);
  });

  it("honors maxRows as the total output-row budget", () => {
    const rows = renderTodoColumn(manyTasks(30), {
      width: 40,
      frame: 0,
      focused: false,
      theme: THEME,
      selectedIndex: 10,
      maxRows: 3,
    });

    assert.ok(rows.length <= 3, `within budget: ${rows.length}`);
  });

  it("never exceeds a budget of 2 (one row + one combined indicator)", () => {
    // A mid-list selection hides rows on both sides; the column must merge
    // them into a single indicator so the output stays within two rows.
    const rows = renderTodoColumn(manyTasks(12), {
      width: 40,
      frame: 0,
      focused: false,
      theme: THEME,
      selectedIndex: 5,
      maxRows: 2,
    });

    assert.equal(rows.length, 2, `within budget: ${rows.length}`);
    assert.ok(
      rows.some((row) => row.includes("t5")),
      rows.join(" | "),
    );
    assert.ok(
      rows.some((row) => row.includes("↑") && row.includes("↓")),
      `combined indicator expected: ${rows.join(" | ")}`,
    );
  });

  it("emits only the selected row at a budget of 1", () => {
    const rows = renderTodoColumn(manyTasks(12), {
      width: 40,
      frame: 0,
      focused: false,
      theme: THEME,
      selectedIndex: 5,
      maxRows: 1,
    });

    assert.equal(rows.length, 1, `within budget: ${rows.length}`);
    assert.ok(rows[0].includes("t5"), rows[0]);
  });

  it("keeps the fixed-budget +N overflow row without a selection", () => {
    const rows = renderTodoColumn(manyTasks(10), {
      width: 40,
      frame: 0,
      focused: false,
      theme: THEME,
      maxRows: 4,
    });

    assert.equal(rows.length, 4);
    assert.ok(rows[3].includes("+"), rows.join(" | "));
  });
});
