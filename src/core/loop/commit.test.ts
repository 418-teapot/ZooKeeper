/**
 * Tests for the settle commit gate (`commit.ts`).
 *
 * The gate is the one place a host turns a verdict into a delivered wake, so
 * these tests drive it over the real engine and a recording delivery.  The
 * boundary is `commitSettle` itself: the host-visible contract is which
 * strategies run, whether a wake is charged, and whether the delivery
 * starts — never the gate's internals.
 *
 * A cancelled settle is normal silence: it consults no further strategy and
 * commits nothing.  A cancellation that lands once the delivery started
 * keeps the charge, so a stop can never become an unbounded retry loop.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { restoreEnv, saveEnv } from "../../testkits/env.js";
import { _getBufferForTesting, _resetForTesting } from "../../utils/logger.js";
import { commitSettle } from "./commit.js";
import { createLoopEngine, type LoopSession, type Wake } from "./engine.js";
import type { Decision, SettledInput, SettleRequest } from "./settle.js";

let origDebug: string | undefined;

beforeEach(() => {
  origDebug = saveEnv("ZOO_DEBUG");
  process.env.ZOO_DEBUG = "1";
});

afterEach(() => {
  restoreEnv("ZOO_DEBUG", origDebug);
  _resetForTesting();
});

/** A promise plus its resolvers, used to hold work mid-flight. */
function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** The one strategy name under test (the budget account key). */
const WAKER = "waker";

/** A wake verdict. */
const WAKE: Decision = { kind: "wake", text: "go" };

/** A silence verdict with no strategy-specific gate. */
const SILENT: Decision = { kind: "silence", reason: "empty" };

/** A settled turn that made a tool call, under `signal`. */
function request(signal: AbortSignal): SettleRequest {
  return { cause: "settled", hadActivity: true, signal };
}

/** Build one session handle whose single strategy answers `handle`. */
function session(
  handle: (input: SettledInput) => Promise<Decision>,
  maxWakes = 3,
): LoopSession {
  const engine = createLoopEngine([{ name: WAKER, maxWakes, handle }]);
  return engine.createSession("s1");
}

/** The judge events the gate and the engine wrote, in log order. */
function judgeEvents(): string[] {
  const names = new Set(["settle_cancelled", "wake_injected", "settle_silent"]);
  return _getBufferForTesting()
    .filter((entry) => names.has(String(entry.event)))
    .map((entry) => String(entry.event));
}

describe("commitSettle — cancelled before the verdict", () => {
  it("consults no strategy and commits nothing", async () => {
    const controller = new AbortController();
    controller.abort();
    let consulted = 0;
    const delivered: Wake[] = [];
    const loop = session(async () => {
      consulted += 1;
      return WAKE;
    });

    const result = await commitSettle(
      loop,
      request(controller.signal),
      async (wake) => {
        delivered.push(wake);
        return "sent";
      },
    );

    assert.equal(result, null);
    assert.equal(consulted, 0, "no strategy is consulted");
    assert.deepEqual(delivered, [], "nothing is delivered");
    assert.equal(loop.used(WAKER), 0, "nothing is charged");
  });

  it("ends the settle between two strategies", async () => {
    const controller = new AbortController();
    let second = 0;
    const engine = createLoopEngine([
      {
        name: "first",
        maxWakes: 3,
        handle: async () => {
          controller.abort();
          return SILENT;
        },
      },
      {
        name: "second",
        maxWakes: 3,
        handle: async () => {
          second += 1;
          return WAKE;
        },
      },
    ]);
    const loop = engine.createSession("s1");
    let delivered = 0;

    const result = await commitSettle(
      loop,
      request(controller.signal),
      async () => {
        delivered += 1;
        return "sent";
      },
    );

    assert.equal(result, null);
    assert.equal(second, 0, "the later strategy is not consulted");
    assert.equal(delivered, 0);
    assert.equal(loop.used("second"), 0);
  });
});

describe("commitSettle — cancelled by the verdict", () => {
  it("drops the wake that arrived after the stop", async () => {
    const controller = new AbortController();
    const entered = deferred<void>();
    const gate = deferred<void>();
    const loop = session(async () => {
      entered.resolve();
      await gate.promise;
      return WAKE;
    });
    let delivered = 0;

    const pending = commitSettle(loop, request(controller.signal), async () => {
      delivered += 1;
      return "sent";
    });
    await entered.promise;
    controller.abort();
    gate.resolve();

    assert.equal(await pending, null);
    assert.equal(delivered, 0, "the cancelled verdict is not delivered");
    assert.equal(loop.used(WAKER), 0, "the cancelled verdict is not charged");
    assert.deepEqual(judgeEvents(), ["settle_cancelled"]);
  });
});

describe("commitSettle — commit", () => {
  it("charges the wake before the delivery starts", async () => {
    const loop = session(async () => WAKE);
    const charges: number[] = [];

    const result = await commitSettle(
      loop,
      request(new AbortController().signal),
      async (wake, signal) => {
        assert.equal(wake.name, WAKER);
        assert.equal(wake.text, "go");
        assert.equal(signal.aborted, false);
        charges.push(loop.used(WAKER));
        return "sent";
      },
    );

    assert.equal(result, "sent", "the delivery's result reaches the caller");
    assert.deepEqual(charges, [1], "the charge precedes the delivery");
    assert.equal(loop.used(WAKER), 1);
  });

  it("keeps the charge when the stop lands mid-delivery", async () => {
    const controller = new AbortController();
    const entered = deferred<void>();
    const release = deferred<void>();
    const loop = session(async () => WAKE, 1);

    const pending = commitSettle(loop, request(controller.signal), async () => {
      entered.resolve();
      await release.promise;
      return "sent";
    });
    await entered.promise;
    controller.abort();
    release.resolve();

    assert.equal(await pending, "sent", "the started delivery is awaited");
    assert.equal(loop.used(WAKER), 1, "the charge stands");

    // A spent budget silences the next settle: the stop cannot re-wake.
    let redelivered = 0;
    const again = await commitSettle(
      loop,
      request(new AbortController().signal),
      async () => {
        redelivered += 1;
        return "sent";
      },
    );
    assert.equal(again, null);
    assert.equal(redelivered, 0);
  });

  it("delivers nothing for a silent settle", async () => {
    const loop = session(async () => SILENT);
    let delivered = 0;

    const result = await commitSettle(
      loop,
      request(new AbortController().signal),
      async () => {
        delivered += 1;
        return "sent";
      },
    );

    assert.equal(result, null);
    assert.equal(delivered, 0);
    assert.equal(loop.used(WAKER), 0);
  });
});
