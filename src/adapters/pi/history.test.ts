/**
 * Tests for the pi message → lens mapping adapter (`history.ts`).
 *
 * Layers:
 * 1. Mapping table — every pi block type maps to the expected region kind,
 *    message-level fields (`role`, `usage`) map to the lens fields, and
 *    edge shapes (empty content, images, null/undefined tool arguments) are
 *    covered.
 * 2. Tool pair linkage — a `toolCall` block resolves its linked
 *    `toolResult` message by call id: the tool-input region's metadata
 *    carries the core status (`"error"` for failed results, `"completed"`
 *    for clean ones) and the positional address of the result's
 *    tool-output region; unlinked calls carry neither.
 * 3. Region write-back — the adapter's regions mutate the backing pi
 *    message in place, including tool arguments parsed back to an object or
 *    wrapped in `{ pruned }` when they do not parse.
 * 4. Injection provenance — `isInjectableRegion` marks exactly the
 *    text-derived content regions and tool-output regions; images, thinking,
 *    and tool inputs are never targets.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { TextRegion } from "../../core/context/lens.js";
import { makeMsg } from "../../core/context/lens-testkit.js";
import {
  PRUNED_TOOL_ERROR_INPUT_REPLACEMENT,
  PRUNED_TOOL_OUTPUT_REPLACEMENT,
} from "../../core/context/message-parts.js";
import { history, isInjectableRegion, type WritableRegion } from "./history.js";
import type {
  PiAgentMessage,
  PiAssistantMessage,
  PiToolCallPart,
  PiToolResultMessage,
  PiUserMessage,
} from "./types.js";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function textPart(text: string): { type: "text"; text: string } {
  return { type: "text", text };
}

function imagePart(
  data = "base64",
  mimeType = "image/png",
): { type: "image"; data: string; mimeType: string } {
  return { type: "image", data, mimeType };
}

function thinkingPart(thinking: string): {
  type: "thinking";
  thinking: string;
} {
  return { type: "thinking", thinking };
}

function toolCallPart(
  id: string,
  name: string,
  args: Record<string, unknown>,
): PiToolCallPart {
  return { type: "toolCall", id, name, arguments: args };
}

function userMessage(content: PiUserMessage["content"]): PiUserMessage {
  return { role: "user", content };
}

function assistantMessage(
  content: PiAssistantMessage["content"],
  usage?: PiAssistantMessage["usage"],
): PiAssistantMessage {
  return { role: "assistant", content, usage };
}

function toolResultMessage(
  toolCallId: string,
  toolName: string,
  content: PiToolResultMessage["content"],
  isError = false,
): PiToolResultMessage {
  return { role: "toolResult", toolCallId, toolName, content, isError };
}

function regionsOf(message: PiAgentMessage) {
  return history([message])[0].regions;
}

// ---------------------------------------------------------------------------
// Mapping table
// ---------------------------------------------------------------------------

describe("pi block → region mapping", () => {
  it("user string content maps to a content region", () => {
    const [region] = regionsOf(userMessage("hello"));
    assert.equal(region.kind, "content");
    assert.equal(region.get(), "hello");
  });

  it("empty user string content yields no regions", () => {
    assert.deepEqual(regionsOf(userMessage("")), []);
  });

  it("user array content preserves text block order", () => {
    const regions = regionsOf(
      userMessage([textPart("a"), textPart("b"), textPart("c")]),
    );
    assert.deepEqual(
      regions.map((r) => r.kind),
      ["content", "content", "content"],
    );
    assert.deepEqual(
      regions.map((r) => r.get()),
      ["a", "b", "c"],
    );
  });

  it("image block maps to a content region with empty text", () => {
    const [region] = regionsOf(userMessage([imagePart()]));
    assert.equal(region.kind, "content");
    assert.equal(region.get(), "");
  });

  it("mixed user text and image blocks each become a content region", () => {
    const regions = regionsOf(
      userMessage([textPart("a"), imagePart(), textPart("b")]),
    );
    assert.equal(regions.length, 3);
    assert.deepEqual(
      regions.map((r) => r.get()),
      ["a", "", "b"],
    );
  });

  it("assistant text block maps to a content region", () => {
    const [region] = regionsOf(assistantMessage([textPart("hi")]));
    assert.equal(region.kind, "content");
    assert.equal(region.get(), "hi");
  });

  it("thinking block maps to a thinking region", () => {
    const [region] = regionsOf(assistantMessage([thinkingPart("trace")]));
    assert.equal(region.kind, "thinking");
    assert.equal(region.get(), "trace");
  });

  it("toolCall block maps to a tool-input region with tool name", () => {
    const [region] = regionsOf(
      assistantMessage([toolCallPart("call-1", "bash", { cmd: "ls" })]),
    );
    assert.equal(region.kind, "tool-input");
    assert.equal(region.get(), '{"cmd":"ls"}');
    assert.equal(region.tool?.name, "bash");
  });

  it("toolCall with null/undefined arguments maps to empty string", () => {
    const nullCall = {
      type: "toolCall",
      id: "call-1",
      name: "bash",
      arguments: null,
    } as unknown as PiToolCallPart;
    const [nullRegion] = regionsOf(assistantMessage([nullCall]));
    assert.equal(nullRegion.get(), "");
    const undefCall = {
      type: "toolCall",
      id: "call-1",
      name: "bash",
      arguments: undefined,
    } as unknown as PiToolCallPart;
    const [undefRegion] = regionsOf(assistantMessage([undefCall]));
    assert.equal(undefRegion.get(), "");
  });

  it("assistant usage maps flat to TokenUsage", () => {
    const [msg] = history([
      assistantMessage([textPart("ok")], {
        input: 10,
        output: 20,
        reasoning: 5,
        cacheRead: 30,
        cacheWrite: 40,
      }),
    ]);
    assert.deepEqual(msg.usage, {
      input: 10,
      output: 20,
      reasoning: 5,
      cacheRead: 30,
      cacheWrite: 40,
    });
  });

  it("toolResult maps to a tool-output region with joined text", () => {
    const [region] = regionsOf(
      toolResultMessage("call-1", "bash", [
        textPart("line1"),
        textPart("line2"),
      ]),
    );
    assert.equal(region.kind, "tool-output");
    assert.equal(region.get(), "line1line2");
    assert.equal(region.tool?.name, "bash");
  });

  it("toolResult ignores image blocks when joining text", () => {
    const [region] = regionsOf(
      toolResultMessage("call-1", "bash", [textPart("text"), imagePart()]),
    );
    assert.equal(region.get(), "text");
  });

  it("every message is visible (hidden is always false)", () => {
    assert.equal(history([userMessage("x")])[0].hidden, false);
    assert.equal(history([assistantMessage([textPart("x")])])[0].hidden, false);
    assert.equal(
      history([toolResultMessage("c", "t", [textPart("x")])])[0].hidden,
      false,
    );
  });

  it("multi-block assistant message preserves block order", () => {
    const regions = regionsOf(
      assistantMessage([
        textPart("answer"),
        thinkingPart("trace"),
        toolCallPart("call-1", "read", { path: "a.ts" }),
      ]),
    );
    assert.deepEqual(
      regions.map((r) => r.kind),
      ["content", "thinking", "tool-input"],
    );
    assert.equal(regions[0].get(), "answer");
    assert.equal(regions[1].get(), "trace");
    assert.equal(regions[2].get(), '{"path":"a.ts"}');
  });
});

// ---------------------------------------------------------------------------
// Tool pair linkage (status + output address)
// ---------------------------------------------------------------------------

describe("tool pair status and linkage", () => {
  it("errored pair surfaces error status on both halves", () => {
    const messages: PiAgentMessage[] = [
      userMessage("do it"),
      assistantMessage([toolCallPart("call-1", "bash", { cmd: "ls" })]),
      toolResultMessage("call-1", "bash", [textPart("boom")], true),
    ];
    const mapped = history(messages);
    const input = mapped[1].regions[0];
    const output = mapped[2].regions[0];
    assert.equal(input.kind, "tool-input");
    assert.equal(input.tool?.name, "bash");
    assert.equal(input.tool?.status, "error");
    assert.deepEqual(input.tool?.output, { ordinal: 2, regionIndex: 0 });
    assert.equal(output.kind, "tool-output");
    assert.equal(output.tool?.name, "bash");
    assert.equal(output.tool?.status, "error");
  });

  it("clean pair surfaces completed status and the linked output address", () => {
    const messages: PiAgentMessage[] = [
      userMessage("do it"),
      assistantMessage([toolCallPart("call-1", "bash", { cmd: "ls" })]),
      toolResultMessage("call-1", "bash", [textPart("total 12")]),
    ];
    const mapped = history(messages);
    const input = mapped[1].regions[0];
    const output = mapped[2].regions[0];
    assert.equal(input.tool?.status, "completed");
    assert.deepEqual(input.tool?.output, { ordinal: 2, regionIndex: 0 });
    assert.equal(output.tool?.status, "completed");
  });

  it("unlinked toolCall carries neither status nor output address", () => {
    const [msg] = history([
      assistantMessage([toolCallPart("call-1", "bash", { cmd: "ls" })]),
    ]);
    const input = msg.regions[0];
    assert.equal(input.tool?.name, "bash");
    assert.equal(input.tool?.status, undefined);
    assert.equal(input.tool?.output, undefined);
  });

  it("each call links to its own toolResult across interleaved pairs", () => {
    const messages: PiAgentMessage[] = [
      assistantMessage([
        toolCallPart("c1", "bash", { cmd: "ls" }),
        toolCallPart("c2", "read", { path: "a.ts" }),
      ]),
      toolResultMessage("c1", "bash", [textPart("out1")]),
      toolResultMessage("c2", "read", [textPart("out2")], true),
    ];
    const mapped = history(messages);
    const inputs = mapped[0].regions;
    assert.deepEqual(inputs[0].tool?.output, { ordinal: 1, regionIndex: 0 });
    assert.deepEqual(inputs[1].tool?.output, { ordinal: 2, regionIndex: 0 });
    assert.equal(inputs[0].tool?.status, "completed");
    assert.equal(inputs[1].tool?.status, "error");

    // The pair linkage resolves to the sibling tool-output region.
    for (const input of inputs) {
      const ref = input.tool?.output;
      assert.ok(ref);
      const sibling = mapped[ref.ordinal].regions[ref.regionIndex ?? -1];
      assert.equal(sibling.kind, "tool-output");
      assert.equal(sibling.tool?.name, input.tool?.name);
    }
  });
});

// ---------------------------------------------------------------------------
// Region write-back
// ---------------------------------------------------------------------------

describe("pi region write-back", () => {
  it("content region set rewrites an assistant text block", () => {
    const message = assistantMessage([textPart("before")]);
    const region = history([message])[0].regions[0];
    (region as WritableRegion).set("after");
    assert.equal((message.content[0] as { text: string }).text, "after");
  });

  it("content region set rewrites a user string content", () => {
    const message = userMessage("before");
    const region = history([message])[0].regions[0];
    (region as WritableRegion).set("after");
    assert.equal(message.content, "after");
  });

  it("content region set replaces an image block with a text block", () => {
    const message = userMessage([imagePart()]);
    const region = history([message])[0].regions[0];
    (region as WritableRegion).set("image caption");
    assert.deepEqual(message.content, [
      { type: "text", text: "image caption" },
    ]);
  });

  it("tool-output region set rewrites the first text part", () => {
    const message = toolResultMessage("call-1", "bash", [textPart("before")]);
    const region = history([message])[0].regions[0];
    (region as WritableRegion).set(PRUNED_TOOL_OUTPUT_REPLACEMENT);
    assert.equal(
      (message.content[0] as { text: string }).text,
      PRUNED_TOOL_OUTPUT_REPLACEMENT,
    );
  });

  it("tool-output region set creates a text part when none exists", () => {
    const message = toolResultMessage("call-1", "bash", [imagePart()]);
    const region = history([message])[0].regions[0];
    (region as WritableRegion).set(PRUNED_TOOL_OUTPUT_REPLACEMENT);
    assert.deepEqual(message.content, [
      { type: "text", text: PRUNED_TOOL_OUTPUT_REPLACEMENT },
    ]);
  });

  it("tool-input region set parses a JSON object back into arguments", () => {
    const message = assistantMessage([
      toolCallPart("call-1", "bash", { cmd: "ls" }),
    ]);
    const region = history([message])[0].regions[0];
    (region as WritableRegion).set('{"cmd":"pwd"}');
    assert.deepEqual(
      (message.content[0] as { arguments: Record<string, unknown> }).arguments,
      { cmd: "pwd" },
    );
  });

  it("tool-input region set wraps non-parsing text in a pruned object", () => {
    const message = assistantMessage([
      toolCallPart("call-1", "bash", { cmd: "ls" }),
    ]);
    const region = history([message])[0].regions[0];
    (region as WritableRegion).set(PRUNED_TOOL_ERROR_INPUT_REPLACEMENT);
    assert.deepEqual(
      (message.content[0] as { arguments: Record<string, unknown> }).arguments,
      { pruned: PRUNED_TOOL_ERROR_INPUT_REPLACEMENT },
    );
  });
});

// ---------------------------------------------------------------------------
// Injection provenance
// ---------------------------------------------------------------------------

describe("isInjectableRegion", () => {
  it("text-derived content regions are injectable", () => {
    const [region] = regionsOf(userMessage([textPart("hi")]));
    assert.equal(isInjectableRegion(region), true);
  });

  it("image-derived content regions are not injectable", () => {
    const [region] = regionsOf(userMessage([imagePart()]));
    assert.equal(isInjectableRegion(region), false);
  });

  it("thinking regions are not injectable", () => {
    const [region] = regionsOf(assistantMessage([thinkingPart("x")]));
    assert.equal(isInjectableRegion(region), false);
  });

  it("tool-input regions are not injectable", () => {
    const [region] = regionsOf(
      assistantMessage([toolCallPart("call-1", "bash", { cmd: "ls" })]),
    );
    assert.equal(isInjectableRegion(region), false);
  });

  it("tool-output regions are injectable", () => {
    const [region] = regionsOf(
      toolResultMessage("call-1", "bash", [textPart("out")]),
    );
    assert.equal(isInjectableRegion(region), true);
  });

  it("regions from other adapters are not injectable", () => {
    const foreign = makeMsg("user", ["hi"]).regions[0];
    assert.equal(isInjectableRegion(foreign), false);
  });

  it("nullish input is not injectable", () => {
    assert.equal(isInjectableRegion(null as unknown as TextRegion), false);
    assert.equal(isInjectableRegion(undefined as unknown as TextRegion), false);
  });
});
