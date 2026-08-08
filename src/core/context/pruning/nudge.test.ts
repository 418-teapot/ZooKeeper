/**
 * Tests for the context-nudge pure decision layer.
 *
 * Covers: threshold resolution (mixed absolute/percentage configs, cap
 * clamping, malformed-input rejection), the single-anchor watermark
 * evaluation (first-eval silence, gentle/urgent intervals, frozen
 * silence, downward ratchet, wild fluctuation), and eligibility payload
 * computation (triple-protection window, first-user-message exclusion,
 * start/end refs, phantom-gate alignment).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ContextMessageEntry } from "../metrics.js";
import type { NudgeConfig, NudgeThresholds, PruneFoldConfig } from "./nudge.js";
import {
  computeEligibility,
  evaluateNudge,
  resolveThresholds,
} from "./nudge.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a message entry with a single text part.
 */
function msg(role: string, id: string, text: string): ContextMessageEntry {
  return {
    info: { role, id },
    parts: [{ type: "text", text }],
  };
}

// ---------------------------------------------------------------------------
// resolveThresholds
// ---------------------------------------------------------------------------

describe("resolveThresholds", () => {
  const baseConfig: NudgeConfig = {
    minContext: "60%",
    minContextCap: 200000,
    maxContext: "80%",
    maxContextCap: 300000,
    growthTokens: "5%",
  };

  it("resolves percentage thresholds across three context windows", () => {
    // 200K window: percentages resolve under the caps.
    assert.deepEqual(resolveThresholds(baseConfig, 200000), {
      min: 120000,
      max: 160000,
      growthTokens: 10000,
    });
    // 256K window: percentages resolve under the caps.
    assert.deepEqual(resolveThresholds(baseConfig, 256000), {
      min: 153600,
      max: 204800,
      growthTokens: 12800,
    });
    // 1M window: percentage resolution exceeds the caps — clamped.
    assert.deepEqual(resolveThresholds(baseConfig, 1000000), {
      min: 200000,
      max: 300000,
      growthTokens: 50000,
    });
  });

  it("clamps thresholds to their caps via min(cap, value)", () => {
    // Percentage resolving above the cap is clamped down.
    assert.deepEqual(
      resolveThresholds(
        {
          minContext: "80%",
          minContextCap: 100000,
          maxContext: "90%",
          maxContextCap: 150000,
          growthTokens: 5000,
        },
        200000,
      ),
      { min: 100000, max: 150000, growthTokens: 5000 },
    );
    // Absolute value above the cap is clamped down.
    assert.deepEqual(
      resolveThresholds(
        {
          minContext: 250000,
          minContextCap: 200000,
          maxContext: 400000,
          maxContextCap: 350000,
          growthTokens: 5000,
        },
        200000,
      ),
      { min: 200000, max: 350000, growthTokens: 5000 },
    );
  });

  it("mixes absolute and percentage values", () => {
    assert.deepEqual(
      resolveThresholds(
        {
          minContext: 100000,
          minContextCap: 200000,
          maxContext: "90%",
          maxContextCap: 300000,
          growthTokens: 6000,
        },
        200000,
      ),
      { min: 100000, max: 180000, growthTokens: 6000 },
    );
  });

  it("applies no cap to growthTokens", () => {
    assert.deepEqual(
      resolveThresholds(
        {
          minContext: "60%",
          minContextCap: 200000,
          maxContext: "80%",
          maxContextCap: 300000,
          growthTokens: 500000,
        },
        200000,
      ),
      { min: 120000, max: 160000, growthTokens: 500000 },
    );
  });

  it("rounds percentage-derived values to integers", () => {
    assert.deepEqual(
      resolveThresholds(
        {
          minContext: "33.333%",
          minContextCap: 100000,
          maxContext: 5000,
          maxContextCap: 100000,
          growthTokens: 1000,
        },
        10000,
      ),
      { min: 3333, max: 5000, growthTokens: 1000 },
    );
  });

  it("rejects malformed percentage strings in every position", () => {
    for (const bad of [
      "60",
      "abc%",
      "60%%",
      "%",
      "",
      "60 %",
      " 60%",
      "-50%",
      "60.5.5%",
    ]) {
      assert.equal(
        resolveThresholds(
          {
            minContext: bad,
            minContextCap: 200000,
            maxContext: "80%",
            maxContextCap: 300000,
            growthTokens: "5%",
          },
          200000,
        ),
        null,
        `minContext "${bad}" must be rejected`,
      );
      assert.equal(
        resolveThresholds(
          {
            minContext: "60%",
            minContextCap: 200000,
            maxContext: bad,
            maxContextCap: 300000,
            growthTokens: "5%",
          },
          200000,
        ),
        null,
        `maxContext "${bad}" must be rejected`,
      );
      assert.equal(
        resolveThresholds(
          {
            minContext: "60%",
            minContextCap: 200000,
            maxContext: "80%",
            maxContextCap: 300000,
            growthTokens: bad,
          },
          200000,
        ),
        null,
        `growthTokens "${bad}" must be rejected`,
      );
    }
  });

  it("rejects wrong-typed inputs", () => {
    const valid: NudgeConfig = {
      minContext: "60%",
      minContextCap: 200000,
      maxContext: "80%",
      maxContextCap: 300000,
      growthTokens: "5%",
    };
    const patches: Array<Partial<NudgeConfig>> = [
      { minContext: true as unknown as number },
      { minContext: null as unknown as number },
      { minContext: [] as unknown as number },
      { minContext: {} as unknown as number },
      { minContext: undefined as unknown as number },
      { minContextCap: "200000" as unknown as number },
      { minContextCap: NaN },
      { maxContext: true as unknown as number },
      { maxContextCap: NaN },
      { growthTokens: true as unknown as number },
      { growthTokens: null as unknown as number },
    ];
    for (const patch of patches) {
      assert.equal(
        resolveThresholds({ ...valid, ...patch }, 200000),
        null,
        `config patch ${JSON.stringify(patch)} must be rejected`,
      );
    }
  });

  it("rejects non-positive resolved values", () => {
    const valid: NudgeConfig = {
      minContext: "60%",
      minContextCap: 200000,
      maxContext: "80%",
      maxContextCap: 300000,
      growthTokens: "5%",
    };
    assert.equal(resolveThresholds({ ...valid, minContext: 0 }, 200000), null);
    assert.equal(
      resolveThresholds({ ...valid, minContext: "0%" }, 200000),
      null,
    );
    assert.equal(
      resolveThresholds({ ...valid, maxContext: -100 }, 200000),
      null,
    );
    assert.equal(
      resolveThresholds({ ...valid, growthTokens: 0 }, 200000),
      null,
    );
    assert.equal(
      resolveThresholds({ ...valid, growthTokens: -500 }, 200000),
      null,
    );
  });

  it("rejects min >= max after resolution", () => {
    // min above max directly.
    assert.equal(
      resolveThresholds(
        {
          minContext: "90%",
          minContextCap: 200000,
          maxContext: "80%",
          maxContextCap: 300000,
          growthTokens: "5%",
        },
        200000,
      ),
      null,
    );
    // Equal thresholds.
    assert.equal(
      resolveThresholds(
        {
          minContext: "80%",
          minContextCap: 200000,
          maxContext: "80%",
          maxContextCap: 200000,
          growthTokens: "5%",
        },
        200000,
      ),
      null,
    );
    // Cap clamping flips the order: min clamps high, max clamps low.
    assert.equal(
      resolveThresholds(
        {
          minContext: "90%",
          minContextCap: 200000,
          maxContext: "80%",
          maxContextCap: 150000,
          growthTokens: "5%",
        },
        200000,
      ),
      null,
    );
  });
});

// ---------------------------------------------------------------------------
// evaluateNudge
// ---------------------------------------------------------------------------

describe("evaluateNudge", () => {
  const thresholds: NudgeThresholds = {
    min: 120000,
    max: 160000,
    growthTokens: 5000,
  };

  it("first evaluation builds the baseline silently", () => {
    // Below both thresholds — no level, anchor at tokens.
    assert.deepEqual(evaluateNudge(undefined, 100000, thresholds), {
      level: null,
      newAnchor: 100000,
    });
    // Within the gentle band — level present but delta 0, so the first
    // eval never fires (existing-session silence).
    assert.deepEqual(evaluateNudge(undefined, 150000, thresholds), {
      level: null,
      newAnchor: 150000,
    });
    // At/above max — level urgent but the delta is still 0.
    assert.deepEqual(evaluateNudge(undefined, 200000, thresholds), {
      level: null,
      newAnchor: 200000,
    });
  });

  it("triggers gentle once growth passes the gentle interval", () => {
    // Baseline established at 100000, then +25000 >= growth 5000.
    assert.deepEqual(evaluateNudge(100000, 125000, thresholds), {
      level: "gentle",
      newAnchor: 125000,
    });
    // Exactly at the interval boundary — triggers.
    assert.deepEqual(evaluateNudge(120000, 125000, thresholds), {
      level: "gentle",
      newAnchor: 125000,
    });
  });

  it("does not trigger below the growth interval", () => {
    // Delta 4999 < 5000 — level present but no trigger; anchor unchanged.
    assert.deepEqual(evaluateNudge(120000, 124999, thresholds), {
      level: null,
      newAnchor: 120000,
    });
  });

  it("triggers urgent at half the growth interval", () => {
    // Baseline at 159000 (gentle band, no trigger on first eval).
    assert.deepEqual(evaluateNudge(undefined, 159000, thresholds), {
      level: null,
      newAnchor: 159000,
    });
    // Delta 3499: below full growth (5000) but above the halved urgent
    // interval (floor(5000 / 2) = 2500) — the halving makes it fire.
    assert.deepEqual(evaluateNudge(159000, 162499, thresholds), {
      level: "urgent",
      newAnchor: 162499,
    });
    // Delta 2499 < 2500 — no trigger.
    assert.deepEqual(evaluateNudge(159000, 161499, thresholds), {
      level: null,
      newAnchor: 159000,
    });
    // Exactly at the halved interval — triggers.
    assert.deepEqual(evaluateNudge(159000, 161500, thresholds), {
      level: "urgent",
      newAnchor: 161500,
    });
  });

  it("stays silent on frozen context (anchor already moved)", () => {
    // Repeated evaluation at the same tokens has delta 0 and never
    // re-triggers — the anchor is already at the current tokens.
    assert.deepEqual(evaluateNudge(150000, 150000, thresholds), {
      level: null,
      newAnchor: 150000,
    });
    assert.deepEqual(evaluateNudge(150000, 150000, thresholds), {
      level: null,
      newAnchor: 150000,
    });
    assert.deepEqual(evaluateNudge(125000, 125000, thresholds), {
      level: null,
      newAnchor: 125000,
    });
  });

  it("follows context downward after compression and re-accumulates", () => {
    // Compression drops tokens below the anchor — the anchor ratchets
    // down, no special branch.
    assert.deepEqual(evaluateNudge(150000, 80000, thresholds), {
      level: null,
      newAnchor: 80000,
    });
    // Growth re-accumulates from the lowered anchor — triggers again.
    assert.deepEqual(evaluateNudge(80000, 130000, thresholds), {
      level: "gentle",
      newAnchor: 130000,
    });
    // Frozen again after the trigger.
    assert.deepEqual(evaluateNudge(130000, 130000, thresholds), {
      level: null,
      newAnchor: 130000,
    });
    // The next growth interval re-accumulates from 130000.
    assert.deepEqual(evaluateNudge(130000, 135000, thresholds), {
      level: "gentle",
      newAnchor: 135000,
    });
  });

  it("behaves sanely under wild up-down-up fluctuation", () => {
    // Baseline.
    assert.deepEqual(evaluateNudge(undefined, 50000, thresholds), {
      level: null,
      newAnchor: 50000,
    });
    // Spike to urgent — huge delta, triggers.
    assert.deepEqual(evaluateNudge(50000, 200000, thresholds), {
      level: "urgent",
      newAnchor: 200000,
    });
    // Collapse below the anchor — anchor ratchets down, level null.
    assert.deepEqual(evaluateNudge(200000, 40000, thresholds), {
      level: null,
      newAnchor: 40000,
    });
    // Rebound — distance re-accumulated from the lowered anchor.
    assert.deepEqual(evaluateNudge(40000, 150000, thresholds), {
      level: "gentle",
      newAnchor: 150000,
    });
    // Dip below min — anchor follows down.
    assert.deepEqual(evaluateNudge(150000, 80000, thresholds), {
      level: null,
      newAnchor: 80000,
    });
    // Second spike to urgent — triggers from the low anchor.
    assert.deepEqual(evaluateNudge(80000, 165000, thresholds), {
      level: "urgent",
      newAnchor: 165000,
    });
    // Small downward wobble from the spike — anchor eases down, silent.
    assert.deepEqual(evaluateNudge(165000, 163000, thresholds), {
      level: null,
      newAnchor: 163000,
    });
  });
});

// ---------------------------------------------------------------------------
// computeEligibility
// ---------------------------------------------------------------------------

describe("computeEligibility", () => {
  const messages: ContextMessageEntry[] = [
    msg("user", "u1", "aaaa"), // 1 token
    msg("assistant", "a1", "bbbbbbbb"), // 2
    msg("user", "u2", "cccccccccccc"), // 3
    msg("assistant", "a2", "dddddddddddddddd"), // 4
    msg("user", "u3", "eeeeeeeeeeeeeeeeeeee"), // 5
    msg("assistant", "a3", "ffffffffffffffffffffff"), // 6
    msg("user", "u4", "gggggggggggggggggggggggggg"), // 7
    msg("assistant", "a4", "hhhhhhhhhhhhhhhhhhhhhhhhhhhhhh"), // 8
  ];
  const refs = new Map<string, string>([
    ["u1", "m0001"],
    ["a1", "m0002"],
    ["u3", "m0003"],
    ["u4", "m0004"],
    ["a4", "m0005"],
  ]);
  const refFor = (id: string): string | undefined => refs.get(id);

  /** Config with the phantom gate and token protection disabled. */
  const baseConfig: PruneFoldConfig = {
    protectedMessages: 2,
    protectedTokens: 0,
    thresholdTokens: 0,
  };

  it("computes the window between the first-user boundary and the triple protection", () => {
    // protectedMessages=2 → boundary 6; last user at 6; no token cap →
    // window [1, 6): a1..a3 = 2+3+4+5+6 = 20 tokens.  startRef = a1
    // (first ref ≥ 1), endRef = u3 (last ref < 6).
    const result = computeEligibility(messages, baseConfig, refFor);
    assert.deepEqual(result, {
      startRef: "m0002",
      endRef: "m0003",
      reclaimTokens: 20,
    });
  });

  it("returns null when the protected window covers everything", () => {
    // protectedMessages=100 > 8 → boundary 0 → empty window.
    assert.equal(
      computeEligibility(
        messages,
        { ...baseConfig, protectedMessages: 100 },
        refFor,
      ),
      null,
    );
  });

  it("returns null when no message inside the window holds a ref", () => {
    // Only protected messages (u4/a4) hold refs; the window [1,6) has none.
    const refForProtected = (id: string): string | undefined =>
      id === "u4" || id === "a4" ? refs.get(id) : undefined;
    assert.equal(
      computeEligibility(messages, baseConfig, refForProtected),
      null,
    );
  });

  it("shrinks the window when token protection is tighter than message count", () => {
    // protectedMessages=2 → boundary 6; protectedTokens=16 accumulates
    // from the end (8+7+6 = 21 ≥ 16) → token boundary 5 → window [1,5)
    // = 2+3+4+5 = 14 tokens.
    const result = computeEligibility(
      messages,
      { ...baseConfig, protectedTokens: 16 },
      refFor,
    );
    assert.deepEqual(result, {
      startRef: "m0002",
      endRef: "m0003",
      reclaimTokens: 14,
    });
  });

  it("protects the last user message even when nothing else is protected", () => {
    // Nothing protected by message count or tokens → the boundary would
    // be 8, but the last user message (u4 at index 6) caps the window at
    // 6 — without it the window would be [1,8) = 35 tokens, endRef m0005.
    const result = computeEligibility(
      messages,
      { ...baseConfig, protectedMessages: 0 },
      refFor,
    );
    assert.deepEqual(result, {
      startRef: "m0002",
      endRef: "m0003",
      reclaimTokens: 20,
    });
  });

  it("excludes the first user message from the window start", () => {
    // u1 (m0001) is never compressible — the window starts at index 1,
    // so startRef is a1 (m0002), never m0001 (without the exclusion the
    // window would be [0,6) = 21 tokens, startRef m0001).
    const result = computeEligibility(
      messages,
      { ...baseConfig, protectedMessages: 0 },
      refFor,
    );
    assert.equal(result?.startRef, "m0002");
    assert.equal(result?.endRef, "m0003");
    assert.equal(result?.reclaimTokens, 20);
  });

  it("returns null when the window estimate falls below thresholdTokens", () => {
    // Window [1,6) = 20 tokens < 100 → phantom gate → null.
    assert.equal(
      computeEligibility(
        messages,
        { ...baseConfig, thresholdTokens: 100 },
        refFor,
      ),
      null,
    );
  });

  it("skips messages without an id when scanning for refs", () => {
    const messages2 = [...messages];
    messages2[4] = {
      info: { role: "user" },
      parts: [{ type: "text", text: "eeeeeeeeeeeeeeeeeeee" }],
    } as unknown as ContextMessageEntry;
    // u3 lost its id → startRef and endRef both resolve to a1 (m0002).
    const result = computeEligibility(messages2, baseConfig, refFor);
    assert.deepEqual(result, {
      startRef: "m0002",
      endRef: "m0002",
      reclaimTokens: 20,
    });
  });

  it("returns null when the session has no user message", () => {
    const assistantOnly = [
      msg("assistant", "a1", "bbbbbbbb"),
      msg("assistant", "a2", "dddddddddddddddd"),
    ];
    assert.equal(computeEligibility(assistantOnly, baseConfig, refFor), null);
  });

  it("returns null for an empty message array", () => {
    assert.equal(computeEligibility([], baseConfig, refFor), null);
  });
});
