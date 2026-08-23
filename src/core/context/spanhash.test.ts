/**
 * Tests for rolling span hashing and block validation (`spanhash.ts`).
 *
 * Covers the spec's G3 / SC3 requirements: four rewrite scenarios
 * (truncation, compaction replacement, mid-span rewrite, fork prefix —
 * prefix-survival and out-of-bounds invalidation), hidden-message
 * participation in the hash (Decision 1), the concatenation-ambiguity
 * property of the rolling composition, hash determinism and output
 * format, range defense, and suicide-block protection — the prune
 * placeholders leave validation passing, while a line-start ref marker
 * in content hashes verbatim and breaks it.  Fixtures are built through
 * the lens testkit.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { canon } from "./canon.js";
import type { HostMessage } from "./lens.js";
import { makeAssistantMsg, makeMsg, setRegionText } from "./lens-testkit.js";
import {
  PRUNED_TOOL_ERROR_INPUT_REPLACEMENT,
  PRUNED_TOOL_OUTPUT_REPLACEMENT,
} from "./message-parts.js";
import {
  computeSpanHash,
  fnv1a,
  type HashedSpan,
  validateBlock,
} from "./spanhash.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Six plain user/assistant messages, enough to host a `[1, 5)` block. */
function makeTranscript(): HostMessage[] {
  return [
    makeMsg("user", ["prompt"]),
    makeMsg("assistant", ["reply"]),
    makeMsg("user", ["question"]),
    makeMsg("assistant", ["answer"]),
    makeMsg("user", ["next"]),
    makeMsg("assistant", ["done"]),
  ];
}

/** Create a block record over `[start, end)` with the current hash. */
function makeBlock(
  history: HostMessage[],
  start: number,
  end: number,
): HashedSpan {
  return { start, end, spanHash: computeSpanHash(history, start, end) };
}

// ---------------------------------------------------------------------------
// Truncation (v1 revert semantics)
// ---------------------------------------------------------------------------

describe("truncation", () => {
  it("a block is invalidated when the tail is cut into its interval", () => {
    const history = makeTranscript();
    const block = makeBlock(history, 1, 5);
    assert.equal(validateBlock(history.slice(0, 4), block), false);
  });

  it("a block survives truncation that keeps its interval intact", () => {
    const history = makeTranscript();
    const block = makeBlock(history, 1, 5);
    // Cut exactly at the block's end and beyond: interval fully present.
    assert.equal(validateBlock(history.slice(0, 5), block), true);
    assert.equal(validateBlock(history.slice(0, 6), block), true);
  });
});

// ---------------------------------------------------------------------------
// Compaction replacement
// ---------------------------------------------------------------------------

describe("compaction replacement", () => {
  it("a covered message replaced by a summary message invalidates the block", () => {
    const history = makeTranscript();
    const block = makeBlock(history, 1, 5);
    const compacted = [...history];
    compacted[2] = makeMsg("user", ["[summary of messages 1-4]"]);
    assert.equal(validateBlock(compacted, block), false);
  });

  it("an identical-content replacement keeps the block valid (control)", () => {
    const history = makeTranscript();
    const block = makeBlock(history, 1, 5);
    const same = [...history];
    same[2] = makeMsg("user", [history[2].regions[0].get()]);
    assert.equal(validateBlock(same, block), true);
  });
});

// ---------------------------------------------------------------------------
// Mid-span rewrite (spec Decision 2, option C: full-span hash catches it)
// ---------------------------------------------------------------------------

describe("mid-span rewrite", () => {
  it("a same-length middle rewrite is caught although endpoints are untouched", () => {
    const history = makeTranscript();
    const block = makeBlock(history, 1, 5);
    const rewritten = [...history];
    // "answer" -> "answrX": same length, different content, first and last
    // covered messages intact.
    rewritten[3] = makeMsg("assistant", ["answrX"]);
    assert.equal(validateBlock(rewritten, block), false);
  });
});

// ---------------------------------------------------------------------------
// Fork prefix
// ---------------------------------------------------------------------------

describe("fork prefix", () => {
  it("a block fully inside the preserved prefix survives the fork", () => {
    const history = makeTranscript();
    const block = makeBlock(history, 1, 5);
    const forked = history.slice(0, 5); // fork exactly at the block's end
    assert.equal(validateBlock(forked, block), true);
  });

  it("a fork that cuts into the interval makes the block out of bounds", () => {
    const history = makeTranscript();
    const block = makeBlock(history, 1, 5);
    const forked = history.slice(0, 3);
    assert.equal(validateBlock(forked, block), false);
  });

  it("a diverged tail beyond the interval leaves the block alive", () => {
    const history = makeTranscript();
    const block = makeBlock(history, 1, 5);
    const diverged = [...history];
    diverged[5] = makeMsg("assistant", ["divergent tail"]);
    assert.equal(validateBlock(diverged, block), true);
  });
});

// ---------------------------------------------------------------------------
// Suicide block protection (spec R6 / Decision 2)
// ---------------------------------------------------------------------------

describe("suicide block protection", () => {
  it("prune placeholder replacement keeps validation passing", () => {
    const history: HostMessage[] = [
      makeMsg("user", ["prompt"]),
      makeAssistantMsg({
        text: "let me check",
        thinking: "reasoning",
        toolCalls: [
          { name: "bash", input: "ls -la", output: "files" },
          { name: "edit", input: "big payload", output: "ok" },
        ],
      }),
      makeMsg("user", ["question"]),
      makeMsg("assistant", ["answer"]),
    ];
    const block = makeBlock(history, 1, 3);
    const mutated = history[1];
    const canonBefore = canon(mutated);

    // Tool-output prune (sweep/dedup).
    setRegionText(mutated, 3, PRUNED_TOOL_OUTPUT_REPLACEMENT);
    // Input prune for input-heavy tools.
    setRegionText(mutated, 4, PRUNED_TOOL_ERROR_INPUT_REPLACEMENT);
    // Error-input prune (purge-errors).
    setRegionText(mutated, 2, PRUNED_TOOL_ERROR_INPUT_REPLACEMENT);

    // canon is invariant under the placeholder mutations, so the span
    // hash is unchanged and the block still validates.
    assert.equal(canon(mutated), canonBefore);
    assert.equal(validateBlock(history, block), true);
  });

  it("a line-start ref marker in content breaks validation (hashed verbatim)", () => {
    const history: HostMessage[] = [
      makeMsg("user", ["prompt"]),
      makeAssistantMsg({
        text: "let me check",
        thinking: "reasoning",
        toolCalls: [
          { name: "bash", input: "ls -la", output: "files" },
          { name: "edit", input: "big payload", output: "ok" },
        ],
      }),
      makeMsg("user", ["question"]),
      makeMsg("assistant", ["answer"]),
    ];
    const block = makeBlock(history, 1, 3);
    // Line-start ref injection into a content region.
    setRegionText(history[1], 0, "[m2] let me check");

    // Content is hashed verbatim: an injected ref marker changes the
    // projection, so the block no longer validates.  The pipeline never
    // hits this — hashing runs before the injection phase on pristine
    // text — but persisted text containing a line-start marker hashes
    // verbatim (accepted consequence).
    assert.equal(validateBlock(history, block), false);
  });
});

// ---------------------------------------------------------------------------
// Hidden messages (spec Decision 1)
// ---------------------------------------------------------------------------

describe("hidden messages", () => {
  it("hidden messages occupy ordinals and participate in the hash", () => {
    const original = [
      makeMsg("user", ["p"]),
      makeMsg("assistant", ["h"], { hidden: true }),
      makeMsg("user", ["q"]),
    ];
    const rewritten = [
      makeMsg("user", ["p"]),
      makeMsg("assistant", ["DIFFERENT"], { hidden: true }),
      makeMsg("user", ["q"]),
    ];
    assert.notEqual(
      computeSpanHash(original, 0, 3),
      computeSpanHash(rewritten, 0, 3),
    );
  });

  it("a hidden flag flip does not change the span hash", () => {
    const visible = [
      makeMsg("user", ["p"]),
      makeMsg("assistant", ["h"], { hidden: false }),
      makeMsg("user", ["q"]),
    ];
    const hidden = [
      makeMsg("user", ["p"]),
      makeMsg("assistant", ["h"], { hidden: true }),
      makeMsg("user", ["q"]),
    ];
    assert.equal(computeSpanHash(visible, 0, 3), computeSpanHash(hidden, 0, 3));
  });
});

// ---------------------------------------------------------------------------
// Rolling composition properties
// ---------------------------------------------------------------------------

describe("rolling composition", () => {
  it("is deterministic for identical input", () => {
    const history = makeTranscript();
    assert.equal(
      computeSpanHash(history, 1, 5),
      computeSpanHash(history, 1, 5),
    );
  });

  it("is order-sensitive", () => {
    const ab = [makeMsg("user", ["a"]), makeMsg("user", ["b"])];
    const ba = [makeMsg("user", ["b"]), makeMsg("user", ["a"])];
    assert.notEqual(computeSpanHash(ab, 0, 2), computeSpanHash(ba, 0, 2));
  });

  it("does not confuse a two-message span [a, b] with a single [ab]", () => {
    const two = [makeMsg("user", ["a"]), makeMsg("user", ["b"])];
    const one = [makeMsg("user", ["ab"])];
    assert.notEqual(computeSpanHash(two, 0, 2), computeSpanHash(one, 0, 1));
  });

  it("returns a fixed-length lowercase hex string", () => {
    const history = makeTranscript();
    for (const span of [
      [0, 6],
      [1, 5],
      [2, 3],
    ]) {
      const [start, end] = span;
      assert.match(computeSpanHash(history, start, end), /^[0-9a-f]{8}$/);
    }
  });
});

// ---------------------------------------------------------------------------
// fnv1a known vectors
// ---------------------------------------------------------------------------

describe("fnv1a", () => {
  it("matches the standard FNV-1a 32-bit test vectors", () => {
    assert.equal(fnv1a(""), 0x811c9dc5);
    assert.equal(fnv1a("a"), 0xe40c292c);
    assert.equal(fnv1a("foobar"), 0xbf9cf968);
  });
});

// ---------------------------------------------------------------------------
// Range defense
// ---------------------------------------------------------------------------

describe("range defense", () => {
  it("throws on a negative start", () => {
    assert.throws(() => computeSpanHash(makeTranscript(), -1, 3), RangeError);
  });

  it("throws when the end exceeds the history length", () => {
    assert.throws(() => computeSpanHash(makeTranscript(), 1, 9), RangeError);
  });

  it("throws on an empty or inverted span", () => {
    const history = makeTranscript();
    assert.throws(() => computeSpanHash(history, 2, 2), RangeError);
    assert.throws(() => computeSpanHash(history, 4, 2), RangeError);
  });

  it("validateBlock reports invalid spans as false without throwing", () => {
    const history = makeTranscript();
    const invalid: HashedSpan[] = [
      { start: -1, end: 3, spanHash: "00000000" },
      { start: 1, end: 9, spanHash: "00000000" },
      { start: 3, end: 3, spanHash: "00000000" },
      { start: 4, end: 2, spanHash: "00000000" },
    ];
    for (const block of invalid) {
      assert.equal(validateBlock(history, block), false);
    }
  });
});
