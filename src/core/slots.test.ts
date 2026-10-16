/**
 * Tests for `makeHookContributions` in `src/core/slots.ts`.
 *
 * Covers the default-empty slot set and partial overrides.
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { _getBufferForTesting, _resetForTesting } from "../utils/logger.js";
import {
  makeHookContributions,
  runIsolated,
  runIsolatedSync,
} from "./slots.js";

afterEach(() => {
  _resetForTesting();
});

describe("makeHookContributions", () => {
  it("defaults every hook slot to an empty array", () => {
    const contributions = makeHookContributions();

    assert.equal(contributions.kind, "hook");
    assert.deepEqual(contributions.afterExec, []);
    assert.deepEqual(contributions.transform, []);
    assert.deepEqual(contributions.textComplete, []);
    assert.deepEqual(contributions.toolDefinition, []);
    assert.deepEqual(contributions.delegation, []);
    assert.deepEqual(contributions.onSettled, []);
  });

  it("applies the named slot and keeps omitted slots empty", () => {
    const handler = { name: "x", handle: async () => {} };
    const contributions = makeHookContributions({ afterExec: [handler] });

    assert.deepEqual(contributions.afterExec, [handler]);
    assert.deepEqual(contributions.transform, []);
    assert.deepEqual(contributions.textComplete, []);
    assert.deepEqual(contributions.toolDefinition, []);
    assert.deepEqual(contributions.delegation, []);
    assert.deepEqual(contributions.onSettled, []);
  });
});

/** Count the buffered `handler_crashed` entries. */
function crashedEntries(): Array<Record<string, unknown>> {
  return _getBufferForTesting().filter(
    (entry) => entry.event === "handler_crashed",
  );
}

describe("runIsolated", () => {
  it("runs every contribution in order", async () => {
    const order: string[] = [];
    await runIsolated(
      [{ name: "a" }, { name: "b" }],
      (contribution) => {
        order.push(contribution.name);
      },
      { sessionID: "s" },
    );
    assert.deepEqual(order, ["a", "b"]);
  });

  it("isolates a synchronous throw and continues", async () => {
    const order: string[] = [];
    await runIsolated(
      [
        {
          name: "boom",
          handle: () => {
            order.push("boom");
            throw new Error("boom");
          },
        },
        {
          name: "ok",
          handle: () => {
            order.push("ok");
          },
        },
      ],
      (contribution) => contribution.handle(),
      { sessionID: "s", callId: "c" },
    );

    assert.deepEqual(order, ["boom", "ok"]);
    const crashed = crashedEntries();
    assert.equal(crashed.length, 1);
    assert.equal(crashed[0].hook, "plugin");
    assert.equal(crashed[0].sessionId, "s");
    assert.equal(crashed[0].callId, "c");
    assert.equal(crashed[0].handler, "boom");
    assert.equal(crashed[0].error, "Error: boom");
  });

  it("isolates an async rejection and continues", async () => {
    const order: string[] = [];
    await runIsolated(
      [
        {
          name: "async-boom",
          handle: async () => {
            order.push("async-boom");
            throw new Error("async boom");
          },
        },
        {
          name: "ok",
          handle: async () => {
            order.push("ok");
          },
        },
      ],
      (contribution) => contribution.handle(),
      { sessionID: "s" },
    );

    assert.deepEqual(order, ["async-boom", "ok"]);
    const crashed = crashedEntries();
    assert.equal(crashed.length, 1);
    assert.equal(crashed[0].handler, "async-boom");
    assert.equal(crashed[0].callId, undefined);
  });

  it("is a no-op for an empty list", async () => {
    await runIsolated([], () => {}, { sessionID: "s" });
    assert.deepEqual(crashedEntries(), []);
  });
});

describe("runIsolatedSync", () => {
  it("runs every contribution in order", () => {
    const order: string[] = [];
    runIsolatedSync(
      [{ name: "a" }, { name: "b" }],
      (contribution) => {
        order.push(contribution.name);
      },
      { sessionID: "s" },
    );
    assert.deepEqual(order, ["a", "b"]);
  });

  it("isolates a throw and continues", () => {
    const order: string[] = [];
    runIsolatedSync(
      [
        {
          name: "boom",
          handle: () => {
            order.push("boom");
            throw new Error("sync boom");
          },
        },
        {
          name: "ok",
          handle: () => {
            order.push("ok");
          },
        },
      ],
      (contribution) => contribution.handle(),
      { sessionID: "s", callId: "0" },
    );

    assert.deepEqual(order, ["boom", "ok"]);
    const crashed = crashedEntries();
    assert.equal(crashed.length, 1);
    assert.equal(crashed[0].handler, "boom");
    assert.equal(crashed[0].callId, "0");
  });

  it("records an async handler rejection without throwing", async () => {
    const order: string[] = [];
    runIsolatedSync(
      [
        {
          name: "async-boom",
          handle: async () => {
            order.push("async-boom");
            throw new Error("async sync boom");
          },
        },
        {
          name: "ok",
          handle: () => {
            order.push("ok");
          },
        },
      ],
      (contribution) => contribution.handle(),
      { sessionID: "s", callId: "0" },
    );

    // The synchronous loop returns before the rejection settles.
    assert.deepEqual(order, ["async-boom", "ok"]);
    assert.deepEqual(crashedEntries(), []);

    // Let the rejected promise settle so its `.catch` fires.
    await new Promise((resolve) => setTimeout(resolve, 0));
    const crashed = crashedEntries();
    assert.equal(crashed.length, 1);
    assert.equal(crashed[0].handler, "async-boom");
    assert.equal(crashed[0].sessionId, "s");
    assert.equal(crashed[0].callId, "0");
    assert.equal(crashed[0].error, "Error: async sync boom");
  });

  it("is a no-op for an empty list", () => {
    runIsolatedSync([], () => {}, { sessionID: "s" });
    assert.deepEqual(crashedEntries(), []);
  });
});
