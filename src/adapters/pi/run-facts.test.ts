/**
 * Tests for the pi run-fact projection layer (`src/adapters/pi/run-facts.ts`).
 *
 * Boundary: the module's exported projections and fact constructors.  Live
 * session events and replayed session messages both enter here, so these are
 * the single rules that decide what a run's fact log records — the
 * expectations below are the pi shapes these rules must serve, stated as
 * literals rather than recomputed.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  messageEndFact,
  projectMessageParts,
  projectMessageText,
  projectTextParts,
  projectToolCalls,
  projectUsage,
  toolEndFact,
  toolStartFact,
  userMessageFact,
} from "./run-facts.js";

describe("projectUsage", () => {
  it("keeps the finite usage fields and drops everything else", () => {
    assert.deepEqual(
      projectUsage({
        input: 10,
        output: 20,
        cacheRead: 5,
        cacheWrite: 3,
        totalTokens: 30,
      }),
      { input: 10, output: 20, cacheRead: 5, totalTokens: 30 },
    );
  });

  it("omits absent and non-finite fields", () => {
    assert.deepEqual(projectUsage({ input: 10, output: Number.NaN }), {
      input: 10,
    });
    assert.deepEqual(projectUsage({ input: "10", output: 4 }), { output: 4 });
  });

  it("yields no usage when nothing usable was reported", () => {
    assert.equal(projectUsage({}), undefined);
    assert.equal(projectUsage({ input: Infinity }), undefined);
    assert.equal(projectUsage(null), undefined);
    assert.equal(projectUsage("usage"), undefined);
  });

  it("yields zero usage rather than dropping a reported zero", () => {
    assert.deepEqual(projectUsage({ input: 0, output: 0 }), {
      input: 0,
      output: 0,
    });
  });
});

describe("projectMessageParts", () => {
  it("keeps text and thinking parts in message order", () => {
    assert.deepEqual(
      projectMessageParts([
        { type: "thinking", thinking: "hmm" },
        { type: "text", text: "answer" },
        { type: "toolCall", id: "t1", name: "bash", arguments: {} },
        { type: "image", data: "zz", mimeType: "image/png" },
        { type: "text", text: " more" },
      ]),
      [
        { type: "thinking", thinking: "hmm" },
        { type: "text", text: "answer" },
        { type: "text", text: " more" },
      ],
    );
  });

  it("treats a plain string content as one text part", () => {
    assert.deepEqual(projectMessageParts("hello"), [
      { type: "text", text: "hello" },
    ]);
  });

  it("yields no parts for a missing or non-part content", () => {
    assert.deepEqual(projectMessageParts(undefined), []);
    assert.deepEqual(projectMessageParts(3), []);
    assert.deepEqual(projectMessageParts([null, 4, "raw"]), []);
  });
});

describe("projectTextParts", () => {
  it("keeps only text parts", () => {
    assert.deepEqual(
      projectTextParts([
        { type: "text", text: "build ok" },
        { type: "image", data: "zz", mimeType: "image/png" },
        { type: "thinking", thinking: "hmm" },
        { type: "text", text: "\nwarn" },
      ]),
      [
        { type: "text", text: "build ok" },
        { type: "text", text: "\nwarn" },
      ],
    );
  });

  it("treats a plain string content as one text part", () => {
    assert.deepEqual(projectTextParts("build ok"), [
      { type: "text", text: "build ok" },
    ]);
  });

  it("yields no parts for a missing content", () => {
    assert.deepEqual(projectTextParts(undefined), []);
  });
});

describe("projectMessageText", () => {
  it("joins the text parts of a part array", () => {
    assert.equal(
      projectMessageText([
        { type: "text", text: "part one " },
        { type: "thinking", thinking: "ignored" },
        { type: "text", text: "part two" },
      ]),
      "part one part two",
    );
  });

  it("returns a string content verbatim", () => {
    assert.equal(projectMessageText("SUMMARY: do it"), "SUMMARY: do it");
  });

  it("yields an empty string when there is no text", () => {
    assert.equal(projectMessageText(undefined), "");
    assert.equal(projectMessageText([]), "");
    assert.equal(projectMessageText([{ type: "image", data: "z" }]), "");
  });
});

describe("projectToolCalls", () => {
  it("keeps the id, name, and arguments of tool-call blocks", () => {
    assert.deepEqual(
      projectToolCalls([
        { type: "text", text: "thinking out loud" },
        {
          type: "toolCall",
          id: "tc-1",
          name: "bash",
          arguments: { command: "ls -la" },
        },
      ]),
      [{ id: "tc-1", name: "bash", args: { command: "ls -la" } }],
    );
  });

  it("falls back to a generic name and empty args for a malformed block", () => {
    assert.deepEqual(
      projectToolCalls([
        { type: "toolCall", id: 7, name: 9, arguments: ["ls"] },
        { type: "toolCall", name: "read", arguments: { path: "a" } },
      ]),
      [
        { name: "tool", args: {} },
        { name: "read", args: { path: "a" } },
      ],
    );
  });

  it("yields no blocks for a non-array content", () => {
    assert.deepEqual(projectToolCalls("text"), []);
    assert.deepEqual(projectToolCalls(undefined), []);
  });
});

describe("userMessageFact", () => {
  it("projects the message text and the observed timestamp", () => {
    assert.deepEqual(
      userMessageFact([{ type: "text", text: "SUMMARY: go" }], 1700000000000),
      { type: "user_message", at: 1700000000000, text: "SUMMARY: go" },
    );
  });

  it("yields no fact for a blank message", () => {
    assert.equal(
      userMessageFact([{ type: "text", text: "  \n " }], 1),
      undefined,
    );
    assert.equal(userMessageFact([], 1), undefined);
    assert.equal(userMessageFact(undefined, 1), undefined);
  });
});

describe("messageEndFact", () => {
  it("projects the content parts with the usage report", () => {
    assert.deepEqual(
      messageEndFact(
        [
          { type: "text", text: "done" },
          { type: "toolCall", id: "t1", name: "bash", arguments: {} },
        ],
        { input: 10, output: 4, cacheRead: 6, totalTokens: 20 },
        5,
      ),
      {
        type: "message_end",
        at: 5,
        content: [{ type: "text", text: "done" }],
        usage: { input: 10, output: 4, cacheRead: 6, totalTokens: 20 },
      },
    );
  });

  it("omits the usage field when the provider reported none", () => {
    assert.deepEqual(messageEndFact([], undefined, 5), {
      type: "message_end",
      at: 5,
      content: [],
    });
  });
});

describe("tool facts", () => {
  it("projects a tool start with its id and untruncated args", () => {
    assert.deepEqual(
      toolStartFact(
        { id: "tc-1", name: "bash", args: { command: "npm run build" } },
        7,
      ),
      {
        type: "tool_start",
        at: 7,
        toolCallId: "tc-1",
        toolName: "bash",
        args: { command: "npm run build" },
      },
    );
  });

  it("omits the tool-call id when the host reported none", () => {
    assert.deepEqual(toolStartFact({ name: "bash", args: {} }, 7), {
      type: "tool_start",
      at: 7,
      toolName: "bash",
      args: {},
    });
  });

  it("projects a tool end with its text parts and error flag", () => {
    assert.deepEqual(
      toolEndFact(
        {
          toolCallId: "tc-1",
          toolName: "bash",
          content: [
            { type: "text", text: "build ok" },
            { type: "image", data: "zz", mimeType: "image/png" },
          ],
          isError: true,
        },
        9,
      ),
      {
        type: "tool_end",
        at: 9,
        toolCallId: "tc-1",
        toolName: "bash",
        content: [{ type: "text", text: "build ok" }],
        isError: true,
      },
    );
  });
});
