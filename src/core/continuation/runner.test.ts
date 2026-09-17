/**
 * Tests for the shared settle-contribution runner (`runner.ts`).
 *
 * Locks the first-wake selection, per-handler crash isolation, and the
 * fail-closed `null` for an all-silent or empty contribution list — the
 * behavior both host adapters (`buildSettledRunner`, `buildPiSettledHandler`)
 * now delegate to.
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { _getBufferForTesting, _resetForTesting } from "../../utils/logger.js";
import type { SettledContribution, SettledInput } from "../slots.js";
import type { Decision } from "./decide.js";
import { runSettled } from "./runner.js";

afterEach(() => {
  _resetForTesting();
});

const INPUT: SettledInput = {
  sessionID: "s1",
  cause: "settled",
  budget: { limit: 3, used: 0 },
  progress: true,
};

/** Build a named contribution from a judging function. */
function handler(
  name: string,
  fn: (input: SettledInput) => Promise<Decision>,
): SettledContribution {
  return { name, handle: fn };
}

describe("runSettled", () => {
  it("returns the first wake decision and stops there", async () => {
    const calls: string[] = [];
    const decision = await runSettled(
      [
        handler("silent", async () => {
          calls.push("silent");
          return { kind: "silence", reason: "no-active" };
        }),
        handler("waker", async () => {
          calls.push("waker");
          return { kind: "wake", text: "go" };
        }),
        handler("after", async () => {
          calls.push("after");
          return { kind: "wake", text: "late" };
        }),
      ],
      INPUT,
    );
    assert.deepEqual(decision, { kind: "wake", text: "go" });
    assert.deepEqual(calls, ["silent", "waker"]);
  });

  it("returns null when every contribution silences", async () => {
    const decision = await runSettled(
      [
        handler("a", async () => ({ kind: "silence", reason: "empty" })),
        handler("b", async () => ({ kind: "silence", reason: "no-active" })),
      ],
      INPUT,
    );
    assert.equal(decision, null);
  });

  it("returns null for an empty contribution list", async () => {
    assert.equal(await runSettled([], INPUT), null);
  });

  it("isolates a throwing contribution and continues", async () => {
    const decision = await runSettled(
      [
        handler("boom", async () => {
          throw new Error("handler failed");
        }),
        handler("ok", async () => ({ kind: "wake", text: "after crash" })),
      ],
      INPUT,
    );
    assert.deepEqual(decision, { kind: "wake", text: "after crash" });
    const crashed = _getBufferForTesting().filter(
      (entry) => entry.event === "handler_crashed",
    );
    assert.equal(crashed.length, 1);
    assert.equal(crashed[0].handler, "boom");
  });
});
