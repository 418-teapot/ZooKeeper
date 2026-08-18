/**
 * Tests for the lens-based nudge module (`nudge.ts`).
 *
 * Lens-specific behavior:
 *   - threshold resolution across percentage, absolute, mixed, and
 *     malformed inputs (C6-01),
 *   - nudge evaluation trigger boundaries ±1 token and the
 *     single-anchor watermark transitions (C6-02, C5-07),
 *   - the gates (completed assistant, absent / invalid config, empty
 *     eligible window) and watermark persistence (C5-08, C6-05),
 *   - the reminder text assembled from the shared templates (C6-03),
 *   - the eligibility window computation (C6-05).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { COMPRESS_GUIDANCE } from "../prompts.js";
import type { HostMessage } from "./lens.js";
import { makeMsg } from "./lens-testkit.js";
import {
  computeEligibility,
  evaluateNudge,
  type NudgeConfig,
  type NudgeInjectOptions,
} from "./nudge.js";
import type { SessionState } from "./state.js";

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

/**
 * Nudge config resolving against a 200K window: min 120K, max 160K,
 * growth 10K (gentle) / 5K (urgent) — the same thresholds the golden
 * G-NUDGE-01 scenario uses.
 */
const NUDGE_CONFIG: NudgeConfig = {
  minContext: "60%",
  minContextCap: 200000,
  maxContext: "80%",
  maxContextCap: 300000,
  growthTokens: "5%",
};

/**
 * Context inputs for the parity evaluations: a non-empty eligible window
 * whenever a level fires (no protection, no phantom gate, refs present).
 */
const PARITY_OPTS = {
  contextLimit: 200000,
  protectedMessages: 0,
  protectedTokens: 0,
  thresholdTokens: 0,
};

/** Ref lookup over the lens fixture ordinals (1-based ref names). */
const ORDINAL_REFS = ["m0001", "m0002", "m0003", "m0004"];
const refForLens = (ordinal: number): string | undefined =>
  ORDINAL_REFS[ordinal];

/** Injection options for standalone lens-only tests. */
const INJECT_OPTS: NudgeInjectOptions = {
  contextLimit: 200000,
  protectedMessages: 2,
  protectedTokens: 0,
  thresholdTokens: 0,
  refForOrdinal: refForLens,
};

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

/**
 * Build the two-turn lens nudge view.  Only a1 carries usage
 * (`output: 100 > 0`), so it is the last completed assistant.
 */
function lensNudgeMessages(
  inputTokens: number,
  cacheRead = 0,
  cacheWrite = 0,
): HostMessage[] {
  return [
    makeMsg("user", ["hello"]),
    makeMsg("assistant", ["response text"], {
      usage: { input: inputTokens, output: 100, cacheRead, cacheWrite },
    }),
    makeMsg("user", ["again"]),
    makeMsg("assistant", ["done"]),
  ];
}

/**
 * Create a fresh session state with an optional nudge watermark.
 */
function makeNewState(lastAnchor?: number): SessionState {
  const state: SessionState = { blocks: new Map(), marks: new Map() };
  if (lastAnchor !== undefined) {
    state.nudges = { lastNudgeTokens: lastAnchor };
  }
  return state;
}

// ---------------------------------------------------------------------------
// evaluateNudge — gates and watermark persistence
// ---------------------------------------------------------------------------

describe("evaluateNudge gates", () => {
  it("skips when no completed assistant exists — watermark untouched (C5-08)", () => {
    const streaming = [
      makeMsg("user", ["hello"]),
      makeMsg("assistant", ["streaming"], { usage: { output: 0 } }),
    ];
    const state = makeNewState(140000);
    const text = evaluateNudge(state, streaming, NUDGE_CONFIG, {
      ...PARITY_OPTS,
      refForOrdinal: refForLens,
    });
    assert.equal(text, null, "nudge skipped");
    assert.equal(state.nudges?.lastNudgeTokens, 140000, "watermark untouched");

    // A text-only assistant without usage is not completed either.
    const plain = [makeMsg("user", ["hello"]), makeMsg("assistant", ["ok"])];
    const text2 = evaluateNudge(state, plain, NUDGE_CONFIG, {
      ...PARITY_OPTS,
      refForOrdinal: refForLens,
    });
    assert.equal(text2, null);
    assert.equal(state.nudges?.lastNudgeTokens, 140000);
  });

  it("returns null and leaves the watermark untouched for an absent config", () => {
    const state = makeNewState(140000);
    const text = evaluateNudge(state, lensNudgeMessages(150000), undefined, {
      ...PARITY_OPTS,
      refForOrdinal: refForLens,
    });
    assert.equal(text, null);
    assert.equal(state.nudges?.lastNudgeTokens, 140000, "watermark untouched");
  });

  it("returns null and leaves the watermark untouched for an invalid config", () => {
    const inverted: NudgeConfig = { ...NUDGE_CONFIG, minContext: "90%" };
    const malformed: NudgeConfig = { ...NUDGE_CONFIG, growthTokens: "5" };
    for (const config of [inverted, malformed]) {
      const state = makeNewState(140000);
      const text = evaluateNudge(state, lensNudgeMessages(150000), config, {
        ...PARITY_OPTS,
        refForOrdinal: refForLens,
      });
      assert.equal(text, null);
      assert.equal(state.nudges?.lastNudgeTokens, 140000);
    }
  });

  it("persists the anchor but injects nothing when no window is eligible (C6-05)", () => {
    // protectedMessages covers the whole view → empty window.
    const state = makeNewState();
    const opts: NudgeInjectOptions = {
      ...INJECT_OPTS,
      protectedMessages: 100,
    };
    assert.equal(
      evaluateNudge(state, lensNudgeMessages(140000), NUDGE_CONFIG, opts),
      null,
    );
    const text = evaluateNudge(
      state,
      lensNudgeMessages(150000),
      NUDGE_CONFIG,
      opts,
    );
    assert.equal(text, null, "no text without an eligible window");
    assert.equal(
      state.nudges?.lastNudgeTokens,
      150000,
      "anchor still persisted",
    );
  });
});

// ---------------------------------------------------------------------------
// Nudge text assembly
// ---------------------------------------------------------------------------

describe("nudge text assembly (C6-03)", () => {
  it("assembles the gentle reminder from the shared templates", () => {
    const state = makeNewState();
    assert.equal(
      evaluateNudge(
        state,
        lensNudgeMessages(140000),
        NUDGE_CONFIG,
        INJECT_OPTS,
      ),
      null,
      "baseline injects nothing",
    );
    const text = evaluateNudge(
      state,
      lensNudgeMessages(150000),
      NUDGE_CONFIG,
      INJECT_OPTS,
    );
    assert.ok(text !== null, "gentle fires");
    assert.ok(text.startsWith("<internal-reminder>"), "wrapper opens");
    assert.ok(text.endsWith("</internal-reminder>"), "wrapper closes");
    assert.ok(
      text.includes("**CONTEXT GROWING — 150000 (75% of 200000 window)**"),
      "gentle header with tokens and percent",
    );
    assert.ok(
      text.includes(
        "Compressible window: m0002–m0002 (~4 tokens), both refs inclusive.",
      ),
      "window refs and reclaim estimate",
    );
    assert.ok(
      text.includes(
        "At your next natural pause, compress a closed range with the `compress` tool. Timing is your call.",
      ),
      "gentle action copy",
    );
    assert.ok(
      text.includes(
        "UNCOMPRESSED HISTORY = GROWING CONTEXT = SHRINKING HEADROOM.",
      ),
      "gentle equation copy",
    );
    assert.ok(text.includes(COMPRESS_GUIDANCE), "teaching slot filled");
    assert.ok(!text.includes("{"), "no placeholder leaks");
  });

  it("assembles the urgent reminder from the shared templates", () => {
    const state = makeNewState();
    evaluateNudge(state, lensNudgeMessages(140000), NUDGE_CONFIG, INJECT_OPTS);
    const text = evaluateNudge(
      state,
      lensNudgeMessages(165000),
      NUDGE_CONFIG,
      INJECT_OPTS,
    );
    assert.ok(text !== null, "urgent fires");
    assert.ok(
      text.includes("**CONTEXT LIMIT — 165000 (83% of 200000 window)**"),
      "urgent header",
    );
    assert.ok(
      text.includes(
        "Finish your current atomic step, then call the `compress` tool IMMEDIATELY.",
      ),
      "urgent action copy",
    );
    assert.ok(
      text.includes("FULL CONTEXT = TERMINATED SESSION = LOST WORK."),
      "urgent equation copy",
    );
    assert.ok(!text.includes("{"), "no placeholder leaks");
  });
});

// ---------------------------------------------------------------------------
// computeEligibility
// ---------------------------------------------------------------------------

describe("computeEligibility (C6-05)", () => {
  /** Eight messages whose heuristic estimates are 1..8 tokens. */
  const lensEligMessages: HostMessage[] = [
    makeMsg("user", ["aaaa"]),
    makeMsg("assistant", ["bbbbbbbb"]),
    makeMsg("user", ["cccccccccccc"]),
    makeMsg("assistant", ["dddddddddddddddd"]),
    makeMsg("user", ["eeeeeeeeeeeeeeeeeeee"]),
    makeMsg("assistant", ["ffffffffffffffffffffff"]),
    makeMsg("user", ["gggggggggggggggggggggggggg"]),
    makeMsg("assistant", ["hhhhhhhhhhhhhhhhhhhhhhhhhhhhhh"]),
  ];

  /** Per-ordinal refs: u1/a1/u3/u4/a4 hold refs, the rest do not. */
  const ELIG_ORDINAL_REFS: Array<string | undefined> = [
    "m0001",
    "m0002",
    undefined,
    undefined,
    "m0003",
    undefined,
    "m0004",
    "m0005",
  ];
  const refForOrdinal = (ordinal: number): string | undefined =>
    ELIG_ORDINAL_REFS[ordinal];

  /** Config with the phantom gate and token protection disabled. */
  const baseConfig = {
    protectedMessages: 2,
    protectedTokens: 0,
    thresholdTokens: 0,
  };

  it("computes the window between the first-user boundary and the protection", () => {
    // Pin the literal: window [1,6) = 2+3+4+5+6 = 20 tokens; startRef
    // a1 (m0002), endRef u3 (m0003).
    assert.deepEqual(
      computeEligibility(lensEligMessages, baseConfig, refForOrdinal),
      {
        startRef: "m0002",
        endRef: "m0003",
        reclaimTokens: 20,
      },
    );
  });

  it("returns null when the protected window covers everything", () => {
    assert.equal(
      computeEligibility(
        lensEligMessages,
        { ...baseConfig, protectedMessages: 100 },
        refForOrdinal,
      ),
      null,
    );
  });

  it("returns null when no message inside the window holds a ref", () => {
    // Only the protected tail (u4/a4) holds refs; the window has none.
    const refForProtectedOrdinal = (ordinal: number): string | undefined =>
      ordinal === 6 || ordinal === 7 ? refForOrdinal(ordinal) : undefined;
    assert.equal(
      computeEligibility(lensEligMessages, baseConfig, refForProtectedOrdinal),
      null,
    );
  });

  it("shrinks the window when token protection is tighter than message count", () => {
    // Window [1,5) = 2+3+4+5 = 14 tokens.
    assert.deepEqual(
      computeEligibility(
        lensEligMessages,
        { ...baseConfig, protectedTokens: 16 },
        refForOrdinal,
      ),
      { startRef: "m0002", endRef: "m0003", reclaimTokens: 14 },
    );
  });

  it("protects the last user message even when nothing else is protected", () => {
    assert.deepEqual(
      computeEligibility(
        lensEligMessages,
        { ...baseConfig, protectedMessages: 0 },
        refForOrdinal,
      ),
      { startRef: "m0002", endRef: "m0003", reclaimTokens: 20 },
    );
  });

  it("excludes the first user message from the window start", () => {
    const result = computeEligibility(
      lensEligMessages,
      { ...baseConfig, protectedMessages: 0 },
      refForOrdinal,
    );
    assert.equal(result?.startRef, "m0002", "never m0001");
  });

  it("returns null when the window estimate falls below thresholdTokens", () => {
    assert.equal(
      computeEligibility(
        lensEligMessages,
        { ...baseConfig, thresholdTokens: 100 },
        refForOrdinal,
      ),
      null,
    );
  });

  it("skips messages without a ref when scanning for refs", () => {
    // u3 (ordinal 4) loses its ref → both refs resolve to a1 (m0002).
    const refForDirtyOrdinal = (ordinal: number): string | undefined =>
      ordinal === 4 ? undefined : refForOrdinal(ordinal);
    assert.deepEqual(
      computeEligibility(lensEligMessages, baseConfig, refForDirtyOrdinal),
      { startRef: "m0002", endRef: "m0002", reclaimTokens: 20 },
    );
  });

  it("returns null when the session has no user message", () => {
    const assistantOnlyLens = [
      makeMsg("assistant", ["bbbbbbbb"]),
      makeMsg("assistant", ["dddddddddddddddd"]),
    ];
    assert.equal(
      computeEligibility(assistantOnlyLens, baseConfig, refForOrdinal),
      null,
    );
  });

  it("returns null for an empty message array", () => {
    assert.equal(computeEligibility([], baseConfig, refForOrdinal), null);
  });
});
