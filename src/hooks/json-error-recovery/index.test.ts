/**
 * Tests for the JSON error recovery hook.
 *
 * Covers pattern detection, excluded tools, deduplication, non-string output,
 * and false positives.
 */
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { zookeeper } from "../../index.js";
import {
  JSON_ERROR_PATTERNS,
  JSON_ERROR_REMINDER,
  JSON_ERROR_REMINDER_MARKER,
  JSON_ERROR_TOOL_EXCLUDE_LIST,
  JSON_ERROR_TOOL_EXCLUDES,
  recoverJsonError,
} from "./index.js";

// ---------------------------------------------------------------------------
// Constants / helpers
// ---------------------------------------------------------------------------

const ALL_TOOLS = JSON_ERROR_TOOL_EXCLUDE_LIST;

/**
 * Invoke recoverJsonError with the given tool and output and return the
 * mutated output object.
 */
function applyRecovery(tool: string, output: string): { output?: string } {
  const result: { output?: string } = { output };
  recoverJsonError({ tool }, result);
  return result;
}

/**
 * Assert that `obj.output` contains the reminder marker.
 */
function assertHasReminder(obj: { output?: string }, message?: string): void {
  assert.ok(
    obj.output?.includes(JSON_ERROR_REMINDER_MARKER),
    message ?? "expected output to contain reminder marker",
  );
}

// ---------------------------------------------------------------------------
// Detection — JSON error patterns append reminder
// ---------------------------------------------------------------------------

describe("JSON error detection", () => {
  it("detects 'json parse error' and appends reminder", () => {
    const res = applyRecovery("write", "json parse error: unexpected token");
    assertHasReminder(res);
  });

  it("detects 'SyntaxError: unexpected token in JSON' and appends reminder", () => {
    const res = applyRecovery(
      "write",
      "SyntaxError: unexpected token in JSON at position 42",
    );
    assertHasReminder(res);
  });

  it("does not modify normal output", () => {
    const res = applyRecovery("write", "Task completed successfully");
    assert.equal(res.output, "Task completed successfully");
  });

  it("does not modify empty string output", () => {
    const res = applyRecovery("write", "");
    assert.equal(res.output, "");
  });
});

// ---------------------------------------------------------------------------
// False positives — template errors without JSON prefix
// ---------------------------------------------------------------------------

describe("false positives", () => {
  it("does not match template error 'expected }' without json prefix", () => {
    const res = applyRecovery(
      "write",
      "Template failed: expected '}' before newline",
    );
    assert.equal(res.output, "Template failed: expected '}' before newline");
  });

  it("does match 'json expected }' with json prefix", () => {
    const res = applyRecovery("write", "JSON parse: expected '}' at line 1");
    assertHasReminder(res);
  });
});

// ---------------------------------------------------------------------------
// Excluded tools — no reminder appended
// ---------------------------------------------------------------------------

describe("excluded tools", () => {
  for (const tool of ALL_TOOLS) {
    it(`skips excluded tool "${tool}"`, () => {
      const res = applyRecovery(tool, "json parse error in output");
      assert.equal(
        res.output,
        "json parse error in output",
        `expected no change for tool "${tool}"`,
      );
    });
  }

  it("skips case-variant of excluded tool (BASH)", () => {
    const res = applyRecovery("BASH", "json parse error in output");
    assert.equal(res.output, "json parse error in output");
  });
});

// ---------------------------------------------------------------------------
// Prose within excluded tools — still no reminder
// ---------------------------------------------------------------------------

describe("JSON error text in excluded tool output", () => {
  for (const tool of ALL_TOOLS) {
    it(`does not append reminder for "${tool}" with JSON error prose`, () => {
      const res = applyRecovery(
        tool,
        "I see a json parse error in the response",
      );
      assert.equal(
        res.output,
        "I see a json parse error in the response",
        `expected no change for tool "${tool}"`,
      );
    });
  }
});

// ---------------------------------------------------------------------------
// Deduplication — marker appears only once
// ---------------------------------------------------------------------------

describe("deduplication", () => {
  it("does not append reminder a second time", () => {
    const output: { output?: string } = {
      output: "json parse error: unexpected token",
    };
    recoverJsonError({ tool: "write" }, output);
    const afterFirst =
      (output.output as string).split(JSON_ERROR_REMINDER_MARKER).length - 1;
    assert.equal(afterFirst, 1);

    recoverJsonError({ tool: "write" }, output);
    const afterSecond =
      (output.output as string).split(JSON_ERROR_REMINDER_MARKER).length - 1;
    assert.equal(
      afterSecond,
      1,
      "marker count should stay 1 after second call",
    );
  });
});

// ---------------------------------------------------------------------------
// No output property — no change
// ---------------------------------------------------------------------------

describe("missing output property", () => {
  it("does not throw or modify when output property is absent", () => {
    const obj: { output?: string } = {};
    recoverJsonError({ tool: "write" }, obj);
    assert.equal(obj.output, undefined);
  });

  it("does not modify when output is undefined", () => {
    const obj: { output?: string } = { output: undefined };
    recoverJsonError({ tool: "write" }, obj);
    assert.equal(obj.output, undefined);
  });
});

// ---------------------------------------------------------------------------
// Every pattern individually testable
// ---------------------------------------------------------------------------

describe("all JSON_ERROR_PATTERNS match individually", () => {
  const testCases: Array<{ pattern: RegExp; matching: string }> = [
    { pattern: /json parse error/i, matching: "json parse error: token" },
    { pattern: /failed to parse json/i, matching: "failed to parse json" },
    { pattern: /invalid json/i, matching: "invalid json at position 5" },
    { pattern: /malformed json/i, matching: "malformed json input" },
    {
      pattern: /unexpected end of json input/i,
      matching: "unexpected end of json input",
    },
    {
      pattern: /syntaxerror:\s*unexpected token.*json/i,
      matching: "SyntaxError: unexpected token in JSON",
    },
    {
      pattern: /json[^\n]*expected '\}'/i,
      matching: "json parse expected '}' at line 1",
    },
    {
      pattern: /json[^\n]*unexpected eof/i,
      matching: "JSON unexpected EOF",
    },
  ];

  for (const { pattern, matching } of testCases) {
    it(`pattern ${pattern} matches "${matching}"`, () => {
      // Verify the pattern itself works
      assert.ok(
        pattern.test(matching),
        `pattern ${pattern} should match "${matching}"`,
      );
      // Verify recoverJsonError appends the reminder
      const res = applyRecovery("write", matching);
      assertHasReminder(res, `expected reminder for "${matching}"`);
    });
  }
});

// ---------------------------------------------------------------------------
// Integration with barrel export
// ---------------------------------------------------------------------------

describe("barrel export", () => {
  it("exports all expected symbols", () => {
    assert.ok(Array.isArray(JSON_ERROR_TOOL_EXCLUDE_LIST));
    assert.ok(JSON_ERROR_TOOL_EXCLUDES instanceof Set);
    assert.ok(Array.isArray(JSON_ERROR_PATTERNS));
    assert.equal(typeof JSON_ERROR_REMINDER, "string");
    assert.equal(typeof JSON_ERROR_REMINDER_MARKER, "string");
    assert.equal(typeof recoverJsonError, "function");
  });

  it("JSON_ERROR_REMINDER starts with the marker", () => {
    assert.ok(JSON_ERROR_REMINDER.startsWith(JSON_ERROR_REMINDER_MARKER));
  });
});

// ---------------------------------------------------------------------------
// Test fixture: ensure core/config.json exists for plugin init tests.
// zookeeper() calls loadValidationConfig() on startup, which throws if the
// file is missing or malformed.
// ---------------------------------------------------------------------------

const CORE_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../../core",
);
const CONFIG_PATH = resolve(CORE_DIR, "config.json");
let originalContent: string | null = null;

before(() => {
  if (!existsSync(CORE_DIR)) mkdirSync(CORE_DIR, { recursive: true });
  if (existsSync(CONFIG_PATH)) {
    originalContent = readFileSync(CONFIG_PATH, "utf-8");
    return;
  }
  writeFileSync(CONFIG_PATH, validConfigJson());
});

after(() => {
  if (originalContent !== null) {
    writeFileSync(CONFIG_PATH, originalContent);
    return;
  }
  if (existsSync(CONFIG_PATH)) rmSync(CONFIG_PATH);
});

/** Serialize default test config to JSON. */
function validConfigJson(): string {
  return `${JSON.stringify(
    { context_word_limit: 100, prompt_word_limit: 250 },
    null,
    2,
  )}\n`;
}

// ---------------------------------------------------------------------------
// Helper: build a minimal valid prompt that passes all checks.
// ---------------------------------------------------------------------------

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
// Integration: via plugin entry point
// ---------------------------------------------------------------------------

describe("integration: tool.execute.after via plugin", () => {
  it("non-task tool with JSON parse error appends reminder via plugin", async () => {
    const plugin = await zookeeper({});
    const output: { output?: string } = {
      output: "json parse error: unexpected token at position 42",
    };
    await plugin["tool.execute.after"](
      { tool: "write", sessionID: "s1", callID: "c1" },
      output,
    );
    assert.ok(output.output?.includes(JSON_ERROR_REMINDER_MARKER));
    assert.ok(output.output?.includes("You sent invalid JSON arguments"));
  });

  it("non-task tool with normal output unchanged via plugin", async () => {
    const plugin = await zookeeper({});
    const output: { output?: string } = {
      output: "File written successfully",
    };
    await plugin["tool.execute.after"](
      { tool: "write", sessionID: "s1", callID: "c1" },
      output,
    );
    assert.equal(output.output, "File written successfully");
  });

  it("excluded tool (bash) with JSON error NOT appended via plugin", async () => {
    const plugin = await zookeeper({});
    const output: { output?: string } = {
      output: "json parse error in bash output",
    };
    await plugin["tool.execute.after"](
      { tool: "bash", sessionID: "s1", callID: "c1" },
      output,
    );
    assert.equal(output.output, "json parse error in bash output");
  });

  it("task tool (excluded for JSON recovery) with JSON error NOT appended via plugin", async () => {
    const plugin = await zookeeper({});
    const output: { output?: string } = {
      output: "I encountered a json parse error in the response",
    };
    await plugin["tool.execute.after"](
      { tool: "task", sessionID: "s1", callID: "c1" },
      output,
    );
    assert.equal(
      output.output,
      "I encountered a json parse error in the response",
    );
  });

  it("task tool with nudge-worthy prompt + JSON error: only nudge, no JSON reminder", async () => {
    const plugin = await zookeeper({});
    const prompt = validPrompt({
      context: "The bug is at src/db.py line 42. Fix it.",
    });
    const output: { output?: string } = {
      output: "Task finished with a json parse error in subagent output",
    };
    await plugin["tool.execute.after"](
      { tool: "task", sessionID: "s1", callID: "c1", args: { prompt } },
      output,
    );
    assert.equal(
      output.output?.includes(JSON_ERROR_REMINDER_MARKER),
      false,
      "task tool should not receive JSON reminder marker",
    );
    assert.ok(
      output.output?.includes("Guidance for next time"),
      "nudge should be appended for line references",
    );
    assert.ok(output.output?.includes("line references"));
  });

  it("non-task tool with SyntaxError appends reminder via plugin", async () => {
    const plugin = await zookeeper({});
    const output: { output?: string } = {
      output: "SyntaxError: unexpected token in JSON at position 42",
    };
    await plugin["tool.execute.after"](
      { tool: "write", sessionID: "s1", callID: "c1" },
      output,
    );
    assert.ok(output.output?.includes(JSON_ERROR_REMINDER_MARKER));
    assert.ok(output.output?.includes("You sent invalid JSON arguments"));
  });
});
