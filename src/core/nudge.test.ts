/**
 * Tests for the shared nudge-injection helper (`applyNudge`).
 *
 * The helper owns the common skeleton every nudge shares: lowercase the
 * tool name, pick the first matching rule, run the ordered guard chain,
 * append the produced text after a blank line, and emit the injected /
 * skipped log entries.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { restoreEnv, saveEnv } from "../testkits/env.js";
import { _getBufferForTesting, _resetForTesting } from "../utils/logger.js";
import { applyNudge, type NudgeContext, type NudgeRule } from "./nudge.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Capture debug-level skip entries for the assertions below. */
let origZooDebug: string | undefined;

beforeEach(() => {
  origZooDebug = saveEnv("ZOO_DEBUG");
  process.env.ZOO_DEBUG = "1";
});

afterEach(() => {
  restoreEnv("ZOO_DEBUG", origZooDebug);
  _resetForTesting();
});

/**
 * Build a context with a single always-matching throwaway rule replaced by
 * the caller's rules.
 */
function makeContext(
  output: { output?: string },
  rules: NudgeRule[],
  overrides: Partial<NudgeContext> = {},
): NudgeContext {
  return {
    hook: "test-hook",
    sessionID: "s1",
    callID: "c1",
    tool: "edit",
    output,
    rules,
    ...overrides,
  };
}

/** Find the first buffered log entry with the given event. */
function findLog(event: string): Record<string, unknown> | undefined {
  return _getBufferForTesting().find((e) => e.event === event);
}

// ---------------------------------------------------------------------------
// Injection
// ---------------------------------------------------------------------------

describe("applyNudge — injection", () => {
  it("appends the text after a blank line", async () => {
    const output: { output?: string } = { output: "original" };
    await applyNudge(
      makeContext(output, [
        { matches: () => true, text: () => "NUDGE", event: "injected" },
      ]),
    );
    assert.equal(output.output, "original\n\nNUDGE");
  });

  it("starts from an empty string when output is absent", async () => {
    const output: { output?: string } = {};
    await applyNudge(
      makeContext(output, [
        { matches: () => true, text: () => "NUDGE", event: "injected" },
      ]),
    );
    assert.equal(output.output, "\n\nNUDGE");
  });

  it("logs the injected event at info with the built fields", async () => {
    const output: { output?: string } = { output: "original" };
    await applyNudge(
      makeContext(output, [
        {
          matches: () => true,
          text: () => "NUDGE",
          event: "thing_injected",
          fields: () => ({ kind: "edit" }),
        },
      ]),
    );
    const entry = findLog("thing_injected");
    assert.ok(entry, "expected the injected log entry");
    assert.equal(entry.hook, "test-hook");
    assert.equal(entry.level, "info");
    assert.equal(entry.sessionId, "s1");
    assert.equal(entry.callId, "c1");
    assert.equal(entry.kind, "edit");
  });

  it("runs an async text provider and still injects", async () => {
    const output: { output?: string } = { output: "original" };
    const result = applyNudge(
      makeContext(output, [
        {
          matches: () => true,
          text: async () => {
            await Promise.resolve();
            return "ASYNC";
          },
          event: "injected",
        },
      ]),
    );
    assert.ok(result instanceof Promise, "async text returns a promise");
    await result;
    assert.equal(output.output, "original\n\nASYNC");
    assert.ok(findLog("injected"));
  });

  it("mutates synchronously (returns void) for a sync text provider", () => {
    const output: { output?: string } = { output: "original" };
    const result = applyNudge(
      makeContext(output, [
        { matches: () => true, text: () => "SYNC", event: "injected" },
      ]),
    );
    assert.equal(result, undefined);
    assert.equal(output.output, "original\n\nSYNC");
  });
});

// ---------------------------------------------------------------------------
// Tool gate
// ---------------------------------------------------------------------------

describe("applyNudge — tool gate", () => {
  it("lowercases the tool name before matching", async () => {
    const output: { output?: string } = { output: "original" };
    await applyNudge(
      makeContext(
        output,
        [
          {
            matches: (tool) => tool === "subagent",
            text: () => "NUDGE",
            event: "injected",
          },
        ],
        { tool: "SubAgent" },
      ),
    );
    assert.equal(output.output, "original\n\nNUDGE");
  });

  it("stays silent when no rule matches and no gateSkip is set", async () => {
    const output: { output?: string } = { output: "original" };
    await applyNudge(
      makeContext(output, [
        { matches: () => false, text: () => "NUDGE", event: "injected" },
      ]),
    );
    assert.equal(output.output, "original");
    assert.equal(_getBufferForTesting().length, 0);
  });

  it("logs gateSkip at debug when no rule matches", async () => {
    const output: { output?: string } = { output: "original" };
    await applyNudge(
      makeContext(
        output,
        [{ matches: () => false, text: () => "NUDGE", event: "injected" }],
        {
          tool: "bash",
          gateSkip: { event: "thing_skipped", fields: { reason: "excluded" } },
        },
      ),
    );
    assert.equal(output.output, "original");
    const entry = findLog("thing_skipped");
    assert.ok(entry, "expected the gate skip log entry");
    assert.equal(entry.level, "debug");
    assert.equal(entry.reason, "excluded");
  });

  it("picks the first matching rule", async () => {
    const output: { output?: string } = { output: "original" };
    await applyNudge(
      makeContext(output, [
        {
          matches: (tool) => tool === "edit",
          text: () => "FIRST",
          event: "first",
        },
        {
          matches: () => true,
          text: () => "SECOND",
          event: "second",
        },
      ]),
    );
    assert.equal(output.output, "original\n\nFIRST");
  });
});

// ---------------------------------------------------------------------------
// Guard chain
// ---------------------------------------------------------------------------

describe("applyNudge — guards", () => {
  it("blocks injection and logs the guard skip", async () => {
    const output: { output?: string } = { output: "original" };
    let textCalled = false;
    await applyNudge(
      makeContext(output, [
        {
          matches: () => true,
          guards: [
            () => ({ event: "thing_skipped", fields: { reason: "no_output" } }),
          ],
          text: () => {
            textCalled = true;
            return "NUDGE";
          },
          event: "injected",
        },
      ]),
    );
    assert.equal(output.output, "original");
    assert.equal(textCalled, false, "text must not run when a guard blocks");
    const entry = findLog("thing_skipped");
    assert.ok(entry);
    assert.equal(entry.level, "debug");
    assert.equal(entry.reason, "no_output");
  });

  it("blocks silently when the guard carries no event", async () => {
    const output: { output?: string } = { output: "original" };
    await applyNudge(
      makeContext(output, [
        {
          matches: () => true,
          guards: [() => ({})],
          text: () => "NUDGE",
          event: "injected",
        },
      ]),
    );
    assert.equal(output.output, "original");
    assert.equal(_getBufferForTesting().length, 0);
  });

  it("runs guards in order and stops at the first blocker", async () => {
    const output: { output?: string } = { output: "original" };
    const order: string[] = [];
    await applyNudge(
      makeContext(output, [
        {
          matches: () => true,
          guards: [
            () => {
              order.push("g1");
              return null;
            },
            () => {
              order.push("g2");
              return { event: "second_skipped" };
            },
            () => {
              order.push("g3");
              return null;
            },
          ],
          text: () => "NUDGE",
          event: "injected",
        },
      ]),
    );
    assert.deepEqual(order, ["g1", "g2"]);
    assert.ok(findLog("second_skipped"));
  });

  it("injects when every guard passes", async () => {
    const output: { output?: string } = { output: "original" };
    await applyNudge(
      makeContext(output, [
        {
          matches: () => true,
          guards: [() => null, () => null],
          text: () => "NUDGE",
          event: "injected",
        },
      ]),
    );
    assert.equal(output.output, "original\n\nNUDGE");
  });
});
