/**
 * Tests for the dual-column layout primitives
 * (`src/adapters/pi/tui/columns.ts`).
 *
 * The primitives are pure, ANSI-aware string composition, so every case is
 * asserted against pi-tui's `visibleWidth` rather than raw string length:
 * padding must reach a target visible width without counting escape codes,
 * and joined rows must keep a constant visible width with the separator drawn
 * on every line.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
  columnWidths,
  isNarrowLayout,
  joinColumns,
  padToWidth,
} from "./columns.js";

describe("padToWidth", () => {
  it("pads an ANSI-colored line to the target visible width", () => {
    const colored = "\x1b[31mab\x1b[39m";
    const padded = padToWidth(colored, 5);

    assert.equal(visibleWidth(padded), 5);
    assert.equal(padded, `${colored}   `);
  });

  it("leaves an already-full or over-wide line unchanged", () => {
    const full = "abcde";
    const overWide = "abcdefgh";

    assert.equal(padToWidth(full, 5), full);
    assert.equal(padToWidth(overWide, 5), overWide);
  });
});

describe("isNarrowLayout", () => {
  it("stacks below 100 columns and joins at 100 or more", () => {
    assert.equal(isNarrowLayout(99), true);
    assert.equal(isNarrowLayout(100), false);
  });
});

describe("columnWidths", () => {
  it("splits 103 into 55 left / 45 right", () => {
    assert.deepEqual(columnWidths(103), { left: 55, right: 45 });
  });
});

describe("joinColumns", () => {
  it("allocates 55/45 of the width at totalWidth 103", () => {
    const out = joinColumns(["a"], ["b"], 103);

    assert.equal(out.length, 1);
    assert.equal(visibleWidth(out[0]), 103);
    // 55 left columns, then the separator's leading space, then the bar.
    assert.equal(out[0].indexOf("│"), 56);
    assert.equal(out[0].slice(0, 55), padToWidth("a", 55));
    assert.equal(out[0].slice(58), padToWidth("b", 45));
  });

  it("pads the shorter column with blank lines and keeps every row equal", () => {
    const out = joinColumns(["l1", "l2", "l3"], ["r1"], 103);

    assert.equal(out.length, 3);
    for (const line of out) {
      assert.equal(visibleWidth(line), 103);
      assert.ok(line.includes("│"), "separator present on every line");
    }
    assert.equal(out[0].slice(58), padToWidth("r1", 45));
    assert.equal(out[1].slice(58), " ".repeat(45));
  });

  it("truncates an over-wide input line to its column width", () => {
    const longLeft = "x".repeat(200);
    const out = joinColumns([longLeft], ["r"], 103);

    assert.equal(visibleWidth(out[0]), 103);
    assert.ok(out[0].includes("..."), "over-wide line is truncated");
    // Truncation appends a zero-width ANSI reset, so match on the tail.
    assert.ok(out[0].endsWith(padToWidth("r", 45)));
  });
});
