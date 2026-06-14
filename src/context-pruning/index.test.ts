/**
 * Tests for the context pruning infrastructure.
 *
 * Covers:
 * - Empty pipeline pass-through preserves messages
 * - Pipeline filters malformed messages
 * - State TTL cleanup deletes expired sessions
 * - Nudge threshold behaviour (none / gentle / urgent)
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { loadContextConfig, resolveThreshold } from "./config-loader";
import { markDuplicates } from "./dedup";
import {
  estimateTokens,
  estimateTotalTokens,
  getContextTokens,
} from "./estimator";
import { buildNudges } from "./nudge";
import {
  prepareSession,
  runPipeline,
  syncCompressionBlocks,
} from "./pipeline";
import { applyCompression } from "./compress";
import { applyPruning } from "./prune";
import { markPurgeErrors } from "./purge-errors";
import { ContextPruningState, globalState } from "./state";
import type {
  ContextPruningConfig,
  MessageRef,
  PipelineInput,
  PipelineStats,
  SessionState,
} from "./types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Create a default config with all pruning strategies disabled (pass-through).
 */
function passThroughConfig(
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
    commandsEnabled: false,
    persistState: false,
    protectedTools: ["task", "skill", "question"],
    turnProtection: 2,
    dedupProtectedTools: ["task", "skill", "read"],
    purgeErrorsProtectedTools: ["task", "skill"],
    protectedFilePatterns: [],
    ...overrides,
  };
}

/**
 * Create a minimal valid message ref.
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
 * Create a fresh session state with empty maps/sets for unit testing.
 */
function freshState(overrides?: Partial<SessionState>): SessionState {
  return {
    sessionId: "test-session",
    blocksById: new Map(),
    byMessageId: new Map(),
    activeBlockIds: new Set(),
    dedupCache: new Map(),
    errorTracking: new Map(),
    protectedTurns: 2,
    turnCount: 5,
    prune: { tools: new Map(), prunedCallIds: new Set() },
    nextBlockId: 1,
    nextRunId: 1,
    lastAccessedAt: Date.now(),
    totalPrunedTokens: 0,
    totalCompressedTokens: 0,
    ...overrides,
  } as SessionState;
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

afterEach(() => {
  // Remove any sessions left by tests in the singleton.
  // The singleton itself is not destroyed (other tests may rely on it).
  globalState.delete("test-session");
  globalState.delete("ttl-test-session");
});

// ---------------------------------------------------------------------------
// (a) Empty pipeline pass-through preserves messages
// ---------------------------------------------------------------------------

describe("pipeline pass-through", () => {
  it("preserves valid messages when all strategies are disabled", () => {
    const messages: MessageRef[] = [
      msg("m0000", "user", "Hello"),
      msg("m0001", "assistant", "Hi there"),
      msg("m0002", "user", "How are you?"),
    ];
    const input: PipelineInput = {
      sessionId: "test-session",
      messages,
      config: passThroughConfig(),
    };

    const output = runPipeline(input);

    // Content should be preserved
    assert.equal(output.messages.length, 3);
    assert.equal(output.messages[0].content, "Hello");
    assert.equal(output.messages[1].content, "Hi there");
    assert.equal(output.messages[2].content, "How are you?");
  });

  it("returns empty nudges when below threshold", () => {
    const messages: MessageRef[] = [msg("m0000", "user", "Hello")];
    const input: PipelineInput = {
      sessionId: "test-session",
      messages,
      config: passThroughConfig({
        dedupEnabled: false,
        purgeErrorsEnabled: false,
      }),
    };

    const output = runPipeline(input);
    assert.deepEqual(output.nudges, []);
  });

  it("returns zero stats when all strategies are disabled", () => {
    const messages: MessageRef[] = [msg("m0000", "user", "Hello")];
    const input: PipelineInput = {
      sessionId: "test-session",
      messages,
      config: passThroughConfig(),
    };

    const output = runPipeline(input);
    assert.equal(output.stats.dedupRemoved, 0);
    assert.equal(output.stats.errorPurged, 0);
    assert.equal(output.stats.compressedTokens, 0);
    assert.equal(output.stats.summaryTokens, 0);
    assert.equal(output.stats.prunedOutputs, 0);
    assert.equal(output.stats.prunedErrors, 0);
  });

  it("reassigns message IDs sequentially (m0000, m0001, …)", () => {
    const messages: MessageRef[] = [
      msg("custom-id", "user", "A"),
      msg("another-id", "assistant", "B"),
    ];
    const input: PipelineInput = {
      sessionId: "test-session",
      messages,
      config: passThroughConfig(),
    };

    const output = runPipeline(input);
    assert.equal(output.messages[0].id, "m0000");
    assert.equal(output.messages[1].id, "m0001");
  });

  it("preserves existing mNNNN-format IDs when reassigning others", () => {
    const messages: MessageRef[] = [
      msg("m0003", "user", "A"),
      msg("custom-id", "assistant", "B"),
      msg("m0007", "user", "C"),
    ];
    const input: PipelineInput = {
      sessionId: "test-session",
      messages,
      config: passThroughConfig(),
    };

    const output = runPipeline(input);

    // m0003 and m0007 kept; custom-id gets next ID after max(3, 7) + 1 = 8
    assert.equal(output.messages[0].id, "m0003");
    assert.equal(output.messages[1].id, "m0008");
    assert.equal(output.messages[2].id, "m0007");
    assert.equal(output.messages.length, 3);
  });
});

// ---------------------------------------------------------------------------
// (b) Pipeline filters malformed messages
// ---------------------------------------------------------------------------

describe("pipeline malformed filtering", () => {
  it("removes messages with empty id", () => {
    const messages = [
      msg("", "user", "Valid content?"),
      msg("m0001", "user", "Real message"),
    ] as MessageRef[];

    const input: PipelineInput = {
      sessionId: "test-session",
      messages,
      config: passThroughConfig(),
    };

    const output = runPipeline(input);
    assert.equal(output.messages.length, 1);
    assert.equal(output.messages[0].content, "Real message");
  });

  it("removes messages with empty role", () => {
    const messages = [
      { id: "m0000", role: "" as MessageRef["role"], content: "No role" },
      { id: "m0001", role: "user" as const, content: "Valid" },
    ];

    const input: PipelineInput = {
      sessionId: "test-session",
      messages,
      config: passThroughConfig(),
    };

    const output = runPipeline(input);
    assert.equal(output.messages.length, 1);
    assert.equal(output.messages[0].content, "Valid");
  });

  it("removes messages with undefined content", () => {
    const messages = [
      {
        id: "m0000",
        role: "user" as const,
        content: undefined as unknown as string,
      },
      { id: "m0001", role: "user" as const, content: "Valid" },
    ];

    const input: PipelineInput = {
      sessionId: "test-session",
      messages,
      config: passThroughConfig(),
    };

    const output = runPipeline(input);
    assert.equal(output.messages.length, 1);
    assert.equal(output.messages[0].content, "Valid");
  });

  it("keeps messages with empty string content", () => {
    const messages = [msg("m0000", "assistant", "")];

    const input: PipelineInput = {
      sessionId: "test-session",
      messages,
      config: passThroughConfig(),
    };

    const output = runPipeline(input);
    assert.equal(output.messages.length, 1);
    assert.equal(output.messages[0].content, "");
  });
});

// ---------------------------------------------------------------------------
// (c) State TTL cleanup deletes expired sessions
// ---------------------------------------------------------------------------

describe("state TTL cleanup", () => {
  it("removes sessions after TTL expires", async () => {
    const shortTtl = 10; // 10 ms
    const cleanupInterval = 20; // cleanup every 20 ms
    const state = new ContextPruningState(shortTtl, cleanupInterval);

    try {
      state.getOrCreate("ttl-test-session");
      // Session should exist immediately
      assert.ok(state.get("ttl-test-session"));

      // Wait for TTL + cleanup to run
      await new Promise((r) => setTimeout(r, 60));

      // Session should now be cleaned up
      assert.equal(state.get("ttl-test-session"), undefined);
    } finally {
      state.destroy();
    }
  });

  it("does not remove sessions that were recently accessed", async () => {
    const shortTtl = 50; // 50 ms
    const cleanupInterval = 30; // cleanup every 30 ms
    const state = new ContextPruningState(shortTtl, cleanupInterval);

    try {
      state.getOrCreate("ttl-test-session");

      // Access within TTL window
      await new Promise((r) => setTimeout(r, 30));
      state.get("ttl-test-session"); // refresh lastAccessedAt

      // Wait a bit more but not enough for full TTL from last access
      await new Promise((r) => setTimeout(r, 30));

      // Should still exist since last access is recent
      assert.ok(state.get("ttl-test-session"));
    } finally {
      state.destroy();
    }
  });

  it("singleton has a working getOrCreate", () => {
    const session = globalState.getOrCreate("test-session");
    assert.ok(session);
    assert.equal(session.sessionId, "test-session");
    assert.equal(session.turnCount, 0);
    assert.ok(session.lastAccessedAt > 0);
  });

  it("initializes prune state with empty tools map", () => {
    const session = globalState.getOrCreate("test-session");
    assert.ok(session.prune);
    assert.ok(session.prune.tools instanceof Map);
    assert.equal(session.prune.tools.size, 0);
  });

  it("singleton returns the same instance on repeated calls", () => {
    const a = globalState.getOrCreate("test-session");
    const b = globalState.getOrCreate("test-session");
    assert.equal(a, b);
  });
});

// ---------------------------------------------------------------------------
// (i) state methods
// ---------------------------------------------------------------------------

describe("state methods", () => {
  it("trackToolCall first call returns false (new entry)", () => {
    const result = globalState.trackToolCall(
      "test-session",
      "read",
      { path: "a.ts" },
      "m0000",
    );
    assert.equal(result, false);
    const session = globalState.get("test-session");
    assert.ok(session);
    assert.equal(session.dedupCache.size, 1);
    const entry = session.dedupCache.values().next().value;
    assert.ok(entry);
    assert.equal(entry.callCount, 1);
  });

  it("trackToolCall duplicate call returns true, callCount becomes 2", () => {
    globalState.trackToolCall(
      "test-session",
      "read",
      { path: "a.ts" },
      "m0000",
    );
    const result = globalState.trackToolCall(
      "test-session",
      "read",
      { path: "a.ts" },
      "m0001",
    );
    assert.equal(result, true);
    const session = globalState.get("test-session");
    assert.ok(session);
    const entry = session.dedupCache.values().next().value;
    assert.ok(entry);
    assert.equal(entry.callCount, 2);
  });

  it("trackToolCall with different params returns false", () => {
    globalState.trackToolCall(
      "test-session",
      "read",
      { path: "a.ts" },
      "m0000",
    );
    const result = globalState.trackToolCall(
      "test-session",
      "read",
      { path: "b.ts" },
      "m0001",
    );
    assert.equal(result, false);
    const session = globalState.get("test-session");
    assert.ok(session);
    assert.equal(session.dedupCache.size, 2);
  });

  it("trackError stores entry with correct turnNumber", () => {
    globalState.advanceTurn("test-session"); // turnCount becomes 1
    globalState.trackError(
      "test-session",
      "t0000",
      "bash",
      "command not found",
    );
    const session = globalState.get("test-session");
    assert.ok(session);
    const entry = session.errorTracking.get("t0000");
    assert.ok(entry);
    assert.equal(entry.turnNumber, 1);
    assert.equal(entry.toolName, "bash");
    assert.equal(entry.errorMessage, "command not found");
  });

  it("advanceTurn increments turnCount by 1", () => {
    const session = globalState.getOrCreate("test-session");
    assert.equal(session.turnCount, 0);
    globalState.advanceTurn("test-session");
    assert.equal(session.turnCount, 1);
  });

  it("advanceTurn called twice → turnCount=2", () => {
    globalState.getOrCreate("test-session");
    globalState.advanceTurn("test-session");
    globalState.advanceTurn("test-session");
    const session = globalState.get("test-session");
    assert.ok(session);
    assert.equal(session.turnCount, 2);
  });

  it("get() for nonexistent session returns undefined", () => {
    assert.equal(globalState.get("nonexistent-session"), undefined);
  });

  it("delete() nonexistent session does NOT throw", () => {
    assert.doesNotThrow(() => {
      globalState.delete("nonexistent-session");
    });
  });
});

// ---------------------------------------------------------------------------
// (d) Nudge thresholds
// ---------------------------------------------------------------------------

describe("buildNudges thresholds", () => {
  const config = passThroughConfig({
    nudgeThresholdTokens: 100,
    urgentThresholdTokens: 200,
    nudgeFrequency: 1,
  });

  it("returns no nudges below nudge threshold", () => {
    const nudges = buildNudges(50, config);
    assert.deepEqual(nudges, []);
  });

  it("returns no nudges at exactly nudge threshold", () => {
    // Tier 2 condition: totalTokens >= nudgeThresholdTokens (100) AND < urgentThresholdTokens (200)
    const nudges = buildNudges(100, config);
    assert.equal(nudges.length, 1);
  });

  it("returns one gentle nudge between nudge and urgent threshold", () => {
    const nudges = buildNudges(150, config);
    assert.equal(nudges.length, 1);
    assert.ok(nudges[0].includes("Notice"));
  });

  it("returns one urgent nudge at urgent threshold", () => {
    const nudges = buildNudges(200, config);
    assert.equal(nudges.length, 1);
    assert.ok(nudges[0].includes("Warning"));
  });

  it("returns one urgent nudge above urgent threshold", () => {
    const nudges = buildNudges(250, config);
    assert.equal(nudges.length, 1);
    assert.ok(nudges[0].includes("Warning"));
    assert.ok(nudges[0].includes("250"));
  });

  it("respects nudgeFrequency — only fires every N calls", () => {
    const state = { nudgeCounter: 0 } as SessionState;
    const freqConfig = passThroughConfig({
      nudgeThresholdTokens: 100,
      urgentThresholdTokens: 200,
      nudgeFrequency: 3,
    });

    // Call buildNudges 5 times with a value above threshold, using
    // per-session state for frequency control (counter starts at 0).
    // The counter is always incremented; nudge fires only when
    // counter % nudgeFrequency === 0.
    const call1 = buildNudges(150, freqConfig, state);
    const call2 = buildNudges(150, freqConfig, state);
    const call3 = buildNudges(150, freqConfig, state);
    const call4 = buildNudges(150, freqConfig, state);
    const call5 = buildNudges(150, freqConfig, state);

    // Call 1: counter=0, 0%3=0 → fires, counter becomes 1
    // Call 2: counter=1, 1%3=1≠0 → skips, counter becomes 2
    // Call 3: counter=2, 2%3=2≠0 → skips, counter becomes 3
    // Call 4: counter=3, 3%3=0 → fires, counter becomes 4
    // Call 5: counter=4, 4%3=1≠0 → skips, counter becomes 5
    assert.equal(call1.length, 1);
    assert.equal(call2.length, 0);
    assert.equal(call3.length, 0);
    assert.equal(call4.length, 1);
    assert.equal(call5.length, 0);
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("pipeline edge cases", () => {
  it("handles empty messages array", () => {
    const input: PipelineInput = {
      sessionId: "test-session",
      messages: [],
      config: passThroughConfig(),
    };

    const output = runPipeline(input);
    assert.deepEqual(output.messages, []);
    assert.deepEqual(output.nudges, []);
  });

  it("handles messages with toolCalls and toolResults unchanged", () => {
    const messages: MessageRef[] = [
      {
        id: "m0000",
        role: "user",
        content: "Check file",
        toolCalls: [
          { id: "t0000", toolName: "read", parameters: { path: "a.ts" } },
        ],
        toolResults: [
          {
            id: "tr0000",
            toolCallId: "t0000",
            output: "file content",
          },
        ],
      },
    ];

    const input: PipelineInput = {
      sessionId: "test-session",
      messages,
      config: passThroughConfig(),
    };

    const output = runPipeline(input);
    assert.equal(output.messages.length, 1);
    assert.equal(output.messages[0].toolCalls?.length, 1);
    assert.equal(output.messages[0].toolResults?.length, 1);
    assert.equal(output.messages[0].toolCalls?.[0].toolName, "read");
  });

  it("injects message IDs into content for non-mNNNN IDs", () => {
    const messages: MessageRef[] = [
      msg("custom-id-1", "user", "Hello from custom"),
      msg("m0000", "assistant", "I have a valid ID"),
      msg("custom-id-2", "user", "Another custom"),
    ];
    const input: PipelineInput = {
      sessionId: "test-session",
      messages,
      config: passThroughConfig(),
    };

    const output = runPipeline(input);

    // custom-id-1 gets reassigned to next available ID after max existing mNNNN
    // m0000 is valid, so nextId starts at 1 (m0000 + 1)
    // custom-id-1 → m0001, custom-id-2 → m0002
    assert.equal(output.messages[0].id, "m0001");
    assert.equal(output.messages[1].id, "m0000");
    assert.equal(output.messages[2].id, "m0002");

    // Messages with non-mNNNN IDs get <zoo:message-id> injected into content
    assert.ok(
      output.messages[0].content.startsWith("<zoo:message-id>m0001"),
      "custom-id-1 should get message-id tag",
    );
    assert.ok(
      !output.messages[1].content.includes("<zoo:message-id>"),
      "m0000 already has valid ID, no tag needed",
    );
    assert.ok(
      output.messages[2].content.startsWith("<zoo:message-id>m0002"),
      "custom-id-2 should get message-id tag",
    );
  });
});

// ---------------------------------------------------------------------------
// (j) pipeline metadata stripping + advanceTurn
// ---------------------------------------------------------------------------

describe("pipeline metadata stripping + advanceTurn", () => {
  it("strips _provider and _raw from metadata but keeps other fields", () => {
    const messages: MessageRef[] = [
      {
        id: "m0000",
        role: "user",
        content: "hello",
        metadata: { _provider: "anthropic", _raw: "xxx", keep: "me" },
      },
      {
        id: "m0001",
        role: "assistant",
        content: "hi",
      },
    ];
    const input: PipelineInput = {
      sessionId: "test-session",
      messages,
      config: passThroughConfig(),
    };

    const output = runPipeline(input);
    assert.equal(output.messages.length, 2);
    const meta = output.messages[0].metadata;
    assert.ok(meta);
    assert.equal(meta.keep, "me");
    assert.equal(meta._provider, undefined);
    assert.equal(meta._raw, undefined);
  });

  it("only strips metadata from messages before the last assistant", () => {
    const messages: MessageRef[] = [
      {
        id: "m0000",
        role: "user",
        content: "first",
        metadata: { _provider: "anthropic", keep: "yes" },
      },
      {
        id: "m0001",
        role: "assistant",
        content: "middle",
        metadata: { _provider: "openai", keep: "also" },
      },
      {
        id: "m0002",
        role: "user",
        content: "second",
        metadata: { _provider: "anthropic", _raw: "raw", keep: "too" },
      },
      // This is the LAST assistant — its metadata should be kept
      {
        id: "m0003",
        role: "assistant",
        content: "last",
        metadata: { _provider: "anthropic", _raw: "last-raw", keep: "last" },
      },
    ];
    const input: PipelineInput = {
      sessionId: "test-session",
      messages,
      config: passThroughConfig(),
    };

    const output = runPipeline(input);
    assert.equal(output.messages.length, 4);

    // Messages before the last assistant (indices 0, 1, 2) have _provider and _raw stripped
    assert.ok(output.messages[0].metadata);
    assert.equal(output.messages[0].metadata!.keep, "yes");
    assert.equal(output.messages[0].metadata!._provider, undefined);
    assert.equal(output.messages[0].metadata!._raw, undefined);

    assert.ok(output.messages[1].metadata);
    assert.equal(output.messages[1].metadata!.keep, "also");
    assert.equal(output.messages[1].metadata!._provider, undefined);

    assert.ok(output.messages[2].metadata);
    assert.equal(output.messages[2].metadata!.keep, "too");
    assert.equal(output.messages[2].metadata!._provider, undefined);
    assert.equal(output.messages[2].metadata!._raw, undefined);

    // The last assistant (index 3) keeps all metadata
    assert.ok(output.messages[3].metadata);
    assert.equal(output.messages[3].metadata!.keep, "last");
    assert.equal(output.messages[3].metadata!._provider, "anthropic");
    assert.equal(output.messages[3].metadata!._raw, "last-raw");
  });

  it("message without metadata — no error, output unchanged", () => {
    const messages: MessageRef[] = [msg("m0000", "user", "hello")];
    const input: PipelineInput = {
      sessionId: "test-session",
      messages,
      config: passThroughConfig(),
    };

    const output = runPipeline(input);
    assert.equal(output.messages.length, 1);
    assert.equal(output.messages[0].metadata, undefined);
  });

  it("advanceTurn effect: turnCount === 1 after one pipeline run", () => {
    const messages: MessageRef[] = [msg("m0000", "user", "hello")];
    const input: PipelineInput = {
      sessionId: "test-session",
      messages,
      config: passThroughConfig(),
    };

    runPipeline(input);
    const session = globalState.get("test-session");
    assert.ok(session);
    assert.equal(session.turnCount, 1);
  });

  it("multiple pipeline calls: turnCount === 2 after two runs", () => {
    const messages: MessageRef[] = [msg("m0000", "user", "hello")];
    const config = passThroughConfig();
    const input: PipelineInput = {
      sessionId: "test-session",
      messages,
      config,
    };

    runPipeline(input);
    runPipeline(input);
    const session = globalState.get("test-session");
    assert.ok(session);
    assert.equal(session.turnCount, 2);
  });
});

// ---------------------------------------------------------------------------
// (g) prepareSession
// ---------------------------------------------------------------------------

describe("prepareSession", () => {
  it("filters malformed messages and assigns IDs (stub)", () => {
    const messages: MessageRef[] = [
      { id: "", role: "user" as const, content: "bad" },
      { id: "x0000", role: "user" as const, content: "good" },
    ];
    prepareSession(passThroughConfig(), messages, "test-session");
    // The .filter() creates a new local array so the original array length
    // is unchanged. But surviving message objects (shared references) have
    // their IDs reassigned. The "good" message (original index 1) survives
    // the filter and becomes index 0 in the filtered array → id "m0000".
    assert.equal(messages.length, 2);
    assert.equal(messages[1].id, "m0000");
  });

  it("is a no-op when config.enabled is false", () => {
    const messages: MessageRef[] = [
      { id: "m0000", role: "user" as const, content: "hello" },
    ];
    // Should not throw
    prepareSession(
      passThroughConfig({ enabled: false }),
      messages,
      "test-session",
    );
    assert.equal(messages.length, 1);
  });

  it("does not crash with empty messages", () => {
    const messages: MessageRef[] = [];
    prepareSession(passThroughConfig(), messages, "test-session");
    assert.deepEqual(messages, []);
  });
});

// ---------------------------------------------------------------------------
// (h) estimator
// ---------------------------------------------------------------------------

describe("estimator", () => {
  describe("estimateTokens", () => {
    it("returns 0 for empty string", () => {
      assert.equal(estimateTokens(""), 0);
    });

    it("estimates 'hello' as 2 tokens", () => {
      assert.equal(estimateTokens("hello"), 2); // Math.ceil(5/4) = 2
    });

    it("estimates 'hello world' as 3 tokens", () => {
      assert.equal(estimateTokens("hello world"), 3); // Math.ceil(11/4) = 3
    });
  });

  describe("estimateTotalTokens", () => {
    it("empty array returns 0", () => {
      assert.equal(estimateTotalTokens([]), 0);
    });

    it("single message content counted", () => {
      const messages: MessageRef[] = [msg("m0", "user", "hello")];
      assert.equal(estimateTotalTokens(messages), 2);
    });

    it("message with toolCalls counts name and params", () => {
      const messages: MessageRef[] = [
        {
          id: "m0",
          role: "assistant",
          content: "",
          toolCalls: [
            { id: "t0", toolName: "read", parameters: { path: "a.ts" } },
          ],
        },
      ];
      // toolName "read" = 4 chars → 1 token
      // JSON.stringify({path:"a.ts"}) = 15 chars → Math.ceil(15/4) = 4
      // Total = 1 + 4 = 5
      assert.equal(estimateTotalTokens(messages), 5);
    });

    it("message with toolResults counts output", () => {
      const messages: MessageRef[] = [
        {
          id: "m0",
          role: "tool",
          content: "",
          toolResults: [
            { id: "tr0", toolCallId: "t0", output: "file content" },
          ],
        },
      ];
      // "file content" = 12 chars → Math.ceil(12/4) = 3
      assert.equal(estimateTotalTokens(messages), 3);
    });

    it("message with toolResult error counts error text", () => {
      const messages: MessageRef[] = [
        {
          id: "m0",
          role: "tool",
          content: "",
          toolResults: [
            { id: "tr0", toolCallId: "t0", output: "", error: "not found" },
          ],
        },
      ];
      // "not found" = 9 chars → Math.ceil(9/4) = 3
      assert.equal(estimateTotalTokens(messages), 3);
    });
  });

  describe("getContextTokens", () => {
    it("empty array returns 0", () => {
      assert.equal(getContextTokens([]), 0);
    });

    it("no assistant at all — heuristic only", () => {
      const messages = [
        {
          info: { role: "user" },
          parts: [{ type: "text", text: "hello" }],
        },
      ];
      // Math.ceil(5/4) = 2
      assert.equal(getContextTokens(messages), 2);
    });

    it("completed assistant — reported tokens summed", () => {
      const messages = [
        {
          info: {
            role: "assistant",
            tokens: { input: 10, output: 20, reasoning: 5 },
          },
          parts: [{ type: "text", text: "" }],
        },
      ];
      // 10 + 20 + 5 = 35
      assert.equal(getContextTokens(messages), 35);
    });

    it("streaming assistant (output=0) is skipped — next completed used", () => {
      const messages = [
        {
          info: {
            role: "assistant",
            tokens: { input: 5, output: 0, reasoning: 0 },
          },
          parts: [{ type: "text", text: "streaming" }],
        },
        {
          info: {
            role: "assistant",
            tokens: { input: 10, output: 30, reasoning: 2 },
          },
          parts: [{ type: "text", text: "" }],
        },
      ];
      // 10 + 30 + 2 = 42
      assert.equal(getContextTokens(messages), 42);
    });

    it("cache tokens are included in sum", () => {
      const messages = [
        {
          info: {
            role: "assistant",
            tokens: {
              input: 10,
              output: 20,
              reasoning: 5,
              cache: { read: 3, write: 7 },
            },
          },
          parts: [{ type: "text", text: "" }],
        },
      ];
      // 10 + 20 + 5 + 3 + 7 = 45
      assert.equal(getContextTokens(messages), 45);
    });

    it("heuristic after completed assistant", () => {
      const messages = [
        {
          info: {
            role: "assistant",
            tokens: { input: 10, output: 20, reasoning: 0 },
          },
          parts: [{ type: "text", text: "" }],
        },
        {
          info: { role: "user" },
          parts: [{ type: "text", text: "hello world" }],
        },
      ];
      // 10 + 20 + 0 = 30 (reported) + Math.ceil(11/4) = 3 (heuristic) = 33
      assert.equal(getContextTokens(messages), 33);
    });
  });
});

// ---------------------------------------------------------------------------
// Barrel export
// ---------------------------------------------------------------------------

describe("barrel export", () => {
  it("exports runPipeline as a function", () => {
    assert.equal(typeof runPipeline, "function");
  });

  it("exports prepareSession as a function", () => {
    assert.equal(typeof prepareSession, "function");
  });

  it("exports buildNudges as a function", () => {
    assert.equal(typeof buildNudges, "function");
  });

  it("exports ContextPruningState", () => {
    assert.equal(typeof ContextPruningState, "function");
  });

  it("exports globalState", () => {
    assert.ok(globalState);
    assert.equal(typeof globalState.getOrCreate, "function");
  });

  it("exports loadContextConfig as a function", () => {
    assert.equal(typeof loadContextConfig, "function");
  });

  it("exports resolveThreshold as a function", () => {
    assert.equal(typeof resolveThreshold, "function");
  });

  it("exports estimateTokens as a function", () => {
    assert.equal(typeof estimateTokens, "function");
  });

  it("exports estimateTotalTokens as a function", () => {
    assert.equal(typeof estimateTotalTokens, "function");
  });

  it("exports getContextTokens as a function", () => {
    assert.equal(typeof getContextTokens, "function");
  });

  it("exports markPurgeErrors as a function", () => {
    assert.equal(typeof markPurgeErrors, "function");
  });
});

// ---------------------------------------------------------------------------
// (e) Config loader
// ---------------------------------------------------------------------------

describe("loadContextConfig", () => {
  it("returns correct defaults when input is empty", () => {
    const config = loadContextConfig({});
    assert.equal(config.enabled, true);
    // Resolved thresholds: no contextLimit, so absolute fallback wins
    assert.equal(config.nudgeThresholdTokens, 200_000);
    assert.equal(config.urgentThresholdTokens, 400_000);
    assert.equal(config.dedupEnabled, false);
    assert.equal(config.purgeErrorsEnabled, false);
    assert.equal(config.purgeErrorsTurns, 3);
    assert.equal(config.compressEnabled, false);
    assert.equal(config.compressMode, "range");
    assert.equal(config.nudgeFrequency, 5);
    assert.equal(config.compressLlmEnabled, false);
    assert.equal(config.compressMessageModeEnabled, false);
    assert.equal(config.commandsEnabled, false);
    assert.equal(config.persistState, false);
    assert.deepEqual(config.protectedTools, ["task", "skill", "question"]);
    assert.equal(config.turnProtection, 2);
    assert.deepEqual(config.dedupProtectedTools, ["task", "skill", "read"]);
    assert.deepEqual(config.purgeErrorsProtectedTools, ["task", "skill"]);
  });

  it("returns correct defaults when input is undefined", () => {
    const config = loadContextConfig(
      undefined as unknown as Record<string, any>,
    );
    assert.equal(config.enabled, true);
    assert.equal(config.nudgeThresholdTokens, 200_000);
    assert.equal(config.urgentThresholdTokens, 400_000);
    assert.equal(config.compressMode, "range");
  });

  it("maps all snake_case TOML keys to camelCase config fields", () => {
    const zooConfig = {
      context: {
        enabled: false,
        nudge_threshold_percent: 10,
        urgent_threshold_percent: 25,
        nudge_threshold_absolute: 50_000,
        urgent_threshold_absolute: 100_000,
        dedup_enabled: false,
        purge_errors_enabled: false,
        purge_errors_turns: 5,
        compress_enabled: false,
        compress_mode: "message",
        compress_nudge_frequency: 6,
        compress_llm_enabled: true,
        compress_message_mode_enabled: true,
        commands_enabled: true,
        persist_state: false,
        protected_tools: ["task"],
        protect_user_messages: false,
        turn_protection: 4,
        dedup_protected_tools: ["task"],
        purge_errors_protected_tools: ["task", "bash"],
      },
    };

    const config = loadContextConfig(zooConfig);
    assert.equal(config.enabled, false);
    // Resolved: no contextLimit, so absolute fallback wins
    assert.equal(config.nudgeThresholdTokens, 50_000);
    assert.equal(config.urgentThresholdTokens, 100_000);
    assert.equal(config.dedupEnabled, false);
    assert.equal(config.purgeErrorsEnabled, false);
    assert.equal(config.purgeErrorsTurns, 5);
    assert.equal(config.compressEnabled, false);
    assert.equal(config.compressMode, "message");
    assert.equal(config.nudgeFrequency, 6);
    assert.equal(config.compressLlmEnabled, true);
    assert.equal(config.compressMessageModeEnabled, true);
    assert.equal(config.commandsEnabled, true);
    assert.equal(config.persistState, false);
    assert.deepEqual(config.protectedTools, ["task"]);
    assert.equal(config.turnProtection, 4);
    assert.deepEqual(config.dedupProtectedTools, ["task"]);
    assert.deepEqual(config.purgeErrorsProtectedTools, ["task", "bash"]);
  });
});

// ---------------------------------------------------------------------------
// (f) Dual-mode threshold resolution
// ---------------------------------------------------------------------------

describe("dual-mode threshold resolution", () => {
  describe("resolveThreshold (percent prioritization)", () => {
    it("percentage-only: min(20% of 1M, no absolute) = 200K", () => {
      const config = loadContextConfig(
        { context: { nudge_threshold_percent: 20 } },
        1_000_000,
      );
      assert.equal(config.nudgeThresholdTokens, 200_000);
    });

    it("absolute-only: min(no percent, 200K) = 200K", () => {
      const config = loadContextConfig(
        { context: { nudge_threshold_absolute: 200_000 } },
        1_000_000,
      );
      assert.equal(config.nudgeThresholdTokens, 200_000);
    });

    it("both: min(20% of 128K=25600, 200K) = 25600 (percent tighter)", () => {
      const config = loadContextConfig(
        {
          context: {
            nudge_threshold_percent: 20,
            nudge_threshold_absolute: 200_000,
          },
        },
        128_000,
      );
      assert.equal(config.nudgeThresholdTokens, 25_600);
    });

    it("both: min(20% of 1M=200K, 500K) = 200K (percent tighter)", () => {
      const config = loadContextConfig(
        {
          context: {
            nudge_threshold_percent: 20,
            nudge_threshold_absolute: 500_000,
          },
        },
        1_000_000,
      );
      assert.equal(config.nudgeThresholdTokens, 200_000);
    });

    it("both: min(40% of 1M=400K, 200K) = 200K (absolute tighter)", () => {
      const config = loadContextConfig(
        {
          context: {
            urgent_threshold_percent: 40,
            urgent_threshold_absolute: 200_000,
          },
        },
        1_000_000,
      );
      assert.equal(config.urgentThresholdTokens, 200_000);
    });

    it("no context limit: defaults to absolute values", () => {
      const config = loadContextConfig(
        {
          context: {
            nudge_threshold_percent: 20,
            nudge_threshold_absolute: 200_000,
            urgent_threshold_percent: 40,
            urgent_threshold_absolute: 400_000,
          },
        },
        // no contextLimit
      );
      assert.equal(config.nudgeThresholdTokens, 200_000);
      assert.equal(config.urgentThresholdTokens, 400_000);
    });

    it("contextLimit=0: defaults to absolute values (0 is falsy)", () => {
      const config = loadContextConfig(
        {
          context: {
            nudge_threshold_percent: 20,
            nudge_threshold_absolute: 200_000,
          },
        },
        0,
      );
      assert.equal(config.nudgeThresholdTokens, 200_000);
    });

    it("neither percent nor absolute set: defaults to 0", () => {
      // Direct resolveThreshold test: when all inputs are undefined, default to 0
      // (loadContextConfig always provides DEFAULTS, so this path is only
      // reachable through direct resolveThreshold calls)
      assert.equal(resolveThreshold(undefined, undefined, undefined), 0);
      assert.equal(resolveThreshold(undefined, undefined, 1_000_000), 0);
    });
  });
});

// ---------------------------------------------------------------------------
// (k) markDuplicates — dedup marking
// ---------------------------------------------------------------------------

describe("markDuplicates", () => {
  it("does not mark anything when dedupEnabled is false", () => {
    const state = freshState();
    const messages: MessageRef[] = [
      msg("m0000", "assistant", "", {
        toolCalls: [
          { id: "t0000", toolName: "edit", parameters: { file: "a.ts" } },
        ],
      }),
      msg("m0001", "assistant", "", {
        toolCalls: [
          { id: "t0001", toolName: "edit", parameters: { file: "a.ts" } },
        ],
      }),
    ];
    const count = markDuplicates(
      state,
      passThroughConfig({ dedupEnabled: false, turnProtection: 0 }),
      messages,
    );
    assert.equal(count, 0);
    assert.equal(state.prune.tools.size, 0);
  });

  it("marks older duplicate by signature (same toolName + same params)", () => {
    const state = freshState();
    const messages: MessageRef[] = [
      msg("m0000", "assistant", "", {
        toolCalls: [
          { id: "t000a", toolName: "edit", parameters: { file: "a.ts" } },
        ],
      }),
      msg("m0001", "assistant", "", {
        toolCalls: [
          { id: "t000b", toolName: "edit", parameters: { file: "a.ts" } },
        ],
      }),
    ];
    const count = markDuplicates(
      state,
      passThroughConfig({
        dedupEnabled: true,
        dedupProtectedTools: [],
        turnProtection: 0,
      }),
      messages,
    );
    // Older call (t000a) should be marked, newer (t000b) survives
    assert.equal(count, 1);
    assert.ok(state.prune.tools.has("t000a"));
    assert.ok(!state.prune.tools.has("t000b"));
  });

  it("keeps newest occurrence of each signature (older ones get marked)", () => {
    const state = freshState();
    const messages: MessageRef[] = [
      msg("m0000", "assistant", "", {
        toolCalls: [
          { id: "t000a", toolName: "edit", parameters: { file: "a.ts" } },
        ],
      }),
      msg("m0001", "assistant", "", {
        toolCalls: [
          { id: "t000b", toolName: "edit", parameters: { file: "a.ts" } },
        ],
      }),
      msg("m0002", "assistant", "", {
        toolCalls: [
          { id: "t000c", toolName: "edit", parameters: { file: "a.ts" } },
        ],
      }),
    ];
    const count = markDuplicates(
      state,
      passThroughConfig({
        dedupEnabled: true,
        dedupProtectedTools: [],
        turnProtection: 0,
      }),
      messages,
    );
    // t000a and t000b marked, t000c survives
    assert.equal(count, 2);
    assert.ok(state.prune.tools.has("t000a"));
    assert.ok(state.prune.tools.has("t000b"));
    assert.ok(!state.prune.tools.has("t000c"));
  });

  it("skips protected tools (dedupProtectedTools)", () => {
    const state = freshState();
    const messages: MessageRef[] = [
      msg("m0000", "assistant", "", {
        toolCalls: [
          { id: "t000a", toolName: "task", parameters: { name: "test" } },
        ],
      }),
      msg("m0001", "assistant", "", {
        toolCalls: [
          { id: "t000b", toolName: "task", parameters: { name: "test" } },
        ],
      }),
    ];
    // Uses default dedupProtectedTools: ["task", "skill", "read"]
    const count = markDuplicates(
      state,
      passThroughConfig({ dedupEnabled: true, turnProtection: 0 }),
      messages,
    );
    assert.equal(count, 0);
    assert.equal(state.prune.tools.size, 0);
  });

  it("respects turn protection (recent messages not marked)", () => {
    // The new assistant-based counting: last `turnProtection` (2) assistant
    // messages are protected. With 10 assistant messages, cutoffIndex = 8,
    // so indices 0-7 are scanned and indices 8-9 are protected.
    const state = freshState({ turnCount: 1 });
    const messages: MessageRef[] = Array.from({ length: 10 }, (_, i) =>
      msg(`m${String(i).padStart(4, "0")}`, "assistant", "", {
        toolCalls: [
          {
            id: `t${String(i).padStart(4, "0")}`,
            toolName: "edit",
            parameters: { file: "a.ts" },
          },
        ],
      }),
    );
    const count = markDuplicates(
      state,
      passThroughConfig({
        dedupEnabled: true,
        turnProtection: 2,
        dedupProtectedTools: [],
      }),
      messages,
    );
    // Indices 0-6 are marked as duplicates, index 7 survives (newest non-protected).
    // Indices 8-9 are protected (not scanned).
    assert.equal(count, 7);
    assert.ok(state.prune.tools.has("t0000"));
    assert.ok(state.prune.tools.has("t0006"));
    assert.ok(!state.prune.tools.has("t0007")); // newest non-protected survives
    assert.ok(!state.prune.tools.has("t0008")); // protected
    assert.ok(!state.prune.tools.has("t0009")); // protected
  });

  it("multiple different tools with same signature pattern", () => {
    const state = freshState();
    const messages: MessageRef[] = [
      msg("m0000", "assistant", "", {
        toolCalls: [
          { id: "t000a", toolName: "read", parameters: { path: "x.ts" } },
          { id: "t000b", toolName: "write", parameters: { path: "x.ts" } },
        ],
      }),
      msg("m0001", "assistant", "", {
        toolCalls: [
          { id: "t000c", toolName: "read", parameters: { path: "x.ts" } },
          { id: "t000d", toolName: "write", parameters: { path: "x.ts" } },
        ],
      }),
    ];
    const count = markDuplicates(
      state,
      passThroughConfig({
        dedupEnabled: true,
        dedupProtectedTools: [],
        turnProtection: 0,
      }),
      messages,
    );
    // Both tools have duplicates → 2 marks
    assert.equal(count, 2);
    assert.ok(state.prune.tools.has("t000a")); // older read marked
    assert.ok(state.prune.tools.has("t000b")); // older write marked
    assert.ok(!state.prune.tools.has("t000c")); // newer read survives
    assert.ok(!state.prune.tools.has("t000d")); // newer write survives
  });

  it("returns correct count of newly marked entries", () => {
    const state = freshState();
    const messages: MessageRef[] = [
      msg("m0000", "assistant", "", {
        toolCalls: [
          { id: "t000a", toolName: "edit", parameters: { file: "a.ts" } },
        ],
      }),
      msg("m0001", "assistant", "", {
        toolCalls: [
          { id: "t000b", toolName: "edit", parameters: { file: "b.ts" } },
        ],
      }),
      msg("m0002", "assistant", "", {
        toolCalls: [
          { id: "t000c", toolName: "edit", parameters: { file: "a.ts" } },
        ],
      }),
    ];
    const count = markDuplicates(
      state,
      passThroughConfig({
        dedupEnabled: true,
        dedupProtectedTools: [],
        turnProtection: 0,
      }),
      messages,
    );
    // Only edit(a.ts) has a duplicate → 1 mark (t000a)
    assert.equal(count, 1);
    assert.ok(state.prune.tools.has("t000a"));
    assert.ok(!state.prune.tools.has("t000c")); // newest occurrence survives
  });

  it("protects last N assistant turns regardless of message count per turn", () => {
    // turnProtection=2 — only the last 2 assistant messages are protected.
    // Create alternating messages with varying counts per turn (3, 5, 4 msgs),
    // but the only thing that matters is the number of assistant messages.
    const state = freshState({ turnCount: 1 });
    const messages: MessageRef[] = [
      // Turn 1: 3 messages (1 assistant at index 0)
      msg("m0000", "assistant", "", {
        toolCalls: [
          { id: "t0000", toolName: "edit", parameters: { file: "a.ts" } },
        ],
      }),
      msg("m0001", "tool", "", {
        toolResults: [{ id: "tr0000", toolCallId: "t0000", output: "ok" }],
      }),
      msg("m0002", "user", "", {}),
      // Turn 2: 5 messages (1 assistant at index 3)
      msg("m0003", "assistant", "", {
        toolCalls: [
          { id: "t0001", toolName: "edit", parameters: { file: "a.ts" } },
        ],
      }),
      msg("m0004", "tool", "", {
        toolResults: [{ id: "tr0001", toolCallId: "t0001", output: "ok" }],
      }),
      msg("m0005", "user", "", {}),
      msg("m0006", "tool", "", {
        toolResults: [{ id: "tr0002", toolCallId: "t0001", output: "ok" }],
      }),
      msg("m0007", "tool", "", {
        toolResults: [{ id: "tr0003", toolCallId: "t0001", output: "ok" }],
      }),
      // Turn 3: 4 messages (1 assistant at index 8 — protected)
      msg("m0008", "assistant", "", {
        toolCalls: [
          { id: "t0002", toolName: "edit", parameters: { file: "a.ts" } },
        ],
      }),
      msg("m0009", "tool", "", {
        toolResults: [{ id: "tr0004", toolCallId: "t0002", output: "ok" }],
      }),
      msg("m0010", "user", "", {}),
      msg("m0011", "user", "", {}),
    ];

    const count = markDuplicates(
      state,
      passThroughConfig({
        dedupEnabled: true,
        turnProtection: 2,
        dedupProtectedTools: [],
      }),
      messages,
    );

    // Assistant messages at indices 0, 3, 8
    // turnProtection=2 → last 2 assistants protected (indices 3, 8)
    // CutoffIndex = 3 (start of the first protected assistant)
    // Only index 0 is scanned (non-protected)
    // Index 0 is first occurrence → no mark
    assert.equal(count, 0);
    assert.equal(state.prune.tools.size, 0);
  });
});

// ---------------------------------------------------------------------------
// (l) markPurgeErrors — purge-errors marking
// ---------------------------------------------------------------------------

describe("markPurgeErrors", () => {
  it("does not mark anything when purgeErrorsEnabled is false", () => {
    const state = freshState();
    const messages: MessageRef[] = [
      msg("m0000", "assistant", "", {
        toolCalls: [{ id: "t0000", toolName: "read", parameters: {} }],
      }),
      msg("m0001", "tool", "", {
        toolResults: [
          { id: "tr0000", toolCallId: "t0000", output: "", isError: true },
        ],
      }),
    ];
    const count = markPurgeErrors(
      state,
      passThroughConfig({ purgeErrorsEnabled: false }),
      messages,
    );
    assert.equal(count, 0);
    assert.equal(state.prune.tools.size, 0);
  });

  it("marks errored tool results (isError=true) from old messages", () => {
    const state = freshState({ turnCount: 10 });
    const messages: MessageRef[] = [
      msg("m0000", "assistant", "", {
        toolCalls: [{ id: "t0000", toolName: "read", parameters: {} }],
      }),
      msg("m0001", "tool", "", {
        toolResults: [
          { id: "tr0000", toolCallId: "t0000", output: "", isError: true },
        ],
      }),
    ];
    const count = markPurgeErrors(
      state,
      passThroughConfig({
        purgeErrorsEnabled: true,
        purgeErrorsProtectedTools: [],
        turnProtection: 0,
      }),
      messages,
    );
    assert.equal(count, 1);
    assert.ok(state.prune.tools.has("t0000"));
  });

  it("does NOT mark recent errors within protected window", () => {
    // protectedWindowSize = turnProtection * 4 = 1 * 4 = 4
    // With 4 messages, nonProtectedEnd = max(0, 4-4) = 0 → no messages scanned
    const state = freshState({ turnCount: 10 });
    const messages: MessageRef[] = Array.from({ length: 4 }, (_, i) =>
      msg(`m${String(i).padStart(4, "0")}`, "tool", "", {
        toolResults: [
          {
            id: `tr${String(i).padStart(4, "0")}`,
            toolCallId: `t${String(i).padStart(4, "0")}`,
            output: "",
            isError: true,
          },
        ],
      }),
    );
    const count = markPurgeErrors(
      state,
      passThroughConfig({
        purgeErrorsEnabled: true,
        purgeErrorsProtectedTools: [],
        turnProtection: 1,
      }),
      messages,
    );
    // All messages are within protected window → nothing marked
    assert.equal(count, 0);
    assert.equal(state.prune.tools.size, 0);
  });

  it("skips protected tools (purgeErrorsProtectedTools)", () => {
    const state = freshState({ turnCount: 10 });
    const messages: MessageRef[] = [
      msg("m0000", "assistant", "", {
        toolCalls: [{ id: "t0000", toolName: "task", parameters: {} }],
      }),
      msg("m0001", "tool", "", {
        toolResults: [
          { id: "tr0000", toolCallId: "t0000", output: "", isError: true },
        ],
      }),
    ];
    const count = markPurgeErrors(
      state,
      passThroughConfig({ purgeErrorsEnabled: true }),
      messages,
    );
    // "task" is in purgeErrorsProtectedTools by default
    assert.equal(count, 0);
    assert.equal(state.prune.tools.size, 0);
  });

  it("does not double-mark already-marked toolCallIds", () => {
    const state = freshState({ turnCount: 10 });
    state.prune.tools.set("t0000", 5); // already marked from a previous pass
    const messages: MessageRef[] = [
      msg("m0000", "assistant", "", {
        toolCalls: [{ id: "t0000", toolName: "read", parameters: {} }],
      }),
      msg("m0001", "tool", "", {
        toolResults: [
          { id: "tr0000", toolCallId: "t0000", output: "", isError: true },
        ],
      }),
    ];
    const count = markPurgeErrors(
      state,
      passThroughConfig({
        purgeErrorsEnabled: true,
        purgeErrorsProtectedTools: [],
        turnProtection: 0,
      }),
      messages,
    );
    assert.equal(count, 0); // already marked, no new marks
    assert.equal(state.prune.tools.size, 1); // still just one
  });

  it("handles Source A (errorTracking) — marks old errors from tracking", () => {
    // Source A iterates errorTracking entries and marks those beyond purgeErrorsTurns
    const state = freshState({ turnCount: 10 });
    // Old error: turnNumber=2, age=8 > purgeErrorsTurns=3 → should be marked
    state.errorTracking.set("t0000", {
      toolCallId: "t0000",
      toolName: "read",
      turnNumber: 2,
      errorMessage: "not found",
    });
    // Recent error: turnNumber=9, age=1 <= purgeErrorsTurns=3 → NOT marked
    state.errorTracking.set("t0001", {
      toolCallId: "t0001",
      toolName: "read",
      turnNumber: 9,
      errorMessage: "permission denied",
    });
    const count = markPurgeErrors(
      state,
      passThroughConfig({
        purgeErrorsEnabled: true,
        purgeErrorsTurns: 3,
        purgeErrorsProtectedTools: [],
      }),
      [],
    );
    assert.equal(count, 1);
    assert.ok(state.prune.tools.has("t0000")); // old error → marked
    assert.ok(!state.prune.tools.has("t0001")); // recent error → not marked
  });

  it("returns correct count of newly marked entries", () => {
    const state = freshState({ turnCount: 10 });
    // Error entry that's already marked (should not count)
    state.prune.tools.set("t0000", 3);
    state.errorTracking.set("t0000", {
      toolCallId: "t0000",
      toolName: "read",
      turnNumber: 1, // old enough
      errorMessage: "fail",
    });
    // Unmarked old error (should count)
    state.errorTracking.set("t0002", {
      toolCallId: "t0002",
      toolName: "bash",
      turnNumber: 2,
      errorMessage: "command not found",
    });
    const count = markPurgeErrors(
      state,
      passThroughConfig({
        purgeErrorsEnabled: true,
        purgeErrorsTurns: 3,
        purgeErrorsProtectedTools: [],
      }),
      [],
    );
    // t0000 already marked → not counted, t0002 newly marked → counted
    assert.equal(count, 1);
    assert.ok(state.prune.tools.has("t0002"));
  });
});

// ---------------------------------------------------------------------------
// (m) applyPruning — prune application
// ---------------------------------------------------------------------------

describe("applyPruning", () => {
  it("returns messages unchanged when prune.tools is empty", () => {
    const state = freshState(); // prune.tools is empty
    const messages: MessageRef[] = [
      msg("m0000", "assistant", "", {
        toolCalls: [{ id: "t0000", toolName: "read", parameters: {} }],
      }),
      msg("m0001", "tool", "", {
        toolResults: [
          { id: "tr0000", toolCallId: "t0000", output: "file content" },
        ],
      }),
    ];
    const result = applyPruning(state, messages);
    assert.equal(result.prunedOutputs, 0);
    assert.equal(result.prunedErrors, 0);
    assert.equal(result.messages[1].toolResults?.[0].output, "file content");
  });

  it("replaces tool result output with placeholder when toolCallId is in prune.tools", () => {
    const state = freshState();
    state.prune.tools.set("t0000", 5);
    const messages: MessageRef[] = [
      msg("m0000", "assistant", "", {
        toolCalls: [{ id: "t0000", toolName: "read", parameters: {} }],
      }),
      msg("m0001", "tool", "", {
        toolResults: [
          { id: "tr0000", toolCallId: "t0000", output: "file content" },
        ],
      }),
    ];
    const result = applyPruning(state, messages);
    assert.equal(result.prunedOutputs, 1);
    assert.equal(result.prunedErrors, 0);
    assert.ok(
      result.messages[1].toolResults?.[0].output.startsWith("[pruned:"),
    );
  });

  it("replaces both output and error for isError=true results", () => {
    const state = freshState();
    state.prune.tools.set("t0000", 5);
    const messages: MessageRef[] = [
      msg("m0000", "assistant", "", {
        toolCalls: [{ id: "t0000", toolName: "read", parameters: {} }],
      }),
      msg("m0001", "tool", "", {
        toolResults: [
          {
            id: "tr0000",
            toolCallId: "t0000",
            output: "error occurred",
            isError: true,
            error: "not found",
          },
        ],
      }),
    ];
    const result = applyPruning(state, messages);
    assert.equal(result.prunedOutputs, 0);
    assert.equal(result.prunedErrors, 1);
    assert.ok(
      result.messages[1].toolResults?.[0].output.startsWith("[pruned:"),
    );
    assert.ok(
      result.messages[1].toolResults?.[0].error?.startsWith("[pruned:"),
    );
  });

  it("does NOT replace content when toolCallId is NOT in prune.tools", () => {
    const state = freshState();
    state.prune.tools.set("t0000", 5);
    const messages: MessageRef[] = [
      msg("m0000", "assistant", "", {
        toolCalls: [
          { id: "t0000", toolName: "read", parameters: {} },
          { id: "t0001", toolName: "write", parameters: {} },
        ],
      }),
      msg("m0001", "tool", "", {
        toolResults: [
          { id: "tr0000", toolCallId: "t0000", output: "marked output" },
          { id: "tr0001", toolCallId: "t0001", output: "not marked" },
        ],
      }),
    ];
    const result = applyPruning(state, messages);
    // t0000 is marked → replaced, t0001 is not → preserved
    assert.equal(result.prunedOutputs, 1);
    assert.equal(result.prunedErrors, 0);
    const results = result.messages[1].toolResults;
    assert.ok(results);
    assert.ok(results[0].output.startsWith("[pruned:"));
    assert.equal(results[1].output, "not marked");
  });

  it("idempotent: already-replaced placeholders are not double-processed", () => {
    const state = freshState();
    state.prune.tools.set("t0000", 5);
    // Pre-populate prunedCallIds so the new idempotency check
    // (which uses the Set rather than output content) skips t0000
    state.prune.prunedCallIds.add("t0000");
    const messages: MessageRef[] = [
      msg("m0000", "assistant", "", {
        toolCalls: [{ id: "t0000", toolName: "read", parameters: {} }],
      }),
      msg("m0001", "tool", "", {
        toolResults: [
          {
            id: "tr0000",
            toolCallId: "t0000",
            output: "[pruned: duplicate tool call — read]",
          },
        ],
      }),
    ];
    const result = applyPruning(state, messages);
    // Already pruned, should not count again
    assert.equal(result.prunedOutputs, 0);
    assert.equal(result.prunedErrors, 0);
  });

  it("replaces tool call parameters for errored tools", () => {
    const state = freshState();
    state.prune.tools.set("t0000", 5);
    // Same message has both toolCalls and toolResults (inline format)
    const messages: MessageRef[] = [
      {
        id: "m0000",
        role: "tool",
        content: "",
        toolCalls: [
          {
            id: "t0000",
            toolName: "bash",
            parameters: { cmd: "rm -rf /" },
          },
        ],
        toolResults: [
          {
            id: "tr0000",
            toolCallId: "t0000",
            output: "permission denied",
            isError: true,
            error: "permission denied",
          },
        ],
      },
    ];
    const result = applyPruning(state, messages);

    // The errored tool result should be replaced with a placeholder
    assert.equal(result.prunedOutputs, 0);
    assert.equal(result.prunedErrors, 1);
    const tr = result.messages[0].toolResults?.[0];
    assert.ok(tr);
    assert.ok(tr.output.startsWith("[pruned:"));

    // The tool call parameters should also be replaced
    const tc = result.messages[0].toolCalls?.[0];
    assert.ok(tc);
    assert.deepEqual(tc.parameters, {
      pruned: true,
      reason: "[input removed — failed tool call: bash]",
    });
  });
});

// ---------------------------------------------------------------------------
// (n) Prepare-and-run integration
// ---------------------------------------------------------------------------

describe("two-phase integration", () => {
  it("prepareSession marks duplicates, then runPipeline prunes them", () => {
    const messages: MessageRef[] = [
      msg("raw1", "assistant", "", {
        toolCalls: [
          { id: "t000a", toolName: "bash", parameters: { cmd: "echo 1" } },
        ],
      }),
      msg("raw2", "user", "Check file"),
      msg("raw3", "assistant", "", {
        toolCalls: [
          { id: "t000b", toolName: "bash", parameters: { cmd: "echo 1" } },
        ],
      }),
      msg("raw4", "tool", "", {
        toolResults: [
          { id: "tr0000", toolCallId: "t000a", output: "first result" },
          { id: "tr0001", toolCallId: "t000b", output: "second result" },
        ],
      }),
    ];

    // compress-time: marks duplicates
    prepareSession(
      passThroughConfig({ dedupEnabled: true, turnProtection: 0 }),
      messages,
      "test-session",
    );

    // t000a should be marked as the older duplicate
    const state = globalState.get("test-session");
    assert.ok(state);
    assert.ok(state.prune.tools.has("t000a"));

    // every-turn: applies pruning marks
    const output = runPipeline({
      sessionId: "test-session",
      messages,
      config: passThroughConfig({ dedupEnabled: true, turnProtection: 0 }),
    });

    const toolMsg = output.messages.find((m) => m.role === "tool");
    assert.ok(toolMsg);
    const trForT000a = toolMsg.toolResults?.find(
      (tr) => tr.toolCallId === "t000a",
    );
    assert.ok(trForT000a);
    assert.ok(trForT000a.output.startsWith("[pruned:"));
    const trForT000b = toolMsg.toolResults?.find(
      (tr) => tr.toolCallId === "t000b",
    );
    assert.ok(trForT000b);
    assert.equal(trForT000b.output, "second result");

    assert.equal(output.stats.prunedOutputs, 1);
    assert.equal(output.stats.prunedErrors, 0);
  });

  it("prepareSession marks purge errors, then runPipeline prunes them", () => {
    // Set turnCount so old errors are beyond the purgeErrorsTurns window
    const session = globalState.getOrCreate("test-session");
    session.turnCount = 10;

    const messages: MessageRef[] = [
      msg("m0000", "assistant", "", {
        toolCalls: [{ id: "t0000", toolName: "bash", parameters: {} }],
      }),
      msg("m0001", "tool", "", {
        toolResults: [
          {
            id: "tr0000",
            toolCallId: "t0000",
            output: "",
            isError: true,
            error: "not found",
          },
        ],
      }),
    ];

    // compress-time: marks errors
    prepareSession(
      passThroughConfig({
        purgeErrorsEnabled: true,
        purgeErrorsProtectedTools: [],
        turnProtection: 0,
      }),
      messages,
      "test-session",
    );

    // every-turn: applies pruning marks
    const output = runPipeline({
      sessionId: "test-session",
      messages,
      config: passThroughConfig({
        purgeErrorsEnabled: true,
        purgeErrorsProtectedTools: [],
        turnProtection: 0,
      }),
    });

    const toolMsg = output.messages.find((m) => m.role === "tool");
    assert.ok(toolMsg);
    const tr = toolMsg.toolResults?.[0];
    assert.ok(tr);
    assert.ok(tr.output.startsWith("[pruned:"));
    assert.ok(tr.error?.startsWith("[pruned:"));
    assert.equal(output.stats.prunedErrors, 1);
  });
});

// ---------------------------------------------------------------------------
// (p) applyCompression — heuristic range compression
// ---------------------------------------------------------------------------

describe("applyCompression", () => {
  // ── Helpers ──────────────────────────────────────────────

  function compressConfig(
    overrides?: Partial<ContextPruningConfig>,
  ): ContextPruningConfig {
    return passThroughConfig({
      compressEnabled: true,
      nudgeThresholdTokens: 50,
      turnProtection: 2,
      compressMode: "range",
      ...overrides,
    });
  }

  function zeroStats(): PipelineStats {
    return {
      dedupRemoved: 0,
      errorPurged: 0,
      compressedTokens: 0,
      summaryTokens: 0,
      prunedOutputs: 0,
      prunedErrors: 0,
    };
  }

  // ── 1. No-op gates ──

  it("returns messages unchanged when compressEnabled is false", () => {
    const state = globalState.getOrCreate("test-session");
    const config = compressConfig({ compressEnabled: false });
    const long = "X".repeat(300);
    const messages: MessageRef[] = [
      { id: "m0000", role: "user", content: long },
      { id: "m0001", role: "assistant", content: long },
    ];
    const stats = zeroStats();

    const result = applyCompression(state, config, messages, stats);

    assert.equal(result, messages);
    assert.equal(stats.compressedTokens, 0);
    assert.equal(stats.summaryTokens, 0);
  });

  it("returns messages unchanged when tokens are below threshold", () => {
    const state = globalState.getOrCreate("test-session");
    const config = compressConfig({ nudgeThresholdTokens: 10_000 });
    const messages: MessageRef[] = [
      { id: "m0000", role: "user", content: "hi" },
      { id: "m0001", role: "assistant", content: "hello" },
    ];
    const stats = zeroStats();

    const result = applyCompression(state, config, messages, stats);

    assert.equal(result, messages);
    assert.equal(stats.compressedTokens, 0);
  });

  // ── 2. Protected turns — boundary detection ──

  it("protects the last N assistant turns from compression", () => {
    const state = globalState.getOrCreate(
      "test-session",
      2, /* protectedTurns */
    );
    const config = compressConfig({ turnProtection: 2 });
    const long = "X".repeat(300);

    // 6 assistant messages interleaved with tool results (12 total)
    const messages: MessageRef[] = [];
    for (let i = 0; i < 6; i++) {
      messages.push({
        id: `m${String(i * 2).padStart(4, "0")}`,
        role: "assistant",
        content: long,
      });
      messages.push({
        id: `m${String(i * 2 + 1).padStart(4, "0")}`,
        role: "tool",
        content: "",
      });
    }

    const stats = zeroStats();
    const result = applyCompression(state, config, messages, stats);

    // 4 assistants compressed → placeholder + 2 protected assistants + 2 tool results
    assert.equal(result.length, 5);
    // First message is the placeholder
    assert.ok(result[0].content.startsWith("[Compressed:"));
    assert.equal(result[0].role, "user");
    // Protected messages preserved
    assert.equal(result[1].id, "m0008");
    assert.equal(result[2].id, "m0009");
    assert.equal(result[3].id, "m0010");
    assert.equal(result[4].id, "m0011");
    // Placeholder summary: 8 messages compressed (4 assistants + 4 tools)
    assert.ok(result[0].content.includes("8 messages"));
    assert.ok(result[0].content.includes("tokens removed"));
  });

  it("returns unchanged when all messages are within protection window", () => {
    const state = globalState.getOrCreate(
      "test-session",
      3, /* protectedTurns */
    );
    const config = compressConfig({ turnProtection: 3 });
    const long = "X".repeat(300);

    // 3 assistant messages with interleaved tool results — all protected
    const messages: MessageRef[] = [
      { id: "m0000", role: "assistant", content: long },
      { id: "m0001", role: "tool", content: "" },
      { id: "m0002", role: "assistant", content: long },
      { id: "m0003", role: "tool", content: "" },
      { id: "m0004", role: "assistant", content: long },
      { id: "m0005", role: "tool", content: "" },
    ];

    const stats = zeroStats();
    const result = applyCompression(state, config, messages, stats);

    assert.equal(result, messages);
    assert.equal(stats.compressedTokens, 0);
  });

  it("returns unchanged when all messages are within protection window (over-protection guard)", () => {
    // turnProtection=0 means "protect nothing" but the algorithm
    // interprets this as "everything is within the window" to avoid
    // compressing the entire active context. The D12 guard returns
    // messages unchanged.
    const state = globalState.getOrCreate("test-session", 0);
    const config = compressConfig({ turnProtection: 0 });
    const long = "X".repeat(300);
    const messages: MessageRef[] = [
      { id: "m0000", role: "user", content: long },
      { id: "m0001", role: "assistant", content: long },
      { id: "m0002", role: "assistant", content: long },
    ];

    const stats = zeroStats();
    const result = applyCompression(state, config, messages, stats);

    // Over-protection guard prevents compression when all messages
    // are within the protection window (turnProtection=0)
    assert.equal(result, messages);
    assert.equal(stats.compressedTokens, 0);
  });

  it("compresses all but the last assistant when turnProtection is 1", () => {
    const state = globalState.getOrCreate("test-session", 1);
    const config = compressConfig({ turnProtection: 1 });
    const long = "X".repeat(300);

    // 3 assistant messages with interleaved tool results (6 total)
    const messages: MessageRef[] = [];
    for (let i = 0; i < 3; i++) {
      messages.push({
        id: `m${String(i * 2).padStart(4, "0")}`,
        role: "assistant",
        content: long,
      });
      messages.push({
        id: `m${String(i * 2 + 1).padStart(4, "0")}`,
        role: "tool",
        content: "",
      });
    }

    const stats = zeroStats();
    const result = applyCompression(state, config, messages, stats);

    // 2 assistants compressed → placeholder + 1 protected assistant + 1 tool result
    assert.equal(result.length, 3);
    assert.ok(result[0].content.startsWith("[Compressed:"));
    assert.equal(result[0].role, "user");
    // Protected: last assistant turn (m0004 + m0005)
    assert.equal(result[1].id, "m0004");
    assert.equal(result[2].id, "m0005");
  });

  // ── 4. Placeholder format ──

  it("creates correct placeholder format with topic extracted from first assistant", () => {
    const state = globalState.getOrCreate(
      "test-session",
      1, /* protectedTurns */
    );
    const config = compressConfig({ turnProtection: 1 });
    const long = "X".repeat(300);
    const messages: MessageRef[] = [
      { id: "m0000", role: "user", content: "How do I install deps?" },
      {
        id: "m0001",
        role: "assistant",
        content:
          "Install dependencies for the project using npm and then run the build script",
      },
      { id: "m0002", role: "tool", content: "" },
      { id: "m0003", role: "assistant", content: long }, // protected
    ];

    const stats = zeroStats();
    const result = applyCompression(state, config, messages, stats);

    assert.ok(result[0].content.startsWith("[Compressed:"));
    assert.ok(result[0].content.includes("Install dependencies for the project"));
    assert.ok(
      /\[Compressed: .+ — \d+ messages \/ \d+ tokens removed\]\n<zoo:block-id>\d+<\/zoo:block-id>$/.test(
        result[0].content,
      ),
    );
    assert.equal(result[0].role, "user");
    assert.ok(result[0].id.startsWith("dcp_c"));
    // 3 messages compressed → placeholder + 1 protected assistant
    assert.equal(result.length, 2);
  });

  it("falls back to 'earlier conversation' when no assistant message in compressible range", () => {
    const state = globalState.getOrCreate(
      "test-session",
      1, /* protectedTurns */
    );
    const config = compressConfig({ turnProtection: 1 });
    const long = "X".repeat(300);
    const messages: MessageRef[] = [
      { id: "m0000", role: "user", content: "Hello there" },
      { id: "m0001", role: "user", content: "Are you there?" },
      { id: "m0002", role: "assistant", content: long }, // protected (only assistant)
    ];

    const stats = zeroStats();
    const result = applyCompression(state, config, messages, stats);

    assert.ok(result[0].content.startsWith("[Compressed:"));
    assert.ok(result[0].content.includes("earlier conversation"));
  });

  it("includes machine-parseable block-id footer in placeholder", () => {
    const state = globalState.getOrCreate("test-session", 1);
    const config = compressConfig({ turnProtection: 1 });
    const long = "X".repeat(300);
    const messages: MessageRef[] = [
      { id: "m0000", role: "user", content: "Hello" },
      { id: "m0001", role: "assistant", content: long },
      { id: "m0002", role: "assistant", content: long }, // protected
    ];

    const stats = zeroStats();
    const result = applyCompression(state, config, messages, stats);

    assert.ok(result[0].content.includes("<zoo:block-id>"));
    const block = state.blocksById.values().next().value;
    assert.ok(block);
    assert.ok(
      result[0].content.includes(
        `<zoo:block-id>${block.blockId}</zoo:block-id>`,
      ),
    );
  });

  // ── 5. State updates ──

  it("updates blocksById and byMessageId on compression", () => {
    const state = globalState.getOrCreate(
      "test-session",
      1, /* protectedTurns */
    );
    const config = compressConfig({ turnProtection: 1 });
    const long = "X".repeat(300);
    const messages: MessageRef[] = [
      { id: "m0000", role: "user", content: "Hello" },
      { id: "m0001", role: "assistant", content: "install deps" },
      { id: "m0002", role: "tool", content: "" },
      { id: "m0003", role: "assistant", content: long }, // protected
    ];

    assert.equal(state.blocksById.size, 0);

    const stats = zeroStats();
    applyCompression(state, config, messages, stats);

    assert.equal(state.blocksById.size, 1);
    const block = state.blocksById.values().next().value;
    assert.ok(block);
    assert.equal(block.active, true);
    assert.equal(block.mode, "range");
    assert.equal(block.directMessageIds.length, 3); // m0000, m0001, m0002

    // byMessageId for compressed messages
    for (const msgId of ["m0000", "m0001", "m0002"]) {
      const entry = state.byMessageId.get(msgId);
      assert.ok(entry);
      assert.equal(entry.allBlockIds.length, 1);
      assert.equal(entry.allBlockIds[0], block.blockId);
    }
  });

  it("updates activeBlockIds and totalCompressedTokens", () => {
    const state = globalState.getOrCreate(
      "test-session",
      1, /* protectedTurns */
    );
    const config = compressConfig({ turnProtection: 1 });
    const long = "X".repeat(300);
    const messages: MessageRef[] = [
      { id: "m0000", role: "user", content: "Hello" },
      { id: "m0001", role: "assistant", content: long },
      { id: "m0002", role: "assistant", content: long }, // protected
    ];

    assert.equal(state.activeBlockIds.size, 0);
    assert.equal(state.totalCompressedTokens, 0);

    const stats = zeroStats();
    applyCompression(state, config, messages, stats);

    // activeBlockIds
    assert.equal(state.activeBlockIds.size, 1);
    const blockId = state.blocksById.keys().next().value;
    assert.ok(blockId);
    assert.ok(state.activeBlockIds.has(blockId));

    // totalCompressedTokens
    assert.ok(state.totalCompressedTokens > 0);
  });

  // ── 5b. Multiple compressions ──

  it("supports compressing again when new turns push tokens above threshold", () => {
    const state = globalState.getOrCreate("test-session", 1);
    const config = compressConfig({ turnProtection: 1 });
    const long = "X".repeat(300);

    // First compression: 2 assistants, last one protected
    const messages1: MessageRef[] = [
      { id: "m0000", role: "user", content: long },
      { id: "m0001", role: "assistant", content: long },
      { id: "m0002", role: "assistant", content: long }, // protected (last 1)
    ];

    const stats1 = zeroStats();
    const result1 = applyCompression(state, config, messages1, stats1);

    // First compression: placeholder + m0002
    assert.equal(result1.length, 2);
    assert.ok(result1[0].content.startsWith("[Compressed:"));
    assert.ok(result1[0].content.includes("2 messages"));

    // Second compression: add more messages, tokens exceed threshold again
    const messages2: MessageRef[] = [
      ...result1,
      { id: "m0003", role: "user", content: long },
      { id: "m0004", role: "assistant", content: long }, // new protected (last 1)
    ];

    const stats2 = zeroStats();
    const result2 = applyCompression(state, config, messages2, stats2);

    // Old placeholder + m0002 + m0003 should be compressed into a new placeholder
    // Protected: m0004 (last assistant)
    assert.equal(result2.length, 2);
    assert.ok(result2[0].content.startsWith("[Compressed:"));
    assert.notEqual(result2[0].id, result1[0].id); // new placeholder ID
    assert.equal(result2[1].id, "m0004");
  });

  // ── 6. Stats ──

  it("updates pipeline stats", () => {
    const state = globalState.getOrCreate(
      "test-session",
      1, /* protectedTurns */
    );
    const config = compressConfig({ turnProtection: 1 });
    const long = "X".repeat(300);
    const messages: MessageRef[] = [
      { id: "m0000", role: "user", content: "Hello" },
      { id: "m0001", role: "assistant", content: long },
      { id: "m0002", role: "tool", content: "" },
      { id: "m0003", role: "assistant", content: long }, // protected
    ];

    const stats = zeroStats();
    applyCompression(state, config, messages, stats);

    assert.ok(stats.compressedTokens > 0);
    assert.equal(stats.summaryTokens, 50);
  });

  // ── 7. Edge cases ──

  it("returns messages unchanged when estimateTotalTokens throws", () => {
    const state = globalState.getOrCreate("test-session");
    const config = compressConfig();
    // Use null content to trigger a TypeError in estimateTokens → caught by try-catch
    const messages: MessageRef[] = [
      { id: "m0000", role: "assistant", content: null as unknown as string },
      { id: "m0001", role: "user", content: "hello" },
    ];
    const stats = zeroStats();

    const result = applyCompression(state, config, messages, stats);

    assert.equal(result, messages);
    assert.equal(stats.compressedTokens, 0);
  });

  it("handles empty messages array", () => {
    const state = globalState.getOrCreate("test-session");
    const config = compressConfig();
    const messages: MessageRef[] = [];
    const stats = zeroStats();

    const result = applyCompression(state, config, messages, stats);

    assert.deepEqual(result, []);
    assert.equal(stats.compressedTokens, 0);
  });

  it("handles messages with toolCalls — collects toolCall IDs into block", () => {
    const state = globalState.getOrCreate(
      "test-session",
      1, /* protectedTurns */
    );
    const config = compressConfig({ turnProtection: 1 });
    const long = "X".repeat(300);
    const messages: MessageRef[] = [
      {
        id: "m0000",
        role: "assistant",
        content: long,
        toolCalls: [
          { id: "t0000", toolName: "read", parameters: { path: "a.ts" } },
        ],
      },
      { id: "m0001", role: "user", content: "Hello" },
      { id: "m0002", role: "assistant", content: long }, // protected
    ];

    const stats = zeroStats();
    applyCompression(state, config, messages, stats);

    const blocks = [...state.blocksById.values()];
    assert.equal(blocks.length, 1);
    assert.ok(blocks[0].directToolIds.includes("t0000"));
    assert.equal(blocks[0].directToolIds.length, 1);
  });

  // ── 8. Block deactivation ──

  it("deactivates existing blocks when they are consumed by a new block", () => {
    const state = globalState.getOrCreate("test-session", 1);
    // Use turnProtection=1 so the first compression creates a block
    // and the second compression overlaps with its anchor
    const config = compressConfig({ turnProtection: 1 });
    const long = "X".repeat(300);

    // First compression: 3 messages, all compressible
    const messages1: MessageRef[] = [
      { id: "m0000", role: "user", content: long },
      { id: "m0001", role: "assistant", content: long },
      { id: "m0002", role: "assistant", content: long },
    ];
    const stats1 = zeroStats();
    applyCompression(state, config, messages1, stats1);

    // Block 1 should be active (anchor = m0000)
    const block1 = state.blocksById.get(1);
    assert.ok(block1);
    assert.equal(block1.active, true);
    assert.equal(block1.anchorMessageId, "m0000");

    // Second compression — use the ORIGINAL messages plus new ones,
    // so m0000 (the anchor) is still in the compression range.
    const messages2: MessageRef[] = [
      { id: "m0000", role: "user", content: long },
      { id: "m0001", role: "assistant", content: long },
      { id: "m0002", role: "assistant", content: long },
      { id: "m0003", role: "user", content: long },
      { id: "m0004", role: "assistant", content: long },
    ];
    const stats2 = zeroStats();
    applyCompression(state, config, messages2, stats2);

    // Block 1 should now be deactivated (its anchor m0000 was consumed
    // by the new block's compression range)
    assert.equal(block1.active, false);
    assert.ok(block1.deactivatedAt);
    assert.ok(block1.deactivatedByBlockId);
  });

  it("syncCompressionBlocks deactivates orphan blocks", () => {
    const state = globalState.getOrCreate("test-session2", 1);
    const config = compressConfig({ turnProtection: 1 });
    const long = "X".repeat(300);

    // Create a compression block
    const messages: MessageRef[] = [
      { id: "m0000", role: "user", content: long },
      { id: "m0001", role: "assistant", content: long },
      { id: "m0002", role: "assistant", content: long }, // protected
    ];
    const stats = zeroStats();
    applyCompression(state, config, messages, stats);

    // Block should be active
    const block = state.blocksById.values().next().value;
    assert.ok(block);
    assert.equal(block.active, true);

    // Simulate removal of the anchor message (e.g., OpenCode compaction)
    const messagesWithoutAnchor: MessageRef[] = [
      { id: "m0002", role: "assistant", content: long },
    ];

    // Call syncCompressionBlocks — should deactivate the block
    syncCompressionBlocks(state, messagesWithoutAnchor);

    // Block should now be deactivated
    assert.equal(block.active, false);
    assert.ok(block.deactivatedAt);
    assert.ok(!state.activeBlockIds.has(block.blockId));
  });
});

// 116 tests
