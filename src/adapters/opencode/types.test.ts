/**
 * Tests for the pure v1 message helpers in `src/adapters/opencode/types.ts`.
 *
 * Covers the two helpers that survive the lens-pipeline migration:
 * `getCallId` (tool call identifier extraction) and `isMessageIgnored`
 * (ignored-message detection).  The v1 measurement functions and their
 * tests were removed when the sidebar switched to the core lens
 * pipeline.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  type ContextMessageEntry,
  getCallId,
  isMessageIgnored,
} from "./types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal message entry with a role and optional parts.
 */
function entry(role: string, parts?: unknown[]): ContextMessageEntry {
  return {
    info: { role, id: "m1" },
    parts: (parts ?? []) as unknown as ContextMessageEntry["parts"],
  };
}

// ---------------------------------------------------------------------------
// getCallId
// ---------------------------------------------------------------------------

describe("getCallId", () => {
  it("reads the callID field", () => {
    assert.equal(getCallId({ callID: "call-1" }), "call-1");
  });

  it("falls back to the callId field", () => {
    assert.equal(getCallId({ callId: "call-2" }), "call-2");
  });

  it("prefers callID over callId", () => {
    assert.equal(getCallId({ callID: "a", callId: "b" }), "a");
  });

  it("returns undefined when neither field is present", () => {
    assert.equal(getCallId({ type: "text", text: "hi" }), undefined);
  });
});

// ---------------------------------------------------------------------------
// isMessageIgnored
// ---------------------------------------------------------------------------

describe("isMessageIgnored", () => {
  it("returns true when info.ignored is truthy", () => {
    const msg = entry("user") as ContextMessageEntry & {
      info: { ignored?: boolean };
    };
    msg.info.ignored = true;
    assert.equal(isMessageIgnored(msg), true);
  });

  it("returns true when every part is ignored", () => {
    const msg = entry("user", [
      { type: "text", text: "a", ignored: true },
      { type: "text", text: "b", ignored: true },
    ]);
    assert.equal(isMessageIgnored(msg), true);
  });

  it("returns false when only some parts are ignored", () => {
    const msg = entry("user", [
      { type: "text", text: "a", ignored: true },
      { type: "text", text: "b" },
    ]);
    assert.equal(isMessageIgnored(msg), false);
  });

  it("returns false for empty parts", () => {
    assert.equal(isMessageIgnored(entry("user", [])), false);
    assert.equal(isMessageIgnored(entry("user")), false);
  });

  it("returns false for a nullish message", () => {
    assert.equal(
      isMessageIgnored(null as unknown as ContextMessageEntry),
      false,
    );
  });
});
