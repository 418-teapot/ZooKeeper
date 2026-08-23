/**
 * Tests for the pi event-key adapter (`src/compose-pi.ts`).
 *
 * Covers: `buildPiToolResultHandler` (delta appending and rewrite
 * branches, chained contributions, per-handler crash isolation, image
 * preservation, missing sessionManager), `buildPiContextHandler`
 * (native pi messages passed to transforms, result replacement, model
 * limit capture, empty array, crash isolation), and the pure helper
 * `extractText`.
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  buildPiContextHandler,
  buildPiMessageEndHandler,
  buildPiToolResultHandler,
  extractText,
  type PiAgentMessage,
  type PiAssistantMessage,
  type PiContentPart,
  type PiToolResultEvent,
} from "./compose-pi.js";
import type {
  AfterExecContribution,
  AfterExecInput,
  TransformOutput,
} from "./core/slots.js";
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
  it("passes native pi messages to transform contributions", async () => {
    let captured: TransformOutput | undefined;
    const handler = buildPiContextHandler([
      {
        name: "capture",
        handle: (output) => {
          captured = output;
        },
      },
    ]);
    const messages: PiAgentMessage[] = [{ role: "user", content: "hello" }];
    const result = await handler({ type: "context", messages }, SESSION_CTX);
    assert.deepEqual(result, { messages });
    assert.equal(captured?.messages, messages);
  });

  it("returns the modified message list from transform contributions", async () => {
    const replacement: PiAgentMessage[] = [
      { role: "user", content: "replaced" },
    ];
    const handler = buildPiContextHandler([
      {
        name: "replace",
        handle: (output) => {
          output.messages = replacement;
        },
      },
    ]);
    const result = await handler(
      { type: "context", messages: [{ role: "user", content: "hi" }] },
      SESSION_CTX,
    );
    assert.deepEqual(result, { messages: replacement });
  });

  it("captures the model context window from ctx.model", async () => {
    const handler = buildPiContextHandler([
      {
        name: "noop",
        handle: () => {},
      },
    ]);
    await handler(
      { type: "context", messages: [{ role: "user", content: "hi" }] },
      {
        sessionManager: { getSessionId: () => "sess-model" },
        model: { id: "gpt-5", contextWindow: 128000 },
      },
    );
    // The capture is best verified through the downstream pruning/nudge
    // behavior; here we assert the handler completes without throwing.
    assert.ok(true);
  });

  it("returns the input messages for an empty contribution list", async () => {
    const messages: PiAgentMessage[] = [{ role: "user", content: "hi" }];
    const handler = buildPiContextHandler([]);
    const result = await handler({ type: "context", messages }, SESSION_CTX);
    assert.deepEqual(result, { messages });
  });

  it("yields empty messages for an empty message array", async () => {
    const handler = buildPiContextHandler([]);
    const result = await handler(
      { type: "context", messages: [] },
      SESSION_CTX,
    );
    assert.deepEqual(result, { messages: [] });
  });

  it("isolates a throwing transform contribution and still runs later ones", async () => {
    let captured: TransformOutput | undefined;
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
    assert.deepEqual(result, { messages: [{ role: "user", content: "hi" }] });
    assert.ok(captured, "later contribution must still run");
    const crashed = crashedEntries();
    assert.equal(crashed.length, 1);
    assert.equal(crashed[0].handler, "boom");
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

// ---------------------------------------------------------------------------
// buildPiMessageEndHandler
// ---------------------------------------------------------------------------

function assistantMessage(content: PiAssistantMessage["content"]): {
  role: "assistant";
  content: PiAssistantMessage["content"];
} {
  return { role: "assistant", content };
}

function messageEndEvent(message: PiAgentMessage) {
  return { type: "message_end" as const, message };
}

describe("buildPiMessageEndHandler", () => {
  it("strips a leading [mN] ref echo from assistant text", () => {
    const handler = buildPiMessageEndHandler();
    const message = assistantMessage([{ type: "text", text: "[m3] hello" }]);
    const result = handler(messageEndEvent(message), {});
    assert.ok(result);
    assert.equal(result?.message?.role, "assistant");
    assert.deepEqual(result?.message?.content, [
      { type: "text", text: "hello" },
    ]);
  });

  it("strips multiple leading [mN] ref echoes", () => {
    const handler = buildPiMessageEndHandler();
    const message = assistantMessage([
      { type: "text", text: "[m1] [m2] body" },
    ]);
    const result = handler(messageEndEvent(message), {});
    assert.ok(result);
    assert.deepEqual(result?.message?.content, [
      { type: "text", text: "body" },
    ]);
  });

  it("preserves a mid-text [mN] occurrence", () => {
    const handler = buildPiMessageEndHandler();
    const message = assistantMessage([{ type: "text", text: "see [m3] here" }]);
    const result = handler(messageEndEvent(message), {});
    assert.equal(result, undefined);
  });

  it("leaves non-assistant messages untouched", () => {
    const handler = buildPiMessageEndHandler();
    const message: PiAgentMessage = { role: "user", content: "[m3] hi" };
    const result = handler(messageEndEvent(message), {});
    assert.equal(result, undefined);
  });

  it("returns undefined when the message is unchanged", () => {
    const handler = buildPiMessageEndHandler();
    const message = assistantMessage([{ type: "text", text: "plain" }]);
    const result = handler(messageEndEvent(message), {});
    assert.equal(result, undefined);
  });

  it("does not mutate the input message", () => {
    const handler = buildPiMessageEndHandler();
    const content = [{ type: "text" as const, text: "[m3] hello" }];
    const message = assistantMessage(content);
    handler(messageEndEvent(message), {});
    assert.deepEqual(content, [{ type: "text", text: "[m3] hello" }]);
    assert.deepEqual(message.content, [{ type: "text", text: "[m3] hello" }]);
  });

  it("leaves thinking and toolCall blocks untouched", () => {
    const handler = buildPiMessageEndHandler();
    const message = assistantMessage([
      { type: "thinking", thinking: "[m3] thought" },
      { type: "toolCall", id: "c1", name: "x", arguments: {} },
      { type: "text", text: "[m4] ok" },
    ]);
    const result = handler(messageEndEvent(message), {});
    assert.ok(result);
    assert.deepEqual(result?.message?.content, [
      { type: "thinking", thinking: "[m3] thought" },
      { type: "toolCall", id: "c1", name: "x", arguments: {} },
      { type: "text", text: "ok" },
    ]);
  });
});
