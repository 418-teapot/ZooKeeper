/**
 * Tests for the session state layer (`state.ts`) and persistence v2
 * (`store.ts`).
 *
 * Covers the spec's Decision 1/5 field contracts and R5 cleanup rules:
 * persistence round-trip and restart survival, defensive load (corrupt /
 * missing / old-schema files recover to an empty state), the
 * `clearConsumedBlockRange` pending-mark consumption accounting,
 * `deactivateCovering` + `clearInactiveBlocks` revert semantics, the
 * compile- and runtime guarantee that a `Block` satisfies both the fold
 * view contract (`BlockSpan`) and the span validation contract
 * (`HashedSpan`), atomic write (temp file + rename, no residue), and
 * `hasActiveOverlap` interval checking.  Persistence tests run against a
 * per-suite temporary directory injected into the store factory.
 */
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import type { BlockSpan } from "./lens.js";
import type { HashedSpan } from "./spanhash.js";
import {
  type Block,
  clearConsumedBlockRange,
  clearInactiveBlocks,
  deactivateCovering,
  hasActiveOverlap,
  type Mark,
  markKey,
  nextBlockId,
  type SessionState,
} from "./state.js";
import { createStateStore, SCHEMA_VERSION, type StateStore } from "./store.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A fresh empty session state. */
function makeState(): SessionState {
  return { blocks: new Map(), marks: new Map() };
}

/** A block fixture; fields default to a valid `[0, 3)` active block. */
function makeBlock(overrides: Partial<Block> = {}): Block {
  return {
    start: 0,
    end: 3,
    summary: "summary text",
    spanHash: "abcd1234",
    active: true,
    compressedTokens: 100,
    summaryTokens: 20,
    createdAt: 1000,
    ...overrides,
  };
}

/** A mark fixture; defaults to a pending mark over a tool-output region. */
function makeMark(overrides: Partial<Mark> = {}): Mark {
  return {
    anchorOrdinal: 0,
    content: "tool output",
    contentTokens: 50,
    effective: false,
    markedAt: 2000,
    ...overrides,
  };
}

/** Create a scratch store over a fresh temporary directory. */
function scratchStore(): { dir: string; store: StateStore } {
  const dir = mkdtempSync(join(tmpdir(), "zoo-state-test-"));
  after(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, store: createStateStore(dir) };
}

// ---------------------------------------------------------------------------
// 1. Persistence round-trip (restart survival)
// ---------------------------------------------------------------------------

describe("persistence round-trip", () => {
  it("a written state loads back into a fresh store with equal fields", () => {
    const { store } = scratchStore();
    const state = makeState();
    state.blocks.set(1, makeBlock({ start: 0, end: 3, title: "first block" }));
    state.blocks.set(2, makeBlock({ start: 5, end: 8, active: false }));
    state.marks.set(
      markKey(3),
      makeMark({
        anchorOrdinal: 3,
        effective: true,
        effectiveAt: 2100,
        releasedAt: 2100,
      }),
    );
    state.marks.set(
      markKey(3, 1),
      makeMark({
        anchorOrdinal: 3,
        regionIndex: 1,
        content: "second output",
        contentTokens: 12,
      }),
    );
    state.marks.set(markKey(6), {
      anchorOrdinal: 6,
      content: "tool output",
      effective: false,
      markedAt: 2000,
    });
    state.nudges = { lastNudgeTokens: 150000 };
    store.save("session-1", state);

    // A brand-new store over the same directory simulates a process restart.
    const loaded = createStateStore(store.dir).load("session-1");

    // Lookup-based comparison: JSON object keys reorder integer-like
    // block/mark keys on parse, so entry order is a serialization
    // artifact, not state.  Every key and every field must match.
    assert.equal(loaded.blocks.size, state.blocks.size);
    for (const [id, block] of state.blocks) {
      assert.deepEqual(loaded.blocks.get(id), block);
    }
    assert.equal(loaded.marks.size, state.marks.size);
    for (const [key, mark] of state.marks) {
      assert.deepEqual(loaded.marks.get(key), mark);
    }
    assert.deepEqual(loaded.nudges, { lastNudgeTokens: 150000 });
  });

  it("sessions are isolated per file", () => {
    const { store } = scratchStore();
    const a = makeState();
    a.blocks.set(1, makeBlock());
    store.save("session-a", a);

    const b = makeState();
    b.marks.set(markKey(0), makeMark());
    store.save("session-b", b);

    const loadedA = store.load("session-a");
    const loadedB = store.load("session-b");
    assert.equal(loadedA.blocks.size, 1);
    assert.equal(loadedA.marks.size, 0);
    assert.equal(loadedB.blocks.size, 0);
    assert.equal(loadedB.marks.size, 1);
  });

  it("a session with no persisted file loads as an empty state", () => {
    const { store } = scratchStore();
    const loaded = store.load("absent-session");
    assert.deepEqual(loaded.blocks, new Map());
    assert.deepEqual(loaded.marks, new Map());
  });
});

// ---------------------------------------------------------------------------
// 2. Defensive load — corrupt / missing / old-schema recover without throwing
// ---------------------------------------------------------------------------

describe("defensive load", () => {
  it("a corrupt JSON file recovers to an empty state without throwing", () => {
    const { dir, store } = scratchStore();
    writeFileSync(join(dir, "broken.json"), "{ not valid json !!!");
    const state = store.load("broken");
    assert.equal(state.blocks.size, 0);
    assert.equal(state.marks.size, 0);
  });

  it("an old schema file is discarded and loads as empty", () => {
    const { dir, store } = scratchStore();
    const state = makeState();
    state.blocks.set(1, makeBlock());
    store.save("legacy", state);
    const filePath = join(dir, "legacy.json");
    const data = JSON.parse(readFileSync(filePath, "utf8"));
    data.schema = 1; // an incompatible schema version
    writeFileSync(filePath, JSON.stringify(data));

    const loaded = store.load("legacy");
    assert.equal(loaded.blocks.size, 0);
    assert.equal(loaded.marks.size, 0);
  });

  it("a hand-written version-1 state file loads as empty and never throws", () => {
    const { dir, store } = scratchStore();
    // A file in the pre-v2 layout: schema 1 is rejected by the version
    // gate before any field validation, so even structurally plausible
    // entries must not surface.  Any throw here would fail the test.
    writeFileSync(
      join(dir, "v1-schema.json"),
      JSON.stringify({
        schema: 1,
        blocks: {
          "1": { start: 0, end: 3, summary: "legacy", active: true },
        },
        marks: {},
        lastUpdated: "2026-08-01T00:00:00.000Z",
      }),
    );

    const loaded = store.load("v1-schema");
    assert.equal(loaded.blocks.size, 0);
    assert.equal(loaded.marks.size, 0);
  });

  it("a malformed entry invalidates the whole file (strict per-field)", () => {
    const { dir, store } = scratchStore();
    const state = makeState();
    state.blocks.set(1, makeBlock());
    state.marks.set(markKey(1), makeMark({ anchorOrdinal: 1 }));
    store.save("strict", state);
    const filePath = join(dir, "strict.json");
    const data = JSON.parse(readFileSync(filePath, "utf8"));
    data.marks["1"].effective = "not-a-boolean";
    writeFileSync(filePath, JSON.stringify(data));

    const loaded = store.load("strict");
    assert.equal(loaded.blocks.size, 0);
    assert.equal(loaded.marks.size, 0);
  });

  it("unknown keys are ignored (forward compatibility)", () => {
    const { dir, store } = scratchStore();
    const state = makeState();
    state.blocks.set(1, makeBlock());
    store.save("forward", state);
    const filePath = join(dir, "forward.json");
    const data = JSON.parse(readFileSync(filePath, "utf8"));
    data.blocks["1"].futureField = "ignored";
    data.topLevelFuture = { anything: true };
    writeFileSync(filePath, JSON.stringify(data));

    const loaded = store.load("forward");
    const restored = loaded.blocks.get(1);
    assert.ok(restored !== undefined);
    assert.equal(restored.start, 0);
    assert.equal(Object.hasOwn(restored, "futureField"), false);
  });

  it("a malformed nudge watermark is ignored without invalidating the file", () => {
    const { dir, store } = scratchStore();
    const state = makeState();
    state.blocks.set(1, makeBlock());
    store.save("nudge-bad", state);
    const filePath = join(dir, "nudge-bad.json");
    const data = JSON.parse(readFileSync(filePath, "utf8"));
    data.nudges = { lastNudgeTokens: -5 };
    writeFileSync(filePath, JSON.stringify(data));

    const loaded = store.load("nudge-bad");
    assert.equal(loaded.blocks.size, 1);
    assert.equal(loaded.nudges, undefined);
  });
});

// ---------------------------------------------------------------------------
// 3. clearConsumedBlockRange — swallow pending marks inside a landed range
// ---------------------------------------------------------------------------

describe("clearConsumedBlockRange", () => {
  it("swallows pending marks inside the range and returns their token sum", () => {
    const state = makeState();
    state.marks.set(
      markKey(2),
      makeMark({ anchorOrdinal: 2, contentTokens: 30 }),
    );
    state.marks.set(
      markKey(4),
      makeMark({ anchorOrdinal: 4, contentTokens: 20 }),
    );
    state.marks.set(
      markKey(4, 0),
      makeMark({ anchorOrdinal: 4, regionIndex: 0, contentTokens: 5 }),
    );

    const swallowed = clearConsumedBlockRange(state, 2, 5);

    assert.equal(swallowed, 55);
    assert.equal(state.marks.size, 0);
  });

  it("leaves pending marks outside the range untouched", () => {
    const state = makeState();
    state.marks.set(
      markKey(0),
      makeMark({ anchorOrdinal: 0, contentTokens: 10 }),
    );
    state.marks.set(
      markKey(2),
      makeMark({ anchorOrdinal: 2, contentTokens: 10 }),
    );
    state.marks.set(
      markKey(5),
      makeMark({ anchorOrdinal: 5, contentTokens: 10 }),
    );

    assert.equal(clearConsumedBlockRange(state, 2, 5), 10);
    assert.equal(state.marks.size, 2);
    assert.equal(state.marks.has(markKey(0)), true);
    assert.equal(state.marks.has(markKey(5)), true);
  });

  it("leaves effective marks inside the range untouched", () => {
    const state = makeState();
    state.marks.set(
      markKey(3),
      makeMark({
        anchorOrdinal: 3,
        contentTokens: 40,
        effective: true,
        effectiveAt: 3000,
      }),
    );
    state.marks.set(
      markKey(3, 0),
      makeMark({ anchorOrdinal: 3, regionIndex: 0, contentTokens: 9 }),
    );

    const swallowed = clearConsumedBlockRange(state, 2, 4);

    assert.equal(swallowed, 9);
    assert.equal(state.marks.size, 1);
    const kept = state.marks.get(markKey(3));
    assert.equal(kept?.effective, true);
    assert.equal(kept?.contentTokens, 40);
  });

  it("marks without contentTokens contribute zero to the swallowed sum", () => {
    const state = makeState();
    state.marks.set(
      markKey(1),
      makeMark({ anchorOrdinal: 1, contentTokens: undefined }),
    );
    assert.equal(clearConsumedBlockRange(state, 0, 2), 0);
    assert.equal(state.marks.size, 0);
  });
});

// ---------------------------------------------------------------------------
// 4. Revert semantics — deactivateCovering + clearInactiveBlocks
// ---------------------------------------------------------------------------

describe("deactivateCovering", () => {
  it("deactivates active blocks that anchor at or cover the ordinal", () => {
    const state = makeState();
    state.blocks.set(1, makeBlock({ start: 2, end: 6 })); // covers ordinal 4
    state.blocks.set(2, makeBlock({ start: 4, end: 7 })); // anchors at ordinal 4
    state.blocks.set(3, makeBlock({ start: 0, end: 4 })); // ends before ordinal 4
    state.blocks.set(4, makeBlock({ start: 8, end: 10 })); // starts after ordinal 4

    deactivateCovering(state, 4);

    assert.equal(state.blocks.get(1)?.active, false);
    assert.equal(state.blocks.get(2)?.active, false);
    assert.equal(state.blocks.get(3)?.active, true);
    assert.equal(state.blocks.get(4)?.active, true);
  });

  it("leaves already-inactive blocks as they are", () => {
    const state = makeState();
    state.blocks.set(1, makeBlock({ start: 1, end: 3, active: false }));
    deactivateCovering(state, 2);
    assert.equal(state.blocks.get(1)?.active, false);
  });
});

describe("clearInactiveBlocks", () => {
  it("reclaims inactive blocks and keeps active ones", () => {
    const state = makeState();
    state.blocks.set(1, makeBlock({ start: 0, end: 2 }));
    state.blocks.set(2, makeBlock({ start: 3, end: 5, active: false }));
    state.blocks.set(3, makeBlock({ start: 6, end: 8, active: false }));

    clearInactiveBlocks(state);

    assert.deepEqual([...state.blocks.keys()], [1]);
  });

  it("is a no-op when every block is active", () => {
    const state = makeState();
    state.blocks.set(1, makeBlock());
    clearInactiveBlocks(state);
    assert.equal(state.blocks.size, 1);
  });
});

// ---------------------------------------------------------------------------
// 5. Block contract — satisfies BlockSpan and HashedSpan
// ---------------------------------------------------------------------------

describe("block contract", () => {
  it("a Block is assignable to both BlockSpan and HashedSpan (compile-time)", () => {
    const block: Block = makeBlock();
    const asSpan: BlockSpan = block;
    const asHashed: HashedSpan = block;
    // Runtime assertions that every contract field is present.
    assert.equal(typeof asSpan.start, "number");
    assert.equal(typeof asSpan.end, "number");
    assert.equal(typeof asSpan.summary, "string");
    assert.equal(typeof asHashed.spanHash, "string");
    assert.equal(asSpan.summary, "summary text");
    assert.equal(asHashed.spanHash, "abcd1234");
    assert.equal(block.start, 0);
    assert.equal(block.end, 3);
  });

  it("a plain object satisfying both interfaces is a valid Block", () => {
    const block: Block = {
      start: 1,
      end: 4,
      summary: "s",
      spanHash: "00ff00ff",
      active: true,
      compressedTokens: 10,
      summaryTokens: 2,
      createdAt: 5,
    };
    assert.equal(block.title, undefined);
  });
});

// ---------------------------------------------------------------------------
// 6. Atomic persistence — temp file + rename, no half-written files
// ---------------------------------------------------------------------------

describe("atomic persistence", () => {
  it("writes via temp file + rename, leaving no tmp residue", () => {
    const { dir, store } = scratchStore();
    const state = makeState();
    state.blocks.set(1, makeBlock());
    store.save("atomic", state);

    const filePath = join(dir, "atomic.json");
    const tmpPath = join(dir, ".atomic.json.tmp");
    assert.equal(existsSync(tmpPath), false);
    assert.equal(existsSync(filePath), true);
    const parsed = JSON.parse(readFileSync(filePath, "utf8"));
    assert.equal(parsed.schema, SCHEMA_VERSION);
    assert.equal(parsed.blocks["1"].summary, "summary text");
  });

  it("a subsequent save atomically replaces the previous content", () => {
    const { store } = scratchStore();
    const first = makeState();
    first.blocks.set(1, makeBlock({ summary: "first" }));
    store.save("replace", first);

    const second = makeState();
    second.blocks.set(1, makeBlock({ summary: "second" }));
    second.blocks.set(2, makeBlock({ start: 9, end: 10 }));
    store.save("replace", second);

    const loaded = store.load("replace");
    assert.equal(loaded.blocks.size, 2);
    assert.equal(loaded.blocks.get(1)?.summary, "second");
  });

  it("a stale tmp file from an interrupted write is ignored on load", () => {
    const { dir, store } = scratchStore();
    // Simulate a crashed save: only the tmp file exists, half-written.
    writeFileSync(join(dir, ".stale.json.tmp"), "{ partial garbage");
    const state = store.load("stale");
    assert.equal(state.blocks.size, 0);
    assert.equal(state.marks.size, 0);
  });
});

// ---------------------------------------------------------------------------
// 7. hasActiveOverlap — caller invariant for landing new blocks
// ---------------------------------------------------------------------------

describe("hasActiveOverlap", () => {
  it("detects overlap with an active block", () => {
    const state = makeState();
    state.blocks.set(1, makeBlock({ start: 2, end: 5 }));
    assert.equal(hasActiveOverlap(state, 3, 4), true); // fully inside
    assert.equal(hasActiveOverlap(state, 1, 3), true); // straddles left edge
    assert.equal(hasActiveOverlap(state, 4, 6), true); // straddles right edge
    assert.equal(hasActiveOverlap(state, 0, 8), true); // contains the block
  });

  it("touching edges do not overlap (half-open intervals)", () => {
    const state = makeState();
    state.blocks.set(1, makeBlock({ start: 2, end: 5 }));
    assert.equal(hasActiveOverlap(state, 5, 7), false); // starts at block end
    assert.equal(hasActiveOverlap(state, 0, 2), false); // ends at block start
  });

  it("ignores inactive blocks", () => {
    const state = makeState();
    state.blocks.set(1, makeBlock({ start: 0, end: 5, active: false }));
    assert.equal(hasActiveOverlap(state, 1, 3), false);
  });

  it("an empty interval never overlaps", () => {
    const state = makeState();
    state.blocks.set(1, makeBlock({ start: 0, end: 5 }));
    assert.equal(hasActiveOverlap(state, 3, 3), false);
  });
});

// ---------------------------------------------------------------------------
// Keying helpers
// ---------------------------------------------------------------------------

describe("markKey", () => {
  it("keys marks by (anchorOrdinal, regionIndex?) without collision", () => {
    assert.equal(markKey(5), "5");
    assert.equal(markKey(5, 0), "5:0");
    assert.equal(markKey(5, 1), "5:1");
    assert.notEqual(markKey(5), markKey(5, 0));
    assert.notEqual(markKey(5, 0), markKey(5, 1));
  });
});

describe("nextBlockId", () => {
  it("continues from the maximum existing id, including inactive blocks", () => {
    const state = makeState();
    assert.equal(nextBlockId(state.blocks), 1);
    state.blocks.set(2, makeBlock());
    state.blocks.set(5, makeBlock({ active: false }));
    assert.equal(nextBlockId(state.blocks), 6);
  });
});
