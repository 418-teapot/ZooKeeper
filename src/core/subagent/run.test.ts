/**
 * Tests for the lifecycle orchestration in `run.ts`.
 *
 * Covers every remaining run outcome: normal passthrough, driver throw
 * collapse, parent abort propagation (both to the driver signal and to the
 * result), progress pass-through, and the configured run timeout (the timer
 * aborts the driver, which then settles the run as `timeout`).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type {
  SubagentDriver,
  SubagentProgress,
  SubagentResult,
} from "./driver.js";
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
// Outcome mapping — timeout
// ---------------------------------------------------------------------------

describe("runSubagent — timeout", () => {
  it("aborts the driver signal when the timeout elapses and reports timeout", async () => {
    // The driver honors the signal cooperatively, exactly like a host
    // driver: the timer only aborts, the run ends when the driver returns.
    let observed: AbortSignal | undefined;
    const driver: SubagentDriver = {
      async run(_req, ctx): Promise<SubagentResult> {
        observed = ctx.signal;
        return new Promise<SubagentResult>((resolve) => {
          ctx.signal.addEventListener(
            "abort",
            () => resolve({ kind: "aborted", text: "partial output" }),
            { once: true },
          );
        });
      },
    };

    const result = await runSubagent(driver, request(), {
      signal: freshSignal(),
      timeoutMs: 10,
    });

    assert.equal(observed?.aborted, true, "the timeout must abort the driver");
    assert.deepEqual(result, { kind: "timeout", text: "partial output" });
  });

  it("maps an error result produced after the timeout onto timeout", async () => {
    const driver: SubagentDriver = {
      async run(_req, ctx): Promise<SubagentResult> {
        return new Promise<SubagentResult>((resolve) => {
          ctx.signal.addEventListener(
            "abort",
            () =>
              resolve({
                kind: "error",
                text: "partial",
                errorMessage: "session aborted",
              }),
            { once: true },
          );
        });
      },
    };

    const result = await runSubagent(driver, request(), {
      signal: freshSignal(),
      timeoutMs: 10,
    });

    assert.deepEqual(result, { kind: "timeout", text: "partial" });
  });

  it("maps a driver rejection after the timeout onto timeout", async () => {
    // The timeout reason owns the outcome; the abort-driven rejection never
    // reaches the caller as an error.
    const driver: SubagentDriver = {
      async run(_req, ctx): Promise<SubagentResult> {
        return new Promise<SubagentResult>((_resolve, reject) => {
          ctx.signal.addEventListener(
            "abort",
            () => reject(new Error("aborted by signal")),
            { once: true },
          );
        });
      },
    };

    const result = await runSubagent(driver, request(), {
      signal: freshSignal(),
      timeoutMs: 10,
    });

    assert.deepEqual(result, { kind: "timeout", text: "" });
  });

  it("clears the timer when the run settles before it fires", async () => {
    let observed: AbortSignal | undefined;
    const driver: SubagentDriver = {
      async run(_req, ctx): Promise<SubagentResult> {
        observed = ctx.signal;
        return { kind: "ok", text: "done" };
      },
    };

    const result = await runSubagent(driver, request(), {
      signal: freshSignal(),
      timeoutMs: 10,
    });
    // A cleared timer never aborts the driver signal afterwards.
    await new Promise((resolve) => setTimeout(resolve, 30));

    assert.deepEqual(result, { kind: "ok", text: "done" });
    assert.equal(observed?.aborted, false);
  });

  it("keeps the parent abort semantics when the parent aborts first", async () => {
    const parent = new AbortController();
    const driver: SubagentDriver = {
      async run(_req, ctx): Promise<SubagentResult> {
        return new Promise<SubagentResult>((resolve) => {
          ctx.signal.addEventListener(
            "abort",
            () => resolve({ kind: "aborted", text: "stopped early" }),
            { once: true },
          );
        });
      },
    };

    const pending = runSubagent(driver, request(), {
      signal: parent.signal,
      timeoutMs: 10,
    });
    await tick();
    parent.abort();

    assert.deepEqual(await pending, {
      kind: "aborted",
      text: "stopped early",
    });
  });

  it("reports aborted, never timeout, when the parent signal is already aborted", async () => {
    const parent = new AbortController();
    parent.abort();
    let observed: AbortSignal | undefined;
    const driver: SubagentDriver = {
      async run(_req, ctx): Promise<SubagentResult> {
        observed = ctx.signal;
        return { kind: "aborted", text: "was already stopped" };
      },
    };

    const result = await runSubagent(driver, request(), {
      signal: parent.signal,
      timeoutMs: 10,
    });

    assert.equal(observed?.aborted, true);
    assert.deepEqual(result, {
      kind: "aborted",
      text: "was already stopped",
    });
  });

  it("forwards the parent signal itself when no timeout is configured", async () => {
    const parent = new AbortController();
    let observed: AbortSignal | undefined;
    const driver: SubagentDriver = {
      async run(_req, ctx): Promise<SubagentResult> {
        observed = ctx.signal;
        return { kind: "ok", text: "done" };
      },
    };

    await runSubagent(driver, request(), { signal: parent.signal });

    assert.equal(observed, parent.signal);
  });
});
