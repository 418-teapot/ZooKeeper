/**
 * Tests for the ZooKeeper OpenCode plugin's task prompt validation logic.
 *
 * These tests cover `validateTaskPrompt()` — the core function used by the
 * `tool.execute.before` hook to verify dolphin agent `task()` prompt format.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { zookeeper } from "../../opencode.js";
import { TASK_PROMPT_HINT, validateTaskPrompt } from "./index.js";

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

describe("CONTEXT word count limit (≤ 100) — soft warning", () => {
  it("passes when CONTEXT is exactly 100 words", () => {
    // Generate exactly 100 words
    const words = Array.from({ length: 100 }, (_, i) => `word${i + 1}`);
    const prompt = validPrompt({ context: words.join(" ") });
    const result = validateTaskPrompt(prompt);
    assert.equal(result.valid, true);
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.warnings, []);
  });

  it("warns when CONTEXT exceeds 100 words", () => {
    const words = Array.from({ length: 101 }, (_, i) => `word${i + 1}`);
    const prompt = validPrompt({ context: words.join(" ") });
    const result = validateTaskPrompt(prompt);
    assert.equal(result.valid, true);
    assert.deepEqual(result.errors, []);
    assert.ok(result.warnings.some((e) => e.includes("101 words")));
  });

  it("reports the actual word count in the warning", () => {
    const words = Array.from({ length: 150 }, (_, i) => `word${i + 1}`);
    const prompt = validPrompt({ context: words.join(" ") });
    const result = validateTaskPrompt(prompt);
    assert.ok(result.warnings[0].includes("150"));
  });
});

describe("total prompt word count limit (≤ 250) — soft warning", () => {
  it("passes when total is well under 250 and CONTEXT is under 100", () => {
    const contextWords = Array.from({ length: 97 }, (_, i) => `word${i + 1}`);
    const prompt = validPrompt({
      summary: "Fix the bug",
      context: contextWords.join(" "),
      acceptance: "All tests pass",
    });
    // Total = 3 (headers) + 3 (summary) + 97 (context) + 3 (acceptance) = 106
    const result = validateTaskPrompt(prompt);
    assert.equal(result.valid, true);
    assert.deepEqual(result.warnings, []);
  });

  it("passes when CONTEXT is exactly 100 and total is under 250", () => {
    const contextWords = Array.from({ length: 100 }, (_, i) => `word${i + 1}`);
    const prompt = validPrompt({
      summary: "Fix",
      context: contextWords.join(" "),
      acceptance: "All pass",
    });
    // Total = 3 (headers) + 1 (summary) + 100 (context) + 2 (acceptance) = 106
    const result = validateTaskPrompt(prompt);
    assert.equal(result.valid, true);
    assert.deepEqual(result.warnings, []);
  });

  it("warns when CONTEXT is moderate but total exceeds 250", () => {
    // CONTEXT = 50 words (well under 100 limit)
    // We need SUMMARY + ACCEPTANCE to push total over 250
    // Total = 3 (headers) + S + 50 + A > 250  →  S + A > 197
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
    const result = validateTaskPrompt(prompt);
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

  it("uses default for omitted limit when only one is provided (partial)", () => {
    // Only override promptWordLimit; contextWordLimit stays at default 100
    const contextWords = Array.from({ length: 101 }, (_, i) => `word${i + 1}`);
    const prompt = validPrompt({ context: contextWords.join(" ") });
    const result = validateTaskPrompt(prompt, { promptWordLimit: 300 });
    // contextWordLimit defaults to 100 → 101 > 100 should warn
    assert.equal(result.valid, true);
    assert.deepEqual(result.errors, []);
    assert.ok(result.warnings.some((e) => e.includes("101 words")));
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

  it("handles very long prompt gracefully", () => {
    const longContext = "word ".repeat(300).trim();
    const prompt = validPrompt({ context: longContext });
    const result = validateTaskPrompt(prompt);
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
// tool.definition hook
// ---------------------------------------------------------------------------

describe("tool.definition hook", () => {
  it("appends hint to prompt parameter description when toolID is task", async () => {
    const plugin = await zookeeper({});
    const output = {
      description: "Run a task for the dolphin agent",
      parameters: {
        type: "object",
        properties: {
          prompt: {
            description: "The task prompt",
            type: "string",
          },
        },
      },
    };
    await plugin["tool.definition"]({ toolID: "task" }, output);
    assert.equal(
      output.parameters.properties.prompt.description,
      `The task prompt\n\n${TASK_PROMPT_HINT}`,
    );
  });

  it("does NOT modify other tools (e.g. toolID is grep)", async () => {
    const plugin = await zookeeper({});
    const output = {
      description: "Search file contents",
      parameters: {
        type: "object",
        properties: {
          pattern: {
            description: "Search pattern",
            type: "string",
          },
        },
      },
    };
    // Capture a snapshot before
    const originalDesc = output.parameters.properties.pattern.description;
    await plugin["tool.definition"]({ toolID: "grep" }, output);
    // Should remain unchanged
    assert.equal(
      output.parameters.properties.pattern.description,
      originalDesc,
    );
  });

  it("handles missing parameters gracefully", async () => {
    const plugin = await zookeeper({});
    const output = {
      description: "Run a task",
      // No parameters at all
    } as any;
    // Should not throw
    await plugin["tool.definition"]({ toolID: "task" }, output);
    // Output remains as-is
    assert.equal(output.description, "Run a task");
  });

  it("handles missing prompt property gracefully", async () => {
    const plugin = await zookeeper({});
    const output = {
      description: "Run a task",
      parameters: {
        type: "object",
        properties: {
          // No 'prompt' property
          pattern: {
            description: "Some other param",
            type: "string",
          },
        },
      },
    };
    // Should not throw
    await plugin["tool.definition"]({ toolID: "task" }, output);
    assert.equal(output.description, "Run a task");
  });

  it("preserves existing description text (appends, doesn't replace)", async () => {
    const plugin = await zookeeper({});
    const existingDesc = "Original prompt description text";
    const output = {
      description: "Run a task",
      parameters: {
        type: "object",
        properties: {
          prompt: {
            description: existingDesc,
            type: "string",
          },
        },
      },
    };
    await plugin["tool.definition"]({ toolID: "task" }, output);
    // Existing text should be preserved, hint appended after double newline
    assert.ok(
      output.parameters.properties.prompt.description.startsWith(existingDesc),
    );
    assert.ok(
      output.parameters.properties.prompt.description.includes(
        TASK_PROMPT_HINT,
      ),
    );
    assert.equal(
      output.parameters.properties.prompt.description,
      `${existingDesc}\n\n${TASK_PROMPT_HINT}`,
    );
  });
});

// ---------------------------------------------------------------------------
// tool.execute.before hook
// ---------------------------------------------------------------------------

describe("tool.execute.before hook", () => {
  it("valid prompt passes without throwing", async () => {
    const plugin = await zookeeper({});
    const prompt = validPrompt();
    await plugin["tool.execute.before"](
      { tool: "task", sessionID: "s1", callID: "c1" },
      { args: { prompt } },
    );
    // No throw means success
  });

  it("invalid prompt throws with format error", async () => {
    const plugin = await zookeeper({});
    const prompt = "Some random text without any sections";
    await assert.rejects(
      async () =>
        plugin["tool.execute.before"](
          { tool: "task", sessionID: "s1", callID: "c1" },
          { args: { prompt } },
        ),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        const e = err as Error;
        assert.ok(e.message.includes("Task prompt format error"));
        assert.ok(e.message.includes("SUMMARY"));
        assert.ok(e.message.includes("CONTEXT"));
        assert.ok(e.message.includes("ACCEPTANCE"));
        assert.ok(e.message.includes("Required format"));
        return true;
      },
    );
  });

  it("does not throw on CONTEXT too long — nudge delivered via tool.execute.after", async () => {
    const plugin = await zookeeper({});
    const longContext = "word ".repeat(201).trim();
    const prompt = validPrompt({ context: longContext });
    // Must not throw — structural check passes, warnings are soft
    await plugin["tool.execute.before"](
      { tool: "task", sessionID: "s1", callID: "c1" },
      { args: { prompt } },
    );
    // Now verify the nudge is appended via tool.execute.after
    const afterOutput: { output?: string } = {
      output: "Task completed successfully",
    };
    await plugin["tool.execute.after"](
      { tool: "task", sessionID: "s1", callID: "c1", args: { prompt } },
      afterOutput,
    );
    assert.ok(afterOutput.output?.includes("Guidance for next time"));
    assert.ok(afterOutput.output?.includes("201 words"));
  });

  it("does not throw on line references — nudge delivered via tool.execute.after", async () => {
    const plugin = await zookeeper({});
    const prompt = validPrompt({
      context: "The bug is at src/db.py line 42. Fix it.",
    });
    // Must not throw — structural check passes, warnings are soft
    await plugin["tool.execute.before"](
      { tool: "task", sessionID: "s1", callID: "c1" },
      { args: { prompt } },
    );
    // Now verify the nudge is appended via tool.execute.after
    const afterOutput: { output?: string } = {
      output: "Task completed successfully",
    };
    await plugin["tool.execute.after"](
      { tool: "task", sessionID: "s1", callID: "c1", args: { prompt } },
      afterOutput,
    );
    assert.ok(afterOutput.output?.includes("Guidance for next time"));
    assert.ok(afterOutput.output?.includes("line references"));
  });

  it("non-task tools are skipped", async () => {
    const plugin = await zookeeper({});
    // Even with an invalid prompt, non-task tools must not validate
    await plugin["tool.execute.before"](
      { tool: "grep", sessionID: "s1", callID: "c1" },
      { args: { prompt: "no sections at all here" } },
    );
    // No throw means success
  });

  it("missing args handled gracefully", async () => {
    const plugin = await zookeeper({});
    await plugin["tool.execute.before"](
      { tool: "task", sessionID: "s1", callID: "c1" },
      {}, // no args at all
    );
    // No throw means success
  });

  it("missing prompt in args handled gracefully", async () => {
    const plugin = await zookeeper({});
    await plugin["tool.execute.before"](
      { tool: "task", sessionID: "s1", callID: "c1" },
      { args: { someOtherField: "value" } },
    );
    // No throw means success
  });

  it("non-string prompt handled gracefully", async () => {
    const plugin = await zookeeper({});
    await plugin["tool.execute.before"](
      { tool: "task", sessionID: "s1", callID: "c1" },
      { args: { prompt: 123 } },
    );
    // No throw means success
  });

  it("null prompt handled gracefully", async () => {
    const plugin = await zookeeper({});
    await plugin["tool.execute.before"](
      { tool: "task", sessionID: "s1", callID: "c1" },
      { args: { prompt: null } },
    );
    // No throw means success
  });
});

// ---------------------------------------------------------------------------
// tool.execute.after hook (soft nudges)
// ---------------------------------------------------------------------------

describe("tool.execute.after hook (nudge delivery)", () => {
  it("appends nudges when prompt has soft warnings", async () => {
    const plugin = await zookeeper({});
    const longContext = "word ".repeat(201).trim();
    const prompt = validPrompt({ context: longContext });
    const output: { output?: string } = {
      output: "Task result here",
    };
    await plugin["tool.execute.after"](
      { tool: "task", sessionID: "s1", callID: "c1", args: { prompt } },
      output,
    );
    assert.ok(output.output?.includes("Guidance for next time"));
    assert.ok(output.output?.includes("201 words"));
    // Original output preserved
    assert.ok(output.output?.startsWith("Task result here"));
  });

  it("does NOT append nudges when prompt is clean", async () => {
    const plugin = await zookeeper({});
    const prompt = validPrompt(); // short, no forbidden patterns
    const output: { output?: string } = {
      output: "Task completed",
    };
    await plugin["tool.execute.after"](
      { tool: "task", sessionID: "s1", callID: "c1", args: { prompt } },
      output,
    );
    assert.equal(output.output, "Task completed");
  });

  it("non-task tools are skipped", async () => {
    const plugin = await zookeeper({});
    const prompt = validPrompt({
      context: "line 42 bug here", // would trigger nudge if this were task
    });
    const output: { output?: string } = {
      output: "grep result",
    };
    await plugin["tool.execute.after"](
      { tool: "grep", sessionID: "s1", callID: "c1", args: { prompt } },
      output,
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
