/**
 * Tests for the pi todo-history scanner (`src/adapters/pi/todo-scan.ts`).
 *
 * The scanner collects the `details` payloads of todo toolResult messages
 * from the pi session history, newest first, so a restart / fork /
 * compaction can rebuild the todo state from the latest snapshot.
 *
 * Covered here:
 * - newest-first ordering when multiple snapshots exist
 * - non-todo toolResults ignored
 * - todo toolResults without an object `details` skipped
 * - empty history yields an empty list
 * - non-message / malformed entries do not crash the scan
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { PiHistoryEntry } from "./subagent-scan.js";
import { scanTodoSnapshots } from "./todo-scan.js";

/** Build a todo toolResult message entry with the given details. */
function todoResult(details: unknown, callId = "t1"): PiHistoryEntry {
  return {
    type: "message",
    message: {
      role: "toolResult",
      toolCallId: callId,
      toolName: "todo",
      content: [],
      isError: false,
      ...(details === undefined ? {} : { details }),
    },
  };
}

/** Build another tool's toolResult message entry. */
function otherResult(toolName: string, details: unknown): PiHistoryEntry {
  return {
    type: "message",
    message: {
      role: "toolResult",
      toolCallId: "o1",
      toolName,
      content: [],
      isError: false,
      details,
    },
  };
}

describe("scanTodoSnapshots", () => {
  it("returns todo snapshot details newest first", () => {
    const entries: PiHistoryEntry[] = [
      todoResult({ v: 1 }, "tA"),
      todoResult({ v: 2 }, "tB"),
      todoResult({ v: 3 }, "tC"),
    ];
    const result = scanTodoSnapshots(entries);
    assert.equal(result.length, 3);
    assert.deepEqual(result[0], { v: 3 });
    assert.deepEqual(result[1], { v: 2 });
    assert.deepEqual(result[2], { v: 1 });
  });

  it("ignores non-todo toolResults and assistant messages", () => {
    const entries: PiHistoryEntry[] = [
      otherResult("compress", { v: 99 }),
      todoResult({ v: 1 }, "tA"),
      otherResult("bash", { v: 100 }),
      {
        type: "message",
        message: {
          role: "assistant",
          content: [
            { type: "toolCall", id: "tB", name: "todo", arguments: {} },
          ],
        },
      },
    ];
    const result = scanTodoSnapshots(entries);
    assert.equal(result.length, 1);
    assert.deepEqual(result[0], { v: 1 });
  });

  it("skips todo toolResults with missing or non-object details", () => {
    const entries: PiHistoryEntry[] = [
      todoResult({ v: 1 }, "tA"),
      todoResult(undefined, "tMissing"),
      todoResult("not-an-object", "tString"),
      todoResult(42, "tNumber"),
      todoResult(null, "tNull"),
      todoResult([{ v: 2 }], "tArray"),
    ];
    const result = scanTodoSnapshots(entries);
    assert.equal(result.length, 1);
    assert.deepEqual(result[0], { v: 1 });
  });

  it("returns an empty array for an empty history", () => {
    assert.deepEqual(scanTodoSnapshots([]), []);
  });

  it("tolerates non-message and malformed entries", () => {
    const entries: PiHistoryEntry[] = [
      { type: "session" },
      { type: "message" },
      { type: "message", message: null },
      { type: "message", message: "not-an-object" },
      { type: "message", message: { role: "toolResult" } },
      todoResult({ v: 1 }, "tA"),
    ];
    const result = scanTodoSnapshots(entries);
    assert.equal(result.length, 1);
    assert.deepEqual(result[0], { v: 1 });
  });
});
