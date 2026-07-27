/**
 * Direct unit tests for core/validate.ts.
 *
 * Tests `validateTaskPrompt()` in isolation — focus on the return structure,
 * default vs custom limit behavior, boundary conditions, and warning patterns.
 *
 * These complement the existing hook-level tests in
 * `hooks/task-prompt/index.test.ts` which cover section extraction, plugin
 * integration, and tool.execute.before/after wiring.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { validateTaskPrompt } from "./validate.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal valid prompt that passes all checks.
 * Callers can override individual sections.
 */
function validPrompt(overrides?: {
  summary?: string;
  context?: string;
  acceptance?: string;
}): string {
  const s = overrides?.summary ?? "Fix the flaky auth test";
  const c =
    overrides?.context ??
    "The auth.login test fails intermittently on CI due to a token refresh race condition. Target file: tests/auth_test.py";
  const a =
    overrides?.acceptance ?? "All auth tests pass with no new flaky tests";
  return `SUMMARY: ${s}\nCONTEXT: ${c}\nACCEPTANCE: ${a}`;
}

// ---------------------------------------------------------------------------
// Return structure
// ---------------------------------------------------------------------------

describe("validateTaskPrompt return structure", () => {
  it("returns valid=true with empty errors/warnings for a well-formed prompt", () => {
    const result = validateTaskPrompt(validPrompt());
    assert.equal(result.valid, true);
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.warnings, []);
    assert.equal(typeof result.ctx_words, "number");
    assert.equal(typeof result.total_words, "number");
  });

  it("returns valid=false when a section is missing", () => {
    const prompt = "SUMMARY: Fix stuff\nCONTEXT: Some context";
    const result = validateTaskPrompt(prompt);
    assert.equal(result.valid, false);
    assert.ok(result.errors.length > 0);
  });
});

// ---------------------------------------------------------------------------
// Missing sections
// ---------------------------------------------------------------------------

describe("missing sections", () => {
  it("reports missing SUMMARY only", () => {
    const prompt = "CONTEXT: Some context\nACCEPTANCE: Tests pass";
    const result = validateTaskPrompt(prompt);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes("SUMMARY")));
    assert.ok(!result.errors.some((e) => e.includes("CONTEXT")));
    assert.ok(!result.errors.some((e) => e.includes("ACCEPTANCE")));
  });

  it("reports missing CONTEXT only", () => {
    const prompt = "SUMMARY: Fix stuff\nACCEPTANCE: Tests pass";
    const result = validateTaskPrompt(prompt);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes("CONTEXT")));
  });

  it("reports missing ACCEPTANCE only", () => {
    const prompt = "SUMMARY: Fix stuff\nCONTEXT: Some context";
    const result = validateTaskPrompt(prompt);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes("ACCEPTANCE")));
  });

  it("returns zero ctx_words when CONTEXT is missing", () => {
    const prompt = "SUMMARY: Fix stuff\nACCEPTANCE: Tests pass";
    const result = validateTaskPrompt(prompt);
    assert.equal(result.ctx_words, 0);
  });
});

// ---------------------------------------------------------------------------
// Word-count limits (explicit)
// ---------------------------------------------------------------------------

describe("word-count limits (explicit)", () => {
  it("contextWordLimit=100 warns at 101 words", () => {
    const words = Array.from({ length: 101 }, (_, i) => `w${i + 1}`);
    const prompt = validPrompt({ context: words.join(" ") });
    const result = validateTaskPrompt(prompt, { contextWordLimit: 100 });
    assert.ok(result.warnings.some((e) => e.includes("CONTEXT is")));
  });

  it("promptWordLimit=250 warns above threshold", () => {
    const contextWords = Array.from({ length: 50 }, (_, i) => `w${i + 1}`);
    const summaryWords = Array.from({ length: 100 }, (_, i) => `w${i + 1}`);
    const acceptanceWords = Array.from({ length: 100 }, (_, i) => `w${i + 1}`);
    const prompt = [
      `SUMMARY: ${summaryWords.join(" ")}`,
      `CONTEXT: ${contextWords.join(" ")}`,
      `ACCEPTANCE: ${acceptanceWords.join(" ")}`,
    ].join("\n");
    const result = validateTaskPrompt(prompt, { promptWordLimit: 250 });
    assert.ok(result.warnings.some((e) => e.includes("concise")));
  });

  it("returns correct total_words count", () => {
    const prompt = "SUMMARY: Fix bug\nCONTEXT: Short context\nACCEPTANCE: Pass";
    const result = validateTaskPrompt(prompt);
    // "SUMMARY:", "Fix", "bug", "CONTEXT:", "Short", "context", "ACCEPTANCE:", "Pass" = 8
    assert.equal(result.total_words, 8);
  });
});

// ---------------------------------------------------------------------------
// Custom limits
// ---------------------------------------------------------------------------

describe("custom limits via Partial<ValidationLimits>", () => {
  it("uses custom contextWordLimit over default", () => {
    // 60 words exceeds custom limit of 50
    const words = Array.from({ length: 60 }, (_, i) => `w${i + 1}`);
    const prompt = validPrompt({ context: words.join(" ") });
    const result = validateTaskPrompt(prompt, { contextWordLimit: 50 });
    assert.ok(result.warnings.some((e) => e.includes("CONTEXT is")));
  });

  it("uses custom promptWordLimit over default", () => {
    // Total ~160 words exceeds custom limit of 100
    const contextWords = Array.from({ length: 50 }, (_, i) => `w${i + 1}`);
    const extra = Array.from({ length: 60 }, (_, i) => `w${i + 1}`);
    const prompt = [
      `SUMMARY: ${extra.join(" ")}`,
      `CONTEXT: ${contextWords.join(" ")}`,
      `ACCEPTANCE: Fix bug`,
    ].join("\n");
    const result = validateTaskPrompt(prompt, { promptWordLimit: 100 });
    assert.ok(result.warnings.some((e) => e.includes("concise")));
  });

  it("skips total word check when promptWordLimit is omitted", () => {
    // Only set contextWordLimit; promptWordLimit omitted → skip total check.
    const words = Array.from({ length: 101 }, (_, i) => `w${i + 1}`);
    const prompt = validPrompt({ context: words.join(" ") });
    const result = validateTaskPrompt(prompt, { contextWordLimit: 200 });
    // 101 < 200 → no context warning
    assert.equal(
      result.warnings.filter((w) => w.includes("CONTEXT is")).length,
      0,
    );
    // total_words check skipped because promptWordLimit is undefined
    assert.equal(
      result.warnings.filter((w) => w.includes("concise")).length,
      0,
    );
  });

  it("skips all soft checks when limits object is empty", () => {
    const words = Array.from({ length: 101 }, (_, i) => `w${i + 1}`);
    const prompt = validPrompt({ context: words.join(" ") });
    const result = validateTaskPrompt(prompt, {});
    // Both limits undefined → both soft checks skipped
    assert.equal(result.warnings.length, 0);
  });
});

// ---------------------------------------------------------------------------
// CONTEXT word count warnings
// ---------------------------------------------------------------------------

describe("CONTEXT word count warnings", () => {
  it("warns when CONTEXT equals limit + 1 (boundary)", () => {
    const words = Array.from({ length: 101 }, (_, i) => `w${i + 1}`);
    const prompt = validPrompt({ context: words.join(" ") });
    const result = validateTaskPrompt(prompt, { contextWordLimit: 100 });
    assert.ok(result.warnings.some((e) => e.includes("101 words")));
  });

  it("does not warn when CONTEXT is exactly at limit", () => {
    const words = Array.from({ length: 100 }, (_, i) => `w${i + 1}`);
    const prompt = validPrompt({ context: words.join(" ") });
    const result = validateTaskPrompt(prompt, { contextWordLimit: 100 });
    assert.equal(
      result.warnings.filter((w) => w.includes("CONTEXT is")).length,
      0,
    );
  });

  it("reports ctx_words in return value", () => {
    const words = Array.from({ length: 42 }, (_, i) => `w${i + 1}`);
    const prompt = validPrompt({ context: words.join(" ") });
    const result = validateTaskPrompt(prompt);
    assert.equal(result.ctx_words, 42);
  });
});

// ---------------------------------------------------------------------------
// Total prompt word count warnings
// ---------------------------------------------------------------------------

describe("total prompt word count warnings", () => {
  it("warns when total exceeds promptWordLimit=250", () => {
    // Total = 3 header words + 250 summary + 2 context + 1 acceptance = 256 > 250
    const longSummary = Array.from({ length: 250 }, (_, i) => `w${i + 1}`);
    const prompt = [
      `SUMMARY: ${longSummary.join(" ")}`,
      "CONTEXT: Short context",
      "ACCEPTANCE: Pass",
    ].join("\n");
    const result = validateTaskPrompt(prompt, { promptWordLimit: 250 });
    assert.ok(result.warnings.some((e) => e.includes("concise")));
  });

  it("does not warn when total is under the limit", () => {
    const prompt = validPrompt();
    const result = validateTaskPrompt(prompt, { promptWordLimit: 250 });
    assert.equal(
      result.warnings.filter((w) => w.includes("concise")).length,
      0,
    );
  });
});

// ---------------------------------------------------------------------------
// Skip behavior when limits are undefined
// ---------------------------------------------------------------------------

describe("skip behavior when limits are undefined", () => {
  it("skips CONTENT word count check when contextWordLimit is undefined", () => {
    const words = Array.from({ length: 999 }, (_, i) => `w${i + 1}`);
    const prompt = validPrompt({ context: words.join(" ") });
    const result = validateTaskPrompt(prompt, {
      contextWordLimit: undefined,
      promptWordLimit: 5000,
    });
    // No CONTEXT word warning despite 999 words
    const ctxWarnings = result.warnings.filter((w) => w.includes("CONTEXT is"));
    assert.equal(ctxWarnings.length, 0);
  });

  it("skips total word count check when promptWordLimit is undefined", () => {
    const longSummary = Array.from({ length: 999 }, (_, i) => `w${i + 1}`);
    const prompt = [
      `SUMMARY: ${longSummary.join(" ")}`,
      "CONTEXT: Short context",
      "ACCEPTANCE: Pass",
    ].join("\n");
    const result = validateTaskPrompt(prompt, {
      contextWordLimit: 5000,
      promptWordLimit: undefined,
    });
    // No total word warning despite ~1002 words
    const totalWarnings = result.warnings.filter((w) => w.includes("concise"));
    assert.equal(totalWarnings.length, 0);
  });

  it("pattern nudges still fire when both limits are undefined", () => {
    const prompt = validPrompt({
      context:
        "The bug is at src/db.py line 42. Code:\n```\ndef foo()\n```\nFix the issue.",
    });
    const result = validateTaskPrompt(prompt, {});
    // Hard checks still pass (sections present)
    assert.equal(result.valid, true);
    // Pattern nudges still fire (code blocks + line refs)
    assert.ok(result.warnings.some((w) => w.includes("code blocks")));
    assert.ok(result.warnings.some((w) => w.includes("line references")));
  });

  it("hard section checks still fire when both limits are undefined", () => {
    const prompt = "CONTEXT: Some context\nACCEPTANCE: Tests pass";
    const result = validateTaskPrompt(prompt, {});
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes("SUMMARY")));
  });
});

// ---------------------------------------------------------------------------
// Code block detection warnings
// ---------------------------------------------------------------------------

describe("code block detection in CONTEXT", () => {
  it("warns when CONTEXT contains triple backticks", () => {
    const prompt = validPrompt({
      context: "Signature:\n```\ndef foo(x: int) -> str:\n```\nDo not modify.",
    });
    const result = validateTaskPrompt(prompt);
    assert.ok(result.warnings.some((e) => e.includes("code blocks")));
    assert.equal(result.valid, true);
  });

  it("does not warn when CONTEXT has no backticks", () => {
    const prompt = validPrompt();
    const result = validateTaskPrompt(prompt);
    assert.equal(
      result.warnings.filter((w) => w.includes("code blocks")).length,
      0,
    );
  });
});

// ---------------------------------------------------------------------------
// Line reference detection warnings
// ---------------------------------------------------------------------------

describe("line reference detection in CONTEXT", () => {
  it('warns on English "line N" references', () => {
    const prompt = validPrompt({
      context: "The bug is at src/db.py line 42. Fix it.",
    });
    const result = validateTaskPrompt(prompt);
    assert.ok(result.warnings.some((e) => e.includes("line references")));
  });

  it('warns on Chinese "行 N" references', () => {
    const prompt = validPrompt({
      context: "问题出现在 src/db.py 行 42 位置",
    });
    const result = validateTaskPrompt(prompt);
    assert.ok(result.warnings.some((e) => e.includes("line references")));
  });

  it('warns on Chinese "第 N 行" references', () => {
    const prompt = validPrompt({
      context: "bug 在 handler.go 第 15 行",
    });
    const result = validateTaskPrompt(prompt);
    assert.ok(result.warnings.some((e) => e.includes("line references")));
  });

  it("does not warn on CONTEXT without line references", () => {
    const prompt = validPrompt();
    const result = validateTaskPrompt(prompt);
    assert.equal(
      result.warnings.filter((w) => w.includes("line references")).length,
      0,
    );
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("edge cases", () => {
  it("handles empty prompt string", () => {
    const result = validateTaskPrompt("");
    assert.equal(result.valid, false);
    assert.equal(result.ctx_words, 0);
  });

  it("handles prompt with only whitespace", () => {
    const result = validateTaskPrompt("   \n  \n   ");
    assert.equal(result.valid, false);
  });

  it("warns about both code blocks and line refs simultaneously", () => {
    const prompt = validPrompt({
      context:
        "The bug is at src/db.py line 42. Code:\n```\ndef foo()\n```\nFix the issue.",
    });
    const result = validateTaskPrompt(prompt);
    const codeWarnings = result.warnings.filter((w) =>
      w.includes("code blocks"),
    );
    const lineWarnings = result.warnings.filter((w) =>
      w.includes("line references"),
    );
    assert.ok(codeWarnings.length >= 1);
    assert.ok(lineWarnings.length >= 1);
  });
});
