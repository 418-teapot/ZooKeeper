/**
 * Tests for the pi host adapter factory (`adapter.ts`).
 *
 * Coverage:
 * - `applyEdits` returns a new array and leaves the input untouched while
 *   writing edits through the lens.
 * - `renderView` returns a new array and leaves the input untouched while
 *   materializing summaries and injecting line refs.
 * - `render` composes `applyEdits` then `renderView` without mutating input.
 * - `appendUserMessage` appends a synthetic user message to a new array.
 * - `sessionId` delegates to the provider supplied at construction.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { RegionEdit, ViewItem } from "../../core/context/lens.js";
import { computeSpanHash } from "../../core/context/spanhash.js";
import type { SessionState } from "../../core/context/state.js";
import { createPiAdapter } from "./adapter.js";
import { history } from "./history.js";
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
// Adapter contract
// ---------------------------------------------------------------------------

describe("createPiAdapter", () => {
  it("sessionId delegates to the construction-time provider", () => {
    const adapter = createPiAdapter(() => "sess-pi-42");
    assert.equal(adapter.sessionId([]), "sess-pi-42");
  });

  it("sessionId can return undefined when the provider has no id", () => {
    const adapter = createPiAdapter(() => undefined);
    assert.equal(adapter.sessionId([userMessage("hi")]), undefined);
  });
});

describe("pi adapter applyEdits", () => {
  it("returns a new array and leaves the input untouched", () => {
    const adapter = createPiAdapter(() => "sess");
    const messages: PiAgentMessage[] = [
      userMessage("question"),
      assistantMessage([textPart("answer")]),
    ];
    const snapshot = structuredClone(messages);
    const edits: RegionEdit[] = [
      { messageOrdinal: 1, regionIndex: 0, text: "edited answer" },
    ];

    const out = adapter.applyEdits(messages, edits);

    assert.notEqual(out, messages);
    assert.deepEqual(messages, snapshot);
    assert.equal(
      ((out[1] as PiAssistantMessage).content[0] as { text: string }).text,
      "edited answer",
    );
  });

  it("skips edits that cannot be resolved", () => {
    const adapter = createPiAdapter(() => "sess");
    const messages: PiAgentMessage[] = [userMessage("question")];
    const edits: RegionEdit[] = [
      { messageOrdinal: 9, regionIndex: 0, text: "missing message" },
      { messageOrdinal: 0, text: "missing region index" },
      { messageOrdinal: 0, regionIndex: 5, text: "bad region" },
    ];

    const out = adapter.applyEdits(messages, edits);

    assert.notEqual(out, messages);
    assert.equal((out[0] as PiUserMessage).content, "question");
  });
});

describe("pi adapter renderView", () => {
  it("returns a new array and leaves the input untouched", () => {
    const adapter = createPiAdapter(() => "sess");
    const messages: PiAgentMessage[] = [
      userMessage("question"),
      assistantMessage([textPart("answer")]),
    ];
    const snapshot = structuredClone(messages);
    const state = makeState();
    const items: ViewItem[] = messages.map((_, ordinal) => ({
      type: "original" as const,
      ordinal,
    }));

    const out = adapter.renderView(messages, items, state);

    assert.notEqual(out, messages);
    assert.deepEqual(messages, snapshot);
  });

  it("materializes a folded block as a synthetic user message", () => {
    const adapter = createPiAdapter(() => "sess");
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

    const out = adapter.renderView(messages, items, state);

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
});

describe("pi adapter render", () => {
  it("composes applyEdits and renderView without mutating input", () => {
    const adapter = createPiAdapter(() => "sess");
    const messages: PiAgentMessage[] = [
      userMessage("question"),
      assistantMessage([toolCallPart("call-1", "bash", { cmd: "ls" })]),
      toolResultMessage("call-1", "bash", [textPart("output line")]),
    ];
    const snapshot = structuredClone(messages);
    const state = makeState();
    const items: ViewItem[] = messages.map((_, ordinal) => ({
      type: "original" as const,
      ordinal,
    }));
    const edits: RegionEdit[] = [
      { messageOrdinal: 2, regionIndex: 0, text: "pruned output" },
    ];

    const out = adapter.render(messages, items, edits, state);

    assert.notEqual(out, messages);
    assert.deepEqual(messages, snapshot);
    assert.equal(
      ((out[2] as PiToolResultMessage).content[0] as { text: string }).text,
      "[m3] pruned output",
    );
  });
});

describe("pi adapter appendUserMessage", () => {
  it("appends a synthetic user message to a new array", () => {
    const adapter = createPiAdapter(() => "sess");
    const messages: PiAgentMessage[] = [userMessage("hello")];
    const snapshot = structuredClone(messages);

    const out = adapter.appendUserMessage(
      messages,
      "zoo-nudge",
      "sess",
      "nudge text",
    );

    assert.notEqual(out, messages);
    assert.deepEqual(messages, snapshot);
    assert.equal(out.length, 2);
    assert.equal((out[1] as PiUserMessage).content, "nudge text");
    assert.equal((out[1] as PiUserMessage).role, "user");
  });
});
