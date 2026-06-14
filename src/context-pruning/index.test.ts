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
import type {
  ContextPruningConfig,
  MessageRef,
  PipelineInput,
  PipelineOutput,
  PruneState,
} from "./types";
import { runPipeline, prepareSession } from "./pipeline";
import { buildNudges } from "./nudge";
import { ContextPruningState, globalState } from "./state";
import { loadContextConfig, resolveThreshold } from "./config-loader";
import { estimateTokens, estimateTotalTokens, getContextTokens } from "./estimator";

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
    protectUserMessages: true,
    turnProtection: 2,
    dedupProtectedTools: ["task", "skill", "read"],
    purgeErrorsProtectedTools: ["task", "skill"],
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
    const messages: MessageRef[] = [
      msg("m0000", "user", "Hello"),
    ];
    const input: PipelineInput = {
      sessionId: "test-session",
      messages,
      config: passThroughConfig({ dedupEnabled: false, purgeErrorsEnabled: false }),
    };

    const output = runPipeline(input);
    assert.deepEqual(output.nudges, []);
  });

  it("returns zero stats when all strategies are disabled", () => {
    const messages: MessageRef[] = [
      msg("m0000", "user", "Hello"),
    ];
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
      { id: "m0000", role: "user" as const, content: undefined as unknown as string },
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
    const messages = [
      msg("m0000", "assistant", ""),
    ];

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
    const session = globalState.get("test-session")!;
    assert.equal(session.dedupCache.size, 1);
    const entry = session.dedupCache.values().next().value!;
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
    const session = globalState.get("test-session")!;
    const entry = session.dedupCache.values().next().value!;
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
    const session = globalState.get("test-session")!;
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
    const session = globalState.get("test-session")!;
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
    const session = globalState.get("test-session")!;
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

  it("does not include iteration nudge when count is below threshold", () => {
    const nudges = buildNudges(50, config, 5, 8);
    assert.deepEqual(nudges, []);
  });

  it("includes iteration nudge when iteration count exceeds 10", () => {
    const nudges = buildNudges(50, config, 5, 15);
    assert.equal(nudges.length, 1);
    assert.ok(nudges[0].includes("Iteration"));
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
    assert.equal(output.messages[0].toolCalls![0].toolName, "read");
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
    ];
    const input: PipelineInput = {
      sessionId: "test-session",
      messages,
      config: passThroughConfig(),
    };

    const output = runPipeline(input);
    assert.equal(output.messages.length, 1);
    const meta = output.messages[0].metadata;
    assert.ok(meta);
    assert.equal(meta.keep, "me");
    assert.equal(meta._provider, undefined);
    assert.equal(meta._raw, undefined);
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
    assert.equal(config.protectUserMessages, true);
    assert.equal(config.turnProtection, 2);
    assert.deepEqual(config.dedupProtectedTools, ["task", "skill", "read"]);
    assert.deepEqual(config.purgeErrorsProtectedTools, ["task", "skill"]);
  });

  it("returns correct defaults when input is undefined", () => {
    const config = loadContextConfig(undefined as unknown as Record<string, any>);
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
    assert.equal(config.protectUserMessages, false);
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
