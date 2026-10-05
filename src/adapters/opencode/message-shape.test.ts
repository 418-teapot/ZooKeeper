/**
 * Tests for the OpenCode message-shape helpers used by idle
 * classification.
 *
 * Covers the transcript scans that decide whether a settled turn ended at
 * a pending question tool call (`hasUnansweredQuestion`) or at an aborted
 * assistant turn (`lastAssistantAborted`).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  hasUnansweredQuestion,
  lastAssistantAborted,
} from "./message-shape.js";

describe("hasUnansweredQuestion", () => {
  it("detects a pending question in the last assistant turn", () => {
    assert.equal(
      hasUnansweredQuestion([
        {
          info: { role: "assistant" },
          parts: [{ type: "tool", name: "ask_user_question", state: {} }],
        },
      ]),
      true,
    );
  });

  it("returns false once a real user message follows", () => {
    assert.equal(
      hasUnansweredQuestion([
        {
          info: { role: "assistant" },
          parts: [{ type: "tool", tool: "question", state: {} }],
        },
        { info: { role: "user" } },
      ]),
      false,
    );
  });

  it("skips synthetic user messages when scanning backward", () => {
    assert.equal(
      hasUnansweredQuestion([
        { info: { role: "assistant" } },
        { info: { role: "user", synthetic: true } },
        {
          info: { role: "assistant" },
          parts: [{ type: "tool", tool: "question", state: {} }],
        },
      ]),
      true,
    );
  });
});

describe("lastAssistantAborted", () => {
  it("reports the last assistant message error name", () => {
    assert.equal(
      lastAssistantAborted([
        { info: { role: "assistant", error: { name: "MessageAbortedError" } } },
      ]),
      true,
    );
    assert.equal(
      lastAssistantAborted([
        { info: { role: "assistant", error: { name: "ApiError" } } },
      ]),
      false,
    );
    assert.equal(lastAssistantAborted([]), false);
  });
});
