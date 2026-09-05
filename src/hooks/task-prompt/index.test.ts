/**
 * Tests for the ZooKeeper plugin's task prompt validation judge.
 *
 * These tests cover `validateTaskPrompt()` — the core function used by the
 * task-prompt delegation judge to verify task() prompt format — plus the
 * judge wrapper (`judgeTaskPrompt`) and the tool-definition / output-nudge
 * handlers that were part of the same hook unit.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  enhanceTaskDefinition,
  judgeTaskPrompt,
  nudgeTaskOutput,
  TASK_PROMPT_HINT,
  type ValidationLimits,
  validateTaskPrompt,
} from "./index.js";

// Limits mirror `[zoo.validation]` in config.toml — the plugin entry point
// derives them via parseLimits and passes them to the hook adapters.
const limits: ValidationLimits = {
  contextWordLimit: 200,
  promptWordLimit: 500,
};

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
// Section extraction
// ---------------------------------------------------------------------------

describe("extractSections (via validateTaskPrompt)", () => {
  it("accepts plain SUMMARY / CONTEXT / ACCEPTANCE headers", () => {
    const prompt = validPrompt();
    const result = validateTaskPrompt(prompt);
    assert.equal(result.valid, true);
    assert.deepEqual(result.errors, []);
  });

  it("accepts dash-prefixed headers: - SUMMARY: ...", () => {
    const prompt = [
      "- SUMMARY: Fix the flaky auth test",
      "- CONTEXT: The auth.login test fails on CI",
      "- ACCEPTANCE: All tests pass",
    ].join("\n");
    const result = validateTaskPrompt(prompt);
    assert.equal(result.valid, true);
  });

  it("accepts bold headers: **SUMMARY:** ...", () => {
    const prompt = [
      "**SUMMARY:** Fix the flaky auth test",
      "**CONTEXT:** The auth.login test fails on CI",
      "**ACCEPTANCE:** All tests pass",
    ].join("\n");
    const result = validateTaskPrompt(prompt);
    assert.equal(result.valid, true);
  });

  it("accepts dash + bold: - **SUMMARY:** ...", () => {
    const prompt = [
      "- **SUMMARY:** Fix the flaky auth test",
      "- **CONTEXT:** The auth.login test fails on CI",
      "- **ACCEPTANCE:** All tests pass",
    ].join("\n");
    const result = validateTaskPrompt(prompt);
    assert.equal(result.valid, true);
  });

  it("treats content after colon on header line as section content", () => {
    const prompt = [
      "SUMMARY: Fix the flaky auth test",
      "This is still part of summary",
      "CONTEXT: The auth.login test fails on CI",
      "More context here",
      "ACCEPTANCE: All tests pass",
    ].join("\n");
    const result = validateTaskPrompt(prompt);
    assert.equal(result.valid, true);
  });

  it("reports missing SUMMARY", () => {
    const prompt = [
      "CONTEXT: The auth.login test fails on CI",
      "ACCEPTANCE: All tests pass",
    ].join("\n");
    const result = validateTaskPrompt(prompt);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes("SUMMARY")));
  });

  it("reports missing CONTEXT", () => {
    const prompt = [
      "SUMMARY: Fix the flaky auth test",
      "ACCEPTANCE: All tests pass",
    ].join("\n");
    const result = validateTaskPrompt(prompt);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes("CONTEXT")));
  });

  it("reports missing ACCEPTANCE", () => {
    const prompt = [
      "SUMMARY: Fix the flaky auth test",
      "CONTEXT: The auth.login test fails on CI",
    ].join("\n");
    const result = validateTaskPrompt(prompt);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes("ACCEPTANCE")));
  });

  it("reports all missing sections at once", () => {
    const prompt = "Some random text without any sections";
    const result = validateTaskPrompt(prompt);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes("SUMMARY")));
    assert.ok(result.errors.some((e) => e.includes("CONTEXT")));
    assert.ok(result.errors.some((e) => e.includes("ACCEPTANCE")));
  });
});

// ---------------------------------------------------------------------------
// Word count limits → soft warnings
// ---------------------------------------------------------------------------

describe("CONTEXT word count limit — soft warning", () => {
  it("passes when CONTEXT is exactly at contextWordLimit", () => {
    const words = Array.from({ length: 100 }, (_, i) => `word${i + 1}`);
    const prompt = validPrompt({ context: words.join(" ") });
    const result = validateTaskPrompt(prompt, { contextWordLimit: 100 });
    assert.equal(result.valid, true);
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.warnings, []);
  });

  it("warns when CONTEXT exceeds contextWordLimit", () => {
    const words = Array.from({ length: 101 }, (_, i) => `word${i + 1}`);
    const prompt = validPrompt({ context: words.join(" ") });
    const result = validateTaskPrompt(prompt, { contextWordLimit: 100 });
    assert.equal(result.valid, true);
    assert.deepEqual(result.errors, []);
    assert.ok(result.warnings.some((e) => e.includes("101 words")));
  });

  it("reports the actual word count in the warning", () => {
    const words = Array.from({ length: 150 }, (_, i) => `word${i + 1}`);
    const prompt = validPrompt({ context: words.join(" ") });
    const result = validateTaskPrompt(prompt, { contextWordLimit: 100 });
    assert.ok(result.warnings[0].includes("150"));
  });
});

describe("total prompt word count limit — soft warning", () => {
  it("passes when total is well under promptWordLimit", () => {
    const contextWords = Array.from({ length: 97 }, (_, i) => `word${i + 1}`);
    const prompt = validPrompt({
      summary: "Fix the bug",
      context: contextWords.join(" "),
      acceptance: "All tests pass",
    });
    // Total = 3 (headers) + 3 (summary) + 97 (context) + 3 (acceptance) = 106
    const result = validateTaskPrompt(prompt, { promptWordLimit: 250 });
    assert.equal(result.valid, true);
    assert.deepEqual(result.warnings, []);
  });

  it("passes when total is under promptWordLimit with 100-word CONTEXT", () => {
    const contextWords = Array.from({ length: 100 }, (_, i) => `word${i + 1}`);
    const prompt = validPrompt({
      summary: "Fix",
      context: contextWords.join(" "),
      acceptance: "All pass",
    });
    // Total = 3 (headers) + 1 (summary) + 100 (context) + 2 (acceptance) = 106
    const result = validateTaskPrompt(prompt, { promptWordLimit: 250 });
    assert.equal(result.valid, true);
    assert.deepEqual(result.warnings, []);
  });

  it("warns when total exceeds promptWordLimit", () => {
    const summaryWords = Array.from({ length: 100 }, (_, i) => `word${i + 1}`);
    const contextWords = Array.from({ length: 50 }, (_, i) => `word${i + 1}`);
    const acceptanceWords = Array.from(
      { length: 100 },
      (_, i) => `word${i + 1}`,
    );
    const prompt = [
      `SUMMARY: ${summaryWords.join(" ")}`,
      `CONTEXT: ${contextWords.join(" ")}`,
      `ACCEPTANCE: ${acceptanceWords.join(" ")}`,
    ].join("\n");
    // Total = 3 + 100 + 50 + 100 = 253 > 250
    const result = validateTaskPrompt(prompt, { promptWordLimit: 250 });
    assert.equal(result.valid, true);
    assert.deepEqual(result.errors, []);
    assert.ok(
      result.warnings.some(
        (e) => e.includes("253 words") || e.includes("concise"),
      ),
    );
  });
});

// ---------------------------------------------------------------------------
// Configurable word-count limits
// ---------------------------------------------------------------------------

describe("validateTaskPrompt with custom limits", () => {
  it("uses custom contextWordLimit instead of default 100", () => {
    // With default 100, 80 words would pass; with custom 50, 80 words warns
    const contextWords = Array.from({ length: 80 }, (_, i) => `word${i + 1}`);
    const prompt = validPrompt({ context: contextWords.join(" ") });
    const result = validateTaskPrompt(prompt, { contextWordLimit: 50 });
    assert.equal(result.valid, true);
    assert.deepEqual(result.errors, []);
    assert.ok(result.warnings.some((e) => e.includes("80 words")));
  });

  it("passes context word count check with generous limit", () => {
    const contextWords = Array.from({ length: 200 }, (_, i) => `word${i + 1}`);
    const prompt = validPrompt({ context: contextWords.join(" ") });
    const result = validateTaskPrompt(prompt, { contextWordLimit: 250 });
    assert.equal(result.valid, true);
    assert.deepEqual(result.errors, []);
    assert.equal(
      result.warnings.filter((w) => w.includes("CONTEXT is")).length,
      0,
    );
  });

  it("uses custom promptWordLimit instead of default 250", () => {
    const contextWords = Array.from({ length: 50 }, (_, i) => `word${i + 1}`);
    const summaryWords = Array.from({ length: 80 }, (_, i) => `word${i + 1}`);
    const acceptanceWords = Array.from(
      { length: 80 },
      (_, i) => `word${i + 1}`,
    );
    const prompt = [
      `SUMMARY: ${summaryWords.join(" ")}`,
      `CONTEXT: ${contextWords.join(" ")}`,
      `ACCEPTANCE: ${acceptanceWords.join(" ")}`,
    ].join("\n");
    // Total ≈ 3 + 80 + 50 + 80 = 213, which exceeds custom limit of 150
    const result = validateTaskPrompt(prompt, { promptWordLimit: 150 });
    assert.equal(result.valid, true);
    assert.deepEqual(result.errors, []);
    assert.ok(result.warnings.some((e) => e.includes("concise")));
  });

  it("passes total word count check with generous limit", () => {
    const contextWords = Array.from({ length: 80 }, (_, i) => `word${i + 1}`);
    const summaryWords = Array.from({ length: 100 }, (_, i) => `word${i + 1}`);
    const acceptanceWords = Array.from(
      { length: 100 },
      (_, i) => `word${i + 1}`,
    );
    const prompt = [
      `SUMMARY: ${summaryWords.join(" ")}`,
      `CONTEXT: ${contextWords.join(" ")}`,
      `ACCEPTANCE: ${acceptanceWords.join(" ")}`,
    ].join("\n");
    // Total ≈ 3 + 100 + 80 + 100 = 283, but custom limit of 500 passes
    const result = validateTaskPrompt(prompt, { promptWordLimit: 500 });
    assert.equal(result.valid, true);
    assert.deepEqual(result.errors, []);
    assert.equal(
      result.warnings.filter((w) => w.includes("concise")).length,
      0,
    );
  });

  it("accepts both limits overridden simultaneously", () => {
    const contextWords = Array.from({ length: 60 }, (_, i) => `word${i + 1}`);
    const prompt = validPrompt({ context: contextWords.join(" ") });
    // 60 > 50 (context limit) → warn; total ≈ 3+3+60+3 = 69 < 300 → no total warn
    const result = validateTaskPrompt(prompt, {
      contextWordLimit: 50,
      promptWordLimit: 300,
    });
    assert.equal(result.valid, true);
    assert.deepEqual(result.errors, []);
    assert.ok(result.warnings.some((e) => e.includes("60 words")));
    assert.equal(
      result.warnings.filter((w) => w.includes("concise")).length,
      0,
    );
  });

  it("skips context word check when contextWordLimit is omitted (only promptWordLimit given)", () => {
    // Only override promptWordLimit; contextWordLimit omitted → skip context check.
    const contextWords = Array.from({ length: 101 }, (_, i) => `word${i + 1}`);
    const prompt = validPrompt({ context: contextWords.join(" ") });
    const result = validateTaskPrompt(prompt, { promptWordLimit: 300 });
    // contextWordLimit is undefined → skip CONTEXT word count check
    assert.equal(result.valid, true);
    assert.deepEqual(result.errors, []);
    assert.equal(
      result.warnings.filter((w) => w.includes("CONTEXT is")).length,
      0,
    );
    // prompt is ~107 words, well under 300 → no total warning
    assert.equal(
      result.warnings.filter((w) => w.includes("concise")).length,
      0,
    );
  });
});

// ---------------------------------------------------------------------------
// Forbidden patterns in CONTEXT → soft warnings
// ---------------------------------------------------------------------------

describe("forbidden patterns in CONTEXT — soft warning", () => {
  it("warns on triple-backtick code blocks in CONTEXT", () => {
    const prompt = validPrompt({
      context:
        "The function signature is:\n```\ndef foo()\n```\nDo not change it.",
    });
    const result = validateTaskPrompt(prompt);
    assert.equal(result.valid, true);
    assert.deepEqual(result.errors, []);
    assert.ok(result.warnings.some((e) => e.includes("code blocks")));
  });

  it('warns on "line N" references in CONTEXT', () => {
    const prompt = validPrompt({
      context: "The bug is at src/db.py line 42. Fix it.",
    });
    const result = validateTaskPrompt(prompt);
    assert.equal(result.valid, true);
    assert.deepEqual(result.errors, []);
    assert.ok(result.warnings.some((e) => e.includes("line references")));
  });

  it('warns on "行 N" references in CONTEXT', () => {
    const prompt = validPrompt({
      context: "问题出现在 src/db.py 行 42 位置",
    });
    const result = validateTaskPrompt(prompt);
    assert.equal(result.valid, true);
    assert.deepEqual(result.errors, []);
    assert.ok(result.warnings.some((e) => e.includes("line references")));
  });

  it('warns on "第 N 行" references in CONTEXT', () => {
    const prompt = validPrompt({
      context:
        "bug 在 src/api/handler.go 第 42 行，response 对象没有做 nil 检查",
    });
    const result = validateTaskPrompt(prompt);
    assert.equal(result.valid, true);
    assert.deepEqual(result.errors, []);
    assert.ok(result.warnings.some((e) => e.includes("line references")));
  });

  it("reports multiple nudge patterns at once", () => {
    const prompt = validPrompt({
      context:
        "The bug is at src/db.py line 42. Code:\n```\ndef foo()\n```\nFix the 行 42 issue.",
    });
    const result = validateTaskPrompt(prompt);
    assert.equal(result.valid, true);
    assert.deepEqual(result.errors, []);
    const codeBlockWarnings = result.warnings.filter((e) =>
      e.includes("code blocks"),
    );
    const lineRefWarnings = result.warnings.filter((e) =>
      e.includes("line references"),
    );
    assert.ok(codeBlockWarnings.length >= 1);
    assert.ok(lineRefWarnings.length >= 1);
  });

  it("passes when CONTEXT has no forbidden patterns", () => {
    const prompt = validPrompt({
      context:
        "The auth.login test fails intermittently on CI. Target file: tests/auth_test.py. The root cause appears to be a race condition in token refresh.",
    });
    const result = validateTaskPrompt(prompt);
    assert.equal(result.valid, true);
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.warnings, []);
  });
});

// ---------------------------------------------------------------------------
// Integration: realistic valid prompts
// ---------------------------------------------------------------------------

describe("realistic valid prompts", () => {
  it("passes a well-formed bug-fix prompt", () => {
    const prompt = [
      "SUMMARY: Fix the memory leak in the connection pool",
      "CONTEXT: Production shows OOM after 10k requests. The connection pool does not release idle connections. Target file: src/pool.py",
      "ACCEPTANCE: All pool tests pass, memory stays stable under load",
    ].join("\n");
    const result = validateTaskPrompt(prompt);
    assert.equal(result.valid, true);
  });

  it("passes a prompt with multi-line CONTEXT (≤ 100 words)", () => {
    const prompt = [
      "SUMMARY: Add input validation to the user API",
      "CONTEXT: The /api/user endpoint accepts arbitrary JSON without validation.",
      "Must reject invalid emails and duplicate usernames.",
      "Existing tests in tests/test_user_api.py should still pass.",
      "ACCEPTANCE: New tests cover email format and duplicate rejection",
    ].join("\n");
    const result = validateTaskPrompt(prompt);
    assert.equal(result.valid, true);
  });

  it("passes a prompt with a single-word summary", () => {
    const prompt = [
      "- SUMMARY: Refactor",
      "- CONTEXT: The logging module has grown too large and needs to be split into smaller files under src/logging/. Keep the public API unchanged.",
      "- ACCEPTANCE: Lint passes, all existing tests pass",
    ].join("\n");
    const result = validateTaskPrompt(prompt);
    assert.equal(result.valid, true);
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("edge cases", () => {
  it("handles empty prompt", () => {
    const result = validateTaskPrompt("");
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes("SUMMARY")));
  });

  it("handles prompt with only whitespace", () => {
    const result = validateTaskPrompt("   \n  \n   ");
    assert.equal(result.valid, false);
  });

  it("handles prompt with sections out of order", () => {
    // order shouldn't matter — section extraction is order-independent
    const prompt = [
      "CONTEXT: The auth.login test fails on CI",
      "SUMMARY: Fix the flaky auth test",
      "ACCEPTANCE: All tests pass",
    ].join("\n");
    const result = validateTaskPrompt(prompt);
    assert.equal(result.valid, true);
  });

  it('handles "line" as a substring of a larger word', () => {
    // "outline" contains "line" but is not a line-number reference
    const prompt = validPrompt({
      context: "The outline of the plan is to refactor the module",
    });
    const result = validateTaskPrompt(prompt);
    assert.equal(result.valid, true);
  });

  it("handles very long prompt gracefully with explicit limits", () => {
    const longContext = "word ".repeat(300).trim();
    const prompt = validPrompt({ context: longContext });
    const result = validateTaskPrompt(prompt, {
      contextWordLimit: 100,
      promptWordLimit: 200,
    });
    // Sections are present → valid, word count issues are soft warnings
    assert.equal(result.valid, true);
    assert.deepEqual(result.errors, []);
    assert.ok(
      result.warnings.some(
        (e) => e.includes("300 words") || e.includes("splitting"),
      ),
    );
    assert.ok(result.warnings.some((e) => e.includes("concise")));
  });
});

// ---------------------------------------------------------------------------
// tool.definition enhancement (enhanceTaskDefinition)
// ---------------------------------------------------------------------------

describe("tool.definition enhancement", () => {
  it("appends hint to the prompt argument description when the tool is subagent", () => {
    const view = {
      name: "subagent",
      description: "Run a task for the dolphin agent",
      args: {
        prompt: {
          description: "The task prompt",
          type: "string",
        },
      },
    };
    enhanceTaskDefinition(view);
    assert.equal(
      view.args.prompt.description,
      `The task prompt\n\n${TASK_PROMPT_HINT}`,
    );
  });

  it("does NOT modify other tools (e.g. the tool named grep)", () => {
    const view = {
      name: "grep",
      description: "Search file contents",
      args: {
        pattern: {
          description: "Search pattern",
          type: "string",
        },
      },
    };
    // Capture a snapshot before
    const originalDesc = view.args.pattern.description;
    enhanceTaskDefinition(view);
    // Should remain unchanged
    assert.equal(view.args.pattern.description, originalDesc);
  });

  it("handles a view without args gracefully", () => {
    const view = {
      name: "subagent",
      description: "Run a task",
      // No args at all
    };
    // Should not throw
    enhanceTaskDefinition(view);
    // View remains as-is
    assert.equal(view.description, "Run a task");
  });

  it("handles a missing prompt argument gracefully", () => {
    const view = {
      name: "subagent",
      description: "Run a task",
      args: {
        // No 'prompt' argument
        pattern: {
          description: "Some other param",
          type: "string",
        },
      },
    };
    // Should not throw
    enhanceTaskDefinition(view);
    assert.equal(view.description, "Run a task");
  });

  it("preserves existing description text (appends, doesn't replace)", () => {
    const existingDesc = "Original prompt description text";
    const view = {
      name: "subagent",
      description: "Run a task",
      args: {
        prompt: {
          description: existingDesc,
          type: "string",
        },
      },
    };
    enhanceTaskDefinition(view);
    // Existing text should be preserved, hint appended after double newline
    assert.ok(view.args.prompt.description.startsWith(existingDesc));
    assert.ok(view.args.prompt.description.includes(TASK_PROMPT_HINT));
    assert.equal(
      view.args.prompt.description,
      `${existingDesc}\n\n${TASK_PROMPT_HINT}`,
    );
  });
});

// ---------------------------------------------------------------------------
// task-prompt delegation judge (judgeTaskPrompt)
// ---------------------------------------------------------------------------

describe("judgeTaskPrompt", () => {
  it("valid prompt allows (returns null)", () => {
    const refusal = judgeTaskPrompt(
      { caller: "dolphin", target: "beaver", prompt: validPrompt() },
      limits,
    );
    assert.equal(refusal, null);
  });

  it("invalid prompt refuses with the format error text", () => {
    const refusal = judgeTaskPrompt(
      {
        caller: "dolphin",
        target: "beaver",
        prompt: "Some random text without any sections",
      },
      limits,
    );
    assert.ok(refusal !== null);
    assert.ok(refusal.reason.includes("Task prompt format error"));
    assert.ok(refusal.reason.includes("SUMMARY"));
    assert.ok(refusal.reason.includes("CONTEXT"));
    assert.ok(refusal.reason.includes("ACCEPTANCE"));
    assert.ok(refusal.reason.includes("Required format"));
  });

  it("does not refuse on CONTEXT too long — soft warnings go to the nudge", () => {
    const longContext = "word ".repeat(201).trim();
    const prompt = validPrompt({ context: longContext });
    const refusal = judgeTaskPrompt(
      { caller: "dolphin", target: "beaver", prompt },
      limits,
    );
    assert.equal(refusal, null);
    // The nudge is delivered via nudgeTaskOutput (after-exec).
    const afterOutput: { output?: string } = {
      output: "Task completed successfully",
    };
    nudgeTaskOutput(
      { tool: "subagent", sessionID: "s1", callID: "c1", args: { prompt } },
      afterOutput,
      limits,
    );
    assert.ok(afterOutput.output?.includes("Guidance for next time"));
    assert.ok(afterOutput.output?.includes("201 words"));
  });

  it("does not refuse on line references — soft warnings go to the nudge", () => {
    const prompt = validPrompt({
      context: "The bug is at src/db.py line 42. Fix it.",
    });
    const refusal = judgeTaskPrompt(
      { caller: "dolphin", target: "beaver", prompt },
      limits,
    );
    assert.equal(refusal, null);
    const afterOutput: { output?: string } = {
      output: "Task completed successfully",
    };
    nudgeTaskOutput(
      { tool: "subagent", sessionID: "s1", callID: "c1", args: { prompt } },
      afterOutput,
      limits,
    );
    assert.ok(afterOutput.output?.includes("Guidance for next time"));
    assert.ok(afterOutput.output?.includes("line references"));
  });

  it("allows when the prompt is missing (skip semantics)", () => {
    const refusal = judgeTaskPrompt(
      { caller: "dolphin", target: "beaver", prompt: undefined },
      limits,
    );
    assert.equal(refusal, null);
  });

  it("rejects an empty prompt string (empty string is still validated)", () => {
    const refusal = judgeTaskPrompt(
      { caller: "dolphin", target: "beaver", prompt: "" as never },
      limits,
    );
    // Empty string is still a string — the gate boundary converts a
    // non-string argument to `undefined` before the judge runs.
    assert.ok(refusal !== null);
  });
});

// ---------------------------------------------------------------------------
// tool.execute.after hook (nudgeTaskOutput — soft nudges)
// ---------------------------------------------------------------------------

describe("tool.execute.after hook (nudge delivery)", () => {
  it("appends nudges when prompt has soft warnings", () => {
    const longContext = "word ".repeat(201).trim();
    const prompt = validPrompt({ context: longContext });
    const output: { output?: string } = {
      output: "Task result here",
    };
    nudgeTaskOutput(
      { tool: "subagent", sessionID: "s1", callID: "c1", args: { prompt } },
      output,
      limits,
    );
    assert.ok(output.output?.includes("Guidance for next time"));
    assert.ok(output.output?.includes("201 words"));
    // Original output preserved
    assert.ok(output.output?.startsWith("Task result here"));
  });

  it("does NOT append nudges when prompt is clean", () => {
    const prompt = validPrompt(); // short, no forbidden patterns
    const output: { output?: string } = {
      output: "Task completed",
    };
    nudgeTaskOutput(
      { tool: "subagent", sessionID: "s1", callID: "c1", args: { prompt } },
      output,
      limits,
    );
    assert.equal(output.output, "Task completed");
  });

  it("non-subagent tools are skipped", () => {
    const prompt = validPrompt({
      context: "line 42 bug here", // would trigger nudge if this were subagent
    });
    const output: { output?: string } = {
      output: "grep result",
    };
    nudgeTaskOutput(
      { tool: "grep", sessionID: "s1", callID: "c1", args: { prompt } },
      output,
      limits,
    );
    assert.equal(output.output, "grep result");
  });
});

describe("word count precision", () => {
  it("counts hyphenated words as single words", () => {
    const prompt = validPrompt({
      context: "well-known edge-case test-driven-development",
    });
    const result = validateTaskPrompt(prompt);
    assert.equal(result.valid, true);
  });

  it("counts words separated by multiple spaces correctly", () => {
    const prompt = [
      "SUMMARY: Test",
      "CONTEXT: word1    word2    word3",
      "ACCEPTANCE: Pass",
    ].join("\n");
    const result = validateTaskPrompt(prompt);
    assert.equal(result.valid, true);
  });

  it("counts words separated by newlines correctly", () => {
    const prompt = [
      "SUMMARY: Test",
      "CONTEXT:",
      "word1",
      "word2",
      "word3",
      "ACCEPTANCE: Pass",
    ].join("\n");
    const result = validateTaskPrompt(prompt);
    assert.equal(result.valid, true);
  });
});
