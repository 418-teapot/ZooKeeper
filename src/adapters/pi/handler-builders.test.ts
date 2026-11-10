/**
 * Tests for the pi handler builders (`src/adapters/pi/handlers.ts`).
 *
 * Covers: `buildPiToolResultHandler` (delta appending and rewrite
 * branches, chained contributions, per-handler crash isolation, image
 * preservation, missing sessionManager), `buildPiContextHandler`
 * (native pi messages passed to transforms, result replacement, model
 * limit capture, empty array, crash isolation), and
 * `buildPiMessageEndHandler` (ref-echo stripping, immutability).
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { createContextRuntime } from "../../core/context/runtime.js";
import type {
  AfterExecContribution,
  AfterExecInput,
  TransformOutput,
} from "../../core/unit.js";
import { createReplyStripHandler } from "../../hooks/reply-strip/index.js";
import { permitFor } from "../../testkits/context-runtime.js";
import { assistantMessage } from "../../testkits/pi-messages.js";
import { _getBufferForTesting, _resetForTesting } from "../../utils/logger.js";
import {
  buildPiContextHandler,
  buildPiMessageEndHandler,
  buildPiToolResultHandler,
} from "./handlers.js";
import type {
  PiAgentMessage,
  PiContentPart,
  PiToolResultEvent,
} from "./types.js";

afterEach(() => {
  _resetForTesting();
});

/** Session context shared by the handler tests. */
const SESSION_CTX = { sessionManager: { getSessionId: () => "sess-1" } };

/** The plugin instance's context records. */
const runtime = createContextRuntime();

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
    const handler = buildPiContextHandler(
      [
        {
          name: "capture",
          handle: (output) => {
            captured = output;
          },
        },
      ],
      runtime,
    );
    const messages: PiAgentMessage[] = [{ role: "user", content: "hello" }];
    const result = await handler({ type: "context", messages }, SESSION_CTX);
    assert.deepEqual(result, { messages });
    assert.equal(captured?.messages, messages);
  });

  it("returns the modified message list from transform contributions", async () => {
    const replacement: PiAgentMessage[] = [
      { role: "user", content: "replaced" },
    ];
    const handler = buildPiContextHandler(
      [
        {
          name: "replace",
          handle: (output) => {
            output.messages = replacement;
          },
        },
      ],
      runtime,
    );
    const result = await handler(
      { type: "context", messages: [{ role: "user", content: "hi" }] },
      SESSION_CTX,
    );
    assert.deepEqual(result, { messages: replacement });
  });

  it("captures the model context window from ctx.model", async () => {
    const handler = buildPiContextHandler(
      [
        {
          name: "noop",
          handle: () => {},
        },
      ],
      runtime,
    );
    const permit = permitFor("sess-model");
    await handler(
      { type: "context", messages: [{ role: "user", content: "hi" }] },
      {
        sessionManager: { getSessionId: () => "sess-model" },
        model: { id: "gpt-5", contextWindow: 128000 },
      },
      permit.sessionID,
      permit,
    );
    assert.deepEqual(runtime.modelLimit("sess-model"), {
      context: 128000,
      modelId: "gpt-5",
    });
  });

  it("returns the input messages for an empty contribution list", async () => {
    const messages: PiAgentMessage[] = [{ role: "user", content: "hi" }];
    const handler = buildPiContextHandler([], runtime);
    const result = await handler({ type: "context", messages }, SESSION_CTX);
    assert.deepEqual(result, { messages });
  });

  it("yields empty messages for an empty message array", async () => {
    const handler = buildPiContextHandler([], runtime);
    const result = await handler(
      { type: "context", messages: [] },
      SESSION_CTX,
    );
    assert.deepEqual(result, { messages: [] });
  });

  it("isolates a throwing transform contribution and still runs later ones", async () => {
    let captured: TransformOutput | undefined;
    const handler = buildPiContextHandler(
      [
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
      ],
      runtime,
    );
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
// buildPiMessageEndHandler
// ---------------------------------------------------------------------------

function messageEndEvent(message: PiAgentMessage) {
  return { type: "message_end" as const, message };
}

describe("buildPiMessageEndHandler", () => {
  const stripContrib = [createReplyStripHandler()];

  it("strips a leading [mN] ref echo from assistant text", () => {
    const handler = buildPiMessageEndHandler(stripContrib);
    const message = assistantMessage([{ type: "text", text: "[m3] hello" }]);
    const result = handler(messageEndEvent(message), {});
    assert.ok(result);
    assert.equal(result?.message?.role, "assistant");
    assert.deepEqual(result?.message?.content, [
      { type: "text", text: "hello" },
    ]);
  });

  it("strips multiple leading [mN] ref echoes", () => {
    const handler = buildPiMessageEndHandler(stripContrib);
    const message = assistantMessage([
      { type: "text", text: "[m1] [m2] body" },
    ]);
    const result = handler(messageEndEvent(message), {});
    assert.ok(result);
    assert.equal(result?.message?.role, "assistant");
    assert.deepEqual(result?.message?.content, [
      { type: "text", text: "body" },
    ]);
  });

  it("preserves a mid-text [mN] occurrence", () => {
    const handler = buildPiMessageEndHandler(stripContrib);
    const message = assistantMessage([{ type: "text", text: "see [m3] here" }]);
    const result = handler(messageEndEvent(message), {});
    assert.equal(result, undefined);
  });

  it("leaves non-assistant messages untouched", () => {
    const handler = buildPiMessageEndHandler(stripContrib);
    const message: PiAgentMessage = { role: "user", content: "[m3] hi" };
    const result = handler(messageEndEvent(message), {});
    assert.equal(result, undefined);
  });

  it("returns undefined when the message is unchanged", () => {
    const handler = buildPiMessageEndHandler(stripContrib);
    const message = assistantMessage([{ type: "text", text: "plain" }]);
    const result = handler(messageEndEvent(message), {});
    assert.equal(result, undefined);
  });

  it("does not mutate the input message", () => {
    const handler = buildPiMessageEndHandler(stripContrib);
    const content = [{ type: "text" as const, text: "[m3] hello" }];
    const message = assistantMessage(content);
    handler(messageEndEvent(message), {});
    assert.deepEqual(content, [{ type: "text", text: "[m3] hello" }]);
    assert.deepEqual(message.content, [{ type: "text", text: "[m3] hello" }]);
  });

  it("leaves thinking and toolCall blocks untouched", () => {
    const handler = buildPiMessageEndHandler(stripContrib);
    const message = assistantMessage([
      { type: "thinking", thinking: "[m3] thought" },
      { type: "toolCall", id: "c1", name: "x", arguments: {} },
      { type: "text", text: "[m4] ok" },
    ]);
    const result = handler(messageEndEvent(message), {});
    assert.ok(result);
    assert.equal(result?.message?.role, "assistant");
    assert.deepEqual(result?.message?.content, [
      { type: "thinking", thinking: "[m3] thought" },
      { type: "toolCall", id: "c1", name: "x", arguments: {} },
      { type: "text", text: "ok" },
    ]);
  });

  it("runs multiple contributions in registration order", () => {
    const calls: string[] = [];
    const contribs = [
      {
        name: "first",
        handle: (
          _i: { sessionID: string; messageID: string; partID: string },
          o: { text: string },
        ) => {
          calls.push("first");
          o.text += "!";
        },
      },
      {
        name: "second",
        handle: (
          _i: { sessionID: string; messageID: string; partID: string },
          o: { text: string },
        ) => {
          calls.push("second");
          o.text += "?";
        },
      },
    ];
    const handler = buildPiMessageEndHandler(contribs);
    const result = handler(
      messageEndEvent(assistantMessage([{ type: "text", text: "hi" }])),
      {},
    );
    assert.deepEqual(calls, ["first", "second"]);
    assert.ok(result);
    assert.equal(result?.message?.role, "assistant");
    assert.deepEqual(result?.message?.content, [
      { type: "text", text: "hi!?" },
    ]);
  });

  it("isolates a throwing text-finalization contribution and still runs later ones", () => {
    const calls: string[] = [];
    const handler = buildPiMessageEndHandler([
      {
        name: "boom",
        handle: () => {
          throw new Error("strip boom");
        },
      },
      {
        name: "capture",
        handle: (_input, output) => {
          calls.push("capture");
          output.text = output.text.toUpperCase();
        },
      },
    ]);

    const result = handler(
      messageEndEvent(assistantMessage([{ type: "text", text: "hi" }])),
      {},
    );

    assert.deepEqual(calls, ["capture"]);
    assert.ok(result);
    assert.equal(result?.message?.role, "assistant");
    assert.deepEqual(result?.message?.content, [{ type: "text", text: "HI" }]);
    const crashed = crashedEntries();
    assert.equal(crashed.length, 1);
    assert.equal(crashed[0].handler, "boom");
    assert.equal(crashed[0].sessionId, "");
    assert.equal(crashed[0].callId, "0");
    assert.equal(crashed[0].error, "Error: strip boom");
  });

  it("returns undefined for any input when no contributions are supplied", () => {
    const handler = buildPiMessageEndHandler([]);
    const assistant = handler(
      messageEndEvent(assistantMessage([{ type: "text", text: "[m3] hi" }])),
      {},
    );
    assert.equal(assistant, undefined);
    const user = handler(
      messageEndEvent({ role: "user", content: "[m3] hi" }),
      {},
    );
    assert.equal(user, undefined);
  });
});
