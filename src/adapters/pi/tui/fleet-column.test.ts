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
