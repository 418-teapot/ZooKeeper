/**
 * Tests for the protection map (`src/core/context/protection-map.ts`).
 *
 * The map is the host-agnostic protection model of one round: an active
 * tail `[activeStart, length)` plus every non-hidden user instruction.
 * Boundary: the public builders and queries only — the tests observe the
 * map's protection decisions, never its internal construction.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  makeAssistantMsg,
  makeMsg,
  makeTranscript,
} from "../../testkits/context.js";
import type { HostMessage } from "./lens.js";
import {
  buildProtectionMap,
  freezeProtectionMap,
  isProtectedOrdinal,
  isProtectedRange,
} from "./protection-map.js";

/** Four messages whose heuristic estimates are 1..4 tokens. */
function smallHistory(): HostMessage[] {
  return [
    makeMsg("user", ["aaaa"]),
    makeAssistantMsg({ text: "bbbbbbbb" }),
    makeMsg("user", ["cccccccccccc"]),
    makeAssistantMsg({ text: "dddddddddddddddd" }),
  ];
}

// ---------------------------------------------------------------------------
// Active tail
// ---------------------------------------------------------------------------

describe("buildProtectionMap — active tail", () => {
  it("counts back the requested number of non-hidden messages", () => {
    const map = buildProtectionMap(makeTranscript(6), 2, 0);
    assert.equal(map.activeStart, 4, "[4, 6) is the active tail");
  });

  it("accumulates the token budget from the end", () => {
    const map = buildProtectionMap(smallHistory(), 0, 5);
    // 4 + 3 = 7 crosses the budget: the window starts at ordinal 2.
    assert.equal(map.activeStart, 2);
  });

  it("skips hidden messages in the count window", () => {
    const history: HostMessage[] = [
      makeMsg("user", ["aaaa"]),
      makeAssistantMsg({ text: "bbbbbbbb" }),
      makeMsg("user", ["cccccccccccc"]),
      makeAssistantMsg({ text: "dddddddddddddddd" }),
      makeMsg("user", ["injected report"], { hidden: true }),
      makeMsg("user", ["injected report"], { hidden: true }),
    ];
    assert.equal(buildProtectionMap(history, 2, 0).activeStart, 2);
  });

  it("skips hidden messages and their tokens in the token window", () => {
    const history: HostMessage[] = [
      makeMsg("user", ["aaaa"]),
      makeAssistantMsg({ text: "bbbbbbbb" }),
      makeMsg("user", ["cccccccccccc"]),
      makeAssistantMsg({ text: "dddddddddddddddd" }),
      makeMsg("user", ["x".repeat(100)], { hidden: true }),
      makeMsg("user", ["x".repeat(100)], { hidden: true }),
    ];
    assert.equal(buildProtectionMap(history, 0, 5).activeStart, 2);
  });

  it("unions both windows at the earlier boundary", () => {
    // Count window starts at 3, token window at 2.
    assert.equal(buildProtectionMap(smallHistory(), 1, 5).activeStart, 2);
  });

  it("returns the transcript length when both windows are disabled", () => {
    const map = buildProtectionMap(smallHistory(), 0, 0);
    assert.equal(map.activeStart, 4);
    assert.equal(map.messageCount, 4, "the map carries the round's length");
  });

  it("returns zero when the budget covers the whole session", () => {
    const map = buildProtectionMap(smallHistory(), 10, 1_000_000);
    assert.equal(map.activeStart, 0);
  });

  it("returns zero for an empty transcript", () => {
    assert.equal(buildProtectionMap([], 0, 10).activeStart, 0);
  });
});

// ---------------------------------------------------------------------------
// Instructions
// ---------------------------------------------------------------------------

describe("buildProtectionMap — instructions", () => {
  it("collects every non-hidden user ordinal in order", () => {
    const history: HostMessage[] = [
      makeMsg("user", ["first"]),
      makeAssistantMsg({ text: "reply" }),
      makeMsg("user", ["injected"], { hidden: true }),
      makeMsg("user", ["second"]),
      makeMsg("assistant", ["reply"]),
    ];
    assert.deepEqual(buildProtectionMap(history, 0, 0).instructions, [0, 3]);
  });

  it("holds no instruction for an assistant-only transcript", () => {
    const history = [
      makeAssistantMsg({ text: "one" }),
      makeAssistantMsg({ text: "two" }),
    ];
    assert.deepEqual(buildProtectionMap(history, 0, 0).instructions, []);
  });

  it("holds no instruction for an empty transcript", () => {
    assert.deepEqual(buildProtectionMap([], 0, 0).instructions, []);
  });
});

// ---------------------------------------------------------------------------
// Single-ordinal query
// ---------------------------------------------------------------------------

describe("isProtectedOrdinal", () => {
  const history: HostMessage[] = [
    makeMsg("user", ["instruction"]),
    makeAssistantMsg({ text: "work" }),
    makeMsg("user", ["hidden instruction"], { hidden: true }),
    makeAssistantMsg({ text: "work" }),
  ];
  const map = buildProtectionMap(history, 1, 0);

  it("protects every valid ordinal of the active tail", () => {
    assert.equal(isProtectedOrdinal(map, 3), true);
  });

  it("never reports an ordinal outside the transcript as protected", () => {
    assert.equal(isProtectedOrdinal(map, 4), false, "one past the end");
    assert.equal(isProtectedOrdinal(map, 99), false, "far past the end");
    assert.equal(isProtectedOrdinal(map, -1), false, "negative ordinal");
  });

  it("protects an instruction outside the active tail", () => {
    assert.equal(isProtectedOrdinal(map, 0), true);
  });

  it("leaves work and hidden messages outside the active tail free", () => {
    assert.equal(isProtectedOrdinal(map, 1), false, "work before the tail");
    assert.equal(isProtectedOrdinal(map, 2), false, "hidden message");
  });
});

// ---------------------------------------------------------------------------
// Range query
// ---------------------------------------------------------------------------

describe("isProtectedRange", () => {
  const history: HostMessage[] = [
    makeMsg("user", ["instruction"]),
    makeAssistantMsg({ text: "work one" }),
    makeAssistantMsg({ text: "work two" }),
    makeMsg("user", ["hidden instruction"], { hidden: true }),
    makeAssistantMsg({ text: "work three" }),
  ];
  const map = buildProtectionMap(history, 1, 0);

  it("rejects a range whose end crosses into the active tail", () => {
    // The active tail starts at ordinal 4; ending at 5 crosses it.
    assert.equal(isProtectedRange(map, 2, 5), true);
  });

  it("accepts a range ending exactly at the active start", () => {
    assert.equal(isProtectedRange(map, 1, 4), false);
  });

  it("rejects a range containing an instruction", () => {
    assert.equal(isProtectedRange(map, 0, 2), true);
    assert.equal(isProtectedRange(map, 0, 1), true);
  });

  it("ignores a hidden user message inside the range", () => {
    assert.equal(isProtectedRange(map, 1, 4), false);
  });

  it("rejects a range that is entirely inside the active tail", () => {
    assert.equal(isProtectedRange(map, 4, 5), true);
  });
});

// ---------------------------------------------------------------------------
// Immutability
// ---------------------------------------------------------------------------

describe("freezeProtectionMap", () => {
  it("copies the instruction list and freezes both objects", () => {
    const source = {
      activeStart: 2,
      messageCount: 4,
      instructions: [0, 1],
    };
    const frozen = freezeProtectionMap(source);
    source.instructions[1] = 9;
    source.activeStart = 9;
    source.messageCount = 9;

    assert.equal(frozen.activeStart, 2);
    assert.equal(frozen.messageCount, 4);
    assert.deepEqual(frozen.instructions, [0, 1]);
    assert.ok(Object.isFrozen(frozen));
    assert.ok(Object.isFrozen(frozen.instructions));
  });

  it("builds a frozen map", () => {
    const map = buildProtectionMap(makeTranscript(4), 0, 0);
    assert.ok(Object.isFrozen(map));
    assert.ok(Object.isFrozen(map.instructions));
  });
});
