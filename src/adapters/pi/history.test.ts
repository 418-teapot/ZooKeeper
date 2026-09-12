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
import type { HostMessage, TextRegion } from "../../core/context/lens.js";
import { makeMsg } from "../../core/context/lens-testkit.js";
import { estimateMessageHeuristic } from "../../core/context/measure.js";
import {
  PRUNED_TOOL_ERROR_INPUT_REPLACEMENT,
  PRUNED_TOOL_OUTPUT_REPLACEMENT,
} from "../../core/context/message-parts.js";
import { history, isInjectableRegion, type WritableRegion } from "./history.js";
import type {
  PiAgentMessage,
  PiAssistantMessage,
  PiBashExecutionMessage,
  PiBranchSummaryMessage,
  PiCompactionSummaryMessage,
  PiContentPart,
  PiCustomMessage,
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

function compactionSummaryMessage(
  summary: string,
  tokensBefore = 100,
): PiCompactionSummaryMessage {
  return { role: "compactionSummary", summary, tokensBefore, timestamp: 1 };
}

function branchSummaryMessage(summary: string): PiBranchSummaryMessage {
  return { role: "branchSummary", summary, fromId: "abc123", timestamp: 1 };
}

function bashExecutionMessage(
  command: string,
  output: string,
): PiBashExecutionMessage {
  return {
    role: "bashExecution",
    command,
    output,
    exitCode: 0,
    cancelled: false,
    truncated: false,
    timestamp: 1,
  };
}

function customMessage(content: string | PiContentPart[]): PiCustomMessage {
  return {
    role: "custom",
    customType: "my-ext",
    content,
    display: true,
    timestamp: 1,
  };
}

function regionsOf(message: PiAgentMessage): TextRegion[] {
  return messagesOf([message])[0].regions;
}

/**
 * The region view of a pi transcript (most tests here ignore the
 * invocation table; pairing is pinned in "tool pair status and
 * linkage").
 */
function messagesOf(piMessages: PiAgentMessage[]): HostMessage[] {
  return history(piMessages).messages;
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

  it("toolCall block maps to a tool-input region, name on the table", () => {
    const snapshot = history([
      assistantMessage([toolCallPart("call-1", "bash", { cmd: "ls" })]),
    ]);
    const [region] = snapshot.messages[0].regions;
    assert.equal(region.kind, "tool-input");
    assert.equal(region.get(), '{"cmd":"ls"}');
    assert.equal(snapshot.invocations[0].name, "bash");
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
    const [msg] = messagesOf([
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
  });

  it("toolResult ignores image blocks when joining text", () => {
    const [region] = regionsOf(
      toolResultMessage("call-1", "bash", [textPart("text"), imagePart()]),
    );
    assert.equal(region.get(), "text");
  });

  it("every message is visible (hidden is always false)", () => {
    assert.equal(messagesOf([userMessage("x")])[0].hidden, false);
    assert.equal(
      messagesOf([assistantMessage([textPart("x")])])[0].hidden,
      false,
    );
    assert.equal(
      messagesOf([toolResultMessage("c", "t", [textPart("x")])])[0].hidden,
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

  it("compactionSummary maps its summary text to a content region", () => {
    const [msg] = messagesOf([compactionSummaryMessage("## done\n3 files")]);
    assert.equal(msg.role, "compactionSummary");
    assert.equal(msg.regions.length, 1);
    assert.equal(msg.regions[0].kind, "content");
    assert.equal(msg.regions[0].get(), "## done\n3 files");
  });

  it("compactionSummary is marked as the host compaction boundary", () => {
    const [msg] = messagesOf([compactionSummaryMessage("s")]);
    assert.equal(msg.compaction, true);
  });

  it("branchSummary is counted but is not a compaction boundary", () => {
    const [msg] = messagesOf([branchSummaryMessage("branch text")]);
    assert.equal(msg.regions[0].get(), "branch text");
    assert.equal(msg.compaction, undefined);
  });

  it("an empty compactionSummary yields no regions", () => {
    assert.deepEqual(regionsOf(compactionSummaryMessage("")), []);
  });

  it("a summary message with no summary field yields no regions", () => {
    const broken = {
      role: "compactionSummary",
      tokensBefore: 5,
    } as unknown as PiCompactionSummaryMessage;
    assert.deepEqual(regionsOf(broken), []);
  });

  it("custom content maps like a user message", () => {
    const [strMsg] = messagesOf([customMessage("extension text")]);
    assert.equal(strMsg.role, "custom");
    assert.equal(strMsg.regions[0].get(), "extension text");
    const regions = regionsOf(
      customMessage([textPart("a"), imagePart(), textPart("b")]),
    );
    assert.deepEqual(
      regions.map((r) => r.get()),
      ["a", "", "b"],
    );
  });

  it("bashExecution projects no region (its text is host-derived)", () => {
    const [msg] = messagesOf([bashExecutionMessage("ls", "file")]);
    assert.equal(msg.role, "bashExecution");
    assert.deepEqual(msg.regions, []);
    assert.equal(msg.hidden, false);
  });

  it("an undeclared role projects the minimal safe shape", () => {
    const alien = {
      role: "brandNewRole",
      payload: "opaque",
    } as unknown as PiAgentMessage;
    const [msg] = messagesOf([alien]);
    assert.equal(msg.role, "brandNewRole");
    assert.deepEqual(msg.regions, []);
  });

  it("an entry that is not a shaped message projects hidden with no region", () => {
    const messages = [
      userMessage("hi"),
      null,
      undefined,
    ] as unknown as PiAgentMessage[];
    const snapshot = history(messages);
    assert.equal(snapshot.messages.length, 3);
    assert.equal(snapshot.messages[1].hidden, true);
    assert.deepEqual(snapshot.messages[1].regions, []);
    assert.equal(snapshot.messages[2].hidden, true);
  });
});

// ---------------------------------------------------------------------------
// Tool pair linkage (the invocation table)
// ---------------------------------------------------------------------------

describe("tool pair status and linkage", () => {
  it("errored pair surfaces error status on the invocation entry", () => {
    const messages: PiAgentMessage[] = [
      userMessage("do it"),
      assistantMessage([toolCallPart("call-1", "bash", { cmd: "ls" })]),
      toolResultMessage("call-1", "bash", [textPart("boom")], true),
    ];
    const snapshot = history(messages);
    assert.deepEqual(snapshot.invocations, [
      {
        name: "bash",
        status: "error",
        input: { ordinal: 1, regionIndex: 0 },
        output: { ordinal: 2, regionIndex: 0 },
      },
    ]);
    // Regions are a pure text lens: no pairing travels on them.
    const input = snapshot.messages[1].regions[0];
    const output = snapshot.messages[2].regions[0];
    assert.equal(input.kind, "tool-input");
    assert.equal(output.kind, "tool-output");
  });

  it("clean pair surfaces completed status and the linked output address", () => {
    const messages: PiAgentMessage[] = [
      userMessage("do it"),
      assistantMessage([toolCallPart("call-1", "bash", { cmd: "ls" })]),
      toolResultMessage("call-1", "bash", [textPart("total 12")]),
    ];
    const snapshot = history(messages);
    const invocation = snapshot.invocations[0];
    assert.equal(invocation.status, "completed");
    assert.deepEqual(invocation.input, { ordinal: 1, regionIndex: 0 });
    assert.deepEqual(invocation.output, { ordinal: 2, regionIndex: 0 });
    // The reverse index resolves both halves to the same entry.
    assert.equal(snapshot.byRegion.get("1:0"), invocation);
    assert.equal(snapshot.byRegion.get("2:0"), invocation);
  });

  it("unlinked toolCall carries neither status nor output half", () => {
    const snapshot = history([
      assistantMessage([toolCallPart("call-1", "bash", { cmd: "ls" })]),
    ]);
    assert.deepEqual(snapshot.invocations, [
      {
        name: "bash",
        input: { ordinal: 0, regionIndex: 0 },
      },
    ]);
    assert.equal(snapshot.invocations[0].status, undefined);
    assert.equal(snapshot.invocations[0].output, undefined);
  });

  it("orphan toolResult message is not paired at all (fail-closed)", () => {
    const snapshot = history([
      toolResultMessage("call-1", "bash", [textPart("boom")], true),
    ]);
    assert.deepEqual(snapshot.invocations, []);
    assert.equal(snapshot.byRegion.size, 0);
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
    const snapshot = history(messages);
    assert.deepEqual(
      snapshot.invocations.map((invocation) => [
        invocation.name,
        invocation.status,
        invocation.input,
        invocation.output,
      ]),
      [
        [
          "bash",
          "completed",
          { ordinal: 0, regionIndex: 0 },
          { ordinal: 1, regionIndex: 0 },
        ],
        [
          "read",
          "error",
          { ordinal: 0, regionIndex: 1 },
          { ordinal: 2, regionIndex: 0 },
        ],
      ],
    );

    // Each output half addresses a real tool-output region.
    for (const invocation of snapshot.invocations) {
      const output = invocation.output;
      assert.ok(output);
      const region =
        snapshot.messages[output?.ordinal].regions[output?.regionIndex];
      assert.equal(region.kind, "tool-output");
    }
  });
});

// ---------------------------------------------------------------------------
// Summary and non-LLM roles (post-compaction transcript regression)
// ---------------------------------------------------------------------------

/**
 * pi's `context` event delivers the whole `AgentMessage` list, which after
 * an automatic compaction also contains roles without a `content` field.
 * The projection must route every unrecognised role safely: the
 * toolResult mapping reads `message.content.length`, so a role without a
 * `content` field must not reach it, or the pruning handler crashes for
 * the rest of the session.  These tests pin that the projection is a
 * total function over host message shapes.
 */
function postCompactionTranscript(): PiAgentMessage[] {
  return [
    compactionSummaryMessage("compact summary text", 40000),
    userMessage("continue"),
    branchSummaryMessage("branch summary text"),
    bashExecutionMessage("ls", "a.ts"),
    customMessage("extension note"),
    assistantMessage([toolCallPart("call-1", "bash", { cmd: "ls" })]),
    toolResultMessage("call-1", "bash", [textPart("a.ts")]),
  ];
}

describe("summary and non-LLM roles", () => {
  it("a transcript containing compactionSummary projects without throwing", () => {
    assert.doesNotThrow(() => history(postCompactionTranscript()));
  });

  it("every input message occupies exactly one ordinal", () => {
    const messages = postCompactionTranscript();
    const snapshot = history(messages);
    assert.equal(snapshot.messages.length, messages.length);
    assert.deepEqual(
      snapshot.messages.map((m) => m.role),
      messages.map((m) => m.role),
    );
  });

  it("summary text is counted by estimation and marked as the boundary", () => {
    const snapshot = history(postCompactionTranscript());
    const summary = snapshot.messages[0];
    assert.equal(summary.compaction, true);
    assert.ok(estimateMessageHeuristic(summary) > 0);
    // A branch summary is counted too, but is not a boundary.
    const branch = snapshot.messages[2];
    assert.equal(branch.compaction, undefined);
    assert.ok(estimateMessageHeuristic(branch) > 0);
  });

  it("tool pairing addresses the result across summary messages", () => {
    const snapshot = history(postCompactionTranscript());
    assert.deepEqual(snapshot.invocations, [
      {
        name: "bash",
        status: "completed",
        input: { ordinal: 5, regionIndex: 0 },
        output: { ordinal: 6, regionIndex: 0 },
      },
    ]);
  });

  it("unknown-role and non-message entries still hold their ordinals", () => {
    const alien = { role: "brandNewRole" } as unknown as PiAgentMessage;
    const messages = [userMessage("a"), alien, bashExecutionMessage("ls", "o")];
    const snapshot = history(messages);
    assert.equal(snapshot.messages.length, 3);
    assert.equal(snapshot.messages[1].regions.length, 0);
    assert.equal(snapshot.messages[2].regions.length, 0);
  });
});

// ---------------------------------------------------------------------------
// Region write-back
// ---------------------------------------------------------------------------

describe("pi region write-back", () => {
  it("content region set rewrites an assistant text block", () => {
    const message = assistantMessage([textPart("before")]);
    const region = messagesOf([message])[0].regions[0];
    (region as WritableRegion).set("after");
    assert.equal((message.content[0] as { text: string }).text, "after");
  });

  it("content region set rewrites a user string content", () => {
    const message = userMessage("before");
    const region = messagesOf([message])[0].regions[0];
    (region as WritableRegion).set("after");
    assert.equal(message.content, "after");
  });

  it("content region set replaces an image block with a text block", () => {
    const message = userMessage([imagePart()]);
    const region = messagesOf([message])[0].regions[0];
    (region as WritableRegion).set("image caption");
    assert.deepEqual(message.content, [
      { type: "text", text: "image caption" },
    ]);
  });

  it("tool-output region set rewrites the first text part", () => {
    const message = toolResultMessage("call-1", "bash", [textPart("before")]);
    const region = messagesOf([message])[0].regions[0];
    (region as WritableRegion).set(PRUNED_TOOL_OUTPUT_REPLACEMENT);
    assert.equal(
      (message.content[0] as { text: string }).text,
      PRUNED_TOOL_OUTPUT_REPLACEMENT,
    );
  });

  it("tool-output region set creates a text part when none exists", () => {
    const message = toolResultMessage("call-1", "bash", [imagePart()]);
    const region = messagesOf([message])[0].regions[0];
    (region as WritableRegion).set(PRUNED_TOOL_OUTPUT_REPLACEMENT);
    assert.deepEqual(message.content, [
      { type: "text", text: PRUNED_TOOL_OUTPUT_REPLACEMENT },
    ]);
  });

  it("tool-input region set parses a JSON object back into arguments", () => {
    const message = assistantMessage([
      toolCallPart("call-1", "bash", { cmd: "ls" }),
    ]);
    const region = messagesOf([message])[0].regions[0];
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
    const region = messagesOf([message])[0].regions[0];
    (region as WritableRegion).set(PRUNED_TOOL_ERROR_INPUT_REPLACEMENT);
    assert.deepEqual(
      (message.content[0] as { arguments: Record<string, unknown> }).arguments,
      { pruned: PRUNED_TOOL_ERROR_INPUT_REPLACEMENT },
    );
  });

  it("summary region set rewrites the backing summary field", () => {
    const message = compactionSummaryMessage("original summary");
    const region = messagesOf([message])[0].regions[0];
    (region as WritableRegion).set("replaced");
    assert.equal(message.summary, "replaced");
    // The region reads live, so a later projection pass sees the edit.
    assert.equal(region.get(), "replaced");
  });

  it("custom content region set rewrites the message content", () => {
    const message = customMessage("extension text");
    const region = messagesOf([message])[0].regions[0];
    (region as WritableRegion).set("[pruned]");
    assert.equal(message.content, "[pruned]");
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

  it("host summary regions are not injectable", () => {
    const [compaction] = regionsOf(compactionSummaryMessage("summary text"));
    assert.equal(isInjectableRegion(compaction), false);
    const [branch] = regionsOf(branchSummaryMessage("branch text"));
    assert.equal(isInjectableRegion(branch), false);
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
