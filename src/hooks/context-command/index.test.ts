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
import { _clearAllSessionsForTesting } from "../../core/pruning/state.js";
import { _resetForTesting } from "../../utils/logger.js";
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
    assert.equal(state.prune.tools.size, 2);
    assert.ok(state.prune.tools.has("call-1"));
    assert.ok(state.prune.tools.has("call-2"));

    // Token estimates reflect net reclaim (output - placeholder).
    const placeholderTokens = estimateTokenCount(
      PRUNED_TOOL_OUTPUT_REPLACEMENT,
    );
    const est1 = state.prune.tools.get("call-1") ?? 0;
    const est2 = state.prune.tools.get("call-2") ?? 0;
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

    // totalPruneTokens accumulates at mark time: should equal sum of estimates.
    assert.equal(
      state.stats.totalPruneTokens,
      est1 + est2,
      "totalPruneTokens should be accumulated at sweep (mark) time",
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
    assert.equal(state.prune.tools.size, 1);
    assert.ok(state.prune.tools.has("call-short"));

    // estimatedTokens should be floored to 0 because "ok" (2 chars)
    // yields fewer tokens than the placeholder.
    const estValue = state.prune.tools.get("call-short") ?? -1;
    assert.equal(estValue, 0, "short output should have 0 estimated tokens");

    // totalPruneTokens should NOT be inflated by the negative estimate.
    // Since estimatedTokens is 0, totalPruneTokens must stay at 0.
    assert.equal(
      state.stats.totalPruneTokens,
      0,
      "totalPruneTokens should not change when estimatedTokens is 0",
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
    assert.equal(state.prune.tools.size, 1);
    assert.ok(
      state.prune.tools.has("call-recent"),
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
    const markTimeValue = state.stats.totalPruneTokens;
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
      "totalPruneTokens should be net reclaim after sweep",
    );

    // Transform turn 1: pruneToolOutputs replaces output but does NOT
    // touch totalPruneTokens.
    pruneToolOutputs(state, messages);
    assert.equal(
      state.stats.totalPruneTokens,
      markTimeValue,
      "prune should NOT change totalPruneTokens (turn 1)",
    );

    // Transform turn 2: reloaded from DB (output reverted to original),
    // prune runs again.  totalPruneTokens still unchanged.
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
      state.stats.totalPruneTokens,
      markTimeValue,
      "prune should NOT change totalPruneTokens across multiple turns",
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
    assert.ok(persisted.prune.tools.has("call-persist"));
    assert.ok(
      (persisted.prune.tools.get("call-persist") ?? 0) >= 0,
      "persisted estimate must be non-negative",
    );
    assert.ok(
      persisted.stats.totalPruneTokens >= 0,
      "persisted totalPruneTokens must be non-negative",
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

    // State prune map should be empty.
    const state = getOrCreateSessionState("sess-no-tools");
    assert.equal(state.prune.tools.size, 0);
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
    state.prune.tools.set("call-only", 100);

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
