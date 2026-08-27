/**
 * Tests for the message-to-result reduction in `result.ts`.
 *
 * Covers: last-assistant-text extraction, skipping errored messages,
 * empty messages reducing to an error result, aborted/error classification,
 * and partial output preserved on failure variants.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  type AgentMessage,
  classifyOutcome,
  reduceMessages,
} from "./result.js";

/**
 * Build a minimal assistant message for readability.
 *
 * @param overrides - Optional field overrides on top of the base message.
 * @returns A non-errored assistant message with the given overrides.
 */
function assistant(
  text: string,
  overrides: Partial<AgentMessage> = {},
): AgentMessage {
  return { role: "assistant", text, errored: false, ...overrides };
}

// ---------------------------------------------------------------------------
// reduceMessages — last assistant text extraction
// ---------------------------------------------------------------------------

describe("reduceMessages — last assistant text extraction", () => {
  it("returns the text of the last assistant message", () => {
    const messages: AgentMessage[] = [
      { role: "user", text: "do it", errored: false },
      assistant("first draft"),
      assistant("final answer"),
    ];
    assert.equal(reduceMessages(messages), "final answer");
  });

  it("ignores non-assistant messages", () => {
    const messages: AgentMessage[] = [
      { role: "toolResult", text: "tool output", errored: false },
      { role: "user", text: "continue", errored: false },
      assistant("the result"),
    ];
    assert.equal(reduceMessages(messages), "the result");
  });

  it("returns an empty string for an empty message list", () => {
    assert.equal(reduceMessages([]), "");
  });

  it("returns an empty string when no assistant message exists", () => {
    const messages: AgentMessage[] = [
      { role: "user", text: "do it", errored: false },
      { role: "toolResult", text: "output", errored: false },
    ];
    assert.equal(reduceMessages(messages), "");
  });
});

// ---------------------------------------------------------------------------
// reduceMessages — skipping errored messages
// ---------------------------------------------------------------------------

describe("reduceMessages — skipping errored messages", () => {
  it("skips an errored trailing assistant message", () => {
    const messages: AgentMessage[] = [
      assistant("good draft"),
      assistant("broken output", { errored: true }),
    ];
    assert.equal(reduceMessages(messages), "good draft");
  });

  it("skips multiple errored messages to reach a non-errored one", () => {
    const messages: AgentMessage[] = [
      assistant("good output"),
      assistant("broken a", { errored: true }),
      assistant("broken b", { errored: true }),
    ];
    assert.equal(reduceMessages(messages), "good output");
  });

  it("returns an empty string when every assistant message is errored", () => {
    const messages: AgentMessage[] = [
      assistant("broken a", { errored: true }),
      assistant("broken b", { errored: true }),
    ];
    assert.equal(reduceMessages(messages), "");
  });
});

// ---------------------------------------------------------------------------
// classifyOutcome — empty messages
// ---------------------------------------------------------------------------

describe("classifyOutcome — empty messages", () => {
  it("yields an error result when there are no messages", () => {
    const result = classifyOutcome({ messages: [] });
    assert.equal(result.kind, "error");
  });

  it("empty messages with a stop reason still yield an error result", () => {
    const result = classifyOutcome({ stopReason: "stop", messages: [] });
    assert.equal(result.kind, "error");
  });
});

// ---------------------------------------------------------------------------
// classifyOutcome — normal stop
// ---------------------------------------------------------------------------

describe("classifyOutcome — normal stop", () => {
  it("yields an ok result with the reduced text", () => {
    const result = classifyOutcome({
      stopReason: "stop",
      messages: [assistant("done")],
    });
    assert.deepEqual(result, { kind: "ok", text: "done" });
  });
});

// ---------------------------------------------------------------------------
// classifyOutcome — abort and error classification
// ---------------------------------------------------------------------------

describe("classifyOutcome — abort and error classification", () => {
  it("yields an aborted result for an aborted stop reason", () => {
    const result = classifyOutcome({
      stopReason: "aborted",
      messages: [assistant("partial work")],
    });
    assert.deepEqual(result, { kind: "aborted", text: "partial work" });
  });

  it("yields an error result for an error stop reason", () => {
    const result = classifyOutcome({
      stopReason: "error",
      messages: [assistant("partial work")],
    });
    assert.deepEqual(result, {
      kind: "error",
      text: "partial work",
      errorMessage: "subagent stopped with error",
    });
  });

  it("yields an error result when an explicit error message is present", () => {
    const result = classifyOutcome({
      errorMessage: "provider exploded",
      messages: [assistant("partial work")],
    });
    assert.deepEqual(result, {
      kind: "error",
      text: "partial work",
      errorMessage: "provider exploded",
    });
  });
});

// ---------------------------------------------------------------------------
// classifyOutcome — partial output preserved on failure variants
// ---------------------------------------------------------------------------

describe("classifyOutcome — partial output preserved on failure variants", () => {
  it("aborted preserves the reduced text", () => {
    const result = classifyOutcome({
      stopReason: "aborted",
      messages: [assistant("some progress")],
    });
    assert.equal(result.kind, "aborted");
    if (result.kind === "aborted") {
      assert.equal(result.text, "some progress");
    }
  });

  it("error preserves the reduced text alongside the error message", () => {
    const result = classifyOutcome({
      stopReason: "error",
      messages: [assistant("some progress")],
    });
    assert.equal(result.kind, "error");
    if (result.kind === "error") {
      assert.equal(result.text, "some progress");
      assert.equal(result.errorMessage, "subagent stopped with error");
    }
  });

  it("an explicit error message wins over an ok stop reason", () => {
    const result = classifyOutcome({
      stopReason: "stop",
      errorMessage: "late failure",
      messages: [assistant("output anyway")],
    });
    assert.deepEqual(result, {
      kind: "error",
      text: "output anyway",
      errorMessage: "late failure",
    });
  });
});
