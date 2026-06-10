/**
 * Tests for the Direct Work Nudge hook.
 *
 * Covers edit/write firing, non-matching tools, null/undefined output,
 * case-insensitivity, no path exemptions, consecutive calls, constants,
 * and integration via the plugin entry point.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { zookeeper } from "../../index.js";
import { DIRECT_WORK_NUDGE, nudgeDirectWork } from "./index.js";

// ---------------------------------------------------------------------------
// Constants / helpers
// ---------------------------------------------------------------------------

const NON_EDIT_WRITE_TOOLS = [
  "bash",
  "read",
  "grep",
  "glob",
  "task",
  "skill",
  "webfetch",
  "websearch",
];

/**
 * Invoke nudgeDirectWork with the given tool and output and return the
 * mutated output object.
 */
function applyReminder(tool: string, text: string): { output?: string } {
  const result: { output?: string } = { output: text };
  nudgeDirectWork({ tool }, result);
  return result;
}

/**
 * Assert that `obj.output` contains the DIRECT_WORK_NUDGE text.
 */
function assertHasReminder(obj: { output?: string }, message?: string): void {
  assert.ok(
    obj.output?.includes("DELEGATION REQUIRED"),
    message ?? "expected output to contain nudge",
  );
}

// ---------------------------------------------------------------------------
// edit / write fire the reminder
// ---------------------------------------------------------------------------

describe("edit/write fires reminder", () => {
  it('appends reminder for tool="edit"', () => {
    const res = applyReminder("edit", "Fixed indentation in foo.ts");
    assertHasReminder(res);
    assert.ok(res.output?.includes(DIRECT_WORK_NUDGE));
  });

  it('appends reminder for tool="write"', () => {
    const res = applyReminder("write", "Created new file bar.ts");
    assertHasReminder(res);
    assert.ok(res.output?.includes(DIRECT_WORK_NUDGE));
  });
});

// ---------------------------------------------------------------------------
// Non-matching tools are skipped
// ---------------------------------------------------------------------------

describe("non edit/write tools are skipped", () => {
  for (const tool of NON_EDIT_WRITE_TOOLS) {
    it(`skips tool "${tool}"`, () => {
      const res = applyReminder(tool, "some output text here");
      assert.equal(
        res.output,
        "some output text here",
        `expected no change for tool "${tool}"`,
      );
    });
  }
});

// ---------------------------------------------------------------------------
// Null / undefined output
// ---------------------------------------------------------------------------

describe("null / undefined output", () => {
  it("does not modify when output is absent", () => {
    const obj: { output?: string } = {};
    nudgeDirectWork({ tool: "edit" }, obj);
    assert.equal(obj.output, undefined);
  });

  it("does not modify when output is undefined", () => {
    const obj: { output?: string } = { output: undefined };
    nudgeDirectWork({ tool: "edit" }, obj);
    assert.equal(obj.output, undefined);
  });

  it("does not modify when output is null", () => {
    const obj: { output?: string } = { output: null as unknown as string };
    nudgeDirectWork({ tool: "edit" }, obj);
    assert.equal(obj.output, null);
  });
});

// ---------------------------------------------------------------------------
// Case-insensitive tool names
// ---------------------------------------------------------------------------

describe("case-insensitive tool name matching", () => {
  it('matches "EDIT"', () => {
    const res = applyReminder("EDIT", "some change");
    assertHasReminder(res);
  });

  it('matches "Write"', () => {
    const res = applyReminder("Write", "some change");
    assertHasReminder(res);
  });

  it('matches "EdIt"', () => {
    const res = applyReminder("EdIt", "some change");
    assertHasReminder(res);
  });
});

// ---------------------------------------------------------------------------
// Fires on ANY path (no exemptions)
// ---------------------------------------------------------------------------

describe("fires on any path (no path exemptions)", () => {
  it('fires on ".opencode/config.json"', () => {
    const obj: { output?: string } = { output: "updated config" };
    nudgeDirectWork({ tool: "edit" }, obj);
    assertHasReminder(obj);
  });

  it('fires on "tests/scenarios/x.json"', () => {
    const obj: { output?: string } = { output: "updated test data" };
    nudgeDirectWork({ tool: "edit" }, obj);
    assertHasReminder(obj);
  });

  it('fires on "src/foo.ts"', () => {
    const obj: { output?: string } = { output: "changed source" };
    nudgeDirectWork({ tool: "edit" }, obj);
    assertHasReminder(obj);
  });
});

// ---------------------------------------------------------------------------
// Consecutive calls — stateless, both fire
// ---------------------------------------------------------------------------

describe("consecutive calls", () => {
  it("both calls append the reminder (stateless, no dedup)", () => {
    const obj: { output?: string } = {
      output: "original content",
    };

    // First call
    nudgeDirectWork({ tool: "edit" }, obj);
    const out1 = obj.output as string;
    const countAfterFirst = out1.split("DELEGATION REQUIRED").length - 1;
    assert.equal(countAfterFirst, 1);

    // Second call — reminder appended again
    nudgeDirectWork({ tool: "edit" }, obj);
    const out2 = obj.output as string;
    const countAfterSecond = out2.split("DELEGATION REQUIRED").length - 1;
    assert.equal(countAfterSecond, 2);
  });
});

// ---------------------------------------------------------------------------
// Constants checks
// ---------------------------------------------------------------------------

describe("DIRECT_WORK_NUDGE contents", () => {
  it('contains "DELEGATION REQUIRED"', () => {
    assert.ok(DIRECT_WORK_NUDGE.includes("DELEGATION REQUIRED"));
  });

  it('contains "Build does not implement"', () => {
    assert.ok(DIRECT_WORK_NUDGE.includes("Build does not implement"));
  });

  it("contains documentation exception", () => {
    assert.ok(DIRECT_WORK_NUDGE.includes("Documentation"));
    assert.ok(DIRECT_WORK_NUDGE.includes("this is your job"));
  });
});

// ---------------------------------------------------------------------------
// Barrel export
// ---------------------------------------------------------------------------

describe("barrel export", () => {
  it("exports nudgeDirectWork as a function", () => {
    assert.equal(typeof nudgeDirectWork, "function");
  });

  it("exports DIRECT_WORK_NUDGE as a string", () => {
    assert.equal(typeof DIRECT_WORK_NUDGE, "string");
  });
});

// ---------------------------------------------------------------------------
// Integration: via plugin entry point
// ---------------------------------------------------------------------------

describe("integration: tool.execute.after via plugin", () => {
  it("edit tool appends reminder via plugin", async () => {
    const plugin = await zookeeper({ client: null });
    const output: { output?: string } = {
      output: "fixed formatting in index.ts",
    };
    await plugin["tool.execute.after"](
      { tool: "edit", sessionID: "s1", callID: "c1" },
      output,
    );
    assert.ok(output.output?.includes("DELEGATION REQUIRED"));
    assert.ok(output.output?.includes("orchestrator protocol"));
  });

  it("bash tool remains unchanged via plugin", async () => {
    const plugin = await zookeeper({ client: null });
    const output: { output?: string } = {
      output: "ls output here",
    };
    await plugin["tool.execute.after"](
      { tool: "bash", sessionID: "s1", callID: "c1" },
      output,
    );
    assert.equal(output.output, "ls output here");
  });
});
