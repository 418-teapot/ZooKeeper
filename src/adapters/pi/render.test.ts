/**
 * Tests for the pi render adapter (`render.ts`).
 *
 * Coverage:
 * - each block kind maps through `history` and renders back correctly;
 * - `RegionEdit`s are applied to the right region and unresolvable anchors
 *   are skipped;
 * - line-number prefixes are injected only on injectable regions;
 * - folded blocks materialize as synthetic user messages with the correct
 *   label and prefix format;
 * - tool-call / tool-result linkage is preserved when a summary covers only
 *   one half of a pair (whole-message fold semantics);
 * - the input array and every input message object are left untouched.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { RegionEdit, ViewItem } from "../../core/context/lens.js";
import { computeSpanHash } from "../../core/context/spanhash.js";
import type { SessionState } from "../../core/context/state.js";
import { history } from "./history.js";
import { materializeSummary, render } from "./render.js";
import type {
  PiAgentMessage,
  PiAssistantMessage,
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
): {
  type: "toolCall";
  id: string;
  name: string;
  arguments: Record<string, unknown>;
} {
  return { type: "toolCall", id, name, arguments: args };
}

function userMessage(content: PiUserMessage["content"]): PiUserMessage {
  return { role: "user", content };
}

function assistantMessage(
  content: PiAssistantMessage["content"],
): PiAssistantMessage {
  return { role: "assistant", content };
}

function toolResultMessage(
  toolCallId: string,
  toolName: string,
  content: PiToolResultMessage["content"],
): PiToolResultMessage {
  return { role: "toolResult", toolCallId, toolName, content, isError: false };
}

function makeState(): SessionState {
  return { blocks: new Map(), marks: new Map() };
}

function seedBlock(
  state: SessionState,
  messages: PiAgentMessage[],
  id: number,
  start: number,
  end: number,
  title: string,
  summary: string,
): void {
  state.blocks.set(id, {
    start,
    end,
    title,
    summary,
    spanHash: computeSpanHash(history(messages), start, end),
    active: true,
    compressedTokens: 100,
    summaryTokens: 10,
    createdAt: 1000,
  });
}

// ---------------------------------------------------------------------------
// Render output
// ---------------------------------------------------------------------------

describe("pi render", () => {
  it("injects line refs on text content and tool-output only", () => {
    const messages: PiAgentMessage[] = [
      userMessage("question"),
      assistantMessage([textPart("answer"), thinkingPart("trace")]),
      assistantMessage([toolCallPart("call-1", "bash", { cmd: "ls" })]),
      toolResultMessage("call-1", "bash", [textPart("output")]),
      userMessage([imagePart()]),
      userMessage("follow-up"),
    ];
    const state = makeState();
    const items: ViewItem[] = messages.map((_, ordinal) => ({
      type: "original",
      ordinal,
    }));

    const out = render(messages, items, [], state);

    assert.equal((out[0] as PiUserMessage).content, "[m1] question");
    assert.equal(
      ((out[1] as PiAssistantMessage).content[0] as { text: string }).text,
      "[m2] answer",
    );
    assert.equal(
      ((out[1] as PiAssistantMessage).content[1] as { thinking: string })
        .thinking,
      "trace",
    );
    // Tool-call arguments are not injection targets.
    assert.deepEqual(
      (
        (out[2] as PiAssistantMessage).content[0] as {
          arguments: Record<string, unknown>;
        }
      ).arguments,
      { cmd: "ls" },
    );
    assert.equal(
      ((out[3] as PiToolResultMessage).content[0] as { text: string }).text,
      "[m4] output",
    );
    // Image message keeps its image part and receives no prefix, but still
    // occupies a visible line.
    assert.deepEqual((out[4] as PiUserMessage).content, [imagePart()]);
    assert.equal((out[5] as PiUserMessage).content, "[m6] follow-up");
  });

  it("applies edits and skips unresolvable anchors", () => {
    const messages: PiAgentMessage[] = [
      userMessage("question"),
      assistantMessage([textPart("answer")]),
    ];
    const state = makeState();
    const items: ViewItem[] = messages.map((_, ordinal) => ({
      type: "original",
      ordinal,
    }));
    const edits: RegionEdit[] = [
      { messageOrdinal: 1, regionIndex: 0, text: "edited answer" },
      { messageOrdinal: 9, regionIndex: 0, text: "vanished message" },
      { messageOrdinal: 1, regionIndex: 5, text: "bad region" },
      { messageOrdinal: 0, text: "missing region index" },
    ];

    const out = render(messages, items, edits, state);

    assert.equal((out[0] as PiUserMessage).content, "[m1] question");
    assert.equal(
      ((out[1] as PiAssistantMessage).content[0] as { text: string }).text,
      "[m2] edited answer",
    );
  });

  it("materializes a folded block as a synthetic user message", () => {
    const messages: PiAgentMessage[] = [
      userMessage("question"),
      assistantMessage([textPart("answer one")]),
      userMessage("next question"),
      assistantMessage([textPart("answer two")]),
    ];
    const state = makeState();
    seedBlock(state, messages, 1, 1, 3, "first block", "summary body");
    const block = state.blocks.get(1);
    assert.ok(block);
    const items: ViewItem[] = [
      { type: "original", ordinal: 0 },
      { type: "summary", block },
      { type: "original", ordinal: 3 },
    ];

    const out = render(messages, items, [], state);

    assert.equal(out.length, 3);
    assert.equal((out[0] as PiUserMessage).content, "[m1] question");
    assert.equal(
      (out[1] as PiUserMessage).content,
      "[m2] [Block b1 · 2 条] first block\nsummary body",
    );
    assert.equal(
      ((out[2] as PiAssistantMessage).content[0] as { text: string }).text,
      "[m3] answer two",
    );
  });

  it("expands a folded summary to keep toolCall and toolResult together", () => {
    const messages: PiAgentMessage[] = [
      userMessage("question"),
      assistantMessage([toolCallPart("call-1", "bash", { cmd: "ls" })]),
      toolResultMessage("call-1", "bash", [textPart("output")]),
      userMessage("follow-up"),
    ];
    const state = makeState();
    // Intentionally fold only the assistant toolCall message; the adapter
    // must expand the block to include its paired toolResult, losing the
    // original block id because the surviving interval no longer matches.
    seedBlock(state, messages, 1, 1, 2, "tool round", "did a thing");
    const block = state.blocks.get(1);
    assert.ok(block);
    const items: ViewItem[] = [
      { type: "original", ordinal: 0 },
      { type: "summary", block },
      { type: "original", ordinal: 3 },
    ];

    const out = render(messages, items, [], state);

    assert.equal(out.length, 3);
    assert.equal((out[0] as PiUserMessage).content, "[m1] question");
    assert.equal(
      (out[1] as PiUserMessage).content,
      "[m2] [Block 2 条] tool round\ndid a thing",
    );
    assert.equal((out[2] as PiUserMessage).content, "[m3] follow-up");
  });

  it("never mutates the input array or messages", () => {
    const messages: PiAgentMessage[] = [
      userMessage("question"),
      assistantMessage([textPart("answer")]),
      toolResultMessage("call-1", "bash", [textPart("output")]),
    ];
    const snapshot = structuredClone(messages);
    const state = makeState();
    const items: ViewItem[] = messages.map((_, ordinal) => ({
      type: "original",
      ordinal,
    }));

    const out = render(messages, items, [], state);

    assert.notEqual(out, messages);
    assert.deepEqual(messages, snapshot);
  });
});

// ---------------------------------------------------------------------------
// Summary materialization helper
// ---------------------------------------------------------------------------

describe("materializeSummary", () => {
  it("produces a user message with label, block id and summary body", () => {
    const message = materializeSummary(
      { start: 2, end: 5, title: "topic", summary: "body", id: 3 },
      7,
    );
    assert.equal(message.role, "user");
    assert.equal(message.content, "[m7] [Block b3 · 3 条] topic\nbody");
  });

  it("omits the block id when it is not provided", () => {
    const message = materializeSummary({
      start: 2,
      end: 5,
      title: "topic",
      summary: "body",
    });
    assert.equal(message.content, "[Block 3 条] topic\nbody");
  });

  it("omits the body line when summary is empty", () => {
    const message = materializeSummary(
      { start: 0, end: 1, title: "topic", summary: "", id: 1 },
      1,
    );
    assert.equal(message.content, "[m1] [Block b1 · 1 条] topic");
  });
});
