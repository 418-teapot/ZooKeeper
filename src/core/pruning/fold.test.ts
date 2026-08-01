/**
 * Tests for the compression block fold consumer.
 *
 * Covers: basic fold (covered messages removed, summary injected at anchor),
 * first-user force-keep, synthetic marker and prefix, no-active op,
 * empty-blocks no-op, multiple blocks, deactivated blocks ignored,
 * and edge cases (anchor equals first user).
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { ContextMessageEntry } from "../metrics.js";
import type { CompressionPlan } from "./blocks.js";
import { type CompressionBlock, createBlock } from "./blocks.js";
import { foldCompressedBlocks, previewFold } from "./fold.js";
import {
  _clearAllSessionsForTesting,
  deleteSessionState,
  getOrCreateSessionState,
  removeSession,
} from "./marks.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TEST_SESSION_ID = "sess-fold-test";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMsg(id: string, role = "user"): ContextMessageEntry {
  return {
    info: { role, id } as ContextMessageEntry["info"],
    parts: [{ type: "text", text: `content-${id}` }],
  };
}

function makePlan(overrides?: Partial<CompressionPlan>): CompressionPlan {
  return {
    anchorMessageId: "msg-3",
    messageIds: ["msg-1", "msg-2", "msg-3"],
    summary: "user asked about X, assistant answered Y.",
    title: "auth middleware",
    compressedTokens: 1500,
    summaryTokens: 80,
    ...overrides,
  };
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
// foldCompressedBlocks
// ---------------------------------------------------------------------------

describe("foldCompressedBlocks", () => {
  it("removes all block-covered messages and injects summary at anchor position", () => {
    const state = getOrCreateSessionState(TEST_SESSION_ID);
    createBlock(state, makePlan());

    const messages = [
      makeMsg("msg-1"),
      makeMsg("msg-2"),
      makeMsg("msg-3"), // anchor
      makeMsg("msg-4"), // after block — should be preserved
    ];

    foldCompressedBlocks(state, messages);

    // Expect: msg-1 (first user force-kept), summary(b1), msg-4
    assert.equal(messages.length, 3);

    // msg-1 is the first user message — force-kept even though covered.
    assert.equal(messages[0].info.id, "msg-1");

    // Second message is the synthetic summary at the anchor position.
    const info1 = messages[1].info as unknown as Record<string, unknown>;
    assert.equal(info1.role, "user");
    assert.equal(info1.synthetic, true);
    assert.equal(info1.id, "zoo-fold-b1");

    const text1 = messages[1].parts?.[0] as { text?: string };
    assert.ok(text1?.text?.startsWith("[压缩块 b1"));
    assert.ok(text1?.text?.includes("user asked about X"));

    // msg-4 is preserved unchanged.
    assert.equal(messages[2].info.id, "msg-4");
  });

  it("keeps the first user message even when covered by a block", () => {
    const state = getOrCreateSessionState(TEST_SESSION_ID);
    // Block covers msg-1..msg-3; anchor is msg-3 (NOT the first user).
    createBlock(state, makePlan());

    const messages = [
      makeMsg("msg-1"), // first user IS covered — force-kept
      makeMsg("msg-2"),
      makeMsg("msg-3"), // anchor
      makeMsg("msg-4"),
    ];

    foldCompressedBlocks(state, messages);

    // Expect: msg-1 (kept), summary(b1), msg-4
    assert.equal(messages.length, 3);
    assert.equal(messages[0].info.id, "msg-1");
    assert.equal(
      (messages[1].info as unknown as Record<string, unknown>).synthetic,
      true,
    );
    assert.equal(messages[2].info.id, "msg-4");
  });

  it("force-keeps first user when it equals anchor: both kept and summary inserted", () => {
    const state = getOrCreateSessionState(TEST_SESSION_ID);
    // Block anchor IS the first user message.
    createBlock(
      state,
      makePlan({
        anchorMessageId: "msg-1",
        messageIds: ["msg-1", "msg-2", "msg-3"],
      }),
    );

    const messages = [
      makeMsg("msg-1"), // first user + anchor
      makeMsg("msg-2"),
      makeMsg("msg-3"),
      makeMsg("msg-4"),
    ];

    foldCompressedBlocks(state, messages);

    // Expect: summary(b1), msg-1 (kept first user), msg-4
    assert.equal(messages.length, 3);
    assert.equal(
      (messages[0].info as unknown as Record<string, unknown>).synthetic,
      true,
    );
    assert.equal(messages[1].info.id, "msg-1");
    assert.equal(messages[2].info.id, "msg-4");
  });

  it("creates synthetic message with correct marker and prefix", () => {
    const state = getOrCreateSessionState(TEST_SESSION_ID);
    createBlock(
      state,
      makePlan({ anchorMessageId: "msg-5", messageIds: ["msg-4", "msg-5"] }),
    );

    const messages = [
      makeMsg("msg-1"),
      makeMsg("msg-2"),
      makeMsg("msg-3"),
      makeMsg("msg-4"),
      makeMsg("msg-5"), // anchor
      makeMsg("msg-6"),
    ];

    foldCompressedBlocks(state, messages);

    // Expect: msg-1, msg-2, msg-3, summary(b1), msg-6
    assert.equal(messages.length, 5);

    const info3 = messages[3].info as unknown as Record<string, unknown>;
    assert.equal(info3.role, "user");
    assert.equal(info3.synthetic, true);
    assert.equal(info3.id, "zoo-fold-b1");

    const text3 = messages[3].parts?.[0] as { text?: string };
    assert.ok(text3?.text?.startsWith("[压缩块 b1"));
  });

  it("no active blocks → message list is byte-identical", () => {
    const state = getOrCreateSessionState(TEST_SESSION_ID);
    // Create a block then immediately deactivate it.
    createBlock(state, makePlan());
    for (const [, block] of state.blocks) {
      block.active = false;
    }

    const messages = [makeMsg("msg-1"), makeMsg("msg-2"), makeMsg("msg-3")];
    const snapshot = JSON.stringify(messages);

    foldCompressedBlocks(state, messages);

    assert.equal(messages.length, 3);
    assert.equal(JSON.stringify(messages), snapshot);
  });

  it("empty blocks map → no change (sub-agent O(1) no-op)", () => {
    const state = getOrCreateSessionState(TEST_SESSION_ID);
    // No blocks added — map is empty.

    const messages = [makeMsg("msg-1"), makeMsg("msg-2")];
    const snapshot = JSON.stringify(messages);

    foldCompressedBlocks(state, messages);

    assert.equal(JSON.stringify(messages), snapshot);
  });

  it("handles multiple active blocks", () => {
    const state = getOrCreateSessionState(TEST_SESSION_ID);

    // Block 1: covers msg-1..msg-3, anchor=msg-3
    createBlock(state, makePlan());
    // Block 2: covers msg-5..msg-7, anchor=msg-7
    createBlock(
      state,
      makePlan({
        anchorMessageId: "msg-7",
        messageIds: ["msg-5", "msg-6", "msg-7"],
        summary: "second segment.",
      }),
    );

    const messages = [
      makeMsg("msg-1"),
      makeMsg("msg-2"),
      makeMsg("msg-3"), // anchor b1
      makeMsg("msg-4"), // gap — preserved
      makeMsg("msg-5"),
      makeMsg("msg-6"),
      makeMsg("msg-7"), // anchor b2
      makeMsg("msg-8"),
    ];

    foldCompressedBlocks(state, messages);

    // Expect: msg-1 (first user force-kept), summary(b1), msg-4, summary(b2), msg-8
    assert.equal(messages.length, 5);

    // msg-1 is the first user — force-kept.
    assert.equal(messages[0].info.id, "msg-1");

    // summary for block 1 at anchor msg-3 position.
    assert.equal(
      (messages[1].info as unknown as Record<string, unknown>).synthetic,
      true,
    );
    assert.equal(
      (messages[1].info as unknown as Record<string, unknown>).id,
      "zoo-fold-b1",
    );

    // msg-4 is the gap — preserved.
    assert.equal(messages[2].info.id, "msg-4");

    // summary for block 2 at anchor msg-7 position.
    assert.equal(
      (messages[3].info as unknown as Record<string, unknown>).synthetic,
      true,
    );
    assert.equal(
      (messages[3].info as unknown as Record<string, unknown>).id,
      "zoo-fold-b2",
    );

    assert.equal(messages[4].info.id, "msg-8");
  });

  it("deactivated blocks are not folded", () => {
    const state = getOrCreateSessionState(TEST_SESSION_ID);
    // Create a block then deactivate it.
    const block = createBlock(state, makePlan());
    if (block) block.active = false;

    const messages = [makeMsg("msg-1"), makeMsg("msg-2"), makeMsg("msg-3")];

    foldCompressedBlocks(state, messages);

    // All messages preserved.
    assert.equal(messages.length, 3);
    assert.equal(messages[0].info.id, "msg-1");
    assert.equal(messages[1].info.id, "msg-2");
    assert.equal(messages[2].info.id, "msg-3");
  });

  it("assistant-first sessions (no user message) do not crash", () => {
    const state = getOrCreateSessionState(TEST_SESSION_ID);
    createBlock(state, makePlan());

    const messages = [
      makeMsg("sys-1", "system"),
      makeMsg("asst-1", "assistant"),
      makeMsg("msg-1"),
      makeMsg("msg-2"),
    ];

    // Should not throw — firstUserIdx stays -1.
    foldCompressedBlocks(state, messages);

    // Block covers msg-1..msg-3 (anchor=msg-3). msg-3 isn't in the current
    // message list so no anchor match.  msg-1 (first user) is covered →
    // force-kept.  msg-2 is covered → removed.  No anchor found → no
    // summary injected.
    // Result: sys-1, asst-1, msg-1 (force-kept)
    assert.equal(messages.length, 3);
    assert.equal(messages[0].info.id, "sys-1");
    assert.equal(messages[1].info.id, "asst-1");
    assert.equal(messages[2].info.id, "msg-1");
  });

  it("ignored user message before real first user does not affect force-keep", () => {
    const state = getOrCreateSessionState(TEST_SESSION_ID);
    // Block covers msg-1..msg-3; anchor is msg-3.
    createBlock(state, makePlan());

    const messages = [
      // Index 0: ignored user message (e.g. injected /dcp report), NOT covered by block.
      {
        info: {
          role: "user",
          id: "ignored-report",
          ignored: true,
        } as unknown as ContextMessageEntry["info"],
        parts: [{ type: "text", text: "/dcp report" }],
      } as ContextMessageEntry,
      // Index 1: real first user message - covered by block but force-kept.
      makeMsg("msg-1"),
      makeMsg("msg-2"),
      makeMsg("msg-3"), // anchor
      makeMsg("msg-4"),
    ];

    foldCompressedBlocks(state, messages);

    // Expect: ignored-report (uncovered, preserved), msg-1 (force-kept),
    //         summary(b1), msg-4 (preserved).
    assert.equal(messages.length, 4);
    // ignored-report is preserved (not covered by block).
    assert.equal(messages[0].info.id, "ignored-report");
    // msg-1 is the real first non-ignored user — force-kept.
    assert.equal(messages[1].info.id, "msg-1");
    // Synthetic summary at anchor position.
    assert.equal(
      (messages[2].info as unknown as Record<string, unknown>).synthetic,
      true,
    );
    // msg-4 is the last preserved message.
    assert.equal(messages[3].info.id, "msg-4");
  });
});

// ---------------------------------------------------------------------------
// previewFold — pure read-only fold
// ---------------------------------------------------------------------------

describe("previewFold", () => {
  it("returns new array with same content as foldCompressedBlocks for same fixture", () => {
    const state = getOrCreateSessionState(`${TEST_SESSION_ID}-equiv`);
    createBlock(state, makePlan());

    const messages = [
      makeMsg("msg-1"),
      makeMsg("msg-2"),
      makeMsg("msg-3"),
      makeMsg("msg-4"),
    ];

    // Reference: foldCompressedBlocks mutates in place.
    const msgsForMutate = [...messages];
    foldCompressedBlocks(state, msgsForMutate);

    // Extract blocks from state for the pure path.
    const blocks: CompressionBlock[] = [];
    for (const [, b] of state.blocks) {
      if (b.active) blocks.push(b);
    }

    const result = previewFold(messages, blocks);

    assert.deepEqual(result, msgsForMutate);
  });

  it("does not mutate the input messages array", () => {
    const messages = [
      makeMsg("msg-1"),
      makeMsg("msg-2"),
      makeMsg("msg-3"),
      makeMsg("msg-4"),
    ];
    const blocks: CompressionBlock[] = [
      {
        blockId: 1,
        active: true,
        anchorMessageId: "msg-3",
        messageIds: ["msg-1", "msg-2", "msg-3"],
        summary: "test summary.",
        title: "test",
        compressedTokens: 500,
        summaryTokens: 50,
        createdAt: 1000,
      },
    ];

    const snapshot = JSON.stringify(messages);
    previewFold(messages, blocks);

    // Original messages unchanged.
    assert.equal(JSON.stringify(messages), snapshot);
  });

  it("does not mutate the input blocks array", () => {
    const messages = [
      makeMsg("msg-1"),
      makeMsg("msg-2"),
      makeMsg("msg-3"),
      makeMsg("msg-4"),
    ];
    const block: CompressionBlock = {
      blockId: 1,
      active: true,
      anchorMessageId: "msg-3",
      messageIds: ["msg-1", "msg-2", "msg-3"],
      summary: "test summary.",
      title: "test",
      compressedTokens: 500,
      summaryTokens: 50,
      createdAt: 1000,
    };
    const blocks = [block];
    const snapshot = JSON.stringify(blocks);

    previewFold(messages, blocks);

    assert.equal(JSON.stringify(blocks), snapshot);
  });

  it("no active blocks → returns a copy of messages", () => {
    const messages = [makeMsg("msg-1"), makeMsg("msg-2")];
    const blocks: CompressionBlock[] = [
      {
        blockId: 1,
        active: false,
        anchorMessageId: "msg-3",
        messageIds: ["msg-1", "msg-2", "msg-3"],
        summary: "test.",
        title: "test",
        compressedTokens: 500,
        summaryTokens: 50,
        createdAt: 1000,
      },
    ];

    const result = previewFold(messages, blocks);

    assert.deepEqual(result, messages);
    assert.notStrictEqual(result, messages); // Different reference.
  });

  it("returns different reference from input array", () => {
    const messages = [makeMsg("msg-1")];
    const result = previewFold(messages, []);

    assert.notStrictEqual(result, messages);
    assert.deepEqual(result, messages);
  });

  it("removes covered messages and injects summary at anchor (direct blocks)", () => {
    const messages = [
      makeMsg("msg-1"),
      makeMsg("msg-2"),
      makeMsg("msg-3"), // anchor
      makeMsg("msg-4"),
    ];
    const blocks: CompressionBlock[] = [
      {
        blockId: 5,
        active: true,
        anchorMessageId: "msg-3",
        messageIds: ["msg-1", "msg-2", "msg-3"],
        summary: "direct summary.",
        title: "test",
        compressedTokens: 1200,
        summaryTokens: 60,
        createdAt: 2000,
      },
    ];

    const result = previewFold(messages, blocks);

    assert.equal(result.length, 3);
    assert.equal(result[0].info.id, "msg-1"); // force-kept first user
    assert.equal(
      (result[1].info as unknown as Record<string, unknown>).synthetic,
      true,
    );
    assert.equal(
      (result[1].info as unknown as Record<string, unknown>).id,
      "zoo-fold-b5",
    );
    assert.equal(result[2].info.id, "msg-4");
  });

  it("skips blocks referenced by messages not in the array", () => {
    const messages = [makeMsg("msg-4"), makeMsg("msg-5")];
    const blocks: CompressionBlock[] = [
      {
        blockId: 1,
        active: true,
        anchorMessageId: "msg-3",
        messageIds: ["msg-1", "msg-2", "msg-3"],
        summary: "segment.",
        title: "test",
        compressedTokens: 500,
        summaryTokens: 50,
        createdAt: 1000,
      },
    ];

    // Anchor msg-3 is NOT in messages.  The block adds its messageIds to
    // coveredIds but anchor never matches → covered msgs not in array
    // either, so effectively no effect.
    const result = previewFold(messages, blocks);

    assert.equal(result.length, 2);
    assert.deepEqual(result, messages);
  });

  it("handles multiple active blocks with direct array input", () => {
    const messages = [
      makeMsg("msg-1"),
      makeMsg("msg-2"),
      makeMsg("msg-3"), // anchor b1
      makeMsg("msg-4"), // gap
      makeMsg("msg-5"),
      makeMsg("msg-6"),
      makeMsg("msg-7"), // anchor b2
      makeMsg("msg-8"),
    ];
    const blocks: CompressionBlock[] = [
      {
        blockId: 1,
        active: true,
        anchorMessageId: "msg-3",
        messageIds: ["msg-1", "msg-2", "msg-3"],
        summary: "first seg.",
        title: "test",
        compressedTokens: 800,
        summaryTokens: 40,
        createdAt: 1000,
      },
      {
        blockId: 2,
        active: true,
        anchorMessageId: "msg-7",
        messageIds: ["msg-5", "msg-6", "msg-7"],
        summary: "second seg.",
        title: "test",
        compressedTokens: 900,
        summaryTokens: 45,
        createdAt: 2000,
      },
    ];

    const result = previewFold(messages, blocks);

    assert.equal(result.length, 5);
    assert.equal(result[0].info.id, "msg-1"); // force-kept
    assert.equal(
      (result[1].info as unknown as Record<string, unknown>).id,
      "zoo-fold-b1",
    );
    assert.equal(result[2].info.id, "msg-4"); // gap
    assert.equal(
      (result[3].info as unknown as Record<string, unknown>).id,
      "zoo-fold-b2",
    );
    assert.equal(result[4].info.id, "msg-8");
  });

  it("deactivated blocks are ignored in the blocks array", () => {
    const messages = [makeMsg("msg-1"), makeMsg("msg-2"), makeMsg("msg-3")];
    const blocks: CompressionBlock[] = [
      {
        blockId: 1,
        active: false,
        anchorMessageId: "msg-3",
        messageIds: ["msg-1", "msg-2", "msg-3"],
        summary: "inactive.",
        title: "test",
        compressedTokens: 500,
        summaryTokens: 50,
        createdAt: 1000,
      },
    ];

    const result = previewFold(messages, blocks);

    assert.equal(result.length, 3);
    assert.deepEqual(result, messages);
  });

  it("returns a new array (not the same reference as input)", () => {
    const messages = [makeMsg("msg-1")];
    const blocks: CompressionBlock[] = [];

    const result = previewFold(messages, blocks);

    assert.notStrictEqual(result, messages);
  });
});
