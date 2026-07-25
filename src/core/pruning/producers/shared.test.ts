/**
 * Tests for the shared pruning producer utilities.
 *
 * Covers: `collectProtectedCallIDs` (step-start & fallback paths) and
 * `netReclaimTokens` (positive, zero, null bounds).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ContextMessageEntry } from "../../metrics.js";
import type { SweepToolPart } from "../types.js";
import { PRUNED_TOOL_OUTPUT_REPLACEMENT } from "../types.js";
import { collectProtectedCallIDs, netReclaimTokens } from "./shared.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toolPart(callID: string): SweepToolPart {
  return { type: "tool", callID, tool: "bash" };
}

function stepStartPart(): { type: string } {
  return { type: "step-start" };
}

function msg(
  parts: Array<SweepToolPart | { type: string }>,
): ContextMessageEntry {
  return {
    info: { role: "assistant", id: "id" },
    parts: parts as ContextMessageEntry["parts"],
  };
}

// ===========================================================================
// collectProtectedCallIDs
// ===========================================================================

describe("collectProtectedCallIDs", () => {
  it("returns empty set when turnProtection <= 0", () => {
    const messages = [msg([toolPart("call-1"), toolPart("call-2")])];
    assert.equal(collectProtectedCallIDs(messages, 0).size, 0);
    assert.equal(collectProtectedCallIDs(messages, -1).size, 0);
  });

  it("protects last N steps when step-start exists and exceeds window", () => {
    // 4 steps, turnProtection=2 → protect last 2 steps (indices 2, 3)
    const messages = [
      msg([stepStartPart(), toolPart("call-A")]),
      msg([stepStartPart(), toolPart("call-B")]),
      msg([stepStartPart(), toolPart("call-C")]),
      msg([stepStartPart(), toolPart("call-D")]),
    ];
    const ids = collectProtectedCallIDs(messages, 2);
    assert.equal(ids.size, 2);
    assert.ok(ids.has("call-C"));
    assert.ok(ids.has("call-D"));
  });

  it("protects all steps when fewer steps than protection window", () => {
    const messages = [
      msg([stepStartPart(), toolPart("call-A")]),
      msg([stepStartPart(), toolPart("call-B")]),
    ];
    const ids = collectProtectedCallIDs(messages, 5);
    assert.equal(ids.size, 2);
    assert.ok(ids.has("call-A"));
    assert.ok(ids.has("call-B"));
  });

  it("protects tool calls in messages after the last step-start", () => {
    const messages = [
      msg([stepStartPart(), toolPart("call-A")]),
      msg([toolPart("call-B")]),
      msg([stepStartPart(), toolPart("call-C")]),
      msg([toolPart("call-D")]),
    ];
    // 2 step-start steps, turnProtection=1 → protect step starting at
    // the last step-start (index 2) and all after it.
    const ids = collectProtectedCallIDs(messages, 1);
    assert.equal(ids.size, 2);
    assert.ok(ids.has("call-C"));
    assert.ok(ids.has("call-D"));
  });

  it("falls back to protecting last N tool calls when no step-start", () => {
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

  it("protects fewer tool calls than turnProtection fallback when not enough", () => {
    const messages = [msg([toolPart("call-A")]), msg([toolPart("call-B")])];
    const ids = collectProtectedCallIDs(messages, 5);
    assert.equal(ids.size, 2);
    assert.ok(ids.has("call-A"));
    assert.ok(ids.has("call-B"));
  });

  it("skips non-tool parts in fallback path", () => {
    const messages = [msg([toolPart("call-A"), toolPart("call-B")])];
    const ids = collectProtectedCallIDs(messages, 1);
    assert.equal(ids.size, 1);
    // Iteration is reverse, so call-B (last) should be collected first.
    assert.ok(ids.has("call-B"));
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
