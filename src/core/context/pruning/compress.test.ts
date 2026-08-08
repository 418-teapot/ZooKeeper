/**
 * Tests for the retained compression boundary and token-estimation helpers.
 *
 * The mechanical planning pipeline (planner / mechanical summary /
 * mechanical title derivation) was retired with the `/dcp compress`
 * command's move to a model-driven path — these tests cover the boundary
 * materials that remain in use by the range-mode compress pipeline, the
 * nudge subsystem, and the fold view.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ContextMessageEntry } from "../metrics.js";
import {
  BLOCK_HEADER_TEMPLATE,
  estimateSegmentTokens,
  segmentInOutTokens,
  tokenBoundary,
} from "./compress.js";
import { firstUserMessageIndex, lastUserMessageIndex } from "./shared.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeUserMsg(
  id: string,
  text: string,
  ignored = false,
): ContextMessageEntry {
  return {
    info: {
      role: "user",
      id,
      ...(ignored ? { ignored: true } : {}),
    } as unknown as ContextMessageEntry["info"],
    parts: [{ type: "text", text }] as unknown as ContextMessageEntry["parts"],
  };
}

function makeAssistantMsg(id: string, text: string): ContextMessageEntry {
  return {
    info: { role: "assistant", id } as unknown as ContextMessageEntry["info"],
    parts: [{ type: "text", text }] as unknown as ContextMessageEntry["parts"],
  };
}

function makeToolMsg(
  role: string,
  id: string,
  tool: string,
  callID: string,
  input: unknown,
  output: string,
): ContextMessageEntry {
  return {
    info: { role, id } as unknown as ContextMessageEntry["info"],
    parts: [
      { type: "tool", callID, tool, state: { input, output } },
    ] as unknown as ContextMessageEntry["parts"],
  };
}

// ---------------------------------------------------------------------------
// tokenBoundary
// ---------------------------------------------------------------------------

describe("tokenBoundary", () => {
  it("returns messages.length when protectedTokens <= 0", () => {
    const messages = [makeUserMsg("u1", "hello")];
    assert.equal(tokenBoundary(messages, 0), messages.length);
    assert.equal(tokenBoundary(messages, -5), messages.length);
  });

  it("returns messages.length for an empty array", () => {
    assert.equal(tokenBoundary([], 100), 0);
  });

  it("accumulates heuristic tokens from the end until the budget is met", () => {
    // Each text message estimates to roughly text.length / 4 tokens.
    // 4 messages of "x".repeat(40) → ~10 tokens each.  A budget of 16
    // accumulates 10 (idx 3) + 10 (idx 2) = 20 >= 16 → boundary 2.
    const messages: ContextMessageEntry[] = [
      makeUserMsg("u0", "x".repeat(40)),
      makeAssistantMsg("a1", "x".repeat(40)),
      makeUserMsg("u2", "x".repeat(40)),
      makeAssistantMsg("a3", "x".repeat(40)),
    ];
    const boundary = tokenBoundary(messages, 16);
    assert.ok(
      boundary >= 1 && boundary <= 2,
      `unexpected boundary ${boundary}`,
    );
  });

  it("skips ignored messages when accumulating", () => {
    // Two ignored messages (injected reports) sit at the tail — they
    // contribute nothing, so the boundary lands on the real messages
    // as if the ignored ones were absent.  With ~10 tokens per real
    // message and a budget of 16, the boundary is 2 (two real messages
    // accumulated from the end).
    const messages: ContextMessageEntry[] = [
      makeUserMsg("u0", "x".repeat(40)),
      makeAssistantMsg("a1", "x".repeat(40)),
      makeUserMsg("u2", "x".repeat(40)),
      makeAssistantMsg("a3", "x".repeat(40)),
      makeUserMsg("ignored-1", "x".repeat(100), true),
      makeUserMsg("ignored-2", "x".repeat(100), true),
    ];
    const boundary = tokenBoundary(messages, 16);
    assert.equal(boundary, 2);
  });

  it("returns 0 when the budget exceeds the whole session", () => {
    const messages = [makeUserMsg("u0", "hi"), makeAssistantMsg("a1", "yo")];
    assert.equal(tokenBoundary(messages, 1_000_000), 0);
  });
});

// ---------------------------------------------------------------------------
// segmentInOutTokens
// ---------------------------------------------------------------------------

describe("segmentInOutTokens", () => {
  it("counts user text as input and assistant text as output", () => {
    const messages: ContextMessageEntry[] = [
      makeUserMsg("u0", "request body"),
      makeAssistantMsg("a1", "response body"),
    ];
    const { inTokens, outTokens } = segmentInOutTokens(messages, {
      startIndex: 0,
      endIndex: 2,
    });
    assert.ok(inTokens > 0, "user text counts as input");
    assert.ok(outTokens > 0, "assistant text counts as output");
  });

  it("counts tool part input as input and output as output", () => {
    const messages: ContextMessageEntry[] = [
      makeToolMsg(
        "assistant",
        "a1",
        "bash",
        "c1",
        { cmd: "ls" },
        "x".repeat(400),
      ),
    ];
    const { inTokens, outTokens } = segmentInOutTokens(messages, {
      startIndex: 0,
      endIndex: 1,
    });
    assert.ok(inTokens > 0, "tool input counts as input");
    assert.ok(outTokens > 0, "tool output counts as output");
  });

  it("returns zeros for an empty segment", () => {
    assert.deepEqual(
      segmentInOutTokens([makeUserMsg("u0", "hi")], {
        startIndex: 0,
        endIndex: 0,
      }),
      { inTokens: 0, outTokens: 0 },
    );
  });
});

// ---------------------------------------------------------------------------
// estimateSegmentTokens
// ---------------------------------------------------------------------------

describe("estimateSegmentTokens", () => {
  it("sums per-message heuristic estimates over the segment", () => {
    const messages: ContextMessageEntry[] = [
      makeUserMsg("u0", "x".repeat(40)),
      makeAssistantMsg("a1", "x".repeat(40)),
      makeUserMsg("u2", "x".repeat(40)),
    ];
    const total = estimateSegmentTokens(messages, {
      startIndex: 0,
      endIndex: 3,
    });
    assert.ok(total > 0, "segment estimate should be positive");
    // A single message within the same segment cannot exceed the total.
    const single = estimateSegmentTokens(messages, {
      startIndex: 0,
      endIndex: 1,
    });
    assert.ok(single < total, "partial segment estimate below the whole");
  });

  it("returns 0 for an empty segment", () => {
    assert.equal(
      estimateSegmentTokens([makeUserMsg("u0", "hi")], {
        startIndex: 0,
        endIndex: 0,
      }),
      0,
    );
  });
});

// ---------------------------------------------------------------------------
// BLOCK_HEADER_TEMPLATE
// ---------------------------------------------------------------------------

describe("BLOCK_HEADER_TEMPLATE", () => {
  it("keeps the fixed placeholder shape", () => {
    assert.equal(BLOCK_HEADER_TEMPLATE, "[Compression Block b<N>]");
  });
});

// ---------------------------------------------------------------------------
// firstUserMessageIndex / lastUserMessageIndex
// ---------------------------------------------------------------------------

describe("firstUserMessageIndex", () => {
  it("finds the first non-ignored user message", () => {
    const messages: ContextMessageEntry[] = [
      makeUserMsg("u0", "first"),
      makeAssistantMsg("a1", "reply"),
      makeUserMsg("u2", "again"),
    ];
    assert.equal(firstUserMessageIndex(messages), 0);
  });

  it("skips ignored user messages before the real first user", () => {
    const messages: ContextMessageEntry[] = [
      makeUserMsg("ignored-report", "/dcp context report...", true),
      makeUserMsg("u1", "Real first request"),
      makeAssistantMsg("a2", "reply"),
    ];
    assert.equal(firstUserMessageIndex(messages), 1);
  });

  it("returns -1 when no non-ignored user message exists", () => {
    assert.equal(firstUserMessageIndex([]), -1);
    assert.equal(
      firstUserMessageIndex([makeAssistantMsg("a1", "only assistant")]),
      -1,
    );
  });
});

describe("lastUserMessageIndex", () => {
  it("finds the last non-ignored user message", () => {
    const messages: ContextMessageEntry[] = [
      makeUserMsg("u0", "first"),
      makeAssistantMsg("a1", "reply"),
      makeUserMsg("u2", "again"),
      makeAssistantMsg("a3", "final"),
    ];
    assert.equal(lastUserMessageIndex(messages), 2);
  });

  it("skips ignored user messages at the tail", () => {
    const messages: ContextMessageEntry[] = [
      makeUserMsg("u0", "first"),
      makeUserMsg("ignored-report", "/dcp context report...", true),
    ];
    assert.equal(lastUserMessageIndex(messages), 0);
  });

  it("returns messages.length when no non-ignored user message exists", () => {
    const messages: ContextMessageEntry[] = [makeAssistantMsg("a1", "x")];
    assert.equal(lastUserMessageIndex(messages), messages.length);
  });
});
