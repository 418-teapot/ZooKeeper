/**
 * Parity tests for `computeContextReportLens` (lens model) against the v1
 * `computeContextReport` (OpenCode adapter) — field-for-field equality.
 *
 * The same representative v1 `ContextMessageEntry` fixture is projected
 * through the adapter's `history()` into lens `HostMessage`s, then fed to
 * both producers.  Covering: multi-turn dialogs, a completed assistant with
 * cache usage, pruned tool output, ignored/hidden messages, and trailing
 * heuristic segments.
 *
 * This test file imports the v1 adapter types and `computeContextReport`
 * purely as the reference oracle — the only place allowed to do so.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { history } from "../../adapters/opencode/history.js";
import {
  type ContextMessageEntry,
  computeContextReport as v1ComputeContextReport,
} from "../../adapters/opencode/types.js";
import {
  computeContextReportLens,
  countFoldedMessages,
} from "./context-report-lens.js";
import type { HostMessage, ViewItem } from "./lens.js";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal v1 message entry with role, optional tokens, and text.
 */
function msg(
  role: string,
  tokens?: ContextTokenInfoShape,
  text?: string,
): ContextMessageEntry {
  const parts = text !== undefined ? [{ type: "text" as const, text }] : [];
  return { info: { role, id: "m", tokens }, parts };
}

type ContextTokenInfoShape = {
  input?: number;
  output?: number;
  reasoning?: number;
  cache?: { read?: number; write?: number };
};

/**
 * Build a v1 tool message entry with a tool part.
 */
function toolMsg(
  role: string,
  tokens: ContextTokenInfoShape | undefined,
  input: unknown,
  output: unknown,
  callId?: string,
  extraText?: string,
): ContextMessageEntry {
  const parts: Array<Record<string, unknown>> = [
    {
      type: "tool",
      ...(callId !== undefined ? { callID: callId } : {}),
      state: { input, output },
    },
  ];
  if (extraText !== undefined) {
    parts.push({ type: "text", text: extraText });
  }
  return {
    info: { role, id: "m", tokens },
    parts: parts as unknown as ContextMessageEntry["parts"],
  };
}

/**
 * Build a v1 ignored (hidden) user message.
 */
function ignoredMsg(text: string): ContextMessageEntry {
  return {
    info: { role: "user", id: "ignored" },
    parts: [{ type: "text", text, ignored: true }],
  } as unknown as ContextMessageEntry;
}

/**
 * Build a v1 message with summary=true (host-native compaction boundary).
 */
function summaryMsg(text: string): ContextMessageEntry {
  return {
    info: { role: "assistant", id: "summary", summary: true },
    parts: [{ type: "text", text }],
  };
}

// ---------------------------------------------------------------------------
// Parity assertion helper
// ---------------------------------------------------------------------------

/**
 * Assert that the lens report equals the v1 report field-for-field.
 */
function assertReportParity(v1Messages: ContextMessageEntry[]): void {
  const lensMessages: HostMessage[] = history(v1Messages);
  const v1 = v1ComputeContextReport(v1Messages);
  const lens = computeContextReportLens(lensMessages);
  assert.deepEqual(
    lens,
    v1,
    "lens report must match v1 report field-for-field",
  );
}

// ---------------------------------------------------------------------------
// Parity tests
// ---------------------------------------------------------------------------

describe("computeContextReportLens parity with v1 computeContextReport", () => {
  it("multi-turn dialog with cache usage, trailing heuristic, ignored message", () => {
    // user "Hello" (2) + assistant with cache (900) + ignored /dcp report
    // (excluded) + user "Follow-up text here" (5) + streaming assistant (0).
    const v1: ContextMessageEntry[] = [
      msg("user", undefined, "Hello"),
      msg(
        "assistant",
        {
          input: 500,
          output: 100,
          reasoning: 50,
          cache: { read: 200, write: 50 },
        },
        "Response",
      ),
      ignoredMsg("Ignored /dcp context report"),
      msg("user", undefined, "Follow-up text here"),
      msg("assistant", { output: 0 }, "Streaming…"),
    ];
    assertReportParity(v1);
  });

  it("pruned tool output — placeholder-signal detection", () => {
    // A tool part whose output is the pruned placeholder contributes
    // input + placeholder to the tool category.
    const v1: ContextMessageEntry[] = [
      msg("user", undefined, "Run command"),
      toolMsg(
        "assistant",
        { input: 500, output: 100 },
        "echo pruned",
        "[Output removed to save context - information superseded or no longer needed]",
        "call-pruned",
      ),
    ];
    assertReportParity(v1);
  });

  it("pruned tool output via state mutation (write-back path)", () => {
    // Simulate the post-prune state: the output has been replaced by the
    // placeholder in the v1 state object, so history() exposes it directly.
    const v1: ContextMessageEntry[] = [
      msg("user", undefined, "Go"),
      toolMsg(
        "assistant",
        { input: 100, output: 50 },
        "ls -la",
        "[Output removed to save context - information superseded or no longer needed]",
        "call-pruned",
      ),
    ];
    assertReportParity(v1);
  });

  it("empty transcript", () => {
    assertReportParity([]);
  });

  it("compaction boundary — categories only reflect messages at/after it", () => {
    // Pre-boundary history (excluded from categories):
    //   user "Old long question" (17 chars → 5) + assistant tokens
    //   {input: 1000, output: 200} (would be assistant 200 if counted).
    // Boundary: summaryMsg (role assistant, no tokens) — heuristic
    //   fallback "Previous conversation condensed" (30 chars → 8).
    // Post-boundary current context:
    //   user "New question" (12 chars → 3) + assistant {input: 300,
    //   output: 60}.
    // v1: total = last completed assistant (idx 4): 300+60 = 360.
    // Categories (boundary-aware): user=3, assistant=8+60=68, tool=0,
    // system = 360 − 3 − 68 − 0 = 289.
    const v1: ContextMessageEntry[] = [
      msg("user", undefined, "Old long question"),
      msg("assistant", { input: 1000, output: 200 }, "Old answer"),
      summaryMsg("Previous conversation condensed"),
      msg("user", undefined, "New question"),
      msg("assistant", { input: 300, output: 60 }, "New answer"),
    ];
    assertReportParity(v1);
  });

  it("synthetic (ZooKeeper fold-block summary) is not a compaction boundary", () => {
    // `info.synthetic` marks ZooKeeper's own fold-block summary — a
    // distinct concept from `info.summary`.  v1's findCompactionBoundary
    // only recognizes `summary === true`, so a synthetic message must not
    // restrict the lens category breakdown either.  This fixture would
    // diverge if the projection mistakenly mapped `synthetic` to
    // `compaction`.
    const v1: ContextMessageEntry[] = [
      msg("user", undefined, "Old question"),
      msg("assistant", { input: 500, output: 100 }, "Old answer"),
      {
        info: { role: "user", id: "synthetic", synthetic: true },
        parts: [{ type: "text", text: "[Block b1 · 2 条] title\nbody" }],
      },
      msg("user", undefined, "New question"),
      msg("assistant", { input: 300, output: 60 }, "New answer"),
    ];
    assertReportParity(v1);
  });

  it("no completed assistant — pure heuristic", () => {
    const v1: ContextMessageEntry[] = [
      msg("user", undefined, "First message"),
      msg("assistant", undefined, "Still thinking"),
    ];
    assertReportParity(v1);
  });

  it("system role text absorbed by system residual", () => {
    const v1: ContextMessageEntry[] = [
      msg("system", undefined, "System prompt here"),
      msg("user", undefined, "Hello"),
      msg("assistant", { input: 200, output: 50 }, "OK"),
    ];
    assertReportParity(v1);
  });

  it("all-heuristic session (no completed assistant)", () => {
    const v1: ContextMessageEntry[] = [
      msg("user", undefined, "Hello"),
      msg("assistant", undefined, "Hi"),
    ];
    assertReportParity(v1);
  });

  it("messages without parts", () => {
    const v1: ContextMessageEntry[] = [
      msg("user", undefined, "Hello"),
      { info: { role: "assistant", id: "a1" } },
    ];
    assertReportParity(v1);
  });
});

// ---------------------------------------------------------------------------
// countFoldedMessages — dual-scope message counts
// ---------------------------------------------------------------------------

describe("countFoldedMessages", () => {
  it("counts summary items as one each and originals by hidden flag", () => {
    const messages: HostMessage[] = [
      makeHiddenUser(),
      makeUser(),
      makeHiddenUser(),
      makeUser(),
    ];
    const items: ViewItem[] = [
      { type: "summary", block: { start: 0, end: 2, summary: "s" } },
      { type: "original", ordinal: 2 },
      { type: "original", ordinal: 3 },
    ];
    const counts = countFoldedMessages(items, messages);
    // storage: non-hidden = 2 (idx 1, 3).  folded: summary=1 + original
    // idx2 (hidden→0) + original idx3 (non-hidden→1) = 2.
    assert.equal(counts.storageMessageCount, 2);
    assert.equal(counts.foldedMessageCount, 2);
  });

  it("folded count differs from storage when a block folds hidden and visible", () => {
    const messages: HostMessage[] = [
      makeUser(), // 0
      makeHiddenUser(), // 1
      makeUser(), // 2
      makeUser(), // 3
    ];
    const items: ViewItem[] = [
      { type: "original", ordinal: 0 },
      // Block covers ordinals 1..3 (hidden + 2 visible) → one summary.
      { type: "summary", block: { start: 1, end: 4, summary: "s" } },
    ];
    const counts = countFoldedMessages(items, messages);
    // storage: non-hidden = 3 (0, 2, 3).  folded: original 0 (1) + summary (1) = 2.
    assert.equal(counts.storageMessageCount, 3);
    assert.equal(counts.foldedMessageCount, 2);
  });
});

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeUser(): HostMessage {
  return { role: "user", hidden: false, regions: [] };
}

function makeHiddenUser(): HostMessage {
  return { role: "user", hidden: true, regions: [] };
}
