/**
 * Tests for the todo view model (`src/core/todo/view.ts`).
 *
 * Locks the host-agnostic display projections: the todo-domain mapping onto
 * the canonical presentation table (`../display.ts`), the single
 * enumerate-all view-row projection (phase order, blocked placement,
 * status-derived default folds with per-phase overrides), the `+N` overflow
 * row, and the single-line
 * collapsed summary.  Rows are asserted for their semantic fields (glyph,
 * hue, flags) only — concrete styling is never the model's concern.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { DisplayHue } from "../display.js";
import {
  FOLD_COLLAPSED,
  FOLD_EXPANDED,
  STATUS_PRESENTATION,
} from "../display.js";
import type { TodoPhase, TodoStatus } from "./types.js";
import type { TodoViewLine } from "./view.js";
import {
  collapsedSummaryLine,
  overflowLine,
  TODO_PRESENTATION,
  todoLines,
} from "./view.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** The set of allowed semantic hues. */
const HUES: readonly DisplayHue[] = [
  "running",
  "success",
  "error",
  "muted",
  "accent",
];

/** Build a phase object from [content, status] pairs. */
function phase(name: string, ...tasks: Array<[string, TodoStatus]>): TodoPhase {
  return {
    name,
    tasks: tasks.map(([content, status]) => ({ content, status })),
  };
}

/** The header row of a projected viewport, by phase index. */
function headerOf(
  lines: TodoViewLine[],
  index: number,
): Extract<TodoViewLine, { kind: "header" }> {
  const hit = lines.find(
    (line) => line.kind === "header" && line.index === index,
  );
  assert.ok(hit, `expected a header row for phase ${index}`);
  return hit as Extract<TodoViewLine, { kind: "header" }>;
}

/** The task rows of a projected viewport, in order. */
function tasksOf(
  lines: TodoViewLine[],
): Array<Extract<TodoViewLine, { kind: "task" }>> {
  return lines.filter(
    (line): line is Extract<TodoViewLine, { kind: "task" }> =>
      line.kind === "task",
  );
}

/** The overflow rows of a projected viewport, in order. */
function overflowsOf(
  lines: TodoViewLine[],
): Array<Extract<TodoViewLine, { kind: "overflow" }>> {
  return lines.filter(
    (line): line is Extract<TodoViewLine, { kind: "overflow" }> =>
      line.kind === "overflow",
  );
}

/** The content of a task row, by content text. */
function taskContent(
  lines: TodoViewLine[],
  content: string,
): string | undefined {
  return tasksOf(lines).find((line) => line.content === content)?.content;
}

/** The kinds of the projected rows, in emission order. */
function kindsOf(lines: TodoViewLine[]): TodoViewLine["kind"][] {
  return lines.map((line) => line.kind);
}

// ---------------------------------------------------------------------------
// TODO_PRESENTATION → STATUS_PRESENTATION
// ---------------------------------------------------------------------------

describe("view — status presentation", () => {
  it("maps each todo status onto exactly one canonical presentation status", () => {
    assert.deepEqual(TODO_PRESENTATION, {
      pending: "waiting",
      in_progress: "active",
      completed: "succeeded",
      abandoned: "cancelled",
      blocked: "blocked",
    });
  });

  it("resolves every status row through the canonical presentation table", () => {
    // Expected values mirror the canonical STATUS_PRESENTATION table in
    // ../display.ts — the projection must never fork its own presentation.
    const expected: Record<
      TodoStatus,
      { glyph: string; hue: DisplayHue; spinner: boolean }
    > = {
      pending: { glyph: "○", hue: "muted", spinner: false },
      in_progress: { glyph: "", hue: "running", spinner: true },
      completed: { glyph: "●", hue: "success", spinner: false },
      abandoned: { glyph: "■", hue: "muted", spinner: false },
      blocked: { glyph: "●", hue: "running", spinner: false },
    };
    for (const status of Object.keys(expected) as TodoStatus[]) {
      const want = expected[status];
      // A lone closed/blocked task would leave the phase inactive (no open
      // work → collapsed header only), so an `in_progress` companion keeps
      // the phase active and the row under test actually projected.
      const tasks: Array<[string, TodoStatus]> =
        status === "in_progress"
          ? [["a", status]]
          : [
              ["a", status],
              ["z", "in_progress"],
            ];
      const lines = todoLines([phase("Work", ...tasks)]);
      const row = tasksOf(lines).find((l) => l.content === "a");
      assert.equal(row?.glyph, want.glyph, status);
      assert.equal(row?.hue, want.hue, status);
      assert.equal(row?.spinner, want.spinner, status);
    }
  });

  it("restricts the hue vocabulary to the DisplayHue values", () => {
    const allowed = new Set(HUES);
    for (const presentation of Object.values(STATUS_PRESENTATION)) {
      assert.ok(allowed.has(presentation.hue), `bad hue ${presentation.hue}`);
    }
  });

  it("keeps the completed-row strikethrough as a todo-domain extra", () => {
    // A closed task is only projected as the active phase's closed-context
    // lead (the last closed task), so each assertion builds its own phase.
    const done = todoLines([
      phase("Work", ["a", "completed"], ["z", "in_progress"]),
    ]);
    assert.equal(
      tasksOf(done).find((l) => l.content === "a")?.strikethrough,
      true,
    );
    const failed = todoLines([
      phase("Work", ["b", "abandoned"], ["z", "in_progress"]),
    ]);
    assert.equal(
      tasksOf(failed).find((l) => l.content === "b")?.strikethrough,
      false,
    );
  });

  it("distinguishes the animated spinner from the static blocked glyph", () => {
    const active = STATUS_PRESENTATION.active;
    const blocked = STATUS_PRESENTATION.blocked;
    assert.equal(active.hue, blocked.hue);
    assert.equal(active.spinner, true);
    assert.notEqual(blocked.spinner, true);
  });
});

// ---------------------------------------------------------------------------
// todoLines — full-ordered emission
// ---------------------------------------------------------------------------

describe("view — todoLines ordering", () => {
  it("is empty for an empty plan", () => {
    assert.deepEqual(todoLines([]), []);
    // A plan of task-less phases has nothing to summarize either.
    assert.deepEqual(todoLines([phase("Empty"), phase("AlsoEmpty")]), []);
  });

  it("emits every open task of the active phase without a cap", () => {
    const tasks: Array<[string, TodoStatus]> = [
      ["a", "in_progress"],
      ["b", "pending"],
      ["c", "pending"],
      ["d", "pending"],
      ["e", "pending"],
      ["f", "pending"],
      ["g", "pending"],
    ];
    const lines = todoLines([phase("Work", ...tasks)]);

    assert.equal(headerOf(lines, 1).active, true);
    assert.equal(headerOf(lines, 1).fold, FOLD_EXPANDED);
    // No windowing: all seven open tasks are emitted, no overflow row.
    assert.deepEqual(
      tasksOf(lines).map((line) => line.content),
      ["a", "b", "c", "d", "e", "f", "g"],
    );
    assert.equal(overflowsOf(lines).length, 0);
  });

  it("enumerates every task of an open phase in declaration order", () => {
    const lines = todoLines([
      phase(
        "Work",
        ["c1", "completed"],
        ["c2", "completed"],
        ["a", "in_progress"],
        ["b", "pending"],
      ),
    ]);
    // Closed rows stay in place, struck through, ahead of the open work.
    assert.deepEqual(
      tasksOf(lines).map((line) => line.content),
      ["c1", "c2", "a", "b"],
    );
    assert.deepEqual(
      tasksOf(lines).map((line) => line.strikethrough),
      [true, true, false, false],
    );
  });

  it("emits phases in declaration order, header before tasks", () => {
    const lines = todoLines([
      phase("Current", ["a", "in_progress"]),
      phase("Later", ["x", "pending"]),
    ]);
    // Kind sequence pins the layout: each phase's header precedes its rows.
    assert.deepEqual(kindsOf(lines), ["header", "task", "header", "task"]);
    assert.equal(headerOf(lines, 1).name, "Current");
    assert.equal(headerOf(lines, 2).name, "Later");
    assert.deepEqual(
      tasksOf(lines).map((line) => line.content),
      ["a", "x"],
    );
  });

  it("keeps a settled leading phase ahead of the active phase in place", () => {
    const lines = todoLines([
      phase("Done", ["c", "completed"]),
      phase("Current", ["a", "in_progress"]),
    ]);
    // The settled phase is not the active one (no open work in it): its
    // header alone is emitted, the active phase keeps its own position.
    assert.deepEqual(kindsOf(lines), ["header", "header", "task"]);
    assert.equal(headerOf(lines, 1).active, false);
    assert.equal(headerOf(lines, 2).active, true);
    assert.deepEqual(
      tasksOf(lines).map((line) => line.content),
      ["a"],
    );
  });

  it("emits every open task of later phases without a cap", () => {
    const lines = todoLines([
      phase("Current", ["a", "in_progress"]),
      phase(
        "Later",
        ["x1", "pending"],
        ["x2", "pending"],
        ["x3", "pending"],
        ["x4", "pending"],
        ["x5", "pending"],
        ["x6", "pending"],
      ),
    ]);
    assert.deepEqual(
      tasksOf(lines)
        .filter((line) => line.content.startsWith("x"))
        .map((line) => line.content),
      ["x1", "x2", "x3", "x4", "x5", "x6"],
    );
    assert.equal(overflowsOf(lines).length, 0);
  });

  it("enumerates a closed task in a non-active open phase too", () => {
    const lines = todoLines([
      phase("Current", ["a", "in_progress"], ["closed", "completed"]),
      phase("Later", ["done2", "completed"], ["x", "pending"]),
    ]);
    // Every open phase enumerates all of its rows; no phase gets a special
    // "closed lead" and no closed row is hidden.
    assert.deepEqual(
      tasksOf(lines).map((line) => line.content),
      ["a", "closed", "done2", "x"],
    );
    assert.equal(taskContent(lines, "done2"), "done2");
    assert.equal(taskContent(lines, "x"), "x");
  });

  it("keeps blocked tasks in place among the open tasks", () => {
    const lines = todoLines([
      phase(
        "Work",
        ["a", "pending"],
        ["b", "blocked"],
        ["c", "in_progress"],
        ["d", "pending"],
      ),
    ]);
    assert.deepEqual(
      tasksOf(lines).map((line) => line.content),
      ["a", "b", "c", "d"],
    );
    const blocked = tasksOf(lines).find((line) => line.content === "b");
    assert.equal(blocked?.hue, "running");
    assert.equal(blocked?.spinner, false);
  });

  it("renders a blocked task's blocker note into its text", () => {
    const lines = todoLines([
      {
        name: "Work",
        tasks: [
          { content: "a", status: "in_progress" },
          { content: "b", status: "blocked", blocker: "waiting on review" },
        ],
      },
    ]);
    const blocked = tasksOf(lines).find((line) => line.content === "b");
    assert.equal(blocked?.blocker, "waiting on review");
    assert.equal(blocked?.text, "b — waiting on review");
  });

  it("renders a settled single-phase plan as its header alone", () => {
    const lines = todoLines([
      phase("Done", ["a", "completed"], ["b", "abandoned"]),
    ]);
    // Settled work collapses to the phase header — never a plan-wide summary.
    assert.deepEqual(kindsOf(lines), ["header"]);
    assert.equal(headerOf(lines, 1).settled, true);
    assert.equal(headerOf(lines, 1).fold, FOLD_COLLAPSED);
    assert.equal(headerOf(lines, 1).text, `${FOLD_COLLAPSED} Done  2/2`);
    assert.equal(overflowsOf(lines).length, 0);
  });

  it("renders a settled multi-phase plan as N headers, no summary row", () => {
    const lines = todoLines([
      phase("Done", ["a", "completed"], ["b", "abandoned"]),
      phase("Later", ["c", "completed"]),
    ]);
    assert.deepEqual(kindsOf(lines), ["header", "header"]);
    assert.deepEqual(
      lines.map((line) => (line.kind === "header" ? line.name : "")),
      ["Done", "Later"],
    );
    assert.equal(
      lines.some((line) => line.kind === "summary"),
      false,
    );
  });

  it("keeps the multi-row projection for a plan with one pending task", () => {
    // One pending task among completed ones is open work: the phase stays
    // active and renders its header, closed lead, and open task as today.
    const lines = todoLines([
      phase("Work", ["c1", "completed"], ["p1", "pending"]),
    ]);
    assert.deepEqual(kindsOf(lines), ["header", "task", "task"]);
    assert.equal(headerOf(lines, 1).active, true);
    assert.deepEqual(
      tasksOf(lines).map((line) => line.content),
      ["c1", "p1"],
    );
  });

  it("skips phases with no tasks, keeping their ordinal slot", () => {
    const lines = todoLines([
      phase("Empty"),
      phase("Current", ["a", "in_progress"]),
    ]);
    assert.deepEqual(kindsOf(lines), ["header", "task"]);
    // The empty phase is not rendered but still owns ordinal 1 — the
    // header row keeps its one-based position in the plan.
    assert.equal(
      lines.some((line) => line.kind === "header" && line.index === 1),
      false,
    );
    assert.equal(headerOf(lines, 2).name, "Current");
    assert.equal(headerOf(lines, 2).active, true);
  });

  it("renders per-phase header progress as done/total", () => {
    const lines = todoLines([
      phase("Work", ["a", "in_progress"], ["b", "pending"], ["c", "completed"]),
    ]);
    const header = lines.find((line) => line.kind === "header");
    assert.ok(header && header.kind === "header");
    assert.equal(header.done, 1);
    assert.equal(header.total, 3);
    assert.equal(header.text, `${FOLD_EXPANDED} Work  1/3`);
  });

  it("marks a settled phase header collapsed and an open one expanded", () => {
    const lines = todoLines([
      phase("Current", ["a", "in_progress"]),
      phase("Later", ["x", "pending"]),
      phase("Closed", ["y", "completed"]),
    ]);
    const later = lines.find(
      (line) => line.kind === "header" && line.index === 2,
    );
    assert.ok(later && later.kind === "header");
    assert.equal(later.active, false);
    assert.equal(later.settled, false);
    assert.equal(later.fold, FOLD_EXPANDED);
    const closed = lines.find(
      (line) => line.kind === "header" && line.index === 3,
    );
    assert.ok(closed && closed.kind === "header");
    assert.equal(closed.active, false);
    assert.equal(closed.settled, true);
    assert.equal(closed.fold, FOLD_COLLAPSED);
  });

  it("marks the in_progress task row with the spinner flag", () => {
    const lines = todoLines([phase("Work", ["a", "in_progress"])]);
    const current = tasksOf(lines)[0];
    assert.equal(current?.status, "in_progress");
    assert.equal(current?.spinner, true);
    assert.equal(current?.glyph, "");
    assert.equal(current?.hue, "running");
  });
});

describe("view — overflow row", () => {
  it("summarizes hidden rows as a muted +N line", () => {
    const row = overflowLine(3);
    assert.equal(row.kind, "overflow");
    assert.equal(row.count, 3);
    assert.equal(row.text, "+3 more");
    assert.equal(row.hue, "muted");
  });
});

// ---------------------------------------------------------------------------
// todoLines — phase fold overrides
// ---------------------------------------------------------------------------

describe("view — phase fold overrides", () => {
  it("enumerates an open phase by default", () => {
    const lines = todoLines([
      phase("Work", ["a", "pending"], ["b", "completed"]),
    ]);
    assert.deepEqual(kindsOf(lines), ["header", "task", "task"]);
    assert.equal(headerOf(lines, 1).fold, FOLD_EXPANDED);
  });

  it("collapses an open phase to its header when overridden", () => {
    const lines = todoLines(
      [phase("Work", ["a", "pending"], ["b", "in_progress"])],
      {
        foldOverrides: new Map([["Work", false]]),
      },
    );
    assert.deepEqual(kindsOf(lines), ["header"]);
    const header = headerOf(lines, 1);
    assert.equal(header.settled, false);
    assert.equal(header.fold, FOLD_COLLAPSED);
    assert.equal(header.text, `${FOLD_COLLAPSED} Work  0/2`);
  });

  it("enumerates a settled phase's struck tasks when overridden", () => {
    const lines = todoLines(
      [phase("Done", ["a", "completed"], ["b", "abandoned"])],
      { foldOverrides: new Map([["Done", true]]) },
    );
    assert.deepEqual(kindsOf(lines), ["header", "task", "task"]);
    assert.deepEqual(
      tasksOf(lines).map((line) => line.content),
      ["a", "b"],
    );
    assert.equal(headerOf(lines, 1).settled, true);
    assert.equal(headerOf(lines, 1).fold, FOLD_EXPANDED);
    // Only completed work is crossed out; abandonment is not.
    assert.deepEqual(
      tasksOf(lines).map((line) => line.strikethrough),
      [true, false],
    );
  });

  it("overrides a single phase while the rest keep their status default", () => {
    const lines = todoLines(
      [
        phase("Done", ["a", "completed"]),
        phase("Later", ["b", "completed"]),
        phase("Open", ["c", "pending"]),
        phase("Busy", ["d", "in_progress"]),
      ],
      {
        foldOverrides: new Map([
          ["Later", true],
          ["Busy", false],
        ]),
      },
    );
    assert.deepEqual(kindsOf(lines), [
      "header",
      "header",
      "task",
      "header",
      "task",
      "header",
    ]);
    assert.deepEqual(
      tasksOf(lines).map((line) => line.content),
      ["b", "c"],
    );
    assert.equal(headerOf(lines, 3).fold, FOLD_EXPANDED);
    assert.equal(headerOf(lines, 4).fold, FOLD_COLLAPSED);
  });

  it("lets an override win over the status default in both directions", () => {
    // Settled → expanded, open → collapsed.
    const overridden = todoLines(
      [phase("Settled", ["a", "completed"]), phase("Open", ["b", "pending"])],
      {
        foldOverrides: new Map([
          ["Settled", true],
          ["Open", false],
        ]),
      },
    );
    assert.deepEqual(kindsOf(overridden), ["header", "task", "header"]);
    assert.deepEqual(
      tasksOf(overridden).map((line) => line.content),
      ["a"],
    );
    // The same statuses without overrides fall back to their defaults.
    assert.deepEqual(
      kindsOf(
        todoLines([
          phase("Settled", ["a", "completed"]),
          phase("Open", ["b", "pending"]),
        ]),
      ),
      ["header", "header", "task"],
    );
  });

  it("is unaffected by an override name that matches no phase", () => {
    const lines = todoLines([phase("Done", ["a", "completed"])], {
      foldOverrides: new Map([["Nope", true]]),
    });
    assert.deepEqual(kindsOf(lines), ["header"]);
  });

  it("treats an empty override map like no options", () => {
    const phases = [phase("Done", ["a", "completed"])];
    assert.deepEqual(
      todoLines(phases, { foldOverrides: new Map() }),
      todoLines(phases),
    );
  });
});

// ---------------------------------------------------------------------------
// collapsedSummaryLine
// ---------------------------------------------------------------------------

describe("view — collapsed summary line", () => {
  it("reports done/total plus the in_progress task content", () => {
    const line = collapsedSummaryLine([
      phase("Work", ["a", "completed"], ["b", "in_progress"], ["c", "pending"]),
    ]);
    assert.equal(line.kind, "summary");
    assert.equal(line.done, 1);
    assert.equal(line.total, 3);
    assert.equal(line.current, "b");
    assert.equal(line.text, "1/3 done — b");
    assert.equal(line.hue, "running");
  });

  it("falls back to the earliest pending task when nothing is in_progress", () => {
    const line = collapsedSummaryLine([
      phase("Work", ["first", "pending"], ["second", "pending"]),
    ]);
    assert.equal(line.current, "first");
    assert.equal(line.text, "0/2 done — first");
    assert.equal(line.hue, "muted");
  });

  it("shows only the count when nothing is open", () => {
    const line = collapsedSummaryLine([
      phase("Work", ["a", "completed"], ["b", "abandoned"]),
    ]);
    assert.equal(line.current, undefined);
    assert.equal(line.text, "2/2 done");
    assert.equal(line.hue, "muted");
  });

  it("counts abandoned tasks as done", () => {
    const line = collapsedSummaryLine([
      phase("Work", ["a", "abandoned"], ["b", "pending"]),
    ]);
    assert.equal(line.done, 1);
    assert.equal(line.total, 2);
    assert.equal(line.text, "1/2 done — b");
  });

  it("renders an empty plan as 0/0", () => {
    const line = collapsedSummaryLine([]);
    assert.equal(line.done, 0);
    assert.equal(line.total, 0);
    assert.equal(line.current, undefined);
    assert.equal(line.text, "0/0 done");
  });

  it("picks the in_progress task across phases over a later pending task", () => {
    const line = collapsedSummaryLine([
      phase("A", ["a", "in_progress"]),
      phase("B", ["b", "pending"]),
    ]);
    assert.equal(line.current, "a");
    assert.equal(line.text, "0/2 done — a");
  });
});
