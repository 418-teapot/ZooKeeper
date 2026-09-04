/**
 * Tests for the cold-start hydration module (`src/adapters/pi/hydrate.ts`).
 *
 * Boundary: the module's public surface — `factsFromContextMessages`
 * (pure message→fact conversion), `loadRunLog` (session file → RunLog),
 * and the toolCallId-keyed cache orchestration (`beginHydration` /
 * `hydrationState` / `waitForHydration` / `resetHydration`).  Chosen
 * because the whole restore behaviour lives here and it never touches the
 * pi TUI, so the card can be tested against ready logs separately.
 *
 * Expected fact values are independent literals mirroring the driver's
 * append rules (`src/adapters/pi/subagent.ts` `appendRunFact`), not
 * recomputations of the conversion code.
 */
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import type { RunFact } from "../../core/subagent/run-log.js";
import {
  beginHydration,
  factsFromContextMessages,
  hydrationState,
  loadRunLog,
  resetHydration,
  waitForHydration,
} from "./hydrate.js";

/** A finite-number `at` is asserted loosely (clock-dependent fallbacks). */
function hasAt(fact: RunFact): void {
  assert.equal(typeof fact.at, "number");
  assert.ok(Number.isFinite(fact.at));
}

describe("factsFromContextMessages", () => {
  it("converts an assistant text message into a message_end fact", () => {
    const facts = factsFromContextMessages([
      {
        role: "assistant",
        content: [
          { type: "text", text: "hello " },
          { type: "thinking", thinking: "hm" },
          { type: "text", text: "world" },
        ],
        usage: { input: 10, output: 4, totalTokens: 14 },
        timestamp: 1000,
      },
    ]);
    assert.equal(facts.length, 1);
    assert.deepEqual(facts[0], {
      type: "message_end",
      at: 1000,
      content: [
        { type: "text", text: "hello " },
        { type: "thinking", thinking: "hm" },
        { type: "text", text: "world" },
      ],
      usage: { input: 10, output: 4, totalTokens: 14 },
    });
  });

  it("converts assistant toolCall blocks into tool_start facts", () => {
    const facts = factsFromContextMessages([
      {
        role: "assistant",
        content: [
          { type: "text", text: "running now" },
          {
            type: "toolCall",
            id: "call-1",
            name: "bash",
            arguments: { command: "ls -la" },
          },
        ],
        timestamp: 2000,
      },
    ]);
    assert.equal(facts.length, 2);
    assert.deepEqual(facts[1], {
      type: "tool_start",
      at: 2000,
      toolCallId: "call-1",
      toolName: "bash",
      args: { command: "ls -la" },
    });
  });

  it("converts a toolResult message into a tool_end fact with text parts", () => {
    const facts = factsFromContextMessages([
      {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "bash",
        content: [
          { type: "text", text: "file listing" },
          { type: "image", data: "zz", mimeType: "image/png" },
        ],
        isError: true,
        timestamp: 3000,
      },
    ]);
    assert.equal(facts.length, 1);
    assert.deepEqual(facts[0], {
      type: "tool_end",
      at: 3000,
      toolCallId: "call-1",
      toolName: "bash",
      content: [{ type: "text", text: "file listing" }],
      isError: true,
    });
  });

  it("converts a user message into a user_message fact and drops unknown roles", () => {
    const facts = factsFromContextMessages([
      { role: "user", content: "the prompt", timestamp: 1 },
      { role: "something_else", content: "x", timestamp: 2 },
      null,
      "not a message",
    ]);
    assert.deepEqual(facts, [
      { type: "user_message", at: 1, text: "the prompt" },
    ]);
  });

  it("joins a part-array user content and drops a blank user message", () => {
    const facts = factsFromContextMessages([
      {
        role: "user",
        content: [
          { type: "text", text: "part one " },
          { type: "image", data: "zz", mimeType: "image/png" },
          { type: "text", text: "part two" },
        ],
        timestamp: 1,
      },
      // A blank user message renders as an empty box — the overlay drops it,
      // so hydration must not create the fact.
      { role: "user", content: "   ", timestamp: 2 },
    ]);
    assert.deepEqual(facts, [
      { type: "user_message", at: 1, text: "part one part two" },
    ]);
  });

  it("interleaves user_message facts at their position in the messages", () => {
    const facts = factsFromContextMessages([
      { role: "user", content: "first instruction", timestamp: 1 },
      {
        role: "assistant",
        content: [{ type: "text", text: "a" }],
        timestamp: 2,
      },
      { role: "user", content: "steered mid-run", timestamp: 3 },
      {
        role: "assistant",
        content: [{ type: "text", text: "b" }],
        timestamp: 4,
      },
    ]);
    assert.deepEqual(
      facts.map((fact) => `${fact.type}@${fact.at}`),
      ["user_message@1", "message_end@2", "user_message@3", "message_end@4"],
    );
  });

  it("emits a message_end for a tool-call-only assistant message (driver parity)", () => {
    // The live driver appends one message_end per assistant message_end
    // event regardless of content, so hydration must not drop the empty
    // turn: turn counters have to match for live and hydrated runs.
    const facts = factsFromContextMessages([
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "call-only",
            name: "read",
            arguments: { path: "a.ts" },
          },
        ],
        timestamp: 4000,
      },
    ]);
    assert.deepEqual(
      facts.map((f) => f.type),
      ["message_end", "tool_start"],
      "an assistant message with no renderable part still yields message_end",
    );
    const first = facts[0];
    assert.ok(first && first.type === "message_end");
    assert.deepEqual(first.content, []);
    assert.equal(first.usage, undefined, "no usage reported → no usage field");
    assert.ok(!("usage" in first), "an absent usage must not become a key");
  });

  it("emits one message_end per persisted assistant message", () => {
    const facts = factsFromContextMessages([
      { role: "user", content: "go", timestamp: 1 },
      // Empty assistant turn (no parts, no usage).
      { role: "assistant", content: [], timestamp: 2 },
      {
        role: "assistant",
        content: [{ type: "text", text: "a" }],
        timestamp: 3,
      },
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            name: "bash",
            arguments: { command: "ls" },
          },
        ],
        timestamp: 4,
      },
    ]);
    assert.deepEqual(
      facts.filter((f) => f.type === "message_end").map((f) => f.at),
      [2, 3, 4],
      "every assistant message contributes exactly one message_end",
    );
    // The id-less tool call still yields a tool_start (paired by name FIFO).
    assert.equal(
      facts.filter((f) => f.type === "tool_start").length,
      1,
      "tool-call blocks still project to tool_start facts",
    );
  });

  it("omits usage when the provider reported no finite numbers", () => {
    const facts = factsFromContextMessages([
      {
        role: "assistant",
        content: [{ type: "text", text: "a" }],
        usage: { input: Number.NaN },
        timestamp: 10,
      },
    ]);
    assert.equal(facts.length, 1);
    assert.equal(
      (facts[0] as { usage?: unknown }).usage,
      undefined,
      "NaN usage must not produce a usage field",
    );
  });
});

/** One `message` line of a pi session jsonl. */
function line(message: unknown): string {
  return JSON.stringify({
    type: "message",
    id: `m${Math.random().toString(36).slice(2)}`,
    parentId: null,
    timestamp: "2026-08-31T00:00:00.000Z",
    message,
  });
}

/** Write a minimal pi session jsonl (header + given message records). */
async function writeSession(messages: unknown[]): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "zoo-hydrate-"));
  const path = join(dir, "session.jsonl");
  const header = JSON.stringify({
    type: "session",
    version: 3,
    id: "ses-hydrate",
    timestamp: "2026-08-31T00:00:00.000Z",
    cwd: "/tmp",
  });
  await writeFile(path, [header, ...messages.map(line)].join("\n"), "utf-8");
  return path;
}

describe("loadRunLog", () => {
  it("parses a session file into a run log of driver-shaped facts", async () => {
    const path = await writeSession([
      { role: "user", content: "do the work" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "listing" },
          {
            type: "toolCall",
            id: "tc-1",
            name: "bash",
            arguments: { command: "ls" },
          },
        ],
        usage: { input: 5, output: 2, totalTokens: 7 },
        timestamp: 100,
      },
      {
        role: "toolResult",
        toolCallId: "tc-1",
        toolName: "bash",
        content: [{ type: "text", text: "a.txt" }],
        isError: false,
        timestamp: 200,
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "done: a.txt exists" }],
        usage: { input: 3, output: 1, totalTokens: 4 },
        timestamp: 300,
      },
    ]);
    const log = await loadRunLog(path);
    assert.ok(log, "the fixture must load");
    const kinds = log.facts().map((f) => f.type);
    // The user message contributes its instruction fact; each assistant
    // message contributes its message fact plus one tool_start per toolCall
    // block, interleaved in message order.
    assert.deepEqual(kinds, [
      "user_message",
      "message_end",
      "tool_start",
      "tool_end",
      "message_end",
    ]);
    const first = log.facts()[0];
    assert.ok(first && first.type === "user_message");
    assert.equal(first.text, "do the work");
    const last = log.facts()[4];
    assert.equal(last.type, "message_end");
    if (last.type === "message_end") {
      assert.deepEqual(last.content, [
        { type: "text", text: "done: a.txt exists" },
      ]);
    }
  });

  it("returns undefined for a missing file", async () => {
    const log = await loadRunLog("/nonexistent/zoo-hydrate/none.jsonl");
    assert.equal(log, undefined);
  });
});

describe("hydration cache orchestration", () => {
  afterEach(() => {
    resetHydration();
  });

  it("transitions missing → pending → ready and caches by toolCallId", async () => {
    const path = await writeSession([
      {
        role: "assistant",
        content: [{ type: "text", text: "final answer" }],
        timestamp: 1,
      },
    ]);
    assert.equal(hydrationState("call-A").kind, "missing");
    let settled = 0;
    beginHydration("call-A", path, () => {
      settled += 1;
    });
    assert.equal(hydrationState("call-A").kind, "pending");
    await waitForHydration("call-A");
    assert.equal(settled, 1, "the settle callback must fire once");
    const state = hydrationState("call-A");
    assert.equal(state.kind, "ready");
    if (state.kind === "ready") {
      const facts = state.log.facts();
      assert.equal(facts.length, 1);
      assert.ok(facts[0]);
      hasAt(facts[0]);
    }
  });

  it("deduplicates concurrent begins for the same toolCallId", async () => {
    const path = await writeSession([
      { role: "assistant", content: [{ type: "text", text: "x" }] },
    ]);
    let loads = 0;
    const countingLoad = async (p: string) => {
      loads += 1;
      return loadRunLog(p);
    };
    beginHydration("call-B", path, undefined, countingLoad);
    beginHydration("call-B", path, undefined, countingLoad);
    await waitForHydration("call-B");
    assert.equal(loads, 1, "a pending hydration must not start a second load");
  });

  it("records a failed load as failed (never retried, never ready)", async () => {
    beginHydration("call-C", "/nonexistent/zoo-hydrate/none.jsonl");
    await waitForHydration("call-C");
    assert.equal(hydrationState("call-C").kind, "failed");
    // A later begin for a failed id must not restart the load.
    beginHydration("call-C", "/nonexistent/zoo-hydrate/none.jsonl");
    assert.equal(hydrationState("call-C").kind, "failed");
  });

  it("waitForHydration resolves immediately for an unknown id", async () => {
    await waitForHydration("call-never");
    assert.equal(hydrationState("call-never").kind, "missing");
  });

  it("evicts settled hydrations when the cache exceeds its 8-entry capacity", async () => {
    // The settled cache is bounded (FIFO): filling it past 8 evicts the
    // oldest entry so resident memory cannot grow with finished-run views.
    const paths: string[] = [];
    for (let i = 0; i < 9; i++) {
      const path = await writeSession([
        {
          role: "assistant",
          content: [{ type: "text", text: `m${i}` }],
          timestamp: i,
        },
      ]);
      paths.push(path);
    }
    for (let i = 0; i < 9; i++) {
      beginHydration(`call-${i}`, paths[i]);
      await waitForHydration(`call-${i}`);
    }
    assert.equal(
      hydrationState("call-0").kind,
      "missing",
      "the oldest settled entry must be evicted at capacity 8",
    );
    for (let i = 1; i < 9; i++) {
      assert.equal(
        hydrationState(`call-${i}`).kind,
        "ready",
        `entry ${i} must remain in the cache`,
      );
    }
    // An evicted id hydrates again on demand (a later begin is not blocked),
    // and the re-settle evicts the then-oldest entry in turn.
    beginHydration("call-0", paths[0]);
    await waitForHydration("call-0");
    assert.equal(hydrationState("call-0").kind, "ready");
    assert.equal(
      hydrationState("call-1").kind,
      "missing",
      "the re-added entry must evict the new oldest",
    );
  });
});
