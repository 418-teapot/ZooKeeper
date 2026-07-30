/**
 * Tests for the `/dcp context` command hook adapter.
 *
 * Covers: fetching messages, injecting ignored prompt, throwing sentinel,
 * unknown subcommand help, empty messages, unavailable client APIs.
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { ContextMessageEntry } from "../../core/metrics.js";
import { estimateTokenCount } from "../../core/metrics.js";
import {
  deleteSessionState,
  getOrCreateSessionState,
  loadSessionState,
  PRUNED_TOOL_OUTPUT_REPLACEMENT,
  pruneToolOutputs,
} from "../../core/pruning/index.js";
import {
  _clearAllSessionsForTesting,
  addMark,
  reclaimedTokens,
} from "../../core/pruning/marks.js";
import { _getBufferForTesting, _resetForTesting } from "../../utils/logger.js";
import {
  DCP_COMMAND_HANDLED,
  type DcpClient,
  handleDcpCommand,
  parseSweepCount,
} from "./index.js";

// ---------------------------------------------------------------------------
// Logger & state cleanup
// ---------------------------------------------------------------------------

/** Session IDs that persist to disk during tests (need file cleanup). */
const SWEEP_TEST_SESSION_IDS = [
  "sess-sweep-success",
  "sess-short-output",
  "sess-sweep-1",
  "sess-no-double",
  "sess-persist-after-sweep",
];

afterEach(() => {
  _resetForTesting();
  _clearAllSessionsForTesting();
  for (const sid of SWEEP_TEST_SESSION_IDS) {
    deleteSessionState(sid);
  }
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Create a mock client that returns given messages and tracks prompt calls.
 */
function mockClient(messages: ContextMessageEntry[]): {
  client: DcpClient;
  promptCalls: Array<{
    sessionID: string;
    text: string;
    noReply?: boolean;
    ignored?: boolean;
  }>;
} {
  const promptCalls: Array<{
    sessionID: string;
    text: string;
    noReply?: boolean;
    ignored?: boolean;
  }> = [];

  const client: DcpClient = {
    session: {
      messages: async () => ({ data: messages }),
      prompt: async (input: {
        path: { id: string };
        body: {
          noReply?: boolean;
          parts: Array<{ type: "text"; text: string; ignored?: boolean }>;
        };
      }) => {
        promptCalls.push({
          sessionID: input.path.id,
          text: input.body.parts[0]?.text ?? "",
          noReply: input.body.noReply,
          ignored: input.body.parts[0]?.ignored,
        });
      },
    },
  };

  return { client, promptCalls };
}

/**
 * Assert that the prompt call includes expected keywords.
 */
function assertPromptContains(
  promptCalls: Array<{ text: string }>,
  keyword: string,
  message?: string,
): void {
  assert.ok(promptCalls.length > 0, "expected at least one prompt call");
  assert.ok(
    promptCalls[0].text.includes(keyword),
    message ?? `expected prompt to contain "${keyword}"`,
  );
}

// ---------------------------------------------------------------------------
// Normal flow: context subcommand
// ---------------------------------------------------------------------------

describe("/dcp context subcommand", () => {
  it("fetches messages and injects ignored prompt", async () => {
    const msgs: ContextMessageEntry[] = [
      {
        info: { role: "user", id: "m1" },
        parts: [{ type: "text", text: "Hi" }],
      },
      {
        info: {
          role: "assistant",
          id: "m2",
          tokens: { input: 100, output: 50 },
        },
        parts: [{ type: "text", text: "Hello" }],
      },
    ];
    const { client, promptCalls } = mockClient(msgs);

    await handleDcpCommand(client, "sess-1", "context");

    assert.equal(promptCalls.length, 1);
    assert.equal(promptCalls[0].sessionID, "sess-1");
    assert.equal(promptCalls[0].noReply, true);
    assert.equal(promptCalls[0].ignored, true);
    assertPromptContains(promptCalls, "上下文报告");
    assertPromptContains(promptCalls, "tokens");
  });

  it("handles empty args (default to context)", async () => {
    const msgs: ContextMessageEntry[] = [
      {
        info: { role: "user", id: "m1" },
        parts: [{ type: "text", text: "Hi" }],
      },
    ];
    const { client, promptCalls } = mockClient(msgs);

    await handleDcpCommand(client, "sess-2", "");

    assert.equal(promptCalls.length, 1);
    assertPromptContains(promptCalls, "上下文报告");
  });

  it("includes cache hit rate when available", async () => {
    const msgs: ContextMessageEntry[] = [
      {
        info: { role: "user", id: "m1" },
        parts: [{ type: "text", text: "Hi" }],
      },
      {
        info: {
          role: "assistant",
          id: "m2",
          tokens: {
            input: 500,
            output: 100,
            cache: { read: 200, write: 50 },
          },
        },
        parts: [{ type: "text", text: "Response" }],
      },
    ];
    const { client, promptCalls } = mockClient(msgs);

    await handleDcpCommand(client, "sess-3", "context");

    assertPromptContains(promptCalls, "26.7%");
  });

  it("omits category breakdown from compact report", async () => {
    const msgs: ContextMessageEntry[] = [
      {
        info: { role: "user", id: "m1" },
        parts: [{ type: "text", text: "Hello" }],
      },
      {
        info: {
          role: "assistant",
          id: "m2",
          tokens: { input: 500, output: 100 },
        },
        parts: [{ type: "text", text: "World" }],
      },
    ];
    const { client, promptCalls } = mockClient(msgs);

    await handleDcpCommand(client, "sess-4", "context");

    // Compact report: summary lines only, no category breakdown.
    assert.ok(
      !promptCalls[0].text.includes("分类占比"),
      "should not contain category breakdown intro",
    );
    assert.ok(
      !promptCalls[0].text.includes("user "),
      "should not contain category label",
    );
    assert.ok(
      !promptCalls[0].text.includes("总计"),
      "should not contain total footer",
    );
  });
});

// ---------------------------------------------------------------------------
// Unknown subcommand
// ---------------------------------------------------------------------------

describe("unknown subcommand", () => {
  it("injects help text instead of context report", async () => {
    const msgs: ContextMessageEntry[] = [
      {
        info: { role: "user", id: "m1" },
        parts: [{ type: "text", text: "Hi" }],
      },
    ];
    const { client, promptCalls } = mockClient(msgs);

    await handleDcpCommand(client, "sess-5", "foobar");

    assert.equal(promptCalls.length, 1);
    assertPromptContains(promptCalls, "用法");
    assertPromptContains(promptCalls, "/dcp context");
    // Should NOT contain context report keywords
    assert.equal(
      promptCalls[0].text.includes("上下文报告"),
      false,
      "help text should not include context report",
    );
  });
});

// ---------------------------------------------------------------------------
// Empty messages
// ---------------------------------------------------------------------------

describe("empty messages", () => {
  it("handles empty array gracefully", async () => {
    const { client, promptCalls } = mockClient([]);

    await handleDcpCommand(client, "sess-6", "context");

    assert.equal(promptCalls.length, 1);
    assertPromptContains(promptCalls, "0 tokens");
    assertPromptContains(promptCalls, "0 条");
  });
});

// ---------------------------------------------------------------------------
// Client with missing APIs
// ---------------------------------------------------------------------------

describe("missing client APIs", () => {
  it("throws when client is null", async () => {
    await assert.rejects(
      () => handleDcpCommand(null, "sess-7", "context"),
      /无法获取/,
    );
  });

  it("throws when client is undefined", async () => {
    await assert.rejects(
      () => handleDcpCommand(undefined, "sess-8", "context"),
      /无法获取/,
    );
  });

  it("throws when session.messages is unavailable", async () => {
    const client: DcpClient = {}; // no session at all
    await assert.rejects(
      () => handleDcpCommand(client, "sess-9", "context"),
      /无法获取/,
    );
  });

  it("throws when response contains error object (HTTP error)", async () => {
    const client: DcpClient = {
      session: {
        messages: async () => ({
          data: undefined,
          error: { message: "rate limit exceeded" },
        }),
      },
    };
    await assert.rejects(
      () => handleDcpCommand(client, "sess-10", "context"),
      /rate limit exceeded/,
    );
  });
});

// ---------------------------------------------------------------------------
// Sentinel export
// ---------------------------------------------------------------------------

describe("DCP_COMMAND_HANDLED sentinel", () => {
  it("is an Error instance", () => {
    assert.ok(DCP_COMMAND_HANDLED instanceof Error);
  });

  it("has descriptive message", () => {
    assert.ok(DCP_COMMAND_HANDLED.message.includes("/dcp command handled"));
  });
});

// ---------------------------------------------------------------------------
// Barrel export
// ---------------------------------------------------------------------------

describe("barrel export", () => {
  it("exports handleDcpCommand as a function", () => {
    assert.equal(typeof handleDcpCommand, "function");
  });

  it("exports DCP_COMMAND_HANDLED as an Error", () => {
    assert.ok(DCP_COMMAND_HANDLED instanceof Error);
  });

  it("exports parseSweepCount as a function", () => {
    assert.equal(typeof parseSweepCount, "function");
  });
});

// ---------------------------------------------------------------------------
// parseSweepCount
// ---------------------------------------------------------------------------

describe("parseSweepCount", () => {
  it("returns undefined for bare 'sweep'", () => {
    assert.equal(parseSweepCount("sweep"), undefined);
  });

  it("throws for 'sweep' with trailing space (Number('')=0, rejected by n<1 guard)", () => {
    assert.throws(() => parseSweepCount("sweep  "), /正整数/);
  });

  it("parses a positive integer N from 'sweep N'", () => {
    assert.equal(parseSweepCount("sweep 3"), 3);
  });

  it("handles double spaces: 'sweep  3'", () => {
    assert.equal(parseSweepCount("sweep  3"), 3);
  });

  it("rejects N=0 (no-op, should be user error)", () => {
    assert.throws(() => parseSweepCount("sweep 0"), /正整数/);
  });

  it("rejects negative N", () => {
    assert.throws(() => parseSweepCount("sweep -1"), /正整数/);
  });

  it("rejects float N", () => {
    assert.throws(() => parseSweepCount("sweep 3.5"), /正整数/);
  });

  it("rejects non-numeric argument", () => {
    assert.throws(() => parseSweepCount("sweep abc"), /正整数/);
  });
});

// ---------------------------------------------------------------------------
// Sweep subcommand integration tests
// ---------------------------------------------------------------------------

describe("/dcp sweep subcommand — success path", () => {
  it("marks tool outputs, injects result, does NOT throw sentinel", async () => {
    // Messages with tool parts after the last user message.
    const messages: ContextMessageEntry[] = [
      {
        info: { role: "user", id: "u1" },
        parts: [{ type: "text", text: "do something" }],
      },
      {
        info: { role: "assistant", id: "a1" },
        parts: [
          {
            type: "tool",
            callID: "call-1",
            state: {
              output:
                "output 1 data with additional content to make the net token estimate positive after placeholder subtraction",
            },
            tool: "bash",
          } as any,
          {
            type: "tool",
            callID: "call-2",
            state: {
              output:
                "output 2 longer content here with even more text to ensure a positive net reclaim estimate after subtracting the placeholder",
            },
            tool: "bash",
          } as any,
        ],
      },
    ];

    let promptText = "";
    const client: DcpClient = {
      session: {
        messages: async () => ({ data: messages }),
        prompt: async (input: {
          path: { id: string };
          body: {
            noReply?: boolean;
            parts: Array<{ type: string; text: string; ignored?: boolean }>;
          };
        }) => {
          promptText = input.body.parts[0]?.text ?? "";
        },
      },
    };

    // Should NOT throw.
    await handleDcpCommand(client, "sess-sweep-success", "sweep");

    // Verify result message was injected.
    assert.ok(
      promptText.includes("已标记"),
      `expected "已标记" in prompt, got: ${promptText}`,
    );
    assert.ok(
      promptText.includes("预计可回收"),
      `expected "预计可回收" in prompt, got: ${promptText}`,
    );

    // Verify state was populated.
    const state = getOrCreateSessionState("sess-sweep-success");
    assert.equal(state.marks.size, 2);
    assert.ok(state.marks.has("call-1"));
    assert.ok(state.marks.has("call-2"));

    // Token estimates reflect net reclaim (output - placeholder).
    const placeholderTokens = estimateTokenCount(
      PRUNED_TOOL_OUTPUT_REPLACEMENT,
    );
    const est1 = state.marks.get("call-1")?.tokens ?? 0;
    const est2 = state.marks.get("call-2")?.tokens ?? 0;
    assert.equal(
      est1,
      Math.max(
        0,
        estimateTokenCount(
          "output 1 data with additional content to make the net token estimate positive after placeholder subtraction",
        ) - placeholderTokens,
      ),
      "unexpected net estimate for call-1",
    );
    assert.equal(
      est2,
      Math.max(
        0,
        estimateTokenCount(
          "output 2 longer content here with even more text to ensure a positive net reclaim estimate after subtracting the placeholder",
        ) - placeholderTokens,
      ),
      "unexpected net estimate for call-2",
    );

    // reclaimedTokens is derived from effective marks.
    assert.equal(
      reclaimedTokens(state),
      est1 + est2,
      "reclaimedTokens should reflect effective marks after sweep",
    );
  });

  it("short tool output yields zero estimatedTokens and does not inflate totalPruneTokens", async () => {
    // A very short output like "ok" (2 chars → 1 token) is shorter than
    // the placeholder (83 chars → 21 tokens), so Math.max floors to 0.
    const messages: ContextMessageEntry[] = [
      {
        info: { role: "user", id: "u1" },
        parts: [{ type: "text", text: "run command" }],
      },
      {
        info: { role: "assistant", id: "a1" },
        parts: [
          {
            type: "tool",
            callID: "call-short",
            state: { output: "ok" },
            tool: "bash",
          } as any,
        ],
      },
    ];

    let promptText = "";
    const client: DcpClient = {
      session: {
        messages: async () => ({ data: messages }),
        prompt: async (input: {
          path: { id: string };
          body: {
            noReply?: boolean;
            parts: Array<{ type: string; text: string; ignored?: boolean }>;
          };
        }) => {
          promptText = input.body.parts[0]?.text ?? "";
        },
      },
    };

    await handleDcpCommand(client, "sess-short-output", "sweep");

    const state = getOrCreateSessionState("sess-short-output");
    assert.equal(state.marks.size, 1);
    assert.ok(state.marks.has("call-short"));

    // estimatedTokens should be floored to 0 because "ok" (2 chars)
    // yields fewer tokens than the placeholder.
    const estValue = state.marks.get("call-short")?.tokens ?? -1;
    assert.equal(estValue, 0, "short output should have 0 estimated tokens");

    // reclaimedTokens should NOT be inflated by the negative estimate.
    // Since estimatedTokens is 0, reclaimedTokens must stay at 0.
    assert.equal(
      reclaimedTokens(state),
      0,
      "reclaimedTokens should not change when estimatedTokens is 0",
    );

    // The user-facing report confirms 1 tool marked with 0 tokens.
    assert.ok(
      promptText.includes("已标记 1 个工具输出"),
      "report should confirm 1 marked tool",
    );
  });

  it("accepts 'sweep 1' marking only the most recent tool", async () => {
    const messages: ContextMessageEntry[] = [
      {
        info: { role: "assistant", id: "a1" },
        parts: [
          {
            type: "tool",
            callID: "call-old",
            state: { output: "old output" },
            tool: "bash",
          } as any,
        ],
      },
      {
        info: { role: "assistant", id: "a2" },
        parts: [
          {
            type: "tool",
            callID: "call-recent",
            state: { output: "recent output" },
            tool: "bash",
          } as any,
        ],
      },
    ];

    const client: DcpClient = {
      session: {
        messages: async () => ({ data: messages }),
        prompt: async () => {},
      },
    };

    await handleDcpCommand(client, "sess-sweep-1", "sweep 1");

    const state = getOrCreateSessionState("sess-sweep-1");
    assert.equal(state.marks.size, 1);
    assert.ok(
      state.marks.has("call-recent"),
      "expected the most recent tool to be marked",
    );
  });

  it("totalPruneTokens accumulates once at mark time, NOT doubled by pruneToolOutputs", async () => {
    // Simulate a sweep followed by two transform turns (prune calls).
    const messages: ContextMessageEntry[] = [
      {
        info: { role: "user", id: "u1" },
        parts: [{ type: "text", text: "do something" }],
      },
      {
        info: { role: "assistant", id: "a1" },
        parts: [
          {
            type: "tool",
            callID: "call-1",
            state: {
              output:
                "some tool output with extra text to make net positive after subtracting the placeholder string fully",
            },
            tool: "bash",
          } as any,
        ],
      },
    ];

    const client: DcpClient = {
      session: {
        messages: async () => ({ data: messages }),
        prompt: async () => {},
      },
    };

    // Sweep (mark time): totalPruneTokens accumulates here.
    await handleDcpCommand(client, "sess-no-double", "sweep");

    const state = getOrCreateSessionState("sess-no-double");
    const markTimeValue = reclaimedTokens(state);
    const placeholderTokens = estimateTokenCount(
      PRUNED_TOOL_OUTPUT_REPLACEMENT,
    );
    assert.equal(
      markTimeValue,
      Math.max(
        0,
        estimateTokenCount(
          "some tool output with extra text to make net positive after subtracting the placeholder string fully",
        ) - placeholderTokens,
      ),
      "reclaimedTokens should be net reclaim after sweep",
    );

    // Transform turn 1: pruneToolOutputs replaces output but does NOT
    // touch anything derived (read-only on state).
    pruneToolOutputs(state, messages);
    assert.equal(
      reclaimedTokens(state),
      markTimeValue,
      "prune should NOT change reclaimedTokens (turn 1)",
    );

    // Transform turn 2: reloaded from DB (output reverted to original),
    // prune runs again.  reclaimedTokens still unchanged.
    const reloadedMessages: ContextMessageEntry[] = [
      {
        info: { role: "user", id: "u1" },
        parts: [{ type: "text", text: "do something" }],
      },
      {
        info: { role: "assistant", id: "a1" },
        parts: [
          {
            type: "tool",
            callID: "call-1",
            // DB original (not the placeholder) — simulates transform
            // reloading fresh from DB each turn.
            state: {
              output:
                "some tool output with extra text to make net positive after subtracting the placeholder string fully",
            },
            tool: "bash",
          } as any,
        ],
      },
    ];
    pruneToolOutputs(state, reloadedMessages);
    assert.equal(
      reclaimedTokens(state),
      markTimeValue,
      "prune should NOT change reclaimedTokens across multiple turns",
    );
  });

  it("persists sweep marks to disk immediately via saveSessionState", async () => {
    const sessionID = "sess-persist-after-sweep";
    const messages: ContextMessageEntry[] = [
      {
        info: { role: "user", id: "u1" },
        parts: [{ type: "text", text: "do something" }],
      },
      {
        info: { role: "assistant", id: "a1" },
        parts: [
          {
            type: "tool",
            callID: "call-persist",
            state: {
              output:
                "some tool output that is long enough to make net reclaim positive after subtracting the placeholder text here and there",
            },
            tool: "bash",
          } as any,
        ],
      },
    ];

    const client: DcpClient = {
      session: {
        messages: async () => ({ data: messages }),
        prompt: async () => {},
      },
    };

    await handleDcpCommand(client, sessionID, "sweep");

    // Verify marks survive via loadSessionState (disk persistence).
    const persisted = loadSessionState(sessionID);
    assert.ok(persisted, "state should be persisted to disk after sweep");
    assert.ok(persisted.marks.has("call-persist"));
    assert.ok(
      (persisted.marks.get("call-persist")?.tokens ?? 0) >= 0,
      "persisted estimate must be non-negative",
    );

    // Clean up persisted file.
    deleteSessionState(sessionID);
  });
});

describe("/dcp sweep subcommand — no-marks path", () => {
  it("injects no-marks message when no tool outputs exist, does NOT throw", async () => {
    const messages: ContextMessageEntry[] = [
      {
        info: { role: "user", id: "u1" },
        parts: [{ type: "text", text: "hello" }],
      },
      {
        info: { role: "assistant", id: "a1" },
        parts: [{ type: "text", text: "response" }],
      },
    ];

    let promptText = "";
    const client: DcpClient = {
      session: {
        messages: async () => ({ data: messages }),
        prompt: async (input: {
          path: { id: string };
          body: {
            noReply?: boolean;
            parts: Array<{ type: string; text: string; ignored?: boolean }>;
          };
        }) => {
          promptText = input.body.parts[0]?.text ?? "";
        },
      },
    };

    // Should NOT throw.
    await handleDcpCommand(client, "sess-no-tools", "sweep");

    // Verify no-marks message was injected.
    assert.ok(
      promptText.includes("没有找到可标记的工具输出"),
      `expected "没有找到可标记的工具输出" in prompt, got: ${promptText}`,
    );

    // State marks should be empty.
    const state = getOrCreateSessionState("sess-no-tools");
    assert.equal(state.marks.size, 0);
  });

  it("returns no-marks message when all tool outputs are already marked", async () => {
    const messages: ContextMessageEntry[] = [
      {
        info: { role: "user", id: "u1" },
        parts: [{ type: "text", text: "do it" }],
      },
      {
        info: { role: "assistant", id: "a1" },
        parts: [
          {
            type: "tool",
            callID: "call-only",
            state: { output: "only output" },
            tool: "bash",
          } as any,
        ],
      },
    ];

    // Pre-mark call-only.
    const state = getOrCreateSessionState("sess-already-marked");
    addMark(state, "call-only", 100, true, "tool-output");

    let promptText = "";
    const client: DcpClient = {
      session: {
        messages: async () => ({ data: messages }),
        prompt: async (input: {
          path: { id: string };
          body: {
            noReply?: boolean;
            parts: Array<{ type: string; text: string; ignored?: boolean }>;
          };
        }) => {
          promptText = input.body.parts[0]?.text ?? "";
        },
      },
    };

    // Should NOT throw — no new marks to add.
    await handleDcpCommand(client, "sess-already-marked", "sweep");

    // Should have injected the no-marks message.
    assert.ok(
      promptText.includes("没有找到可标记的工具输出"),
      `expected no-marks message, got: ${promptText}`,
    );
  });
});

describe("/dcp sweep subcommand — parse errors propagate", () => {
  it("throws for 'sweep 0' (not a positive integer)", async () => {
    const client: DcpClient = {
      session: {
        messages: async () => ({ data: [] }),
        prompt: async () => {},
      },
    };

    await assert.rejects(
      () => handleDcpCommand(client, "sess", "sweep 0"),
      /正整数/,
    );
  });

  it("throws for 'sweep -1' (negative)", async () => {
    const client: DcpClient = {
      session: {
        messages: async () => ({ data: [] }),
        prompt: async () => {},
      },
    };

    await assert.rejects(
      () => handleDcpCommand(client, "sess", "sweep -1"),
      /正整数/,
    );
  });
});

// ---------------------------------------------------------------------------
// Compress subcommand tests
// ---------------------------------------------------------------------------

describe("/dcp compress subcommand", () => {
  const SESSION_ID = "sess-compress-test";

  afterEach(() => {
    _clearAllSessionsForTesting();
    deleteSessionState(SESSION_ID);
  });

  /**
   * Create a message fixture where some segments are definitely
   * compressible (long messages far from the protection zone).
   *
   * Each assistant response is long enough that the segment token
   * estimate exceeds the summary token estimate (negative-benefit
   * gate must pass).
   */
  function makeMessages(): ContextMessageEntry[] {
    const msgs: ContextMessageEntry[] = [];

    // First user message (always protected from compression).
    msgs.push({
      info: { role: "user", id: "u0" },
      parts: [{ type: "text", text: "First message in session" }],
    });

    // Add 5 compressible user/assistant exchanges.  Each assistant
    // response is a repetitive block that is long enough to beat
    // the summary both ways (phantom gate + negative-benefit gate).
    for (let i = 1; i <= 5; i++) {
      msgs.push({
        info: { role: "user", id: `u${i}` },
        parts: [{ type: "text", text: `Step ${i}: implement feature` }],
      });
      // Long assistant response (~200 chars) so estimateMessageHeuristic
      // returns many tokens per message (~50 tokens each).
      const longText =
        `Here are the detailed implementation steps for feature number ${i}. `.repeat(
          10,
        );
      msgs.push({
        info: { role: "assistant", id: `a${i}` },
        parts: [{ type: "text", text: longText }],
      });
    }

    // Protected zone messages.
    msgs.push({
      info: { role: "user", id: "u-last" },
      parts: [{ type: "text", text: "Final request" }],
    });
    msgs.push({
      info: { role: "assistant", id: "a-last" },
      parts: [{ type: "text", text: "Final response" }],
    });

    return msgs;
  }

  it("enabled=false → command refuses with notice, no state writes", async () => {
    let promptText = "";
    const promptClient: DcpClient = {
      session: {
        messages: async () => ({ data: [] }),
        prompt: async (input: {
          path: { id: string };
          body: {
            noReply?: boolean;
            parts: Array<{ type: string; text: string; ignored?: boolean }>;
          };
        }) => {
          promptText = input.body.parts[0]?.text ?? "";
        },
      },
    };

    await handleDcpCommand(promptClient, "sess-compress-disabled", "compress", {
      dedup: {},
      purgeErrors: {},
      compress: { enabled: false },
    });

    assert.ok(
      promptText.includes("压缩功能未启用"),
      `expected "压缩功能未启用" in prompt, got: ${promptText}`,
    );

    // State should be empty (no writes).
    const state = getOrCreateSessionState("sess-compress-disabled");
    assert.equal(state.blocks.size, 0);
  });

  it("empty plan → replies 无可压缩内容, no state writes", async () => {
    let promptText = "";
    const promptClient: DcpClient = {
      session: {
        messages: async () => ({
          data: [
            {
              info: { role: "user", id: "only-msg" },
              parts: [{ type: "text", text: "hi" }],
            },
          ],
        }),
        prompt: async (input: {
          path: { id: string };
          body: {
            noReply?: boolean;
            parts: Array<{ type: string; text: string; ignored?: boolean }>;
          };
        }) => {
          promptText = input.body.parts[0]?.text ?? "";
        },
      },
    };

    await handleDcpCommand(promptClient, "sess-empty-plan", "compress", {
      dedup: {},
      purgeErrors: {},
      protectedMessages: 2,
      compress: { enabled: true, thresholdTokens: 1, protectedTokens: 1 },
    });

    assert.ok(
      promptText.includes("无可压缩内容"),
      `expected "无可压缩内容" in prompt, got: ${promptText}`,
    );

    const state = getOrCreateSessionState("sess-empty-plan");
    assert.equal(state.blocks.size, 0);
  });

  it("creates blocks for compressible segments, does NOT modify message list", async () => {
    const messages = makeMessages();
    let promptText = "";
    let promptNoReply: boolean | undefined;
    let promptIgnored: boolean | undefined;

    const client: DcpClient = {
      session: {
        messages: async () => ({ data: messages }),
        prompt: async (input: {
          path: { id: string };
          body: {
            noReply?: boolean;
            parts: Array<{ type: string; text: string; ignored?: boolean }>;
          };
        }) => {
          promptText = input.body.parts[0]?.text ?? "";
          promptNoReply = input.body.noReply;
          promptIgnored = input.body.parts[0]?.ignored;
        },
      },
    };

    await handleDcpCommand(client, SESSION_ID, "compress", {
      dedup: {},
      purgeErrors: {},
      protectedMessages: 2,
      compress: { enabled: true, thresholdTokens: 1, protectedTokens: 1 },
    });

    // State should have blocks.
    const state = getOrCreateSessionState(SESSION_ID);
    assert.ok(
      state.blocks.size > 0,
      "expected at least one block to be created",
    );

    // Message list unchanged (two-phase discipline).
    assert.equal(messages.length, makeMessages().length);

    // Notification is ignored + noReply.
    assert.equal(promptNoReply, true);
    assert.equal(promptIgnored, true);
    assert.ok(
      promptText.includes("已压缩"),
      `expected "已压缩" in prompt, got: ${promptText}`,
    );
    assert.ok(
      promptText.includes("tokens"),
      `expected "tokens" in prompt, got: ${promptText}`,
    );
  });

  it("repeat execution is idempotent (already-compressed messages excluded)", async () => {
    const messages = makeMessages();

    const client: DcpClient = {
      session: {
        messages: async () => ({ data: messages }),
        prompt: async () => {
          // noop — first execution
        },
      },
    };

    // First execution — creates blocks.
    await handleDcpCommand(client, SESSION_ID, "compress", {
      dedup: {},
      purgeErrors: {},
      protectedMessages: 2,
      compress: { enabled: true, thresholdTokens: 1, protectedTokens: 1 },
    });

    const stateAfterFirst = getOrCreateSessionState(SESSION_ID);
    const firstBlockCount = stateAfterFirst.blocks.size;
    assert.ok(firstBlockCount > 0, "first execution should create blocks");

    // Second execution — should find nothing new to compress.
    let secondPromptText = "";
    const secondClient: DcpClient = {
      session: {
        messages: async () => ({ data: messages }),
        prompt: async (input: {
          path: { id: string };
          body: {
            noReply?: boolean;
            parts: Array<{ type: string; text: string; ignored?: boolean }>;
          };
        }) => {
          secondPromptText = input.body.parts[0]?.text ?? "";
        },
      },
    };

    await handleDcpCommand(secondClient, SESSION_ID, "compress", {
      dedup: {},
      purgeErrors: {},
      protectedMessages: 2,
      compress: { enabled: true, thresholdTokens: 1, protectedTokens: 1 },
    });

    const stateAfterSecond = getOrCreateSessionState(SESSION_ID);
    assert.equal(
      stateAfterSecond.blocks.size,
      firstBlockCount,
      "block count should not increase on second execution",
    );

    assert.ok(
      secondPromptText.includes("无可压缩内容"),
      `expected "无可压缩内容" on repeat, got: ${secondPromptText}`,
    );
  });

  it("log includes compress_created with blockId/message count/in-out tokens", async () => {
    const messages = makeMessages();
    _resetForTesting();

    const client: DcpClient = {
      session: {
        messages: async () => ({ data: messages }),
        prompt: async () => {},
      },
    };

    await handleDcpCommand(client, SESSION_ID, "compress", {
      dedup: {},
      purgeErrors: {},
      protectedMessages: 2,
      compress: { enabled: true, thresholdTokens: 1, protectedTokens: 1 },
    });

    const buffer = _getBufferForTesting();
    const logEntries = buffer.filter((e) => e.event === "compress_created");
    assert.ok(
      logEntries.length > 0,
      "expected at least one compress_created log entry",
    );

    for (const entry of logEntries) {
      const e = entry as Record<string, unknown>;
      assert.ok(typeof e.blockId === "number", "blockId should be a number");
      assert.ok(
        typeof e.messageCount === "number",
        "messageCount should be a number",
      );
      assert.ok(typeof e.inTokens === "number", "inTokens should be a number");
      assert.ok(
        typeof e.outTokens === "number",
        "outTokens should be a number",
      );
    }
  });
});
