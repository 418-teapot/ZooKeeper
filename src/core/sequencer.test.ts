/**
 * Unit tests for the state-change gate (src/core/sequencer).
 *
 * Locks the properties the tools rely on when they move their state
 * protection inside themselves: an uncontended call starts immediately,
 * concurrent entrants run one at a time in arrival order, a rejected
 * entrant never blocks the queue, and every caller receives the outcome of
 * its own function.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createSequencer } from "./sequencer.js";

/** Resolve after the given number of microtask turns. */
function tick(n: number): Promise<void> {
  let p = Promise.resolve();
  for (let i = 0; i < n; i += 1) p = p.then(() => undefined);
  return p;
}

describe("sequencer ordering", () => {
  it("runs concurrent entrants in arrival order without overlap", async () => {
    const serialize = createSequencer();
    const events: string[] = [];

    const job = (name: string, ticks: number) =>
      serialize(async () => {
        events.push(`start:${name}`);
        await tick(ticks);
        events.push(`end:${name}`);
        return name;
      });

    // Submitted concurrently: the slow first job must still delay the rest.
    const results = await Promise.all([job("a", 5), job("b", 1), job("c", 2)]);

    assert.deepEqual(results, ["a", "b", "c"]);
    assert.deepEqual(events, [
      "start:a",
      "end:a",
      "start:b",
      "end:b",
      "start:c",
      "end:c",
    ]);
  });

  it("starts an uncontended call without waiting a tick", async () => {
    const serialize = createSequencer();
    let started = false;

    const running = serialize(async () => {
      started = true;
      return "now";
    });

    // No microtask boundary: a tool that draws a dialog synchronously as
    // soon as the host calls it still does so behind the gate.
    assert.ok(started, "a free gate must run the call immediately");
    assert.equal(await running, "now");
  });

  it("keeps arrival order for same-tick submissions", async () => {
    const serialize = createSequencer();
    const order: number[] = [];

    await Promise.all(
      [0, 1, 2, 3, 4].map((i) =>
        serialize(async () => {
          await tick(1);
          order.push(i);
          return i;
        }),
      ),
    );

    assert.deepEqual(order, [0, 1, 2, 3, 4]);
  });

  it("serialises a re-entrant-free mix of fast and slow callers", async () => {
    const serialize = createSequencer();
    let running = 0;
    let maxRunning = 0;

    const bodies = Array.from({ length: 8 }, (_, i) =>
      serialize(async () => {
        running += 1;
        maxRunning = Math.max(maxRunning, running);
        await tick(i % 3);
        running -= 1;
        return i;
      }),
    );

    assert.deepEqual(await Promise.all(bodies), [0, 1, 2, 3, 4, 5, 6, 7]);
    assert.equal(maxRunning, 1);
  });
});

describe("sequencer failure isolation", () => {
  it("lets a rejected caller fail alone and keeps the queue moving", async () => {
    const serialize = createSequencer();
    const ran: string[] = [];

    const first = serialize(async () => {
      ran.push("first");
      throw new Error("boom");
    });
    const second = serialize(async () => {
      ran.push("second");
      return 42;
    });
    const third = serialize(async () => {
      ran.push("third");
      throw new Error("bang");
    });
    const fourth = serialize(async () => {
      ran.push("fourth");
      return "ok";
    });

    await assert.rejects(first, /boom/);
    assert.equal(await second, 42);
    await assert.rejects(third, /bang/);
    assert.equal(await fourth, "ok");
    assert.deepEqual(ran, ["first", "second", "third", "fourth"]);
  });

  it("routes each rejection to its own caller only", async () => {
    const serialize = createSequencer();

    const outcomes = await Promise.allSettled([
      serialize(async () => {
        await tick(2);
        throw new Error("e1");
      }),
      serialize(async () => {
        await tick(1);
        throw new Error("e2");
      }),
      serialize(async () => "fine"),
    ]);

    assert.deepEqual(
      outcomes.map((o) =>
        o.status === "fulfilled"
          ? `ok:${String(o.value)}`
          : `err:${(o.reason as Error).message}`,
      ),
      ["err:e1", "err:e2", "ok:fine"],
    );
  });

  it("propagates an early throw and still releases the gate", async () => {
    const serialize = createSequencer();

    await assert.rejects(
      serialize(async () => {
        throw new Error("early");
      }),
      /early/,
    );
    // The chain survives it.
    assert.equal(await serialize(async () => "still working"), "still working");
  });
});

describe("sequencer independence", () => {
  it("keeps separate sequencers independent", async () => {
    const one = createSequencer();
    const two = createSequencer();
    const events: string[] = [];

    const slow = one(async () => {
      events.push("one:start");
      await tick(5);
      events.push("one:end");
    });
    const fast = two(async () => {
      events.push("two:start");
      await tick(1);
      events.push("two:end");
    });

    await Promise.all([slow, fast]);
    // Different locks protect different resources: no cross-queue waiting.
    assert.deepEqual(events, ["one:start", "two:start", "two:end", "one:end"]);
  });
});
