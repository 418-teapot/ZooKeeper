/**
 * Tests for the lens-based sweep producer (`producers/sweep.ts`).
 *
 * Two layers:
 * 1. **Window semantics** — the lens producer's decisions over
 *    `HostMessage` transcripts are pinned literally: marks every tool
 *    output after the last non-hidden user message, multi-output
 *    messages, empty windows (last-user-at-end / no user), the hidden
 *    user boundary, the block-protection switch (`sweepProtectedBlocks`),
 *    already-pruned placeholder detection, the protection window, and
 *    re-run idempotency.
 * 2. **Lens-specific semantics** — self-gating defaults
 *    (thresholdContext=0.80, fail-closed on unknown model limit, the
 *    protected-window fail-safe), hidden-message skipping, completed-status
 *    filtering, the first-write-wins clamp, snapshot truncation, and the
 *    span-hash linkage: sweeping an in-block tool output never
 *    invalidates the block.
 *
 * The lens producer has no `protectedTools` list, so neither does the
 * test — no tool name is ever excluded from sweeping.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { HostMessage } from "../lens.js";
import { makeAssistantMsg, makeMsg, makeToolMsg } from "../lens-testkit.js";
import { measureMessages } from "../measure.js";
import { PRUNED_TOOL_OUTPUT_REPLACEMENT } from "../message-parts.js";
import { computeSpanHash, validateBlock } from "../spanhash.js";
import { type Block, markKey, type SessionState } from "../state.js";
import { runSweep, type SweepProducerOptions } from "./sweep.js";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

/** Output long enough to reclaim tokens against the placeholder. */
const LONG_OUTPUT = "x".repeat(500);

/** Model limit used to open the context-fraction gate. */
const MODEL_LIMIT = 1_000_000;

/**
 * Net reclaim of one LONG_OUTPUT mark: ceil(500/4) = 125 tokens minus
 * the output-placeholder estimate of 20 tokens.
 */
const MARK_TOKENS = 105;

/** A fresh empty lens session state. */
function makeNewState(): SessionState {
  return { blocks: new Map(), marks: new Map() };
}

/** A lens block record over `[start, end)` with the given hash. */
function makeBlock(
  start: number,
  end: number,
  spanHash = "0".repeat(8),
): Block {
  return {
    start,
    end,
    spanHash,
    summary: "block",
    active: true,
    compressedTokens: 0,
    summaryTokens: 0,
    createdAt: 0,
  };
}

/**
 * Sweep options with both gates open and an empty protection window over
 * the given transcript.
 */
function openOptions(
  messages: HostMessage[],
  overrides: Partial<SweepProducerOptions> = {},
): SweepProducerOptions {
  return {
    contextLimit: MODEL_LIMIT,
    thresholdContext: 0,
    protectedStartOrdinal: messages.length,
    ...overrides,
  };
}

/**
 * Run sweep with the common open options over a fresh state and return
 * the created mark keys (sorted) and the reported reclaim tokens.
 */
function runOpen(
  messages: HostMessage[],
  overrides: Partial<SweepProducerOptions> = {},
): { keys: string[]; tokens: number } {
  const state = makeNewState();
  const result = runSweep(state, messages, openOptions(messages, overrides));
  return { keys: [...state.marks.keys()].sort(), tokens: result.tokens };
}

// ===========================================================================
// Window semantics
// ===========================================================================

describe("sweep window semantics", () => {
  it("marks every tool output after the last user message", () => {
    const lens = [
      makeMsg("user", ["first command"]),
      makeToolMsg("bash", '{"cmd":"ls"}', LONG_OUTPUT),
      makeMsg("user", ["second command"]),
      makeToolMsg("bash", '{"cmd":"pwd"}', LONG_OUTPUT),
      makeToolMsg("bash", '{"cmd":"whoami"}', LONG_OUTPUT),
    ];
    const { keys, tokens } = runOpen(lens);
    assert.deepEqual(keys, [markKey(3, 1), markKey(4, 1)]);
    assert.equal(tokens, 2 * MARK_TOKENS);
  });

  it("marks multiple tool outputs within one message", () => {
    const lens = [
      makeMsg("user", ["do it"]),
      makeAssistantMsg({
        toolCalls: [
          { name: "bash", input: '{"cmd":"ls"}', output: LONG_OUTPUT },
          { name: "bash", input: '{"cmd":"pwd"}', output: LONG_OUTPUT },
          { name: "bash", input: '{"cmd":"whoami"}', output: LONG_OUTPUT },
        ],
      }),
    ];
    const { keys, tokens } = runOpen(lens);
    assert.deepEqual(keys, [markKey(1, 1), markKey(1, 3), markKey(1, 5)]);
    assert.equal(tokens, 3 * MARK_TOKENS);
  });

  it("returns nothing when the last user message is at the very end", () => {
    const lens = [
      makeToolMsg("bash", '{"cmd":"ls"}', LONG_OUTPUT),
      makeMsg("user", ["final instruction"]),
    ];
    const result = runOpen(lens);
    assert.deepEqual(result.keys, []);
    assert.equal(result.tokens, 0);
  });

  it("returns nothing when no user message exists", () => {
    const lens = [makeToolMsg("bash", '{"cmd":"ls"}', LONG_OUTPUT)];
    const result = runOpen(lens);
    assert.deepEqual(result.keys, []);
    assert.equal(result.tokens, 0);
  });

  it("skips hidden user messages when finding the boundary", () => {
    const lens = [
      makeMsg("user", ["real message"]),
      makeToolMsg("bash", '{"cmd":"ls"}', LONG_OUTPUT),
      makeMsg("user", ["injected context"], { hidden: true }),
      makeToolMsg("bash", '{"cmd":"pwd"}', LONG_OUTPUT),
    ];
    const { keys, tokens } = runOpen(lens);
    assert.deepEqual(keys, [markKey(1, 1), markKey(3, 1)]);
    assert.equal(tokens, 2 * MARK_TOKENS);
  });

  it("sweeps inside blocks with sweepProtectedBlocks=false", () => {
    // A block over message 3; the switch off keeps its in-block output
    // sweepable (the span hash excludes tool-output text).
    const lens = [
      makeMsg("user", ["first"]),
      makeToolMsg("bash", '{"cmd":"ls"}', LONG_OUTPUT),
      makeMsg("user", ["second"]),
      makeToolMsg("bash", '{"cmd":"pwd"}', LONG_OUTPUT),
      makeToolMsg("bash", '{"cmd":"whoami"}', LONG_OUTPUT),
    ];
    const state = makeNewState();
    state.blocks.set(1, makeBlock(3, 4));
    const result = runSweep(state, lens, openOptions(lens));
    assert.equal(result.created, 2);
    assert.ok(state.marks.has(markKey(3, 1)));
    assert.ok(state.marks.has(markKey(4, 1)));
  });

  it("skips in-block messages with sweepProtectedBlocks=true", () => {
    const lens = [
      makeMsg("user", ["first"]),
      makeToolMsg("bash", '{"cmd":"ls"}', LONG_OUTPUT),
      makeMsg("user", ["second"]),
      makeToolMsg("bash", '{"cmd":"pwd"}', LONG_OUTPUT),
      makeToolMsg("bash", '{"cmd":"whoami"}', LONG_OUTPUT),
    ];
    const state = makeNewState();
    state.blocks.set(1, makeBlock(3, 4));
    const result = runSweep(state, lens, {
      ...openOptions(lens),
      sweepProtectedBlocks: true,
    });
    assert.equal(result.created, 1);
    assert.equal(state.marks.has(markKey(4, 1)), true);
    assert.equal(state.marks.has(markKey(3, 1)), false);
  });

  it("skips outputs already replaced by the placeholder", () => {
    // A prior round replaced the second call's output; the placeholder
    // prefix suppresses a second mark.
    const lens = [
      makeMsg("user", ["do it"]),
      makeAssistantMsg({
        toolCalls: [
          { name: "bash", input: '{"cmd":"ls"}', output: LONG_OUTPUT },
          {
            name: "bash",
            input: '{"cmd":"pwd"}',
            output: PRUNED_TOOL_OUTPUT_REPLACEMENT,
          },
        ],
      }),
    ];
    const { keys, tokens } = runOpen(lens);
    assert.deepEqual(keys, [markKey(1, 1)]);
    assert.equal(tokens, MARK_TOKENS);
  });

  it("honours the protection window boundary", () => {
    const lens = [
      makeMsg("user", ["do it"]),
      makeToolMsg("bash", '{"cmd":"ls"}', LONG_OUTPUT),
      makeToolMsg("bash", '{"cmd":"pwd"}', LONG_OUTPUT),
      makeToolMsg("bash", '{"cmd":"whoami"}', LONG_OUTPUT),
    ];
    const { keys, tokens } = runOpen(lens, {
      protectedStartOrdinal: 3,
    });
    assert.deepEqual(keys, [markKey(1, 1), markKey(2, 1)]);
    assert.equal(tokens, 2 * MARK_TOKENS);
  });

  it("re-runs are idempotent", () => {
    const lens = [
      makeMsg("user", ["do it"]),
      makeAssistantMsg({
        toolCalls: [
          { name: "bash", input: '{"cmd":"ls"}', output: LONG_OUTPUT },
          { name: "bash", input: '{"cmd":"pwd"}', output: LONG_OUTPUT },
        ],
      }),
    ];
    const state = makeNewState();
    assert.equal(runSweep(state, lens, openOptions(lens)).created, 2);
    assert.deepEqual(runSweep(state, lens, openOptions(lens)), {
      created: 0,
      tokens: 0,
    });
    assert.equal(state.marks.size, 2);
  });
});

// ===========================================================================
// Lens-specific gating semantics
// ===========================================================================

describe("lens-specific gating semantics", () => {
  it("fail-safe: undefined protectedStartOrdinal skips with zero side effects", () => {
    const state = makeNewState();
    const lens = [
      makeMsg("user", ["do it"]),
      makeToolMsg("bash", '{"cmd":"ls"}', LONG_OUTPUT),
    ];
    const result = runSweep(state, lens, {
      contextLimit: MODEL_LIMIT,
      thresholdContext: 0,
    });
    assert.deepEqual(result, { created: 0, tokens: 0 });
    assert.equal(state.marks.size, 0);
  });

  it("fail-closed: undefined contextLimit skips", () => {
    const state = makeNewState();
    const lens = [
      makeMsg("user", ["do it"]),
      makeToolMsg("bash", '{"cmd":"ls"}', LONG_OUTPUT),
    ];
    const result = runSweep(state, lens, {
      thresholdContext: 0,
      protectedStartOrdinal: lens.length,
    });
    assert.equal(result.created, 0);
    assert.equal(state.marks.size, 0);
  });

  it("threshold: below 0.80 of the model limit skips, at/above runs", () => {
    const lens = [
      makeMsg("user", ["do it"]),
      makeToolMsg("bash", '{"cmd":"ls"}', LONG_OUTPUT),
    ];
    const total = measureMessages(lens).total;

    // Default threshold 0.80: limit twice the total closes the gate.
    const below = makeNewState();
    const rBelow = runSweep(below, lens, {
      contextLimit: total * 2,
      protectedStartOrdinal: lens.length,
    });
    assert.equal(rBelow.created, 0);

    // Default threshold 0.80: limit equal to the total opens the gate.
    const at = makeNewState();
    const rAt = runSweep(at, lens, {
      contextLimit: total,
      protectedStartOrdinal: lens.length,
    });
    assert.equal(rAt.created, 1);
  });

  it("threshold equality opens the gate (explicit threshold)", () => {
    const lens = [
      makeMsg("user", ["do it"]),
      makeToolMsg("bash", '{"cmd":"ls"}', LONG_OUTPUT),
    ];
    const total = measureMessages(lens).total;
    const state = makeNewState();
    const result = runSweep(state, lens, {
      contextLimit: total,
      thresholdContext: 1,
      protectedStartOrdinal: lens.length,
    });
    assert.equal(result.created, 1);
  });

  it("marks zero-benefit short outputs (legacy marks regardless of reclaim)", () => {
    const state = makeNewState();
    const lens = [
      makeMsg("user", ["do it"]),
      makeToolMsg("bash", '{"cmd":"ls"}', "short"),
    ];
    const result = runSweep(state, lens, {
      contextLimit: MODEL_LIMIT,
      thresholdContext: 0,
      protectedStartOrdinal: lens.length,
    });
    assert.equal(result.created, 1);
    const mark = state.marks.get(markKey(1, 1));
    assert.ok(mark);
    assert.equal(mark.contentTokens, 0);
  });
});

// ===========================================================================
// Lens-specific skip semantics
// ===========================================================================

describe("lens-specific skip semantics", () => {
  it("skips hidden assistant messages in the window", () => {
    const state = makeNewState();
    const lens = [
      makeMsg("user", ["do it"]),
      makeToolMsg("bash", '{"cmd":"ls"}', LONG_OUTPUT, { hidden: true }),
      makeToolMsg("bash", '{"cmd":"pwd"}', LONG_OUTPUT),
    ];
    const result = runSweep(state, lens, {
      contextLimit: MODEL_LIMIT,
      thresholdContext: 0,
      protectedStartOrdinal: lens.length,
    });
    assert.equal(result.created, 1);
    assert.ok(state.marks.has(markKey(2, 1)));
    assert.equal(state.marks.has(markKey(1, 1)), false);
  });

  it("skips non-completed statuses, marks completed and absent", () => {
    const cases: Array<{ status?: string; expected: boolean }> = [
      { status: "running", expected: false },
      { status: "pending", expected: false },
      { status: "error", expected: false },
      { status: "completed", expected: true },
      { status: undefined, expected: true },
    ];
    for (const [i, c] of cases.entries()) {
      const state = makeNewState();
      const lens = [
        makeMsg("user", ["do it"]),
        makeToolMsg("bash", '{"cmd":"ls"}', LONG_OUTPUT, {
          status: c.status,
        }),
      ];
      runSweep(state, lens, {
        contextLimit: MODEL_LIMIT,
        thresholdContext: 0,
        protectedStartOrdinal: lens.length,
      });
      assert.equal(
        state.marks.has(markKey(1, 1)),
        c.expected,
        `case ${i} status=${c.status ?? "absent"}`,
      );
    }
  });

  it("skips ordinals reported as folded or pruned via prunedOrdinals", () => {
    const state = makeNewState();
    const lens = [
      makeMsg("user", ["do it"]),
      makeToolMsg("bash", '{"cmd":"ls"}', LONG_OUTPUT),
      makeToolMsg("bash", '{"cmd":"pwd"}', LONG_OUTPUT),
    ];
    const result = runSweep(state, lens, {
      contextLimit: MODEL_LIMIT,
      thresholdContext: 0,
      protectedStartOrdinal: lens.length,
      prunedOrdinals: (ordinal) => ordinal === 1,
    });
    assert.equal(result.created, 1);
    assert.ok(state.marks.has(markKey(2, 1)));
    assert.equal(state.marks.has(markKey(1, 1)), false);
  });

  it("never overwrites an existing mark at the same key (first-write-wins)", () => {
    const state = makeNewState();
    state.marks.set(markKey(1, 1), {
      anchorOrdinal: 1,
      regionIndex: 1,
      content: "preexisting",
      contentTokens: 5,
      effective: false,
      markedAt: 1,
    });
    const lens = [
      makeMsg("user", ["do it"]),
      makeToolMsg("bash", '{"cmd":"ls"}', LONG_OUTPUT),
    ];
    const result = runSweep(state, lens, {
      contextLimit: MODEL_LIMIT,
      thresholdContext: 0,
      protectedStartOrdinal: lens.length,
    });
    assert.equal(result.created, 0);
    assert.equal(result.tokens, 0);
    const mark = state.marks.get(markKey(1, 1));
    assert.equal(mark?.content, "preexisting");
    assert.equal(mark?.contentTokens, 5);
  });

  it("writes pending marks with a truncated content snapshot", () => {
    const big = "x".repeat(20_000);
    const state = makeNewState();
    const lens = [
      makeMsg("user", ["do it"]),
      makeToolMsg("bash", '{"cmd":"ls"}', big),
    ];
    runSweep(state, lens, {
      contextLimit: MODEL_LIMIT,
      thresholdContext: 0,
      protectedStartOrdinal: lens.length,
    });
    const mark = state.marks.get(markKey(1, 1));
    assert.ok(mark);
    assert.equal(mark.effective, false);
    assert.equal(mark.content.length, 16_000);
    assert.equal(mark.content, "x".repeat(16_000));
    assert.equal(mark.anchorOrdinal, 1);
    assert.equal(mark.regionIndex, 1);
  });

  it("only touches tool-output regions (input text intact)", () => {
    const state = makeNewState();
    const lens = [
      makeMsg("user", ["do it"]),
      makeToolMsg("bash", '{"cmd":"ls"}', LONG_OUTPUT),
    ];
    runSweep(state, lens, {
      contextLimit: MODEL_LIMIT,
      thresholdContext: 0,
      protectedStartOrdinal: lens.length,
    });
    assert.equal(lens[1].regions[0].get(), '{"cmd":"ls"}');
    assert.equal(lens[1].regions[1].get(), LONG_OUTPUT);
  });
});

// ===========================================================================
// Span-hash linkage (in-block sweep)
// ===========================================================================

describe("spanhash linkage (in-block sweep)", () => {
  it("replacing a swept in-block tool output keeps validateBlock true", () => {
    const history = [
      makeMsg("user", ["first"]),
      makeToolMsg("bash", '{"cmd":"ls"}', LONG_OUTPUT),
      makeMsg("user", ["second"]),
      makeToolMsg("bash", '{"cmd":"pwd"}', LONG_OUTPUT),
      makeToolMsg("bash", '{"cmd":"whoami"}', LONG_OUTPUT),
    ];
    const span = {
      start: 0,
      end: 5,
      spanHash: computeSpanHash(history, 0, 5),
    };
    const state = makeNewState();
    state.blocks.set(1, makeBlock(span.start, span.end, span.spanHash));

    // Window opens after the last user (ordinal 2); both in-block
    // outputs at ordinals 3 and 4 are swept with the switch off.
    const result = runSweep(state, history, {
      contextLimit: MODEL_LIMIT,
      thresholdContext: 0,
      protectedStartOrdinal: history.length,
    });
    assert.equal(result.created, 2);

    // Apply the release-phase replacement for the in-block outputs.
    for (const ordinal of [3, 4]) {
      history[ordinal].regions[1].set(PRUNED_TOOL_OUTPUT_REPLACEMENT);
    }
    assert.equal(validateBlock(history, span), true);
  });

  it("control: a real content change invalidates the block", () => {
    const history = [
      makeMsg("user", ["first"]),
      makeToolMsg("bash", '{"cmd":"ls"}', LONG_OUTPUT),
      makeMsg("user", ["second"]),
    ];
    const span = {
      start: 0,
      end: 3,
      spanHash: computeSpanHash(history, 0, 3),
    };
    history[0].regions[0].set("changed content");
    assert.equal(validateBlock(history, span), false);
  });

  it("sweepProtectedBlocks=true keeps in-block outputs untouched", () => {
    const history = [
      makeMsg("user", ["first"]),
      makeToolMsg("bash", '{"cmd":"ls"}', LONG_OUTPUT),
      makeMsg("user", ["second"]),
      makeToolMsg("bash", '{"cmd":"pwd"}', LONG_OUTPUT),
      makeToolMsg("bash", '{"cmd":"whoami"}', LONG_OUTPUT),
    ];
    const span = {
      start: 3,
      end: 5,
      spanHash: computeSpanHash(history, 3, 5),
    };
    const state = makeNewState();
    state.blocks.set(1, makeBlock(span.start, span.end, span.spanHash));

    const result = runSweep(state, history, {
      contextLimit: MODEL_LIMIT,
      thresholdContext: 0,
      protectedStartOrdinal: history.length,
      sweepProtectedBlocks: true,
    });
    assert.equal(result.created, 0);
    assert.equal(state.marks.size, 0);
  });
});
