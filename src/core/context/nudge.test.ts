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
import { makeMsg, makeState } from "../../testkits/context.js";
import { COMPRESS_USAGE_POINTER } from "../prompts.js";
import type { BlockSpan, HostMessage, ViewItem } from "./lens.js";
import {
  computeEligibility,
  creditReclaim,
  type EligibilityConfig,
  evaluateNudge,
  type NudgeConfig,
  type NudgeInjectOptions,
  readLevel,
} from "./nudge.js";
import { buildProtectionMap } from "./protection-map.js";
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
    start: ordinal,
    end: ordinal + 1,
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
    protection: buildProtectionMap(messages, 0, 0),
    thresholdTokens: 0,
    numbered: numberedOf(messages),
  };
}

/** Injection options for the standalone lens tests over an unfolded view. */
function injectOpts(messages: HostMessage[]): NudgeInjectOptions {
  return {
    contextLimit: 200000,
    protection: buildProtectionMap(messages, 2, 0),
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

// ---------------------------------------------------------------------------
// evaluateNudge — gates and watermark persistence
// ---------------------------------------------------------------------------

describe("evaluateNudge gates", () => {
  it("skips when no completed assistant exists — watermark untouched", () => {
    const streaming = [
      makeMsg("user", ["hello"]),
      makeMsg("assistant", ["streaming"], { usage: { output: 0 } }),
    ];
    const state = makeState(140000);
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
    const state = makeState(140000);
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
      const state = makeState(140000);
      const text = evaluateNudge(state, messages, config, {
        ...parityOpts(messages),
      });
      assert.equal(text, null);
      assert.equal(state.nudges?.lastNudgeTokens, 140000);
    }
  });

  it("persists the anchor but injects nothing when no window is eligible", () => {
    // activeMessages covers the whole view → empty window.
    const state = makeState();
    const opts = (messages: HostMessage[]): NudgeInjectOptions => ({
      ...injectOpts(messages),
      protection: buildProtectionMap(messages, 100, 0),
    });
    assert.equal(
      evaluateNudge(
        state,
        lensNudgeMessages(140000),
        NUDGE_CONFIG,
        opts(lensNudgeMessages(140000)),
      )?.text,
      null,
    );
    const grown = lensNudgeMessages(150000);
    const decision = evaluateNudge(state, grown, NUDGE_CONFIG, opts(grown));
    assert.equal(decision?.text, null, "no text without an eligible window");
    assert.equal(
      state.nudges?.lastNudgeTokens,
      150000,
      "anchor still persisted",
    );
  });

  it("persists the anchor but injects nothing when a layer is unconfigured", () => {
    const state = makeState();
    const opts = (messages: HostMessage[]): NudgeInjectOptions => ({
      ...injectOpts(messages),
      protection: undefined,
    });
    evaluateNudge(
      state,
      lensNudgeMessages(140000),
      NUDGE_CONFIG,
      opts(lensNudgeMessages(140000)),
    );
    const grown = lensNudgeMessages(150000);
    assert.equal(
      evaluateNudge(state, grown, NUDGE_CONFIG, opts(grown))?.text,
      null,
      "no window → no injection",
    );
    assert.equal(
      state.nudges?.lastNudgeTokens,
      150000,
      "anchor still persisted",
    );
  });

  it("keeps the text-only assistant gate (no usage at all)", () => {
    // A text-only assistant without usage is not completed either.
    const plain = [makeMsg("user", ["hello"]), makeMsg("assistant", ["ok"])];
    const state = makeState(140000);
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
    const state = makeState();
    const baseline = lensNudgeMessages(140000);
    assert.equal(
      evaluateNudge(state, baseline, NUDGE_CONFIG, injectOpts(baseline))?.text,
      null,
      "baseline injects nothing",
    );
    const grown = lensNudgeMessages(150000);
    const decision = evaluateNudge(
      state,
      grown,
      NUDGE_CONFIG,
      injectOpts(grown),
    );
    const text = decision?.text ?? null;
    assert.ok(text !== null, "gentle fires");
    assert.ok(text.startsWith("<internal-reminder>"), "wrapper opens");
    assert.ok(text.endsWith("</internal-reminder>"), "wrapper closes");
    assert.ok(
      text.includes("**CONTEXT GROWING — 150000 (75% of 200000 window)**"),
      "gentle header with tokens and percent",
    );
    // The window is the single line between the first instruction and
    // the active tail — a1's dense line 2, ~4 tokens.
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
    const state = makeState();
    const baseline = lensNudgeMessages(140000);
    evaluateNudge(state, baseline, NUDGE_CONFIG, injectOpts(baseline));
    const urgent = lensNudgeMessages(165000);
    const decision = evaluateNudge(
      state,
      urgent,
      NUDGE_CONFIG,
      injectOpts(urgent),
    );
    const text = decision?.text ?? null;
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

  /** The fixture transcript's unfolded view, one line per message. */
  const lensEligNumbered = numberedOf(lensEligMessages);

  /** Protection map of the fixture: a 2-message tail, no token tail. */
  const lensEligProtection = buildProtectionMap(lensEligMessages, 2, 0);

  /** Gate config with the phantom threshold disabled. */
  const gate: EligibilityConfig = { thresholdTokens: 0 };

  /**
   * A transcript whose earlier work segment frees 100 tokens and whose
   * later one frees 10, split by a middle instruction and followed by a
   * two-message active tail.
   */
  function bigThenSmall(): HostMessage[] {
    return [
      makeMsg("user", ["instruction"]),
      makeMsg("assistant", ["x".repeat(400)]),
      makeMsg("user", ["middle instruction"]),
      makeMsg("assistant", ["y".repeat(40)]),
      makeMsg("assistant", ["tail one"]),
      makeMsg("assistant", ["tail two"]),
    ];
  }

  it("returns null when the protection map is absent", () => {
    assert.equal(
      computeEligibility(undefined, lensEligMessages, lensEligNumbered, gate),
      null,
      "an absent protection map fails closed",
    );
  });

  it("returns null when the phantom threshold is unconfigured", () => {
    assert.equal(
      computeEligibility(
        lensEligProtection,
        lensEligMessages,
        lensEligNumbered,
        {},
      ),
      null,
      "an unconfigured threshold fails closed",
    );
  });

  it("advertises the highest-reclaim work segment", () => {
    // Active tail starts at ordinal 6.  Instructions cut the work at
    // ordinals 0, 2 and 4, leaving the runs m2 (2 tokens), m4 (4) and
    // m6 (6): the assistant at ordinal 5 frees the most.
    assert.deepEqual(
      computeEligibility(
        lensEligProtection,
        lensEligMessages,
        lensEligNumbered,
        gate,
      ),
      {
        startRef: "m6",
        endRef: "m6",
        reclaimTokens: 6,
      },
    );
  });

  it("advertises the earlier segment when it frees more tokens", () => {
    // Both segments clear the phantom gate, and the earlier one frees ten
    // times more than the later one, so view order does not decide.
    const history = bigThenSmall();
    assert.deepEqual(
      computeEligibility(
        buildProtectionMap(history, 2, 0),
        history,
        numberedOf(history),
        gate,
      ),
      { startRef: "m2", endRef: "m2", reclaimTokens: 100 },
    );
  });

  it("advertises the later segment when both free the same tokens", () => {
    // A tie goes to the newer segment: m4 sits closer to the active tail.
    const history = bigThenSmall();
    history[3] = makeMsg("assistant", ["z".repeat(400)]);
    assert.deepEqual(
      computeEligibility(
        buildProtectionMap(history, 2, 0),
        history,
        numberedOf(history),
        gate,
      ),
      { startRef: "m4", endRef: "m4", reclaimTokens: 100 },
    );
  });

  it("skips a segment below the phantom threshold", () => {
    // The later segment frees 10 tokens, below the 50-token gate, so it
    // does not compete with the 100-token segment.
    const history = bigThenSmall();
    assert.deepEqual(
      computeEligibility(
        buildProtectionMap(history, 2, 0),
        history,
        numberedOf(history),
        { thresholdTokens: 50 },
      ),
      { startRef: "m2", endRef: "m2", reclaimTokens: 100 },
    );
  });

  it("returns null when the protected window covers everything", () => {
    assert.equal(
      computeEligibility(
        buildProtectionMap(lensEligMessages, 100, 0),
        lensEligMessages,
        lensEligNumbered,
        gate,
      ),
      null,
    );
  });

  it("returns null when the window is empty after renumbering", () => {
    // The whole window sits inside one folded block and the protection
    // boundary cuts it off: no line is left inside the window.
    const items: ViewItem[] = [
      { type: "original", start: 0, end: 1 },
      summaryItem(1, 6),
      { type: "original", start: 6, end: 7 },
      { type: "original", start: 7, end: 8 },
    ];
    assert.equal(
      computeEligibility(
        buildProtectionMap(lensEligMessages, 100, 0),
        lensEligMessages,
        numberedOf(lensEligMessages, items),
        gate,
      ),
      null,
    );
  });

  it("shrinks the window when token protection is tighter than message count", () => {
    // The 16-token budget reaches ordinal 5, so the active tail starts
    // there.  The last work segment is the assistant at ordinal 3 — dense
    // line m4, 4 heuristic tokens.
    assert.deepEqual(
      computeEligibility(
        buildProtectionMap(lensEligMessages, 2, 16),
        lensEligMessages,
        lensEligNumbered,
        gate,
      ),
      { startRef: "m4", endRef: "m4", reclaimTokens: 4 },
    );
  });

  it("does not protect a suffix after the last user instruction", () => {
    // Nothing is protected but the instructions: the work after the last
    // instruction is still compressible, so the freshest run is m8.
    assert.deepEqual(
      computeEligibility(
        buildProtectionMap(lensEligMessages, 0, 0),
        lensEligMessages,
        lensEligNumbered,
        gate,
      ),
      { startRef: "m8", endRef: "m8", reclaimTokens: 8 },
    );
  });

  it("never advertises a user instruction", () => {
    const result = computeEligibility(
      buildProtectionMap(lensEligMessages, 0, 0),
      lensEligMessages,
      lensEligNumbered,
      gate,
    );
    assert.equal(result?.startRef, "m8", "never an instruction line");
  });

  it("returns null when the window estimate falls below thresholdTokens", () => {
    assert.equal(
      computeEligibility(
        lensEligProtection,
        lensEligMessages,
        lensEligNumbered,
        { thresholdTokens: 100 },
      ),
      null,
    );
  });

  it("gives no line (and no ref) to a hidden message inside the window", () => {
    // Ordinal 5 is hidden: it occupies no line, so the final work segment
    // after the last instruction starts at ordinal 6 and keeps its own
    // ref, while the hidden message adds no reclaim.
    const dirty = [...lensEligMessages];
    dirty[5] = makeMsg("assistant", ["ffffffffffffffffffffff"], {
      hidden: true,
    });
    assert.deepEqual(
      computeEligibility(
        buildProtectionMap(dirty, 0, 0),
        dirty,
        numberedOf(dirty),
        gate,
      ),
      { startRef: "m7", endRef: "m7", reclaimTokens: 8 },
    );
  });

  it("excludes a folded interval from the reclaim estimate", () => {
    // Ordinals 1..5 are folded into one summary line, so the window is
    // that line plus nothing else: the folded tokens are already spent
    // and the whole window frees nothing new → silent.
    const items: ViewItem[] = [
      { type: "original", start: 0, end: 1 },
      summaryItem(1, 6),
      { type: "original", start: 6, end: 7 },
      { type: "original", start: 7, end: 8 },
    ];
    assert.equal(
      computeEligibility(
        lensEligProtection,
        lensEligMessages,
        numberedOf(lensEligMessages, items),
        gate,
      ),
      null,
    );
  });

  it("addresses only the work segment after the final instruction", () => {
    // Ordinals 1..3 are folded and ordinal 4 is an instruction.  The
    // summary line holds no instruction, so it is work, but the active
    // tail starts at ordinal 6 and the last free run is the assistant at
    // ordinal 5 — line m4, 6 heuristic tokens.
    const items: ViewItem[] = [
      { type: "original", start: 0, end: 1 },
      summaryItem(1, 4),
      { type: "original", start: 4, end: 5 },
      { type: "original", start: 5, end: 6 },
      { type: "original", start: 6, end: 7 },
      { type: "original", start: 7, end: 8 },
    ];
    assert.deepEqual(
      computeEligibility(
        lensEligProtection,
        lensEligMessages,
        numberedOf(lensEligMessages, items),
        gate,
      ),
      { startRef: "m4", endRef: "m4", reclaimTokens: 6 },
    );
  });

  it("keeps a summary straddling the protection boundary out of the window", () => {
    // The block covers ordinals 1..6, i.e. it reaches past the boundary
    // (ordinal 6), and `compress` would reject it as reaching into the
    // protected tail — so the window ends at the line before it.
    const items: ViewItem[] = [
      { type: "original", start: 0, end: 1 },
      summaryItem(1, 7),
    ];
    assert.equal(
      computeEligibility(
        lensEligProtection,
        lensEligMessages,
        numberedOf(lensEligMessages, items),
        gate,
      ),
      null,
    );
  });

  it("numbers the window in the folded view, not in transcript ordinals", () => {
    // One instruction at ordinal 0, then 21 assistants.  Folding the
    // middle of the work into one line pulls the end ref far below the
    // ordinal it would address unfolded, and the folded content is not
    // billed as reclaim again.
    const many: HostMessage[] = [makeMsg("user", ["aaaa"])];
    for (let i = 1; i < 22; i++) {
      many.push(makeMsg("assistant", ["x".repeat(i * 4)]));
    }
    const unfolded = numberedOf(many);
    const foldedItems: ViewItem[] = [
      { type: "original", start: 0, end: 1 },
      { type: "original", start: 1, end: 2 },
      summaryItem(2, 21),
      { type: "original", start: 21, end: 22 },
    ];
    const folded = numberedOf(many, foldedItems);
    const protection = buildProtectionMap(many, 0, 0);

    const before = computeEligibility(protection, many, unfolded, gate);
    const after = computeEligibility(protection, many, folded, gate);
    assert.ok(before && after, "both windows eligible");
    // Unfolded the window ends at the line addressing ordinal 21; folded
    // the same content is one summary line, so the end ref is m4 and the
    // 19 folded messages contribute no reclaim.
    assert.equal(after.startRef, "m2");
    assert.equal(after.endRef, "m4");
    assert.ok(
      (after?.reclaimTokens ?? 0) < (before?.reclaimTokens ?? 0),
      "folded content is not billed as reclaim again",
    );
  });

  it("returns null when the active tail covers the whole transcript", () => {
    const assistantOnly = [
      makeMsg("assistant", ["bbbbbbbb"]),
      makeMsg("assistant", ["dddddddddddddddd"]),
    ];
    assert.equal(
      computeEligibility(
        buildProtectionMap(assistantOnly, 2, 0),
        assistantOnly,
        numberedOf(assistantOnly),
        gate,
      ),
      null,
    );
  });

  it("advertises work in a transcript without a user message", () => {
    // No instruction exists, so nothing was ever protected by a
    // first-user-only rule: the whole work run is eligible.
    const assistantOnly = [
      makeMsg("assistant", ["bbbbbbbb"]),
      makeMsg("assistant", ["dddddddddddddddd"]),
    ];
    assert.deepEqual(
      computeEligibility(
        buildProtectionMap(assistantOnly, 0, 0),
        assistantOnly,
        numberedOf(assistantOnly),
        gate,
      ),
      { startRef: "m1", endRef: "m2", reclaimTokens: 6 },
    );
  });

  it("keeps 200 steps of work after a single instruction eligible", () => {
    // One instruction, 200 assistant steps, and an active tail of the
    // last 10 messages: the work that already left the active tail is
    // compressible, addressed in dense view lines.
    const history: HostMessage[] = [makeMsg("user", ["instruction"])];
    for (let i = 1; i <= 200; i++) {
      history.push(makeMsg("assistant", ["brief step"]));
    }
    const result = computeEligibility(
      buildProtectionMap(history, 10, 0),
      history,
      numberedOf(history),
      gate,
    );
    assert.equal(result?.startRef, "m2");
    assert.equal(result?.endRef, "m191");
    assert.ok((result?.reclaimTokens ?? 0) > 0);
  });

  it("splits work segments at a middle user instruction", () => {
    // ordinals 1..3 are large work, ordinal 4 is a middle instruction,
    // ordinals 5..9 are small work, and the active tail starts at 10.
    // The last segment is below the phantom threshold, so the earlier
    // segment is advertised — and it must stop before the instruction.
    const history: HostMessage[] = [makeMsg("user", ["instruction"])];
    for (let i = 1; i <= 3; i++) {
      history.push(makeMsg("assistant", ["x".repeat(400)]));
    }
    history.push(makeMsg("user", ["middle instruction"]));
    for (let i = 5; i <= 9; i++) {
      history.push(makeMsg("assistant", ["z".repeat(40)]));
    }
    history.push(makeMsg("assistant", ["tail one"]));
    history.push(makeMsg("assistant", ["tail two"]));
    const result = computeEligibility(
      buildProtectionMap(history, 2, 0),
      history,
      numberedOf(history),
      { thresholdTokens: 100 },
    );
    assert.equal(result?.startRef, "m2");
    assert.equal(result?.endRef, "m4");
    assert.ok(
      (result?.reclaimTokens ?? 0) >= 100,
      "the advertised segment clears the threshold",
    );
  });

  it("returns null for an empty message array", () => {
    assert.equal(
      computeEligibility(buildProtectionMap([], 0, 0), [], [], gate),
      null,
    );
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
    const state = makeState();
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
    const state = makeState(150000);
    creditReclaim(state, 40000);
    // Measured usage still says 150K; the booked reclaim is what the
    // view actually costs, and it is below the gentle threshold (120K).
    assert.equal(readLevel(state, 150000), 110000, "pure read discounts");
    assert.equal(state.nudges?.pendingReclaimTokens, 40000, "read is pure");

    const decision = evaluateNudge(
      state,
      viewAt(150000),
      NUDGE_CONFIG,
      parityOpts(viewAt(150000)),
    );
    assert.equal(
      decision?.text,
      null,
      "no nudge once the level drops below the band",
    );
    assert.equal(
      state.nudges?.lastNudgeTokens,
      110000,
      "watermark follows the level down at once",
    );
  });

  it("keeps the discount while the measurement is the same one", () => {
    const state = makeState(150000);
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
    const state = makeState(150000);
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
    const state = makeState(140000);
    creditReclaim(state, 10000);
    // Measured 150K − credited 10K = 140K level: no growth over the
    // anchor, so nothing fires while the credit holds.
    const same = viewAt(150000);
    assert.equal(
      evaluateNudge(state, same, NUDGE_CONFIG, parityOpts(same))?.text,
      null,
      "discounted level matches the anchor",
    );

    // A measurement that moves off the credited one consumes the credit,
    // so the next evaluation reports the measured value itself.
    const later = viewAt(155000);
    const decision = evaluateNudge(
      state,
      later,
      NUDGE_CONFIG,
      parityOpts(later),
    );
    const text = decision?.text ?? null;
    assert.ok(text !== null, "gentle fires 15K above the anchor");
    assert.ok(
      text.includes("**CONTEXT GROWING — 155000 (78% of 200000 window)**"),
      "header carries the level with no double subtraction",
    );
  });

  it("never lets the discount report a negative level", () => {
    const state = makeState(150000);
    creditReclaim(state, 400000);
    const messages = viewAt(150000);
    assert.equal(readLevel(state, 150000), 0);
    assert.equal(
      evaluateNudge(state, messages, NUDGE_CONFIG, parityOpts(messages))?.text,
      null,
      "a level of 0 is below every threshold",
    );
    assert.equal(state.nudges?.lastNudgeTokens, 0);
  });
});
