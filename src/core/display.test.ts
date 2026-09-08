/**
 * Tests for the domain-neutral presentation primitives (`src/core/display.ts`).
 *
 * Locks the canonical status → presentation table: one entry per canonical
 * status, hues restricted to the `DisplayHue` vocabulary, the spinner
 * flag as the only animated/static separator, and the structural fold/tree
 * symbols with their unique meanings.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  type DisplayHue,
  FOLD_COLLAPSED,
  FOLD_EXPANDED,
  fitToBudget,
  type PresentationStatus,
  STATUS_PRESENTATION,
  spinnerFrameIndex,
  TREE_BRANCH,
  TREE_LAST,
} from "./display.js";

describe("display — STATUS_PRESENTATION", () => {
  it("declares exactly the six canonical presentation statuses", () => {
    assert.deepEqual(Object.keys(STATUS_PRESENTATION).sort(), [
      "active",
      "blocked",
      "cancelled",
      "failed",
      "succeeded",
      "waiting",
    ]);
  });

  it("locks the canonical glyph, hue, and spinner flag per status", () => {
    assert.deepEqual(STATUS_PRESENTATION.active, {
      glyph: "",
      hue: "running",
      spinner: true,
    });
    assert.deepEqual(STATUS_PRESENTATION.waiting, {
      glyph: "○",
      hue: "muted",
    });
    assert.deepEqual(STATUS_PRESENTATION.succeeded, {
      glyph: "●",
      hue: "success",
    });
    assert.deepEqual(STATUS_PRESENTATION.failed, {
      glyph: "■",
      hue: "error",
    });
    assert.deepEqual(STATUS_PRESENTATION.blocked, {
      glyph: "●",
      hue: "running",
    });
    assert.deepEqual(STATUS_PRESENTATION.cancelled, {
      glyph: "■",
      hue: "muted",
    });
  });

  it("restricts every hue to the DisplayHue vocabulary", () => {
    const allowed = new Set<DisplayHue>([
      "running",
      "success",
      "error",
      "muted",
      "accent",
    ]);
    for (const status of Object.keys(
      STATUS_PRESENTATION,
    ) as PresentationStatus[]) {
      const presentation = STATUS_PRESENTATION[status];
      assert.ok(allowed.has(presentation.hue), `bad hue for ${status}`);
    }
  });

  it("marks only the active status as animated", () => {
    for (const status of Object.keys(
      STATUS_PRESENTATION,
    ) as PresentationStatus[]) {
      assert.equal(
        STATUS_PRESENTATION[status].spinner === true,
        status === "active",
        `spinner flag wrong for ${status}`,
      );
    }
  });
});

describe("display — spinnerFrameIndex", () => {
  it("wraps the sequence counter into the frame range", () => {
    assert.equal(spinnerFrameIndex(0), 0);
    assert.equal(spinnerFrameIndex(9), 9);
    assert.equal(spinnerFrameIndex(10), 0);
    // Negative counters clamp to the first frame, never wrap underflow.
    assert.equal(spinnerFrameIndex(-1), 0);
  });
});

describe("display — fitToBudget", () => {
  const lines = ["a", "b", "c", "d", "e"];
  const overflow = (hidden: number) => `+${hidden} more`;

  it("returns the lines untouched when they fit the budget", () => {
    assert.deepEqual(fitToBudget(lines, 5, overflow), [
      "a",
      "b",
      "c",
      "d",
      "e",
    ]);
  });

  it("returns the lines untouched when the budget exceeds them", () => {
    assert.deepEqual(fitToBudget(lines, 99, overflow), [
      "a",
      "b",
      "c",
      "d",
      "e",
    ]);
  });

  it("locks the budget boundary: exactly as many lines as the budget", () => {
    assert.deepEqual(fitToBudget(lines, 6, overflow), [
      "a",
      "b",
      "c",
      "d",
      "e",
    ]);
    assert.deepEqual(fitToBudget(lines, 5, overflow).length, 5);
  });

  it("clips to budget - 1 lines plus one overflow row when over budget", () => {
    const fitted = fitToBudget(lines, 3, overflow);
    assert.deepEqual(fitted, ["a", "b", "+3 more"]);
    assert.equal(fitted.length, 3);
  });

  it("counts every dropped line in the overflow row", () => {
    // 5 lines, budget 1: nothing but the summary row fits.
    assert.deepEqual(fitToBudget(lines, 1, overflow), ["+5 more"]);
  });

  it("reports an empty sequence as empty at any positive budget", () => {
    assert.deepEqual(fitToBudget([], 3, overflow), []);
    assert.deepEqual(fitToBudget([], 1, overflow), []);
  });

  it("degrades to the overflow row alone when the budget is below 1", () => {
    assert.deepEqual(fitToBudget(lines, 0, overflow), ["+5 more"]);
    assert.deepEqual(fitToBudget(lines, -2, overflow), ["+5 more"]);
  });

  it("degrades an empty sequence to empty when the budget is below 1", () => {
    assert.deepEqual(fitToBudget([], 0, overflow), []);
  });
});

describe("display — structural symbols", () => {
  it("locks the fold glyphs", () => {
    assert.equal(FOLD_COLLAPSED, "▸");
    assert.equal(FOLD_EXPANDED, "▾");
  });

  it("locks the tree branch glyphs", () => {
    assert.equal(TREE_BRANCH, "├─");
    assert.equal(TREE_LAST, "└─");
  });

  it("keeps structural symbols disjoint from every status glyph", () => {
    const structural = new Set([
      FOLD_COLLAPSED,
      FOLD_EXPANDED,
      TREE_BRANCH,
      TREE_LAST,
    ]);
    for (const status of Object.keys(
      STATUS_PRESENTATION,
    ) as PresentationStatus[]) {
      const glyph = STATUS_PRESENTATION[status].glyph;
      if (glyph !== "") {
        assert.ok(!structural.has(glyph), `glyph clash for ${status}`);
      }
    }
  });
});
