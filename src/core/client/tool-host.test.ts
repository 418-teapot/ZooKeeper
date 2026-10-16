/**
 * Tests for the host tool-services contract (`tool-host.ts`).
 *
 * Boundary: the toast message formatter both host adapters render into
 * their UI surface — the `[zoo][source]` tag and the payload text.  The
 * host ports that deliver the rendered string are the adapters' concern
 * and stay covered by their own tool-host tests.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatToastMessage } from "./tool-host.js";

describe("formatToastMessage", () => {
  it("prefixes the source in the [zoo][source] tag", () => {
    assert.equal(
      formatToastMessage({
        source: "context-pruning",
        level: "warning",
        text: "上下文吃紧：已用 90%",
      }),
      "[zoo][context-pruning] 上下文吃紧：已用 90%",
    );
  });

  it("renders the level independently of the message text", () => {
    assert.equal(
      formatToastMessage({ source: "x", level: "info", text: "hi" }),
      "[zoo][x] hi",
    );
  });
});
