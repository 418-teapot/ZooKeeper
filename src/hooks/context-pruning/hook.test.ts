/**
 * Tests for the context-pruning transform handler on the new core.
 *
 * Focused suite covering the cut-over checklist C13 contracts and the
 * pipeline phase wiring (state → history → release → three producers →
 * fold + block maintenance → view render → nudge / manual compress →
 * save):
 *
 * - **C13-01** release notification exactly once, text carries the
 *   "上下文清理" / "约回收" wording.
 * - **C13-02** log field sets: `prune_completed` counts effective marks
 *   only, `marks_released` carries the forced field, `nudge_injected` /
 *   `manual_compress_injected` carry their payloads.
 * - **C13-03** robust no-ops for null / undefined / empty / missing
 *   sessionID inputs.
 * - **C13-04** the unit registration contributes the transform handler
 *   unconditionally.
 * - Persistence round-trip through the shared store (restart keeps
 *   blocks folding and marks pruning), nudge injection + anchor
 *   persistence, and config gating combinations.
 *
 * Fixtures are v1-shaped message arrays driven through the real
 * handler; state and persistence go through the process-wide shared
 * manager (`getContextStateManager`), with session files cleaned up in
 * teardown.
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { HostAdapter, HostMessage } from "../../core/context/lens.js";
import { PRUNED_TOOL_OUTPUT_REPLACEMENT } from "../../core/context/message-parts.js";
import {
  _resetForTesting as _resetModelLimitsForTesting,
  setModelLimit,
} from "../../core/context/model-limits.js";
import {
  _resetContextStateManagerForTesting,
  consumePendingViewChange,
  getContextStateManager,
  getRuntimeFlaggedState,
  setPendingViewChange,
} from "../../core/context/runtime.js";
import { computeSpanHash } from "../../core/context/spanhash.js";
import { markKey } from "../../core/context/state.js";
import type { ActiveSet, Deps } from "../../core/slots.js";
import { createV1Adapter } from "../../opencode.js";
import { _getBufferForTesting, _resetForTesting } from "../../utils/logger.js";
import {
  _resetViewChangeFlagsForTesting,
  contextPruningTransformHandler,
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
  "sess-nudge-no-section",
  "sess-nudge-no-tool",
  "sess-manual-basic",
  "sess-manual-no-tool",
  "sess-dedup-marked",
  "sess-dedup-gated",
  "sess-dedup-pending",
  "sess-pure-mock",
];

afterEach(() => {
  const manager = getContextStateManager();
  for (const sid of TEST_SESSION_IDS) {
    manager.store.delete(sid);
  }
  _resetContextStateManagerForTesting();
  _resetViewChangeFlagsForTesting();
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
// C13-03 — Robust no-ops
// ---------------------------------------------------------------------------

describe("robustness (C13-03)", () => {
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
      active: true,
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
// Release notification contract (C13-01) + sweep lifecycle
// ---------------------------------------------------------------------------

describe("release notification (C13-01)", () => {
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

    // C13-01: the text carries the required wording and the mark count.
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
// Log field sets (C13-02)
// ---------------------------------------------------------------------------

describe("log field sets (C13-02)", () => {
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

    // The synthetic nudge is appended at the very END with the legacy
    // message shape (info marker + single text part).
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
      return messages.map(
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
// C13-04 — unit registration behavior
// ---------------------------------------------------------------------------

describe("unit.create enablement (C13-04)", () => {
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
      sessionAgentMap: new Map(),
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
      sessionAgentMap: new Map(),
    };

    const contributions = unit.create(deps, activeSet);

    assert.equal(contributions.kind, "hook");
    assert.equal(contributions.transform.length, 0);
    assert.deepEqual(contributions.beforeExec, []);
    assert.deepEqual(contributions.afterExec, []);
    assert.deepEqual(contributions.toolDefinition, []);
  });
});
