/**
 * Tests for the lens-based dedup producer (`producers/dedup.ts`).
 *
 * Two layers:
 * 1. **Dedup semantics** — the lens producer's decisions over
 *    `HostMessage` transcripts are pinned literally: duplicate detection
 *    (2 and 3 occurrences, single-message duplicates), signature
 *    normalisation (key order, null fields, volatile fields, array
 *    order, null inputs, tool names), skip rules (protected tools,
 *    non-completed statuses, zero-benefit outputs), the message-count
 *    protection window, and re-run idempotency.
 * 2. **Lens-specific semantics** — self-gating defaults (minMessages=20,
 *    thresholdContext=0.4, protectedTools=["batch"]), the protected
 *    window fail-safe, folded-message skipping, parse-failure inputs,
 *    mark content truncation, and the first-write-wins clamp.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { HostMessage } from "../lens.js";
import { makeAssistantMsg, makeToolMsg } from "../lens-testkit.js";
import { measureMessages } from "../measure.js";
import { markKey, type SessionState } from "../state.js";
import { type DedupProducerOptions, runDedup } from "./dedup.js";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

/** Output long enough to reclaim tokens against the placeholder. */
const LONG_OUTPUT = "x".repeat(500);

/** Output too short to reclaim tokens against the placeholder. */
const SHORT_OUTPUT = "short";

/** Model limit used to open the context-fraction gate. */
const MODEL_LIMIT = 1_000_000;

/**
 * Net reclaim of one LONG_OUTPUT mark: ceil(500/4) = 125 tokens minus
 * the output-placeholder estimate of 20 tokens.
 */
const MARK_TOKENS = 105;

/** One tool call in a fixture message. */
interface CallSpec {
  tool: string;
  input: Record<string, unknown> | string | null;
  output: string;
  status?: string;
}

/** A bash call with the given input, output and optional status. */
function bash(
  input: Record<string, unknown> | string | null,
  output = LONG_OUTPUT,
  status?: string,
): CallSpec {
  return { tool: "bash", input, output, status };
}

/** Serialise a fixture input to the lens input-region text. */
function inputText(input: CallSpec["input"]): string {
  if (input == null) return "";
  if (typeof input === "string") return input;
  return JSON.stringify(input);
}

/** Build the lens assistant message for the given calls. */
function lensMsg(calls: CallSpec[]): HostMessage {
  return makeAssistantMsg({
    toolCalls: calls.map((call) => ({
      name: call.tool,
      input: inputText(call.input),
      output: call.output,
      status: call.status,
    })),
  });
}

/** A fresh empty lens session state. */
function makeNewState(): SessionState {
  return { blocks: new Map(), marks: new Map() };
}

/**
 * Dedup options with both gates open over the given transcript (empty
 * protection window, no protected tools).
 */
function dedupOptions(
  messages: HostMessage[],
  overrides: Partial<DedupProducerOptions> = {},
): DedupProducerOptions {
  return {
    minMessages: 0,
    contextLimit: MODEL_LIMIT,
    thresholdContext: 0,
    protectedStartOrdinal: messages.length,
    protectedTools: [],
    ...overrides,
  };
}

/**
 * Run dedup with the common open options over a fresh state and return
 * the created mark keys (sorted) and the reported reclaim tokens.
 */
function runOpen(
  messages: HostMessage[],
  overrides: Partial<DedupProducerOptions> = {},
): { keys: string[]; tokens: number } {
  const state = makeNewState();
  const result = runDedup(state, messages, dedupOptions(messages, overrides));
  return { keys: [...state.marks.keys()].sort(), tokens: result.tokens };
}

// ===========================================================================
// Dedup semantics
// ===========================================================================

describe("dedup semantics", () => {
  it("marks older duplicates and keeps the newest (2 and 3 occurrences)", () => {
    const two = [
      lensMsg([bash({ cmd: "ls" })]),
      lensMsg([bash({ cmd: "ls" })]),
    ];
    assert.deepEqual(runOpen(two), {
      keys: [markKey(0, 1)],
      tokens: MARK_TOKENS,
    });

    const three = [
      lensMsg([bash({ cmd: "ls" })]),
      lensMsg([bash({ cmd: "ls" })]),
      lensMsg([bash({ cmd: "ls" })]),
    ];
    const result = runOpen(three);
    assert.deepEqual(result.keys, [markKey(0, 1), markKey(1, 1)]);
    assert.equal(result.tokens, 2 * MARK_TOKENS);
  });

  it("treats different tool names as different signatures", () => {
    const lens = [
      lensMsg([{ tool: "bash", input: { path: "/tmp" }, output: LONG_OUTPUT }]),
      lensMsg([{ tool: "read", input: { path: "/tmp" }, output: LONG_OUTPUT }]),
    ];
    assert.deepEqual(runOpen(lens), { keys: [], tokens: 0 });
  });

  it("treats different input key order as equivalent", () => {
    const lens = [
      lensMsg([bash({ cmd: "ls", path: "/tmp" })]),
      lensMsg([bash({ path: "/tmp", cmd: "ls" })]),
    ];
    const result = runOpen(lens);
    assert.deepEqual(result.keys, [markKey(0, 1)]);
    assert.equal(result.tokens, MARK_TOKENS);
  });

  it("strips null fields from input", () => {
    const lens = [
      lensMsg([bash({ cmd: "ls", extra: null })]),
      lensMsg([bash({ cmd: "ls" })]),
    ];
    const result = runOpen(lens);
    assert.deepEqual(result.keys, [markKey(0, 1)]);
    assert.equal(result.tokens, MARK_TOKENS);
  });

  it("strips volatile fields (timestamp/ts/date) at any depth", () => {
    const top = [
      lensMsg([bash({ cmd: "grep", timestamp: "2024-01-01T00:00:00Z" })]),
      lensMsg([bash({ cmd: "grep" })]),
    ];
    const nested = [
      lensMsg([bash({ args: { path: "/etc", ts: 1234567890 } })]),
      lensMsg([bash({ args: { path: "/etc" } })]),
    ];
    const array = [
      lensMsg([bash({ items: [{ path: "/tmp", ts: 123 }] })]),
      lensMsg([bash({ items: [{ path: "/tmp" }] })]),
    ];
    for (const messages of [top, nested, array]) {
      const result = runOpen(messages);
      assert.deepEqual(result.keys, [markKey(0, 1)]);
      assert.equal(result.tokens, MARK_TOKENS);
    }
  });

  it("keeps arrays order-sensitive", () => {
    const lens = [
      lensMsg([bash({ args: ["-la", "/tmp"] })]),
      lensMsg([bash({ args: ["/tmp", "-la"] })]),
    ];
    assert.deepEqual(runOpen(lens), { keys: [], tokens: 0 });
  });

  it("normalises null inputs to the same signature", () => {
    const lens = [lensMsg([bash(null)]), lensMsg([bash(null)])];
    const result = runOpen(lens);
    assert.deepEqual(result.keys, [markKey(0, 1)]);
    assert.equal(result.tokens, MARK_TOKENS);
  });

  it("skips protected tools by name", () => {
    const lens = [
      lensMsg([{ tool: "read", input: { path: "/tmp" }, output: LONG_OUTPUT }]),
      lensMsg([{ tool: "read", input: { path: "/tmp" }, output: LONG_OUTPUT }]),
    ];
    assert.deepEqual(runOpen(lens, { protectedTools: ["read"] }), {
      keys: [],
      tokens: 0,
    });
  });

  it("skips non-completed statuses (error/running/pending)", () => {
    for (const status of ["error", "running", "pending"]) {
      const lens = [
        lensMsg([bash({ cmd: "ls" }, LONG_OUTPUT, status)]),
        lensMsg([bash({ cmd: "ls" })]),
      ];
      const result = runOpen(lens);
      assert.deepEqual(result.keys, [], `status ${status}`);
      assert.equal(result.tokens, 0, `status ${status}`);
    }
  });

  it("processes completed and absent statuses normally", () => {
    for (const status of ["completed", undefined]) {
      const lens = [
        lensMsg([bash({ cmd: "ls" }, LONG_OUTPUT, status)]),
        lensMsg([bash({ cmd: "ls" })]),
      ];
      const result = runOpen(lens);
      assert.deepEqual(result.keys, [markKey(0, 1)], `status ${status}`);
      assert.equal(result.tokens, MARK_TOKENS, `status ${status}`);
    }
  });

  it("marks older duplicates within a single message", () => {
    const lens = [
      lensMsg([bash({ cmd: "ls" }), bash({ cmd: "ls" }), bash({ cmd: "pwd" })]),
    ];
    const result = runOpen(lens);
    assert.deepEqual(result.keys, [markKey(0, 1)]);
    assert.equal(result.tokens, MARK_TOKENS);
  });

  it("honours the message-count protection window", () => {
    // Protected ordinals [2, 4) are excluded from the scan entirely, so
    // only the first two duplicates compete: the older one is marked.
    const lens = [
      lensMsg([bash({ cmd: "ls" })]),
      lensMsg([bash({ cmd: "ls" })]),
      lensMsg([bash({ cmd: "ls" })]),
      lensMsg([bash({ cmd: "ls" })]),
    ];
    const result = runOpen(lens, { protectedStartOrdinal: 2 });
    assert.deepEqual(result.keys, [markKey(0, 1)]);
    assert.equal(result.tokens, MARK_TOKENS);
  });

  it("protects all messages when the window covers the whole transcript", () => {
    const lens = [
      lensMsg([bash({ cmd: "ls" })]),
      lensMsg([bash({ cmd: "ls" })]),
    ];
    assert.deepEqual(runOpen(lens, { protectedStartOrdinal: 0 }), {
      keys: [],
      tokens: 0,
    });
  });

  it("an empty protection window disables the protection", () => {
    const lens = [
      lensMsg([bash({ cmd: "ls" })]),
      lensMsg([bash({ cmd: "ls" })]),
    ];
    const result = runOpen(lens, { protectedStartOrdinal: 2 });
    assert.deepEqual(result.keys, [markKey(0, 1)]);
    assert.equal(result.tokens, MARK_TOKENS);
  });

  it("skips zero-benefit marks when outputs are shorter than the placeholder", () => {
    const bothShort = [
      lensMsg([bash({ cmd: "ls" }, SHORT_OUTPUT)]),
      lensMsg([bash({ cmd: "ls" }, SHORT_OUTPUT)]),
    ];
    assert.deepEqual(runOpen(bothShort), { keys: [], tokens: 0 });

    const mixed = [
      lensMsg([bash({ cmd: "ls" }, SHORT_OUTPUT)]),
      lensMsg([bash({ cmd: "ls" }, LONG_OUTPUT)]),
    ];
    assert.deepEqual(runOpen(mixed), { keys: [], tokens: 0 });
  });

  it("re-runs are idempotent", () => {
    const lens = [
      lensMsg([bash({ cmd: "ls" })]),
      lensMsg([bash({ cmd: "ls" })]),
    ];
    const state = makeNewState();
    assert.equal(runDedup(state, lens, dedupOptions(lens)).created, 1);
    const second = runDedup(state, lens, dedupOptions(lens));
    assert.equal(second.created, 0);
    assert.equal(second.tokens, 0);
    assert.equal(state.marks.size, 1);
  });
});

// ===========================================================================
// Lens-specific gating semantics
// ===========================================================================

describe("lens-specific gating semantics", () => {
  it("fail-safe: undefined protectedStartOrdinal skips with zero side effects", () => {
    const state = makeNewState();
    const lens = [
      lensMsg([bash({ cmd: "ls" })]),
      lensMsg([bash({ cmd: "ls" })]),
    ];
    const result = runDedup(state, lens, {
      minMessages: 0,
      contextLimit: MODEL_LIMIT,
      thresholdContext: 0,
    });
    assert.deepEqual(result, { created: 0, tokens: 0 });
    assert.equal(state.marks.size, 0);
  });

  it("message-count gate: default minMessages 20 skips at 20, runs above", () => {
    const atTwenty = Array.from({ length: 20 }, () =>
      makeToolMsg("bash", '{"cmd":"ls"}', LONG_OUTPUT),
    );
    const state20 = makeNewState();
    const r20 = runDedup(state20, atTwenty, {
      contextLimit: MODEL_LIMIT,
      thresholdContext: 0,
      protectedStartOrdinal: atTwenty.length,
    });
    assert.equal(r20.created, 0);
    assert.equal(state20.marks.size, 0);

    const above = [
      ...atTwenty,
      makeToolMsg("bash", '{"cmd":"ls"}', LONG_OUTPUT),
    ];
    const state21 = makeNewState();
    const r21 = runDedup(state21, above, {
      contextLimit: MODEL_LIMIT,
      thresholdContext: 0,
      protectedStartOrdinal: above.length,
    });
    assert.equal(r21.created, 20);
  });

  it("context gate: below threshold skips, at threshold opens, above runs", () => {
    const lens = [
      lensMsg([bash({ cmd: "ls" })]),
      lensMsg([bash({ cmd: "ls" })]),
    ];
    const total = measureMessages(lens).total;

    const below = makeNewState();
    const rBelow = runDedup(below, lens, {
      minMessages: 0,
      contextLimit: MODEL_LIMIT,
      thresholdContext: 0.4,
      protectedStartOrdinal: lens.length,
    });
    assert.equal(rBelow.created, 0);

    // Equality opens the gate (legacy "equal opens" semantics).
    const at = makeNewState();
    const rAt = runDedup(at, lens, {
      minMessages: 0,
      contextLimit: total,
      thresholdContext: 1,
      protectedStartOrdinal: lens.length,
    });
    assert.equal(rAt.created, 1);

    const above = makeNewState();
    const rAbove = runDedup(above, lens, {
      minMessages: 0,
      contextLimit: 1,
      thresholdContext: 0.4,
      protectedStartOrdinal: lens.length,
    });
    assert.equal(rAbove.created, 1);
  });

  it("context gate: undefined model limit skips (fail-closed)", () => {
    const state = makeNewState();
    const lens = [
      lensMsg([bash({ cmd: "ls" })]),
      lensMsg([bash({ cmd: "ls" })]),
    ];
    const result = runDedup(state, lens, {
      minMessages: 0,
      thresholdContext: 0.4,
      protectedStartOrdinal: lens.length,
    });
    assert.equal(result.created, 0);
    assert.equal(state.marks.size, 0);
  });
});

// ===========================================================================
// Lens-specific skip and dedup semantics
// ===========================================================================

describe("lens-specific skip and dedup semantics", () => {
  it("default protectedTools protects 'batch'", () => {
    const state = makeNewState();
    const lens = [
      makeToolMsg("batch", '{"x":1}', LONG_OUTPUT),
      makeToolMsg("batch", '{"x":1}', LONG_OUTPUT),
    ];
    const result = runDedup(state, lens, {
      minMessages: 0,
      contextLimit: MODEL_LIMIT,
      thresholdContext: 0,
      protectedStartOrdinal: lens.length,
    });
    assert.equal(result.created, 0);
  });

  it("protectedTools matching is case-sensitive ('Batch' is not protected)", () => {
    const state = makeNewState();
    const lens = [
      makeToolMsg("Batch", '{"x":1}', LONG_OUTPUT),
      makeToolMsg("Batch", '{"x":1}', LONG_OUTPUT),
    ];
    const result = runDedup(state, lens, {
      minMessages: 0,
      contextLimit: MODEL_LIMIT,
      thresholdContext: 0,
      protectedStartOrdinal: lens.length,
    });
    assert.equal(result.created, 1);
  });

  it("'systemioprompt' is not protected by default", () => {
    const state = makeNewState();
    const lens = [
      makeToolMsg("systemioprompt", '{"x":1}', LONG_OUTPUT),
      makeToolMsg("systemioprompt", '{"x":1}', LONG_OUTPUT),
    ];
    const result = runDedup(state, lens, {
      minMessages: 0,
      contextLimit: MODEL_LIMIT,
      thresholdContext: 0,
      protectedStartOrdinal: lens.length,
    });
    assert.equal(result.created, 1);
  });

  it("hidden messages' tool calls still participate in dedup", () => {
    const state = makeNewState();
    const lens = [
      makeToolMsg("bash", '{"cmd":"ls"}', LONG_OUTPUT, { hidden: true }),
      makeToolMsg("bash", '{"cmd":"ls"}', LONG_OUTPUT),
    ];
    const result = runDedup(state, lens, {
      minMessages: 0,
      contextLimit: MODEL_LIMIT,
      thresholdContext: 0,
      protectedStartOrdinal: lens.length,
    });
    assert.equal(result.created, 1);
    assert.ok(state.marks.has(markKey(0, 1)));
  });

  it("skips ordinals reported as folded or pruned via prunedOrdinals", () => {
    const state = makeNewState();
    const lens = [
      lensMsg([bash({ cmd: "ls" })]),
      lensMsg([bash({ cmd: "ls" })]),
    ];
    const result = runDedup(state, lens, {
      minMessages: 0,
      contextLimit: MODEL_LIMIT,
      thresholdContext: 0,
      protectedStartOrdinal: lens.length,
      prunedOrdinals: (ordinal) => ordinal === 0,
    });
    assert.equal(result.created, 0);
    assert.equal(state.marks.size, 0);
  });

  it("parse-failure inputs fall back to the raw text", () => {
    const same = makeNewState();
    const lensSame = [
      makeToolMsg("bash", "not json at all", LONG_OUTPUT),
      makeToolMsg("bash", "not json at all", LONG_OUTPUT),
    ];
    assert.equal(
      runDedup(same, lensSame, {
        minMessages: 0,
        contextLimit: MODEL_LIMIT,
        thresholdContext: 0,
        protectedStartOrdinal: lensSame.length,
      }).created,
      1,
    );

    const different = makeNewState();
    const lensDiff = [
      makeToolMsg("bash", "aaa", LONG_OUTPUT),
      makeToolMsg("bash", "bbb", LONG_OUTPUT),
    ];
    assert.equal(
      runDedup(different, lensDiff, {
        minMessages: 0,
        contextLimit: MODEL_LIMIT,
        thresholdContext: 0,
        protectedStartOrdinal: lensDiff.length,
      }).created,
      0,
    );
  });

  it("writes pending marks with a truncated content snapshot", () => {
    const big = "x".repeat(20_000);
    const state = makeNewState();
    const lens = [
      makeToolMsg("bash", '{"cmd":"ls"}', big),
      makeToolMsg("bash", '{"cmd":"ls"}', big),
    ];
    const result = runDedup(state, lens, {
      minMessages: 0,
      contextLimit: MODEL_LIMIT,
      thresholdContext: 0,
      protectedStartOrdinal: lens.length,
    });
    assert.equal(result.created, 1);
    const mark = state.marks.get(markKey(0, 1));
    assert.ok(mark);
    assert.equal(mark.effective, false);
    assert.equal(mark.content.length, 16_000);
    assert.equal(mark.content, "x".repeat(16_000));
    assert.equal(mark.anchorOrdinal, 0);
    assert.equal(mark.regionIndex, 1);
    assert.ok(mark.contentTokens !== undefined && mark.contentTokens > 0);
  });

  it("never overwrites an existing mark at the same key (first-write-wins)", () => {
    const state = makeNewState();
    state.marks.set(markKey(0, 1), {
      anchorOrdinal: 0,
      regionIndex: 1,
      content: "preexisting",
      contentTokens: 5,
      effective: false,
      markedAt: 1,
    });
    const lens = [
      lensMsg([bash({ cmd: "ls" })]),
      lensMsg([bash({ cmd: "ls" })]),
    ];
    const result = runDedup(state, lens, {
      minMessages: 0,
      contextLimit: MODEL_LIMIT,
      thresholdContext: 0,
      protectedStartOrdinal: lens.length,
    });
    assert.equal(result.created, 0);
    assert.equal(result.tokens, 0);
    const mark = state.marks.get(markKey(0, 1));
    assert.equal(mark?.content, "preexisting");
    assert.equal(mark?.contentTokens, 5);
  });

  it("leaves input regions untouched", () => {
    const state = makeNewState();
    const lens = [
      makeAssistantMsg({
        toolCalls: [
          { name: "bash", input: '{"cmd":"ls"}', output: LONG_OUTPUT },
        ],
      }),
      makeToolMsg("bash", '{"cmd":"ls"}', LONG_OUTPUT),
    ];
    runDedup(state, lens, {
      minMessages: 0,
      contextLimit: MODEL_LIMIT,
      thresholdContext: 0,
      protectedStartOrdinal: lens.length,
    });
    assert.equal(lens[0].regions[0].get(), '{"cmd":"ls"}');
    assert.equal(lens[1].regions[0].get(), '{"cmd":"ls"}');
  });
});
