/**
 * Tests for the loop engine (`engine.ts`).
 *
 * Locks the cause interlock (a non-settled turn returns `null` before any
 * strategy runs with its own logged reason), the per-strategy budget
 * interlock (a strategy whose allowance is spent is logged
 * `budget-exhausted` with its name and skipped so later strategies may
 * still win), the first-wake selection, per-handler crash isolation, the
 * fail-closed `null` for an all-silent or empty strategy list, and the
 * per-(session, strategy) bookkeeping (`record` / `reset` / `used`)
 * including the optional session cap.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { _getBufferForTesting, _resetForTesting } from "../../utils/logger.js";
import type { SettledContribution, SettleRequest } from "../slots.js";
import type { Decision } from "./engine.js";
import { createLoopEngine } from "./engine.js";

let origDebug: string | undefined;

beforeEach(() => {
  origDebug = process.env.ZOO_DEBUG;
  process.env.ZOO_DEBUG = "1";
});

afterEach(() => {
  if (origDebug === undefined) delete process.env.ZOO_DEBUG;
  else process.env.ZOO_DEBUG = origDebug;
  _resetForTesting();
});

/** A settled request that made mutating progress. */
const REQUEST: SettleRequest = {
  sessionID: "s1",
  cause: "settled",
  progress: true,
};

/** Build a named contribution from a judging function. */
function handler(
  name: string,
  fn: (input: { sessionID: string; progress: boolean }) => Promise<Decision>,
  maxWakes = 3,
): SettledContribution {
  return { name, maxWakes, handle: fn };
}

/** The interlock reason logged for the last `settle_interlock` entry. */
function interlockReason(): unknown {
  const entries = _getBufferForTesting().filter(
    (entry) => entry.event === "settle_interlock",
  );
  return entries.at(-1)?.reason;
}

describe("createLoopEngine — cause interlock", () => {
  it("does not consult any strategy when the turn did not settle", async () => {
    let consulted = false;
    const engine = createLoopEngine([
      handler("waker", async () => {
        consulted = true;
        return { kind: "wake", text: "go" };
      }),
    ]);

    for (const cause of ["awaiting-input", "aborted"] as const) {
      assert.equal(await engine.run({ ...REQUEST, cause }), null);
    }
    assert.equal(consulted, false);
    assert.equal(interlockReason(), "not-settled");
  });
});

describe("createLoopEngine — construction", () => {
  it("rejects duplicate strategy names (budget account keys)", () => {
    assert.throws(
      () =>
        createLoopEngine([
          handler("dup", async () => ({ kind: "wake", text: "go" })),
          handler("dup", async () => ({ kind: "wake", text: "go" })),
        ]),
      /duplicate strategy name "dup"/,
    );
  });
});

describe("createLoopEngine — budget interlock", () => {
  it("skips a strategy whose budget is exhausted and logs its name", async () => {
    let consulted = false;
    const engine = createLoopEngine(
      [
        handler(
          "spent",
          async () => {
            consulted = true;
            return { kind: "wake", text: "go" };
          },
          2,
        ),
      ],
      { store: new Map([["s1", new Map([["spent", 2]])]]) },
    );

    assert.equal(await engine.run(REQUEST), null);
    assert.equal(consulted, false);
    assert.equal(interlockReason(), "budget-exhausted");
    const entry = _getBufferForTesting().find(
      (e) => e.event === "settle_interlock",
    );
    assert.equal(entry?.handler, "spent");
  });

  it("reports budget-exhausted before a strategy's no-progress gate", async () => {
    // The budget interlock runs before the strategy, so an exhausted
    // budget is the logged reason even when the turn also made no progress.
    let consulted = false;
    const engine = createLoopEngine(
      [
        handler(
          "strategy",
          async () => {
            consulted = true;
            return { kind: "silence", reason: "no-progress" };
          },
          1,
        ),
      ],
      { store: new Map([["s1", new Map([["strategy", 1]])]]) },
    );

    assert.equal(await engine.run({ ...REQUEST, progress: false }), null);
    assert.equal(consulted, false);
    assert.equal(interlockReason(), "budget-exhausted");
  });

  it("wakes at the budget boundary used == maxWakes - 1", async () => {
    const engine = createLoopEngine(
      [handler("waker", async () => ({ kind: "wake", text: "go" }), 2)],
      { store: new Map([["s1", new Map([["waker", 1]])]]) },
    );

    assert.deepEqual(await engine.run(REQUEST), { name: "waker", text: "go" });
  });

  it("cards each strategy's budget separately", async () => {
    // `spent` is out of budget; `fresh` still has an allowance and wins.
    let spentConsulted = false;
    const engine = createLoopEngine(
      [
        handler(
          "spent",
          async () => {
            spentConsulted = true;
            return { kind: "wake", text: "spent" };
          },
          1,
        ),
        handler("fresh", async () => ({ kind: "wake", text: "fresh" })),
      ],
      {
        store: new Map([
          [
            "s1",
            new Map([
              ["spent", 1],
              ["fresh", 0],
            ]),
          ],
        ]),
      },
    );

    assert.deepEqual(await engine.run(REQUEST), {
      name: "fresh",
      text: "fresh",
    });
    assert.equal(spentConsulted, false);
  });
});

describe("createLoopEngine — convergence", () => {
  it("returns the first wake decision labelled with its strategy", async () => {
    const calls: string[] = [];
    const engine = createLoopEngine([
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
    ]);

    assert.deepEqual(await engine.run(REQUEST), { name: "waker", text: "go" });
    assert.deepEqual(calls, ["silent", "waker"]);
  });

  it("returns null when every strategy silences and logs each gate", async () => {
    const engine = createLoopEngine([
      handler("a", async () => ({ kind: "silence", reason: "empty" })),
      handler("b", async () => ({ kind: "silence", reason: "no-active" })),
    ]);

    assert.equal(await engine.run(REQUEST), null);
    const silent = _getBufferForTesting().filter(
      (entry) => entry.event === "settle_silent",
    );
    assert.deepEqual(
      silent.map((entry) => [entry.handler, entry.reason]),
      [
        ["a", "empty"],
        ["b", "no-active"],
      ],
    );
  });

  it("returns null for an empty strategy list", async () => {
    const engine = createLoopEngine([]);
    assert.equal(await engine.run(REQUEST), null);
  });

  it("isolates a throwing strategy and continues", async () => {
    const engine = createLoopEngine([
      handler("boom", async () => {
        throw new Error("handler failed");
      }),
      handler("ok", async () => ({ kind: "wake", text: "after crash" })),
    ]);

    assert.deepEqual(await engine.run(REQUEST), {
      name: "ok",
      text: "after crash",
    });
    const crashed = _getBufferForTesting().filter(
      (entry) => entry.event === "handler_crashed",
    );
    assert.equal(crashed.length, 1);
    assert.equal(crashed[0].handler, "boom");
  });

  it("passes only the session and progress to a strategy", async () => {
    let seen: unknown;
    const engine = createLoopEngine([
      handler("probe", async (input) => {
        seen = input;
        return { kind: "silence", reason: "empty" };
      }),
    ]);

    await engine.run({ sessionID: "s9", cause: "settled", progress: false });
    assert.deepEqual(seen, { sessionID: "s9", progress: false });
  });
});

describe("createLoopEngine — budget bookkeeping", () => {
  it("records, observes, and resets the per-strategy count", () => {
    const engine = createLoopEngine([]);

    assert.equal(engine.used("s1", "a"), 0);
    engine.record("s1", "a");
    engine.record("s1", "a");
    assert.equal(engine.used("s1", "a"), 2);
    engine.reset("s1");
    assert.equal(engine.used("s1", "a"), 0);
  });

  it("keeps separate accounts per strategy", () => {
    const engine = createLoopEngine([]);

    engine.record("s1", "a");
    engine.record("s1", "a");
    engine.record("s1", "b");

    assert.equal(engine.used("s1", "a"), 2);
    assert.equal(engine.used("s1", "b"), 1);
    assert.equal(engine.used("s2", "a"), 0);
  });

  it("evicts the oldest-inserted sessions past the cap", () => {
    const store = new Map<string, Map<string, number>>();
    for (let i = 0; i < 100; i += 1) store.set(`s${i}`, new Map([["a", 1]]));
    const engine = createLoopEngine([], { cap: 100, store });

    engine.record("s100", "a");

    assert.equal(store.size, 100);
    assert.equal(store.has("s0"), false, "oldest entry evicted");
    assert.equal(engine.used("s100", "a"), 1, "new entry retained");
  });
});
