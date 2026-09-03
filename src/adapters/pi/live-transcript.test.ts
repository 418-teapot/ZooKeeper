/**
 * Tests for the pi live-transcript bus (`src/adapters/pi/live-transcript.ts`).
 *
 * The bus is the event wire between the subagent driver and the transcript
 * overlay: the driver forwards the child session's raw pi events keyed by
 * session id, and an overlay subscribes for the run's child session.  These
 * tests assert the registry semantics: per-session delivery, the
 * render-relevant event filter (finalized `message_end` messages of the
 * rendered roles, the assistant streaming lifecycle `message_start` /
 * `message_update`, the `tool_execution_start` / `tool_execution_end`
 * bookends, and the bare `agent_end` run-end marker), unsubscribe cleanup,
 * and the test reset.
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  emitTranscriptEvent,
  type LiveTranscriptEvent,
  resetTranscriptBus,
  subscribeTranscript,
} from "./live-transcript.js";

afterEach(() => {
  resetTranscriptBus();
});

describe("live-transcript bus", () => {
  it("forwards message_end events to the session's subscribers", () => {
    const received: LiveTranscriptEvent[] = [];
    const unsubscribe = subscribeTranscript("child-1", (event) => {
      received.push(event);
    });
    emitTranscriptEvent("child-1", {
      type: "message_end",
      message: { role: "assistant", content: [] },
    });
    assert.deepEqual(
      received.map((e) => e.type),
      ["message_end"],
      JSON.stringify(received),
    );
    unsubscribe();
  });

  it("delivers only to the matching session's subscribers", () => {
    const received: string[] = [];
    subscribeTranscript("child-a", (e) => received.push(e.type));
    emitTranscriptEvent("child-b", {
      type: "message_end",
      message: { role: "user", content: "x" },
    });
    assert.deepEqual(received, [], "other sessions' events must not leak");
    emitTranscriptEvent("child-a", {
      type: "message_end",
      message: { role: "user", content: "x" },
    });
    assert.deepEqual(received, ["message_end"]);
  });

  it("forwards assistant streaming events with the message payload", () => {
    const received: LiveTranscriptEvent[] = [];
    const unsubscribe = subscribeTranscript("child-1", (event) => {
      received.push(event);
    });
    const start = { role: "assistant", content: [] };
    const partial = {
      role: "assistant",
      content: [{ type: "text", text: "half" }],
    };
    const final = {
      role: "assistant",
      content: [{ type: "text", text: "half done" }],
    };
    emitTranscriptEvent("child-1", { type: "message_start", message: start });
    emitTranscriptEvent("child-1", {
      type: "message_update",
      message: partial,
      assistantMessageEvent: { type: "text_delta", delta: " half" },
    });
    emitTranscriptEvent("child-1", { type: "message_end", message: final });
    assert.deepEqual(
      received.map((e) => e.type),
      ["message_start", "message_update", "message_end"],
      JSON.stringify(received),
    );
    // The forwarded payload is the message only (host-neutral duck shape):
    // the accumulated partial message, not the raw delta envelope.
    assert.deepEqual(
      (received[1] as { message: unknown }).message,
      partial,
      "message_update carries the accumulated partial message",
    );
    unsubscribe();
  });

  it("drops streaming events for roles the overlay does not stream", () => {
    const received: LiveTranscriptEvent[] = [];
    const unsubscribe = subscribeTranscript("child-1", (event) => {
      received.push(event);
    });
    // Only assistant messages stream; user / toolResult arrive whole (their
    // `message_start` / `message_end` fire back to back and the record
    // renders from the `message_end` alone).
    emitTranscriptEvent("child-1", {
      type: "message_start",
      message: { role: "user", content: "u" },
    });
    emitTranscriptEvent("child-1", {
      type: "message_update",
      message: { role: "user", content: "u" },
    });
    emitTranscriptEvent("child-1", {
      type: "message_start",
      message: { role: "toolResult", toolCallId: "c1", content: [] },
    });
    emitTranscriptEvent("child-1", {
      type: "message_update",
      message: { role: "toolResult", toolCallId: "c1", content: [] },
    });
    emitTranscriptEvent("child-1", {
      type: "message_start",
      message: { role: "custom", customType: "x", content: [] },
    });
    assert.deepEqual(received, [], "non-assistant streaming is dropped");
    unsubscribe();
  });

  it("forwards tool_execution_start narrowed to its host-neutral duck shape", () => {
    const received: LiveTranscriptEvent[] = [];
    const unsubscribe = subscribeTranscript("child-1", (event) => {
      received.push(event);
    });
    // A raw pi event with extra host fields: the forwarded form carries the
    // duck shape only (toolCallId / toolName / args), never the raw object.
    emitTranscriptEvent("child-1", {
      type: "tool_execution_start",
      toolCallId: "c1",
      toolName: "bash",
      args: { command: "npm test" },
      extraHostField: "must-not-leak",
    });
    assert.deepEqual(received, [
      {
        type: "tool_execution_start",
        toolCallId: "c1",
        toolName: "bash",
        args: { command: "npm test" },
      },
    ]);
    unsubscribe();
  });

  it("forwards tool_execution_end with the result and a boolean isError", () => {
    const received: LiveTranscriptEvent[] = [];
    const unsubscribe = subscribeTranscript("child-1", (event) => {
      received.push(event);
    });
    const result = { content: [{ type: "text", text: "ok" }] };
    emitTranscriptEvent("child-1", {
      type: "tool_execution_end",
      toolCallId: "c1",
      toolName: "bash",
      result,
      isError: true,
    });
    // The missing-`isError` case normalizes to `false` (pi omits it for a
    // successful plain result in some paths).
    emitTranscriptEvent("child-1", {
      type: "tool_execution_end",
      toolCallId: "c2",
      toolName: "bash",
      result,
    });
    assert.deepEqual(received, [
      {
        type: "tool_execution_end",
        toolCallId: "c1",
        toolName: "bash",
        result,
        isError: true,
      },
      {
        type: "tool_execution_end",
        toolCallId: "c2",
        toolName: "bash",
        result,
        isError: false,
      },
    ]);
    unsubscribe();
  });

  it("defaults a non-string tool name to 'tool' and drops malformed ids", () => {
    const received: LiveTranscriptEvent[] = [];
    const unsubscribe = subscribeTranscript("child-1", (event) => {
      received.push(event);
    });
    emitTranscriptEvent("child-1", {
      type: "tool_execution_start",
      toolCallId: "c1",
      args: {},
    });
    // No usable call id → nothing to key a live component by → dropped.
    emitTranscriptEvent("child-1", {
      type: "tool_execution_start",
      toolName: "bash",
      args: {},
    });
    emitTranscriptEvent("child-1", {
      type: "tool_execution_end",
      toolCallId: "",
      toolName: "bash",
      result: {},
    });
    assert.deepEqual(received, [
      {
        type: "tool_execution_start",
        toolCallId: "c1",
        toolName: "tool",
        args: {},
      },
    ]);
    unsubscribe();
  });

  it("forwards agent_end as a bare run-end marker (payload stripped)", () => {
    const received: LiveTranscriptEvent[] = [];
    const unsubscribe = subscribeTranscript("child-1", (event) => {
      received.push(event);
    });
    emitTranscriptEvent("child-1", {
      type: "agent_end",
      messages: [{ role: "assistant", content: [] }],
    });
    assert.deepEqual(received, [{ type: "agent_end" }]);
    unsubscribe();
  });

  it("drops event types the overlay does not render with", () => {
    const received: string[] = [];
    subscribeTranscript("child-1", (e) => received.push(e.type));
    emitTranscriptEvent("child-1", { type: "message_start", message: {} });
    emitTranscriptEvent("child-1", { type: "message_update", message: {} });
    emitTranscriptEvent("child-1", {
      type: "turn_end",
      message: {},
      toolResults: [],
    });
    // Partial tool output: the overlay renders the pending call and the
    // final result only — streaming updates are dropped at the boundary.
    emitTranscriptEvent("child-1", {
      type: "tool_execution_update",
      toolCallId: "c1",
      toolName: "bash",
      args: { command: "ls" },
      partialResult: { content: [{ type: "text", text: "half" }] },
    });
    assert.deepEqual(received, [], "non-forwarded events must be dropped");
  });

  it("unsubscribing stops delivery and cleans the registry entry", () => {
    const received: string[] = [];
    const unsubscribe = subscribeTranscript(
      "child-1",
      (e: LiveTranscriptEvent) => {
        received.push(e.type);
      },
    );
    unsubscribe();
    emitTranscriptEvent("child-1", {
      type: "message_end",
      message: { role: "user", content: "x" },
    });
    // NB: `.length` is asserted instead of `deepEqual(received, [])` — the
    // latter's assertion signature narrows `received` to `never[]`, which
    // would break the push in the re-subscribed callback below.
    assert.equal(received.length, 0, "unsubscribed listeners must not receive");
    // Re-subscribing under the same id works (the entry was cleaned).
    subscribeTranscript("child-1", (e: LiveTranscriptEvent) => {
      received.push(e.type);
    });
    emitTranscriptEvent("child-1", {
      type: "message_end",
      message: { role: "user", content: "x" },
    });
    assert.deepEqual(received, ["message_end"]);
  });

  it("is a no-op when nobody subscribes", () => {
    emitTranscriptEvent("child-1", {
      type: "message_end",
      message: { role: "user", content: "x" },
    });
    // No subscribers → nothing to deliver, nothing to assert beyond no throw.
  });
});
