/**
 * Tests for the pi view host (`src/adapters/pi/view-host.ts`).
 *
 * The host posts the `/view` page as a `zoo-view` custom entry through
 * pi's `appendEntry` channel: persistent in the session, drawn by the
 * registered entry renderer, and never part of the LLM context.  Missing
 * and throwing bindings drop the page without failing the command.
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { _getBufferForTesting, _resetForTesting } from "../../utils/logger.js";
import { createPiViewHost } from "./view-host.js";

/** The page a command hands over: complete logical lines. */
const PAGE = ["   4 tokens  user:      │ [m9]  第一条消息"];

afterEach(() => {
  _resetForTesting();
});

describe("createPiViewHost", () => {
  it("appends the page as a zoo-view custom entry", () => {
    const appended: Array<{ customType: string; data?: unknown }> = [];
    const host = createPiViewHost((customType, data) => {
      appended.push({ customType, data });
    });

    host.present("sess-1", PAGE);

    assert.deepEqual(appended, [
      { customType: "zoo-view", data: { lines: PAGE } },
    ]);
  });

  it("drops the page without failing when appendEntry is absent", () => {
    const host = createPiViewHost();

    assert.doesNotThrow(() => host.present("s", PAGE));
  });

  it("swallows appendEntry failures and logs a warning", () => {
    const host = createPiViewHost(() => {
      throw new Error("session gone");
    });

    assert.doesNotThrow(() => host.present("s", PAGE));
    const logs = _getBufferForTesting().filter(
      (entry) => entry.event === "present_failed",
    );
    assert.equal(logs.length, 1);
  });
});
