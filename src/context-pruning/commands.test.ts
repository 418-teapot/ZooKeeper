/**
 * Tests for {@link commands} — /dcp slash command handlers.
 *
 * Covers:
 * - dispatchCommand returns null for unknown subcommand
 * - /dcp context format and breakdown
 * - /dcp stats format
 * - /dcp sweep without and with N argument
 * - /dcp decompress list (no arg)
 * - /dcp decompress non-existent block
 * - /dcp recompress list (no arg)
 * - /dcp recompress non-existent block
 * - formatTokenCount and formatPrunedItemsList helpers
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  type CommandContext,
  dispatchCommand,
  formatPrunedItemsList,
  formatTokenCount,
} from "./commands";
import type { ContextPruningConfig, MessageRef, SessionState } from "./types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Create a minimal config for testing commands.
 */
function testConfig(
  overrides?: Partial<ContextPruningConfig>,
): ContextPruningConfig {
  return {
    enabled: true,
    nudgeThresholdTokens: 200_000,
    urgentThresholdTokens: 400_000,
    dedupEnabled: false,
    purgeErrorsEnabled: false,
    purgeErrorsTurns: 3,
    compressMode: "range",
    compressEnabled: false,
    nudgeFrequency: 5,
    compressLlmEnabled: false,
    compressMessageModeEnabled: false,
    commandsEnabled: true,
    persistState: false,
    protectedTools: ["task", "skill", "question"],
    turnProtection: 2,
    protectUserMessages: false,
    dedupProtectedTools: ["task", "skill", "read"],
    purgeErrorsProtectedTools: ["task", "skill"],
    protectedFilePatterns: [],
    ...overrides,
  };
}

/**
 * Create a minimal {@link MessageRef} for tests.
 */
function msg(
  id: string,
  role: MessageRef["role"],
  content: string,
  overrides?: Partial<MessageRef>,
): MessageRef {
  return { id, role, content, ...overrides };
}

/**
 * Build a {@link CommandContext} from minimal pieces.
 */
function buildContext(overrides: Partial<CommandContext>): CommandContext {
  return {
    sessionId: "test-session",
    state: {
      sessionId: "test-session",
      blocksById: new Map(),
      byMessageId: new Map(),
      activeBlockIds: new Set(),
      activeByAnchorMessageId: new Map(),
      dedupCache: new Map(),
      errorTracking: new Map(),
      protectedTurns: 2,
      turnCount: 5,
      nudgeCounter: 0,
      nextBlockId: 1,
      nextRunId: 1,
      lastAccessedAt: Date.now(),
      totalPrunedTokens: 0,
      totalCompressedTokens: 0,
      prune: { tools: new Map(), prunedCallIds: new Set() },
    } as SessionState,
    config: testConfig(),
    messages: [],
    args: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// (a) dispatch unknown subcommand
// ---------------------------------------------------------------------------

describe("dispatchCommand", () => {
  it("returns null for unknown subcommand", () => {
    const ctx = buildContext({});
    const result = dispatchCommand("unknown", ctx);
    assert.equal(result, null);
  });

  it("returns null for empty subcommand", () => {
    const ctx = buildContext({});
    const result = dispatchCommand("", ctx);
    assert.equal(result, null);
  });

  it("returns a string for known subcommand 'context'", () => {
    const ctx = buildContext({});
    const result = dispatchCommand("context", ctx);
    assert.ok(typeof result === "string");
    assert.ok(result.length > 0);
  });

  it("returns a string for known subcommand 'stats'", () => {
    const ctx = buildContext({});
    const result = dispatchCommand("stats", ctx);
    assert.ok(typeof result === "string");
    assert.ok(result.length > 0);
  });
});

// ---------------------------------------------------------------------------
// (b) /dcp context — token breakdown format
// ---------------------------------------------------------------------------

describe("/dcp context", () => {
  it("shows breakdown with multiple roles", () => {
    const ctx = buildContext({
      messages: [
        msg("m0000", "system", "You are a helpful assistant."),
        msg("m0001", "user", "Hello, how are you?"),
        msg("m0002", "assistant", "I am doing well, thank you!"),
        msg("m0003", "tool", "", {
          toolResults: [
            {
              id: "tr0000",
              toolCallId: "t0000",
              output: "some file content here",
            },
          ],
        }),
      ],
    });

    const result = dispatchCommand("context", ctx);
    assert.ok(result);
    // Should contain the box drawing characters
    assert.ok(result.includes("╭─ Context Token Breakdown"));
    assert.ok(result.includes("System"));
    assert.ok(result.includes("User"));
    assert.ok(result.includes("Assistant"));
    assert.ok(result.includes("Tools"));
    assert.ok(result.includes("Total"));
    assert.ok(result.includes("╰"));
  });

  it("shows pruned tokens line when totalPrunedTokens > 0", () => {
    const ctx = buildContext({
      state: {
        sessionId: "test-session",
        blocksById: new Map(),
        byMessageId: new Map(),
        activeBlockIds: new Set(),
        activeByAnchorMessageId: new Map(),
        dedupCache: new Map(),
        errorTracking: new Map(),
        protectedTurns: 2,
        turnCount: 5,
        nudgeCounter: 0,
        nextBlockId: 1,
        nextRunId: 1,
        lastAccessedAt: Date.now(),
        totalPrunedTokens: 1500,
        totalCompressedTokens: 0,
        prune: { tools: new Map(), prunedCallIds: new Set() },
      } as SessionState,
      messages: [msg("m0000", "user", "hi")],
    });

    const result = dispatchCommand("context", ctx);
    assert.ok(result);
    assert.ok(result.includes("Pruned"));
    assert.ok(result.includes("1.5K"));
  });

  it("does not show Pruned line when totalPrunedTokens is 0", () => {
    const ctx = buildContext({
      messages: [msg("m0000", "user", "hi")],
    });
    const result = dispatchCommand("context", ctx);
    assert.ok(result);
    assert.ok(!result.includes("Pruned"));
  });

  it("handles empty messages array", () => {
    const ctx = buildContext({ messages: [] });
    const result = dispatchCommand("context", ctx);
    assert.ok(result);
    assert.ok(result.includes("Total"));
  });
});

// ---------------------------------------------------------------------------
// (c) /dcp stats — compression statistics format
// ---------------------------------------------------------------------------

describe("/dcp stats", () => {
  it("shows zero stats when no blocks exist", () => {
    const ctx = buildContext({});
    const result = dispatchCommand("stats", ctx);
    assert.ok(result);
    assert.ok(result.includes("Active blocks"));
    assert.ok(result.includes("Total pruned"));
    assert.ok(result.includes("Net savings"));
  });

  it("includes active block counts and compression ratio", () => {
    const state = {
      sessionId: "test-session",
      blocksById: new Map([
        [
          1,
          {
            blockId: 1,
            runId: 1,
            active: true,
            deactivatedByUser: false,
            compressedTokens: 5000,
            summaryTokens: 200,
            mode: "range" as const,
            topic: "Test block",
            createdAt: 100,
            anchorMessageId: "m0000",
            compressMessageId: "m0001",
            durationMs: 50,
            consumedBlockIds: [],
            parentBlockIds: [],
            includedBlockIds: [1],
            startId: "m0000",
            endId: "m0003",
            directMessageIds: ["m0000"],
            directToolIds: ["t0000"],
            effectiveMessageIds: ["m0000"],
            effectiveToolIds: ["t0000"],
            summary: "test",
          },
        ],
        [
          2,
          {
            blockId: 2,
            runId: 1,
            active: false, // inactive — should not be counted
            deactivatedByUser: true,
            compressedTokens: 3000,
            summaryTokens: 150,
            mode: "range" as const,
            topic: "Inactive block",
            createdAt: 200,
            anchorMessageId: "m0004",
            compressMessageId: "m0005",
            durationMs: 50,
            consumedBlockIds: [],
            parentBlockIds: [],
            includedBlockIds: [2],
            startId: "m0004",
            endId: "m0006",
            directMessageIds: ["m0004"],
            directToolIds: ["t0001"],
            effectiveMessageIds: ["m0004"],
            effectiveToolIds: ["t0001"],
            summary: "inactive",
          },
        ],
      ]),
      byMessageId: new Map(),
      activeBlockIds: new Set([1]),
      activeByAnchorMessageId: new Map([["m0000", 1]]),
      dedupCache: new Map(),
      errorTracking: new Map(),
      protectedTurns: 2,
      turnCount: 5,
      nudgeCounter: 0,
      nextBlockId: 3,
      nextRunId: 2,
      lastAccessedAt: Date.now(),
      totalPrunedTokens: 1200,
      totalCompressedTokens: 5000,
      prune: { tools: new Map(), prunedCallIds: new Set() },
    } as SessionState;

    const ctx = buildContext({ state });
    const result = dispatchCommand("stats", ctx);
    assert.ok(result);
    assert.ok(result.includes("Active blocks"));
    assert.ok(result.includes("1")); // 1 active block
    assert.ok(result.includes("1.2K")); // total pruned
    assert.ok(result.includes("5.0K")); // compressed tokens
    assert.ok(result.includes("200")); // summary tokens (200)
    assert.ok(result.includes("4.8K")); // net savings ≈ 5000-200 = 4800
    assert.ok(result.includes("25.0")); // ratio = 5000/200 = 25.0
  });

  it("shows ratio dash when no summary tokens", () => {
    const state = {
      sessionId: "test-session",
      blocksById: new Map([
        [
          1,
          {
            blockId: 1,
            runId: 1,
            active: true,
            deactivatedByUser: false,
            compressedTokens: 100,
            summaryTokens: 0,
            mode: "range" as const,
            topic: "Empty summary",
            createdAt: 100,
            anchorMessageId: "m0000",
            compressMessageId: "m0001",
            durationMs: 50,
            consumedBlockIds: [],
            parentBlockIds: [],
            includedBlockIds: [1],
            startId: "m0000",
            endId: "m0001",
            directMessageIds: ["m0000"],
            directToolIds: ["t0000"],
            effectiveMessageIds: ["m0000"],
            effectiveToolIds: ["t0000"],
            summary: "",
          },
        ],
      ]),
      byMessageId: new Map(),
      activeBlockIds: new Set([1]),
      activeByAnchorMessageId: new Map([["m0000", 1]]),
      dedupCache: new Map(),
      errorTracking: new Map(),
      protectedTurns: 2,
      turnCount: 5,
      nudgeCounter: 0,
      nextBlockId: 2,
      nextRunId: 2,
      lastAccessedAt: Date.now(),
      totalPrunedTokens: 0,
      totalCompressedTokens: 100,
      prune: { tools: new Map(), prunedCallIds: new Set() },
    } as SessionState;

    const ctx = buildContext({ state });
    const result = dispatchCommand("stats", ctx);
    assert.ok(result);
    assert.ok(result.includes("—")); // dash for ratio
  });
});

// ---------------------------------------------------------------------------
// (d) /dcp sweep — tool output pruning
// ---------------------------------------------------------------------------

describe("/dcp sweep", () => {
  it("sweeps unprotected tool outputs", () => {
    const ctx = buildContext({
      messages: [
        msg("m0000", "user", "read a.ts"),
        msg("m0001", "assistant", "", {
          toolCalls: [
            { id: "t0000", toolName: "read", parameters: { path: "a.ts" } },
          ],
        }),
        msg("m0002", "tool", "", {
          toolResults: [
            { id: "tr0000", toolCallId: "t0000", output: "file content here" },
          ],
        }),
      ],
    });

    const result = dispatchCommand("sweep", ctx);
    assert.ok(result);
    assert.ok(result.includes("Swept 1 tool output"));
    assert.ok(result.includes("read"));

    // State should have been updated
    assert.ok(ctx.state.prune.tools.has("t0000"));
    assert.ok(ctx.state.prune.prunedCallIds.has("t0000"));
    assert.ok(ctx.state.totalPrunedTokens > 0);
  });

  it("skips protected tools", () => {
    const ctx = buildContext({
      config: testConfig({ protectedTools: ["read"] }),
      messages: [
        msg("m0000", "user", "read a.ts"),
        msg("m0001", "assistant", "", {
          toolCalls: [
            { id: "t0000", toolName: "read", parameters: { path: "a.ts" } },
          ],
        }),
        msg("m0002", "tool", "", {
          toolResults: [
            { id: "tr0000", toolCallId: "t0000", output: "file content" },
          ],
        }),
      ],
    });

    const result = dispatchCommand("sweep", ctx);
    assert.ok(result);
    assert.ok(result.includes("No tool outputs"));
    assert.equal(ctx.state.prune.tools.size, 0);
  });

  it("sweeps last N tool calls with numeric argument", () => {
    const ctx = buildContext({
      config: testConfig({ protectedTools: [] }),
      messages: [
        msg("m0000", "user", "do things"),
        msg("m0001", "assistant", "", {
          toolCalls: [
            {
              id: "t0000",
              toolName: "bash",
              parameters: { command: "echo 1" },
            },
          ],
        }),
        msg("m0002", "tool", "", {
          toolResults: [
            { id: "tr0000", toolCallId: "t0000", output: "result 1" },
          ],
        }),
        msg("m0003", "assistant", "", {
          toolCalls: [
            {
              id: "t0001",
              toolName: "bash",
              parameters: { command: "echo 2" },
            },
          ],
        }),
        msg("m0004", "tool", "", {
          toolResults: [
            { id: "tr0001", toolCallId: "t0001", output: "result 2" },
          ],
        }),
      ],
      args: ["1"],
    });

    const result = dispatchCommand("sweep", ctx);
    assert.ok(result);
    assert.ok(result.includes("Swept 1 tool output"));
    // Only the last tool call should be pruned
    assert.ok(!ctx.state.prune.tools.has("t0000"));
    assert.ok(ctx.state.prune.tools.has("t0001"));
  });

  it("handles no eligible tool outputs gracefully", () => {
    const ctx = buildContext({
      messages: [msg("m0000", "user", "hello")],
    });
    const result = dispatchCommand("sweep", ctx);
    assert.ok(result);
    assert.ok(result.includes("No tool outputs"));
  });

  it("rejects non-positive N argument", () => {
    const ctx = buildContext({ args: ["-1"] });
    const result = dispatchCommand("sweep", ctx);
    assert.ok(result);
    assert.ok(result.includes("Usage"));
  });
});

// ---------------------------------------------------------------------------
// (e) /dcp decompress — list and restore blocks
// ---------------------------------------------------------------------------

describe("/dcp decompress", () => {
  it("lists active blocks when no argument given", () => {
    const state = {
      sessionId: "test-session",
      blocksById: new Map([
        [
          1,
          {
            blockId: 1,
            runId: 1,
            active: true,
            deactivatedByUser: false,
            compressedTokens: 5000,
            summaryTokens: 200,
            mode: "range" as const,
            topic: "build output",
            createdAt: 100,
            anchorMessageId: "m0000",
            compressMessageId: "m0001",
            durationMs: 50,
            consumedBlockIds: [],
            parentBlockIds: [],
            includedBlockIds: [1],
            startId: "m0000",
            endId: "m0003",
            directMessageIds: ["m0000"],
            directToolIds: ["t0000"],
            effectiveMessageIds: ["m0000"],
            effectiveToolIds: ["t0000"],
            summary: "build output compressed",
          },
        ],
      ]),
      byMessageId: new Map(),
      activeBlockIds: new Set([1]),
      activeByAnchorMessageId: new Map([["m0000", 1]]),
      dedupCache: new Map(),
      errorTracking: new Map(),
      protectedTurns: 2,
      turnCount: 5,
      nudgeCounter: 0,
      nextBlockId: 2,
      nextRunId: 2,
      lastAccessedAt: Date.now(),
      totalPrunedTokens: 0,
      totalCompressedTokens: 5000,
      prune: { tools: new Map(), prunedCallIds: new Set() },
    } as SessionState;

    const ctx = buildContext({ state });
    const result = dispatchCommand("decompress", ctx);
    assert.ok(result);
    assert.ok(result.includes("Active Compression Blocks"));
    assert.ok(result.includes("build output"));
    assert.ok(result.includes("5.0K"));
  });

  it("returns message when no active blocks exist", () => {
    const ctx = buildContext({});
    const result = dispatchCommand("decompress", ctx);
    assert.ok(result);
    assert.ok(result.includes("No active compression blocks"));
  });

  it("returns error for non-existent block", () => {
    const ctx = buildContext({ args: ["999"] });
    const result = dispatchCommand("decompress", ctx);
    assert.ok(result);
    assert.ok(result.includes("not found"));
  });

  it("returns error for already inactive block", () => {
    const state = {
      sessionId: "test-session",
      blocksById: new Map([
        [
          1,
          {
            blockId: 1,
            runId: 1,
            active: false,
            deactivatedByUser: true,
            compressedTokens: 100,
            summaryTokens: 20,
            mode: "range" as const,
            topic: "inactive",
            createdAt: 100,
            anchorMessageId: "m0000",
            compressMessageId: "m0001",
            durationMs: 50,
            consumedBlockIds: [],
            parentBlockIds: [],
            includedBlockIds: [1],
            startId: "m0000",
            endId: "m0001",
            directMessageIds: [],
            directToolIds: [],
            effectiveMessageIds: [],
            effectiveToolIds: [],
            summary: "",
          },
        ],
      ]),
      byMessageId: new Map(),
      activeBlockIds: new Set(),
      activeByAnchorMessageId: new Map(),
      dedupCache: new Map(),
      errorTracking: new Map(),
      protectedTurns: 2,
      turnCount: 5,
      nudgeCounter: 0,
      nextBlockId: 2,
      nextRunId: 2,
      lastAccessedAt: Date.now(),
      totalPrunedTokens: 0,
      totalCompressedTokens: 100,
      prune: { tools: new Map(), prunedCallIds: new Set() },
    } as SessionState;

    const ctx = buildContext({ state, args: ["1"] });
    const result = dispatchCommand("decompress", ctx);
    assert.ok(result);
    assert.ok(result.includes("already inactive"));
  });
});

// ---------------------------------------------------------------------------
// (f) /dcp recompress — list and re-activate blocks
// ---------------------------------------------------------------------------

describe("/dcp recompress", () => {
  it("lists user-decompressed blocks when no argument given", () => {
    const state = {
      sessionId: "test-session",
      blocksById: new Map([
        [
          1,
          {
            blockId: 1,
            runId: 1,
            active: false,
            deactivatedByUser: true,
            compressedTokens: 5000,
            summaryTokens: 200,
            mode: "range" as const,
            topic: "build output",
            createdAt: 100,
            anchorMessageId: "m0000",
            compressMessageId: "m0001",
            durationMs: 50,
            consumedBlockIds: [],
            parentBlockIds: [],
            includedBlockIds: [1],
            startId: "m0000",
            endId: "m0003",
            directMessageIds: [],
            directToolIds: [],
            effectiveMessageIds: [],
            effectiveToolIds: [],
            summary: "",
          },
        ],
      ]),
      byMessageId: new Map(),
      activeBlockIds: new Set(),
      activeByAnchorMessageId: new Map(),
      dedupCache: new Map(),
      errorTracking: new Map(),
      protectedTurns: 2,
      turnCount: 5,
      nudgeCounter: 0,
      nextBlockId: 2,
      nextRunId: 2,
      lastAccessedAt: Date.now(),
      totalPrunedTokens: 0,
      totalCompressedTokens: 5000,
      prune: { tools: new Map(), prunedCallIds: new Set() },
    } as SessionState;

    const ctx = buildContext({ state });
    const result = dispatchCommand("recompress", ctx);
    assert.ok(result);
    assert.ok(result.includes("Available for Re-compression"));
    assert.ok(result.includes("build output"));
  });

  it("returns message when no user-decompressed blocks exist", () => {
    const ctx = buildContext({});
    const result = dispatchCommand("recompress", ctx);
    assert.ok(result);
    assert.ok(result.includes("No user-decompressed blocks"));
  });

  it("returns error for non-existent block", () => {
    const ctx = buildContext({ args: ["999"] });
    const result = dispatchCommand("recompress", ctx);
    assert.ok(result);
    assert.ok(result.includes("not found"));
  });

  it("returns error for already active block", () => {
    const state = {
      sessionId: "test-session",
      blocksById: new Map([
        [
          1,
          {
            blockId: 1,
            runId: 1,
            active: true,
            deactivatedByUser: false,
            compressedTokens: 100,
            summaryTokens: 20,
            mode: "range" as const,
            topic: "active",
            createdAt: 100,
            anchorMessageId: "m0000",
            compressMessageId: "m0001",
            durationMs: 50,
            consumedBlockIds: [],
            parentBlockIds: [],
            includedBlockIds: [1],
            startId: "m0000",
            endId: "m0001",
            directMessageIds: [],
            directToolIds: [],
            effectiveMessageIds: [],
            effectiveToolIds: [],
            summary: "",
          },
        ],
      ]),
      byMessageId: new Map(),
      activeBlockIds: new Set([1]),
      activeByAnchorMessageId: new Map([["m0000", 1]]),
      dedupCache: new Map(),
      errorTracking: new Map(),
      protectedTurns: 2,
      turnCount: 5,
      nudgeCounter: 0,
      nextBlockId: 2,
      nextRunId: 2,
      lastAccessedAt: Date.now(),
      totalPrunedTokens: 0,
      totalCompressedTokens: 100,
      prune: { tools: new Map(), prunedCallIds: new Set() },
    } as SessionState;

    const ctx = buildContext({ state, args: ["1"] });
    const result = dispatchCommand("recompress", ctx);
    assert.ok(result);
    assert.ok(result.includes("already active"));
  });
});

// ---------------------------------------------------------------------------
// (g) format helpers
// ---------------------------------------------------------------------------

describe("formatTokenCount", () => {
  it("returns raw number for < 1000", () => {
    assert.equal(formatTokenCount(0), "0");
    assert.equal(formatTokenCount(500), "500");
    assert.equal(formatTokenCount(999), "999");
  });

  it("formats thousands as K", () => {
    assert.equal(formatTokenCount(1_000), "1.0K");
    assert.equal(formatTokenCount(12_345), "12.3K");
    assert.equal(formatTokenCount(100_000), "100.0K");
    assert.equal(formatTokenCount(999_999), "1000.0K");
  });

  it("formats millions as M", () => {
    assert.equal(formatTokenCount(1_000_000), "1.0M");
    assert.equal(formatTokenCount(1_234_567), "1.2M");
    assert.equal(formatTokenCount(10_000_000), "10.0M");
  });

  it("formats billions as B", () => {
    assert.equal(formatTokenCount(1_000_000_000), "1.0B");
  });
});

describe("formatPrunedItemsList", () => {
  it("returns 'none' for empty array", () => {
    assert.equal(formatPrunedItemsList([]), "none");
  });

  it("formats a single item", () => {
    assert.equal(
      formatPrunedItemsList([{ toolName: "read", tokens: 1200 }]),
      "read (1.2K)",
    );
  });

  it("formats multiple items with comma separation", () => {
    assert.equal(
      formatPrunedItemsList([
        { toolName: "read", tokens: 1200 },
        { toolName: "bash", tokens: 3000 },
      ]),
      "read (1.2K), bash (3.0K)",
    );
  });

  it("formats items with small token counts", () => {
    assert.equal(
      formatPrunedItemsList([{ toolName: "edit", tokens: 500 }]),
      "edit (500)",
    );
  });
});
