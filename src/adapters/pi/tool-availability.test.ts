/**
 * Tests for the pi host's ask-tool visibility rule.
 *
 * Boundary: `withAskVisibility` in `./tool-availability.ts` — the pure rule
 * every active-tool writer of the pi adapter shares.  The rule is pinned
 * without any host state: given a deny-filtered candidate set and the three
 * facts about the ask tool (registered, channel available, primary denies
 * it), it returns the set to activate.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ASK_TOOL_NAME } from "../../core/ask.js";
import { withAskVisibility } from "./tool-availability.js";

describe("withAskVisibility", () => {
  it("appends the ask tool when it is registered and the channel exists", () => {
    assert.deepEqual(
      withAskVisibility(["bash", "edit"], {
        registered: true,
        available: true,
        denied: false,
      }),
      ["bash", "edit", ASK_TOOL_NAME],
    );
  });

  it("keeps one ask entry when the candidate set already carries it", () => {
    assert.deepEqual(
      withAskVisibility(["bash", ASK_TOOL_NAME, "edit"], {
        registered: true,
        available: true,
        denied: false,
      }),
      ["bash", ASK_TOOL_NAME, "edit"],
    );
  });

  it("removes the ask tool when no channel exists", () => {
    assert.deepEqual(
      withAskVisibility(["bash", ASK_TOOL_NAME, "edit"], {
        registered: true,
        available: false,
        denied: false,
      }),
      ["bash", "edit"],
    );
  });

  it("never adds the ask tool when the host registers none", () => {
    assert.deepEqual(
      withAskVisibility(["bash", "edit"], {
        registered: false,
        available: true,
        denied: false,
      }),
      ["bash", "edit"],
    );
  });

  it("removes an ask entry a host configuration activated", () => {
    assert.deepEqual(
      withAskVisibility(["bash", ASK_TOOL_NAME], {
        registered: false,
        available: true,
        denied: false,
      }),
      ["bash"],
    );
  });

  it("never adds the ask tool when the primary denies it", () => {
    assert.deepEqual(
      withAskVisibility(["bash", "edit"], {
        registered: true,
        available: true,
        denied: true,
      }),
      ["bash", "edit"],
    );
  });

  it("removes an ask entry the channel would allow when the primary denies it", () => {
    assert.deepEqual(
      withAskVisibility(["bash", ASK_TOOL_NAME, "edit"], {
        registered: true,
        available: true,
        denied: true,
      }),
      ["bash", "edit"],
    );
  });

  it("leaves the other tools untouched", () => {
    assert.deepEqual(
      withAskVisibility(["fetch", "edit", "bash"], {
        registered: true,
        available: false,
        denied: false,
      }),
      ["fetch", "edit", "bash"],
    );
  });
});
