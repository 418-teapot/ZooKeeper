/**
 * Tests for the pi event-key adapter (`src/compose-pi.ts`).
 *
 * Covers: `buildPiToolResultHandler` (delta appending and rewrite
 * branches, chained contributions, per-handler crash isolation, image
 * preservation, missing sessionManager), `buildPiContextHandler`
 * (message conversion, empty array, measure-only contract, crash
 * isolation), and the pure helpers `toContextMessageEntries` /
 * `extractText`.
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { ContextMetricsOutput } from "./adapters/opencode/types.js";
import {
  buildPiContextHandler,
  buildPiToolResultHandler,
  extractText,
  type PiContentPart,
  type PiToolResultEvent,
  toContextMessageEntries,
} from "./compose-pi.js";
import type { AfterExecContribution, AfterExecInput } from "./core/slots.js";
import { _getBufferForTesting, _resetForTesting } from "./utils/logger.js";

afterEach(() => {
  _resetForTesting();
});

/** Session context shared by the handler tests. */
const SESSION_CTX = { sessionManager: { getSessionId: () => "sess-1" } };

/**
 * Build a minimal after-exec contribution that appends a suffix line.
 */
function appendSuffix(suffix: string): AfterExecContribution {
  return {
    name: `append-${suffix}`,
    handle: (_input, output) => {
      output.output = `${output.output ?? ""}\n${suffix}`;
    },
  };
}

/**
 * Build a minimal pi `tool_result` event for the `bash` tool.
 */
function toolEvent(
  content: PiContentPart[],
  input?: Record<string, unknown>,
): PiToolResultEvent {
  return {
    type: "tool_result",
    toolName: "bash",
    toolCallId: "call-1",
    input,
    content,
    isError: false,
  };
}

/** Count the buffered `handler_crashed` entries. */
function crashedEntries(): Array<Record<string, unknown>> {
  return _getBufferForTesting().filter(
    (entry) => entry.event === "handler_crashed",
  );
}

// ---------------------------------------------------------------------------
// buildPiToolResultHandler
// ---------------------------------------------------------------------------

describe("buildPiToolResultHandler", () => {
  it("appends the delta as one text part for a single contribution", async () => {
    const handler = buildPiToolResultHandler([appendSuffix("done")]);
    const result = await handler(
      toolEvent([{ type: "text", text: "hello" }]),
      SESSION_CTX,
    );
    assert.deepEqual(result, {
      content: [
        { type: "text", text: "hello" },
        { type: "text", text: "\ndone" },
      ],
    });
  });

  it("chains multiple contributions into one accumulated delta part", async () => {
    const handler = buildPiToolResultHandler([
      appendSuffix("A"),
      appendSuffix("B"),
    ]);
    const result = await handler(
      toolEvent([{ type: "text", text: "hello" }]),
      SESSION_CTX,
    );
    assert.deepEqual(result, {
      content: [
        { type: "text", text: "hello" },
        { type: "text", text: "\nA\nB" },
      ],
    });
  });

  it("supports async contributions", async () => {
    const handler = buildPiToolResultHandler([
      {
        name: "async-append",
        handle: async (_input, output) => {
          output.output = `${output.output ?? ""}\nasync`;
        },
      },
    ]);
    const result = await handler(
      toolEvent([{ type: "text", text: "hello" }]),
      SESSION_CTX,
    );
    assert.deepEqual(result, {
      content: [
        { type: "text", text: "hello" },
        { type: "text", text: "\nasync" },
      ],
    });
  });

  it("returns undefined when no contribution changes the output", async () => {
    const handler = buildPiToolResultHandler([
      {
        name: "noop",
        handle: () => {},
      },
    ]);
    const result = await handler(
      toolEvent([{ type: "text", text: "hello" }]),
      SESSION_CTX,
    );
    assert.equal(result, undefined);
  });

  it("returns undefined for an empty contribution list", async () => {
    const handler = buildPiToolResultHandler([]);
    const result = await handler(
      toolEvent([{ type: "text", text: "hello" }]),
      SESSION_CTX,
    );
    assert.equal(result, undefined);
  });

  it("isolates a throwing contribution and still runs later ones", async () => {
    const handler = buildPiToolResultHandler([
      {
        name: "boom",
        handle: () => {
          throw new Error("boom");
        },
      },
      appendSuffix("ok"),
    ]);
    const result = await handler(
      toolEvent([{ type: "text", text: "hello" }]),
      SESSION_CTX,
    );
    assert.deepEqual(result, {
      content: [
        { type: "text", text: "hello" },
        { type: "text", text: "\nok" },
      ],
    });
    const crashed = crashedEntries();
    assert.equal(crashed.length, 1);
    assert.equal(crashed[0].handler, "boom");
    assert.equal(crashed[0].sessionId, "sess-1");
    assert.equal(crashed[0].callId, "call-1");
  });

  it("isolates an async rejection", async () => {
    const handler = buildPiToolResultHandler([
      {
        name: "async-boom",
        handle: async () => {
          throw new Error("async boom");
        },
      },
      appendSuffix("ok"),
    ]);
    const result = await handler(
      toolEvent([{ type: "text", text: "hello" }]),
      SESSION_CTX,
    );
    assert.deepEqual(result, {
      content: [
        { type: "text", text: "hello" },
        { type: "text", text: "\nok" },
      ],
    });
    const crashed = crashedEntries();
    assert.equal(crashed.length, 1);
    assert.equal(crashed[0].handler, "async-boom");
  });

  it("preserves image parts and appends only the text delta", async () => {
    const handler = buildPiToolResultHandler([appendSuffix("note")]);
    const result = await handler(
      toolEvent([
        { type: "text", text: "screenshot shown" },
        { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
      ]),
      SESSION_CTX,
    );
    assert.deepEqual(result, {
      content: [
        { type: "text", text: "screenshot shown" },
        { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
        { type: "text", text: "\nnote" },
      ],
    });
  });

  it("seeds an empty text when the event has no content", async () => {
    const handler = buildPiToolResultHandler([
      {
        name: "inject",
        handle: (_input, output) => {
          output.output = "injected";
        },
      },
    ]);
    // `content` is required by the pi contract; the cast simulates a
    // structurally older event so the handler's defensive fallback runs.
    const bareEvent = {
      type: "tool_result",
      toolName: "bash",
      toolCallId: "call-1",
      isError: false,
    } as PiToolResultEvent;
    const result = await handler(bareEvent, SESSION_CTX);
    assert.deepEqual(result, {
      content: [{ type: "text", text: "injected" }],
    });
  });

  it("rewrites the text when a contribution prefixes the seed", async () => {
    const handler = buildPiToolResultHandler([
      {
        name: "prepend",
        handle: (_input, output) => {
          output.output = `hello ${output.output ?? ""}`;
        },
      },
    ]);
    // A contribution that inserts text before the seed does not extend
    // it (the final text does not start with the seed), so the text is
    // rewritten: the content becomes a single full text part carrying
    // the entire final text, and the image part is preserved.
    const result = await handler(
      toolEvent([
        { type: "text", text: "world" },
        { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
      ]),
      SESSION_CTX,
    );
    assert.deepEqual(result, {
      content: [
        { type: "text", text: "hello world" },
        { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
      ],
    });
  });

  it("rewrite mode replaces text parts entirely and keeps images", async () => {
    const handler = buildPiToolResultHandler([
      {
        name: "rewrite",
        handle: (_input, output) => {
          output.output = "rewritten summary";
        },
      },
    ]);
    // The contribution neither extends nor prefixes the seed, so the
    // text was rewritten: the original text part is replaced by the
    // full final text and the image part is preserved.
    const result = await handler(
      toolEvent([
        { type: "text", text: "original text" },
        { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
      ]),
      SESSION_CTX,
    );
    assert.deepEqual(result, {
      content: [
        { type: "text", text: "rewritten summary" },
        { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
      ],
    });
  });

  it("tolerates a missing sessionManager", async () => {
    const handler = buildPiToolResultHandler([appendSuffix("x")]);
    const result = await handler(toolEvent([{ type: "text", text: "hi" }]), {});
    assert.deepEqual(result, {
      content: [
        { type: "text", text: "hi" },
        { type: "text", text: "\nx" },
      ],
    });
  });

  it("passes tool / sessionID / callID / args to the afterExec input", async () => {
    let captured: AfterExecInput | undefined;
    const handler = buildPiToolResultHandler([
      {
        name: "capture",
        handle: (input) => {
          captured = input;
        },
      },
    ]);
    await handler(
      toolEvent([{ type: "text", text: "hello" }], {
        command: "ls",
        cwd: "/tmp",
      }),
      SESSION_CTX,
    );
    assert.deepEqual(captured, {
      tool: "bash",
      sessionID: "sess-1",
      callID: "call-1",
      args: { command: "ls", cwd: "/tmp" },
    });
  });
});

// ---------------------------------------------------------------------------
// buildPiContextHandler
// ---------------------------------------------------------------------------

describe("buildPiContextHandler", () => {
  it("converts user / assistant / toolResult messages into entries", async () => {
    let captured: ContextMetricsOutput | undefined;
    const handler = buildPiContextHandler([
      {
        name: "capture",
        handle: (output) => {
          captured = output;
        },
      },
    ]);
    const result = await handler(
      {
        type: "context",
        messages: [
          { role: "user", content: "hello" },
          {
            role: "assistant",
            content: [
              {
                type: "toolCall",
                id: "tc-1",
                name: "bash",
                arguments: { command: "ls" },
              },
              { type: "thinking", thinking: "hmm" },
              { type: "text", text: "answer" },
            ],
            usage: {
              input: 100,
              output: 50,
              cacheRead: 200,
              cacheWrite: 10,
              reasoning: 5,
            },
          },
          {
            role: "toolResult",
            toolCallId: "tc-1",
            toolName: "bash",
            content: [
              { type: "text", text: "file.txt" },
              { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
            ],
            isError: false,
          },
        ],
      },
      SESSION_CTX,
    );
    assert.equal(result, undefined);
    assert.deepEqual(captured?.messages, [
      {
        info: { role: "user", id: "pi-sess-1-0", sessionID: "sess-1" },
        parts: [{ type: "text", text: "hello" }],
      },
      {
        info: {
          role: "assistant",
          id: "pi-sess-1-1",
          sessionID: "sess-1",
          tokens: {
            input: 100,
            output: 50,
            cache: { read: 200, write: 10 },
            reasoning: 5,
          },
        },
        parts: [
          { type: "tool", callID: "tc-1", state: { input: { command: "ls" } } },
          { type: "text", text: "hmm" },
          { type: "text", text: "answer" },
        ],
      },
      {
        info: { role: "toolResult", id: "pi-sess-1-2", sessionID: "sess-1" },
        parts: [
          { type: "tool", callID: "tc-1", state: { output: "file.txt" } },
        ],
      },
    ]);
  });

  it("converts user content arrays, skipping image parts", async () => {
    let captured: ContextMetricsOutput | undefined;
    const handler = buildPiContextHandler([
      {
        name: "capture",
        handle: (output) => {
          captured = output;
        },
      },
    ]);
    const result = await handler(
      {
        type: "context",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "look at" },
              { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
              { type: "text", text: "this" },
            ],
          },
        ],
      },
      SESSION_CTX,
    );
    assert.equal(result, undefined);
    assert.deepEqual(captured?.messages, [
      {
        info: { role: "user", id: "pi-sess-1-0", sessionID: "sess-1" },
        parts: [
          { type: "text", text: "look at" },
          { type: "text", text: "this" },
        ],
      },
    ]);
  });

  it("yields empty entries for an empty message array", async () => {
    let captured: ContextMetricsOutput | undefined;
    const handler = buildPiContextHandler([
      {
        name: "capture",
        handle: (output) => {
          captured = output;
        },
      },
    ]);
    const result = await handler(
      { type: "context", messages: [] },
      SESSION_CTX,
    );
    assert.equal(result, undefined);
    assert.deepEqual(captured?.messages, []);
  });

  it("is measure-only — always returns undefined even when contributions mutate messages", async () => {
    const handler = buildPiContextHandler([
      {
        name: "mutate",
        handle: (output) => {
          output.messages = [];
        },
      },
    ]);
    const result = await handler(
      { type: "context", messages: [{ role: "user", content: "hi" }] },
      SESSION_CTX,
    );
    assert.equal(result, undefined);
  });

  it("isolates a throwing transform contribution and still runs later ones", async () => {
    let captured: ContextMetricsOutput | undefined;
    const handler = buildPiContextHandler([
      {
        name: "boom",
        handle: () => {
          throw new Error("ctx boom");
        },
      },
      {
        name: "capture",
        handle: (output) => {
          captured = output;
        },
      },
    ]);
    const result = await handler(
      { type: "context", messages: [{ role: "user", content: "hi" }] },
      SESSION_CTX,
    );
    assert.equal(result, undefined);
    assert.ok(captured, "later contribution must still run");
    const crashed = crashedEntries();
    assert.equal(crashed.length, 1);
    assert.equal(crashed[0].handler, "boom");
  });
});

// ---------------------------------------------------------------------------
// toContextMessageEntries
// ---------------------------------------------------------------------------

describe("toContextMessageEntries", () => {
  it("synthesises ids and keeps roles as-is", () => {
    const entries = toContextMessageEntries(
      [{ role: "user", content: "hi" }],
      "sess-9",
    );
    assert.deepEqual(entries, [
      {
        info: { role: "user", id: "pi-sess-9-0", sessionID: "sess-9" },
        parts: [{ type: "text", text: "hi" }],
      },
    ]);
  });

  it("omits tokens when an assistant message has no usage", () => {
    const entries = toContextMessageEntries(
      [{ role: "assistant", content: [{ type: "text", text: "ok" }] }],
      "sess-9",
    );
    assert.deepEqual(entries, [
      {
        info: { role: "assistant", id: "pi-sess-9-0", sessionID: "sess-9" },
        parts: [{ type: "text", text: "ok" }],
      },
    ]);
  });
});

// ---------------------------------------------------------------------------
// extractText
// ---------------------------------------------------------------------------

describe("extractText", () => {
  it("joins text parts and ignores images", () => {
    assert.equal(
      extractText([
        { type: "text", text: "a" },
        { type: "image", data: "x", mimeType: "image/png" },
        { type: "text", text: "b" },
      ]),
      "ab",
    );
  });

  it("returns an empty string for empty or missing content", () => {
    assert.equal(extractText(undefined), "");
    assert.equal(extractText([]), "");
  });
});
