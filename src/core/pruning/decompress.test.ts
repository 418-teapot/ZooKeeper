/**
 * Tests for the decompress core (resolveTarget / evaluateGate /
 * applyDecompress / truncateRecallSummary).
 *
 * Covers: loud Chinese errors for invalid `b<N>` formats and nonexistent
 * blocks, restore vs recall resolution, idempotent recall, the restore
 * context-limit gate (boundary pass, rejection with delta + guidance,
 * skipped when the limit is missing), the four applyDecompress mutations,
 * recall summary truncation, and the deactivatedBy/deactivatedAt
 * persistence round-trip.
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { type CompressionBlock, createBlock } from "./blocks.js";
import {
  applyDecompress,
  evaluateGate,
  RECALL_MAX_CHARS,
  resolveTarget,
  truncateRecallSummary,
} from "./decompress.js";
import {
  _clearAllSessionsForTesting,
  deleteSessionState,
  getOrCreateSessionState,
  loadSessionState,
  removeSession,
  type SessionState,
  saveSessionState,
} from "./marks.js";

// ---------------------------------------------------------------------------
// Constants & helpers
// ---------------------------------------------------------------------------

const TEST_SESSION_ID = "sess-decompress-test";

/** A complete CompressionBlock literal for gate/truncation tests. */
function makeBlock(
  overrides: Partial<CompressionBlock> = {},
): CompressionBlock {
  return {
    blockId: 1,
    active: true,
    anchorMessageId: "m3",
    messageIds: ["m1", "m2", "m3"],
    summary: "test summary",
    title: "测试主题",
    compressedTokens: 1000,
    summaryTokens: 60,
    createdAt: 123456789,
    ...overrides,
  };
}

/** Compression plan matching makeBlock's anchor. */
function makePlan() {
  return {
    anchorMessageId: "m3",
    messageIds: ["m1", "m2", "m3"],
    summary: "test summary",
    title: "测试主题",
    compressedTokens: 1000,
    summaryTokens: 60,
  };
}

/** Fresh session state with block b1 created and returned. */
function freshStateWithBlock(): {
  state: SessionState;
  block: CompressionBlock;
} {
  const state = getOrCreateSessionState(TEST_SESSION_ID);
  const block = createBlock(state, makePlan());
  assert.ok(block !== null);
  return { state, block };
}

// ---------------------------------------------------------------------------
// Teardown
// ---------------------------------------------------------------------------

afterEach(() => {
  deleteSessionState(TEST_SESSION_ID);
  removeSession(TEST_SESSION_ID);
  _clearAllSessionsForTesting();
});

// ===========================================================================
// resolveTarget
// ===========================================================================

describe("resolveTarget", () => {
  it("throws a loud Chinese format error for invalid ids", () => {
    const state = getOrCreateSessionState(TEST_SESSION_ID);
    for (const bad of ["3", "b0", "b-1", "bx", "", "b"]) {
      assert.throws(
        () => resolveTarget(state, bad),
        (err: unknown) =>
          err instanceof Error &&
          /格式非法/.test(err.message) &&
          /\[Compression Block bN\]/.test(err.message) &&
          /--- bN/.test(err.message),
      );
    }
  });

  it("throws a loud Chinese error for a nonexistent block id", () => {
    const state = getOrCreateSessionState(TEST_SESSION_ID);
    createBlock(state, makePlan());
    assert.throws(
      () => resolveTarget(state, "b99"),
      (err: unknown) =>
        err instanceof Error &&
        /不存在/.test(err.message) &&
        /\[Compression Block bN\]/.test(err.message) &&
        /--- bN/.test(err.message),
    );
  });

  it("resolves an active block to kind restore", () => {
    const { state, block } = freshStateWithBlock();
    const result = resolveTarget(state, "b1");
    assert.equal(result.kind, "restore");
    assert.equal(result.block, block);
  });

  it("resolves an inactive block to kind recall", () => {
    const { state, block } = freshStateWithBlock();
    block.active = false;
    const result = resolveTarget(state, "b1");
    assert.equal(result.kind, "recall");
    assert.equal(result.block, block);
  });

  it("recall is idempotent — repeated calls on the same inactive block do not error", () => {
    const { state, block } = freshStateWithBlock();
    block.active = false;
    const r1 = resolveTarget(state, "b1");
    const r2 = resolveTarget(state, "b1");
    assert.equal(r1.kind, "recall");
    assert.equal(r2.kind, "recall");
    assert.equal(r1.block.summary, "test summary");
    assert.equal(r2.block.summary, "test summary");
  });
});

// ===========================================================================
// evaluateGate
// ===========================================================================

describe("evaluateGate", () => {
  it("allows when the estimated after equals the threshold (boundary passes)", () => {
    const block = makeBlock({ compressedTokens: 1000, summaryTokens: 500 });
    // after = 0 + (1000 - 500) = 500; threshold = 1000 * 50 / 100 = 500.
    assert.deepEqual(evaluateGate(0, block, 1000, 50), { allowed: true });
  });

  it("rejects when the estimated after exceeds the threshold, with delta and guidance", () => {
    const block = makeBlock({ compressedTokens: 1000, summaryTokens: 500 });
    // after = 100 + 500 = 600 > threshold 500.
    const result = evaluateGate(100, block, 1000, 50);
    assert.equal(result.allowed, false);
    assert.ok(result.reason.includes("600"));
    assert.ok(result.reason.includes("500"));
    assert.ok(/超过/.test(result.reason));
    assert.ok(/回胀/.test(result.reason));
    assert.ok(/腾出空间/.test(result.reason));
  });

  it("skips the gate when the context limit is missing (allowed)", () => {
    const block = makeBlock({ compressedTokens: 999999, summaryTokens: 0 });
    assert.deepEqual(evaluateGate(100000, block, undefined, 50), {
      allowed: true,
    });
  });
});

// ===========================================================================
// applyDecompress
// ===========================================================================

describe("applyDecompress", () => {
  it("sets the four mutations on the block and state", () => {
    const { state, block } = freshStateWithBlock();
    state.dirty = false;
    applyDecompress(state, block);
    assert.equal(block.active, false);
    assert.equal(block.deactivatedBy, "user");
    assert.equal(typeof block.deactivatedAt, "number");
    assert.equal(state.dirty, true);
  });
});

// ===========================================================================
// truncateRecallSummary
// ===========================================================================

describe("truncateRecallSummary", () => {
  it("truncates an over-cap summary with a Chinese tail note", () => {
    const long = "x".repeat(RECALL_MAX_CHARS + 500);
    const result = truncateRecallSummary(long);
    assert.ok(result.length > RECALL_MAX_CHARS);
    assert.equal(result.startsWith("x".repeat(RECALL_MAX_CHARS)), true);
    assert.ok(result.includes("省略 500 字符"));
  });

  it("returns under-cap and exactly-cap summaries untouched", () => {
    const short = "短摘要";
    assert.equal(truncateRecallSummary(short), short);
    const exact = "y".repeat(RECALL_MAX_CHARS);
    assert.equal(truncateRecallSummary(exact), exact);
  });
});

// ===========================================================================
// deactivatedBy persistence
// ===========================================================================

describe("deactivatedBy persistence", () => {
  it("round-trips deactivatedBy and deactivatedAt through save/load", () => {
    const { state, block } = freshStateWithBlock();
    applyDecompress(state, block);
    saveSessionState(TEST_SESSION_ID, state);

    // Simulate restart.
    removeSession(TEST_SESSION_ID);
    _clearAllSessionsForTesting();

    const loaded = loadSessionState(TEST_SESSION_ID);
    assert.ok(loaded !== null);
    const b1 = loaded.blocks.get("1");
    assert.ok(b1 !== undefined);
    assert.equal(b1.active, false);
    assert.equal(b1.deactivatedBy, "user");
    assert.equal(b1.deactivatedAt, block.deactivatedAt);
  });
});
