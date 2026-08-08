/**
 * Tests for the compression block state layer.
 *
 * Covers: createBlock idempotence and id increment (including recovery
 * from persistence), syncBlocks (anchor present/absent/deactivated),
 * derived stats (activeBlockCount, activeReclaimedTokens,
 * cumulativeReclaimedTokens).
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { CompressionPlan } from "./blocks.js";
import {
  activeBlockCount,
  activeReclaimedTokens,
  type CompressionBlock,
  createBlock,
  cumulativeReclaimedTokens,
  liveBlocks,
  syncBlocks,
} from "./blocks.js";
import {
  _clearAllSessionsForTesting,
  deleteSessionState,
  getOrCreateSessionState,
  removeSession,
  saveSessionState,
} from "./marks.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEST_SESSION_ID = "sess-blocks-test";

function makePlan(overrides?: Partial<CompressionPlan>): CompressionPlan {
  return {
    anchorMessageId: "msg-3",
    messageIds: ["msg-1", "msg-2", "msg-3"],
    summary: "Summary: user asked about X, assistant answered Y.",
    title: "auth middleware investigation",
    compressedTokens: 1500,
    summaryTokens: 80,
    ...overrides,
  };
}

function makeMessage(id: string) {
  return { info: { id } };
}

// ---------------------------------------------------------------------------
// Teardown
// ---------------------------------------------------------------------------

afterEach(() => {
  deleteSessionState(TEST_SESSION_ID);
  removeSession(TEST_SESSION_ID);
  _clearAllSessionsForTesting();
});

// ---------------------------------------------------------------------------
// createBlock
// ---------------------------------------------------------------------------

describe("createBlock", () => {
  it("creates a block with blockId=1 on empty state", () => {
    const state = getOrCreateSessionState(TEST_SESSION_ID);
    const block = createBlock(state, makePlan());

    assert.ok(block !== null);
    assert.equal(block.blockId, 1);
    assert.equal(block.active, true);
    assert.equal(block.anchorMessageId, "msg-3");
    assert.deepEqual(block.messageIds, ["msg-1", "msg-2", "msg-3"]);
    assert.equal(
      block.summary,
      "Summary: user asked about X, assistant answered Y.",
    );
    assert.equal(block.title, "auth middleware investigation");
    assert.equal(block.compressedTokens, 1500);
    assert.equal(block.summaryTokens, 80);
    assert.equal(block.deactivatedBy, undefined);
    assert.ok(typeof block.createdAt === "number");
    assert.equal(state.dirty, true);
  });

  it("increments blockId for each new block", () => {
    const state = getOrCreateSessionState(TEST_SESSION_ID);

    const b1 = createBlock(state, makePlan({ anchorMessageId: "msg-3" }));
    assert.equal(b1?.blockId, 1);

    const b2 = createBlock(
      state,
      makePlan({ anchorMessageId: "msg-7", messageIds: ["msg-4", "msg-5"] }),
    );
    assert.equal(b2?.blockId, 2);

    const b3 = createBlock(
      state,
      makePlan({ anchorMessageId: "msg-10", messageIds: ["msg-9"] }),
    );
    assert.equal(b3?.blockId, 3);
  });

  it("is idempotent — returns null for duplicate anchorMessageId", () => {
    const state = getOrCreateSessionState(TEST_SESSION_ID);

    const b1 = createBlock(state, makePlan());
    assert.ok(b1 !== null);
    assert.equal(state.blocks.size, 1);
    assert.equal(state.dirty, true);

    // Reset dirty to verify second create does NOT set it.
    state.dirty = false;

    const b2 = createBlock(state, makePlan());
    assert.equal(b2, null);
    // Block count unchanged.
    assert.equal(state.blocks.size, 1);
    // dirty NOT set.
    assert.equal(state.dirty, false);
  });

  it("creates a block when the anchor-occupying block is excluded by id", () => {
    const state = getOrCreateSessionState(TEST_SESSION_ID);

    const b1 = createBlock(state, makePlan()); // anchor msg-3, blockId 1
    assert.ok(b1 !== null);

    // The same anchor re-created with block 1 excluded succeeds (the
    // caller is about to consume block 1 — create-before-consume order).
    const b2 = createBlock(
      state,
      makePlan({ messageIds: ["msg-1", "msg-2", "msg-3", "msg-4"] }),
      [b1.blockId],
    );
    assert.ok(b2 !== null);
    assert.equal(b2.blockId, 2);
    assert.equal(b2.anchorMessageId, "msg-3");
    assert.deepEqual(b2.messageIds, ["msg-1", "msg-2", "msg-3", "msg-4"]);
    assert.equal(state.blocks.size, 2);
    assert.equal(state.dirty, true);
  });

  it("returns null when a non-excluded block occupies the anchor (genuine conflict)", () => {
    const state = getOrCreateSessionState(TEST_SESSION_ID);

    const b1 = createBlock(state, makePlan()); // anchor msg-3, blockId 1
    assert.ok(b1 !== null);

    // Exclude a DIFFERENT block id — block 1 still occupies the anchor.
    state.dirty = false;
    const b2 = createBlock(state, makePlan(), [999]);
    assert.equal(b2, null);
    // Block count unchanged and dirty NOT set.
    assert.equal(state.blocks.size, 1);
    assert.equal(state.dirty, false);
  });

  it("continues blockId numbering after restore from persistence", () => {
    const state = getOrCreateSessionState(TEST_SESSION_ID);

    // Create two blocks.
    createBlock(state, makePlan({ anchorMessageId: "msg-3" })); // b1
    createBlock(
      state,
      makePlan({ anchorMessageId: "msg-7", messageIds: ["msg-5"] }),
    ); // b2

    saveSessionState(TEST_SESSION_ID, state);

    // Simulate restart.
    removeSession(TEST_SESSION_ID);
    _clearAllSessionsForTesting();

    const restored = getOrCreateSessionState(TEST_SESSION_ID);
    assert.equal(restored.blocks.size, 2);

    // Next block should be id=3.
    const b3 = createBlock(
      restored,
      makePlan({ anchorMessageId: "msg-10", messageIds: ["msg-9"] }),
    );
    assert.ok(b3 !== null);
    assert.equal(b3.blockId, 3);
  });
});

// ---------------------------------------------------------------------------
// syncBlocks
// ---------------------------------------------------------------------------

describe("syncBlocks", () => {
  it("leaves blocks untouched when anchor message is present", () => {
    const state = getOrCreateSessionState(TEST_SESSION_ID);
    createBlock(state, makePlan({ anchorMessageId: "msg-3" }));

    const messages = [
      makeMessage("msg-1"),
      makeMessage("msg-2"),
      makeMessage("msg-3"),
      makeMessage("msg-4"),
    ];

    state.dirty = false;
    syncBlocks(state, messages);

    // Block still active.
    const block = state.blocks.get("1");
    assert.ok(block !== undefined);
    assert.equal(block.active, true);
    assert.equal(state.dirty, false);
  });

  it("deactivates block when anchor message is missing", () => {
    const state = getOrCreateSessionState(TEST_SESSION_ID);
    createBlock(state, makePlan({ anchorMessageId: "msg-3" }));

    const messages = [
      makeMessage("msg-1"),
      makeMessage("msg-2"),
      // msg-3 is missing (compacted away)
      makeMessage("msg-4"),
    ];

    state.dirty = false;
    syncBlocks(state, messages);

    const block = state.blocks.get("1");
    assert.ok(block !== undefined);
    assert.equal(block.active, false);
    assert.equal(state.dirty, true);
  });

  it("does NOT re-process already-deactivated blocks", () => {
    const state = getOrCreateSessionState(TEST_SESSION_ID);
    createBlock(state, makePlan({ anchorMessageId: "msg-3" }));

    // First sync: deactivate the block.
    syncBlocks(state, [makeMessage("msg-1")]);
    assert.equal(state.blocks.get("1")?.active, false);

    // Reset dirty.
    state.dirty = false;

    // Second sync: block already deactivated — should not touch it.
    syncBlocks(state, [makeMessage("msg-1")]);
    // Block stays deactivated.
    assert.equal(state.blocks.get("1")?.active, false);
    // dirty NOT set (no state mutation).
    assert.equal(state.dirty, false);
  });

  it("handles multiple blocks — deactivates only those with missing anchors", () => {
    const state = getOrCreateSessionState(TEST_SESSION_ID);
    createBlock(state, makePlan({ anchorMessageId: "msg-3" })); // block 1
    createBlock(
      state,
      makePlan({
        anchorMessageId: "msg-7",
        messageIds: ["msg-5", "msg-6"],
      }),
    ); // block 2
    createBlock(
      state,
      makePlan({
        anchorMessageId: "msg-10",
        messageIds: ["msg-9"],
      }),
    ); // block 3

    // Messages missing block 1 and block 3's anchors.
    const messages = [
      makeMessage("msg-1"),
      makeMessage("msg-2"),
      // msg-3 missing
      makeMessage("msg-4"),
      makeMessage("msg-5"),
      makeMessage("msg-6"),
      makeMessage("msg-7"), // present
      makeMessage("msg-8"),
      // msg-9, msg-10 missing
    ];

    syncBlocks(state, messages);

    assert.equal(state.blocks.get("1")?.active, false); // msg-3 missing
    assert.equal(state.blocks.get("2")?.active, true); // msg-7 present
    assert.equal(state.blocks.get("3")?.active, false); // msg-10 missing
  });
});

// ---------------------------------------------------------------------------
// Derived stats
// ---------------------------------------------------------------------------

describe("derived stats", () => {
  it("activeBlockCount returns number of active blocks", () => {
    const state = getOrCreateSessionState(TEST_SESSION_ID);
    assert.equal(activeBlockCount(state), 0);

    createBlock(state, makePlan({ anchorMessageId: "msg-3" }));
    assert.equal(activeBlockCount(state), 1);

    createBlock(state, makePlan({ anchorMessageId: "msg-7" }));
    assert.equal(activeBlockCount(state), 2);

    // Deactivate block 1 (msg-3 missing).
    syncBlocks(state, [makeMessage("msg-7")]); // Only block 2's anchor present.
    assert.equal(activeBlockCount(state), 1);
  });

  it("activeReclaimedTokens sums net tokens for active blocks only", () => {
    const state = getOrCreateSessionState(TEST_SESSION_ID);

    // Block 1: compressed=1500, summary=80 → reclaimed=1420
    createBlock(state, makePlan({ anchorMessageId: "msg-3" }));
    assert.equal(activeReclaimedTokens(state), 1420);

    // Block 2: compressed=800, summary=50 → reclaimed=750
    createBlock(
      state,
      makePlan({
        anchorMessageId: "msg-7",
        messageIds: ["msg-5", "msg-6"],
        compressedTokens: 800,
        summaryTokens: 50,
      }),
    );
    assert.equal(activeReclaimedTokens(state), 1420 + 750);

    // Deactivate block 1 (msg-3 missing) — only block 2 contributes.
    syncBlocks(state, [makeMessage("msg-7")]);
    assert.equal(activeReclaimedTokens(state), 750);
  });

  it("cumulativeReclaimedTokens sums net tokens for all blocks", () => {
    const state = getOrCreateSessionState(TEST_SESSION_ID);

    // Block 1: 1420 net.
    createBlock(state, makePlan({ anchorMessageId: "msg-3" }));
    assert.equal(cumulativeReclaimedTokens(state), 1420);

    // Block 2: 750 net.
    createBlock(
      state,
      makePlan({
        anchorMessageId: "msg-7",
        messageIds: ["msg-5"],
        compressedTokens: 800,
        summaryTokens: 50,
      }),
    );
    assert.equal(cumulativeReclaimedTokens(state), 1420 + 750);

    // Deactivate block 1 — cumulative unchanged (still counts).
    syncBlocks(state, [makeMessage("msg-1")]);
    assert.equal(cumulativeReclaimedTokens(state), 1420 + 750);
  });

  it("active vs cumulative differ after deactivation", () => {
    const state = getOrCreateSessionState(TEST_SESSION_ID);
    createBlock(state, makePlan({ anchorMessageId: "msg-3" })); // 1420 net
    createBlock(
      state,
      makePlan({
        anchorMessageId: "msg-7",
        compressedTokens: 500,
        summaryTokens: 20,
      }),
    ); // 480 net

    // Both active: active == cumulative.
    assert.equal(activeReclaimedTokens(state), 1420 + 480);
    assert.equal(cumulativeReclaimedTokens(state), 1420 + 480);

    // Deactivate block 1 (msg-3 missing).
    syncBlocks(state, [makeMessage("msg-7")]);

    // Active excludes block 1, cumulative includes all.
    assert.equal(activeReclaimedTokens(state), 480);
    assert.equal(cumulativeReclaimedTokens(state), 1420 + 480);
  });
});

// ---------------------------------------------------------------------------
// liveBlocks — pure liveness filter
// ---------------------------------------------------------------------------

describe("liveBlocks", () => {
  function makeBlock(overrides?: Partial<CompressionBlock>): CompressionBlock {
    return {
      blockId: 1,
      active: true,
      anchorMessageId: "msg-3",
      messageIds: ["msg-1", "msg-2", "msg-3"],
      summary: "summary.",
      title: "test block",
      compressedTokens: 500,
      summaryTokens: 50,
      createdAt: 1000,
      ...overrides,
    };
  }

  it("keeps active block with anchor present in messages", () => {
    const blocks = [makeBlock()];
    const messages = [
      makeMessage("msg-1"),
      makeMessage("msg-2"),
      makeMessage("msg-3"),
    ];

    const result = liveBlocks(blocks, messages);

    assert.equal(result.length, 1);
    assert.equal(result[0].blockId, 1);
  });

  it("filters out active block with anchor missing from messages", () => {
    const blocks = [makeBlock({ anchorMessageId: "msg-99" })];
    const messages = [makeMessage("msg-1"), makeMessage("msg-2")];

    const result = liveBlocks(blocks, messages);

    assert.equal(result.length, 0);
  });

  it("filters out inactive block even when anchor is present", () => {
    const blocks = [makeBlock({ active: false })];
    const messages = [
      makeMessage("msg-1"),
      makeMessage("msg-2"),
      makeMessage("msg-3"),
    ];

    const result = liveBlocks(blocks, messages);

    assert.equal(result.length, 0);
  });

  it("handles mixed live and dead blocks", () => {
    const blocks = [
      makeBlock({
        blockId: 1,
        anchorMessageId: "msg-3",
      }), // live
      makeBlock({
        blockId: 2,
        anchorMessageId: "msg-99",
      }), // dead (anchor missing)
      makeBlock({
        blockId: 3,
        anchorMessageId: "msg-6",
        active: false,
      }), // dead (inactive)
      makeBlock({
        blockId: 4,
        anchorMessageId: "msg-6",
      }), // live
    ];
    const messages = [
      makeMessage("msg-1"),
      makeMessage("msg-2"),
      makeMessage("msg-3"),
      makeMessage("msg-4"),
      makeMessage("msg-5"),
      makeMessage("msg-6"),
    ];

    const result = liveBlocks(blocks, messages);

    assert.equal(result.length, 2);
    assert.equal(result[0].blockId, 1);
    assert.equal(result[1].blockId, 4);
  });

  it("returns a new array (not the same reference)", () => {
    const blocks = [makeBlock()];
    const messages = [makeMessage("msg-1"), makeMessage("msg-3")];

    const result = liveBlocks(blocks, messages);

    assert.notStrictEqual(result, blocks);
  });

  it("does not mutate the input blocks array", () => {
    const block = makeBlock();
    const blocks = [block];
    const messages = [makeMessage("msg-1"), makeMessage("msg-3")];

    const snapshot = JSON.stringify(blocks);
    liveBlocks(blocks, messages);

    assert.equal(JSON.stringify(blocks), snapshot);
  });
});
