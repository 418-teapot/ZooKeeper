/**
 * Tests for the loop engine (`engine.ts`).
 *
 * Locks the cause interlock (a non-settled turn returns `null` before any
 * strategy runs with its own logged reason), the per-strategy budget
 * interlock (a strategy whose allowance is spent is logged
 * `budget-exhausted` with its name and skipped so later strategies may
 * still win), the per-(session, strategy) awaiting-progress lock (a
 * delivered wake skips that strategy's later no-activity settles
 * without spending budget while other strategies are still consulted;
 * any tool activity releases every lock of the session), the
 * first-wake selection, per-handler crash
 * isolation, the fail-closed `null` for an all-silent or empty strategy
 * list, and the per-(session, strategy) bookkeeping (`record` / `reset`
 * / `used`) including the optional session cap.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { restoreEnv, saveEnv } from "../../testkits/env.js";
import { _getBufferForTesting, _resetForTesting } from "../../utils/logger.js";
import type { SettledContribution, SettleRequest } from "../slots.js";
import type { Decision } from "./engine.js";
import { createLoopEngine } from "./engine.js";

let origDebug: string | undefined;

beforeEach(() => {
  origDebug = saveEnv("ZOO_DEBUG");
  process.env.ZOO_DEBUG = "1";
});

afterEach(() => {
  restoreEnv("ZOO_DEBUG", origDebug);
  _resetForTesting();
});

/** A settled request whose turn made a tool call. */
const REQUEST: SettleRequest = {
  sessionID: "s1",
  cause: "settled",
  hadActivity: true,
};

/** Build a named contribution from a judging function. */
function handler(
  name: string,
  fn: (input: { sessionID: string; hadActivity: boolean }) => Promise<Decision>,
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

  it("reports budget-exhausted before the strategy handler runs", async () => {
    // The budget interlock runs before the strategy, so an exhausted
    // budget is the logged reason even when the strategy would silence
    // with its own gate reason.
    let consulted = false;
    const engine = createLoopEngine(
      [
        handler(
          "strategy",
          async () => {
            consulted = true;
            return { kind: "silence", reason: "no-active" };
          },
          1,
        ),
      ],
      { store: new Map([["s1", new Map([["strategy", 1]])]]) },
    );

    assert.equal(await engine.run({ ...REQUEST, hadActivity: false }), null);
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

  it("passes only the session and the activity fact to a strategy", async () => {
    let seen: unknown;
    const engine = createLoopEngine([
      handler("probe", async (input) => {
        seen = input;
        return { kind: "silence", reason: "empty" };
      }),
    ]);

    await engine.run({
      sessionID: "s9",
      cause: "settled",
      hadActivity: false,
    });
    assert.deepEqual(seen, { sessionID: "s9", hadActivity: false });
  });
});

describe("createLoopEngine — awaiting-progress lock", () => {
  /** A waker engine with a consultation counter that can be re-zeroed. */
  function wakerEngine(): {
    engine: ReturnType<typeof createLoopEngine>;
    consulted: () => number;
    zero: () => void;
  } {
    let consulted = 0;
    const engine = createLoopEngine([
      handler("waker", async () => {
        consulted += 1;
        return { kind: "wake", text: "go" };
      }),
    ]);
    return {
      engine,
      consulted: () => consulted,
      zero: () => {
        consulted = 0;
      },
    };
  }

  it("silences a delivered wake's follow-up no-activity settle without spending budget", async () => {
    const { engine, consulted, zero } = wakerEngine();
    assert.deepEqual(await engine.run(REQUEST), { name: "waker", text: "go" });
    engine.record("s1", "waker");
    zero();

    assert.equal(
      await engine.run({ ...REQUEST, hadActivity: false }),
      null,
      "the locked strategy is skipped",
    );
    assert.equal(consulted(), 0, "the locked strategy is not consulted");
    assert.equal(interlockReason(), "awaiting-activity");
    assert.equal(
      engine.used("s1", "waker"),
      1,
      "the locked settle spends no budget",
    );

    assert.equal(await engine.run({ ...REQUEST, hadActivity: false }), null);
    assert.equal(consulted(), 0, "the lock survives another idle settle");
  });

  it("skips only the locked strategy and still consults unlocked ones", async () => {
    // The collateral-damage case: a text-only reply to A's wake must
    // not silence B's legitimate wake on the same session.
    const consulted: string[] = [];
    const engine = createLoopEngine([
      handler("locked-a", async () => {
        consulted.push("locked-a");
        return { kind: "wake", text: "a" };
      }),
      handler("fresh-b", async () => {
        consulted.push("fresh-b");
        return { kind: "wake", text: "b" };
      }),
    ]);
    engine.record("s1", "locked-a");

    assert.deepEqual(
      await engine.run({ ...REQUEST, hadActivity: false }),
      { name: "fresh-b", text: "b" },
      "the unlocked strategy still wins",
    );
    assert.deepEqual(consulted, ["fresh-b"], "the locked one is skipped");
    const entry = _getBufferForTesting()
      .filter((e) => e.event === "settle_interlock")
      .at(-1);
    assert.equal(entry?.reason, "awaiting-activity");
    assert.equal(entry?.handler, "locked-a");
    assert.equal(
      engine.used("s1", "locked-a"),
      1,
      "the skip spends no budget and keeps the lock",
    );

    consulted.length = 0;
    assert.deepEqual(
      await engine.run({ ...REQUEST, hadActivity: false }),
      { name: "fresh-b", text: "b" },
      "A stays locked across another idle settle",
    );
    assert.deepEqual(consulted, ["fresh-b"]);
    assert.equal(engine.used("s1", "locked-a"), 1);
  });

  it("releases every locked strategy of the session on any activity", async () => {
    const consulted: string[] = [];
    const engine = createLoopEngine([
      handler("a", async () => {
        consulted.push("a");
        return { kind: "silence", reason: "no-active" };
      }),
      handler("b", async () => {
        consulted.push("b");
        return { kind: "silence", reason: "no-active" };
      }),
    ]);
    engine.record("s1", "a");
    engine.record("s1", "b");

    assert.equal(
      await engine.run({ ...REQUEST, hadActivity: false }),
      null,
      "both strategies locked: every one skipped, nothing wakes",
    );
    assert.deepEqual(consulted, []);

    assert.equal(await engine.run(REQUEST), null);
    assert.deepEqual(
      consulted,
      ["a", "b"],
      "one active turn answers all pending wakes",
    );
  });

  it("releases the lock on any tool activity and evaluates normally", async () => {
    const { engine, consulted, zero } = wakerEngine();
    await engine.run(REQUEST);
    engine.record("s1", "waker");
    zero();

    assert.deepEqual(
      await engine.run({ ...REQUEST, hadActivity: true }),
      { name: "waker", text: "go" },
      "a read-only turn still counts as activity and releases the lock",
    );
    assert.equal(consulted(), 1);
  });

  it("does not lock on a wake that was never recorded as delivered", async () => {
    const { engine, consulted, zero } = wakerEngine();
    await engine.run(REQUEST);
    zero();

    assert.deepEqual(
      await engine.run({ ...REQUEST, hadActivity: false }),
      { name: "waker", text: "go" },
      "no record() means no lock",
    );
    assert.equal(consulted(), 1);
  });

  it("clears the lock together with the budget on reset", async () => {
    const { engine, consulted, zero } = wakerEngine();
    await engine.run(REQUEST);
    engine.record("s1", "waker");
    engine.reset("s1");
    zero();

    assert.deepEqual(
      await engine.run({ ...REQUEST, hadActivity: false }),
      { name: "waker", text: "go" },
      "a real user turn clears the lock",
    );
    assert.equal(consulted(), 1);
    assert.equal(engine.used("s1", "waker"), 0);
  });

  it("evicts a locked session's lock with its budget past the cap", async () => {
    let consulted = 0;
    const capped = createLoopEngine(
      [
        handler("waker", async () => {
          consulted += 1;
          return { kind: "wake", text: "go" };
        }),
      ],
      { cap: 1 },
    );
    capped.record("s1", "waker");
    // A second recorded session pushes the cap-1 store past its bound,
    // evicting s1's budget account and its lock.
    capped.record("s2", "waker");

    assert.deepEqual(
      await capped.run({
        sessionID: "s1",
        cause: "settled",
        hadActivity: false,
      }),
      { name: "waker", text: "go" },
      "the evicted session is no longer locked",
    );
    assert.equal(consulted, 1);
    assert.equal(capped.used("s1", "waker"), 0, "budget evicted with the lock");
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
