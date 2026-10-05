/**
 * Tests for the `zoo-notice` custom-entry renderer (`notice.ts`).
 *
 * The renderer reads the notification text from the appended entry's
 * `data.content`, labels it through the active theme when one exposes
 * `fg`, and degrades to `undefined` for a missing or empty payload so pi
 * renders nothing.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildPiNoticeEntryRenderer } from "./notice.js";

describe("buildPiNoticeEntryRenderer", () => {
  it("renders the notification text from the entry data content", () => {
    const renderer = buildPiNoticeEntryRenderer();
    const theme = { fg: (_color: string, text: string) => text };
    const component = renderer(
      { data: { content: "上下文报告\ntokens: 100" } },
      { expanded: false },
      theme,
    ) as { render(): string[] } | undefined;
    assert.ok(component, "a component must be returned");
    assert.deepEqual(component.render(), [
      "[zoo]",
      "上下文报告",
      "tokens: 100",
    ]);
  });

  it("uses the themed label when the theme exposes fg", () => {
    const renderer = buildPiNoticeEntryRenderer();
    const theme = {
      fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
    };
    const component = renderer(
      { data: { content: "report" } },
      { expanded: false },
      theme,
    ) as { render(): string[] } | undefined;
    assert.ok(component);
    assert.deepEqual(component.render(), [
      "<customMessageLabel>[zoo]</customMessageLabel>",
      "report",
    ]);
  });

  it("returns undefined for an empty or missing payload", () => {
    const renderer = buildPiNoticeEntryRenderer();
    assert.equal(renderer({ data: { content: "" } }, {}, undefined), undefined);
    assert.equal(renderer({ data: undefined }, {}, undefined), undefined);
    assert.equal(
      renderer({ data: { content: "  " } }, {}, undefined),
      undefined,
    );
  });
});
