/**
 * Tests for the Context Pruning Hook handlers.
 *
 * Covers all four exported handlers:
 *   1. handleToolBefore — tool call tracking for dedup detection
 *   2. handleToolAfter — tool error tracking for purge-errors strategy
 *   3. handleSessionCleanup — session state cleanup
 *   4. handleMessagesTransform — OpenCode message conversion, pipeline, back-mapping
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { globalState } from "../../context-pruning/state.js";
import {
  handleMessagesTransform,
  handleSessionCleanup,
  handleToolAfter,
  handleToolBefore,
} from "./index.js";

// ---------------------------------------------------------------------------
// Local type mirrors (matching hook.ts private interfaces)
// ---------------------------------------------------------------------------

interface OpenCodeMessageInfo {
  id: string;
  role: string;
  sessionID?: string;
  agent?: string;
  [key: string]: unknown;
}

interface TextPart {
  type: "text";
  text: string;
}

interface ToolPart {
  type: "tool";
  tool: string;
  id: string;
  state: {
    status: string;
    input?: Record<string, unknown>;
    output?: string;
    error?: string;
    [key: string]: unknown;
  };
}

type MessagePart = TextPart | ToolPart;

interface OpenCodeMessage {
  info: OpenCodeMessageInfo;
  parts: MessagePart[];
}

interface TransformOutput {
  messages?: OpenCodeMessage[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SESSION_ID = "test-hook-session";

/**
 * Build a minimal OpenCode message.
 */
function msg(
  role: string,
  text: string,
  overrides?: Partial<OpenCodeMessageInfo>,
): OpenCodeMessage {
  return {
    info: {
      role,
      id: `msg-${role}-${Date.now()}`,
      sessionID: SESSION_ID,
      ...overrides,
    },
    parts: [{ type: "text" as const, text }],
  };
}

/**
 * Create a tool-call message part.
 */
function toolPart(
  tool: string,
  id: string,
  status: string,
  input?: Record<string, unknown>,
): ToolPart {
  return {
    type: "tool",
    tool,
    id,
    state: { status, input: input ?? {} },
  };
}

// ---------------------------------------------------------------------------
// Cleanup between tests
// ---------------------------------------------------------------------------

afterEach(() => {
  // Remove all test sessions from global state
  globalState.delete(SESSION_ID);
  globalState.delete(`${SESSION_ID}-tb`);
  globalState.delete(`${SESSION_ID}-ta`);
  globalState.delete(`${SESSION_ID}-ta-1`);
  globalState.delete(`${SESSION_ID}-ta-2`);
  globalState.delete(`${SESSION_ID}-ta-3`);
  globalState.delete(`${SESSION_ID}-cleanup`);
  globalState.delete(`${SESSION_ID}-mt-once`);
});

// ===========================================================================
// handleToolBefore
// ===========================================================================

describe("handleToolBefore", () => {
  it("tracks tool call with sessionID, tool, parameters, callID", async () => {
    const sid = `${SESSION_ID}-tb`;
    await handleToolBefore(
      { tool: "bash", sessionID: sid, callID: "c1" },
      { args: { cmd: "ls -la" } },
    );

    const state = globalState.get(sid);
    assert.ok(state, "expected session state to exist");
    // trackToolCall adds a dedup cache entry
    assert.equal(state?.dedupCache.size, 1);
  });

  it("extracts args from output.args", async () => {
    const sid = `${SESSION_ID}-tb`;
    await handleToolBefore(
      { tool: "read", sessionID: sid, callID: "c2" },
      { args: { filePath: "/tmp/test.txt" } },
    );

    const state = globalState.get(sid);
    assert.ok(state, "expected session state to exist");
    // Each call adds one dedup entry
    assert.equal(state?.dedupCache.size, 1);
    // Verify the cache entry reflects the passed args
    const signature = `read::${JSON.stringify({ filePath: "/tmp/test.txt" })}`;
    assert.ok(state?.dedupCache.has(signature));
  });

  it("defaults to empty object when output.args is undefined", async () => {
    const sid = `${SESSION_ID}-tb`;
    // The handler uses `output.args ?? {}` — should not crash
    await handleToolBefore(
      { tool: "edit", sessionID: sid, callID: "c3" },
      { args: undefined as unknown as Record<string, unknown> },
    );

    const state = globalState.get(sid);
    assert.ok(state, "expected session state to exist");
    // Dedup entry created with empty (normalized) parameters
    assert.equal(state?.dedupCache.size, 1);
    const signature = "edit::{}";
    assert.ok(state?.dedupCache.has(signature));
  });

  it("does not crash when output is undefined", async () => {
    await handleToolBefore(
      { tool: "bash", sessionID: `${SESSION_ID}-tb`, callID: "c4" },
      undefined as unknown as { args?: Record<string, unknown> },
    );
    assert.ok(true);
  });

  it("does not crash when sessionID is undefined", async () => {
    await handleToolBefore(
      { tool: "bash", sessionID: undefined as unknown as string, callID: "c5" },
      { args: { cmd: "ls" } },
    );
    assert.ok(true);
  });
});

// ===========================================================================
// handleToolAfter
// ===========================================================================

describe("handleToolAfter", () => {
  it("does not track error when output has output field", async () => {
    const sid = `${SESSION_ID}-ta-1`;
    await handleToolAfter(
      { tool: "bash", sessionID: sid, callID: "c1" },
      { output: "success" },
    );

    // No error → no session state is created (expected — handler is no-op)
    const state = globalState.get(sid);
    assert.equal(state, undefined, "no session should be created on success");
  });

  it("tracks error when output.output is undefined", async () => {
    const sid = `${SESSION_ID}-ta-2`;
    await handleToolAfter(
      { tool: "bash", sessionID: sid, callID: "c2" },
      { output: undefined },
    );

    const state = globalState.get(sid);
    assert.ok(state, "expected session state to exist");
    assert.equal(state?.errorTracking.size, 1);
    const entry = state?.errorTracking.get("c2");
    assert.ok(entry, "expected error entry for c2");
    assert.equal(entry?.toolName, "bash");
  });

  it("tracks error when output has error field", async () => {
    const sid = `${SESSION_ID}-ta-3`;
    await handleToolAfter(
      { tool: "read", sessionID: sid, callID: "c3" },
      { error: "File not found" },
    );

    const state = globalState.get(sid);
    assert.ok(state, "expected session state to exist");
    assert.equal(state?.errorTracking.size, 1);
    const entry = state?.errorTracking.get("c3");
    assert.ok(entry, "expected error entry for c3");
    assert.equal(entry?.errorMessage, "File not found");
  });

  it("does not crash when output is undefined", async () => {
    await handleToolAfter(
      { tool: "bash", sessionID: `${SESSION_ID}-ta-2`, callID: "c4" },
      undefined as unknown as { output?: string; error?: string },
    );
    assert.ok(true);
  });

  it("does not crash when sessionID is undefined", async () => {
    await handleToolAfter(
      { tool: "bash", sessionID: undefined as unknown as string, callID: "c5" },
      { output: "result" },
    );
    assert.ok(true);
  });
});

// ===========================================================================
// handleSessionCleanup
// ===========================================================================

describe("handleSessionCleanup", () => {
  it("removes session from globalState", async () => {
    const sid = `${SESSION_ID}-cleanup`;
    // Create a session first
    globalState.getOrCreate(sid);
    assert.ok(globalState.get(sid), "expected session to exist before cleanup");

    await handleSessionCleanup({ sessionID: sid }, {});

    assert.equal(globalState.get(sid), undefined);
  });

  it("does not crash when session doesn't exist", async () => {
    await handleSessionCleanup({ sessionID: "nonexistent-session" }, {});
    assert.ok(true);
  });

  it("does not crash when sessionID is missing", async () => {
    await handleSessionCleanup(
      { sessionID: undefined as unknown as string },
      {},
    );
    assert.ok(true);
  });
});

// ===========================================================================
// handleMessagesTransform
// ===========================================================================

describe("handleMessagesTransform", () => {
  it("returns early when messages array is empty", async () => {
    const output: TransformOutput = { messages: [] };
    await handleMessagesTransform({}, output);
    // Should remain empty — no crash, no change
    assert.equal(output.messages?.length, 0);
  });

  it("returns early when no sessionID on messages", async () => {
    const output: TransformOutput = {
      messages: [
        {
          info: { id: "m1", role: "user" }, // no sessionID
          parts: [{ type: "text" as const, text: "Hello" }],
        },
      ],
    };
    await handleMessagesTransform({}, output);
    // Messages should remain unchanged
    assert.equal(output.messages?.length, 1);
    assert.equal((output.messages?.[0].parts[0] as TextPart).text, "Hello");
  });

  it("converts basic text messages correctly", async () => {
    const output: TransformOutput = {
      messages: [
        msg("user", "Build this feature"),
        msg("assistant", "Let me implement that"),
      ],
    };
    await handleMessagesTransform({}, output);

    assert.ok(output.messages, "expected messages to exist");
    assert.equal(output.messages.length, 2);
    // Content is preserved — the pipeline strips <zoo:message-id> tags
    // but the injected newline before the tag remains as a leading \n
    assert.ok(
      (output.messages[0].parts[0] as TextPart).text.includes(
        "Build this feature",
      ),
    );
    assert.ok(
      (output.messages[1].parts[0] as TextPart).text.includes(
        "Let me implement that",
      ),
    );
    // IDs should have been assigned (original ids may be reassigned by pipeline)
    assert.ok(output.messages[0].info.id);
    assert.ok(output.messages[1].info.id);
  });

  it("pipeline runs without error when messages include tool parts", async () => {
    const output: TransformOutput = {
      messages: [
        msg("user", "Run bash"),
        {
          info: { id: "a1", role: "assistant", sessionID: SESSION_ID },
          parts: [
            { type: "text", text: "Running ls" },
            toolPart("bash", "tc1", "running", { cmd: "ls" }),
          ],
        },
        {
          info: { id: "t1", role: "tool", sessionID: SESSION_ID },
          parts: [
            {
              type: "tool",
              tool: "bash",
              id: "tc1",
              state: { status: "success", output: "file1.txt" },
            },
          ],
        },
      ],
    };
    await handleMessagesTransform({}, output);

    assert.ok(output.messages, "expected messages to exist");
    // All three messages should pass through
    assert.equal(output.messages.length, 3);
  });

  it("filters malformed messages with missing id", async () => {
    const output: TransformOutput = {
      messages: [
        {
          info: { id: "", role: "user", sessionID: SESSION_ID },
          parts: [{ type: "text" as const, text: "bad" }],
        },
        msg("user", "good", { sessionID: SESSION_ID }),
      ],
    };
    await handleMessagesTransform({}, output);
    // The malformed message (empty id) is filtered out;
    // only the valid message passes through
    assert.ok(output.messages, "expected messages to exist");
    assert.equal(output.messages.length, 1);
    const p = output.messages[0].parts[0];
    assert.equal(p.type, "text");
    assert.ok((p as TextPart).text.includes("good"));
  });

  it("filters malformed messages with invalid role", async () => {
    const output: TransformOutput = {
      messages: [
        {
          info: { id: "m1", role: "invalid", sessionID: SESSION_ID },
          parts: [{ type: "text" as const, text: "bad" }],
        },
        msg("user", "good", { sessionID: SESSION_ID }),
      ],
    };
    await handleMessagesTransform({}, output);
    assert.equal(output.messages?.length, 1);
    const p = output.messages[0].parts[0];
    assert.equal(p.type, "text");
    assert.ok((p as TextPart).text.includes("good"));
  });

  it("filters malformed messages with no parts array", async () => {
    const output: TransformOutput = {
      messages: [
        {
          info: { id: "m1", role: "user", sessionID: SESSION_ID },
          parts: undefined as unknown as MessagePart[],
        },
        msg("user", "good", { sessionID: SESSION_ID }),
      ],
    };
    await handleMessagesTransform({}, output);
    assert.equal(output.messages?.length, 1);
    const p = output.messages[0].parts[0];
    assert.equal(p.type, "text");
    assert.ok((p as TextPart).text.includes("good"));
  });

  it("filters malformed messages with empty parts array", async () => {
    const output: TransformOutput = {
      messages: [
        {
          info: { id: "m1", role: "user", sessionID: SESSION_ID },
          parts: [],
        },
        msg("user", "good", { sessionID: SESSION_ID }),
      ],
    };
    await handleMessagesTransform({}, output);
    assert.equal(output.messages?.length, 1);
    const p = output.messages[0].parts[0];
    assert.equal(p.type, "text");
    assert.ok((p as TextPart).text.includes("good"));
  });

  it("does not crash on malformed messages (try-catch swallows)", async () => {
    // Message with null info — filtered out by convertOpenCodeToMessageRefs
    const output: TransformOutput = {
      messages: [
        {
          info: null as unknown as OpenCodeMessageInfo,
          parts: [{ type: "text", text: "Hello" }],
        } as unknown as OpenCodeMessage,
      ],
    };
    // Should not throw — caught by try-catch inside the handler
    await handleMessagesTransform({}, output);
    assert.ok(true);
  });

  it("handles multiple transform calls correctly", async () => {
    const sid = `${SESSION_ID}-mt-once`;
    const buildMsg = (text: string): TransformOutput => ({
      messages: [msg("user", text, { sessionID: sid })],
    });

    // First call — runPipeline (state init + ID assignment + sync blocks)
    const first = buildMsg("Turn 1");
    await handleMessagesTransform({}, first);
    assert.ok(first.messages, "expected messages after first call");

    const stateAfterFirst = globalState.get(sid);
    assert.ok(stateAfterFirst, "expected session state after first call");

    // Second call — runPipeline again
    const second = buildMsg("Turn 2");
    await handleMessagesTransform({}, second);
    assert.ok(second.messages, "expected messages after second call");

    const stateAfterSecond = globalState.get(sid);
    assert.ok(stateAfterSecond, "expected session state after second call");
    // runPipeline is called each turn and calls advanceTurn
    // First: runPipeline (advanceTurn) → turnCount = 1
    // Second: runPipeline (advanceTurn) → turnCount = 2
    assert.equal(stateAfterSecond?.turnCount, 2);
  });
});
