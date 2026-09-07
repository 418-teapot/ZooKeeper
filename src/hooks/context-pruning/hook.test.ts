/**
 * Tests for the context-pruning transform handler.
 *
 * Focused suite covering the handler contracts and the pipeline phase
 * wiring (state → history → release → three producers →
 * fold + block maintenance → view render → nudge / manual compress →
 * save):
 *
 * - Release notification fires exactly once, text carries the
 *   "上下文清理" / "约回收" wording.
 * - Log field sets: `prune_completed` counts effective marks
 *   only, `marks_released` carries the forced field, `nudge_injected` /
 *   `manual_compress_injected` carry their payloads.
 * - Robust no-ops for null / undefined / empty / missing
 *   sessionID inputs.
 * - The unit registration contributes the transform handler
 *   unconditionally.
 * - Persistence round-trip through the shared store (restart keeps
 *   blocks folding and marks pruning), nudge injection + anchor
 *   persistence, config gating combinations, and the session-cleanup
 *   contract for the pending-view-change bypass.
 *
 * Fixtures are v1-shaped message arrays driven through the real
 * handler; state and persistence go through the process-wide shared
 * manager (`getContextStateManager`), with session files cleaned up in
 * teardown.
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { ToolHost } from "../../core/client/tool-host.js";
import type { HostAdapter, HostMessage } from "../../core/context/lens.js";
import { project } from "../../core/context/lens.js";
import { PRUNED_TOOL_OUTPUT_REPLACEMENT } from "../../core/context/message-parts.js";
import {
  _resetForTesting as _resetModelLimitsForTesting,
  setModelLimit,
} from "../../core/context/model-limits.js";
import { creditReclaim } from "../../core/context/nudge.js";
import {
  _listRoundViewSessionsForTesting,
  getRoundView,
} from "../../core/context/round-view.js";
import {
  _resetContextStateManagerForTesting,
  cleanupSession,
  consumePendingViewChange,
  getContextStateManager,
  getRuntimeFlaggedState,
  setPendingViewChange,
} from "../../core/context/runtime.js";
import { computeSpanHash } from "../../core/context/spanhash.js";
import { allocateBlockId, markKey } from "../../core/context/state.js";
import type { ActiveSet, Deps } from "../../core/slots.js";
import { createV1Adapter } from "../../opencode.js";
import { _getBufferForTesting, _resetForTesting } from "../../utils/logger.js";
import {
  contextPruningTransformHandler,
  handleContextPruning,
} from "./hook.js";
import { unit } from "./index.js";

// ---------------------------------------------------------------------------
// Local v1-shaped fixture types
//
// The handler is driven through the real v1 adapter, but the test fixtures
// only need a structural subset of the full TestMessageEntry type.
// ---------------------------------------------------------------------------

/** Minimal v1-shaped message entry used by fixtures. */
interface TestMessageEntry {
  info: {
    role: string;
    id: string;
    sessionID?: string;
    tokens?: TestTokenInfo;
    synthetic?: boolean;
    ignored?: boolean;
  };
  parts: unknown[];
}

/** Minimal v1-shaped token report used by fixtures. */
interface TestTokenInfo {
  input?: number;
  output?: number;
  reasoning?: number;
  cache?: { read?: number; write?: number };
}

/** Shared v1 adapter instance for the fixture-driven tests. */
const adapter = createV1Adapter();

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

/** Session IDs used by tests in this file (for persisted-file cleanup). */
const TEST_SESSION_IDS = [
  "sess-persist-roundtrip",
  "sess-sweep-notify",
  "sess-sweep-below",
  "sess-log-effective",
  "sess-release-forced",
  "sess-nudge-basic",
  "sess-nudge-window-plain",
  "sess-nudge-window-folded",
  "sess-nudge-reclaim-credit",
  "sess-nudge-no-section",
  "sess-nudge-no-tool",
  "sess-nudge-toast",
  "sess-nudge-toast-urgent",
  "sess-toast-wire",
  "sess-toast-wire-noui",
  "sess-manual-basic",
  "sess-manual-no-tool",
  "sess-dedup-marked",
  "sess-dedup-gated",
  "sess-dedup-pending",
  "sess-pure-mock",
  "sess-round-view",
  "sess-stale-expiry",
  "sess-terminal-view-change",
  "sess-cleanup-bypass",
  "sess-cleanup-control",
];

afterEach(() => {
  const manager = getContextStateManager();
  for (const sid of TEST_SESSION_IDS) {
    manager.store.delete(sid);
  }
  _resetContextStateManagerForTesting();
  _resetForTesting();
  _resetModelLimitsForTesting();
});

/** Build a text part. */
function textPart(
  text: string,
  ignored = false,
): { type: string; text: string; ignored?: boolean } {
  return { type: "text", text, ...(ignored ? { ignored: true } : {}) };
}

/**
 * Build a tool part with a callID, optional input, output, and status.
 */
function toolPart(
  output: string,
  input?: unknown,
  status?: string,
): {
  type: string;
  callID: string;
  tool: string;
  state: { input: unknown; output: string; status?: string };
} {
  return {
    type: "tool",
    callID: `call-${Math.random().toString(36).slice(2, 8)}`,
    tool: "bash",
    state: {
      input: input ?? "",
      output,
      ...(status ? { status } : {}),
    },
  };
}

/**
 * Build a message entry with the given role, id, parts, optional session
 * ID and token report.
 */
function msg(
  role: string,
  id: string,
  parts: unknown[],
  sessionID?: string,
  tokens?: TestTokenInfo,
): TestMessageEntry {
  return {
    info: {
      role,
      id,
      ...(sessionID ? { sessionID } : {}),
      ...(tokens ? { tokens } : {}),
    },
    parts: parts as TestMessageEntry["parts"],
  };
}

/** Long output so tool-output replacement reclaims tokens. */
const LONG_OUTPUT = "x".repeat(2000);

/** Model limit used to open the producer context gates in flow runs. */
const MODEL_LIMIT = 1_000_000;

// ---------------------------------------------------------------------------
// Block staleness — span-hash invalidation keeps the record
// ---------------------------------------------------------------------------

describe("block staleness (span-hash invalidation)", () => {
  /** A three-message transcript whose first text is caller-chosen. */
  const turn = (sessionID: string, firstText: string): TestMessageEntry[] => [
    msg("user", "u1", [textPart(firstText)], sessionID),
    msg("assistant", "a1", [toolPart("first call output")]),
    msg("user", "u2", [textPart("again")], sessionID),
  ];

  /** Seed an active block over [0, 2) hashing the given transcript. */
  function seedBlock(sessionID: string, hashing: TestMessageEntry[]): void {
    const state = getContextStateManager().get(sessionID);
    state.blocks.set(1, {
      start: 0,
      end: 2,
      title: "会话开场",
      summary: "packed summary",
      spanHash: computeSpanHash(adapter.history(hashing), 0, 2),
      status: "active",
      compressedTokens: 100,
      summaryTokens: 10,
      createdAt: 1000,
    });
  }

  const NO_PRODUCERS = { dedup: {}, purgeErrors: {} };

  it("folds while the span validates, then expands once it does not", () => {
    const sessionID = "sess-stale-expiry";
    seedBlock(sessionID, turn(sessionID, "hello"));

    const roundOne = turn(sessionID, "hello");
    contextPruningTransformHandler(adapter, roundOne, NO_PRODUCERS);
    assert.equal(roundOne[0].info.synthetic, true, "block folds while valid");
    assert.equal(
      getContextStateManager().get(sessionID).blocks.get(1)?.status,
      "active",
    );

    // The covered content changed under the block: it can no longer
    // vouch for its interval.
    const roundTwo = turn(sessionID, "rewritten opening");
    contextPruningTransformHandler(adapter, roundTwo, NO_PRODUCERS);

    assert.equal(
      roundTwo[0].info.synthetic,
      undefined,
      "the invalidated interval expands back into originals",
    );
    assert.equal(
      getContextStateManager().get(sessionID).blocks.get(1)?.status,
      "stale",
    );
  });

  it("keeps the record addressable — retained in the map with its text", () => {
    const sessionID = "sess-stale-expiry";
    seedBlock(sessionID, turn(sessionID, "hello"));
    contextPruningTransformHandler(
      adapter,
      turn(sessionID, "hello"),
      NO_PRODUCERS,
    );

    contextPruningTransformHandler(
      adapter,
      turn(sessionID, "rewritten opening"),
      NO_PRODUCERS,
    );

    const state = getContextStateManager().get(sessionID);
    const block = state.blocks.get(1);
    assert.ok(block !== undefined, "the record is not deleted");
    assert.equal(block.title, "会话开场");
    assert.equal(block.summary, "packed summary");
    assert.deepEqual([block.start, block.end], [0, 2]);
    assert.equal(state.blocks.size, 1);
  });

  it("logs the transition with the interval and both hashes", () => {
    const sessionID = "sess-stale-expiry";
    seedBlock(sessionID, turn(sessionID, "hello"));
    contextPruningTransformHandler(
      adapter,
      turn(sessionID, "hello"),
      NO_PRODUCERS,
    );
    const before = _getBufferForTesting().length;

    contextPruningTransformHandler(
      adapter,
      turn(sessionID, "rewritten opening"),
      NO_PRODUCERS,
    );

    const entry = _getBufferForTesting()
      .slice(before)
      .find((e) => e.event === "compress_block_stale") as
      | Record<string, unknown>
      | undefined;
    assert.ok(entry, "compress_block_stale logged for the invalidated block");
    assert.equal(entry.blockId, 1);
    assert.equal(entry.start, 0);
    assert.equal(entry.end, 2);
    assert.equal(entry.reason, "hash-mismatch");
    assert.equal(entry.title, "会话开场");
    assert.equal(entry.historyLength, 3);
    assert.equal(typeof entry.storedHash, "string");
    assert.equal(typeof entry.currentHash, "string");
    assert.notEqual(entry.storedHash, entry.currentHash);
  });

  it("reports a reason instead of a hash when the span is out of bounds", () => {
    const sessionID = "sess-stale-expiry";
    seedBlock(sessionID, turn(sessionID, "hello"));
    const before = _getBufferForTesting().length;

    // The transcript shrank under the block's interval (a revert cut).
    const truncated = [msg("user", "u1", [textPart("hello")], sessionID)];
    contextPruningTransformHandler(adapter, truncated, NO_PRODUCERS);

    const entry = _getBufferForTesting()
      .slice(before)
      .find((e) => e.event === "compress_block_stale") as
      | Record<string, unknown>
      | undefined;
    assert.ok(entry, "the out-of-bounds block is reported stale");
    assert.equal(entry.reason, "out-of-bounds");
    assert.equal(typeof entry.storedHash, "string");
    assert.equal(entry.currentHash, null, "no hash is defined for the span");
    assert.equal(entry.historyLength, 1);
    assert.equal(
      getContextStateManager().get(sessionID).blocks.get(1)?.status,
      "stale",
    );
  });

  it("never re-ages a stale block in later rounds", () => {
    const sessionID = "sess-stale-expiry";
    seedBlock(sessionID, turn(sessionID, "hello"));
    contextPruningTransformHandler(
      adapter,
      turn(sessionID, "rewritten opening"),
      NO_PRODUCERS,
    );
    assert.equal(
      getContextStateManager().get(sessionID).blocks.get(1)?.status,
      "stale",
    );
    const before = _getBufferForTesting().length;

    contextPruningTransformHandler(
      adapter,
      turn(sessionID, "rewritten opening"),
      NO_PRODUCERS,
    );

    assert.equal(
      _getBufferForTesting()
        .slice(before)
        .filter((e) => e.event === "compress_block_stale").length,
      0,
      "a terminal block is never re-validated or re-reported",
    );
    assert.equal(
      getContextStateManager().get(sessionID).blocks.get(1)?.status,
      "stale",
    );
  });

  it("allocates a fresh id for the next block instead of reusing b1", () => {
    const sessionID = "sess-stale-expiry";
    seedBlock(sessionID, turn(sessionID, "hello"));
    contextPruningTransformHandler(
      adapter,
      turn(sessionID, "rewritten opening"),
      NO_PRODUCERS,
    );

    const state = getContextStateManager().get(sessionID);
    assert.equal(allocateBlockId(state), 2);
    assert.equal(state.blocks.get(1)?.status, "stale");
  });
});

// ---------------------------------------------------------------------------
// Retained terminal blocks and the release bypass
//
// Terminal records stay in the state map, so a fold round over them is
// steady state: only a block that drops out of the view in THIS round
// arms the pending-view-change bypass.
// ---------------------------------------------------------------------------

describe("retained terminal blocks do not force every release", () => {
  const sessionID = "sess-terminal-view-change";

  /** A three-message transcript whose first text is caller-chosen. */
  const turn = (firstText: string): TestMessageEntry[] => [
    msg("user", "u1", [textPart(firstText)], sessionID),
    msg("assistant", "a1", [toolPart("first call output")]),
    msg("user", "u2", [textPart("again")], sessionID),
  ];

  /** Seed a pending mark over a1's tool-output region. */
  function seedPendingMark(): void {
    getContextStateManager().get(sessionID).marks.set(markKey(1, 1), {
      anchorOrdinal: 1,
      regionIndex: 1,
      content: "first call output",
      contentTokens: 400,
      effective: false,
      markedAt: 1000,
    });
  }

  /** marks_released entries recorded after the buffer watermark. */
  function releasedLog(since: number): Record<string, unknown>[] {
    return _getBufferForTesting()
      .slice(since)
      .filter((e) => e.event === "marks_released") as Record<string, unknown>[];
  }

  it("arms the bypass for the expiry round only", () => {
    // releasedPercent is unset, so the percentage gate stays closed and a
    // release can only come from the view-change bypass.
    const config = { dedup: {}, purgeErrors: {} };
    const state = getContextStateManager().get(sessionID);
    state.blocks.set(1, {
      start: 0,
      end: 2,
      summary: "packed summary",
      spanHash: computeSpanHash(adapter.history(turn("hello")), 0, 2),
      status: "active",
      compressedTokens: 100,
      summaryTokens: 10,
      createdAt: 1000,
    });

    // Round 1: the span still validates; the pending mark stays pending.
    seedPendingMark();
    let watermark = _getBufferForTesting().length;
    contextPruningTransformHandler(adapter, turn("hello"), config);
    assert.equal(releasedLog(watermark).length, 0, "gate closed, no bypass");

    // Round 2: the content changes, the block goes stale and arms the
    // bypass for the NEXT round.
    watermark = _getBufferForTesting().length;
    contextPruningTransformHandler(adapter, turn("rewritten opening"), config);
    assert.equal(state.blocks.get(1)?.status, "stale");
    assert.equal(releasedLog(watermark).length, 0, "the flag lands next turn");

    // Round 3: the bypass fires — the mark flushes even with the gate shut.
    watermark = _getBufferForTesting().length;
    contextPruningTransformHandler(adapter, turn("rewritten opening"), config);
    const forced = releasedLog(watermark);
    assert.equal(forced.length, 1, "the armed bypass flushed the mark");
    assert.equal(forced[0].forced, "view_change");

    // Round 4: the stale record is still in the map, yet the steady-state
    // fold over it must not arm the bypass again.
    seedPendingMark();
    watermark = _getBufferForTesting().length;
    contextPruningTransformHandler(adapter, turn("rewritten opening"), config);
    assert.equal(state.blocks.size, 1, "the record is retained");
    assert.equal(state.blocks.get(1)?.status, "stale");
    assert.equal(
      releasedLog(watermark).length,
      0,
      "a retained terminal block is not a view change",
    );
  });

  it("treats a terminal record in the map as steady state every round", () => {
    const config = { dedup: {}, purgeErrors: {} };
    const state = getContextStateManager().get(sessionID);
    // A block that stopped folding but stayed in the map (restored or
    // swallowed by a wider block) — exactly what retention now leaves
    // behind round after round.
    state.blocks.set(1, {
      start: 0,
      end: 2,
      summary: "packed summary",
      spanHash: computeSpanHash(adapter.history(turn("hello")), 0, 2),
      status: "consumed",
      compressedTokens: 100,
      summaryTokens: 10,
      createdAt: 1000,
    });

    for (const round of ["first", "second"]) {
      seedPendingMark();
      const watermark = _getBufferForTesting().length;
      contextPruningTransformHandler(adapter, turn("hello"), config);
      assert.equal(
        releasedLog(watermark).length,
        0,
        `${round} round over a retained block must not force a flush`,
      );
      assert.equal(state.blocks.size, 1, "the record survives the round");
      assert.equal(state.blocks.get(1)?.status, "consumed");
    }
  });
});

// ---------------------------------------------------------------------------
// Session cleanup and the fold-armed bypass
//
// A fold view change arms the bypass after the release phase has already
// consumed it, so the flag survives the final round of a session. The
// deleted-session cleanup must drop it with the session's other records.
// ---------------------------------------------------------------------------

describe("cleanupSession drops a bypass armed by the fold", () => {
  /** A three-message transcript addressed to the given session. */
  const turnFor = (
    sessionID: string,
    firstText: string,
  ): TestMessageEntry[] => [
    msg("user", "u1", [textPart(firstText)], sessionID),
    msg("assistant", "a1", [toolPart("first call output")]),
    msg("user", "u2", [textPart("again")], sessionID),
  ];

  /**
   * Run one round whose opening text changes, staling the active block
   * and arming the bypass for the NEXT round.
   */
  function armBypass(sessionID: string): void {
    const state = getContextStateManager().get(sessionID);
    state.blocks.set(1, {
      start: 0,
      end: 2,
      summary: "packed summary",
      spanHash: computeSpanHash(
        adapter.history(turnFor(sessionID, "hello")),
        0,
        2,
      ),
      status: "active",
      compressedTokens: 100,
      summaryTokens: 10,
      createdAt: 1000,
    });
    contextPruningTransformHandler(
      adapter,
      turnFor(sessionID, "rewritten opening"),
      { dedup: {}, purgeErrors: {} },
    );
    assert.equal(state.blocks.get(1)?.status, "stale", "the span went stale");
  }

  it("leaves no armed flag behind once the session is cleaned up", () => {
    // Control: without cleanup the armed flag is pending for the next
    // round, so the assertion below is not vacuously true.
    armBypass("sess-cleanup-control");
    assert.equal(
      consumePendingViewChange("sess-cleanup-control"),
      true,
      "the fold armed the bypass",
    );

    armBypass("sess-cleanup-bypass");
    cleanupSession("sess-cleanup-bypass");
    assert.equal(
      consumePendingViewChange("sess-cleanup-bypass"),
      false,
      "cleanupSession must drop the fold-armed bypass",
    );
  });
});

// ---------------------------------------------------------------------------
// Robust no-ops
// ---------------------------------------------------------------------------

describe("robustness", () => {
  it("is a no-op for null messages", () => {
    assert.doesNotThrow(() =>
      contextPruningTransformHandler(adapter, null, {}),
    );
  });

  it("is a no-op for undefined messages", () => {
    assert.doesNotThrow(() =>
      contextPruningTransformHandler(adapter, undefined, {}),
    );
  });

  it("is a no-op for an empty array", () => {
    assert.doesNotThrow(() => contextPruningTransformHandler(adapter, [], {}));
  });

  it("is a no-op when the first message has no sessionID", () => {
    const messages = [msg("user", "u1", [textPart("hi")])];
    assert.doesNotThrow(() =>
      contextPruningTransformHandler(adapter, messages, {
        dedup: { thresholdContext: 100000 },
        purgeErrors: { thresholdContext: 100000 },
        compress: { protectedTokens: 0, thresholdTokens: 0 },
      }),
    );
    assert.equal(messages.length, 1, "input untouched");
  });

  it("is a no-op when the first message is null", () => {
    const messages = [null, msg("user", "u2", [textPart("hi")])];
    assert.doesNotThrow(() =>
      contextPruningTransformHandler(
        adapter,
        messages as unknown as TestMessageEntry[],
        {},
      ),
    );
  });

  it("tolerates messages with null parts and stateless tool parts", () => {
    const sessionID = "sess-robust-parts";
    const messages = [
      msg("user", "u1", [textPart("do it")], sessionID),
      {
        info: { role: "assistant", id: "a1", sessionID },
        parts: [null, { type: "tool" }, { type: "text", text: "ok" }],
      } as unknown as TestMessageEntry,
      msg("user", "u2", [null, textPart("again")], sessionID),
    ];
    // The pipeline must never throw on degenerate part shapes.
    assert.doesNotThrow(() =>
      contextPruningTransformHandler(adapter, messages, {
        dedup: { thresholdContext: 100000 },
        purgeErrors: {},
      }),
    );
    assert.equal(messages.length, 3, "no synthetic messages appended");
  });
});

// ---------------------------------------------------------------------------
// Persistence round-trip
// ---------------------------------------------------------------------------

describe("persistence round-trip via the shared store", () => {
  it("restart keeps blocks folding and effective marks pruning", () => {
    const sessionID = "sess-persist-roundtrip";

    const buildTurn = (): TestMessageEntry[] => [
      msg("user", "u1", [textPart("hello")], sessionID),
      msg("assistant", "a1", [toolPart("first call output")], undefined, {
        input: 6000,
        output: 200,
      }),
      msg("user", "u2", [textPart("again")], sessionID),
      msg("assistant", "a2", [toolPart(LONG_OUTPUT)]),
    ];

    // Seed a persistent block over [0,2) and one effective mark on a2's
    // tool-output region (ordinal 3, region index 1).
    const manager = getContextStateManager();
    const state = manager.get(sessionID);
    const turnOne = buildTurn();
    state.blocks.set(1, {
      start: 0,
      end: 2,
      summary: "packed",
      spanHash: computeSpanHash(adapter.history(turnOne), 0, 2),
      status: "active",
      compressedTokens: 100,
      summaryTokens: 10,
      createdAt: 1000,
    });
    state.marks.set(markKey(3, 1), {
      anchorOrdinal: 3,
      regionIndex: 1,
      content: LONG_OUTPUT.slice(0, 100),
      contentTokens: 400,
      effective: true,
      markedAt: 1000,
    });

    // Turn 1: effective mark applied + block folded + state saved.
    const turnOneMessages = buildTurn();
    contextPruningTransformHandler(adapter, turnOneMessages, {
      dedup: {},
      purgeErrors: {},
    });
    assert.equal(turnOneMessages.length, 3, "folded view materialized");
    assert.equal(turnOneMessages[0].info.synthetic, true);
    assert.equal(
      (turnOneMessages[0].parts?.[0] as { text?: string }).text,
      "[m1] [Block b1 · 2 条]\npacked",
      "summary message rendered with line ref",
    );

    // Simulate a restart: drop the in-memory cache (state reloads from
    // the store on the next get).
    _resetContextStateManagerForTesting();

    // Turn 2: fresh transcript from the host — the reloaded state must
    // still fold the block and apply the effective mark.
    const turnTwoMessages = buildTurn();
    contextPruningTransformHandler(adapter, turnTwoMessages, {
      dedup: {},
      purgeErrors: {},
    });
    assert.equal(turnTwoMessages.length, 3, "block still folds");
    assert.equal(turnTwoMessages[0].info.synthetic, true);
    const a2Part = turnTwoMessages[2].parts?.[0] as {
      state?: { output: string };
    };
    assert.ok(
      a2Part.state?.output.includes(PRUNED_TOOL_OUTPUT_REPLACEMENT),
      "effective mark still prunes the tool output after restart",
    );

    // The reloaded state itself carries the block and the mark.
    const reloaded = getContextStateManager().get(sessionID);
    assert.equal(reloaded.blocks.size, 1, "block persisted");
    assert.equal(reloaded.marks.size, 1, "mark persisted");
    assert.equal(reloaded.marks.get(markKey(3, 1))?.effective, true);
  });
});

// ---------------------------------------------------------------------------
// Release notification contract + sweep lifecycle
// ---------------------------------------------------------------------------

describe("release notification", () => {
  it("notifies exactly once with the cleanup wording on a batch release", () => {
    const sessionID = "sess-sweep-notify";
    setModelLimit(sessionID, MODEL_LIMIT, "test-model");

    const buildTurn = (): TestMessageEntry[] => [
      msg("user", "u1", [textPart("do it")], sessionID),
      msg("assistant", "a1", [toolPart(LONG_OUTPUT)], undefined, {
        input: 800000,
        output: 200,
      }),
    ];

    const notifyCalls: string[] = [];
    const notify = (text: string) => {
      notifyCalls.push(text);
    };
    const config = {
      protectedMessages: 0,
      releasedPercent: 0,
    };

    // Turn N: sweep marks the tool output as pending; nothing releases.
    contextPruningTransformHandler(adapter, buildTurn(), config, notify);
    assert.equal(notifyCalls.length, 0, "no release on the marking turn");
    const state = getContextStateManager().get(sessionID);
    assert.equal(state.marks.size, 1, "sweep wrote one pending mark");
    assert.equal(state.marks.get(markKey(1, 1))?.effective, false);
    const entries = _getBufferForTesting();
    assert.ok(
      entries.some((e) => e.event === "sweep_marked"),
      "sweep_marked log event",
    );

    // Turn N+1: the pending mark flips and the notify fires exactly once.
    contextPruningTransformHandler(adapter, buildTurn(), config, notify);
    assert.equal(notifyCalls.length, 1, "notify called exactly once");

    // The notification text carries the required wording and the mark
    // count.
    const text = notifyCalls[0];
    assert.ok(
      text.includes("上下文清理"),
      "should contain the cleanup keyword",
    );
    assert.ok(text.includes("约回收"), "should use the 回收 verb");
    assert.ok(text.includes("1"), "should mention the mark count");

    const releaseLog = _getBufferForTesting().find(
      (e) => e.event === "marks_released",
    ) as Record<string, unknown> | undefined;
    assert.ok(releaseLog, "marks_released log event");
    assert.equal(releaseLog.releasedCount, 1);
    // Prompt-side total = input + cache read + cache write (output excluded).
    assert.equal(releaseLog.promptTokens, 800000);
    assert.ok(
      !("forced" in releaseLog),
      "no forced field on a threshold release",
    );
  });

  it("keeps marks pending while the releasedPercent gate is closed", () => {
    const sessionID = "sess-sweep-below";
    setModelLimit(sessionID, MODEL_LIMIT, "test-model");
    const buildTurn = (): TestMessageEntry[] => [
      msg("user", "u1", [textPart("do it")], sessionID),
      msg("assistant", "a1", [toolPart(LONG_OUTPUT)], undefined, {
        input: 800000,
        output: 200,
      }),
    ];

    // releasedPercent undefined → the gate stays closed regardless of
    // pending tokens: the sweep mark accumulates but never flips.
    const config = { protectedMessages: 0 };
    for (let turn = 0; turn < 2; turn++) {
      const notifyCalls: string[] = [];
      contextPruningTransformHandler(adapter, buildTurn(), config, (t) =>
        notifyCalls.push(t),
      );
      assert.equal(notifyCalls.length, 0, "no release without releasedPercent");
    }
    const state = getContextStateManager().get(sessionID);
    const marks = [...state.marks.values()];
    // The same position cannot be re-marked (first-write-wins), so the
    // single mark simply stays pending across turns.
    assert.equal(marks.length, 1, "the sweep mark persists");
    assert.equal(marks[0]?.effective, false, "never released");
  });
});

// ---------------------------------------------------------------------------
// Log field sets
// ---------------------------------------------------------------------------

describe("log field sets", () => {
  it("prune_completed counts effective marks only", () => {
    const sessionID = "sess-log-effective";
    const manager = getContextStateManager();
    const state = manager.get(sessionID);

    // 2 effective marks + 1 pending mark.
    state.marks.set(markKey(1, 1), {
      anchorOrdinal: 1,
      regionIndex: 1,
      content: "eff1",
      contentTokens: 200,
      effective: true,
      markedAt: 1000,
    });
    state.marks.set(markKey(1, 4), {
      anchorOrdinal: 1,
      regionIndex: 4,
      content: "eff2",
      contentTokens: 300,
      effective: true,
      markedAt: 1000,
    });
    state.marks.set(markKey(1, 6), {
      anchorOrdinal: 1,
      regionIndex: 6,
      content: "pending",
      contentTokens: 500,
      effective: false,
      markedAt: 1000,
    });

    const messages = [
      msg("user", "u1", [textPart("do it")], sessionID),
      msg("assistant", "a1", [
        toolPart("eff1 output"),
        textPart("some text"),
        toolPart("eff2 output"),
        toolPart("pending output"),
      ]),
    ];
    contextPruningTransformHandler(adapter, messages, {
      dedup: {},
      purgeErrors: {},
    });

    const entry = _getBufferForTesting().find(
      (e) => e.event === "prune_completed",
    ) as Record<string, unknown> | undefined;
    assert.ok(entry, "prune_completed log event");
    assert.equal(entry.prunedToolCount, 2, "effective marks only, not 3");
    assert.equal(entry.totalReclaimedTokens, 500, "pending tokens excluded");
    assert.equal(entry.totalPruneTokens, 500);
  });

  it("marks_released carries the forced field when pendingViewChange bypasses the gate", () => {
    const sessionID = "sess-release-forced";
    const manager = getContextStateManager();
    const state = manager.get(sessionID);
    state.marks.set(markKey(1, 1), {
      anchorOrdinal: 1,
      regionIndex: 1,
      content: "long enough output",
      contentTokens: 400,
      effective: false,
      markedAt: 1000,
    });
    // A sibling unit (compress / decompress tool) armed the view change
    // through the shared runtime flag map.
    setPendingViewChange(sessionID);

    const messages = [
      msg("user", "u1", [textPart("do it")], sessionID),
      msg("assistant", "a1", [toolPart(LONG_OUTPUT)], undefined, {
        input: 1000,
        output: 200,
      }),
    ];
    const notifyCalls: string[] = [];
    contextPruningTransformHandler(
      adapter,
      messages,
      { dedup: {}, purgeErrors: {} },
      (t) => notifyCalls.push(t),
    );

    const entry = _getBufferForTesting().find(
      (e) => e.event === "marks_released",
    ) as Record<string, unknown> | undefined;
    assert.ok(entry, "marks_released log event");
    assert.equal(entry.forced, "view_change", "forced reason field");
    assert.equal(entry.releasedCount, 1);
    assert.equal(notifyCalls.length, 1, "forced release still notifies");

    // The flag is consumed — cleared by the release phase.
    assert.equal(
      consumePendingViewChange(sessionID),
      false,
      "flag consumed and cleared",
    );
  });
});

// ---------------------------------------------------------------------------
// Nudge injection + anchor persistence
// ---------------------------------------------------------------------------

describe("context-nudge injection", () => {
  const NUDGE_LIMIT = 200000;
  const NUDGE_CONFIG = {
    minContext: "60%",
    minContextCap: 200000,
    maxContext: "80%",
    maxContextCap: 300000,
    growthTokens: "5%",
  };

  /** Token/threshold protections disabled; only message count protects. */
  function nudgeTransformConfig(protectedMessages: number) {
    return {
      protectedMessages,
      nudge: NUDGE_CONFIG,
      compress: { protectedTokens: 0, thresholdTokens: 0 },
      dedup: {},
      purgeErrors: {},
    };
  }

  /** Two-turn view: only a1 carries tokens (output > 0). */
  function nudgeMessages(
    sessionID: string,
    inputTokens: number,
  ): TestMessageEntry[] {
    return [
      msg("user", "u1", [textPart("hello")], sessionID),
      msg("assistant", "a1", [toolPart("data one")], undefined, {
        input: inputTokens,
        output: 100,
      }),
      msg("user", "u2", [textPart("again")], sessionID),
      msg("assistant", "a2", [toolPart("data two")]),
    ];
  }

  it("injects a gentle nudge at the END and persists the anchor", () => {
    const sessionID = "sess-nudge-basic";
    setModelLimit(sessionID, NUDGE_LIMIT, "test-model");

    // Baseline eval at 140K — establishes the anchor silently.
    let messages = nudgeMessages(sessionID, 140000);
    contextPruningTransformHandler(
      adapter,
      messages,
      nudgeTransformConfig(2),
      undefined,
      true,
    );
    assert.equal(messages.length, 4, "baseline injects nothing");
    let state = getContextStateManager().get(sessionID);
    assert.equal(state.nudges?.lastNudgeTokens, 140000, "anchor persisted");

    // Growth past the gentle interval: 150K (delta 10K >= 10K).
    messages = nudgeMessages(sessionID, 150000);
    contextPruningTransformHandler(
      adapter,
      messages,
      nudgeTransformConfig(2),
      undefined,
      true,
    );

    // The synthetic nudge is appended at the very END carrying the
    // message shape the adapter emits (info marker + single text part).
    assert.equal(messages.length, 5, "nudge message appended");
    const last = messages[messages.length - 1];
    assert.equal(last.info.id, "zoo-nudge");
    assert.equal(last.info.role, "user");
    assert.equal(last.info.sessionID, sessionID);
    const text = (last.parts?.[0] as { text?: string }).text ?? "";
    assert.ok(text.startsWith("<internal-reminder>"), "wrapper opens");
    assert.ok(text.endsWith("</internal-reminder>"), "wrapper closes");
    assert.ok(
      text.includes("**CONTEXT GROWING — 150000 (75% of 200000 window)**"),
      "header filled from the gentle slots",
    );
    // protectedMessages=2 + first-user exclusion → window is a1 only,
    // whose per-round line ref is m2 (dense line numbering).
    assert.ok(
      text.includes("Compressible window: m2–m2"),
      "window refs placed in text",
    );
    assert.ok(/\(~\d+ tokens\)/.test(text), "reclaim estimate present");

    // Anchor ratcheted up to the fired level's tokens.
    state = getContextStateManager().get(sessionID);
    assert.equal(state.nudges?.lastNudgeTokens, 150000);

    // nudge_injected log carries the evaluation payload.
    const entry = _getBufferForTesting().find(
      (e) => e.event === "nudge_injected",
    ) as Record<string, unknown> | undefined;
    assert.ok(entry, "nudge_injected log event");
    assert.equal(entry.nudgeLevel, "gentle");
    assert.equal(entry.tokens, 150000);
    assert.equal(entry.anchor, 150000);
    assert.equal(entry.startRef, "m2");
    assert.equal(entry.endRef, "m2");
  });

  it("toasts the gentle nudge with source and info level, fire-and-forget", () => {
    const sessionID = "sess-nudge-toast";
    setModelLimit(sessionID, NUDGE_LIMIT, "test-model");
    const toasts: Array<{ source: string; level: string; text: string }> = [];
    const toast = (t: { source: string; level: string; text: string }) => {
      toasts.push(t);
    };

    // Baseline eval at 140K — nothing fires, so nothing toasts.
    let messages = nudgeMessages(sessionID, 140000);
    contextPruningTransformHandler(
      adapter,
      messages,
      nudgeTransformConfig(2),
      undefined,
      true,
      toast,
    );
    assert.equal(toasts.length, 0, "baseline eval toasts nothing");

    // Growth past the gentle interval: 150K → the nudge injects.
    messages = nudgeMessages(sessionID, 150000);
    contextPruningTransformHandler(
      adapter,
      messages,
      nudgeTransformConfig(2),
      undefined,
      true,
      toast,
    );
    assert.equal(messages[messages.length - 1].info.id, "zoo-nudge");
    assert.equal(toasts.length, 1, "toast fires exactly once per injection");
    assert.equal(toasts[0].source, "context-pruning");
    // Gentle band maps onto the transient-UI info level (one decision,
    // two audiences: the model nudge text stays separate).
    assert.equal(toasts[0].level, "info");
    // 150000 / 200000 → 75%.
    assert.match(toasts[0].text, /75%/);
  });

  it("toasts the urgent nudge with warning level", () => {
    const sessionID = "sess-nudge-toast-urgent";
    setModelLimit(sessionID, NUDGE_LIMIT, "test-model");
    const toasts: Array<{ source: string; level: string; text: string }> = [];
    const toast = (t: { source: string; level: string; text: string }) => {
      toasts.push(t);
    };

    // Baseline at 170K (already past the 80% max threshold) is silent.
    let messages = nudgeMessages(sessionID, 170000);
    contextPruningTransformHandler(
      adapter,
      messages,
      nudgeTransformConfig(2),
      undefined,
      true,
      toast,
    );
    assert.equal(toasts.length, 0);

    // 180K: delta 10K >= the urgent interval (5K) → urgent fires.
    messages = nudgeMessages(sessionID, 180000);
    contextPruningTransformHandler(
      adapter,
      messages,
      nudgeTransformConfig(2),
      undefined,
      true,
      toast,
    );
    const entry = _getBufferForTesting().find(
      (e) => e.event === "nudge_injected",
    ) as Record<string, unknown> | undefined;
    assert.equal(entry?.nudgeLevel, "urgent", "urgent band fired");
    assert.equal(toasts.length, 1);
    assert.equal(toasts[0].source, "context-pruning");
    assert.equal(toasts[0].level, "warning");
    // 180000 / 200000 → 90%.
    assert.match(toasts[0].text, /90%/);
  });

  it("does not re-inject while the anchor sits at the current tokens", () => {
    const sessionID = "sess-nudge-basic";
    setModelLimit(sessionID, NUDGE_LIMIT, "test-model");

    let messages = nudgeMessages(sessionID, 140000);
    contextPruningTransformHandler(
      adapter,
      messages,
      nudgeTransformConfig(2),
      undefined,
      true,
    );
    messages = nudgeMessages(sessionID, 150000);
    contextPruningTransformHandler(
      adapter,
      messages,
      nudgeTransformConfig(2),
      undefined,
      true,
    );
    assert.equal(messages[messages.length - 1].info.id, "zoo-nudge");

    // Same tokens again — delta 0 → the anchor already moved → silent.
    const messages2 = nudgeMessages(sessionID, 150000);
    contextPruningTransformHandler(
      adapter,
      messages2,
      nudgeTransformConfig(2),
      undefined,
      true,
    );
    assert.equal(messages2.length, 4, "no second injection");
    assert.equal(messages2[messages2.length - 1].info.id, "a2");
  });

  it("advertises the window in the folded view's coordinates", () => {
    // Two sessions over the same transcript; one carries an active block
    // folding ordinals 1-2.  The window the nudge advertises must be
    // measured over the view the model sees: the folded interval holds no
    // reclaim and the dense renumbering pulls the end ref back.
    const plain = "sess-nudge-window-plain";
    const folded = "sess-nudge-window-folded";
    setModelLimit(plain, NUDGE_LIMIT, "test-model");
    setModelLimit(folded, NUDGE_LIMIT, "test-model");

    const HEAVY = "y".repeat(2000);
    const viewMessages = (sessionID: string, inputTokens: number) => [
      msg("user", "u1", [textPart("开场问题")], sessionID),
      msg("assistant", "a1", [textPart(HEAVY)]),
      msg("assistant", "a2", [textPart(HEAVY)]),
      msg("assistant", "a3", [textPart(HEAVY)]),
      msg("user", "u4", [textPart("再来一次")], sessionID),
      msg("assistant", "a5", [textPart("好的")], undefined, {
        input: inputTokens,
        output: 100,
      }),
    ];

    // Seed the block over [1, 3) on the transcript as the fold sees it.
    const seed = viewMessages(folded, 140000);
    const snapshot = adapter.history(seed);
    getContextStateManager()
      .get(folded)
      .blocks.set(1, {
        start: 1,
        end: 3,
        summary: "已折叠的历史",
        spanHash: computeSpanHash(snapshot, 1, 3),
        status: "active",
        compressedTokens: 900,
        summaryTokens: 30,
        createdAt: 1000,
      });

    const run = (sessionID: string, inputTokens: number) => {
      _resetForTesting();
      contextPruningTransformHandler(
        adapter,
        viewMessages(sessionID, inputTokens),
        nudgeTransformConfig(2),
        undefined,
        true,
      );
      return _getBufferForTesting().find((e) => e.event === "nudge_injected") as
        | Record<string, unknown>
        | undefined;
    };

    // Baseline round establishes the anchor; the growth round fires.
    run(plain, 140000);
    run(folded, 140000);
    const plainEntry = run(plain, 150000);
    const foldedEntry = run(folded, 150000);
    assert.ok(plainEntry && foldedEntry, "both rounds fire the nudge");

    // Unfolded: the window is ordinals 1-3, i.e. lines m2-m4, and all
    // three messages are billed as reclaim.
    assert.equal(plainEntry.startRef, "m2");
    assert.equal(plainEntry.endRef, "m4");
    // Folded: the same content is lines m2-m3 (one summary plus one
    // original) and only the unfolded line still carries reclaim.
    assert.equal(foldedEntry.startRef, "m2");
    assert.equal(foldedEntry.endRef, "m3");
    assert.equal(
      Number(foldedEntry.reclaimTokens) * 3,
      Number(plainEntry.reclaimTokens),
      "the folded interval is not billed again",
    );
  });

  it("drops the water level as soon as a compression books its reclaim", () => {
    const sessionID = "sess-nudge-reclaim-credit";
    setModelLimit(sessionID, NUDGE_LIMIT, "test-model");
    const state = getContextStateManager().get(sessionID);

    // Anchor at 140K.
    contextPruningTransformHandler(
      adapter,
      nudgeMessages(sessionID, 140000),
      nudgeTransformConfig(2),
      undefined,
      true,
    );
    assert.equal(state.nudges?.lastNudgeTokens, 140000);

    // A compression frees 30K mid-round; the usage figure still reads
    // 150K because it was written by the call that preceded the compress.
    creditReclaim(state, 30000);
    const stale = nudgeMessages(sessionID, 150000);
    contextPruningTransformHandler(
      adapter,
      stale,
      nudgeTransformConfig(2),
      undefined,
      true,
    );
    assert.equal(stale.length, 4, "the reclaimed tokens are off the level");
    assert.equal(
      state.nudges?.lastNudgeTokens,
      120000,
      "water level follows the view down at once",
    );
    assert.equal(state.nudges?.pendingReclaimTokens, 30000, "still booked");
    assert.equal(state.nudges?.reclaimMeasurement, 150000, "anchored to it");

    // A newer measurement already includes the reclaim, so the credit is
    // consumed rather than subtracted again: the level is the measured
    // 152K, and that is 32K above the anchor → the nudge fires.
    const fresh = nudgeMessages(sessionID, 152000);
    contextPruningTransformHandler(
      adapter,
      fresh,
      nudgeTransformConfig(2),
      undefined,
      true,
    );
    assert.equal(
      fresh[fresh.length - 1].info.id,
      "zoo-nudge",
      "no double subtraction: the level is measured, not discounted twice",
    );
    assert.equal(state.nudges?.pendingReclaimTokens, undefined);
    assert.equal(state.nudges?.reclaimMeasurement, undefined);
    assert.equal(state.nudges?.lastNudgeTokens, 152000);
  });

  it("stays silent without the nudge section or the compress tool", () => {
    // Gate 1: the compress tool registered but NO nudge section — the
    // evaluation would fire at 150K if the section existed.
    const sessionID = "sess-nudge-no-section";
    setModelLimit(sessionID, NUDGE_LIMIT, "test-model");
    const noNudgeConfig = {
      protectedMessages: 2,
      compress: { protectedTokens: 0, thresholdTokens: 0 },
      dedup: {},
      purgeErrors: {},
    };
    let messages = nudgeMessages(sessionID, 140000);
    contextPruningTransformHandler(
      adapter,
      messages,
      noNudgeConfig,
      undefined,
      true,
    );
    messages = nudgeMessages(sessionID, 150000);
    contextPruningTransformHandler(
      adapter,
      messages,
      noNudgeConfig,
      undefined,
      true,
    );
    assert.equal(messages.length, 4, "absent nudge section → silent");

    // Gate 2: nudge section present but the compress tool NOT registered.
    const sessionID2 = "sess-nudge-no-tool";
    setModelLimit(sessionID2, NUDGE_LIMIT, "test-model");
    messages = nudgeMessages(sessionID2, 140000);
    contextPruningTransformHandler(
      adapter,
      messages,
      nudgeTransformConfig(2),
      undefined,
      false,
    );
    messages = nudgeMessages(sessionID2, 150000);
    contextPruningTransformHandler(
      adapter,
      messages,
      nudgeTransformConfig(2),
      undefined,
      false,
    );
    assert.equal(messages.length, 4, "no compress tool → no nudge");

    const entries = _getBufferForTesting();
    assert.ok(
      !entries.some((e) => e.event === "nudge_injected"),
      "no nudge_injected log without both gates",
    );
  });

  it("routes the nudge toast through the tool host toast port", () => {
    const sessionID = "sess-toast-wire";
    setModelLimit(sessionID, NUDGE_LIMIT, "test-model");
    const calls: Array<{
      sessionId: string;
      source: string;
      level: string;
      text: string;
    }> = [];
    const toolHost: ToolHost = {
      resolveSessionId: () => undefined,
      fetchHistory: async () => project([], []),
      notify: async () => {},
      toast: (sessionId, t) => {
        calls.push({
          sessionId,
          source: t.source,
          level: t.level,
          text: t.text,
        });
      },
    };

    // Baseline turn — nothing injects, so the port stays untouched.
    handleContextPruning(
      { messages: nudgeMessages(sessionID, 140000) },
      nudgeTransformConfig(2),
      toolHost,
      true,
      adapter,
    );
    assert.equal(calls.length, 0, "no toast on the baseline turn");

    // Growth turn — the nudge injects and the toast port receives it
    // synchronously (fire-and-forget — no await between handle returning
    // and the call landing).
    handleContextPruning(
      { messages: nudgeMessages(sessionID, 150000) },
      nudgeTransformConfig(2),
      toolHost,
      true,
      adapter,
    );
    assert.equal(calls.length, 1, "toast routed through the tool host");
    assert.equal(calls[0].sessionId, sessionID);
    assert.equal(calls[0].source, "context-pruning");
    assert.equal(calls[0].level, "info");
    assert.match(calls[0].text, /75%/);
  });

  it("never throws when the tool host wires no toast port", () => {
    const sessionID = "sess-toast-wire-noui";
    setModelLimit(sessionID, NUDGE_LIMIT, "test-model");
    // A host that implements notify but not the optional toast port.
    const toolHost: ToolHost = {
      resolveSessionId: () => undefined,
      fetchHistory: async () => project([], []),
      notify: async () => {},
    };
    handleContextPruning(
      { messages: nudgeMessages(sessionID, 140000) },
      nudgeTransformConfig(2),
      toolHost,
      true,
      adapter,
    );
    assert.doesNotThrow(() =>
      handleContextPruning(
        { messages: nudgeMessages(sessionID, 150000) },
        nudgeTransformConfig(2),
        toolHost,
        true,
        adapter,
      ),
    );
    // The nudge itself still injected — a missing UI channel never
    // affects the model-facing reminder.
    assert.ok(
      _getBufferForTesting().some((e) => e.event === "nudge_injected"),
      "nudge injection still happens without a toast port",
    );
  });
});

// ---------------------------------------------------------------------------
// Manual compress trigger (pendingManualTrigger)
// ---------------------------------------------------------------------------

describe("manual compress trigger", () => {
  /** Two-turn view with the compress section thresholds disabled. */
  function manualMessages(sessionID: string): TestMessageEntry[] {
    return [
      msg("user", "u1", [textPart("hello")], sessionID),
      msg("assistant", "a1", [toolPart("data one")], undefined, {
        input: 150000,
        output: 100,
      }),
      msg("user", "u2", [textPart("again")], sessionID),
      msg("assistant", "a2", [toolPart("data two")]),
    ];
  }

  function manualConfig(protectedMessages: number) {
    return {
      protectedMessages,
      compress: { protectedTokens: 0, thresholdTokens: 0 },
      dedup: {},
      purgeErrors: {},
    };
  }

  it("injects the synthetic user command at the END and clears the flag", () => {
    const sessionID = "sess-manual-basic";
    const state = getRuntimeFlaggedState(sessionID);
    state.pendingManualTrigger = true;

    const messages = manualMessages(sessionID);
    contextPruningTransformHandler(
      adapter,
      messages,
      manualConfig(2),
      undefined,
      true,
    );

    assert.equal(messages.length, 5, "synthetic command appended");
    const last = messages[messages.length - 1];
    assert.equal(last.info.id, "zoo-manual-compress");
    assert.equal(last.info.role, "user");
    assert.equal(last.info.sessionID, sessionID);
    const text = (last.parts?.[0] as { text?: string }).text ?? "";
    assert.ok(
      text.startsWith("请立即使用 compress 工具压缩历史上下文"),
      "user-instruction tone opener",
    );
    // protectedMessages=2 + first-user exclusion → window is a1 only (m2).
    assert.ok(text.includes("可压缩窗口：m2–m2"), "window payload attached");
    // One-shot: the flag is cleared after injection.
    assert.equal(state.pendingManualTrigger, false, "flag cleared");

    // manual_compress_injected log carries the eligibility payload.
    const entry = _getBufferForTesting().find(
      (e) => e.event === "manual_compress_injected",
    ) as Record<string, unknown> | undefined;
    assert.ok(entry, "manual_compress_injected log event");
    assert.equal(entry.startRef, "m2");
    assert.equal(entry.endRef, "m2");
    assert.equal(typeof entry.reclaimTokens, "number");
  });

  it("clears a stale flag without injecting when the compress tool is absent", () => {
    const sessionID = "sess-manual-no-tool";
    const state = getRuntimeFlaggedState(sessionID);
    state.pendingManualTrigger = true;

    const messages = manualMessages(sessionID);
    contextPruningTransformHandler(
      adapter,
      messages,
      manualConfig(2),
      undefined,
      false,
    );

    assert.equal(messages.length, 4, "no injection without the compress tool");
    assert.equal(state.pendingManualTrigger, false, "stale flag cleared");
    const entries = _getBufferForTesting();
    assert.ok(
      entries.some((e) => e.event === "manual_compress_skipped"),
      "manual_compress_skipped warn event",
    );
  });
});

// ---------------------------------------------------------------------------
// Config gating combinations
// ---------------------------------------------------------------------------

describe("config gating combinations", () => {
  /**
   * A 22-message transcript (over the dedup 20-message floor) whose last
   * assistant carries two identical tool calls plus a completed token
   * report (input 100000 + output 200 = 100200 exact).
   */
  function dedupTranscript(sessionID: string): TestMessageEntry[] {
    const messages: TestMessageEntry[] = [];
    for (let i = 0; i < 22; i++) {
      const role = i % 2 === 0 ? "user" : "assistant";
      if (i === 21) {
        messages.push(
          msg(
            "assistant",
            `a${i}`,
            [
              toolPart(LONG_OUTPUT, '{"cmd":"ls"}'),
              toolPart(LONG_OUTPUT, '{"cmd":"ls"}'),
            ],
            undefined,
            { input: 100000, output: 200 },
          ),
        );
      } else {
        messages.push(
          role === "user"
            ? msg(role, `u${i}`, [textPart(`prompt ${i}`)], sessionID)
            : msg(role, `a${i}`, [textPart(`reply ${i}`)], undefined),
        );
      }
    }
    return messages;
  }

  it("skips dedup entirely when thresholdContext is not configured", () => {
    const sessionID = "sess-dedup-gated";
    contextPruningTransformHandler(adapter, dedupTranscript(sessionID), {
      protectedMessages: 0,
    });
    const state = getContextStateManager().get(sessionID);
    assert.equal(state.marks.size, 0, "no marks without the dedup gate");
    const entries = _getBufferForTesting();
    assert.ok(
      !entries.some((e) => e.event === "dedup_marked"),
      "no dedup_marked log",
    );
  });

  it("runs dedup and leaves the mark pending when releasedPercent is undefined", () => {
    const sessionID = "sess-dedup-marked";
    setModelLimit(sessionID, MODEL_LIMIT, "test-model");

    // Turn N: dedup writes one pending mark; release gate is closed.
    contextPruningTransformHandler(adapter, dedupTranscript(sessionID), {
      protectedMessages: 0,
      dedup: { thresholdContext: 100000 },
      purgeErrors: {},
    });
    const state = getContextStateManager().get(sessionID);
    assert.equal(state.marks.size, 1, "one pending dedup mark");
    assert.equal(state.marks.get(markKey(21, 1))?.effective, false);

    // Turn N+1: the release gate is still closed and the position is
    // already claimed (first-write-wins), so the mark stays pending —
    // it never flips and is never re-marked.
    contextPruningTransformHandler(adapter, dedupTranscript(sessionID), {
      protectedMessages: 0,
      dedup: { thresholdContext: 100000 },
      purgeErrors: {},
    });
    assert.equal(
      state.marks.get(markKey(21, 1))?.effective,
      false,
      "mark stays pending",
    );
    const entries = _getBufferForTesting();
    const dedupLogs = entries.filter((e) => e.event === "dedup_marked");
    assert.equal(dedupLogs.length, 1, "one dedup_marked log");
    assert.equal((dedupLogs[0] as Record<string, unknown>).markedCount, 1);
  });

  it("releasedPercent 0 releases the pending dedup marks on the next turn", () => {
    const sessionID = "sess-dedup-pending";
    setModelLimit(sessionID, MODEL_LIMIT, "test-model");
    const config = {
      protectedMessages: 0,
      releasedPercent: 0,
      dedup: { thresholdContext: 100000 },
      purgeErrors: {},
    };

    contextPruningTransformHandler(adapter, dedupTranscript(sessionID), config);
    let state = getContextStateManager().get(sessionID);
    assert.equal(state.marks.size, 1, "pending after the marking turn");
    assert.equal(state.marks.get(markKey(21, 1))?.effective, false);

    contextPruningTransformHandler(adapter, dedupTranscript(sessionID), config);
    state = getContextStateManager().get(sessionID);
    assert.equal(state.marks.get(markKey(21, 1))?.effective, true, "released");
  });
});

// ---------------------------------------------------------------------------
// Round-view publication — the single snapshot the tools read
// ---------------------------------------------------------------------------

describe("round-view publication", () => {
  it("publishes the round's frozen snapshot and numbering before rendering", () => {
    const sessionID = "sess-round-view";
    const messages: TestMessageEntry[] = [
      msg("user", "u1", [textPart("开场问题")], sessionID),
      msg("assistant", "a1", [textPart("回答")], sessionID),
      msg("user", "u2", [textPart("第二个问题")], sessionID),
    ];

    const rendered = contextPruningTransformHandler(adapter, messages, {
      dedup: {},
      purgeErrors: {},
    }) as TestMessageEntry[];

    const view = getRoundView(sessionID);
    assert.ok(view, "the transform publishes the round view");

    // Numbering is the address space the model was shown this round.
    assert.deepEqual(
      view.numbered.map(({ n, item }) => [n, item.type]),
      [
        [1, "original"],
        [2, "original"],
        [3, "original"],
      ],
    );

    // The published transcript is the text the fold hashed: the rendered
    // host view carries per-round `[mN] ` prefixes, the snapshot must not.
    assert.equal(
      String((rendered[0].parts[0] as { text: string }).text),
      "[m1] 开场问题",
    );
    assert.equal(view.projection.messages[0].regions[0].get(), "开场问题");

    // Frozen: the snapshot is copied text, so a later in-place rewrite of
    // the host message (mid-turn, by any host) cannot reach the tools.
    (rendered[0].parts[0] as { text: string }).text = "当轮被改写的文本";
    assert.equal(view.projection.messages[0].regions[0].get(), "开场问题");
  });

  it("publishes nothing when the pipeline short-circuits", () => {
    // No resolvable session id → the handler returns before any fold, so
    // no view is published and no session key enters the cache.
    const orphan = [msg("user", "u1", [textPart("无主消息")])];
    contextPruningTransformHandler(adapter, orphan, {
      dedup: {},
      purgeErrors: {},
    });
    assert.deepEqual(_listRoundViewSessionsForTesting(), []);
  });
});

// ---------------------------------------------------------------------------
// Mutation-agnostic pipeline with a strictly-pure mock adapter
// ---------------------------------------------------------------------------

describe("pure adapter pipeline support", () => {
  /** Minimal message shape used only by the mock adapter. */
  interface MockMessage {
    id: string;
    sessionId: string;
    text: string;
  }

  /**
   * Strictly pure mock adapter: every method returns a new array and never
   * mutates its input.  The handler must produce output from these returned
   * arrays rather than relying on in-place mutation.
   */
  const mockAdapter: HostAdapter<MockMessage[]> = {
    history(messages) {
      return project(
        messages.map(
          (m): HostMessage => ({
            role: "user",
            hidden: false,
            regions: [
              {
                kind: "content",
                get: () => m.text,
              },
            ],
          }),
        ),
        [],
      );
    },
    applyEdits(messages, edits) {
      const edited = messages.map((m) => ({ ...m }));
      for (const edit of edits) {
        const target = edited[edit.messageOrdinal];
        if (target) {
          target.text = `${target.text}[edit:${edit.text}]`;
        }
      }
      return edited.map((m) => ({ ...m, text: `${m.text}(applied)` }));
    },
    renderView(messages) {
      return messages.map((m) => ({ ...m, text: `${m.text}(view)` }));
    },
    render(messages, items, edits, state) {
      return this.renderView(this.applyEdits(messages, edits), items, state);
    },
    sessionId(messages) {
      return messages[0]?.sessionId;
    },
    appendUserMessage(messages, id, sessionId, text) {
      return [...messages, { id, sessionId, text }];
    },
  };

  it("returns the adapter's arrays instead of mutating in place", () => {
    const sessionID = "sess-pure-mock";
    const manager = getContextStateManager();
    const state = manager.get(sessionID);
    state.marks.set(markKey(1, 0), {
      anchorOrdinal: 1,
      regionIndex: 0,
      content: "long output",
      contentTokens: 100,
      effective: true,
      markedAt: 1000,
    });

    const original: MockMessage[] = [
      { id: "u1", sessionId: sessionID, text: "hello" },
      { id: "a1", sessionId: sessionID, text: "tool output" },
    ];
    const snapshot = structuredClone(original);

    const result = contextPruningTransformHandler(
      mockAdapter as HostAdapter<unknown>,
      original,
      { dedup: {}, purgeErrors: {} },
    ) as MockMessage[];

    assert.notEqual(result, original, "handler returned a new array");
    assert.deepEqual(
      original,
      snapshot,
      "input array was never mutated by the pure adapter",
    );
    assert.ok(
      result[1].text.includes("[edit:"),
      "release edit traveled through the adapter return",
    );
    assert.ok(
      result[1].text.includes("(applied)"),
      "applyEdits return was threaded to later phases",
    );
    assert.ok(
      result[1].text.includes("(view)"),
      "renderView return was threaded to the final output",
    );
  });
});

// ---------------------------------------------------------------------------
// Unit registration behavior
// ---------------------------------------------------------------------------

describe("unit.create enablement", () => {
  const activeSet: ActiveSet = {
    agents: new Set(),
    skills: new Set(),
    hooks: new Set(),
    tools: new Set(["compress"]),
    commands: new Set(),
  };

  it("contributes the transform handler when an adapter is wired", () => {
    const deps: Deps = {
      limits: {},
      contextConfig: {},
      client: {},
      directory: "/tmp/zoo",
      resolveAgent: () => undefined,
      adapter,
    };

    const contributions = unit.create(deps, activeSet);

    assert.equal(contributions.kind, "hook");
    assert.deepEqual(contributions.beforeExec, []);
    assert.deepEqual(contributions.afterExec, []);
    assert.deepEqual(contributions.toolDefinition, []);
    assert.equal(contributions.transform.length, 1);
    assert.equal(contributions.transform[0].name, "contextPruning");
    assert.ok(!_getBufferForTesting().some((e) => e.event === "unit_disabled"));
  });

  it("contributes no transform handler when adapter is undefined (fail-closed)", () => {
    const deps: Deps = {
      limits: {},
      contextConfig: {},
      client: {
        session: {
          get: async () => ({}),
        },
      },
      directory: "/tmp/zoo",
      resolveAgent: () => undefined,
    };

    const contributions = unit.create(deps, activeSet);

    assert.equal(contributions.kind, "hook");
    assert.equal(contributions.transform.length, 0);
    assert.deepEqual(contributions.beforeExec, []);
    assert.deepEqual(contributions.afterExec, []);
    assert.deepEqual(contributions.toolDefinition, []);
  });
});
