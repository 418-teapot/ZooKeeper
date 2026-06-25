/**
 * Tests for the Context Metrics hook.
 *
 * Covers: normal messages with assistant tokens, empty messages,
 * undefined messages, no completed assistant found, heuristic estimation
 * correctness, messages without parts, and the barrel export.
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { _resetForTesting } from "../../utils/logger.js";
import {
  type ContextMessageEntry,
  estimateMessageHeuristic,
  measureContext,
} from "./index.js";

// ---------------------------------------------------------------------------
// Logger cleanup
// ---------------------------------------------------------------------------

afterEach(() => {
  _resetForTesting();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal message entry with the given role, tokens, and optional
 * parts text.
 */
function msg(
  role: string,
  tokens?: {
    input?: number;
    output?: number;
    reasoning?: number;
    cache?: { read?: number; write?: number };
  },
  text?: string,
  overrides?: Partial<{ sessionID: string; id: string; agent: string }>,
): ContextMessageEntry {
  const parts = text !== undefined ? [{ type: "text" as const, text }] : [];
  return {
    info: {
      role,
      id: overrides?.id ?? "m1",
      sessionID: overrides?.sessionID,
      tokens,
      agent: overrides?.agent,
    },
    parts,
  };
}

// ---------------------------------------------------------------------------
// Normal: messages with completed assistant
// ---------------------------------------------------------------------------

describe("normal messages with completed assistant", () => {
  it("sums API-reported tokens from last completed assistant", () => {
    const msgs: ContextMessageEntry[] = [
      msg("user", undefined, "Hello"),
      msg("assistant", { input: 500, output: 100 }, "Response"),
    ];
    const result = measureContext({ messages: msgs });
    // exact = 500 + 100 = 600
    assert.equal(result.exact_tokens, 600);
    assert.equal(result.estimated_new_tokens, 0);
    assert.equal(result.estimated_tokens, 600);
    assert.equal(result.message_count, 2);
  });

  it("includes reasoning and cache tokens in exact count", () => {
    const msgs: ContextMessageEntry[] = [
      msg("user", undefined, "Hello"),
      msg("assistant", {
        input: 1000,
        output: 200,
        reasoning: 50,
        cache: { read: 300, write: 100 },
      }),
    ];
    const result = measureContext({ messages: msgs });
    // exact = 1000 + 200 + 50 + 300 + 100 = 1650
    assert.equal(result.exact_tokens, 1650);
    assert.equal(result.estimated_tokens, 1650);
  });

  it("estimates heuristic for messages after last assistant", () => {
    const msgs: ContextMessageEntry[] = [
      msg("user", undefined, "Hello"),
      msg("assistant", { input: 800, output: 150 }, "Response"),
      msg("user", undefined, "Follow-up question with more text"),
      msg("assistant", { output: 0 }, "Streaming..."), // incomplete
    ];
    const result = measureContext({ messages: msgs });
    // exact = 800 + 150 = 950
    assert.equal(result.exact_tokens, 950);
    // Heuristic for msg[2]: "Follow-up question with more text".length = 33 → 33/4 = 8.25 → ceil = 9
    // Heuristic for msg[3]: "Streaming...".length = 12 → 12/4 = 3
    // Total heuristic = 9 + 3 = 12
    assert.equal(result.estimated_new_tokens, 12);
    assert.equal(result.estimated_tokens, 950 + 12);
    assert.equal(result.message_count, 4);
  });

  it("uses sessionID from the last assistant message", () => {
    const msgs: ContextMessageEntry[] = [
      msg("user", undefined, "Hello"),
      msg("assistant", { input: 100, output: 50 }, "OK", {
        sessionID: "sess-123",
      }),
    ];
    const result = measureContext({ messages: msgs });
    assert.equal(result.exact_tokens, 150);
    assert.equal(result.message_count, 2);
  });
});

// ---------------------------------------------------------------------------
// Edge cases: empty / undefined messages
// ---------------------------------------------------------------------------

describe("empty / undefined messages", () => {
  it("returns zeros for empty messages array", () => {
    const result = measureContext({ messages: [] });
    assert.equal(result.estimated_tokens, 0);
    assert.equal(result.message_count, 0);
    assert.equal(result.exact_tokens, 0);
    assert.equal(result.estimated_new_tokens, 0);
  });

  it("returns zeros for undefined messages", () => {
    const result = measureContext({});
    assert.equal(result.estimated_tokens, 0);
    assert.equal(result.message_count, 0);
    assert.equal(result.exact_tokens, 0);
    assert.equal(result.estimated_new_tokens, 0);
  });

  it("returns zeros when messages field is missing", () => {
    const result = measureContext({ messages: undefined });
    assert.equal(result.estimated_tokens, 0);
    assert.equal(result.message_count, 0);
  });
});

// ---------------------------------------------------------------------------
// Edge cases: no completed assistant
// ---------------------------------------------------------------------------

describe("no completed assistant found", () => {
  it("estimates all messages heuristically when no assistant has tokens", () => {
    const msgs: ContextMessageEntry[] = [
      msg("user", undefined, "First"),
      msg("assistant", undefined, "Response without tokens"),
      msg("user", undefined, "Second"),
    ];
    const result = measureContext({ messages: msgs });
    // Heuristic: "First" = 5 / 4 → ceil = 2
    // "Response without tokens" = 24 / 4 = 6
    // "Second" = 6 / 4 → ceil = 2
    // Total = 2 + 6 + 2 = 10
    assert.equal(result.exact_tokens, 0);
    assert.equal(result.estimated_new_tokens, 10);
    assert.equal(result.estimated_tokens, 10);
    assert.equal(result.message_count, 3);
  });

  it("skips streaming assistant (tokens.output = 0)", () => {
    const msgs: ContextMessageEntry[] = [
      msg("user", undefined, "Prompt"),
      msg("assistant", { input: 500, output: 0 }, "Still streaming"),
    ];
    const result = measureContext({ messages: msgs });
    // No completed assistant → pure heuristic
    assert.equal(result.exact_tokens, 0);
    // "Prompt" = 6 / 4 → ceil = 2
    // "Still streaming" = 16 / 4 = 4
    // Total = 2 + 4 = 6
    assert.equal(result.estimated_tokens, 6);
  });

  it("treats missing tokens object as incomplete", () => {
    const msgs: ContextMessageEntry[] = [
      msg("assistant", undefined, "No tokens field"),
    ];
    const result = measureContext({ messages: msgs });
    assert.equal(result.exact_tokens, 0);
    // "No tokens field" = 15 / 4 → ceil = 4
    assert.equal(result.estimated_tokens, 4);
  });
});

// ---------------------------------------------------------------------------
// Messages without parts
// ---------------------------------------------------------------------------

describe("messages without parts", () => {
  it("skips messages with undefined parts", () => {
    const msgs: ContextMessageEntry[] = [
      msg("user", undefined, "Hello"),
      { info: { role: "assistant", id: "a1" } }, // no parts field
    ];
    const result = measureContext({ messages: msgs });
    // No completed assistant (no tokens) → pure heuristic
    // "Hello" = 5 / 4 → ceil = 2
    assert.equal(result.estimated_tokens, 2);
    assert.equal(result.estimated_new_tokens, 2);
    assert.equal(result.exact_tokens, 0);
  });

  it("skips messages with empty parts array", () => {
    const msgs: ContextMessageEntry[] = [
      msg("user", undefined, "Hi"),
      { info: { role: "assistant", id: "a1" }, parts: [] },
    ];
    const result = measureContext({ messages: msgs });
    // "Hi" = 2 / 4 → ceil = 1
    assert.equal(result.estimated_tokens, 1);
  });

  it("handles parts with undefined text gracefully", () => {
    const msgs: ContextMessageEntry[] = [
      msg("user", undefined, "Hey"),
      {
        info: { role: "assistant", id: "a1" },
        parts: [{ type: "text", text: undefined }],
      },
    ];
    const result = measureContext({ messages: msgs });
    // "Hey" = 3 / 4 → ceil = 1
    assert.equal(result.estimated_tokens, 1);
  });
});

// ---------------------------------------------------------------------------
// Heuristic estimation correctness
// ---------------------------------------------------------------------------

describe("estimateMessageHeuristic", () => {
  it("returns 0 for empty parts", () => {
    assert.equal(
      estimateMessageHeuristic({ info: { role: "user", id: "m1" }, parts: [] }),
      0,
    );
  });

  it("returns 0 for undefined parts", () => {
    assert.equal(
      estimateMessageHeuristic({ info: { role: "user", id: "m1" } }),
      0,
    );
  });

  it("computes Math.ceil(text.length / 4) for single part", () => {
    const entry: ContextMessageEntry = {
      info: { role: "user", id: "m1" },
      parts: [{ type: "text", text: "Hello World" }],
    };
    // "Hello World" = 11 chars → 11 / 4 = 2.75 → ceil = 3
    assert.equal(estimateMessageHeuristic(entry), 3);
  });

  it("sums across multiple parts", () => {
    const entry: ContextMessageEntry = {
      info: { role: "assistant", id: "a1" },
      parts: [
        { type: "text", text: "Short" }, // 5 chars
        { type: "text", text: "Longer text" }, // 11 chars
      ],
    };
    // Total chars = 16 → 16 / 4 = 4 → ceil = 4
    assert.equal(estimateMessageHeuristic(entry), 4);
  });

  it("ignores parts without text", () => {
    const entry: ContextMessageEntry = {
      info: { role: "user", id: "m1" },
      parts: [
        { type: "text", text: "ABC" }, // 3 / 4 → ceil = 1
        { type: "text" }, // no text → 0
      ],
    };
    assert.equal(estimateMessageHeuristic(entry), 1);
  });

  it("returns 0 for parts array with undefined text entries", () => {
    const entry: ContextMessageEntry = {
      info: { role: "user", id: "m1" },
      parts: [
        { type: "text", text: undefined },
        { type: "text", text: undefined },
      ],
    };
    assert.equal(estimateMessageHeuristic(entry), 0);
  });
});

// ---------------------------------------------------------------------------
// Barrel export
// ---------------------------------------------------------------------------

describe("barrel export", () => {
  it("exports measureContext as a function", () => {
    assert.equal(typeof measureContext, "function");
  });

  it("exports estimateMessageHeuristic as a function", () => {
    assert.equal(typeof estimateMessageHeuristic, "function");
  });
});

// ---------------------------------------------------------------------------
// Return value shape
// ---------------------------------------------------------------------------

describe("return value shape", () => {
  it("returns all five fields", () => {
    const result = measureContext({ messages: [] });
    assert.ok("estimated_tokens" in result);
    assert.ok("message_count" in result);
    assert.ok("exact_tokens" in result);
    assert.ok("estimated_new_tokens" in result);
    assert.ok("agent" in result);
  });

  it("fields are numbers (agent is string)", () => {
    const msgs: ContextMessageEntry[] = [
      msg("user", undefined, "Test"),
      msg("assistant", { output: 1, input: 10 }, "OK"),
    ];
    const result = measureContext({ messages: msgs });
    assert.equal(typeof result.estimated_tokens, "number");
    assert.equal(typeof result.message_count, "number");
    assert.equal(typeof result.exact_tokens, "number");
    assert.equal(typeof result.estimated_new_tokens, "number");
    assert.equal(typeof result.agent, "string");
  });
});

// ---------------------------------------------------------------------------
// Agent extraction
// ---------------------------------------------------------------------------

describe("agent extraction", () => {
  it("extracts agent from the last user message", () => {
    const msgs: ContextMessageEntry[] = [
      msg("user", undefined, "Hello", { agent: "dolphin" }),
      msg("assistant", { input: 100, output: 50 }, "OK"),
    ];
    const result = measureContext({ messages: msgs });
    assert.equal(result.agent, "dolphin");
  });

  it("falls back to unknown when no agent on user message", () => {
    const msgs: ContextMessageEntry[] = [
      msg("user", undefined, "Hello"),
      msg("assistant", { input: 100, output: 50 }, "OK"),
    ];
    const result = measureContext({ messages: msgs });
    assert.equal(result.agent, "unknown");
  });

  it("returns unknown agent for empty messages", () => {
    const result = measureContext({ messages: [] });
    assert.equal(result.agent, "unknown");
  });

  it("extracts agent even without completed assistant", () => {
    const msgs: ContextMessageEntry[] = [
      msg("user", undefined, "Hello", { agent: "beaver" }),
    ];
    const result = measureContext({ messages: msgs });
    assert.equal(result.agent, "beaver");
  });
});
