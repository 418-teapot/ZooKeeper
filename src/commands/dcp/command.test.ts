/**
 * Tests for the `/dcp` command handler (src/commands/dcp/command.ts).
 *
 * Covers: fetching messages, injecting ignored prompt, unknown
 * subcommand help, empty messages, unavailable client APIs, sweep
 * selection semantics and the compress gate.  State is exercised through
 * the new host-agnostic core: the shared session-state manager
 * (`getContextStateManager`) and its store.
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { history } from "../../adapters/opencode/history.js";
import type { ContextMessageEntry } from "../../adapters/opencode/types.js";
import type { SessionClient } from "../../core/client/session.js";
import { estimateTokenCount } from "../../core/context/measure.js";
import { PRUNED_TOOL_OUTPUT_REPLACEMENT } from "../../core/context/message-parts.js";
import {
  computeEdits,
  flipReleasedMarks,
  pendingTokens,
  reclaimedTokens,
} from "../../core/context/release.js";
import {
  _resetContextStateManagerForTesting,
  consumePendingViewChange,
  getContextStateManager,
  getRuntimeFlaggedState,
} from "../../core/context/runtime.js";
import { markKey } from "../../core/context/state.js";
import { _resetForTesting } from "../../utils/logger.js";
import { handleDcpCommand, parseSweepCount } from "./command.js";

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
  const manager = getContextStateManager();
  for (const sid of SWEEP_TEST_SESSION_IDS) {
    manager.store.delete(sid);
  }
  _resetContextStateManagerForTesting();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Create a mock client that returns given messages and tracks prompt calls.
 */
function mockClient(messages: ContextMessageEntry[]): {
  client: SessionClient;
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

  const client: SessionClient = {
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
    const client: SessionClient = {}; // no session at all
    await assert.rejects(
      () => handleDcpCommand(client, "sess-9", "context"),
      /无法获取/,
    );
  });

  it("throws when response contains error object (HTTP error)", async () => {
    const client: SessionClient = {
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
// Module exports
// ---------------------------------------------------------------------------

describe("module exports", () => {
  it("exports handleDcpCommand as a function", () => {
    assert.equal(typeof handleDcpCommand, "function");
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
    const client: SessionClient = {
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

    // Verify state was populated.  New-core marks are keyed by
    // `(ordinal, regionIndex)`: the assistant message is ordinal 1, and
    // its two tool parts map to regions [0]=input, [1]=output for
    // call-1 and [2]=input, [3]=output for call-2.
    const state = getContextStateManager().get("sess-sweep-success");
    assert.equal(state.marks.size, 2);
    assert.ok(state.marks.has(markKey(1, 1)));
    assert.ok(state.marks.has(markKey(1, 3)));

    // Token estimates reflect net reclaim (output - placeholder).
    const placeholderTokens = estimateTokenCount(
      PRUNED_TOOL_OUTPUT_REPLACEMENT,
    );
    const est1 = state.marks.get(markKey(1, 1))?.contentTokens ?? 0;
    const est2 = state.marks.get(markKey(1, 3))?.contentTokens ?? 0;
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

    // Sweep marks are pending; pendingTokens carries the reclaim total
    // until the next transform release flips them effective.
    assert.equal(
      pendingTokens(state),
      est1 + est2,
      "pendingTokens should reflect the sweep marks",
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
    const client: SessionClient = {
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

    const state = getContextStateManager().get("sess-short-output");
    assert.equal(state.marks.size, 1);
    assert.ok(state.marks.has(markKey(1, 1)));

    // contentTokens should be floored to 0 because "ok" (2 chars)
    // yields fewer tokens than the placeholder.
    const estValue = state.marks.get(markKey(1, 1))?.contentTokens ?? -1;
    assert.equal(estValue, 0, "short output should have 0 estimated tokens");

    // pendingTokens should NOT be inflated by the negative estimate.
    // Since contentTokens is 0, pendingTokens must stay at 0.
    assert.equal(
      pendingTokens(state),
      0,
      "pendingTokens should not change when contentTokens is 0",
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

    const client: SessionClient = {
      session: {
        messages: async () => ({ data: messages }),
        prompt: async () => {},
      },
    };

    await handleDcpCommand(client, "sess-sweep-1", "sweep 1");

    const state = getContextStateManager().get("sess-sweep-1");
    assert.equal(state.marks.size, 1);
    assert.ok(
      state.marks.has(markKey(1, 1)),
      "expected the most recent tool to be marked",
    );
    assert.ok(
      !state.marks.has(markKey(0, 1)),
      "expected the older tool to stay unmarked",
    );
  });

  it("totalPruneTokens accumulates once at mark time, NOT doubled by the release pass", async () => {
    // Simulate a sweep followed by two transform turns (release calls).
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

    const client: SessionClient = {
      session: {
        messages: async () => ({ data: messages }),
        prompt: async () => {},
      },
    };

    // Sweep (mark time): the reclaim total accumulates here; the sweep
    // arms the pending-view-change flag consumed by the next release.
    const sessionID = "sess-no-double";
    await handleDcpCommand(client, sessionID, "sweep");

    const state = getContextStateManager().get(sessionID);
    const markTimeValue = pendingTokens(state);
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
      "pendingTokens should be net reclaim after sweep",
    );

    // Transform turn 1: the release pass consumes the view-change flag
    // and flips the pending mark effective — the reclaim total moves to
    // the effective side without doubling.  The edit selection confirms
    // the release pass targets the pending sweep mark's region; the flip
    // performs the state half.
    const turn1View = history(messages);
    const viewChange = consumePendingViewChange(sessionID);
    const turn1Edits = computeEdits(state, turn1View, {
      promptTokens: 0,
      pendingViewChange: viewChange,
    });
    assert.equal(turn1Edits.length, 1, "the pending sweep mark is released");
    flipReleasedMarks(state, {
      promptTokens: 0,
      pendingViewChange: viewChange,
    });
    assert.equal(
      reclaimedTokens(state),
      markTimeValue,
      "release should move the reclaim total to effective, not double it (turn 1)",
    );
    assert.equal(
      pendingTokens(state),
      0,
      "no pending tokens remain after the release (turn 1)",
    );

    // Transform turn 2: reloaded from DB (output reverted to original),
    // the release applies again.  reclaimedTokens still unchanged.
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
    // The now-effective mark still selects an edit; the closed gate
    // (promptTokens 0, no bypass) flips nothing.
    const turn2Edits = computeEdits(state, history(reloadedMessages), {
      promptTokens: 0,
      pendingViewChange: false,
    });
    assert.equal(turn2Edits.length, 1, "the effective mark is re-applied");
    flipReleasedMarks(state, {
      promptTokens: 0,
      pendingViewChange: false,
    });
    assert.equal(
      reclaimedTokens(state),
      markTimeValue,
      "release should NOT change reclaimedTokens across multiple turns",
    );
  });

  it("persists sweep marks to disk immediately via the shared manager", async () => {
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

    const client: SessionClient = {
      session: {
        messages: async () => ({ data: messages }),
        prompt: async () => {},
      },
    };

    await handleDcpCommand(client, sessionID, "sweep");

    // Verify marks survive a store reload (disk persistence).
    const manager = getContextStateManager();
    const persisted = manager.store.load(sessionID);
    assert.ok(persisted.marks.has(markKey(1, 1)), "mark persisted to disk");
    assert.ok(
      (persisted.marks.get(markKey(1, 1))?.contentTokens ?? 0) >= 0,
      "persisted estimate must be non-negative",
    );

    // Clean up persisted file.
    manager.store.delete(sessionID);
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
    const client: SessionClient = {
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
    const state = getContextStateManager().get("sess-no-tools");
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

    // Pre-mark the position the sweep would claim (ordinal 1, tool-output
    // region index 1).
    const state = getContextStateManager().get("sess-already-marked");
    state.marks.set(markKey(1, 1), {
      anchorOrdinal: 1,
      regionIndex: 1,
      content: "only output",
      contentTokens: 100,
      effective: true,
      markedAt: Date.now(),
    });

    let promptText = "";
    const client: SessionClient = {
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
    const client: SessionClient = {
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
    const client: SessionClient = {
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
    const manager = getContextStateManager();
    manager.store.delete(SESSION_ID);
    _resetContextStateManagerForTesting();
  });

  /** Gate-open config — compress section strictly parsed. */
  const compressConfig: Parameters<typeof handleDcpCommand>[3] = {
    dedup: {},
    purgeErrors: {},
    protectedMessages: 2,
    compress: { thresholdTokens: 1, protectedTokens: 1 },
  };

  it("compress tool not registered → command refuses with notice, no state writes", async () => {
    let promptText = "";
    const promptClient: SessionClient = {
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

    // Valid compress section, but the tool is NOT in the profile tools.
    await handleDcpCommand(
      promptClient,
      "sess-compress-disabled",
      "compress",
      {
        dedup: {},
        purgeErrors: {},
        compress: { thresholdTokens: 1, protectedTokens: 1 },
      },
      false,
    );

    assert.ok(
      promptText.includes("压缩功能未启用"),
      `expected "压缩功能未启用" in prompt, got: ${promptText}`,
    );

    // State should be empty (no flag, no writes).
    const state = getRuntimeFlaggedState("sess-compress-disabled");
    assert.equal(state.blocks.size, 0);
    assert.equal(state.pendingManualTrigger, undefined);
  });

  it("compress section absent → command refuses with notice, no state writes", async () => {
    let promptText = "";
    const promptClient: SessionClient = {
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

    // Tool registered in the profile, but the compress section is absent.
    await handleDcpCommand(
      promptClient,
      "sess-compress-absent",
      "compress",
      {
        dedup: {},
        purgeErrors: {},
      },
      true,
    );

    assert.ok(
      promptText.includes("压缩功能未启用"),
      `expected "压缩功能未启用" in prompt, got: ${promptText}`,
    );

    // State should be empty (no flag, no writes).
    const state = getRuntimeFlaggedState("sess-compress-absent");
    assert.equal(state.blocks.size, 0);
    assert.equal(state.pendingManualTrigger, undefined);
  });

  it("arms the one-shot trigger and notifies; creates no blocks, fetches no messages", async () => {
    // The client deliberately has NO session.messages — arming the trigger
    // must not fetch the message list (the mechanical pipeline is gone).
    let promptNoReply: boolean | undefined;
    let promptIgnored: boolean | undefined;
    let promptText = "";
    const client: SessionClient = {
      session: {
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

    await handleDcpCommand(
      client,
      SESSION_ID,
      "compress",
      compressConfig,
      true,
    );

    // Notification is ignored + noReply and tells the user about the
    // next-turn trigger.
    assert.equal(promptNoReply, true);
    assert.equal(promptIgnored, true);
    assert.ok(
      promptText.includes("下一轮"),
      `expected next-turn trigger notice, got: ${promptText}`,
    );

    // One-shot in-memory flag set; no blocks; the flag is never
    // persisted (the state file stays absent).
    const state = getRuntimeFlaggedState(SESSION_ID);
    assert.equal(state.pendingManualTrigger, true, "one-shot flag set");
    assert.equal(state.blocks.size, 0, "no blocks created");
  });

  it("repeat /dcp compress keeps the flag armed (idempotent)", async () => {
    const client: SessionClient = {
      session: { prompt: async () => {} },
    };

    await handleDcpCommand(
      client,
      SESSION_ID,
      "compress",
      compressConfig,
      true,
    );
    await handleDcpCommand(
      client,
      SESSION_ID,
      "compress",
      compressConfig,
      true,
    );

    const state = getRuntimeFlaggedState(SESSION_ID);
    assert.equal(state.pendingManualTrigger, true, "flag stays armed");
    assert.equal(state.blocks.size, 0);
  });
});
