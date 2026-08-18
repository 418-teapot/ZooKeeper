/**
 * Tests for `parseContextConfig` in `src/core/config-parse.ts`.
 *
 * Covers the seven C11-* contracts from the semantic-equivalence
 * checklist audit (2026-08-17):
 *
 *  - C11-01 fail-to-skip: any invalid value in a section invalidates
 *    the whole section (undefined + one `<section>_config_invalid`
 *    warn carrying the offending key); an absent section is
 *    undefined with no warn.
 *  - C11-02 zero values preserved: protected_messages:0 /
 *    released_percent:0 / anchor_tokens:0 / compress.threshold_tokens:0
 *    / compress.protected_tokens:0 are accepted without warns.
 *  - C11-03 anchorTokens missing-key default: 0 (the only missing-key
 *    default in the whole parser); negative / non-numeric invalidate
 *    the core group.
 *  - C11-04 released_percent top-level priority: only the top-level
 *    `[zoo.context].released_percent` is read; the legacy
 *    `[zoo.context.dedup].released_percent` is silently ignored.
 *    Bounds 0–100; out-of-range / non-finite / non-numeric invalidate
 *    the core group.
 *  - C11-05 strict section validation: compress requires all three
 *    keys, max_ranges must be a positive integer; decompress requires
 *    max_fill_percent as integer 1–100; the legacy
 *    `reject_percent` is silently ignored.
 *  - C11-06 nudge strict validation: all five keys required; invalid
 *    thresholds (string for caps, malformed percentage, negative cap)
 *    drop the whole section.
 *  - C11-07 unknown keys are silently ignored (legacy / future
 *    candidates don't trigger warns).
 *
 * The test harness reads the in-memory log buffer via
 * `_getBufferForTesting()` and resets it between tests via
 * `_resetForTesting()` — same pattern used by the neighbour
 * `mode-profile.test.ts`.
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { _getBufferForTesting, _resetForTesting } from "../utils/logger.js";
import { parseContextConfig } from "./config-parse.js";

afterEach(() => {
  _resetForTesting();
});

/** Filter the log buffer for entries with the given event name. */
function warnsOf(event: string): Array<Record<string, unknown>> {
  return _getBufferForTesting().filter((e) => e.event === event);
}

/** Count entries with the given event name. */
function warnCount(event: string): number {
  return warnsOf(event).length;
}

// =============================================================================
// C11-01 fail-to-skip: any invalid value in a section inverts the whole
// section (undefined + one `<section>_config_invalid` warn carrying the
// offending key); an absent section is undefined with no warn.
// =============================================================================

describe("C11-01 fail-to-skip", () => {
  describe("core group ([zoo.context])", () => {
    it("returns undefined fields and logs context_config_invalid for string protected_messages", () => {
      const result = parseContextConfig({
        context: { protected_messages: "abc" },
      });
      assert.equal(result.protectedMessages, undefined);
      assert.equal(result.releasedPercent, undefined);
      assert.equal(result.anchorTokens, 0);

      const warns = warnsOf("context_config_invalid");
      assert.equal(warns.length, 1, "exactly one warn for the section");
      assert.equal(warns[0].key, "protected_messages");
      assert.equal(warns[0].value, "abc");
    });

    it("returns undefined fields and logs context_config_invalid for negative anchor_tokens", () => {
      const result = parseContextConfig({
        context: { anchor_tokens: -5 },
      });
      assert.equal(result.protectedMessages, undefined);
      assert.equal(result.releasedPercent, undefined);
      assert.equal(result.anchorTokens, 0);

      const warns = warnsOf("context_config_invalid");
      assert.equal(warns.length, 1);
      assert.equal(warns[0].key, "anchor_tokens");
    });

    it("returns undefined fields and logs context_config_invalid for non-finite released_percent", () => {
      const result = parseContextConfig({
        context: { released_percent: NaN },
      });
      assert.equal(result.protectedMessages, undefined);
      assert.equal(result.releasedPercent, undefined);
      assert.equal(result.anchorTokens, 0);

      const warns = warnsOf("context_config_invalid");
      assert.equal(warns.length, 1);
      assert.equal(warns[0].key, "released_percent");
    });
  });

  describe("dedup sub-section", () => {
    it("returns undefined dedup and logs dedup_config_invalid for negative threshold_context", () => {
      const result = parseContextConfig({
        context: { dedup: { threshold_context: -1 } },
      });
      assert.equal(result.dedup, undefined);

      const warns = warnsOf("dedup_config_invalid");
      assert.equal(warns.length, 1);
      assert.equal(warns[0].key, "threshold_context");
    });

    it("returns undefined dedup and logs dedup_config_invalid for non-string protected_tools array element", () => {
      const result = parseContextConfig({
        context: { dedup: { protected_tools: ["webfetch", 42] } },
      });
      assert.equal(result.dedup, undefined);

      const warns = warnsOf("dedup_config_invalid");
      assert.equal(warns.length, 1);
      assert.equal(warns[0].key, "protected_tools");
    });
  });

  describe("purge_errors sub-section", () => {
    it("returns undefined purgeErrors and logs purge_errors_config_invalid for zero threshold_context", () => {
      const result = parseContextConfig({
        context: { purge_errors: { threshold_context: 0 } },
      });
      assert.equal(result.purgeErrors, undefined);

      const warns = warnsOf("purge_errors_config_invalid");
      assert.equal(warns.length, 1);
      assert.equal(warns[0].key, "threshold_context");
    });

    it("returns undefined purgeErrors and logs purge_errors_config_invalid for non-array protected_tools", () => {
      const result = parseContextConfig({
        context: { purge_errors: { protected_tools: "webfetch" } },
      });
      assert.equal(result.purgeErrors, undefined);

      const warns = warnsOf("purge_errors_config_invalid");
      assert.equal(warns.length, 1);
      assert.equal(warns[0].key, "protected_tools");
    });
  });

  describe("compress sub-section", () => {
    it("returns undefined compress and logs compress_config_invalid for negative threshold_tokens", () => {
      const result = parseContextConfig({
        context: {
          compress: {
            threshold_tokens: -5,
            protected_tokens: 200,
            max_ranges: 3,
          },
        },
      });
      assert.equal(result.compress, undefined);

      const warns = warnsOf("compress_config_invalid");
      assert.equal(warns.length, 1);
      assert.equal(warns[0].key, "threshold_tokens");
    });
  });

  describe("decompress sub-section", () => {
    it("returns undefined decompress and logs decompress_config_invalid for out-of-range max_fill_percent", () => {
      const result = parseContextConfig({
        context: { decompress: { max_fill_percent: 0 } },
      });
      assert.equal(result.decompress, undefined);

      const warns = warnsOf("decompress_config_invalid");
      assert.equal(warns.length, 1);
      assert.equal(warns[0].key, "max_fill_percent");
    });

    it("returns undefined decompress and logs decompress_config_invalid for non-integer max_fill_percent", () => {
      const result = parseContextConfig({
        context: { decompress: { max_fill_percent: 3.5 } },
      });
      assert.equal(result.decompress, undefined);

      const warns = warnsOf("decompress_config_invalid");
      assert.equal(warns.length, 1);
      assert.equal(warns[0].key, "max_fill_percent");
    });
  });

  describe("nudge sub-section", () => {
    it("returns undefined nudge and logs nudge_config_invalid for malformed percentage min_context", () => {
      const result = parseContextConfig({
        context: {
          nudge: {
            min_context: "-5%",
            min_context_cap: 1000,
            max_context: 10000,
            max_context_cap: 2000,
            growth_tokens: 500,
          },
        },
      });
      assert.equal(result.nudge, undefined);

      const warns = warnsOf("nudge_config_invalid");
      assert.equal(warns.length, 1);
      assert.equal(warns[0].key, "min_context");
    });

    it("returns undefined nudge and logs nudge_config_invalid for negative min_context_cap", () => {
      const result = parseContextConfig({
        context: {
          nudge: {
            min_context: 1000,
            min_context_cap: -1,
            max_context: 10000,
            max_context_cap: 2000,
            growth_tokens: 500,
          },
        },
      });
      assert.equal(result.nudge, undefined);

      const warns = warnsOf("nudge_config_invalid");
      assert.equal(warns.length, 1);
      assert.equal(warns[0].key, "min_context_cap");
    });
  });

  describe("absent section → no warn", () => {
    it("does not log any *_config_invalid when [zoo.context] is entirely absent", () => {
      const result = parseContextConfig({});
      assert.equal(result.protectedMessages, undefined);
      assert.equal(result.releasedPercent, undefined);
      assert.equal(result.anchorTokens, 0);
      assert.equal(result.dedup, undefined);
      assert.equal(result.purgeErrors, undefined);
      assert.equal(result.nudge, undefined);
      assert.equal(result.compress, undefined);
      assert.equal(result.decompress, undefined);

      const buffer = _getBufferForTesting();
      const sectionWarns = buffer.filter((e) =>
        (e.event as string).endsWith("_config_invalid"),
      );
      assert.equal(
        sectionWarns.length,
        0,
        "absent section must not produce any warn",
      );
    });

    it("does not log any *_config_invalid when [zoo.context] is present but empty", () => {
      const result = parseContextConfig({ context: {} });
      assert.equal(result.protectedMessages, undefined);
      assert.equal(result.releasedPercent, undefined);
      assert.equal(result.anchorTokens, 0);
      assert.equal(result.dedup, undefined);
      assert.equal(result.purgeErrors, undefined);
      assert.equal(result.nudge, undefined);
      assert.equal(result.compress, undefined);
      assert.equal(result.decompress, undefined);

      const buffer = _getBufferForTesting();
      const sectionWarns = buffer.filter((e) =>
        (e.event as string).endsWith("_config_invalid"),
      );
      assert.equal(
        sectionWarns.length,
        0,
        "empty section must not produce any warn",
      );
    });
  });

  describe("per-section warn isolation", () => {
    it("invalid core group does not affect dedup / compress / decompress", () => {
      const result = parseContextConfig({
        context: {
          protected_messages: "abc",
          dedup: { threshold_context: 100, protected_tools: ["webfetch"] },
          compress: {
            threshold_tokens: 1000,
            protected_tokens: 200,
            max_ranges: 3,
          },
          decompress: { max_fill_percent: 50 },
        },
      });
      // Core group dropped.
      assert.equal(result.protectedMessages, undefined);
      assert.equal(result.releasedPercent, undefined);
      assert.equal(result.anchorTokens, 0);
      // Other sub-sections remain valid.
      assert.deepEqual(result.dedup, {
        thresholdContext: 100,
        protectedTools: ["webfetch"],
      });
      assert.deepEqual(result.compress, {
        thresholdTokens: 1000,
        protectedTokens: 200,
        maxRanges: 3,
      });
      assert.deepEqual(result.decompress, { maxFillPercent: 50 });

      // Only one warn — for the core group, not the other sub-sections.
      assert.equal(warnCount("context_config_invalid"), 1);
      assert.equal(warnCount("dedup_config_invalid"), 0);
      assert.equal(warnCount("compress_config_invalid"), 0);
      assert.equal(warnCount("decompress_config_invalid"), 0);
    });

    it("invalid compress does not affect core / dedup / decompress", () => {
      const result = parseContextConfig({
        context: {
          protected_messages: 3,
          released_percent: 10,
          anchor_tokens: 0,
          dedup: { threshold_context: 50, protected_tools: ["webfetch"] },
          compress: {
            threshold_tokens: 1000,
            protected_tokens: 200,
            max_ranges: 0,
          },
          decompress: { max_fill_percent: 50 },
        },
      });
      // Core & dedup & decompress remain valid.
      assert.equal(result.protectedMessages, 3);
      assert.equal(result.releasedPercent, 10);
      assert.equal(result.anchorTokens, 0);
      assert.deepEqual(result.dedup, {
        thresholdContext: 50,
        protectedTools: ["webfetch"],
      });
      assert.deepEqual(result.decompress, { maxFillPercent: 50 });
      // Compress dropped.
      assert.equal(result.compress, undefined);

      // Only one warn — for compress.
      assert.equal(warnCount("compress_config_invalid"), 1);
      assert.equal(warnCount("context_config_invalid"), 0);
      assert.equal(warnCount("dedup_config_invalid"), 0);
      assert.equal(warnCount("decompress_config_invalid"), 0);
    });
  });
});

// =============================================================================
// C11-02 zero values preserved: protected_messages:0 / released_percent:0 /
// anchor_tokens:0 / compress.threshold_tokens:0 / compress.protected_tokens:0
// are accepted without warns and round-trip as 0.
// =============================================================================

describe("C11-02 zero values preserved", () => {
  it("accepts protected_messages: 0 (no warn, returns 0)", () => {
    const result = parseContextConfig({
      context: { protected_messages: 0 },
    });
    assert.equal(result.protectedMessages, 0);
    assert.equal(warnCount("context_config_invalid"), 0);
  });

  it("accepts released_percent: 0 (no warn, returns 0)", () => {
    const result = parseContextConfig({
      context: { released_percent: 0 },
    });
    assert.equal(result.releasedPercent, 0);
    assert.equal(warnCount("context_config_invalid"), 0);
  });

  it("accepts anchor_tokens: 0 (no warn, returns 0)", () => {
    const result = parseContextConfig({
      context: { anchor_tokens: 0 },
    });
    assert.equal(result.anchorTokens, 0);
    assert.equal(warnCount("context_config_invalid"), 0);
  });

  it("accepts compress.threshold_tokens: 0 (no warn, returns 0)", () => {
    const result = parseContextConfig({
      context: {
        compress: { threshold_tokens: 0, protected_tokens: 200, max_ranges: 3 },
      },
    });
    assert.deepEqual(result.compress, {
      thresholdTokens: 0,
      protectedTokens: 200,
      maxRanges: 3,
    });
    assert.equal(warnCount("compress_config_invalid"), 0);
  });

  it("accepts compress.protected_tokens: 0 (no warn, returns 0)", () => {
    const result = parseContextConfig({
      context: {
        compress: {
          threshold_tokens: 1000,
          protected_tokens: 0,
          max_ranges: 3,
        },
      },
    });
    assert.deepEqual(result.compress, {
      thresholdTokens: 1000,
      protectedTokens: 0,
      maxRanges: 3,
    });
    assert.equal(warnCount("compress_config_invalid"), 0);
  });

  it("accepts all-zero core group together (no warn)", () => {
    const result = parseContextConfig({
      context: {
        protected_messages: 0,
        released_percent: 0,
        anchor_tokens: 0,
      },
    });
    assert.equal(result.protectedMessages, 0);
    assert.equal(result.releasedPercent, 0);
    assert.equal(result.anchorTokens, 0);
    assert.equal(warnCount("context_config_invalid"), 0);
  });
});

// =============================================================================
// C11-03 anchorTokens missing-key default: 0 (the only missing-key default
// in the parser); negative / non-numeric values invalidate the core group.
// =============================================================================

describe("C11-03 anchorTokens default and validation", () => {
  it("returns anchorTokens: 0 when anchor_tokens key is absent (no warn)", () => {
    const result = parseContextConfig({ context: { protected_messages: 3 } });
    assert.equal(result.anchorTokens, 0);
    assert.equal(warnCount("context_config_invalid"), 0);
  });

  it("returns anchorTokens: 0 when [zoo.context] is entirely absent (no warn)", () => {
    const result = parseContextConfig({});
    assert.equal(result.anchorTokens, 0);
    assert.equal(warnCount("context_config_invalid"), 0);
  });

  it("drops core group and warns for negative anchor_tokens", () => {
    const result = parseContextConfig({
      context: { protected_messages: 3, anchor_tokens: -5 },
    });
    assert.equal(result.anchorTokens, 0);
    assert.equal(result.protectedMessages, undefined);
    const warns = warnsOf("context_config_invalid");
    assert.equal(warns.length, 1);
    assert.equal(warns[0].key, "anchor_tokens");
  });

  it("drops core group and warns for non-numeric anchor_tokens", () => {
    const result = parseContextConfig({
      context: { anchor_tokens: "abc" },
    });
    assert.equal(result.anchorTokens, 0);
    assert.equal(result.protectedMessages, undefined);
    const warns = warnsOf("context_config_invalid");
    assert.equal(warns.length, 1);
    assert.equal(warns[0].key, "anchor_tokens");
  });

  it("drops core group and warns for non-finite anchor_tokens (Infinity)", () => {
    const result = parseContextConfig({
      context: { anchor_tokens: Infinity },
    });
    assert.equal(result.anchorTokens, 0);
    assert.equal(result.protectedMessages, undefined);
    const warns = warnsOf("context_config_invalid");
    assert.equal(warns.length, 1);
    assert.equal(warns[0].key, "anchor_tokens");
  });
});

// =============================================================================
// C11-04 released_percent top-level priority: only the top-level
// `[zoo.context].released_percent` is read; the legacy
// `[zoo.context.dedup].released_percent` is silently ignored. Bounds 0–100.
// =============================================================================

describe("C11-04 released_percent precedence and bounds", () => {
  describe("top-level priority", () => {
    it("returns top-level value when both top-level and [dedup] are present", () => {
      const result = parseContextConfig({
        context: {
          released_percent: 10,
          dedup: { threshold_context: 50, released_percent: 20 },
        },
      });
      assert.equal(result.releasedPercent, 10);
    });

    it("returns undefined when only [dedup].released_percent is present (legacy ignored)", () => {
      const result = parseContextConfig({
        context: {
          dedup: { threshold_context: 50, released_percent: 20 },
        },
      });
      assert.equal(result.releasedPercent, undefined);
    });

    it("returns undefined when only [dedup].released_percent is present and [dedup] is otherwise invalid", () => {
      const result = parseContextConfig({
        context: {
          dedup: { threshold_context: -1, released_percent: 20 },
        },
      });
      assert.equal(result.releasedPercent, undefined);
      assert.equal(result.dedup, undefined);
    });

    it("does not log any warn when only [dedup].released_percent is present (legacy silently ignored)", () => {
      parseContextConfig({
        context: {
          dedup: { threshold_context: 50, released_percent: 20 },
        },
      });
      assert.equal(warnCount("context_config_invalid"), 0);
      assert.equal(warnCount("dedup_config_invalid"), 0);
    });
  });

  describe("bounds: 0..100 inclusive", () => {
    it("accepts released_percent: 0 (lower bound)", () => {
      const result = parseContextConfig({
        context: { released_percent: 0 },
      });
      assert.equal(result.releasedPercent, 0);
      assert.equal(warnCount("context_config_invalid"), 0);
    });

    it("accepts released_percent: 100 (upper bound)", () => {
      const result = parseContextConfig({
        context: { released_percent: 100 },
      });
      assert.equal(result.releasedPercent, 100);
      assert.equal(warnCount("context_config_invalid"), 0);
    });

    it("accepts released_percent: 50 (typical mid-range)", () => {
      const result = parseContextConfig({
        context: { released_percent: 50 },
      });
      assert.equal(result.releasedPercent, 50);
      assert.equal(warnCount("context_config_invalid"), 0);
    });
  });

  describe("out-of-range / non-finite / non-numeric", () => {
    it("rejects released_percent: -1 (below 0)", () => {
      const result = parseContextConfig({
        context: { released_percent: -1 },
      });
      assert.equal(result.releasedPercent, undefined);
      const warns = warnsOf("context_config_invalid");
      assert.equal(warns.length, 1);
      assert.equal(warns[0].key, "released_percent");
    });

    it("rejects released_percent: 101 (above 100)", () => {
      const result = parseContextConfig({
        context: { released_percent: 101 },
      });
      assert.equal(result.releasedPercent, undefined);
      const warns = warnsOf("context_config_invalid");
      assert.equal(warns.length, 1);
      assert.equal(warns[0].key, "released_percent");
    });

    it("rejects released_percent: NaN", () => {
      const result = parseContextConfig({
        context: { released_percent: NaN },
      });
      assert.equal(result.releasedPercent, undefined);
      const warns = warnsOf("context_config_invalid");
      assert.equal(warns.length, 1);
      assert.equal(warns[0].key, "released_percent");
    });

    it("rejects released_percent: Infinity", () => {
      const result = parseContextConfig({
        context: { released_percent: Infinity },
      });
      assert.equal(result.releasedPercent, undefined);
      const warns = warnsOf("context_config_invalid");
      assert.equal(warns.length, 1);
      assert.equal(warns[0].key, "released_percent");
    });

    it("rejects released_percent: string ('abc')", () => {
      const result = parseContextConfig({
        context: { released_percent: "abc" },
      });
      assert.equal(result.releasedPercent, undefined);
      const warns = warnsOf("context_config_invalid");
      assert.equal(warns.length, 1);
      assert.equal(warns[0].key, "released_percent");
    });
  });
});

// =============================================================================
// C11-05 strict section validation: compress requires all three keys +
// max_ranges must be a positive integer; decompress requires max_fill_percent
// as integer 1–100; legacy `reject_percent` is silently ignored.
// =============================================================================

describe("C11-05 strict section validation", () => {
  describe("compress — three keys all required", () => {
    it("drops compress when threshold_tokens is missing", () => {
      const result = parseContextConfig({
        context: {
          compress: { protected_tokens: 200, max_ranges: 3 },
        },
      });
      assert.equal(result.compress, undefined);
      const warns = warnsOf("compress_config_invalid");
      assert.equal(warns.length, 1);
      assert.equal(warns[0].key, "threshold_tokens");
    });

    it("drops compress when protected_tokens is missing", () => {
      const result = parseContextConfig({
        context: {
          compress: { threshold_tokens: 1000, max_ranges: 3 },
        },
      });
      assert.equal(result.compress, undefined);
      const warns = warnsOf("compress_config_invalid");
      assert.equal(warns.length, 1);
      assert.equal(warns[0].key, "protected_tokens");
    });

    it("drops compress when max_ranges is missing", () => {
      const result = parseContextConfig({
        context: {
          compress: { threshold_tokens: 1000, protected_tokens: 200 },
        },
      });
      assert.equal(result.compress, undefined);
      const warns = warnsOf("compress_config_invalid");
      assert.equal(warns.length, 1);
      assert.equal(warns[0].key, "max_ranges");
    });

    it("does not log warn when compress section is absent entirely", () => {
      const result = parseContextConfig({ context: { protected_messages: 3 } });
      assert.equal(result.compress, undefined);
      assert.equal(warnCount("compress_config_invalid"), 0);
    });
  });

  describe("compress — max_ranges must be a positive integer", () => {
    it("rejects max_ranges: 0 (must be >= 1)", () => {
      const result = parseContextConfig({
        context: {
          compress: {
            threshold_tokens: 1000,
            protected_tokens: 200,
            max_ranges: 0,
          },
        },
      });
      assert.equal(result.compress, undefined);
      const warns = warnsOf("compress_config_invalid");
      assert.equal(warns.length, 1);
      assert.equal(warns[0].key, "max_ranges");
    });

    it("rejects max_ranges: -1 (negative integer)", () => {
      const result = parseContextConfig({
        context: {
          compress: {
            threshold_tokens: 1000,
            protected_tokens: 200,
            max_ranges: -1,
          },
        },
      });
      assert.equal(result.compress, undefined);
      const warns = warnsOf("compress_config_invalid");
      assert.equal(warns.length, 1);
      assert.equal(warns[0].key, "max_ranges");
    });

    it("rejects max_ranges: 'abc' (non-numeric)", () => {
      const result = parseContextConfig({
        context: {
          compress: {
            threshold_tokens: 1000,
            protected_tokens: 200,
            max_ranges: "abc",
          },
        },
      });
      assert.equal(result.compress, undefined);
      const warns = warnsOf("compress_config_invalid");
      assert.equal(warns.length, 1);
      assert.equal(warns[0].key, "max_ranges");
    });

    it("rejects max_ranges: 1.5 (non-integer)", () => {
      const result = parseContextConfig({
        context: {
          compress: {
            threshold_tokens: 1000,
            protected_tokens: 200,
            max_ranges: 1.5,
          },
        },
      });
      assert.equal(result.compress, undefined);
      const warns = warnsOf("compress_config_invalid");
      assert.equal(warns.length, 1);
      assert.equal(warns[0].key, "max_ranges");
    });

    it("rejects max_ranges: Infinity (non-integer)", () => {
      const result = parseContextConfig({
        context: {
          compress: {
            threshold_tokens: 1000,
            protected_tokens: 200,
            max_ranges: Infinity,
          },
        },
      });
      assert.equal(result.compress, undefined);
      const warns = warnsOf("compress_config_invalid");
      assert.equal(warns.length, 1);
      assert.equal(warns[0].key, "max_ranges");
    });

    it("accepts max_ranges: 1 (minimum positive integer)", () => {
      const result = parseContextConfig({
        context: {
          compress: {
            threshold_tokens: 1000,
            protected_tokens: 200,
            max_ranges: 1,
          },
        },
      });
      assert.deepEqual(result.compress, {
        thresholdTokens: 1000,
        protectedTokens: 200,
        maxRanges: 1,
      });
      assert.equal(warnCount("compress_config_invalid"), 0);
    });
  });

  describe("decompress — max_fill_percent must be integer 1..100", () => {
    it("rejects max_fill_percent: 0 (below 1)", () => {
      const result = parseContextConfig({
        context: { decompress: { max_fill_percent: 0 } },
      });
      assert.equal(result.decompress, undefined);
      const warns = warnsOf("decompress_config_invalid");
      assert.equal(warns.length, 1);
      assert.equal(warns[0].key, "max_fill_percent");
    });

    it("rejects max_fill_percent: 101 (above 100)", () => {
      const result = parseContextConfig({
        context: { decompress: { max_fill_percent: 101 } },
      });
      assert.equal(result.decompress, undefined);
      const warns = warnsOf("decompress_config_invalid");
      assert.equal(warns.length, 1);
      assert.equal(warns[0].key, "max_fill_percent");
    });

    it("rejects max_fill_percent: 3.5 (non-integer)", () => {
      const result = parseContextConfig({
        context: { decompress: { max_fill_percent: 3.5 } },
      });
      assert.equal(result.decompress, undefined);
      const warns = warnsOf("decompress_config_invalid");
      assert.equal(warns.length, 1);
      assert.equal(warns[0].key, "max_fill_percent");
    });

    it("accepts max_fill_percent: 1 (lower bound)", () => {
      const result = parseContextConfig({
        context: { decompress: { max_fill_percent: 1 } },
      });
      assert.deepEqual(result.decompress, { maxFillPercent: 1 });
      assert.equal(warnCount("decompress_config_invalid"), 0);
    });

    it("accepts max_fill_percent: 100 (upper bound)", () => {
      const result = parseContextConfig({
        context: { decompress: { max_fill_percent: 100 } },
      });
      assert.deepEqual(result.decompress, { maxFillPercent: 100 });
      assert.equal(warnCount("decompress_config_invalid"), 0);
    });

    it("does not log warn when decompress section is absent entirely", () => {
      const result = parseContextConfig({ context: { protected_messages: 3 } });
      assert.equal(result.decompress, undefined);
      assert.equal(warnCount("decompress_config_invalid"), 0);
    });
  });

  describe("decompress — legacy reject_percent silently ignored", () => {
    it("returns valid decompress and ignores reject_percent (no warn)", () => {
      const result = parseContextConfig({
        context: {
          decompress: { max_fill_percent: 50, reject_percent: 30 },
        },
      });
      assert.deepEqual(result.decompress, { maxFillPercent: 50 });
      assert.equal(warnCount("decompress_config_invalid"), 0);
    });

    it("ignores reject_percent when it is the only extra key (no warn)", () => {
      const result = parseContextConfig({
        context: {
          decompress: { reject_percent: 30 },
        },
      });
      // max_fill_percent is missing → section dropped (as expected).
      assert.equal(result.decompress, undefined);
      const warns = warnsOf("decompress_config_invalid");
      assert.equal(warns.length, 1);
      assert.equal(warns[0].key, "max_fill_percent");
    });
  });
});

// =============================================================================
// C11-06 nudge strict validation: all five keys required; invalid thresholds
// (string for caps, malformed percentage, negative cap) drop the whole section.
// =============================================================================

describe("C11-06 nudge strict validation", () => {
  /** A valid 5-key nudge config — used as the baseline. */
  const VALID_NUDGE = {
    min_context: 1000,
    min_context_cap: 2000,
    max_context: 8000,
    max_context_cap: 12000,
    growth_tokens: 500,
  };

  it("accepts a fully valid nudge (no warn)", () => {
    const result = parseContextConfig({
      context: { nudge: VALID_NUDGE },
    });
    assert.deepEqual(result.nudge, {
      minContext: 1000,
      minContextCap: 2000,
      maxContext: 8000,
      maxContextCap: 12000,
      growthTokens: 500,
    });
    assert.equal(warnCount("nudge_config_invalid"), 0);
  });

  describe("each missing key invalidates the whole section", () => {
    for (const key of [
      "min_context",
      "min_context_cap",
      "max_context",
      "max_context_cap",
      "growth_tokens",
    ]) {
      it(`drops nudge when ${key} is missing`, () => {
        const partial: Record<string, unknown> = { ...VALID_NUDGE };
        delete partial[key];
        const result = parseContextConfig({
          context: { nudge: partial },
        });
        assert.equal(result.nudge, undefined);
        const warns = warnsOf("nudge_config_invalid");
        assert.equal(warns.length, 1);
        assert.equal(warns[0].key, key);
      });
    }
  });

  describe("invalid threshold values", () => {
    it("rejects min_context: 'abc' (non-numeric, non-percent string)", () => {
      const result = parseContextConfig({
        context: { nudge: { ...VALID_NUDGE, min_context: "abc" } },
      });
      assert.equal(result.nudge, undefined);
      const warns = warnsOf("nudge_config_invalid");
      assert.equal(warns.length, 1);
      assert.equal(warns[0].key, "min_context");
    });

    it("rejects min_context: '-5%' (negative percent — invalid format)", () => {
      const result = parseContextConfig({
        context: { nudge: { ...VALID_NUDGE, min_context: "-5%" } },
      });
      assert.equal(result.nudge, undefined);
      const warns = warnsOf("nudge_config_invalid");
      assert.equal(warns.length, 1);
      assert.equal(warns[0].key, "min_context");
    });

    it("rejects min_context: 0 (valid format but zero not allowed)", () => {
      const result = parseContextConfig({
        context: { nudge: { ...VALID_NUDGE, min_context: 0 } },
      });
      assert.equal(result.nudge, undefined);
      const warns = warnsOf("nudge_config_invalid");
      assert.equal(warns.length, 1);
      assert.equal(warns[0].key, "min_context");
    });

    it("rejects min_context: '0%' (zero percent not allowed)", () => {
      const result = parseContextConfig({
        context: { nudge: { ...VALID_NUDGE, min_context: "0%" } },
      });
      assert.equal(result.nudge, undefined);
      const warns = warnsOf("nudge_config_invalid");
      assert.equal(warns.length, 1);
      assert.equal(warns[0].key, "min_context");
    });

    it("rejects max_context: -100 (negative number)", () => {
      const result = parseContextConfig({
        context: { nudge: { ...VALID_NUDGE, max_context: -100 } },
      });
      assert.equal(result.nudge, undefined);
      const warns = warnsOf("nudge_config_invalid");
      assert.equal(warns.length, 1);
      assert.equal(warns[0].key, "max_context");
    });

    it("rejects growth_tokens: null (wrong type)", () => {
      const result = parseContextConfig({
        context: { nudge: { ...VALID_NUDGE, growth_tokens: null } },
      });
      assert.equal(result.nudge, undefined);
      const warns = warnsOf("nudge_config_invalid");
      assert.equal(warns.length, 1);
      assert.equal(warns[0].key, "growth_tokens");
    });

    it("accepts nudge thresholds as positive percentage strings", () => {
      const result = parseContextConfig({
        context: {
          nudge: {
            min_context: "10%",
            min_context_cap: 2000,
            max_context: "80%",
            max_context_cap: 12000,
            growth_tokens: "5%",
          },
        },
      });
      assert.deepEqual(result.nudge, {
        minContext: "10%",
        minContextCap: 2000,
        maxContext: "80%",
        maxContextCap: 12000,
        growthTokens: "5%",
      });
      assert.equal(warnCount("nudge_config_invalid"), 0);
    });
  });

  describe("invalid cap values", () => {
    it("rejects min_context_cap: 'abc' (string for cap)", () => {
      const result = parseContextConfig({
        context: { nudge: { ...VALID_NUDGE, min_context_cap: "abc" } },
      });
      assert.equal(result.nudge, undefined);
      const warns = warnsOf("nudge_config_invalid");
      assert.equal(warns.length, 1);
      assert.equal(warns[0].key, "min_context_cap");
    });

    it("accepts min_context_cap: 0 (zero is allowed for caps)", () => {
      const result = parseContextConfig({
        context: { nudge: { ...VALID_NUDGE, min_context_cap: 0 } },
      });
      assert.deepEqual(result.nudge, {
        minContext: 1000,
        minContextCap: 0,
        maxContext: 8000,
        maxContextCap: 12000,
        growthTokens: 500,
      });
      assert.equal(warnCount("nudge_config_invalid"), 0);
    });

    it("rejects max_context_cap: -1 (negative cap)", () => {
      const result = parseContextConfig({
        context: { nudge: { ...VALID_NUDGE, max_context_cap: -1 } },
      });
      assert.equal(result.nudge, undefined);
      const warns = warnsOf("nudge_config_invalid");
      assert.equal(warns.length, 1);
      assert.equal(warns[0].key, "max_context_cap");
    });

    it("rejects max_context_cap: NaN (non-finite cap)", () => {
      const result = parseContextConfig({
        context: { nudge: { ...VALID_NUDGE, max_context_cap: NaN } },
      });
      assert.equal(result.nudge, undefined);
      const warns = warnsOf("nudge_config_invalid");
      assert.equal(warns.length, 1);
      assert.equal(warns[0].key, "max_context_cap");
    });

    it("rejects max_context_cap: Infinity (non-finite cap)", () => {
      const result = parseContextConfig({
        context: { nudge: { ...VALID_NUDGE, max_context_cap: Infinity } },
      });
      assert.equal(result.nudge, undefined);
      const warns = warnsOf("nudge_config_invalid");
      assert.equal(warns.length, 1);
      assert.equal(warns[0].key, "max_context_cap");
    });
  });

  it("does not log warn when nudge section is absent entirely", () => {
    const result = parseContextConfig({
      context: { protected_messages: 3 },
    });
    assert.equal(result.nudge, undefined);
    assert.equal(warnCount("nudge_config_invalid"), 0);
  });
});

// =============================================================================
// C11-07 unknown keys are silently ignored (legacy / future candidates don't
// trigger warns).
// =============================================================================

describe("C11-07 unknown keys ignored", () => {
  it("ignores unknown top-level key in [zoo.context]", () => {
    const result = parseContextConfig({
      context: {
        protected_messages: 3,
        future_field: "ignored",
        legacy_key: 42,
      },
    });
    assert.equal(result.protectedMessages, 3);
    assert.equal(warnCount("context_config_invalid"), 0);
  });

  it("ignores unknown key in [zoo.context.dedup]", () => {
    const result = parseContextConfig({
      context: {
        dedup: {
          threshold_context: 50,
          protected_tools: ["webfetch"],
          threshold_tokens_old: 100, // legacy
          future_field: true,
        },
      },
    });
    assert.deepEqual(result.dedup, {
      thresholdContext: 50,
      protectedTools: ["webfetch"],
    });
    assert.equal(warnCount("dedup_config_invalid"), 0);
  });

  it("ignores unknown key in [zoo.context.purge_errors]", () => {
    const result = parseContextConfig({
      context: {
        purge_errors: {
          threshold_context: 50,
          protected_tools: ["webfetch"],
          legacy_protected_messages: 5,
        },
      },
    });
    assert.deepEqual(result.purgeErrors, {
      thresholdContext: 50,
      protectedTools: ["webfetch"],
    });
    assert.equal(warnCount("purge_errors_config_invalid"), 0);
  });

  it("ignores unknown key in [zoo.context.compress]", () => {
    const result = parseContextConfig({
      context: {
        compress: {
          threshold_tokens: 1000,
          protected_tokens: 200,
          max_ranges: 3,
          legacy_max_messages: 10,
        },
      },
    });
    assert.deepEqual(result.compress, {
      thresholdTokens: 1000,
      protectedTokens: 200,
      maxRanges: 3,
    });
    assert.equal(warnCount("compress_config_invalid"), 0);
  });

  it("ignores unknown key in [zoo.context.decompress]", () => {
    const result = parseContextConfig({
      context: {
        decompress: {
          max_fill_percent: 50,
          legacy_reject_percent: 30,
        },
      },
    });
    assert.deepEqual(result.decompress, { maxFillPercent: 50 });
    assert.equal(warnCount("decompress_config_invalid"), 0);
  });

  it("ignores unknown key in [zoo.context.nudge]", () => {
    const result = parseContextConfig({
      context: {
        nudge: {
          min_context: 1000,
          min_context_cap: 2000,
          max_context: 8000,
          max_context_cap: 12000,
          growth_tokens: 500,
          legacy_min_messages: 5,
        },
      },
    });
    assert.deepEqual(result.nudge, {
      minContext: 1000,
      minContextCap: 2000,
      maxContext: 8000,
      maxContextCap: 12000,
      growthTokens: 500,
    });
    assert.equal(warnCount("nudge_config_invalid"), 0);
  });

  it("does not log any warn for a fully-unknown config tree", () => {
    const result = parseContextConfig({
      context: {
        future_field: "ignored",
        some_other_field: 42,
      },
    });
    assert.equal(result.protectedMessages, undefined);
    assert.equal(result.releasedPercent, undefined);
    assert.equal(result.anchorTokens, 0);
    assert.equal(result.dedup, undefined);
    assert.equal(result.purgeErrors, undefined);
    assert.equal(result.nudge, undefined);
    assert.equal(result.compress, undefined);
    assert.equal(result.decompress, undefined);

    const buffer = _getBufferForTesting();
    const sectionWarns = buffer.filter((e) =>
      (e.event as string).endsWith("_config_invalid"),
    );
    assert.equal(sectionWarns.length, 0);
  });
});

// =============================================================================
// Smoke: fully valid config produces all sub-sections with no warns.
// =============================================================================

describe("parseContextConfig — fully valid config", () => {
  it("returns all sub-sections and no warns for a complete config", () => {
    const result = parseContextConfig({
      context: {
        protected_messages: 3,
        released_percent: 10,
        anchor_tokens: 0,
        dedup: { threshold_context: 50, protected_tools: ["webfetch"] },
        purge_errors: {
          threshold_context: 60,
          protected_tools: ["tool1"],
        },
        nudge: {
          min_context: 1000,
          min_context_cap: 2000,
          max_context: 8000,
          max_context_cap: 12000,
          growth_tokens: 500,
        },
        compress: {
          threshold_tokens: 1000,
          protected_tokens: 200,
          max_ranges: 3,
        },
        decompress: { max_fill_percent: 50 },
      },
    });
    assert.equal(result.protectedMessages, 3);
    assert.equal(result.releasedPercent, 10);
    assert.equal(result.anchorTokens, 0);
    assert.deepEqual(result.dedup, {
      thresholdContext: 50,
      protectedTools: ["webfetch"],
    });
    assert.deepEqual(result.purgeErrors, {
      thresholdContext: 60,
      protectedTools: ["tool1"],
    });
    assert.deepEqual(result.nudge, {
      minContext: 1000,
      minContextCap: 2000,
      maxContext: 8000,
      maxContextCap: 12000,
      growthTokens: 500,
    });
    assert.deepEqual(result.compress, {
      thresholdTokens: 1000,
      protectedTokens: 200,
      maxRanges: 3,
    });
    assert.deepEqual(result.decompress, { maxFillPercent: 50 });

    const buffer = _getBufferForTesting();
    const sectionWarns = buffer.filter((e) =>
      (e.event as string).endsWith("_config_invalid"),
    );
    assert.equal(sectionWarns.length, 0, "valid config must not log any warn");
  });
});
