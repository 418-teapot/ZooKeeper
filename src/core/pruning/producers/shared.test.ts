/**
 * Tests for the shared pruning producer utilities.
 *
 * Covers: `protectedBoundary` (zero/high-water/ignored-message cases),
 * `collectProtectedCallIDs` (message-count window), and
 * `netReclaimTokens` (positive, zero, null bounds).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ContextMessageEntry } from "../../metrics.js";
import type { SweepToolPart } from "../types.js";
import { PRUNED_TOOL_OUTPUT_REPLACEMENT } from "../types.js";
import {
  collectProtectedCallIDs,
  netReclaimTokens,
  protectedBoundary,
} from "./shared.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toolPart(callID: string): SweepToolPart {
  return { type: "tool", callID, tool: "bash" };
}

function msg(
  parts: Array<SweepToolPart | { type: string }>,
  ignored = false,
): ContextMessageEntry {
  const info: Record<string, unknown> = { role: "assistant", id: "id" };
  if (ignored) info.ignored = true;
  return {
    info: info as unknown as ContextMessageEntry["info"],
    parts: parts as ContextMessageEntry["parts"],
  };
}

// ===========================================================================
// protectedBoundary
// ===========================================================================

describe("protectedBoundary", () => {
  it("returns messages.length when n <= 0", () => {
    const messages = [msg([toolPart("call-1")]), msg([toolPart("call-2")])];
    assert.equal(protectedBoundary(messages, 0), 2);
    assert.equal(protectedBoundary(messages, -1), 2);
  });

  it("returns 0 when n exceeds available non-ignored messages", () => {
    const messages = [msg([toolPart("call-1")]), msg([toolPart("call-2")])];
    assert.equal(protectedBoundary(messages, 5), 0);
  });

  it("returns exact boundary when n matches message count", () => {
    const messages = [
      msg([toolPart("call-A")]),
      msg([toolPart("call-B")]),
      msg([toolPart("call-C")]),
    ];
    // count back 2 non-ignored → start at index 1 (call-B)
    assert.equal(protectedBoundary(messages, 2), 1);
    // count back 3 → start at index 0
    assert.equal(protectedBoundary(messages, 3), 0);
  });

  it("skips ignored messages when counting the boundary", () => {
    // 5 messages: idx 0 normal, idx 1 ignored, idx 2 normal, idx 3 ignored,
    // idx 4 normal.  Counting back 2 non-ignored from the end:
    //   idx 4 (normal)  → count 1
    //   idx 3 (ignored)  → skip
    //   idx 2 (normal)  → count 2 → boundary = 2
    const messages = [
      msg([toolPart("call-A")], false),
      msg([toolPart("call-B")], true),
      msg([toolPart("call-C")], false),
      msg([toolPart("call-D")], true),
      msg([toolPart("call-E")], false),
    ];
    assert.equal(protectedBoundary(messages, 2), 2);
  });

  it("handles empty messages array", () => {
    assert.equal(protectedBoundary([], 5), 0);
    assert.equal(protectedBoundary([], 0), 0);
  });
});

// ===========================================================================
// collectProtectedCallIDs
// ===========================================================================

describe("collectProtectedCallIDs", () => {
  it("returns empty set when turnProtection <= 0", () => {
    const messages = [msg([toolPart("call-1"), toolPart("call-2")])];
    assert.equal(collectProtectedCallIDs(messages, 0).size, 0);
    assert.equal(collectProtectedCallIDs(messages, -1).size, 0);
  });

  it("protects tool calls in the last N messages", () => {
    // 4 messages, protect=2 → last 2 messages (call-C, call-D) are protected.
    const messages = [
      msg([toolPart("call-A")]),
      msg([toolPart("call-B")]),
      msg([toolPart("call-C")]),
      msg([toolPart("call-D")]),
    ];
    const ids = collectProtectedCallIDs(messages, 2);
    assert.equal(ids.size, 2);
    assert.ok(ids.has("call-C"));
    assert.ok(ids.has("call-D"));
  });

  it("protects all messages when N >= message count", () => {
    const messages = [msg([toolPart("call-A")]), msg([toolPart("call-B")])];
    const ids = collectProtectedCallIDs(messages, 5);
    assert.equal(ids.size, 2);
    assert.ok(ids.has("call-A"));
    assert.ok(ids.has("call-B"));
  });

  it("collects tool calls across multiple parts in one message", () => {
    const messages = [
      msg([toolPart("call-A"), toolPart("call-B")]),
      msg([toolPart("call-C")]),
    ];
    const ids = collectProtectedCallIDs(messages, 1);
    assert.equal(ids.size, 1);
    assert.ok(ids.has("call-C"));
  });
});

// ===========================================================================
// netReclaimTokens
// ===========================================================================

describe("netReclaimTokens", () => {
  const shortText = "hi";
  const longText = "x".repeat(1000);

  it("returns positive when content is much longer than placeholder", () => {
    const result = netReclaimTokens(longText, PRUNED_TOOL_OUTPUT_REPLACEMENT);
    // Long text (1000 chars) should definitely exceed the placeholder.
    assert.ok(result > 0);
  });

  it("returns 0 when content is shorter than placeholder", () => {
    const result = netReclaimTokens(shortText, PRUNED_TOOL_OUTPUT_REPLACEMENT);
    assert.equal(result, 0);
  });

  it("returns 0 when content token count equals placeholder token count", () => {
    const sameLen = PRUNED_TOOL_OUTPUT_REPLACEMENT;
    const result = netReclaimTokens(sameLen, PRUNED_TOOL_OUTPUT_REPLACEMENT);
    // Same string → diff is 0 → clamped to 0.
    assert.equal(result, 0);
  });

  it("returns 0 for null content", () => {
    const result = netReclaimTokens(null, PRUNED_TOOL_OUTPUT_REPLACEMENT);
    assert.equal(result, 0);
  });

  it("returns 0 for undefined content", () => {
    const result = netReclaimTokens(undefined, PRUNED_TOOL_OUTPUT_REPLACEMENT);
    assert.equal(result, 0);
  });

  it("works with non-string content (object)", () => {
    // Object with long string content → should have tokens > placeholder.
    const obj = {
      data: "very long output ".repeat(200),
    };
    const result = netReclaimTokens(obj, PRUNED_TOOL_OUTPUT_REPLACEMENT);
    assert.ok(result > 0);
  });

  it("lower bound is exactly 0, never negative", () => {
    const result = netReclaimTokens("", PRUNED_TOOL_OUTPUT_REPLACEMENT);
    assert.equal(result, 0);
  });
});
