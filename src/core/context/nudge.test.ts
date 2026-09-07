/**
 * Tests for the lens-based nudge module (`nudge.ts`).
 *
 * Lens-specific behavior:
 *   - threshold resolution across percentage, absolute, mixed, and
 *     malformed inputs,
 *   - nudge evaluation trigger boundaries ±1 token and the
 *     single-anchor watermark transitions,
 *   - the gates (completed assistant, absent / invalid config, empty
 *     eligible window) and watermark persistence,
 *   - the reminder text assembled from the shared templates,
 *   - the eligibility window computed over the folded, numbered view —
 *     refs and reclaim live in the `mN` address space the model holds,
 *     and a folded interval contributes no reclaim,
 *   - the reclaim credit: a compression's reclaim discounts the measured
 *     water level immediately and is consumed by the next real
 *     measurement, never subtracted twice.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { COMPRESS_USAGE_POINTER } from "../prompts.js";
import type { BlockSpan, HostMessage, ViewItem } from "./lens.js";
import { makeMsg } from "./lens-testkit.js";
import {
  computeEligibility,
  creditReclaim,
  evaluateNudge,
  type NudgeConfig,
  type NudgeInjectOptions,
  readLevel,
} from "./nudge.js";
import type { SessionState } from "./state.js";
import type { NumberedItem } from "./view-refs.js";
import { numberView } from "./view-refs.js";

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
 * Build this round's numbered view over a transcript.
 *
 * `items` defaults to the unfolded view (one line per message), so a
 * test only names the fold when the folded coordinate system is what it
 * is exercising.  Numbering runs through the production `numberView`, so
 * hidden messages occupy no line exactly as they do in the render.
 */
function numberedOf(
  messages: HostMessage[],
  items: ViewItem[] = messages.map((_, ordinal) => ({
    type: "original" as const,
    ordinal,
  })),
): NumberedItem[] {
  return numberView(items, (ordinal) => messages[ordinal].hidden);
}

/** A summary item folding `[start, end)` of the transcript. */
function summaryItem(start: number, end: number): ViewItem {
  const block: BlockSpan = {
    start,
    end,
    title: "folded",
    summary: "already folded into a summary.",
  };
  return { type: "summary", block };
}

/**
 * Context inputs for the parity evaluations: a non-empty eligible window
 * whenever a level fires (no protection, no phantom gate, refs present).
 */
function parityOpts(messages: HostMessage[]): NudgeInjectOptions {
  return {
    contextLimit: 200000,
    protectedMessages: 0,
    protectedTokens: 0,
    thresholdTokens: 0,
    numbered: numberedOf(messages),
  };
}

/** Injection options for the standalone lens tests over an unfolded view. */
function injectOpts(messages: HostMessage[]): NudgeInjectOptions {
  return {
    contextLimit: 200000,
    protectedMessages: 2,
    protectedTokens: 0,
    thresholdTokens: 0,
    numbered: numberedOf(messages),
  };
}

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
  it("skips when no completed assistant exists — watermark untouched", () => {
    const streaming = [
      makeMsg("user", ["hello"]),
      makeMsg("assistant", ["streaming"], { usage: { output: 0 } }),
    ];
    const state = makeNewState(140000);
    const text = evaluateNudge(
      state,
      streaming,
      NUDGE_CONFIG,
      parityOpts(streaming),
    );
    assert.equal(text, null, "nudge skipped");
    assert.equal(state.nudges?.lastNudgeTokens, 140000, "watermark untouched");
  });

  it("returns null and leaves the watermark untouched for an absent config", () => {
    const messages = lensNudgeMessages(150000);
    const state = makeNewState(140000);
    const text = evaluateNudge(state, messages, undefined, {
      ...parityOpts(messages),
    });
    assert.equal(text, null);
    assert.equal(state.nudges?.lastNudgeTokens, 140000, "watermark untouched");
  });

  it("returns null and leaves the watermark untouched for an invalid config", () => {
    const inverted: NudgeConfig = { ...NUDGE_CONFIG, minContext: "90%" };
    const malformed: NudgeConfig = { ...NUDGE_CONFIG, growthTokens: "5" };
    for (const config of [inverted, malformed]) {
      const messages = lensNudgeMessages(150000);
      const state = makeNewState(140000);
      const text = evaluateNudge(state, messages, config, {
        ...parityOpts(messages),
      });
      assert.equal(text, null);
      assert.equal(state.nudges?.lastNudgeTokens, 140000);
    }
  });

  it("persists the anchor but injects nothing when no window is eligible", () => {
    // protectedMessages covers the whole view → empty window.
    const state = makeNewState();
    const opts = (messages: HostMessage[]): NudgeInjectOptions => ({
      ...injectOpts(messages),
      protectedMessages: 100,
    });
    assert.equal(
      evaluateNudge(
        state,
        lensNudgeMessages(140000),
        NUDGE_CONFIG,
        opts(lensNudgeMessages(140000)),
      ),
      null,
    );
    const grown = lensNudgeMessages(150000);
    const text = evaluateNudge(state, grown, NUDGE_CONFIG, opts(grown));
    assert.equal(text, null, "no text without an eligible window");
    assert.equal(
      state.nudges?.lastNudgeTokens,
      150000,
      "anchor still persisted",
    );
  });

  it("keeps the text-only assistant gate (no usage at all)", () => {
    // A text-only assistant without usage is not completed either.
    const plain = [makeMsg("user", ["hello"]), makeMsg("assistant", ["ok"])];
    const state = makeNewState(140000);
    const text2 = evaluateNudge(state, plain, NUDGE_CONFIG, {
      ...parityOpts(plain),
    });
    assert.equal(text2, null);
    assert.equal(state.nudges?.lastNudgeTokens, 140000);
  });
});

// ---------------------------------------------------------------------------
// Nudge text assembly
// ---------------------------------------------------------------------------

describe("nudge text assembly", () => {
  it("assembles the gentle reminder from the shared templates", () => {
    const state = makeNewState();
    const baseline = lensNudgeMessages(140000);
    assert.equal(
      evaluateNudge(state, baseline, NUDGE_CONFIG, injectOpts(baseline)),
      null,
      "baseline injects nothing",
    );
    const grown = lensNudgeMessages(150000);
    const text = evaluateNudge(state, grown, NUDGE_CONFIG, injectOpts(grown));
    assert.ok(text !== null, "gentle fires");
    assert.ok(text.startsWith("<internal-reminder>"), "wrapper opens");
    assert.ok(text.endsWith("</internal-reminder>"), "wrapper closes");
    assert.ok(
      text.includes("**CONTEXT GROWING — 150000 (75% of 200000 window)**"),
      "gentle header with tokens and percent",
    );
    // The window is the single line between the first user message and
    // the protection boundary — a1's dense line 2, ~4 tokens.
    assert.ok(
      text.includes(
        "Compressible window: m2–m2 (~4 tokens), both refs inclusive.",
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
    assert.ok(text.includes(COMPRESS_USAGE_POINTER), "teaching slot filled");
    assert.ok(!text.includes("{"), "no placeholder leaks");
  });

  it("assembles the urgent reminder from the shared templates", () => {
    const state = makeNewState();
    const baseline = lensNudgeMessages(140000);
    evaluateNudge(state, baseline, NUDGE_CONFIG, injectOpts(baseline));
    const urgent = lensNudgeMessages(165000);
    const text = evaluateNudge(state, urgent, NUDGE_CONFIG, injectOpts(urgent));
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
// computeEligibility — the window over the folded, numbered view
// ---------------------------------------------------------------------------

describe("computeEligibility", () => {
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

  /** Config with the phantom gate and token protection disabled. */
  const baseConfig = {
    protectedMessages: 2,
    protectedTokens: 0,
    thresholdTokens: 0,
  };

  it("computes the window between the first-user boundary and the protection", () => {
    // Unfolded view: one line per message, so the window is lines m2..m6
    // (ordinals 1..5) = 2+3+4+5+6 = 20 tokens.
    assert.deepEqual(
      computeEligibility(
        lensEligMessages,
        numberedOf(lensEligMessages),
        baseConfig,
      ),
      {
        startRef: "m2",
        endRef: "m6",
        reclaimTokens: 20,
      },
    );
  });

  it("returns null when the protected window covers everything", () => {
    assert.equal(
      computeEligibility(lensEligMessages, numberedOf(lensEligMessages), {
        ...baseConfig,
        protectedMessages: 100,
      }),
      null,
    );
  });

  it("returns null when the window is empty after renumbering", () => {
    // The whole window sits inside one folded block and the protection
    // boundary cuts it off: no line is left inside the window.
    const items: ViewItem[] = [
      { type: "original", ordinal: 0 },
      summaryItem(1, 6),
      { type: "original", ordinal: 6 },
      { type: "original", ordinal: 7 },
    ];
    assert.equal(
      computeEligibility(
        lensEligMessages,
        numberedOf(lensEligMessages, items),
        { ...baseConfig, protectedMessages: 100 },
      ),
      null,
    );
  });

  it("shrinks the window when token protection is tighter than message count", () => {
    // Boundary ordinal 5 (the trailing 16 tokens reach the 16-token
    // budget) → window lines m2..m5 = 2+3+4+5 = 14 tokens.
    assert.deepEqual(
      computeEligibility(lensEligMessages, numberedOf(lensEligMessages), {
        ...baseConfig,
        protectedTokens: 16,
      }),
      { startRef: "m2", endRef: "m5", reclaimTokens: 14 },
    );
  });

  it("protects the last user message even when nothing else is protected", () => {
    assert.deepEqual(
      computeEligibility(lensEligMessages, numberedOf(lensEligMessages), {
        ...baseConfig,
        protectedMessages: 0,
      }),
      { startRef: "m2", endRef: "m6", reclaimTokens: 20 },
    );
  });

  it("excludes the first user message from the window start", () => {
    const result = computeEligibility(
      lensEligMessages,
      numberedOf(lensEligMessages),
      { ...baseConfig, protectedMessages: 0 },
    );
    assert.equal(result?.startRef, "m2", "never m1");
  });

  it("returns null when the window estimate falls below thresholdTokens", () => {
    assert.equal(
      computeEligibility(lensEligMessages, numberedOf(lensEligMessages), {
        ...baseConfig,
        thresholdTokens: 100,
      }),
      null,
    );
  });

  it("gives no line (and no ref) to a hidden message inside the window", () => {
    // Ordinal 5 is hidden: it occupies no line, so the window's last ref
    // is the line before it while the hidden message adds no reclaim.
    const dirty = [...lensEligMessages];
    dirty[5] = makeMsg("assistant", ["ffffffffffffffffffffff"], {
      hidden: true,
    });
    assert.deepEqual(
      computeEligibility(dirty, numberedOf(dirty), {
        ...baseConfig,
        protectedMessages: 0,
      }),
      { startRef: "m2", endRef: "m5", reclaimTokens: 14 },
    );
  });

  it("excludes a folded interval from the reclaim estimate", () => {
    // Ordinals 1..5 are folded into one summary line, so the window is
    // that line plus nothing else: the folded tokens are already spent
    // and the whole window frees nothing new → silent.
    const items: ViewItem[] = [
      { type: "original", ordinal: 0 },
      summaryItem(1, 6),
      { type: "original", ordinal: 6 },
      { type: "original", ordinal: 7 },
    ];
    assert.equal(
      computeEligibility(
        lensEligMessages,
        numberedOf(lensEligMessages, items),
        baseConfig,
      ),
      null,
    );
  });

  it("addresses a folded line but counts only its uncompressed neighbours", () => {
    // Ordinals 1..3 are folded; the window is the summary line (m2) plus
    // ordinals 4 and 5 (m3, m4), so reclaim is 5+6 = 11 while the window
    // still starts at the summary's ref — the address the model holds.
    const items: ViewItem[] = [
      { type: "original", ordinal: 0 },
      summaryItem(1, 4),
      { type: "original", ordinal: 4 },
      { type: "original", ordinal: 5 },
      { type: "original", ordinal: 6 },
      { type: "original", ordinal: 7 },
    ];
    assert.deepEqual(
      computeEligibility(
        lensEligMessages,
        numberedOf(lensEligMessages, items),
        baseConfig,
      ),
      { startRef: "m2", endRef: "m4", reclaimTokens: 11 },
    );
  });

  it("keeps a summary straddling the protection boundary out of the window", () => {
    // The block covers ordinals 1..6, i.e. it reaches past the boundary
    // (ordinal 6), and `compress` would reject it as reaching into the
    // protected tail — so the window ends at the line before it.
    const items: ViewItem[] = [
      { type: "original", ordinal: 0 },
      summaryItem(1, 7),
    ];
    assert.equal(
      computeEligibility(
        lensEligMessages,
        numberedOf(lensEligMessages, items),
        baseConfig,
      ),
      null,
    );
  });

  it("numbers the window in the folded view, not in transcript ordinals", () => {
    // Folding 20 messages of the tail into one line pulls the window's
    // last ref far below the ordinal it would address unfolded.
    const many: HostMessage[] = [];
    many.push(makeMsg("user", ["aaaa"]));
    for (let i = 1; i < 21; i++) {
      many.push(makeMsg("assistant", ["x".repeat(i * 4)]));
    }
    many.push(makeMsg("user", ["gggggggggggggggggggggggggg"]));
    many.push(makeMsg("assistant", ["hhhhhhhhhhhhhhhhhhhhhhhhhhhhhh"]));
    const unfolded = numberedOf(many);
    const foldedItems: ViewItem[] = [
      { type: "original", ordinal: 0 },
      { type: "original", ordinal: 1 },
      summaryItem(2, 21),
      { type: "original", ordinal: 21 },
      { type: "original", ordinal: 22 },
    ];
    const folded = numberedOf(many, foldedItems);
    const cfg = { ...baseConfig, protectedMessages: 0 };

    const before = computeEligibility(many, unfolded, cfg);
    const after = computeEligibility(many, folded, cfg);
    assert.ok(before && after, "both windows eligible");
    // Unfolded the window ends at the line addressing ordinal 19; folded
    // the same content is one summary line, so the end ref is m3 and the
    // 18 folded messages contribute no reclaim.
    assert.equal(after.startRef, "m2");
    assert.equal(after.endRef, "m3");
    assert.ok(
      (after?.reclaimTokens ?? 0) < (before?.reclaimTokens ?? 0),
      "folded content is not billed as reclaim again",
    );
  });

  it("returns null when the session has no user message", () => {
    const assistantOnly = [
      makeMsg("assistant", ["bbbbbbbb"]),
      makeMsg("assistant", ["dddddddddddddddd"]),
    ];
    assert.equal(
      computeEligibility(assistantOnly, numberedOf(assistantOnly), baseConfig),
      null,
    );
  });

  it("returns null for an empty message array", () => {
    assert.equal(computeEligibility([], [], baseConfig), null);
  });
});

// ---------------------------------------------------------------------------
// Reclaim credit — the measured level follows the view immediately
// ---------------------------------------------------------------------------

describe("reclaim credit (water level)", () => {
  /** A view whose measured prompt-side total is `measured`. */
  function viewAt(measured: number): HostMessage[] {
    return lensNudgeMessages(measured);
  }

  it("books positive reclaims and accumulates repeated compressions", () => {
    const state = makeNewState();
    creditReclaim(state, 100);
    creditReclaim(state, 40);
    assert.equal(state.nudges?.pendingReclaimTokens, 140);

    // Non-positive and non-finite bookings are no-ops.
    creditReclaim(state, 0);
    creditReclaim(state, -5);
    creditReclaim(state, Number.NaN);
    assert.equal(state.nudges?.pendingReclaimTokens, 140);
  });

  it("drops the water level the moment the reclaim lands", () => {
    const state = makeNewState(150000);
    creditReclaim(state, 40000);
    // Measured usage still says 150K; the booked reclaim is what the
    // view actually costs, and it is below the gentle threshold (120K).
    assert.equal(readLevel(state, 150000), 110000, "pure read discounts");
    assert.equal(state.nudges?.pendingReclaimTokens, 40000, "read is pure");

    const text = evaluateNudge(
      state,
      viewAt(150000),
      NUDGE_CONFIG,
      parityOpts(viewAt(150000)),
    );
    assert.equal(text, null, "no nudge once the level drops below the band");
    assert.equal(
      state.nudges?.lastNudgeTokens,
      110000,
      "watermark follows the level down at once",
    );
  });

  it("keeps the discount while the measurement is the same one", () => {
    const state = makeNewState(150000);
    creditReclaim(state, 40000);
    evaluateNudge(state, viewAt(150000), NUDGE_CONFIG, {
      ...parityOpts(viewAt(150000)),
    });
    assert.equal(state.nudges?.reclaimMeasurement, 150000, "anchored");

    // Another transform of the same round reads the same stale usage —
    // still not billed, so the discount still applies.
    assert.equal(readLevel(state, 150000), 110000);
    assert.equal(state.nudges?.pendingReclaimTokens, 40000, "still booked");
  });

  it("consumes the credit once a newer measurement reflects the reclaim", () => {
    const state = makeNewState(150000);
    creditReclaim(state, 40000);
    evaluateNudge(state, viewAt(150000), NUDGE_CONFIG, {
      ...parityOpts(viewAt(150000)),
    });
    assert.equal(state.nudges?.lastNudgeTokens, 110000);

    // The next API call is billed against the compressed view: its
    // measurement already includes the reclaim, so subtracting the
    // credit again would double-count it.
    const later = viewAt(111000);
    evaluateNudge(state, later, NUDGE_CONFIG, parityOpts(later));
    assert.equal(
      state.nudges?.pendingReclaimTokens,
      undefined,
      "credit consumed",
    );
    assert.equal(state.nudges?.reclaimMeasurement, undefined);
    assert.equal(
      state.nudges?.lastNudgeTokens,
      110000,
      "anchor ratchets on the measured value, not measured minus credit",
    );

    // Growth measured from the same baseline still re-triggers: the
    // anchor sits at the post-compression level (min 120K, interval 10K).
    const grown = viewAt(130000);
    assert.ok(
      evaluateNudge(state, grown, NUDGE_CONFIG, parityOpts(grown)) !== null,
      "nudge fires on real growth after the credit was consumed",
    );
    assert.equal(state.nudges?.lastNudgeTokens, 130000);
  });

  it("reports the discounted level in the reminder text", () => {
    const state = makeNewState(140000);
    creditReclaim(state, 10000);
    // Measured 150K − credited 10K = 140K level: no growth over the
    // anchor, so nothing fires while the credit holds.
    const same = viewAt(150000);
    assert.equal(
      evaluateNudge(state, same, NUDGE_CONFIG, parityOpts(same)),
      null,
      "discounted level matches the anchor",
    );

    // A measurement that moves off the credited one consumes the credit,
    // so the next evaluation reports the measured value itself.
    const later = viewAt(155000);
    const text = evaluateNudge(state, later, NUDGE_CONFIG, parityOpts(later));
    assert.ok(text !== null, "gentle fires 15K above the anchor");
    assert.ok(
      text.includes("**CONTEXT GROWING — 155000 (78% of 200000 window)**"),
      "header carries the level with no double subtraction",
    );
  });

  it("never lets the discount report a negative level", () => {
    const state = makeNewState(150000);
    creditReclaim(state, 400000);
    const messages = viewAt(150000);
    assert.equal(readLevel(state, 150000), 0);
    assert.equal(
      evaluateNudge(state, messages, NUDGE_CONFIG, parityOpts(messages)),
      null,
      "a level of 0 is below every threshold",
    );
    assert.equal(state.nudges?.lastNudgeTokens, 0);
  });
});
