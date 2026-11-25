/**
 * Tests for the `zoo-view` custom-entry renderer (`view.ts`).
 *
 * The renderer owns the page's final width: it clips each logical line in
 * `render(width)` and never re-flows the columns, so the same entry paints
 * differently after a resize.  Widths are asserted through pi-tui's
 * `visibleWidth`, so CJK content and the `...` marker are measured the way
 * the host measures them.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { buildPiViewEntryRenderer } from "./view.js";

/** The page used by every case: an aligned two-row view. */
const PAGE = [
  "   4 tokens  user:      │ [m9]  第一条消息",
  "1000 tokens  assistant: │ [m10] 后续消息",
];

/** A themed label, so the label line is observable without a real theme. */
const THEME = {
  fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
};

/** The label line the theme above produces. */
const THEMED_LABEL = THEME.fg("customMessageLabel", "[zoo]");

/** Render the entry and return the component's lines. */
function render(
  entry: unknown,
  width: number,
  theme: unknown = THEME,
): string[] {
  const component = buildPiViewEntryRenderer()(entry, {}, theme) as
    | { render(width: number): string[] }
    | undefined;
  assert.ok(component, "a component must be returned");
  return component.render(width);
}

describe("buildPiViewEntryRenderer", () => {
  it("renders every logical line unchanged when the width fits", () => {
    const lines = render({ data: { lines: PAGE } }, 200);

    assert.deepEqual(lines, [
      "<customMessageLabel>[zoo]</customMessageLabel>",
      ...PAGE,
    ]);
  });

  it("clips only the tail to the current width and keeps the columns", () => {
    const lines = render({ data: { lines: PAGE } }, 36);

    for (const line of lines.slice(1)) {
      assert.ok(visibleWidth(line) <= 36, `${line} fits 36 columns`);
    }
    // Both rows keep the aligned prefix and the aligned separator column.
    assert.equal(lines[1]?.indexOf("│"), lines[2]?.indexOf("│"));
    assert.ok(lines[1]?.startsWith("   4 tokens  user:      │ [m9]  "));
    // Truncation appends zero-width ANSI resets, so match the marker, not
    // the tail.
    assert.ok(lines[1]?.includes("..."));
    assert.ok(lines[2]?.includes("..."));
  });

  it("clips the label to the current width as well", () => {
    for (const width of [1, 2, 3, 4]) {
      const label = render({ data: { lines: PAGE } }, width)[0] ?? "";

      assert.ok(visibleWidth(label) <= width, `${label} fits ${width} columns`);
    }
  });

  it("keeps the label intact when it fits the width exactly", () => {
    const width = visibleWidth(THEMED_LABEL);

    assert.equal(render({ data: { lines: PAGE } }, width)[0], THEMED_LABEL);
    assert.ok(
      visibleWidth(render({ data: { lines: PAGE } }, width - 1)[0] ?? "") <=
        width - 1,
    );
  });

  it("re-renders the same data at each width (resize)", () => {
    const entry = { data: { lines: PAGE } };
    const component = buildPiViewEntryRenderer()(entry, {}, THEME) as {
      render(width: number): string[];
    };

    const wide = component.render(200);
    const narrow = component.render(24);

    assert.deepEqual(wide.slice(1), PAGE);
    assert.ok(visibleWidth(narrow[1] ?? "") <= 24);
    assert.ok(visibleWidth(narrow[2] ?? "") <= 24);
    assert.deepEqual(component.render(200).slice(1), PAGE);
  });

  it("falls back to the plain label without a theme", () => {
    const component = buildPiViewEntryRenderer()(
      { data: { lines: PAGE } },
      {},
      undefined,
    ) as { render(width: number): string[] };

    assert.equal(component.render(200)[0], "[zoo]");
  });

  it("returns undefined for an empty or missing payload", () => {
    const renderer = buildPiViewEntryRenderer();

    assert.equal(renderer({ data: { lines: [] } }, {}, THEME), undefined);
    assert.equal(renderer({ data: { lines: "nope" } }, {}, THEME), undefined);
    assert.equal(renderer({ data: { lines: [1] } }, {}, THEME), undefined);
    assert.equal(renderer({ data: undefined }, {}, THEME), undefined);
    assert.equal(renderer(undefined, {}, THEME), undefined);
  });
});
