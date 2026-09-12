/**
 * Tests for the pi expanded fleet column renderer (`fleet-column.ts`).
 *
 * Boundary: the pure renderer observed at its returned strings.  It is fed
 * the session's top-level runs plus an explicit window size and row budget,
 * so these tests drive it directly — window semantics, the `↑`/`↓`
 * indicators, the budget trim that preserves them, the selection band being
 * drawn only while the column is focused, and the window anchor that keeps a
 * selected child's parent in view.
 *
 * The fake theme wraps colors as `<color>…</color>` and the background band
 * as `<selectedBg>…</selectedBg>`, matching the conventions the widget and
 * todo column tests use.  The registry is process-global and reset between
 * tests.
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  finishRun,
  resetRegistry,
  startRun,
  topLevelRuns,
} from "../../../core/subagent/registry.js";
import { type FleetColumnOptions, renderFleetColumn } from "./fleet-column.js";

afterEach(() => {
  resetRegistry();
});

/** A theme stub that wraps each colorized string in `<color>` tags. */
const THEME = {
  fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
  bg: (color: string, text: string) => `<${color}>${text}</${color}>`,
};

/** The colorizer stub wraps each agent name in `<c>` tags. */
const colorizeAgent = (name: string): string => `<c>${name}</c>`;

/** Register a top-level run under the main session (with a session path). */
function seedRun(id: string, startedAt: number, agent = id): void {
  startRun({
    id,
    agent,
    parentSession: "main",
    startedAt,
    sessionPath: `/tmp/sessions/${id}.jsonl`,
  });
}

/** The session's top-level runs, oldest first. */
function tops() {
  return topLevelRuns("main");
}

/** Build renderer options with sensible defaults for the tests. */
function opts(overrides: Partial<FleetColumnOptions> = {}): FleetColumnOptions {
  return {
    windowRows: 7,
    maxLines: 8,
    focused: true,
    frame: 0,
    now: 10_000,
    theme: THEME,
    colorizeAgent,
    ...overrides,
  };
}

describe("renderFleetColumn — window semantics", () => {
  it("windows around the selection with ↑/↓ indicators", () => {
    for (let i = 0; i < 10; i++) seedRun(`r${i}`, i * 1000, `a${i}`);

    // Selection r2 with a 7-row cap: two rows hidden above, one below.
    const rows = renderFleetColumn(
      tops(),
      opts({ windowRows: 7, maxLines: 20, selectedId: "r2" }),
    );

    assert.ok(
      rows[0].includes("↑ 2 more"),
      `leading ↑ indicator expected: ${rows.join(" | ")}`,
    );
    assert.ok(
      rows[rows.length - 1].includes("↓ 1 more"),
      `trailing ↓ indicator expected: ${rows.join(" | ")}`,
    );
    // The selection is banded and stays in view.
    const banded = rows.filter((row) => row.includes("<selectedBg>"));
    assert.equal(banded.length, 1, rows.join(" | "));
    assert.ok(banded[0].includes("<c>a2</c>"), banded[0]);
  });

  it("bottom-aligns and hides only above when nothing is selected", () => {
    for (let i = 0; i < 10; i++) seedRun(`r${i}`, i * 1000);

    const rows = renderFleetColumn(
      tops(),
      opts({ windowRows: 3, maxLines: 20, selectedId: undefined }),
    );

    assert.ok(
      rows[0].includes("↑ 7 more"),
      `top-aligned ↑ indicator expected: ${rows.join(" | ")}`,
    );
    assert.ok(
      !rows.some((row) => row.includes("↓")),
      `no ↓ indicator expected at the bottom: ${rows.join(" | ")}`,
    );
  });

  it("anchors the window on a selected child's parent", () => {
    for (let i = 0; i < 10; i++) seedRun(`r${i}`, i * 1000, `a${i}`);
    // r0 delegated: a nested run under its child session.
    finishRun("r0", { status: "done", childSession: "child-r0" });
    startRun({
      id: "c0",
      agent: "kid",
      parentSession: "child-r0",
      startedAt: 500,
    });

    const rows = renderFleetColumn(
      tops(),
      opts({ windowRows: 2, maxLines: 20, selectedId: "c0" }),
    );

    // The window is anchored at the child's parent, so both the parent row
    // and its nested child render, with the band on the child.
    assert.ok(
      rows.some((row) => row.includes("└─ ") && row.includes("<c>kid</c>")),
      `nested child row expected: ${rows.join(" | ")}`,
    );
    const banded = rows.filter((row) => row.includes("<selectedBg>"));
    assert.equal(banded.length, 1, rows.join(" | "));
    assert.ok(banded[0].includes("<c>kid</c>"), banded[0]);
  });
});

describe("renderFleetColumn — budget trim", () => {
  it("hides a whole trailing run instead of trimming its rows", () => {
    // Three top-level runs, each with one nested child (two rendered rows
    // apiece).  With a 3-row window and a 4-line budget the anchored run r0
    // plus its child fill two rows, so r1 and r2 must be hidden as whole
    // runs — the old tail-slice would instead cut r2's rows silently.
    seedRun("r0", 0);
    seedRun("r1", 1000);
    seedRun("r2", 2000);
    for (const parent of ["r0", "r1", "r2"]) {
      finishRun(parent, { status: "done", childSession: `child-${parent}` });
      startRun({
        id: `c-${parent}`,
        agent: `kid-${parent}`,
        parentSession: `child-${parent}`,
        startedAt: 100,
      });
    }

    const maxLines = 4;
    const rows = renderFleetColumn(
      tops(),
      opts({ windowRows: 3, maxLines, selectedId: "r0" }),
    );

    assert.ok(rows.length <= maxLines, `within budget: ${rows.join(" | ")}`);
    // The anchored run and its child are both fully visible.
    assert.ok(
      rows.some((row) => row.includes("<c>r0</c>")),
      `anchored run expected: ${rows.join(" | ")}`,
    );
    assert.ok(
      rows.some((row) => row.includes("<c>kid-r0</c>")),
      `anchored run's child expected: ${rows.join(" | ")}`,
    );
    // The last top-level run is hidden as a whole (never half-rendered) and
    // the overflow is expressed by the ↓ indicator, not a tail slice.
    assert.ok(
      !rows.some((row) => row.includes("<c>r2</c>")),
      `last run must be fully hidden: ${rows.join(" | ")}`,
    );
    assert.ok(
      !rows.some((row) => row.includes("<c>kid-r2</c>")),
      `hidden run's child must not leak through: ${rows.join(" | ")}`,
    );
    assert.ok(
      rows[rows.length - 1].includes("↓ 2 more"),
      `overflow must be a ↓ indicator: ${rows.join(" | ")}`,
    );
  });

  it("never drops the indicators when nested children overflow maxLines", () => {
    for (let i = 0; i < 10; i++) seedRun(`r${i}`, i * 1000, `a${i}`);
    // Several parents carry a nested child, inflating their rendered rows.
    for (const parent of ["r2", "r5", "r8"]) {
      startRun({
        id: `c-${parent}`,
        agent: "kid",
        parentSession: `child-${parent}`,
        startedAt: 1000,
      });
      finishRun(parent, { status: "done", childSession: `child-${parent}` });
    }

    // With windowRows=7 the anchored window (selection r2) would cost 9 rows,
    // so the budget search must shrink it to 6 to keep both indicators.
    const maxLines = 8;
    const rows = renderFleetColumn(
      tops(),
      opts({ windowRows: 7, maxLines, selectedId: "r2" }),
    );

    assert.ok(
      rows.length <= maxLines,
      `lines=${rows.length} exceeds the ${maxLines}-line budget`,
    );
    assert.ok(
      rows[0].includes("↑ "),
      `↑ indicator must survive the trim: ${rows.join(" | ")}`,
    );
    assert.ok(
      rows[rows.length - 1].includes("↓ "),
      `↓ indicator must survive the trim: ${rows.join(" | ")}`,
    );
  });

  it("keeps a single run's row and summarizes its overflow children", () => {
    seedRun("r0", 0, "root");
    finishRun("r0", { status: "done", childSession: "child-r0" });
    // Six nested children — the one run alone costs seven rendered rows.
    for (let i = 0; i < 6; i++) {
      startRun({
        id: `c${i}`,
        agent: `kid${i}`,
        parentSession: "child-r0",
        startedAt: 100 + i,
      });
    }

    const maxLines = 5;
    const rows = renderFleetColumn(
      tops(),
      opts({ windowRows: 7, maxLines, selectedId: "r0" }),
    );

    assert.ok(rows.length <= maxLines, `within budget: ${rows.join(" | ")}`);
    // The run's own row survives even though its children overflow.
    assert.ok(
      rows.some((row) => row.includes("<c>root</c>")),
      `run row expected: ${rows.join(" | ")}`,
    );
    // The head children fit; the rest collapse into the hint row.
    assert.ok(
      rows.some((row) => row.includes("<c>kid0</c>")),
      `head child expected: ${rows.join(" | ")}`,
    );
    assert.ok(
      rows.some((row) => row.includes("… +3 more")),
      `child overflow hint expected: ${rows.join(" | ")}`,
    );
  });

  it("holds the budget when a single run overflows and runs are hidden", () => {
    for (let i = 0; i < 3; i++) seedRun(`r${i}`, i * 1000, `a${i}`);
    finishRun("r1", { status: "done", childSession: "child-r1" });
    for (let i = 0; i < 6; i++) {
      startRun({
        id: `k${i}`,
        agent: `kid${i}`,
        parentSession: "child-r1",
        startedAt: 100 + i,
      });
    }

    const maxLines = 4;
    const rows = renderFleetColumn(
      tops(),
      opts({ windowRows: 7, maxLines, selectedId: "r1" }),
    );

    assert.ok(rows.length <= maxLines, `within budget: ${rows.join(" | ")}`);
    // The overflowing run's row is preserved and its dropped children are
    // summarized, even though whole-run indicators no longer fit.
    assert.ok(
      rows.some((row) => row.includes("<c>a1</c>")),
      `run row expected: ${rows.join(" | ")}`,
    );
    assert.ok(
      rows.some((row) => row.includes("… +")),
      `child overflow hint expected: ${rows.join(" | ")}`,
    );
  });

  it("returns at most maxLines rows for a plain oversized roster", () => {
    for (let i = 0; i < 20; i++) seedRun(`r${i}`, i * 1000);

    const maxLines = 4;
    const rows = renderFleetColumn(
      tops(),
      opts({ windowRows: 7, maxLines, selectedId: "r10" }),
    );

    assert.ok(rows.length <= maxLines, `within budget: ${rows.length}`);
  });
});

describe("renderFleetColumn — left edge", () => {
  it("starts every row at column 0", () => {
    for (let i = 0; i < 10; i++) seedRun(`r${i}`, i * 1000, `a${i}`);
    finishRun("r2", { status: "done", childSession: "child-r2" });
    startRun({
      id: "c2",
      agent: "kid",
      parentSession: "child-r2",
      startedAt: 500,
    });

    const rows = renderFleetColumn(
      tops(),
      opts({ windowRows: 2, maxLines: 20, selectedId: "c2" }),
    );

    // The ↑/↓ indicators, top-level rows, and nested child rows all begin at
    // column 0; the fold glyphs inside a row carry nesting, not leading
    // spaces.
    for (const row of rows) {
      assert.ok(
        !row.startsWith(" "),
        `row must be flush-left: ${JSON.stringify(row)}`,
      );
    }
    // The selection band wraps the selected nested child from column 0.
    const banded = rows.filter((row) => row.startsWith("<selectedBg>"));
    assert.equal(banded.length, 1, rows.join(" | "));
    assert.ok(banded[0].includes("<c>kid</c>"), banded[0]);
  });
});

describe("renderFleetColumn — deep nesting", () => {
  it("renders grandchildren with accumulated indent and bands the deep selection", () => {
    seedRun("r0", 0, "root");
    finishRun("r0", { status: "done", childSession: "child-r0" });
    startRun({
      id: "c0",
      agent: "kid",
      parentSession: "child-r0",
      startedAt: 100,
    });
    startRun({
      id: "c1",
      agent: "kid2",
      parentSession: "child-r0",
      startedAt: 150,
    });
    finishRun("c0", { status: "done", childSession: "child-c0" });
    startRun({
      id: "g0",
      agent: "grand",
      parentSession: "child-c0",
      startedAt: 200,
    });

    const rows = renderFleetColumn(
      tops(),
      opts({ windowRows: 7, maxLines: 20, selectedId: "g0" }),
    );

    // Four rows: the top run, its two children, and the grandchild one
    // generation deeper under the non-last child (`│` pipe).
    assert.ok(
      rows.some((row) => /├─ .+<c>kid<\/c>/.test(row)),
      rows.join(" | "),
    );
    assert.ok(
      rows.some((row) => /│ {2}└─ .+<c>grand<\/c>/.test(row)),
      rows.join(" | "),
    );
    assert.ok(
      rows.some((row) => /└─ .+<c>kid2<\/c>/.test(row)),
      rows.join(" | "),
    );
    const banded = rows.filter((row) => row.includes("<selectedBg>"));
    assert.equal(banded.length, 1, rows.join(" | "));
    assert.ok(banded[0].includes("<c>grand</c>"), banded[0]);
  });

  it("budgets a three-generation run by its full descendant row count", () => {
    // r0 spans three generations (3 rendered rows); r1 is a plain row.
    seedRun("r0", 0, "root");
    finishRun("r0", { status: "done", childSession: "child-r0" });
    startRun({
      id: "c0",
      agent: "kid",
      parentSession: "child-r0",
      startedAt: 100,
    });
    finishRun("c0", { status: "done", childSession: "child-c0" });
    startRun({
      id: "g0",
      agent: "grand",
      parentSession: "child-c0",
      startedAt: 200,
    });
    seedRun("r1", 1000, "solo");

    // r0 costs 3 rows, so a 3-line budget cannot hold it plus an ↑
    // indicator: the bottom-aligned window drops r0 whole and shows r1
    // with the overflow count.  A one-level count of 2 would wrongly keep
    // r0 in the window and then trim its rows.
    const rows = renderFleetColumn(
      tops(),
      opts({ windowRows: 4, maxLines: 3, selectedId: undefined }),
    );
    assert.ok(rows.length <= 3, rows.join(" | "));
    assert.ok(rows[0].includes("↑ 1 more"), rows.join(" | "));
    assert.ok(
      rows.some((row) => row.includes("<c>solo</c>")),
      rows.join(" | "),
    );
    assert.ok(
      !rows.some(
        (row) => row.includes("<c>root</c>") || row.includes("<c>grand</c>"),
      ),
      `the three-row run must be hidden whole: ${rows.join(" | ")}`,
    );
  });
});

describe("renderFleetColumn — selection band", () => {
  it("draws exactly one band when focused", () => {
    seedRun("r0", 0);
    seedRun("r1", 1000);

    const rows = renderFleetColumn(
      tops(),
      opts({ selectedId: "r0", focused: true }),
    );

    const banded = rows.filter((row) => row.includes("<selectedBg>"));
    assert.equal(banded.length, 1, rows.join(" | "));
  });

  it("draws no band when the column is not focused", () => {
    seedRun("r0", 0);
    seedRun("r1", 1000);

    const rows = renderFleetColumn(
      tops(),
      opts({ selectedId: "r0", focused: false }),
    );

    assert.ok(
      !rows.some((row) => row.includes("selectedBg")),
      `no band expected without focus: ${rows.join(" | ")}`,
    );
  });

  it("falls back to a raw ANSI band when the theme has no bg", () => {
    seedRun("r0", 0);

    const rows = renderFleetColumn(
      tops(),
      opts({
        selectedId: "r0",
        theme: { fg: THEME.fg },
      }),
    );

    assert.ok(
      rows.some((row) => row.includes("\x1b[48;5;239m")),
      `raw ANSI band expected: ${rows.join(" | ")}`,
    );
  });
});
