/**
 * Tests for the lifecycle orchestration in `run.ts`.
 *
 * Covers every remaining run outcome: normal passthrough, driver throw
 * collapse, parent abort propagation (both to the driver signal and to the
 * result), progress pass-through, and identity resolution inside the driver
 * callback.  Concurrency and timeout behaviours were removed with the
 * corresponding constraints and are no longer orchestrated here.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type {
  SubagentDriver,
  SubagentProgress,
  SubagentResult,
} from "./driver.js";
import { type Identity, resolveIdentity } from "./identity.js";
import { runSubagent } from "./run.js";

/**
 * Flush pending microtasks and one macrotask turn.
 *
 * Lets promises queued by synchronous drivers settle before asserting on
 * observable side effects like signal state.
 */
function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** A fresh request for a named agent. */
function request(agent = "worker") {
  return {
    agent,
    prompt: "do the thing",
    tools: ["edit"],
    // Strict mode: a request always carries a configured model.
    model: "Provider/model",
  };
}

/** A never-aborted parent signal. */
function freshSignal(): AbortSignal {
  return new AbortController().signal;
}

// ---------------------------------------------------------------------------
// Outcome mapping — passthrough
// ---------------------------------------------------------------------------

describe("runSubagent — driver passthrough", () => {
  it("passes through an ok result unchanged", async () => {
    const driver: SubagentDriver = {
      async run(): Promise<SubagentResult> {
        return { kind: "ok", text: "finished" };
      },
    };
    const result = await runSubagent(driver, request(), {
      signal: freshSignal(),
    });
    assert.deepEqual(result, { kind: "ok", text: "finished" });
  });

  it("passes through a driver error result unchanged", async () => {
    const driver: SubagentDriver = {
      async run(): Promise<SubagentResult> {
        return {
          kind: "error",
          text: "partial",
          errorMessage: "session failed",
        };
      },
    };
    const result = await runSubagent(driver, request(), {
      signal: freshSignal(),
    });
    assert.deepEqual(result, {
      kind: "error",
      text: "partial",
      errorMessage: "session failed",
    });
  });

  it("passes through a driver aborted result when the parent did not abort", async () => {
    const driver: SubagentDriver = {
      async run(): Promise<SubagentResult> {
        return { kind: "aborted", text: "host session aborted" };
      },
    };
    const result = await runSubagent(driver, request(), {
      signal: freshSignal(),
    });
    assert.deepEqual(result, { kind: "aborted", text: "host session aborted" });
  });

  it("forwards onProgress to the driver unchanged", async () => {
    const received: SubagentProgress[] = [];
    let driverOnProgress: ((p: SubagentProgress) => void) | undefined;
    const driver: SubagentDriver = {
      async run(_req, ctx): Promise<SubagentResult> {
        driverOnProgress = ctx.onProgress;
        ctx.onProgress?.({
          currentTool: "edit",
          done: false,
        });
        ctx.onProgress?.({ done: true });
        return { kind: "ok", text: "done" };
      },
    };
    const onProgress = (p: SubagentProgress): void => {
      received.push(p);
    };
    const result = await runSubagent(driver, request(), {
      signal: freshSignal(),
      onProgress,
    });
    assert.equal(driverOnProgress, onProgress);
    assert.deepEqual(received, [
      { currentTool: "edit", done: false },
      { done: true },
    ]);
    assert.equal(result.kind, "ok");
  });
});

// ---------------------------------------------------------------------------
// Outcome mapping — driver throw collapse
// ---------------------------------------------------------------------------

describe("runSubagent — driver throw collapse", () => {
  it("collapses a driver rejection into an error result", async () => {
    const driver: SubagentDriver = {
      async run(): Promise<SubagentResult> {
        throw new Error("provider exploded");
      },
    };
    const result = await runSubagent(driver, request(), {
      signal: freshSignal(),
    });
    assert.deepEqual(result, {
      kind: "error",
      text: "",
      errorMessage: "provider exploded",
    });
  });

  it("collapses a non-Error rejection into an error result", async () => {
    const driver: SubagentDriver = {
      async run(): Promise<SubagentResult> {
        throw "boom";
      },
    };
    const result = await runSubagent(driver, request(), {
      signal: freshSignal(),
    });
    assert.equal(result.kind, "error");
    if (result.kind === "error") {
      assert.equal(result.errorMessage, "boom");
    }
  });
});

// ---------------------------------------------------------------------------
// Outcome mapping — parent abort
// ---------------------------------------------------------------------------

describe("runSubagent — parent abort", () => {
  it("propagates a parent abort to the driver signal and yields aborted", async () => {
    const parent = new AbortController();
    let received: AbortSignal | undefined;
    const driver: SubagentDriver = {
      async run(_req, ctx): Promise<SubagentResult> {
        received = ctx.signal;
        return new Promise<SubagentResult>((resolve) => {
          if (ctx.signal.aborted) {
            resolve({ kind: "aborted", text: "stopped early" });
          } else {
            ctx.signal.addEventListener(
              "abort",
              () => resolve({ kind: "aborted", text: "stopped early" }),
              { once: true },
            );
          }
        });
      },
    };

    const pending = runSubagent(driver, request(), { signal: parent.signal });

    await tick();
    assert.ok(received);
    assert.equal(received?.aborted, false);

    parent.abort();
    const result = await pending;
    assert.ok(received?.aborted);
    assert.deepEqual(result, { kind: "aborted", text: "stopped early" });
  });

  it("yields aborted when the parent signal is already aborted at launch", async () => {
    const parent = new AbortController();
    parent.abort();
    let received: AbortSignal | undefined;
    const driver: SubagentDriver = {
      async run(_req, ctx): Promise<SubagentResult> {
        received = ctx.signal;
        return { kind: "aborted", text: "was already stopped" };
      },
    };
    const result = await runSubagent(driver, request(), {
      signal: parent.signal,
    });
    assert.ok(received?.aborted);
    assert.deepEqual(result, {
      kind: "aborted",
      text: "was already stopped",
    });
  });
});

// ---------------------------------------------------------------------------
// Identity binding
// ---------------------------------------------------------------------------

describe("runSubagent — identity binding", () => {
  it("resolves the subagent identity inside the driver callback", async () => {
    let seen: Identity | undefined;
    const driver: SubagentDriver = {
      async run(req): Promise<SubagentResult> {
        seen = resolveIdentity();
        // Survive a real async yield so the identity must be carried by the
        // async context, not read from a synchronous frame.
        await Promise.resolve();
        return { kind: "ok", text: "done" };
      },
    };
    const result = await runSubagent(driver, request("delegate"), {
      signal: freshSignal(),
    });
    assert.deepEqual(seen, { kind: "subagent", name: "delegate" });
    assert.equal(result.kind, "ok");
  });
});
